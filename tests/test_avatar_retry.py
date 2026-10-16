"""Simli 头像启动重试测试:假 avatar + 假槽位探测,不碰网络与真实插件。

验证:限流失败后等槽位空出再重试能恢复;重试耗尽安全返回 None;
探测接口挂了照样走完重试;一次成功不多试;job 关闭后不再重试。
"""

import asyncio
from types import SimpleNamespace
from typing import ClassVar
from unittest import mock

import pytest

import agent.main as main_mod


class FakeAvatar:
    """模拟插件"静默失败"行为:wait_for_join 超时抛错,start 不抛。"""

    instances: ClassVar[list["FakeAvatar"]] = []

    def __init__(self, outcomes: list[bool]):
        self.outcomes = outcomes
        self.started = False
        FakeAvatar.instances.append(self)

    async def start(self, session, room) -> None:
        self.started = True

    async def wait_for_join(self, *, timeout: float | None = None) -> None:
        if not self.outcomes.pop(0):
            raise TimeoutError


@pytest.fixture(autouse=True)
def fast_polling(monkeypatch):
    """槽位轮询间隔/等待上限调小,测试毫秒级跑完;进房结果由 FakeAvatar 决定。"""

    async def fake_wait_joined(avatar, room):
        await avatar.wait_for_join()

    monkeypatch.setattr(main_mod, "_wait_avatar_joined", fake_wait_joined)
    monkeypatch.setattr(main_mod, "SIMLI_SLOT_POLL_INTERVAL", 0.01)
    monkeypatch.setattr(main_mod, "SIMLI_SLOT_WAIT_TIMEOUT", 0.05)
    FakeAvatar.instances = []


async def _run(outcomes: list[bool], usage_side_effect, attempts: int = 3):
    with (
        mock.patch.object(
            main_mod, "_new_simli_avatar", lambda cfg: FakeAvatar(outcomes)
        ),
        mock.patch.object(
            main_mod, "_simli_slot_usage", mock.AsyncMock(side_effect=usage_side_effect)
        ),
    ):
        return await main_mod.start_simli_avatar_with_retry(
            session=SimpleNamespace(),
            room=SimpleNamespace(),
            simli_config=SimpleNamespace(),
            api_key="test-key",
            attempts=attempts,
        )


async def test_retry_recovers_after_slot_frees():
    # 第 1 次失败时槽位还被旧会话占着(usage=1),等它归零后第 2 次成功
    avatar = await _run([False, True], [1, 0])
    assert avatar is FakeAvatar.instances[1]
    assert len(FakeAvatar.instances) == 2
    assert all(a.started for a in FakeAvatar.instances)


async def test_gives_up_after_all_attempts():
    avatar = await _run([False, False, False], lambda *a: 1)
    assert avatar is None
    assert len(FakeAvatar.instances) == 3


async def test_retries_even_when_probe_is_down():
    # /ratelimiter/sessions 探测失败(返回 None)不能挡住重试
    avatar = await _run([False, False, False], lambda *a: None)
    assert avatar is None
    assert len(FakeAvatar.instances) == 3


async def test_first_try_success_no_retry_no_probe():
    probe = mock.AsyncMock(return_value=1)
    with (
        mock.patch.object(
            main_mod, "_new_simli_avatar", lambda cfg: FakeAvatar([True])
        ),
        mock.patch.object(main_mod, "_simli_slot_usage", probe),
    ):
        avatar = await main_mod.start_simli_avatar_with_retry(
            session=SimpleNamespace(),
            room=SimpleNamespace(),
            simli_config=SimpleNamespace(),
            api_key="test-key",
            attempts=3,
        )
    assert avatar is FakeAvatar.instances[0]
    assert len(FakeAvatar.instances) == 1
    assert probe.call_count == 0  # 成功路径不需要探测


async def test_stops_when_shutting_down():
    # job 关闭(用户离开触发 shutdown)后不再浪费重试,也不对已关会话做手脚
    stop = asyncio.Event()

    async def probe_then_shutdown(*a):
        stop.set()  # 第 1 次失败的探测一回来,job 已在关闭
        return 0

    with (
        mock.patch.object(
            main_mod, "_new_simli_avatar", lambda cfg: FakeAvatar([False, True])
        ),
        mock.patch.object(main_mod, "_simli_slot_usage", probe_then_shutdown),
    ):
        avatar = await main_mod.start_simli_avatar_with_retry(
            session=SimpleNamespace(),
            room=SimpleNamespace(),
            simli_config=SimpleNamespace(),
            api_key="test-key",
            attempts=3,
            stop=stop,
        )
    assert avatar is None
    assert len(FakeAvatar.instances) == 1  # 关闭后不再做第 2 次尝试


async def test_first_instance_is_reused_not_restarted():
    # session.start 前已 start 的首个实例:第 1 次只等它进房,不再新建/重复 start
    first = FakeAvatar([False])
    first.started = True
    FakeAvatar.instances = []
    with (
        mock.patch.object(
            main_mod, "_new_simli_avatar", lambda cfg: FakeAvatar([True])
        ),
        mock.patch.object(
            main_mod, "_simli_slot_usage", mock.AsyncMock(return_value=0)
        ),
    ):
        avatar = await main_mod.start_simli_avatar_with_retry(
            session=SimpleNamespace(),
            room=SimpleNamespace(),
            simli_config=SimpleNamespace(),
            api_key="test-key",
            attempts=3,
            first=first,
        )
    assert first.outcomes == []  # 第 1 次确实等的是它
    assert len(FakeAvatar.instances) == 1  # 失败后只新建了 1 个重试实例
    assert avatar is FakeAvatar.instances[0]
