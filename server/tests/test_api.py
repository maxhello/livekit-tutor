"""后端 API 测试:sqlite 内存库 + mock GitHub 登录,不碰网络。环境准备见 conftest.py。

每个用例拿到干净数据库(make_client 里 drop/create_all)。
"""

import contextlib
import time

from fastapi.testclient import TestClient

import main

NOW_MS = int(time.time() * 1000)


@contextlib.contextmanager
def make_client(github_login: str = "maxhello", pat_ok: bool = True):
    """TestClient + mock 掉 GitHub 校验 + 重建干净库。"""
    main._github_login = (lambda pat: github_login) if pat_ok else (lambda pat: None)
    main.Base.metadata.drop_all(main.engine)
    main.Base.metadata.create_all(main.engine)
    with TestClient(main.app) as client:
        yield client


def login(client: TestClient, user: str = "maxhello", pat: str = "ghp_x") -> str:
    r = client.post("/api/auth/login", json={"user": user, "pat": pat})
    assert r.status_code == 200, r.text
    return r.json()["token"]


def auth(token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}


def sample_payload() -> dict:
    return {
        "seconds": 120,
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
        assert c.get("/api/sessions/123").status_code == 401
        assert c.put("/api/sessions/123", json=sample_payload()).status_code == 401


def test_rejects_bad_token():
    with make_client() as c:
        r = c.get("/api/sessions", headers=auth("not-a-jwt"))
        assert r.status_code == 401


def test_put_list_get_roundtrip():
    with make_client() as c:
        token = login(c)
        sid = NOW_MS
        put = c.put(f"/api/sessions/{sid}", json=sample_payload(), headers=auth(token))
        assert put.status_code == 200, put.text

        lst = c.get("/api/sessions", headers=auth(token)).json()
        assert lst == [
            {
                "startedAt": sid,
                "seconds": 120,
                "scenario": "ordering coffee",
                "msgs": 2,
                "corrections": 1,
            }
        ]

        detail = c.get(f"/api/sessions/{sid}", headers=auth(token)).json()
        assert detail["msgs"][1]["text"] == "I want a coffee"
        assert detail["corrections"][0]["words"][0]["ipa"] == "/ˈkɒfi/"


def test_put_is_upsert_replacing_children():
    with make_client() as c:
        token = login(c)
        sid = NOW_MS
        c.put(f"/api/sessions/{sid}", json=sample_payload(), headers=auth(token))
        p2 = sample_payload()
        p2["msgs"] = [{"role": "me", "text": "hi"}]
        p2["corrections"] = []
        c.put(f"/api/sessions/{sid}", json=p2, headers=auth(token))
        lst = c.get("/api/sessions", headers=auth(token)).json()
        assert lst[0]["msgs"] == 1 and lst[0]["corrections"] == 0
        detail = c.get(f"/api/sessions/{sid}", headers=auth(token)).json()
        assert detail["msgs"] == [{"role": "me", "text": "hi"}]


def test_rejects_non_timestamp_id():
    with make_client() as c:
        token = login(c)
        r = c.put("/api/sessions/1", json=sample_payload(), headers=auth(token))
        assert r.status_code == 422


def test_user_isolation():
    with make_client() as c:
        token_a = login(c)
        sid = NOW_MS
        c.put(f"/api/sessions/{sid}", json=sample_payload(), headers=auth(token_a))

        # alice 是白名单里另一个用户,看不到 maxhello 的会话
        main._github_login = lambda pat: "alice"
        token_b = login(c, user="alice")
        assert c.get("/api/sessions", headers=auth(token_b)).json() == []
        assert c.get(f"/api/sessions/{sid}", headers=auth(token_b)).status_code == 404
        assert (
            c.delete(f"/api/sessions/{sid}", headers=auth(token_b)).status_code == 404
        )


def test_delete():
    with make_client() as c:
        token = login(c)
        sid = NOW_MS
        c.put(f"/api/sessions/{sid}", json=sample_payload(), headers=auth(token))
        assert c.delete(f"/api/sessions/{sid}", headers=auth(token)).status_code == 200
        assert c.get(f"/api/sessions/{sid}", headers=auth(token)).status_code == 404


def test_list_orders_newest_first():
    with make_client() as c:
        token = login(c)
        c.put(
            f"/api/sessions/{NOW_MS - 5000}", json=sample_payload(), headers=auth(token)
        )
        c.put(f"/api/sessions/{NOW_MS}", json=sample_payload(), headers=auth(token))
        lst = c.get("/api/sessions", headers=auth(token)).json()
        assert [s["startedAt"] for s in lst] == [NOW_MS, NOW_MS - 5000]
