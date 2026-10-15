"""livekit-tutor 历史后端:FastAPI 应用与路由。

模型在 models.py,鉴权在 auth.py。职责:
- GitHub PAT 登录校验(服务端调 GitHub API + 白名单)→ 签发 30 天 JWT
- 练习会话的存/取/删(含消息与纠错卡)
- LiveKit 房间 token 签发(密钥只在服务端,前端每次开练现领短时 token),
  同时建会话:会话 id、起止时间全部由服务器生成

环境变量(生产由 k8s 注入,见 deploy/README.md):
- DATABASE_URL   models.py 读;例:postgresql+psycopg://tutor:***@postgres:5432/tutor
- JWT_SECRET     auth.py 读,必填
- GITHUB_ALLOWLIST auth.py 读;逗号分隔的 GitHub 用户名白名单,空 = 拒绝所有登录
- CORS_ORIGINS   本文件读;逗号分隔的允许来源(默认 Pages 地址 + 本地 dev)
- LIVEKIT_URL / LIVEKIT_API_KEY / LIVEKIT_API_SECRET 本文件读;签房间 token 用
"""

import datetime
import os
import secrets
from contextlib import asynccontextmanager
from typing import Any
from urllib.parse import urlencode

import httpx
from fastapi import Cookie, Depends, FastAPI, Header, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import RedirectResponse
from livekit import api as lk_api
from livekit.protocol import agent_dispatch as lk_dispatch
from livekit.protocol.room import RoomConfiguration
from pydantic import BaseModel
from sqlalchemy import exists, select
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
    utcnow,
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

# LiveKit 房间约定(与前端一致):固定房间、固定 identity,token 内嵌 agent dispatch
LIVEKIT_URL = os.getenv("LIVEKIT_URL", "")
LIVEKIT_API_KEY = os.getenv("LIVEKIT_API_KEY", "")
LIVEKIT_API_SECRET = os.getenv("LIVEKIT_API_SECRET", "")
ROOM_NAME = "tutor-max"
CALLER_IDENTITY = "max"
CALLER_NAME = "Max"
AGENT_NAME = "livekit-tutor"  # 对应 agent/ 里 @server.rtc_session(agent_name=...)
ROOM_TOKEN_TTL = datetime.timedelta(hours=12)

# GitHub OAuth 一键登录(创建 OAuth App 见 deploy/README.md)
GITHUB_CLIENT_ID = os.getenv("GITHUB_CLIENT_ID", "")
GITHUB_CLIENT_SECRET = os.getenv("GITHUB_CLIENT_SECRET", "")
API_PUBLIC_URL = os.getenv("API_PUBLIC_URL", "").rstrip(
    "/"
)  # 本服务对外地址(拼 callback)
FRONTEND_URL = os.getenv("FRONTEND_URL", "").rstrip("/")  # 授权完跳回的前端地址


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


@app.post("/api/token")
def livekit_token(
    user: UserRow = Depends(auth_dep), db: Session = Depends(get_db)
) -> dict[str, Any]:
    """签一个短时房间 token(内嵌 agent dispatch,Emma 自动进房),同时建一条会话
    (开始时间取服务器时间),返回 sessionId 供挂断时保存。需登录。"""
    if not (LIVEKIT_URL and LIVEKIT_API_KEY and LIVEKIT_API_SECRET):
        raise HTTPException(500, "LiveKit credentials not configured")
    token = (
        lk_api.AccessToken(LIVEKIT_API_KEY, LIVEKIT_API_SECRET)
        .with_identity(CALLER_IDENTITY)
        .with_name(CALLER_NAME)
        .with_grants(lk_api.VideoGrants(room_join=True, room=ROOM_NAME))
        .with_ttl(ROOM_TOKEN_TTL)
        .with_room_config(
            RoomConfiguration(
                agents=[lk_dispatch.RoomAgentDispatch(agent_name=AGENT_NAME)],
            )
        )
    )
    session = SessionRow(user_id=user.id)
    db.add(session)
    db.commit()
    return {"token": token.to_jwt(), "url": LIVEKIT_URL, "sessionId": session.id}


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


# ---------------------------------------------------------------- GitHub OAuth 一键登录
# 前端整页跳 /api/auth/github → GitHub 授权 → 回调换 token → 验白名单 →
# 签我们的 JWT → 302 回前端,token 放 URL hash(#gh=...&user=...,hash 不上服务器日志)


def _oauth_redirect_uri() -> str:
    return f"{API_PUBLIC_URL}/api/auth/github/callback"


@app.get("/api/auth/github")
def github_auth() -> RedirectResponse:
    if not (
        GITHUB_CLIENT_ID and GITHUB_CLIENT_SECRET and API_PUBLIC_URL and FRONTEND_URL
    ):
        raise HTTPException(500, "GitHub OAuth not configured")
    state = secrets.token_urlsafe(16)
    url = "https://github.com/login/oauth/authorize?" + urlencode(
        {
            "client_id": GITHUB_CLIENT_ID,
            "redirect_uri": _oauth_redirect_uri(),
            "scope": "read:user",
            "state": state,
        }
    )
    resp = RedirectResponse(url)
    # state 存 HttpOnly cookie 防 CSRF;SameSite=Lax 在顶级跳转下仍会带上
    resp.set_cookie(
        "gh_state", state, max_age=600, httponly=True, samesite="lax", secure=True
    )
    return resp


def _exchange_code(code: str) -> str | None:
    """拿授权码换 GitHub access token;失败返回 None。"""
    try:
        r = httpx.post(
            "https://github.com/login/oauth/access_token",
            headers={"Accept": "application/json"},
            data={
                "client_id": GITHUB_CLIENT_ID,
                "client_secret": GITHUB_CLIENT_SECRET,
                "code": code,
                "redirect_uri": _oauth_redirect_uri(),
            },
            timeout=10,
        )
    except httpx.HTTPError:
        return None
    if r.status_code != 200:
        return None
    token = r.json().get("access_token")
    return str(token) if token else None


@app.get("/api/auth/github/callback")
def github_callback(
    code: str = "",
    state: str = "",
    gh_state: str | None = Cookie(None),
    db: Session = Depends(get_db),
) -> RedirectResponse:
    if not code or not state or not gh_state:
        raise HTTPException(400, "missing code/state")
    if not secrets.compare_digest(state, gh_state):
        raise HTTPException(400, "state mismatch")
    access_token = _exchange_code(code)
    login_name = _github_login(access_token) if access_token else None
    if login_name is None or login_name.lower() not in GITHUB_ALLOWLIST:
        raise HTTPException(403, "user not in allowlist")
    row = db.scalar(select(UserRow).where(UserRow.github_login == login_name))
    if row is None:
        row = UserRow(github_login=login_name)
        db.add(row)
        db.commit()
    resp = RedirectResponse(f"{FRONTEND_URL}/#gh={make_token(row)}&user={login_name}")
    resp.delete_cookie("gh_state")
    return resp


def _ms(dt: datetime.datetime) -> int:
    """时间 → 毫秒时间戳(sqlite 读回来不带时区,按 UTC 处理)。"""
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=datetime.timezone.utc)
    return int(dt.timestamp() * 1000)


def _seconds(s: SessionRow) -> int:
    return round((_ms(s.ended_at) - _ms(s.started_at)) / 1000) if s.ended_at else 0


def _session_out(s: SessionRow) -> dict[str, Any]:
    return {
        "id": s.id,
        "startedAt": _ms(s.started_at),
        "seconds": _seconds(s),
        "scenario": s.scenario,
        "msgs": len(s.messages),
        "corrections": len(s.corrections),
    }


def _session_detail(s: SessionRow) -> dict[str, Any]:
    return {
        "id": s.id,
        "startedAt": _ms(s.started_at),
        "seconds": _seconds(s),
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


def _find_session(db: Session, user: UserRow, session_id: int) -> SessionRow:
    s = db.get(SessionRow, session_id)
    if s is None or s.user_id != user.id:
        raise HTTPException(404, "session not found")
    return s


@app.get("/api/sessions")
def list_sessions(
    user: UserRow = Depends(auth_dep), db: Session = Depends(get_db)
) -> list[dict[str, Any]]:
    # 连上就断、一句话没说的会话不列出
    has_msgs = exists().where(MessageRow.session_id == SessionRow.id)
    rows = db.scalars(
        select(SessionRow)
        .where(SessionRow.user_id == user.id, has_msgs)
        .order_by(SessionRow.started_at.desc(), SessionRow.id.desc())
        .limit(LIST_LIMIT)
    ).all()
    return [_session_out(s) for s in rows]


@app.get("/api/sessions/{session_id}")
def get_session(
    session_id: int, user: UserRow = Depends(auth_dep), db: Session = Depends(get_db)
) -> dict[str, Any]:
    return _session_detail(_find_session(db, user, session_id))


@app.put("/api/sessions/{session_id}")
def put_session(
    session_id: int,
    body: SessionIn,
    user: UserRow = Depends(auth_dep),
    db: Session = Depends(get_db),
) -> dict[str, Any]:
    """保存会话内容(整体覆盖,可重复调用);第一次保存时记下结束时间。"""
    s = _find_session(db, user, session_id)
    if s.ended_at is None:
        s.ended_at = utcnow()
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


@app.delete("/api/sessions/{session_id}")
def delete_session(
    session_id: int, user: UserRow = Depends(auth_dep), db: Session = Depends(get_db)
) -> dict[str, bool]:
    db.delete(_find_session(db, user, session_id))
    db.commit()
    return {"ok": True}
