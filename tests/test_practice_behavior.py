"""Emma 按今日练习内容开场/带对话的行为测试:真实 LLM(LiveKit Inference)+ LLM 评判。

文本模式跑 AgentSession,不需要房间/语音;没有 LiveKit 凭证(.env.local)时跳过。
"""

import json
import os

import pytest
from livekit.agents import AgentSession, inference

from agent.corrections import ANALYZER_MODEL
from agent.main import Assistant
from agent.practice import parse_practice

pytestmark = pytest.mark.skipif(
    not (os.getenv("LIVEKIT_API_KEY") and os.getenv("LIVEKIT_API_SECRET")),
    reason="needs LiveKit Inference credentials in .env.local",
)

UNIT = parse_practice(
    json.dumps(
        {
            "mode": "unit",
            "unit": {
                "index": 45,
                "label": "第3阶段 第6部分",
                "objective": "讨论对超级碗的喜好",
                "sentences": [
                    {"en": "I love watching sports.", "zh": "我非常喜欢看体育比赛。"},
                    {
                        "en": "Do you like watching the game at a bar?",
                        "zh": "你喜欢在酒吧看比赛吗?",
                    },
                    {
                        "en": "My grandma likes watching football.",
                        "zh": "我奶奶喜欢看足球。",
                    },
                    {
                        "en": "The Super Bowl is a big game.",
                        "zh": "超级碗是一场大比赛。",
                    },
                ],
            },
        },
        ensure_ascii=False,
    )
)
SCENARIO = parse_practice(
    json.dumps({"mode": "scenario", "scenario": "ordering coffee"})
)


def judge_llm() -> inference.LLM:
    return inference.LLM(model=ANALYZER_MODEL)


async def test_unit_opening_is_on_topic_and_short():
    async with judge_llm() as judge, AgentSession() as session:
        result = await session.start(Assistant(practice=UNIT), capture_run=True)
        await result
        result.expect.skip_next_event_if(type="agent_handoff")
        await (
            result.expect.next_event()
            .is_message(role="assistant")
            .judge(
                judge,
                intent=(
                    "Greets the student and opens a conversation about watching sports "
                    "or the Super Bowl, asking the student a simple question about it. "
                    "Uses only short, simple English sentences suitable for a beginner."
                ),
            )
        )


async def test_unit_keeps_practicing_the_key_patterns():
    async with judge_llm() as judge, AgentSession() as session:
        await session.start(Assistant(practice=UNIT))
        result = await session.run(user_input="Yes. I like football.")
        await result.expect.next_event(type="message").judge(
            judge,
            intent=(
                "Reacts to the student liking football and keeps the conversation on "
                "watching sports or games, with a follow-up question that invites the "
                "student to say another sentence like 'I love watching sports' or "
                "'Do you like watching the game at a bar?'. Short, simple English."
            ),
        )


async def test_scenario_opening_plays_the_role():
    async with judge_llm() as judge, AgentSession() as session:
        result = await session.start(Assistant(practice=SCENARIO), capture_run=True)
        await result
        result.expect.skip_next_event_if(type="agent_handoff")
        await (
            result.expect.next_event()
            .is_message(role="assistant")
            .judge(
                judge,
                intent=(
                    "Starts an ordering-coffee role play, for example speaking as a cafe "
                    "staff member asking what the student would like. Short, simple English."
                ),
            )
        )


async def test_free_chat_opening_asks_what_to_practice():
    async with judge_llm() as judge, AgentSession() as session:
        result = await session.start(Assistant(), capture_run=True)
        await result
        result.expect.skip_next_event_if(type="agent_handoff")
        await (
            result.expect.next_event()
            .is_message(role="assistant")
            .judge(
                judge,
                intent="Greets the student and asks what they would like to practice today.",
            )
        )
