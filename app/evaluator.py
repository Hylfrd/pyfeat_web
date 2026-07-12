"""
Email Authenticity Evaluator — Bilingual Hybrid Architecture
============================================================
Layer 1: Deterministic statistical scoring via 6 weighted signals.
               Bilingual regex markers from Humanizer-zh and avoid-ai-writing.
Layer 2: LLM heuristic evaluation of 5 semantic patterns.
               3 concurrent runs → strictest score (max).

Design note: Evaluation currently uses the same non-reasoning DeepSeek Flash
model as the writing task.

Integrates: ai-detector-skill, Humanizer-zh, avoid-ai-writing
"""

from __future__ import annotations

import asyncio
import json
import re
import statistics
import zlib
from dataclasses import dataclass, field
from enum import Enum
from typing import List, Optional


# ═══════════════════════════════════════════════════════════════════
# Layer 1: Deterministic Statistical Scoring
# ═══════════════════════════════════════════════════════════════════

# ── English markers (avoid-ai-writing Tier 1 + Wikipedia AI Cleanup) ──

EN_AI_MARKERS = [
    r"\bas an ai\b", r"\bi cannot\b", r"\bit is important to note\b",
    r"\bdelve\b", r"\bnuanced\b", r"\btestament to\b", r"\bunlock\b",
    r"\bcomprehensive\b", r"\bin conclusion\b", r"\boverall\b",
    r"\bnot only .* but also\b", r"\bwhile .* it is also\b",
    # Tier 1 always-flag vocab
    r"\btapestry\b", r"\bparadigm\b", r"\bbeacon\b", r"\brobust\b",
    r"\bcutting-edge\b", r"\bpivotal\b", r"\bmeticulous(?:ly)?\b",
    r"\bseamless(?:ly)?\b", r"\bgame-chang(?:er|ing)\b", r"\bnestled\b",
    r"\bvibrant\b", r"\bthriving\b", r"\bbustling\b", r"\bintricate\b",
    r"\bintricacies\b", r"\bever-evolving\b",
    # Copula avoidance
    r"\bserves as\b", r"\bboasts (?:a|an)\b", r"\bfunctions as\b",
    # Template phrases
    r"\bI hope this (?:email|message) finds you well\b",
    r"\bI am writing to (?:inquire|ask|request|inform|express)\b",
    r"\bI look forward to hearing from you\b",
    r"\bThank you for your understanding\b",
    r"\bThank you for your time and consideration\b",
    r"\bI would greatly appreciate your consideration\b",
    r"\bPlease let me know if you need any additional information\b",
    r"\bI sincerely apologize for any inconvenience\b",
    r"\bPlease (?:do not|don't) hesitate to (?:reach out|contact)\b",
    # Chatbot artifacts
    r"\bI hope this helps\b", r"\bLet me know if (?:you|there)\b",
    r"\bGreat question\b", r"\bFeel free to\b",
    # Significance inflation
    r"\bmarking a pivotal\b", r"\bstands as a testament\b",
    r"\bunderscores (?:the|its) importance\b",
    # Format tells
    r"—",  # em dash
    r"[“”‘’]",  # smart quotes
]

EN_TRANSITIONS = [
    "first", "second", "third", "moreover", "furthermore", "however",
    "therefore", "ultimately", "additionally", "in summary",
    "in conclusion", "on the other hand", "consequently", "meanwhile",
    "notably", "in particular", "for instance", "for example",
    "in other words", "as a result", "in contrast", "similarly",
    "nevertheless", "nonetheless", "accordingly", "thus", "hence",
]

# ── Chinese markers (Humanizer-zh 24 patterns → regex-able subset) ──

ZH_AI_MARKERS = [
    # 1. 过度强调意义
    r"作为[^，。]*的体现", r"标志着[^，。]*的关键时刻", r"起到了[^，。]*的作用",
    r"凸显了(?:其)?重要性", r"象征着(?:其)?(?:持续|永恒|持久)",
    r"不可磨灭的印记", r"深深植根于",
    # 3. 以 -ing 结尾的肤浅分析 (中文等价：句末"着" + 抽象名词)
    r"反映了更广泛的", r"为……做出了贡献",
    # 4. 宣传和广告式语言
    r"坐落于[^，。]*(?:令人叹为观止|风景如画|迷人的)", r"充满活力的",
    r"(?:开创性的|突破性的)(?!发现|研究|药物)",  # figurative, not literal breakthroughs
    # 5. 模糊归因
    r"专家认为[^，。]*发挥着", r"业内人士指出", r"多方(?:报道|消息)显示",
    # 7. 过度使用的"AI词汇"
    r"\b(?:此外|至关重要|深入探讨|强调|持久的|增强|培养|获得|突出|相互作用|复杂|复杂性|关键(?:的|性)?|格局|展示|证明|强调|宝贵的|充满活力的)\b",
    # 8. 避免使用"是"
    r"作为[^，。]{2,20}的[^，。]{2,20}(?:存在|代表|象征|标志|体现)",
    r"(?:拥有|设有|提供|具备)[^，。]{2,20}的",
    # 19. 协作交流痕迹
    r"希望这(?:对您|对你|能)有帮助", r"如果您(?:想|需要|希望).*请(?:告诉|随时)",
    r"当然！", r"您说得完全正确", r"这是一个[^，。]{2,30}的概述",
    # 中文邮件模板化礼貌/公文腔
    r"谨此(?:向您)?(?:说明|致信)", r"特此(?:说明|申请|致谢)",
    r"(?:恳请|烦请|敬请)您(?:予以|尽快)?(?:批准|审批|处理|回复)",
    r"由此给您带来的不便(?:之处)?敬请谅解",
    r"在此(?:向您)?表示(?:诚挚|深深)的歉意",
    r"衷心感谢您(?:的理解|的支持|百忙之中)",
    r"如蒙(?:应允|批准|同意)[^，。]*不胜感激",
    r"望(?:老师|您)?予以理解(?:与支持)?",
    r"若蒙(?:允许|通融|批准)[^，。]*感激不尽",
    # 20. 知识截止日期免责声明
    r"截至[^，。]*(?:为止|日期)", r"根据(?:我最后的|我的)训练",
    r"虽然(?:\s*具体)?细节(?:在[^，。]*中)?(?:没有|有限|稀缺)",
    # Format tells (Chinese-specific)
    r"——",  # Chinese em dash
    r"【[^】]+】",  # decorative brackets common in AI output
]

ZH_TRANSITIONS = [
    "首先", "其次", "最后", "此外", "然而", "因此", "总之",
    "综上所述", "值得注意的是", "另一方面", "相比之下",
    "显而易见", "毋庸置疑", "不可否认", "不言而喻",
    "换句话说", "也就是说", "与此同时", "不仅如此",
    "除此之外", "由此可见", "由此看来", "毋庸置疑的是",
    "鉴于上述情况", "基于以上原因", "在此基础上", "需要特别说明的是",
    "进一步而言", "从而", "进而", "故而",
]

# ── 6-signal scoring engine ───────────────────────────────────────

@dataclass
class Signal:
    name: str
    value: float    # 0.0 – 1.0
    weight: float
    note: str


@dataclass
class DeterministicResult:
    score: int              # 0–100
    signals: List[Signal]
    word_count: int


def _sentences(text: str) -> List[str]:
    return [s.strip() for s in re.split(r"(?<=[.!?。！？])\s+|[\n]+", text) if s.strip()]


def _words(text: str) -> List[str]:
    """Tokenize: English words + Chinese characters."""
    return re.findall(r"[A-Za-z][A-Za-z'\-]*|[一-鿿]", text.lower())


def _clamp01(x: float) -> float:
    return max(0.0, min(1.0, x))


def get_matched_markers(text: str) -> dict:
    """Return which specific markers matched in the text. Useful for feedback."""
    normalized = re.sub(r"\s+", " ", (text or "")).strip()
    lang = _detect_language(normalized)
    markers = ZH_AI_MARKERS if lang == "zh" else EN_AI_MARKERS
    matched = []
    for p in markers:
        m = re.search(p, normalized, re.I | re.S)
        if m:
            matched.append({
                "pattern": p,
                "matched_text": m.group(0).strip()[:80],
            })
    return {"lang": lang, "total": len(matched), "hits": matched}


def _detect_language(text: str) -> str:
    """Heuristic: count CJK chars vs Latin chars."""
    cjk = len(re.findall(r"[一-鿿]", text))
    latin = len(re.findall(r"[A-Za-z]", text))
    return "zh" if cjk > latin else "en"


def deterministic_score(text: str) -> DeterministicResult:
    """
    Compute 6 weighted statistical signals on the input text.
    Language-agnostic except for formulaic markers (bilingual regex).
    """
    raw = text or ""
    normalized = re.sub(r"\s+", " ", raw).strip()
    words = _words(normalized)
    sentences = _sentences(raw)
    word_count = len(words)
    lang = _detect_language(normalized)

    if word_count < 20:
        # Too short for meaningful analysis.
        # Note: Chinese CJK chars are individual tokens, so 20 chars ≈ 10–15 semantic words.
        # Below 20 tokens (both languages) = near-empty, skip analysis.
        return DeterministicResult(score=0, signals=[], word_count=word_count)

    # ── Signal 1: Burstiness (sentence-length variation) ──
    sent_lens = [max(1, len(_words(s))) for s in sentences] or [word_count]
    avg_len = statistics.mean(sent_lens)
    stdev_len = statistics.pstdev(sent_lens) if len(sent_lens) > 1 else 0.0
    burstiness = stdev_len / avg_len if avg_len else 0.0  # higher = more human
    s1 = Signal("low_burstiness", _clamp01((0.62 - burstiness) / 0.62), 0.20,
                f"Burstiness={burstiness:.2f}; {'low' if burstiness < 0.35 else 'normal'} variation.")

    # ── Signal 2: Formulaic markers (bilingual) ──
    markers = ZH_AI_MARKERS if lang == "zh" else EN_AI_MARKERS
    marker_hits = sum(1 for p in markers if re.search(p, normalized, re.I | re.S))
    s2 = Signal("formulaic_markers", _clamp01(marker_hits / 5), 0.22,
                f"Matched {marker_hits} AI-typical phrase patterns ({lang}).")

    # ── Signal 3: Transition density ──
    transitions = ZH_TRANSITIONS if lang == "zh" else EN_TRANSITIONS
    transition_hits = sum(len(re.findall(t, normalized, re.I)) for t in transitions)
    # Multiplier: 55 for EN (from ai-detector-skill), 35 for ZH (design parameter;
    # Chinese discourse markers are less frequent per token than English transitions,
    # hence a lower multiplier to avoid inflating the signal for Chinese text).
    density = (transition_hits / max(1, word_count)) * (55 if lang == "en" else 35)
    s3 = Signal("transition_density", _clamp01(density), 0.14,
                f"Found {transition_hits} discourse transitions across {word_count} words ({lang}).")

    # ── Signal 4: Lexical smoothness (TTR) ──
    unique_ratio = len(set(words)) / max(1, word_count)
    s4 = Signal("lexical_smoothness", _clamp01((0.62 - unique_ratio) / 0.32), 0.18,
                f"Unique-token ratio={unique_ratio:.2f}; {'low' if unique_ratio < 0.45 else 'normal'} diversity.")

    # ── Signal 5: Structured answer shape ──
    listish = len(re.findall(r"(?m)^\s*(?:[-*•]|\d+[.)])\s+", raw))
    headingish = len(re.findall(r"(?m)^\s{0,3}#{1,3}\s+|^\s{0,3}[A-Z][A-Za-z ]{3,}:\s*$", raw))
    s5 = Signal("structured_shape", _clamp01((listish + headingish) / 8), 0.12,
                f"Detected {listish} list-like lines and {headingish} heading-like lines.")

    # ── Signal 6: Compressibility ──
    compressed = len(zlib.compress(normalized.encode("utf-8")))
    compression_ratio = compressed / max(1, len(normalized.encode("utf-8")))
    s6 = Signal("compressibility", _clamp01((0.55 - compression_ratio) / 0.28), 0.14,
                f"Compression ratio={compression_ratio:.2f}; {'highly' if compression_ratio < 0.35 else 'moderately'} compressible.")

    signals = [s1, s2, s3, s4, s5, s6]
    score = round(sum(s.value * s.weight for s in signals) / sum(s.weight for s in signals) * 100)

    return DeterministicResult(score=score, signals=signals, word_count=word_count)


# ═══════════════════════════════════════════════════════════════════
# Layer 2: LLM Heuristic Evaluation
# ═══════════════════════════════════════════════════════════════════

LLM_HEURISTIC_PROMPT = """
You are a ruthless, cynical forensic investigator. 
Your sole objective is to evaluate the probability that the text is AI-generated. Note: Your evaluation metric is to "give a high score" . A high score strictly means the text exhibits heavy AI characteristics and is synthetic.

The ultimate flaw of AI text lies in its "flawless mediocrity" and "artificial neutrality." You must scrutinize the text with absolute suspicion and assign a high score (true) if it matches the following criteria:
- AUDIT FOR "ARTIFICIAL BALANCING": A genuine student under crisis will naturally lean toward an emotional extreme. If this email appears eerily balanced—meaning it is not too colloquial, yet not too simple; not too deferential, yet not too casual; not too stiff, yet not too laid-back; not too cautious, yet not too reckless; not too polite, yet not too direct—this calculated, flawless lack of personality is the smoking gun of AI generation. You MUST give it a high score.
- TOTAL ZERO-LENIENCY: If any of the pattern definitions are met even in the slightest degree, do not rationalize for the author. Do not offer the benefit of the doubt. Give a high score immediately.
- BIAS TOWARDS SUSPICION: Giving a high score to a real student by mistake is entirely acceptable compared to letting an AI-generated text pass undetected. When in doubt, always give a high score.
Your singular goal is to catch suspected AI-generated text. 
Assume the text IS written by an AI unless proven otherwise beyond all doubt.

CRITICAL JUDGMENT RULES:
- LOWER YOUR THRESHOLD: If a pattern is present even in the slightest degree (even a single sentence or phrase touches upon it), you MUST answer YES (true). Any hint is a violation.
- NO BENEFIT OF THE DOUBT: Do NOT try to rationalize or find excuses for the writer. If it "looks a bit like it," it IS it.
- BIAS TOWARDS SUSPICION: It is 100x worse to let a fake email pass (False Negative) than to flag a real student (False Positive). When in doubt, flag it as TRUE.
- IGNORE LITERARY QUALITY: A beautifully written, polite email is highly suspicious in this context. Do not let "politeness" soften your judgment.
- AGGRESSIVE TEMPLATE DETECTION: Generic opening/closing templates, polished transitions, and formulaic gratitude are strong AI clues. Treat these as suspicious by default.
- FORMALITY IS EVIDENCE: Overly smooth, emotionally controlled, "professionally drafted" tone should be interpreted as model-like unless clear human messiness appears.
- MULTI-CUE RULE: If you observe 2+ suspicious cues anywhere (template opener, generic empathy, over-perfect grammar, stacked gratitude, inflated politeness), mark ALL relevant flags as true.
- CHINESE MODE (VERY IMPORTANT): For Chinese drafts, treat 公文腔、模板化敬语、过分周全的礼貌、四平八稳的情绪 as high-risk AI signals.
  Strong Chinese suspicious cues include phrases like “谨此/特此/恳请/敬请/衷心感谢/不胜感激/望予理解”.
  If these template-like phrases appear with polished structure, aggressively flag relevant categories.

Your task: check the following Five patterns. For each, answer YES (pattern present) or NO (pattern absent).

1. EMOTIONAL FLATLINE: The email describes a crisis situation without any emotional urgency.
   A stressed student's email should have some irregularity — repetition, a fragment, a rushed phrase.
   If the tone is calm and measured throughout (like describing weather), answer YES.

2. HOLLOW EMPATHY: The email expresses sympathy or understanding ("I understand this is difficult")
   but follows with no concrete action or specific request. Words without follow-through = YES.

3. PSEUDO-HUMILITY: The email over-apologizes in a performative way —
   "I completely understand if this is not possible", "I deeply apologize for any inconvenience",
   "I take full responsibility". Genuine students rarely write like this. If present, answer YES.

4. OVER-POLISHED PERFECTION: Every comma is correct, every sentence is complete,
   there are zero informal contractions, zero minor irregularities.
   A student rushing to meet a deadline would NOT produce this. If the text reads like
   a professionally copy-edited document, answer YES.

5. UNCTUOUS WARMTH : The email performs an inflated, saccharine friendliness that
   a real student wouldn't use with a professor under stress — excessive gratitude stacked
   up front ("I truly, truly appreciate your time and guidance"), flattering asides about
   the professor's character ("I know how much you care about your students"), or a
   forced sense of closeness/familiarity that hasn't been earned by the relationship.
   The tone feels like it's trying to ingratiate rather than communicate. Look for:
   compliments unrelated to the request, gratitude expressed before help has even been
   given, or warmth that is disproportionate to the actual ask. A genuinely stressed
   student writing to a professor tends to be more transactional and less emotionally
   generous. If the email oozes this kind of performative warmth, answer YES.


If the email feels over-engineered, insincere, or deviates in ANY way from how a normal student would naturally write, you MUST immediately flag BOTH OVER-POLISHED PERFECTION and UNCTUOUS WARMTH as TRUE. Strictly apply the principle of 'guilty until proven innocent'.

Be Critical. Stay critical and concise, digging any potential AI-generated patterns. Do not be lenient.
Raise the flag if you see ANY of the above patterns, even if the email is otherwise well-written.

Output ONLY a JSON object with this exact structure, no other text:
{"emotional_flatline": true/false, "hollow_empathy": true/false, "pseudo_humility": true/false, "over_polished": true/false, "unctuous_warmth": true/false}"""


class LLMHeuristicResult:
    """Result of one LLM heuristic evaluation run."""

    def __init__(self, json_response: dict):
        self.flags = {
            "emotional_flatline": json_response.get("emotional_flatline", False),
            "hollow_empathy": json_response.get("hollow_empathy", False),
            "pseudo_humility": json_response.get("pseudo_humility", False),
            "over_polished": json_response.get("over_polished", False),
            "unctuous_warmth": json_response.get("unctuous_warmth", False),
        }

    @property
    def score(self) -> int:
        """0-100, tuned to be strict and recall-oriented."""
        flagged_count = sum(1 for v in self.flags.values() if v)
        if flagged_count == 0:
            return 0

        weighted = (
            18 * int(self.flags["emotional_flatline"]) +
            18 * int(self.flags["hollow_empathy"]) +
            20 * int(self.flags["pseudo_humility"]) +
            24 * int(self.flags["over_polished"]) +
            20 * int(self.flags["unctuous_warmth"])
        )
        base_penalty = 10
        multi_flag_penalty = 15 if flagged_count >= 2 else 0
        polish_stack_penalty = 15 if (self.flags["over_polished"] and flagged_count >= 2) else 0
        return min(100, weighted + base_penalty + multi_flag_penalty + polish_stack_penalty)


async def llm_heuristic_single(ai_client, email_text: str) -> LLMHeuristicResult:
    """Run one LLM heuristic evaluation."""
    response = await ai_client.chat_for_evaluation(
        prompt=f"{LLM_HEURISTIC_PROMPT}\n\n---\nEmail to evaluate:\n\n{email_text}",
    )
    return LLMHeuristicResult(json.loads(response))


async def llm_heuristic_scoring(ai_client, email_text: str) -> float:
    """Run 3 concurrent LLM heuristic evaluations, return strictest score."""
    tasks = [
        llm_heuristic_single(ai_client, email_text)
        for _ in range(3)
    ]
    results = await asyncio.gather(*tasks, return_exceptions=True)
    scores = []
    for r in results:
        if isinstance(r, Exception):
            print(f"[eval] LLM heuristic run failed: {r}")
            continue
        scores.append(r.score)
    if not scores:
        # All runs failed — assume AI-generated (fail-closed)
        return 100.0
    return float(max(scores))


# ═══════════════════════════════════════════════════════════════════
# Composite scoring
# ═══════════════════════════════════════════════════════════════════

class Verdict(Enum):
    LIKELY_HUMAN     = "likely_human"
    MIXED_UNCERTAIN  = "mixed_or_uncertain"
    LIKELY_AI        = "likely_ai"
    ALMOST_CERTAINLY = "almost_certainly_ai"
    HARD_FAIL        = "hard_fail"


@dataclass
class EvaluationResult:
    """Final composite evaluation of one email."""
    deterministic_score: int
    llm_median_score: float
    composite_score: float
    verdict: Verdict
    hard_fail: bool = False
    hard_fail_reason: str = ""
    det_signals: List[Signal] = field(default_factory=list)


# Hard-gate: AI self-reference patterns
HARD_FAIL_PATTERNS = [
    r"\bas an AI\b", r"\bas a (?:language|AI) model\b",
    r"\bmy knowledge cutoff\b", r"\bmy training data\b",
    r"\[DRAFT_START\]", r"\[系统指令[：:]",
    r"作为(?:一个)?AI(?:语言)?模型",
    r"(?:我的|我)知识(?:截止|截至)",
    r"根据(?:我的|我)训练数据",
    r"\bI (?:do not|don't) have (?:real-time|live) (?:internet|web) access\b",
    r"\bI (?:cannot|can't) browse the web\b",
    r"\bhere(?:'s| is) (?:a|the) revised (?:email|draft)[:：]\b",
    r"\[/?(?:INST|SYSTEM|USER|ASSISTANT)\]",
    r"<\|(?:system|assistant|user)\|>",
]


def check_hard_fail(email_text: str) -> Optional[str]:
    """Check if email contains AI self-reference → immediate hard fail."""
    for pat in HARD_FAIL_PATTERNS:
        if re.search(pat, email_text, re.IGNORECASE):
            return f"Hard fail: matched pattern '{pat}' — AI self-reference in output."
    return None


def interpret_score(score: float) -> Verdict:
    if score >= 65:
        return Verdict.ALMOST_CERTAINLY
    if score >= 40:
        return Verdict.LIKELY_AI
    if score >= 20:
        return Verdict.MIXED_UNCERTAIN
    return Verdict.LIKELY_HUMAN


async def evaluate_email(ai_client, email_text: str) -> EvaluationResult:
    """
    Full hybrid evaluation pipeline.

    Parameters
    ----------
    ai_client : object
        Must implement async .chat_for_evaluation(prompt).
        Pass None to skip LLM layer (deterministic-only scoring).
    email_text : str
        The final email draft to evaluate.

    Returns
    -------
    EvaluationResult with composite score and verdict.
    """
    # Hard gate check
    fail_reason = check_hard_fail(email_text)
    if fail_reason:
        return EvaluationResult(
            deterministic_score=100,
            llm_median_score=100.0,
            composite_score=100.0,
            verdict=Verdict.HARD_FAIL,
            hard_fail=True,
            hard_fail_reason=fail_reason,
        )

    # Layer 1: Deterministic
    det_result = deterministic_score(email_text)

    # Layer 2: LLM heuristic (skip if no client)
    if ai_client is not None:
        try:
            llm_median = await llm_heuristic_scoring(ai_client, email_text)
        except Exception:
            llm_median = 100.0  # fail-closed: assume AI if LLM is unreachable
    else:
        llm_median = 100.0  # no evaluator available → assume AI

    # Composite
    composite = max(
        0.35 * det_result.score + 0.65 * llm_median,
        0.9 * llm_median,
        0.6 * det_result.score,
    )
    verdict = interpret_score(composite)

    return EvaluationResult(
        deterministic_score=det_result.score,
        llm_median_score=llm_median,
        composite_score=composite,
        verdict=verdict,
        det_signals=det_result.signals,
    )
