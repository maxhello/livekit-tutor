"""on_user_turn_completed hook 测试:Stub LLM + 假 room,不碰网络。

验证:有问题→恰好发布一张 correction 卡;没问题/分析抛错→零发布且异常不外溢。
"""

import asyncio
import json
from types import SimpleNamespace
from unittest import mock

from livekit.agents import llm

from agent.agent import Assistant

GOOD = json.dumps(
    {
        "issue": True,
        "original": "I go to school yesterday.",
        "corrected": "I went to school yesterday.",
        "kind": "grammar",
        "point": "过去的事用过去式 went。",
        "words": [{"word": "went", "ipa": "/wɛnt/", "tip_cn": "短元音"}],
    },
    ensure_ascii=False,
)
NO_ISSUE = json.dumps({"issue": False})


class StubStream:
    def __init__(self, text: str):
        self._text = text
        self.closed = False

    async def collect(self):
        return SimpleNamespace(text=self._text)

    async def aclose(self):
        self.closed = True


class StubLLM:
    def __init__(self, text: str = GOOD):
        self.text = text
        self.calls: list[llm.ChatContext] = []

    def chat(self, *, chat_ctx: llm.ChatContext):
        self.calls.append(chat_ctx)
        return StubStream(self.text)


class RaisingLLM(StubLLM):
    def chat(self, *, chat_ctx):
        self.calls.append(chat_ctx)
        return StubStream("")  # 空输出 → parse 返回 None


class FakePublisher:
    def __init__(self):
        self.published: list[tuple[str, dict]] = []

    async def publish_data(self, payload, reliable=True, topic=""):
        self.published.append((topic, json.loads(payload)))


def make_assistant(analyzer: StubLLM) -> tuple[Assistant, FakePublisher]:
    a = Assistant(analyzer_llm=analyzer)  # type: ignore[arg-type]
    a._session_started_monotonic = asyncio.get_event_loop().time()
    publisher = FakePublisher()
    fake_session = SimpleNamespace(
        room_io=SimpleNamespace(room=SimpleNamespace(local_participant=publisher))
    )
    patcher = mock.patch.object(
        Assistant, "session", new_callable=mock.PropertyMock, return_value=fake_session
    )
    patcher.start()
    return a, publisher


async def run_turn(a: Assistant, text: str) -> None:
    await a.on_user_turn_completed(
        llm.ChatContext(), llm.ChatMessage(role="user", content=[text])
    )
    await asyncio.gather(*list(a._analysis_tasks))


async def test_publishes_card_on_real_mistake():
    analyzer = StubLLM(GOOD)
    a, publisher = make_assistant(analyzer)
    await run_turn(a, "I go to school yesterday.")

    assert len(publisher.published) == 1
    topic, card = publisher.published[0]
    assert topic == "correction"
    assert card["original"] == "I go to school yesterday."
    assert card["corrected"] == "I went to school yesterday."
    assert card["kind"] == "grammar"
    assert card["at"] >= 0  # at 由发布侧盖章
    # 分析 prompt 带上了待评分句
    assert "I go to school yesterday." in analyzer.calls[0].messages()[1].text_content


async def test_no_publish_when_no_issue():
    a, publisher = make_assistant(StubLLM(NO_ISSUE))
    await run_turn(a, "hello there")
    assert publisher.published == []


async def test_no_publish_on_garbage_output():
    a, publisher = make_assistant(StubLLM("模型坏掉了,这不是 JSON"))
    await run_turn(a, "hello there")
    assert publisher.published == []


async def test_short_or_chinese_turn_skips_analysis():
    analyzer = StubLLM(GOOD)
    a, publisher = make_assistant(analyzer)
    await run_turn(a, "你好")  # 纯中文
    await run_turn(a, "hello")  # 单词
    assert analyzer.calls == []
    assert publisher.published == []


async def test_rate_limit_one_analysis_per_interval():
    analyzer = StubLLM(GOOD)
    a, publisher = make_assistant(analyzer)
    await run_turn(a, "I go to school yesterday.")
    await run_turn(a, "She like apples very much.")  # 8 秒内的第二轮 → 不分析
    assert len(analyzer.calls) == 1
    assert len(publisher.published) == 1
