"""鉴权:GitHub PAT 校验(白名单)→ 30 天 JWT 的签发与校验。"""

import os
from datetime import datetime, timedelta, timezone

import httpx
import jwt
from fastapi import HTTPException
from sqlalchemy.orm import Session

from models import UserRow

JWT_SECRET = os.getenv("JWT_SECRET", "")
GITHUB_ALLOWLIST = {
    s.strip().lower() for s in os.getenv("GITHUB_ALLOWLIST", "").split(",") if s.strip()
}
TOKEN_TTL_DAYS = 30


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
