"""Light extraction by rules (§5 step 1): what the brief says, and which pinned source
items speak to which question category.

Deterministic, so an intake has a first analysis at once and the same snapshot always
gives the same result. The built-in ``intake_analysis`` job (``oracle.intake.job``) adds
model inferences on top. Everything here is labelled honestly (§5 step 3): the brief is
the author's **hypothesis**; a source item that seems to answer a category is an **AI
inference** with its confidence, never a verified fact.
"""

import re
from collections import defaultdict
from dataclasses import dataclass, field
from typing import Any

from oracle.baseline.conflicts import source_class
from oracle.intake.categories import signals_in
from oracle.intake.evidence import PinnedItem

STOPWORDS = frozenset(
    "about above after again also and any are because been before being both but can could "
    "did does doing down during each every few for from further had has have having her "
    "here hers how into its just more most much must not now off once only other our out "
    "over own same she should some such than that the their them then there these they "
    "this those through too under until very was were what when where which while who "
    "whom why will with would you your add make let lets want need needs so".split()
)
_WORD = re.compile(r"[a-z][a-z'-]{2,}")
_SENTENCE = re.compile(r"(?<=[.!?])\s+")
# Starts only where a whitespace run starts, so a long run is scanned once (linear).
_CLAUSE_END = re.compile(r"(?<!\s)\s++(?:so that|so|to|and|because|which|but)\s+|[,;:]")

_USER = re.compile(
    r"\b((?:new|returning|existing|enterprise|small|internal|mobile|first[- ]time|power|"
    r"paying|free|trial)\s+)?(buyers?|customers?|users?|teams?|admins?|developers?|"
    r"managers?|sellers?|merchants?|shoppers?|founders?|engineers?|operators?|agents?)\b",
    re.I,
)
_OUTCOME = [
    re.compile(r"\bso(?: that)?\s+([^.;]{6,160})", re.I),
    re.compile(
        r"\b((?:increase|reduce|cut|improve|grow|lower|raise|speed up|shorten|double|halve)"
        r"[^.;]{3,160})",
        re.I,
    ),
]
_FEATURE = re.compile(
    r"\b(add|build|let|allow|enable|support|show|create|offer|launch|introduce|use|"
    r"pre-?fill|automate)\s+([^.;]{3,160})",
    re.I,
)
_NON_GOAL = re.compile(r"\b(?:not|without|out of scope:?|excluding|never)\s+([^.;,]{3,120})", re.I)
_DEPENDENCY = re.compile(
    r"\b(?:depends on|requires|relies on|needs|via|from the|using the)\s+([^.;,]{3,120})", re.I
)
# "<topic> is 52%": the matches of
#   ([a-z][a-z ]{2,60}?)\s+(?:is|was|are|were|at|of|=|:)\s*(\d+(?:\.\d+)?)\s*%
# found in linear time. That pattern retries the same tail ("is" + spaces + number) from
# every one of up to 61 starts before it; percent_claims finds each tail once, then the
# topic in at most the 61 characters before it.
_PERCENT_TAIL = re.compile(
    r"(?<!\s)(\s++)(?:is|was|are|were|at|of|=|:)\s*+(\d++(?:\.\d++)?+)\s*+%", re.I
)
_PERCENT_TOPIC = re.compile(r"([a-z][a-z ]{2,60}?)\s+\Z", re.I)

# Which categories a source item speaks to, by what it says.
CATEGORY_CUES: dict[str, re.Pattern[str]] = {
    "pain_evidence": re.compile(
        r"\b(complain\w*|frustrat\w*|slow|abandon\w*|churn\w*|requests?|tickets?|pain\w*|"
        r"annoy\w*|drop[- ]?off|struggl\w*|confus\w*)\b",
        re.I,
    ),
    # A number starts where its digits start, so a long digit run is scanned once (linear).
    "success_metric": re.compile(
        r"((?<!\d)\d++(?:\.\d++)?+\s*+%|\b(conversion|rate|baseline|metric|kpi|median|nps)\b)",
        re.I,
    ),
    "customer_user": re.compile(r"\b(customers?|users?|buyers?|segment|persona|shoppers?)\b", re.I),
    "differentiation": re.compile(r"\b(competitors?|differentiat\w*|unique|moat)\b", re.I),
    "alternatives": re.compile(r"\b(alternatives?|instead|workaround|versus|vs\.?)\b", re.I),
    "blockers": re.compile(
        r"\b(rate limits?|quotas?|blocked|blockers?|cannot|can't|approval needed)\b", re.I
    ),
    "constraints": re.compile(r"\b(constraints?|limitations?|legacy|must not|deadline)\b", re.I),
    "third_party_policy": re.compile(
        r"\b(api|third[- ]party|partners?|vendor|terms of service|platform polic\w*)\b", re.I
    ),
    "security_privacy": re.compile(
        r"\b(security|privacy|gdpr|pii|personal data|encrypt\w*|consent)\b", re.I
    ),
    "economic_benefit": re.compile(
        r"(\$\s?\d|\b(revenue|savings?|retention|arr|mrr|margin|profit)\b)", re.I
    ),
    "effort_cost": re.compile(r"\b(estimates?|effort|story points|engineer[- ]weeks?)\b", re.I),
    "ownership": re.compile(r"\b(owners?|owns|responsible|accountable|dri)\b", re.I),
    "release_rollout": re.compile(
        r"\b(rollout|roll out|beta|feature flag|launch|rollback)\b", re.I
    ),
    "evaluation_criteria": re.compile(r"\b(acceptance criteria|evals?|test plan|qa)\b", re.I),
    "configurability_scaling": re.compile(
        r"\b(scale|scaling|throughput|latency|configurable|settings)\b", re.I
    ),
}


def stem(word: str) -> str:
    return word[:5] if len(word) > 5 else word


def terms(text: str) -> set[str]:
    """Content words of a text, crudely stemmed, for matching briefs to items and goals."""
    return {stem(w) for w in _WORD.findall(text.lower()) if w not in STOPWORDS}


def _clause(text: str) -> str:
    text = _CLAUSE_END.split(text, maxsplit=1)[0]
    return text.strip(" .;,:-").strip()


def percent_claims(text: str) -> list[tuple[str, str]]:
    """(topic, number) for each "<topic> is <number>%" in the text."""
    claims, pos = [], 0
    for tail in _PERCENT_TAIL.finditer(text):
        space, keyword = tail.span(1)
        # The topic ends inside the space before the keyword, at most 61 characters after
        # it starts, so the space past that is never read.
        topic = _PERCENT_TOPIC.search(text, max(pos, space - 61), min(keyword, space + 62))
        if topic:
            claims.append((topic.group(1), tail.group(2)))
            pos = tail.end()
    return claims


def _dedupe(values: list[str]) -> list[str]:
    seen, out = set(), []
    for v in values:
        key = v.lower()
        if v and key not in seen:
            seen.add(key)
            out.append(v)
    return out


@dataclass
class BriefFacts:
    problem: str | None
    users: list[str]
    outcomes: list[str]
    features: list[str]
    non_goals: list[str]
    dependencies: list[str]
    blockers: list[str]
    signals: dict[str, bool]
    category: str

    def items(self) -> list[dict[str, Any]]:
        """Extracted items, each the author's claim (hypothesis), with origin brief."""
        rows: list[tuple[str, str]] = []
        if self.problem:
            rows.append(("problem", self.problem))
        rows += [("users", u) for u in self.users]
        rows += [("outcomes", o) for o in self.outcomes]
        rows += [("scope", f) for f in self.features]
        rows += [("non_goals", n) for n in self.non_goals]
        rows += [("dependencies", d) for d in self.dependencies]
        rows += [("blockers", b) for b in self.blockers]
        return [
            {
                "field": f,
                "text": t,
                "knowledge_state": "hypothesis",
                "origin": "brief",
                "evidence_ids": [],
            }
            for f, t in rows
        ]


def from_brief(brief: str) -> BriefFacts:
    sentences = [s.strip() for s in _SENTENCE.split(brief.strip()) if s.strip()]
    users = _dedupe([" ".join(p for p in m.groups() if p).strip() for m in _USER.finditer(brief)])
    outcomes = []
    for pattern in _OUTCOME:
        outcomes += [_clause(m.group(1)) for m in pattern.finditer(brief)]
    features = [
        _clause(f"{m.group(1).capitalize()} {m.group(2)}") for m in _FEATURE.finditer(brief)
    ]
    signals = signals_in(brief)
    blockers = [s.rstrip(".") for s in sentences if signals_in(s)["blockers"]]
    if signals["ai"]:
        category = "ai_feature"
    elif signals["new_product"]:
        category = "new_product"
    elif signals["third_party"]:
        category = "integration"
    else:
        category = "feature"
    return BriefFacts(
        problem=sentences[0].rstrip(".") if sentences else None,
        users=users[:5],
        outcomes=_dedupe([o for o in outcomes if len(o) > 5])[:5],
        features=_dedupe([f for f in features if len(f.split()) >= 2])[:5],
        non_goals=_dedupe([_clause(m.group(1)) for m in _NON_GOAL.finditer(brief)])[:5],
        dependencies=_dedupe([_clause(m.group(1)) for m in _DEPENDENCY.finditer(brief)])[:5],
        blockers=_dedupe(blockers)[:5],
        signals=signals,
        category=category,
    )


def relevant(items: list[PinnedItem], brief: str) -> list[PinnedItem]:
    """Pinned items that share enough content words with the brief to matter."""
    wanted = terms(brief)
    need = 2 if len(wanted) >= 4 else 1
    return [i for i in items if len(wanted & terms(f"{i.title or ''} {i.text}")) >= need]


@dataclass
class SourceFacts:
    # Category -> items that seem to speak to it (an inference).
    by_category: dict[str, list[PinnedItem]] = field(default_factory=lambda: defaultdict(list))
    conflicts: list[dict[str, Any]] = field(default_factory=list)
    stale: list[PinnedItem] = field(default_factory=list)
    signals: dict[str, bool] = field(default_factory=dict)


def from_sources(items: list[PinnedItem], stale_freshness: float) -> SourceFacts:
    facts = SourceFacts()
    claims: dict[str, list[tuple[str, PinnedItem]]] = defaultdict(list)
    signals: dict[str, bool] = {}
    for item in items:
        text = f"{item.title or ''} {item.text}"
        for category, cue in CATEGORY_CUES.items():
            if cue.search(text):
                facts.by_category[category].append(item)
        for name, value in signals_in(text).items():
            signals[name] = signals.get(name, False) or value
        for found, value in percent_claims(item.text):
            topic = " ".join(found.lower().split()[-3:])
            claims[topic].append((f"{value}%", item))
        if item.freshness <= stale_freshness:
            facts.stale.append(item)
    facts.signals = signals
    for topic, found in sorted(claims.items()):
        values = {v for v, _ in found}
        if len(values) < 2:
            continue
        facts.conflicts.append(
            {
                "topic": topic,
                "claims": [
                    {
                        "value": value,
                        "item_id": str(item.id),
                        "source_kind": item.row.source_kind,
                        "source_class": source_class(item.row.source_kind),
                        "observed_at": _observed(item),
                        "confidence": item.confidence,
                    }
                    for value, item in found
                ],
            }
        )
    return facts


def _observed(item: PinnedItem) -> str | None:
    i = item.row.item
    stamps = [t for t in (i.source_updated_at, i.occurred_at) if t is not None]
    if not stamps and item.row.version is not None:
        stamps = [item.row.version.fetched_at]
    return max(stamps).isoformat() if stamps else None
