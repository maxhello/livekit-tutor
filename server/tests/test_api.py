"""后端 API 测试:sqlite 内存库 + mock GitHub 登录,不碰网络。环境准备见 conftest.py。

每个用例拿到干净数据库(make_client 里 drop/create_all)。
"""

import contextlib
import datetime
import time

from fastapi.testclient import TestClient

import main
from models import SessionLocal


@contextlib.contextmanager
def make_client(github_login: str = "maxhello", pat_ok: bool = True):
    """TestClient + mock 掉 GitHub 校验 + 重建干净库。"""
    main._github_login = (lambda pat: github_login) if pat_ok else (lambda pat: None)
    main.Base.metadata.drop_all(main.engine)
    main.Base.metadata.create_all(main.engine)
    with TestClient(
        main.app, base_url="https://testserver"
    ) as client:  # https 让 secure cookie 可回传
        yield client


def login(client: TestClient, user: str = "maxhello", pat: str = "ghp_x") -> str:
    r = client.post("/api/auth/login", json={"user": user, "pat": pat})
    assert r.status_code == 200, r.text
    return r.json()["token"]


def auth(token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}


def start_session(client: TestClient, token: str) -> int:
    """开练:领房间 token,后端顺带建会话并返回 sessionId。"""
    r = client.post("/api/token", headers=auth(token))
    assert r.status_code == 200, r.text
    return r.json()["sessionId"]


def sample_payload() -> dict:
    return {
        "scenario": "ordering coffee",
        "msgs": [
            {"role": "emma", "text": "Hi! What would you like?"},
            {"role": "me", "text": "I want a coffee"},
        ],
        "corrections": [
            {
                "original": "I want a coffee",
                "corrected": "I'd like a coffee",
                "kind": "word",
                "point": "点单更礼貌的说法",
                "words": [{"word": "coffee", "ipa": "/ˈkɒfi/", "tip_cn": "重音在前"}],
                "at": 42_000,
            }
        ],
    }


def test_health_open():
    with make_client() as c:
        assert c.get("/api/health").json() == {"ok": True}


def test_login_rejects_user_not_in_allowlist():
    with make_client() as c:
        r = c.post("/api/auth/login", json={"user": "eve", "pat": "ghp_x"})
        assert r.status_code == 403


def test_login_rejects_bad_pat():
    with make_client(pat_ok=False) as c:
        r = c.post("/api/auth/login", json={"user": "maxhello", "pat": "bad"})
        assert r.status_code == 401


def test_login_rejects_pat_of_other_user():
    # token 属于 alice,却声称自己是 maxhello
    with make_client(github_login="alice") as c:
        r = c.post("/api/auth/login", json={"user": "maxhello", "pat": "ghp_x"})
        assert r.status_code == 401


def test_endpoints_require_token():
    with make_client() as c:
        assert c.get("/api/sessions").status_code == 401
        assert c.get("/api/sessions/1").status_code == 401
        assert c.put("/api/sessions/1", json=sample_payload()).status_code == 401


def test_rejects_bad_token():
    with make_client() as c:
        r = c.get("/api/sessions", headers=auth("not-a-jwt"))
        assert r.status_code == 401


def test_token_creates_session_with_server_start_time():
    with make_client() as c:
        token = login(c)
        before = int(time.time() * 1000)
        sid = start_session(c, token)
        after = int(time.time() * 1000)
        c.put(f"/api/sessions/{sid}", json=sample_payload(), headers=auth(token))
        detail = c.get(f"/api/sessions/{sid}", headers=auth(token)).json()
        assert detail["id"] == sid
        assert before - 1000 <= detail["startedAt"] <= after + 1000


def test_each_start_gets_a_new_id():
    with make_client() as c:
        token = login(c)
        assert start_session(c, token) != start_session(c, token)


def test_put_list_get_roundtrip():
    with make_client() as c:
        token = login(c)
        sid = start_session(c, token)
        put = c.put(f"/api/sessions/{sid}", json=sample_payload(), headers=auth(token))
        assert put.status_code == 200, put.text

        lst = c.get("/api/sessions", headers=auth(token)).json()
        assert len(lst) == 1
        assert lst[0]["id"] == sid
        assert lst[0]["scenario"] == "ordering coffee"
        assert lst[0]["msgs"] == 2 and lst[0]["corrections"] == 1
        assert lst[0]["seconds"] >= 0

        detail = c.get(f"/api/sessions/{sid}", headers=auth(token)).json()
        assert detail["msgs"][1]["text"] == "I want a coffee"
        assert detail["corrections"][0]["words"][0]["ipa"] == "/ˈkɒfi/"


def test_duration_is_server_side():
    with make_client() as c:
        token = login(c)
        sid = start_session(c, token)
        # 把开始时间往前拨 90 秒,模拟一次 90 秒的通话
        with SessionLocal() as db:
            row = db.get(main.SessionRow, sid)
            row.started_at = row.started_at - datetime.timedelta(seconds=90)
            db.commit()
        c.put(f"/api/sessions/{sid}", json=sample_payload(), headers=auth(token))
        assert (
            89 <= c.get("/api/sessions", headers=auth(token)).json()[0]["seconds"] <= 91
        )


def test_put_is_idempotent_and_keeps_first_end_time():
    with make_client() as c:
        token = login(c)
        sid = start_session(c, token)
        c.put(f"/api/sessions/{sid}", json=sample_payload(), headers=auth(token))
        with SessionLocal() as db:
            ended = db.get(main.SessionRow, sid).ended_at
        p2 = sample_payload()
        p2["msgs"] = [{"role": "me", "text": "hi"}]
        p2["corrections"] = []
        c.put(f"/api/sessions/{sid}", json=p2, headers=auth(token))
        lst = c.get("/api/sessions", headers=auth(token)).json()
        assert len(lst) == 1  # 重复保存不会多出一条
        assert lst[0]["msgs"] == 1 and lst[0]["corrections"] == 0
        detail = c.get(f"/api/sessions/{sid}", headers=auth(token)).json()
        assert detail["msgs"] == [{"role": "me", "text": "hi"}]
        with SessionLocal() as db:
            assert db.get(main.SessionRow, sid).ended_at == ended


def test_put_unknown_id_is_404():
    with make_client() as c:
        token = login(c)
        r = c.put("/api/sessions/999", json=sample_payload(), headers=auth(token))
        assert r.status_code == 404


def test_list_hides_empty_sessions():
    with make_client() as c:
        token = login(c)
        start_session(c, token)  # 连上就断,没保存
        sid = start_session(c, token)
        c.put(f"/api/sessions/{sid}", json=sample_payload(), headers=auth(token))
        assert [
            s["id"] for s in c.get("/api/sessions", headers=auth(token)).json()
        ] == [sid]


def test_user_isolation():
    with make_client() as c:
        token_a = login(c)
        sid = start_session(c, token_a)
        c.put(f"/api/sessions/{sid}", json=sample_payload(), headers=auth(token_a))

        # alice 是白名单里另一个用户,看不到也改不了 maxhello 的会话
        main._github_login = lambda pat: "alice"
        token_b = login(c, user="alice")
        assert c.get("/api/sessions", headers=auth(token_b)).json() == []
        assert c.get(f"/api/sessions/{sid}", headers=auth(token_b)).status_code == 404
        assert (
            c.put(
                f"/api/sessions/{sid}", json=sample_payload(), headers=auth(token_b)
            ).status_code
            == 404
        )
        assert (
            c.delete(f"/api/sessions/{sid}", headers=auth(token_b)).status_code == 404
        )


def test_delete():
    with make_client() as c:
        token = login(c)
        sid = start_session(c, token)
        c.put(f"/api/sessions/{sid}", json=sample_payload(), headers=auth(token))
        assert c.delete(f"/api/sessions/{sid}", headers=auth(token)).status_code == 200
        assert c.get(f"/api/sessions/{sid}", headers=auth(token)).status_code == 404


def test_list_orders_newest_first():
    with make_client() as c:
        token = login(c)
        first = start_session(c, token)
        second = start_session(c, token)
        for sid in (first, second):
            c.put(f"/api/sessions/{sid}", json=sample_payload(), headers=auth(token))
        lst = c.get("/api/sessions", headers=auth(token)).json()
        assert [s["id"] for s in lst] == [second, first]


def test_livekit_token_requires_auth():
    with make_client() as c:
        assert c.post("/api/token").status_code == 401


def test_livekit_token_contains_room_and_dispatch():
    import jwt as pyjwt

    with make_client() as c:
        token = login(c)
        r = c.post("/api/token", headers=auth(token))
        assert r.status_code == 200, r.text
        body = r.json()
        assert body["url"].startswith("wss://")
        assert isinstance(body["sessionId"], int)
        payload = pyjwt.decode(
            body["token"], options={"verify_signature": False}, algorithms=["HS256"]
        )
        # 房间/身份/agent dispatch 都嵌在 token 里,前端拿去直连
        assert payload["video"]["room"] == "tutor-max"
        assert payload["sub"] == "max"
        assert payload["roomConfig"]["agents"][0]["agentName"] == "livekit-tutor"


# ---------------------------------------------------------------- GitHub OAuth


def test_oauth_authorize_redirects_with_state():
    with make_client() as c:
        r = c.get("/api/auth/github", follow_redirects=False)
        assert r.status_code in (302, 307)
        assert r.headers["location"].startswith(
            "https://github.com/login/oauth/authorize"
        )
        assert "client_id=test-client-id" in r.headers["location"]
        assert "gh_state=" in r.headers["set-cookie"]


def test_oauth_callback_rejects_bad_state():
    with make_client() as c:
        r = c.get("/api/auth/github/callback?code=x&state=evil", follow_redirects=False)
        assert r.status_code == 400


def test_oauth_callback_success_flow():
    from urllib.parse import parse_qs, urlparse

    import jwt as pyjwt

    with make_client() as c:
        r = c.get("/api/auth/github", follow_redirects=False)
        state = parse_qs(urlparse(r.headers["location"]).query)["state"][0]

        # mock 掉 GitHub 的两跳:code 换 token、token 查用户
        main._exchange_code = lambda code: "gh-access-token"
        main._github_login = lambda pat: "maxhello"

        r = c.get(
            f"/api/auth/github/callback?code=abc&state={state}", follow_redirects=False
        )
        assert r.status_code in (302, 307), r.text
        loc = r.headers["location"]
        assert loc.startswith("https://front.test/#gh=")
        jwt_token = loc.split("#gh=")[1].split("&")[0]
        payload = pyjwt.decode(
            jwt_token,
            "test-secret-0123456789abcdef0123456789abcdef",
            algorithms=["HS256"],
        )
        assert payload["login"] == "maxhello"


def test_oauth_callback_rejects_user_not_in_allowlist():
    from urllib.parse import parse_qs, urlparse

    with make_client() as c:
        r = c.get("/api/auth/github", follow_redirects=False)
        state = parse_qs(urlparse(r.headers["location"]).query)["state"][0]
        main._exchange_code = lambda code: "gh-access-token"
        main._github_login = lambda pat: "stranger"
        r = c.get(
            f"/api/auth/github/callback?code=abc&state={state}", follow_redirects=False
        )
        assert r.status_code == 403
