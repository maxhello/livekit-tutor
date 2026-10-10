"""livekit-tutor 历史后端:FastAPI 应用与路由。

模型在 models.py,鉴权在 auth.py。职责:
- GitHub PAT 登录校验(服务端调 GitHub API + 白名单)→ 签发 30 天 JWT
- 练习会话的存/取/删(含消息与纠错卡)

环境变量(生产由 k8s 注入,见 deploy/README.md):
- DATABASE_URL   models.py 读;例:postgresql+psycopg://tutor:***@postgres:5432/tutor
- JWT_SECRET     auth.py 读,必填
- GITHUB_ALLOWLIST auth.py 读;逗号分隔的 GitHub 用户名白名单,空 = 拒绝所有登录
- CORS_ORIGINS   本文件读;逗号分隔的允许来源(默认 Pages 地址 + 本地 dev)
"""

import os
import time
from contextlib import asynccontextmanager
from typing import Any

from fastapi import Depends, FastAPI, Header, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.orm import Session

from auth import GITHUB_ALLOWLIST, JWT_SECRET, _github_login, current_user, make_token
from models import (
    Base,
    CorrectionRow,
    MessageRow,
    SessionRow,
    UserRow,
    engine,
    get_db,
)

CORS_ORIGINS = [
    s.strip()
    for s in os.getenv(
        "CORS_ORIGINS",
        "https://maxhello.github.io,http://localhost:5173",
    ).split(",")
    if s.strip()
]
LIST_LIMIT = 200


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


# ---------------------------------------------------------------- app


app = FastAPI(title="livekit-tutor history API", lifespan=lifespan)
app.add_middleware(
    CORSMiddleware,
    allow_origins=CORS_ORIGINS,
    allow_methods=["*"],
    allow_headers=["*"],
)


def auth_dep(authorization: str = Header(""), db: Session = Depends(get_db)) -> UserRow:
    return current_user(authorization, db)


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
