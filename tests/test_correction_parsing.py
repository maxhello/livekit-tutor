"""纠错纯函数测试:门控、解析、prompt 组装。不碰网络与 SDK 会话。"""

from agent.corrections import (
    CORRECTION_SYSTEM_PROMPT,
    build_analyzer_messages,
    parse_correction_card,
    should_analyze,
)

GOOD_CARD = """
{"issue": true, "original": "I go to school yesterday.", "corrected": "I went to school yesterday.",
 "kind": "grammar", "point": "过去的事用过去式 went。", "words": [{"word": "went", "ipa": "/wɛnt/", "tip_cn": "短元音"}]}
"""


# ---------------------------------------------------------------- should_analyze


def test_should_analyze_requires_two_english_words():
    assert not should_analyze("", None, now=0.0)
    assert not should_analyze("   ", None, now=0.0)
    assert not should_analyze("你好", None, now=0.0)  # 纯中文
    assert not should_analyze("hello 你好", None, now=0.0)  # 只有 1 个英文词
    assert should_analyze("hello there", None, now=0.0)
    assert should_analyze("I go to school yesterday.", None, now=0.0)


def test_should_analyze_rate_limits():
    assert not should_analyze(
        "hello there", last_analysis_monotonic=100.0, now=105.0
    )  # <8s
    assert not should_analyze("hello there", last_analysis_monotonic=100.0, now=107.9)
    assert should_analyze(
        "hello there", last_analysis_monotonic=100.0, now=108.0
    )  # 恰好 8s
    assert should_analyze("hello there", last_analysis_monotonic=None, now=0.0)


# ---------------------------------------------------------------- parse


def test_parse_fenced_json():
    card = parse_correction_card(f"```json\n{GOOD_CARD}\n```")
    assert card is not None
    assert card["original"] == "I go to school yesterday."
    assert card["corrected"] == "I went to school yesterday."
    assert card["kind"] == "grammar"
    assert card["point"] == "过去的事用过去式 went。"
    assert card["words"] == [{"word": "went", "ipa": "/wɛnt/", "tip_cn": "短元音"}]


def test_parse_bare_json_and_prose_prefix():
    assert parse_correction_card(GOOD_CARD) is not None
    assert parse_correction_card(f"Here is the card:\n{GOOD_CARD}\nthanks") is not None


def test_parse_no_issue_variants():
    assert parse_correction_card('{"issue": false}') is None
    assert (
        parse_correction_card('{"issue": false, "original": "x", "corrected": "y"}')
        is None
    )
    # 修正后没变化 → 不算问题
    assert (
        parse_correction_card(
            '{"issue": true, "original": "Hello there", "corrected": "hello there",'
            ' "kind": "grammar", "point": "x"}'
        )
        is None
    )
    # 解析失败一律 None
    assert parse_correction_card("") is None
    assert parse_correction_card("not json at all") is None
    assert parse_correction_card("{broken") is None


def test_parse_rejects_bad_fields():
    # kind 白名单
    base = '{"issue": true, "original": "a b", "corrected": "c d", "point": "p", "kind": "%s"}'
    assert parse_correction_card(base % "grammar") is not None
    assert parse_correction_card(base % "unknown") is None
    # original/corrected 必须非空
    assert parse_correction_card(base.replace('"a b"', '""') % "grammar") is None
    assert parse_correction_card(base.replace('"c d"', '""') % "grammar") is None


def test_parse_clamps():
    raw = (
        '{"issue": true, "original": "a b", "corrected": "c d", "kind": "word",'
        ' "point": "' + "长" * 200 + '",'
        ' "words": ['
        '{"word": "w1", "ipa": "i1", "tip_cn": "t1"},'
        '{"word": "w2", "ipa": "i2", "tip_cn": "t2"},'
        '{"word": "w3", "ipa": "i3", "tip_cn": "t3"},'
        '{"word": "w4", "ipa": "i4", "tip_cn": "t4"},'
        '{"ipa": "no-word-key"}'
        "]}"
    )
    card = parse_correction_card(raw)
    assert card is not None
    assert len(card["point"]) <= 120
    assert [w["word"] for w in card["words"]] == [
        "w1",
        "w2",
        "w3",
    ]  # 最多 3 个,无 word 的丢弃


# ---------------------------------------------------------------- prompt 组装


def test_build_analyzer_messages():
    ctx = build_analyzer_messages(
        history=["Student: What you name?", "Emma: What is your name?"],
        user_text="I go to school yesterday.",
        low_conf_words=["yesterday"],
    )
    msgs = ctx.messages()
    assert [m.role for m in msgs] == ["system", "user"]
    assert msgs[0].text_content == CORRECTION_SYSTEM_PROMPT
    body = msgs[1].text_content
    assert "Student: What you name?" in body
    assert "Emma: What is your name?" in body
    assert '"I go to school yesterday."' in body
    assert "yesterday" in body  # 低置信度词出现


def test_build_analyzer_messages_omits_empty_low_conf():
    ctx = build_analyzer_messages(
        history=[], user_text="hello there", low_conf_words=[]
    )
    body = ctx.messages()[1].text_content
    assert "Low-confidence" not in body
