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
import json
import os
import secrets
from contextlib import asynccontextmanager
from typing import Annotated, Any
from urllib.parse import urlencode, urlsplit

import httpx
from fastapi import Cookie, Depends, FastAPI, Header, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import RedirectResponse
from livekit import api as lk_api
from livekit.protocol import agent_dispatch as lk_dispatch
from livekit.protocol.room import RoomConfiguration
from pydantic import BaseModel, Field
from sqlalchemy import exists, func, select
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
    msgs: list[MsgIn]
    corrections: list[CorrectionIn] = []


# 单元练习材料由前端(读多邻国单元指南)传来,原样转给 Emma:限长防撑爆 prompt
Short = Annotated[str, Field(max_length=200)]


class SentenceIn(BaseModel):
    en: Short
    zh: Short = ""


class GrammarIn(BaseModel):
    title: Short
    examples: Annotated[list[Short], Field(max_length=3)] = []


class UnitIn(BaseModel):
    index: Annotated[int, Field(ge=0, le=10_000)]
    label: Annotated[str, Field(max_length=60)] = ""
    objective: Short = ""
    sentences: Annotated[list[SentenceIn], Field(min_length=1, max_length=10)]
    grammar: Annotated[list[GrammarIn], Field(max_length=3)] = []


class TokenIn(BaseModel):
    """开练参数:场景优先;两者都没有就是自由聊天。"""

    scenario: Annotated[str, Field(max_length=100)] = ""
    unit: UnitIn | None = None


def practice_of(body: TokenIn | None) -> dict[str, Any] | None:
    """本次练什么:写进 agent dispatch metadata,Emma 进房前就知道。"""
    if body is None:
        return None
    if body.scenario.strip():
        return {"mode": "scenario", "scenario": body.scenario.strip()}
    if body.unit is not None:
        return {"mode": "unit", "unit": body.unit.model_dump()}
    return None


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
    body: TokenIn | None = None,
    user: UserRow = Depends(auth_dep),
    db: Session = Depends(get_db),
) -> dict[str, Any]:
    """签一个短时房间 token(内嵌 agent dispatch,Emma 自动进房),同时建一条会话
    (开始时间取服务器时间),返回 sessionId 供挂断时保存。需登录。

    body 带本次练习内容(场景或多邻国单元),经 dispatch metadata 交给 Emma。"""
    if not (LIVEKIT_URL and LIVEKIT_API_KEY and LIVEKIT_API_SECRET):
        raise HTTPException(500, "LiveKit credentials not configured")
    practice = practice_of(body)
    token = (
        lk_api.AccessToken(LIVEKIT_API_KEY, LIVEKIT_API_SECRET)
        .with_identity(CALLER_IDENTITY)
        .with_name(CALLER_NAME)
        .with_grants(lk_api.VideoGrants(room_join=True, room=ROOM_NAME))
        .with_ttl(ROOM_TOKEN_TTL)
        .with_room_config(
            RoomConfiguration(
                agents=[
                    lk_dispatch.RoomAgentDispatch(
                        agent_name=AGENT_NAME,
                        metadata=json.dumps(practice, ensure_ascii=False)
                        if practice
                        else "",
                    )
                ],
            )
        )
    )
    session = SessionRow(user_id=user.id)
    if practice and practice["mode"] == "scenario":
        session.scenario = practice["scenario"]
    elif practice and practice["mode"] == "unit":
        session.unit_index = practice["unit"]["index"]
        session.unit_label = practice["unit"]["label"]
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


def _safe_return_url(url: str | None) -> str:
    """授权完跳回的页面:只认 CORS_ORIGINS 里的来源(如本地 dev),否则回线上前端,防任意跳转。"""
    if url:
        parts = urlsplit(url)
        if f"{parts.scheme}://{parts.netloc}" in CORS_ORIGINS:
            return f"{parts.scheme}://{parts.netloc}{parts.path}".rstrip("/")
    return FRONTEND_URL


@app.get("/api/auth/github")
def github_auth(redirect: str = "") -> RedirectResponse:
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
    # 从哪个前端发起就跳回哪个(本地 dev 也能登录);回调时再校验一次
    resp.set_cookie(
        "gh_return",
        _safe_return_url(redirect),
        max_age=600,
        httponly=True,
        samesite="lax",
        secure=True,
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
    gh_return: str | None = Cookie(None),
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
    back = _safe_return_url(gh_return)
    resp = RedirectResponse(f"{back}/#gh={make_token(row)}&user={login_name}")
    resp.delete_cookie("gh_state")
    resp.delete_cookie("gh_return")
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
        "unitIndex": s.unit_index,
        "unitLabel": s.unit_label,
        "msgs": len(s.messages),
        "corrections": len(s.corrections),
    }


def _session_detail(s: SessionRow) -> dict[str, Any]:
    return {
        "id": s.id,
        "startedAt": _ms(s.started_at),
        "seconds": _seconds(s),
        "scenario": s.scenario,
        "unitIndex": s.unit_index,
        "unitLabel": s.unit_label,
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
    unit: int | None = None,
    user: UserRow = Depends(auth_dep),
    db: Session = Depends(get_db),
) -> list[dict[str, Any]]:
    # 连上就断、一句话没说的会话不列出;?unit=N 只看练该单元的
    q = select(SessionRow).where(SessionRow.user_id == user.id, _has_msgs())
    if unit is not None:
        q = q.where(SessionRow.unit_index == unit)
    rows = db.scalars(
        q.order_by(SessionRow.started_at.desc(), SessionRow.id.desc()).limit(LIST_LIMIT)
    ).all()
    return [_session_out(s) for s in rows]


def _has_msgs() -> Any:
    return exists().where(MessageRow.session_id == SessionRow.id)


@app.get("/api/units/stats")
def unit_stats(
    user: UserRow = Depends(auth_dep), db: Session = Depends(get_db)
) -> dict[str, int]:
    """每个多邻国单元练了几次(只算有对话的会话);站点学习路径页标「练过 N 次」用。"""
    rows = db.execute(
        select(SessionRow.unit_index, func.count())
        .where(
            SessionRow.user_id == user.id,
            SessionRow.unit_index.is_not(None),
            _has_msgs(),
        )
        .group_by(SessionRow.unit_index)
    ).all()
    return {str(idx): n for idx, n in rows}


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
