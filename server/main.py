"""livekit-tutor 历史后端:FastAPI + SQLAlchemy(生产 PostgreSQL,测试 sqlite)。

单文件应用(风格同 agent/agent.py)。职责:
- GitHub PAT 登录校验(服务端调 GitHub API + 白名单)→ 签发 30 天 JWT
- 练习会话的存/取/删(含消息与纠错卡)

环境变量(生产由 k8s 注入,见 deploy/README.md):
- DATABASE_URL   例:postgresql+psycopg://tutor:***@postgres:5432/tutor(默认本地 sqlite 文件)
- JWT_SECRET     签名密钥,必填
- GITHUB_ALLOWLIST 逗号分隔的 GitHub 用户名白名单,空 = 拒绝所有登录
- CORS_ORIGINS   逗号分隔的允许来源(默认 Pages 地址 + 本地 dev)
"""

import os
import time
from contextlib import asynccontextmanager
from datetime import datetime, timedelta, timezone
from typing import Any

import httpx
import jwt
from fastapi import Depends, FastAPI, Header, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from sqlalchemy import JSON, ForeignKey, UniqueConstraint, create_engine, select
from sqlalchemy.orm import (
    DeclarativeBase,
    Mapped,
    Session,
    mapped_column,
    relationship,
    sessionmaker,
)

DATABASE_URL = os.getenv("DATABASE_URL", "sqlite:///./tutor.db")
JWT_SECRET = os.getenv("JWT_SECRET", "")
GITHUB_ALLOWLIST = {
    s.strip().lower() for s in os.getenv("GITHUB_ALLOWLIST", "").split(",") if s.strip()
}
CORS_ORIGINS = [
    s.strip()
    for s in os.getenv(
        "CORS_ORIGINS",
        "https://maxhello.github.io,http://localhost:5173",
    ).split(",")
    if s.strip()
]
TOKEN_TTL_DAYS = 30
LIST_LIMIT = 200


# ---------------------------------------------------------------- DB


class Base(DeclarativeBase):
    pass


class UserRow(Base):
    __tablename__ = "users"

    id: Mapped[int] = mapped_column(primary_key=True)
    github_login: Mapped[str] = mapped_column(unique=True, index=True)
    created_at: Mapped[int] = mapped_column(default=lambda: datetime.now(timezone.utc))


class SessionRow(Base):
    __tablename__ = "sessions"
    __table_args__ = (UniqueConstraint("user_id", "started_at"),)

    id: Mapped[int] = mapped_column(primary_key=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id"), index=True)
    started_at: Mapped[int]  # 会话开始时间,毫秒时间戳(前端用作 id)
    seconds: Mapped[int] = mapped_column(default=0)
    scenario: Mapped[str] = mapped_column(default="")
    created_at: Mapped[int] = mapped_column(default=lambda: datetime.now(timezone.utc))

    messages: Mapped[list["MessageRow"]] = relationship(
        back_populates="session",
        cascade="all, delete-orphan",
        order_by="MessageRow.idx",
    )
    corrections: Mapped[list["CorrectionRow"]] = relationship(
        back_populates="session",
        cascade="all, delete-orphan",
        order_by="CorrectionRow.idx",
    )


class MessageRow(Base):
    __tablename__ = "messages"

    id: Mapped[int] = mapped_column(primary_key=True)
    session_id: Mapped[int] = mapped_column(ForeignKey("sessions.id"), index=True)
    idx: Mapped[int]
    role: Mapped[str]  # 'emma' | 'me'
    text: Mapped[str]

    session: Mapped[SessionRow] = relationship(back_populates="messages")


class CorrectionRow(Base):
    __tablename__ = "corrections"

    id: Mapped[int] = mapped_column(primary_key=True)
    session_id: Mapped[int] = mapped_column(ForeignKey("sessions.id"), index=True)
    idx: Mapped[int]
    original: Mapped[str]
    corrected: Mapped[str]
    kind: Mapped[str]  # 'grammar' | 'word' | 'pronunciation'
    point: Mapped[str]  # 中文语法点解释
    words: Mapped[list[dict[str, Any]]] = mapped_column(JSON, default=list)
    at_ms: Mapped[int] = mapped_column(default=0)  # 距会话开始毫秒

    session: Mapped[SessionRow] = relationship(back_populates="corrections")


if DATABASE_URL.startswith("sqlite"):
    from sqlalchemy.pool import StaticPool

    _sqlite_kwargs: dict[str, Any] = {"connect_args": {"check_same_thread": False}}
    if DATABASE_URL == "sqlite://":
        # 内存库:全线程共享一个连接,否则建表对别的线程不可见(测试用)
        _sqlite_kwargs["poolclass"] = StaticPool
    engine = create_engine(DATABASE_URL, **_sqlite_kwargs)
else:
    engine = create_engine(DATABASE_URL, pool_pre_ping=True)
SessionLocal = sessionmaker(bind=engine, expire_on_commit=False)


def get_db() -> Any:
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()


@asynccontextmanager
async def lifespan(_: FastAPI):
    if not JWT_SECRET:
        raise RuntimeError("JWT_SECRET must be set")
    Base.metadata.create_all(engine)
    yield


# ---------------------------------------------------------------- schemas


class LoginBody(BaseModel):
    user: str
    pat: str


class MsgIn(BaseModel):
    role: str
    text: str


class WordIn(BaseModel):
    word: str
    ipa: str = ""
    tip_cn: str = ""


class CorrectionIn(BaseModel):
    original: str
    corrected: str
    kind: str
    point: str
    words: list[WordIn] = []
    at: int = 0


class SessionIn(BaseModel):
    seconds: int
    scenario: str = ""
    msgs: list[MsgIn]
    corrections: list[CorrectionIn] = []


# ---------------------------------------------------------------- auth


def _github_login(pat: str) -> str | None:
    """拿 PAT 调 GitHub API,返回该 token 的登录名;无效返回 None。"""
    try:
        r = httpx.get(
            "https://api.github.com/user",
            headers={"Authorization": f"Bearer {pat}"},
            timeout=10,
        )
    except httpx.HTTPError:
        return None
    if r.status_code != 200:
        return None
    login = r.json().get("login")
    return str(login) if login else None


def make_token(user: UserRow) -> str:
    now = datetime.now(timezone.utc)
    payload = {
        "uid": user.id,
        "login": user.github_login,
        "iat": now,
        "exp": now + timedelta(days=TOKEN_TTL_DAYS),
    }
    return jwt.encode(payload, JWT_SECRET, algorithm="HS256")


def current_user(authorization: str, db: Session) -> UserRow:
    if not authorization.startswith("Bearer "):
        raise HTTPException(401, "missing bearer token")
    try:
        payload = jwt.decode(
            authorization.removeprefix("Bearer "), JWT_SECRET, algorithms=["HS256"]
        )
    except jwt.PyJWTError:
        raise HTTPException(401, "invalid or expired token") from None
    user = db.get(UserRow, payload.get("uid"))
    if user is None:
        raise HTTPException(401, "unknown user")
    return user


# ---------------------------------------------------------------- app


app = FastAPI(title="livekit-tutor history API", lifespan=lifespan)
app.add_middleware(
    CORSMiddleware,
    allow_origins=CORS_ORIGINS,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/api/health")
def health() -> dict[str, bool]:
    return {"ok": True}


@app.post("/api/auth/login")
def login(body: LoginBody, db: Session = Depends(get_db)) -> dict[str, str]:
    user = body.user.strip().lower()
    if not GITHUB_ALLOWLIST or user not in GITHUB_ALLOWLIST:
        raise HTTPException(403, "user not in allowlist")
    login_name = _github_login(body.pat.strip())
    if login_name is None or login_name.lower() != user:
        raise HTTPException(401, "GitHub token invalid or does not match the user")
    row = db.scalar(select(UserRow).where(UserRow.github_login == login_name))
    if row is None:
        row = UserRow(github_login=login_name)
        db.add(row)
        db.commit()
    return {"token": make_token(row), "user": row.github_login}


def auth_dep(authorization: str = Header(""), db: Session = Depends(get_db)) -> UserRow:
    return current_user(authorization, db)


def _session_out(s: SessionRow) -> dict[str, Any]:
    return {
        "startedAt": s.started_at,
        "seconds": s.seconds,
        "scenario": s.scenario,
        "msgs": len(s.messages),
        "corrections": len(s.corrections),
    }


def _session_detail(s: SessionRow) -> dict[str, Any]:
    return {
        "startedAt": s.started_at,
        "seconds": s.seconds,
        "scenario": s.scenario,
        "msgs": [{"role": m.role, "text": m.text} for m in s.messages],
        "corrections": [
            {
                "original": c.original,
                "corrected": c.corrected,
                "kind": c.kind,
                "point": c.point,
                "words": c.words,
                "at": c.at_ms,
            }
            for c in s.corrections
        ],
    }


def _find_session(db: Session, user: UserRow, started_at: int) -> SessionRow:
    s = db.scalar(
        select(SessionRow).where(
            SessionRow.user_id == user.id, SessionRow.started_at == started_at
        )
    )
    if s is None:
        raise HTTPException(404, "session not found")
    return s


@app.get("/api/sessions")
def list_sessions(
    user: UserRow = Depends(auth_dep), db: Session = Depends(get_db)
) -> list[dict[str, Any]]:
    rows = db.scalars(
        select(SessionRow)
        .where(SessionRow.user_id == user.id)
        .order_by(SessionRow.started_at.desc())
        .limit(LIST_LIMIT)
    ).all()
    return [_session_out(s) for s in rows]


@app.get("/api/sessions/{started_at}")
def get_session(
    started_at: int, user: UserRow = Depends(auth_dep), db: Session = Depends(get_db)
) -> dict[str, Any]:
    return _session_detail(_find_session(db, user, started_at))


@app.put("/api/sessions/{started_at}")
def put_session(
    started_at: int,
    body: SessionIn,
    user: UserRow = Depends(auth_dep),
    db: Session = Depends(get_db),
) -> dict[str, Any]:
    # 只接受合理的 epoch-ms(下界 2020-09,上界允许 10 分钟时钟偏差),防脏数据
    if not (1_600_000_000_000 < started_at <= int(time.time() * 1000) + 600_000):
        raise HTTPException(422, "started_at must be an epoch-ms timestamp")
    s = db.scalar(
        select(SessionRow).where(
            SessionRow.user_id == user.id, SessionRow.started_at == started_at
        )
    )
    if s is None:
        s = SessionRow(user_id=user.id, started_at=started_at)
        db.add(s)
    s.seconds = body.seconds
    s.scenario = body.scenario
    s.messages = [
        MessageRow(idx=i, role=m.role, text=m.text) for i, m in enumerate(body.msgs)
    ]
    s.corrections = [
        CorrectionRow(
            idx=i,
            original=c.original,
            corrected=c.corrected,
            kind=c.kind,
            point=c.point,
            words=[w.model_dump() for w in c.words],
            at_ms=c.at,
        )
        for i, c in enumerate(body.corrections)
    ]
    db.commit()
    return {"ok": True}


@app.delete("/api/sessions/{started_at}")
def delete_session(
    started_at: int, user: UserRow = Depends(auth_dep), db: Session = Depends(get_db)
) -> dict[str, bool]:
    db.delete(_find_session(db, user, started_at))
    db.commit()
    return {"ok": True}
