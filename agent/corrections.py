"""实时纠错的纯逻辑:门控、卡片解析、分析 prompt 组装。

不依赖 Agent SDK 会话(只用到 llm.ChatContext 类型),可独立单测;
hook 接线(何时触发、怎么发布)在 agent/agent.py 的 Assistant 里。
"""

import json
import re
import textwrap

from livekit.agents import llm

CORRECTION_SYSTEM_PROMPT = textwrap.dedent(
    """\
    You are an English grading engine for a Chinese adult beginner (CEFR A1, about one
    month into learning English). You read a short conversation and the student's latest
    sentence, and decide whether it contains a real English mistake worth logging in a
    study notebook.

    Rules:
    - Only flag REAL mistakes: grammar, wrong/missing word, or an obvious
      pronunciation-suspect word. Do NOT flag style, formality, short answers, or
      correct sentences. Simple but correct A1 English is correct.
    - If the student spoke Chinese, output no issue.
    - Never invent content that is not in the student's sentence.
    - "corrected" must be the minimal fix of "original" — keep the student's own words,
      change as little as possible, keep it under 12 words.
    - "point" is one concise Chinese sentence (max 40 Chinese characters) that an A1
      learner understands. No English meta-language.
    - kind: "grammar" for word forms/tense/agreement/word order; "word" for wrong or
      missing word choice; "pronunciation" only when a word is likely mispronounced
      (use the provided low-confidence STT words as hints; if none are provided, never
      choose "pronunciation").
    - "words": the 1-3 most valuable focus words of the sentence (max 3): the word, its
      IPA, and a short Chinese pronunciation tip. Empty list if not useful.
    - Output STRICT JSON only, no markdown fences, no commentary:
      {"issue": true, "original": "...", "corrected": "...", "kind": "grammar",
       "point": "...", "words": [{"word": "...", "ipa": "...", "tip_cn": "..."}]}
    - If there is no real mistake, output exactly {"issue": false}
    """
)

CORRECTION_TOPIC = "correction"
ANALYZER_MODEL = "google/gemini-3.1-flash-lite"
MIN_ANALYSIS_INTERVAL = 8.0  # 两次分析的最小间隔(秒),防刷屏
MIN_WORDS_TO_ANALYZE = 2  # 英文词数下限(纯中文/单词不算)
ANALYZER_TIMEOUT = 12.0
_CARD_KINDS = {"grammar", "word", "pronunciation"}
_POINT_MAX = 120


def should_analyze(
    user_text: str, last_analysis_monotonic: float | None, now: float
) -> bool:
    """门控:至少 2 个英文词,且距上次分析 ≥ 8 秒。"""
    if len(re.findall(r"[a-zA-Z]+", user_text)) < MIN_WORDS_TO_ANALYZE:
        return False
    if last_analysis_monotonic is None:
        return True
    return now - last_analysis_monotonic >= MIN_ANALYSIS_INTERVAL


def _norm(s: str) -> str:
    return " ".join(s.lower().split())


def parse_correction_card(raw: str) -> dict | None:
    """从模型输出里抠出纠错卡 JSON 并校验/钳位;没有真问题或解析失败返回 None。"""
    start, end = raw.find("{"), raw.rfind("}")
    if start < 0 or end <= start:
        return None
    try:
        data = json.loads(raw[start : end + 1])
    except ValueError:
        return None
    if not isinstance(data, dict) or data.get("issue") is False:
        return None
    original = str(data.get("original") or "").strip()
    corrected = str(data.get("corrected") or "").strip()
    kind = str(data.get("kind") or "").strip()
    point = str(data.get("point") or "").strip()[:_POINT_MAX]
    if not original or not corrected or not point or kind not in _CARD_KINDS:
        return None
    if _norm(original) == _norm(corrected):
        return None
    words: list[dict[str, str]] = []
    for w in data.get("words") or []:
        if not isinstance(w, dict):
            continue
        word = str(w.get("word") or "").strip()[:40]
        if not word:
            continue
        words.append(
            {
                "word": word,
                "ipa": str(w.get("ipa") or "").strip()[:60],
                "tip_cn": str(w.get("tip_cn") or "").strip()[:80],
            }
        )
        if len(words) >= 3:
            break
    return {
        "original": original,
        "corrected": corrected,
        "kind": kind,
        "point": point,
        "words": words,
    }


def build_analyzer_messages(
    history: list[str], user_text: str, low_conf_words: list[str]
) -> llm.ChatContext:
    """组装分析请求:系统提示 + (最近对话 + 低置信度词 + 待评分句)。"""
    parts: list[str] = []
    if history:
        parts.append("Recent conversation:\n" + "\n".join(history[-8:]))
    if low_conf_words:
        parts.append(
            "Low-confidence STT words (possible mispronunciations): "
            + ", ".join(low_conf_words)
        )
    parts.append(f'Grade this sentence from the Student: "{user_text}"')
    ctx = llm.ChatContext()
    ctx.add_message(role="system", content=CORRECTION_SYSTEM_PROMPT)
    ctx.add_message(role="user", content="\n\n".join(parts))
    return ctx
