"""学生道别时 Emma 自动挂断的行为测试:真实 LLM(LiveKit Inference)。

只验证 Emma 是否调用 end_call 工具——真正的关会话/删房间要在 job 里跑,
文本模式测试不涉及。没有 LiveKit 凭证(.env.local)时跳过。
"""

import os

import pytest
from livekit.agents import AgentSession

from agent.main import Assistant

pytestmark = pytest.mark.skipif(
    not (os.getenv("LIVEKIT_API_KEY") and os.getenv("LIVEKIT_API_SECRET")),
    reason="needs LiveKit Inference credentials in .env.local",
)


async def _reply_to(user_input: str):
    async with AgentSession() as session:
        await session.start(Assistant())
        # 先聊一轮,模拟练习进行中
        await session.run(user_input="I want to talk about my weekend.")
        return await session.run(user_input=user_input)


@pytest.mark.parametrize(
    "goodbye",
    [
        "Okay, I have to go now. Bye bye!",
        "Thank you Emma. See you tomorrow!",
        "好的,今天就到这吧,拜拜",
    ],
)
async def test_hangs_up_when_student_says_goodbye(goodbye):
    result = await _reply_to(goodbye)
    result.expect.contains_function_call(name="end_call")


@pytest.mark.parametrize(
    "not_goodbye",
    [
        "Yesterday I said goodbye to my friend at the station.",
        "How do I say 再见 in English?",
    ],
)
async def test_keeps_talking_when_bye_is_just_a_word(not_goodbye):
    result = await _reply_to(not_goodbye)
    with pytest.raises(AssertionError):
        result.expect.contains_function_call(name="end_call")
