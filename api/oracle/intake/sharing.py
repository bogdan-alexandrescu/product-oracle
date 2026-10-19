"""Who sees what of an intake's findings (S6, owner decision of 2026-10-19).

An intake reads its author's own sources (AUD-9), which nobody else may read. What
Oracle draws from them is a **finding**, and its author chooses, per finding, what
everyone else sees:

- ``private`` (the default): nothing from it;
- ``counts``: counts and categories only ("1 conflict in success metric evidence");
- ``summary``: Oracle's own summary, never a verbatim excerpt or a number taken from
  the item;
- ``full``: everything, excerpts included.

Findings are the model-written items and gaps (``origin: model``), source conflicts,
stale evidence, and what a rule-made gap's evidence says (``origin: rules``: the gap
itself, a fixed category text known by its ``rule_key``, stays shared; its evidence,
confidence, inferred state and coverage row are the finding, and its importance comes
from the brief and public facts only). A finding drawn only from sources everyone may read is not
restricted; under AUD-9 every source is its owner's alone, so every finding drawn from
an intake's pinned items is.

The levels live in the intake's analysis (``analysis["findings"]``, keyed by finding
id: an item's id, a gap's id, or a stable id for a conflict or stale item), so a
re-analysis keeps them. Model output written from shared text only is registered with
``restricted: false``. Anything drawn from sources that is not registered (an intake
analysed before S6) fails closed: others see it as ``private``, and a model-written gap
never registered as such is registered as a private model finding by the next
analysis. Conflict and stale findings get random ids, so an id never confirms a
guessed topic. Viewers, commenters, approvers, owners and run tokens all see
only what the level allows; the author (never as a run token) sees everything. Every
change of level is audited, and the author can lower a level again at any time.
"""

import hashlib
import re
import uuid
from collections import Counter
from dataclasses import dataclass
from types import SimpleNamespace
from typing import Any

from oracle.auth.deps import Principal
from oracle.intake import categories as cats
from oracle.v2.models import KnowledgeGap, ProductIntake, StakeholderQuestion
from oracle.v2.schemas import KnowledgeGapOut, StakeholderQuestionOut

LEVELS = ("private", "counts", "summary", "full")
RANK = {level: n for n, level in enumerate(LEVELS)}
DEFAULT = "private"
KINDS = ("item", "gap", "conflict", "stale")
FIELD_LABELS = {
    "users": "users",
    "problem": "problem",
    "outcomes": "outcomes",
    "scope": "scope",
    "non_goals": "non-goals",
    "dependencies": "dependencies",
    "blockers": "blockers",
}


@dataclass(frozen=True)
class Viewer:
    """Who reads: the intake's author sees every finding in full; anyone else (and the
    author's own run tokens) sees each finding at its level."""

    is_author: bool
    is_run: bool = False

    def sees(self, level: str | None, need: str) -> bool:
        if level is None or self.is_author:
            return True
        return RANK[level] >= RANK[need]


EVERYONE = Viewer(is_author=False)


def is_author(principal: Principal | None, intake: ProductIntake) -> bool:
    return (
        principal is not None
        and not principal.is_run
        and intake.author_id is not None
        and principal.id == intake.author_id
    )


def viewer(principal: Principal | None, intake: ProductIntake) -> Viewer:
    return Viewer(
        is_author=is_author(principal, intake),
        is_run=principal is not None and principal.is_run,
    )


# --- the registry ---------------------------------------------------------------------


class Registry(dict):
    """An intake's findings by id. ``unregistered``: the intake was analysed before
    findings were registered, so what its sources gave is not listed (fail closed).
    ``analysed``: the intake engine analysed it (so its sources may have been read).
    ``signals`` and ``brief_fields``: what the brief says (public facts), from which a
    rule-made gap's importance is read for everyone else."""

    unregistered: bool = False
    analysed: bool = False
    signals: dict[str, bool] | None = None
    brief_fields: frozenset[str] = frozenset()


def registry(intake: ProductIntake) -> Registry:
    analysis = intake.analysis or {}
    reg = Registry(analysis.get("findings") or {})
    reg.unregistered = "coverage" in analysis and "findings" not in analysis
    reg.analysed = "coverage" in analysis or "findings" in analysis
    if "signals" in analysis:
        reg.signals = analysis.get("signals") or {}
        reg.brief_fields = frozenset(i["field"] for i in brief_items(analysis))
    return reg


def brief_items(analysis: dict[str, Any]) -> list[dict[str, Any]]:
    """The items the brief itself states (everyone reads the brief)."""
    return [i for i in analysis.get("items") or [] if i.get("origin", "brief") == "brief"]


def is_open(entry: dict[str, Any] | None) -> bool:
    """A registered finding drawn from shared text only: not restricted."""
    return entry is not None and entry.get("restricted") is False


def restricted_entry(reg: dict[str, dict[str, Any]], finding_id: Any) -> dict[str, Any] | None:
    entry = reg.get(str(finding_id)) if finding_id is not None else None
    return None if entry is None or is_open(entry) else entry


def level_of(reg: dict[str, dict[str, Any]], finding_id: Any) -> str | None:
    """The finding's level, or None when the thing is not a restricted finding."""
    entry = restricted_entry(reg, finding_id)
    return entry.get("sharing", DEFAULT) if entry else None


def register(
    reg: dict[str, dict[str, Any]],
    finding_id: str,
    *,
    kind: str,
    origin: str,
    category: str | None,
    source_item_ids: list[uuid.UUID] | list[str],
    summary: str,
    gap_id: uuid.UUID | None = None,
    restricted: bool = True,
    match: str | None = None,
    public_state: str | None = None,
) -> dict[str, Any]:
    """Add or refresh a finding; an existing finding keeps the level its author set.
    ``restricted=False``: drawn from shared text only (shown to everyone). ``match``:
    what finds a conflict or stale finding again on the next analysis
    (:func:`finding_id`). ``public_state``: a rule-made gap's knowledge state without
    the author's sources (what others see while its evidence is not shared)."""
    previous = reg.get(finding_id) or {}
    entry = {
        "kind": kind,
        "origin": origin,
        "category": category,
        "source_item_ids": [str(i) for i in dict.fromkeys(source_item_ids)],
        "summary": summary,
        "sharing": previous.get("sharing", DEFAULT),
    }
    if gap_id is not None:
        entry["gap_id"] = str(gap_id)
    if match is not None:
        entry["match"] = match
    if public_state is not None:
        entry["public_state"] = public_state
    if previous.get("public_importance"):
        # A person set the gap's importance: a public fact, kept.
        entry["public_importance"] = previous["public_importance"]
    if not restricted:
        entry["restricted"] = False
    reg[finding_id] = entry
    return entry


def stable_id(intake_id: uuid.UUID, *parts: str) -> str:
    """The id conflicts and stale items had before ids were random. Anyone who knows
    the intake and the item ids could confirm a guessed topic with it, so it is only
    read to carry an old finding's level over (:func:`finding_id`)."""
    return str(uuid.uuid5(intake_id, ":".join(parts)))


def finding_id(
    old: dict[str, dict[str, Any]], intake_id: uuid.UUID, kind: str, *parts: str
) -> tuple[str, dict[str, Any], str]:
    """(id, previous entry, match) of a conflict or stale finding.

    The id is random, so it says nothing about the topic or the items; the stored
    ``match`` (a digest, never shown) finds the same finding on the next analysis, so
    its id and level survive. A finding registered under its old :func:`stable_id`
    keeps its level under a new random id."""
    match = hashlib.sha256(":".join([str(intake_id), kind, *parts]).encode()).hexdigest()
    for fid, entry in old.items():
        if entry.get("match") == match:
            return fid, entry, match
    return str(uuid.uuid4()), old.get(stable_id(intake_id, kind, *parts)) or {}, match


# --- Oracle's own summaries -------------------------------------------------------------

_NUMBER = re.compile(r"[$€£]?\s?\d[\d.,:/]*\s?%?|\b(?:percent|per cent)\b", re.I)
_QUOTE = re.compile(r"[\"“”‘’`«»]")
_WORDS = re.compile(r"[a-z0-9']+")
SHINGLE = 3
MAX_SUMMARY = 240


def _shingles(text: str, n: int = SHINGLE) -> set[tuple[str, ...]]:
    words = _WORDS.findall(text.lower())
    return {tuple(words[i : i + n]) for i in range(len(words) - n + 1)}


_TOKEN = re.compile(r"[A-Za-z0-9][\w'-]*")


def _identifying(token: str, first: bool) -> bool:
    """A name, code or figure rather than an ordinary word."""
    if any(c.isdigit() for c in token) or (len(token) > 1 and token.isupper()):
        return True
    if "-" in token and any(c.isupper() for c in token):
        return True
    return token[:1].isupper() and not first


def oracle_summary(text: str, source_texts: list[str], fallback: str, shared: str = "") -> str:
    """A model sentence fit for the ``summary`` level, else ``fallback``.

    Numbers and quotation marks are removed. A sentence that repeats any three
    consecutive words of a source text, or any name, code or figure a source contains
    (and the shared text, ``shared``, does not), is replaced by the fallback (Oracle's
    fixed wording). So a summary never carries a verbatim excerpt, a figure or a name
    from an item, whatever the model was told inside the data."""
    original = text or ""
    words = _TOKEN.findall(original)
    sources_lower = " ".join(source_texts).lower()
    shared_lower = shared.lower()
    for n, token in enumerate(words):
        low = token.lower()
        if _identifying(token, n == 0) and low in sources_lower and low not in shared_lower:
            return fallback
    cleaned = _QUOTE.sub("", _NUMBER.sub(" ", original))
    cleaned = " ".join(cleaned.split()).strip(" .,;:-")
    if len(cleaned.split()) < 3:
        return fallback
    mine = _shingles(cleaned)
    for source in source_texts:
        if mine & _shingles(source):
            return fallback
    if len(cleaned) > MAX_SUMMARY:
        cleaned = cleaned[: MAX_SUMMARY - 1].rstrip() + "…"
    return cleaned + ("" if cleaned.endswith((".", "?", "!", "…")) else ".")


def category_label(category: str | None) -> str:
    if category in cats.BY_KEY:
        return cats.BY_KEY[category].label.lower()
    if category in FIELD_LABELS:
        return FIELD_LABELS[category]
    return category or "source"


def counts_label(kind: str, category: str | None, count: int) -> str:
    what = category_label(category)
    noun = {
        "conflict": ("conflict", "conflicts"),
        "stale": ("stale item", "stale items"),
        "item": ("inferred item", "inferred items"),
        "gap": ("finding", "findings"),
    }[kind]
    name = noun[0] if count == 1 else noun[1]
    if kind == "stale":
        return f"{count} {name} of {what} evidence"
    if kind == "item":
        return f"{count} {name} about {what}"
    return f"{count} {name} in {what} evidence"


def counts(reg: dict[str, dict[str, Any]], v: Viewer) -> list[dict[str, Any]]:
    """Counts and categories of the findings shown to ``v`` at the counts level only."""
    tally: Counter[tuple[str, str | None]] = Counter()
    for entry in reg.values():
        level = entry.get("sharing", DEFAULT)
        if v.is_author or level != "counts" or is_open(entry):
            continue
        tally[(entry["kind"], entry.get("category"))] += 1
    return [
        {"kind": kind, "category": category, "count": n, "label": counts_label(kind, category, n)}
        for (kind, category), n in sorted(tally.items(), key=lambda t: (t[0][0], t[0][1] or ""))
    ]


def shared_item_ids(reg: dict[str, dict[str, Any]], v: Viewer, need: str) -> set[uuid.UUID]:
    """Source items of the findings ``v`` sees at ``need`` or above."""
    out: set[uuid.UUID] = set()
    for entry in reg.values():
        if v.sees(entry.get("sharing", DEFAULT), need):
            out |= {uuid.UUID(i) for i in entry.get("source_item_ids") or []}
    return out


# --- views of rows ----------------------------------------------------------------------


def _copy(row: Any, out: type, **changes: Any) -> SimpleNamespace:
    data = out.model_validate(row).model_dump()
    data.update(changes)
    return SimpleNamespace(**data)


def rule_made(gap: Any) -> bool:
    """A gap the intake engine made by rule: told by its stable category key, never by
    its statement text (which may be reworded in code)."""
    return getattr(gap, "rule_key", None) is not None


def model_written(gap: KnowledgeGap) -> bool:
    """A gap the model wrote: no person created it and the engine did not make it."""
    return gap.created_by is None and gap.intake_id is not None and not rule_made(gap)


def public_importance(gap: KnowledgeGap, reg: dict[str, dict[str, Any]], entry: dict) -> str:
    """A rule-made gap's importance as everyone else sees it (S6, owner 2026-10-19):
    from the brief and public facts only. A person's edit (``public_importance``) is a
    public fact; otherwise the brief decides, so a row written while the author's
    sources still moved importance shows what the brief gives."""
    if entry.get("public_importance"):
        return entry["public_importance"]
    signals = getattr(reg, "signals", None)
    if not rule_made(gap) or signals is None:
        return gap.importance
    speaks = cats.BRIEF_FIELDS.get(gap.category) in getattr(reg, "brief_fields", frozenset())
    return cats.brief_importance(cats.BY_KEY[gap.category], signals, speaks)


def gap_changes(
    gap: KnowledgeGap, reg: dict[str, dict[str, Any]], v: Viewer
) -> dict[str, Any] | None:
    """What ``v`` sees differently of the gap: None when it is hidden from them, ``{}``
    when they see it as it is."""
    entry = reg.get(str(gap.id))
    if v.is_author or is_open(entry):
        return {}
    if (
        getattr(reg, "analysed", False)
        and model_written(gap)
        and (entry is None or entry.get("origin") != "model")
    ):
        # Model text never registered as a model finding (written before S6): private,
        # whatever else the intake registered.
        return None
    if entry is None:
        if not getattr(reg, "unregistered", False):
            return {}
        if gap.created_by is None and gap.knowledge_state == "ai_inference" and gap.evidence_ids:
            # A rule-made gap whose source evidence was never registered.
            entry = {"origin": "rules", "sharing": DEFAULT,
                     "source_item_ids": [str(e) for e in gap.evidence_ids]}  # fmt: skip
        else:
            return {}
    level = entry.get("sharing", DEFAULT)
    if entry.get("origin") == "model":
        if RANK[level] < RANK["summary"]:
            return None
        return {"statement": entry["summary"]} if level == "summary" else {}
    if RANK[level] >= RANK["summary"]:
        return {}
    # A rule-made gap: its statement is a fixed category text; what the author's
    # sources say about it (evidence, confidence, the inferred state, any importance
    # they once gave it) is not shared.
    changes: dict[str, Any] = {}
    importance = public_importance(gap, reg, entry)
    if importance != gap.importance:
        changes["importance"] = importance
    private = set(entry.get("source_item_ids") or [])
    kept = [e for e in gap.evidence_ids if str(e) not in private]
    if len(kept) == len(gap.evidence_ids):
        return changes
    state = gap.knowledge_state
    if state == "ai_inference":
        state = entry.get("public_state", "unknown")
    return {**changes, "evidence_ids": kept, "confidence": None, "knowledge_state": state}


def set_public_importance(intake: ProductIntake, gap: KnowledgeGap) -> None:
    """Record a person's choice of a rule-made gap's importance in its finding, so
    everyone else reads it rather than what the brief alone gives."""
    analysis = intake.analysis or {}
    reg = dict(analysis.get("findings") or {})
    entry = reg.get(str(gap.id))
    if entry is None or entry.get("origin") == "model":
        return
    reg[str(gap.id)] = {**entry, "public_importance": gap.importance}
    intake.analysis = {**analysis, "findings": reg}


def gap_view(gap: KnowledgeGap, reg: dict[str, dict[str, Any]], v: Viewer) -> Any | None:
    """The gap as ``v`` may see it, or None when it is hidden from them."""
    changes = gap_changes(gap, reg, v)
    if changes is None:
        return None
    return _copy(gap, KnowledgeGapOut, **changes) if changes else gap


def statement_restricted(gap: KnowledgeGap, reg: dict[str, dict[str, Any]]) -> bool:
    """Whether the gap's own words are a restricted finding (model text drawn from the
    author's sources, or never registered), whatever its level now: they never travel
    where their output could be shared."""
    entry = reg.get(str(gap.id))
    if entry is not None and entry.get("origin") == "model":
        return not is_open(entry)
    return model_written(gap)


def gap_views(
    gaps: list[KnowledgeGap], reg: dict[str, dict[str, Any]], v: Viewer
) -> dict[uuid.UUID, Any]:
    """Visible gaps by id (hidden ones are left out)."""
    out = {}
    for gap in gaps:
        view = gap_view(gap, reg, v)
        if view is not None:
            out[gap.id] = view
    return out


def question_prompt(gap: Any, rule: bool | None = None) -> str:
    """The question a gap asks: its category's prompt for a rule-made gap, else the
    gap's own words."""
    cat = cats.BY_KEY[gap.category]
    if rule_made(gap) if rule is None else rule:
        return cat.prompt
    return gap.statement if gap.statement.endswith("?") else f"{gap.statement} {cat.prompt}"


def question_view(
    q: StakeholderQuestion,
    raw: dict[uuid.UUID, KnowledgeGap],
    views: dict[uuid.UUID, Any],
    priorities: dict[uuid.UUID, int] | None = None,
) -> Any | None:
    """A question as the reader may see it: hidden with its gap, reworded with it.
    ``priorities``: its place among what everyone may see (anyone but the author), so a
    priority stored while private facts still moved it never shows."""
    if q.gap_id is None or q.gap_id not in raw:
        return q
    view = views.get(q.gap_id)
    if view is None:
        return None
    gap = raw[q.gap_id]
    changes: dict[str, Any] = {}
    if priorities is not None and priorities.get(q.gap_id, q.priority) != q.priority:
        changes["priority"] = priorities[q.gap_id]
    if view is not gap:
        cat = cats.BY_KEY[gap.category]
        changes["rationale"] = cats.rank_reason(
            cat, view.importance, list(view.impact), view.knowledge_state
        )
        if view.statement != gap.statement:
            # Only the summary of a model-written gap is shared: never its own words.
            changes["prompt"] = question_prompt(view, rule=False)
    return _copy(q, StakeholderQuestionOut, **changes) if changes else q


def public_prompt(reg: dict[str, dict[str, Any]], gap: KnowledgeGap, prompt: str) -> str:
    """The question text that may travel into shared places (baseline proposals, PRD
    patches, research proposals): a model-written gap's own words never do."""
    entry = reg.get(str(gap.id))
    if entry is not None and entry.get("origin") == "model":
        return cats.BY_KEY[gap.category].prompt
    return prompt


def public_statement(reg: dict[str, dict[str, Any]], gap: KnowledgeGap) -> str:
    """How a gap is named in stored text others read (coverage reasons)."""
    entry = reg.get(str(gap.id))
    if entry is not None and entry.get("origin") == "model":
        return f"{cats.BY_KEY[gap.category].label} ({gap.status})"
    return gap.statement


def item_view(
    item: dict[str, Any], reg: dict[str, dict[str, Any]], v: Viewer, shared: set[uuid.UUID]
) -> dict | None:
    """An extracted item as ``v`` may see it. ``shared``: the author's items a shared
    finding cites; a brief item's links to the author's sources show only those."""
    if v.is_author:
        return item
    entry = reg.get(str(item.get("finding_id"))) if item.get("finding_id") else None
    if item.get("origin") == "llm" and entry is None:
        return None  # model output never registered: fail closed
    level = None if entry is None or is_open(entry) else entry.get("sharing", DEFAULT)
    if level is not None and RANK[level] < RANK["summary"]:
        return None
    evidence = [e for e in item.get("evidence_ids") or [] if uuid.UUID(e) in shared]
    if level == "summary":
        return {**item, "text": entry["summary"], "evidence_ids": evidence}  # type: ignore[index]
    return {**item, "evidence_ids": evidence}


def conflict_view(c: dict[str, Any], reg: dict[str, dict[str, Any]], v: Viewer) -> dict | None:
    if v.is_author:
        return c
    entry = reg.get(str(c.get("finding_id"))) if c.get("finding_id") else None
    if entry is None:
        return None  # a source conflict never registered: fail closed
    level = entry.get("sharing", DEFAULT)
    if RANK[level] < RANK["summary"]:
        return None
    if level == "summary":
        return {
            "finding_id": c.get("finding_id"),
            "topic": entry["summary"],
            "summary_only": True,
            "claims": [
                {
                    "value": None,
                    "item_id": cl["item_id"],
                    "source_kind": cl.get("source_kind"),
                    "source_class": cl.get("source_class"),
                    "confidence": cl.get("confidence"),
                }
                for cl in c["claims"]
            ],
        }
    return c


def stale_view(s: dict[str, Any], reg: dict[str, dict[str, Any]], v: Viewer) -> dict | None:
    if v.is_author:
        return s
    entry = reg.get(str(s.get("finding_id"))) if s.get("finding_id") else None
    if entry is not None and v.sees(entry.get("sharing", DEFAULT), "summary"):
        return s
    return None


def coverage_view(
    row: dict[str, Any],
    reg: dict[str, dict[str, Any]],
    v: Viewer,
    analysis: dict[str, Any],
) -> dict[str, Any]:
    """A coverage row: what the author's sources say about a category is a finding.

    Anyone who may not see it reads the row the analysis stored for everyone
    (``public_coverage``: the row as the brief and the baseline alone give it), so the
    row reads exactly as a plain intake's with the same brief: same state, same words.
    An intake analysed before those rows were stored gets one from its brief."""
    entry = reg.get(str(row.get("gap_id"))) if row.get("gap_id") else None
    if v.is_author or (entry is not None and v.sees(entry.get("sharing", DEFAULT), "summary")):
        return row
    if "public_coverage" in analysis:
        return {**row, **(analysis["public_coverage"].get(row["category"]) or {})}
    if row.get("state") != "partial" or row.get("knowledge_state") != "ai_inference":
        return row
    # What the author's sources say about the category (registered or not: fail closed).
    field = cats.BRIEF_FIELDS.get(row["category"])
    texts = [i["text"] for i in brief_items(analysis) if field and i["field"] == field]
    if texts:
        return {**row, "knowledge_state": "hypothesis", "reason": cats.brief_reason(texts)}
    return {**row, "state": "missing", "knowledge_state": "unknown", "reason": cats.UNKNOWN_REASON}


def analysis_view(intake: ProductIntake, v: Viewer) -> dict[str, Any]:
    """The intake's stored analysis as ``v`` may see it (GET /v1/intakes and friends)."""
    analysis = dict(intake.analysis or {})
    if v.is_author:
        return analysis
    reg = registry(intake)
    shared = shared_item_ids(reg, v, "summary")
    analysis.pop("findings", None)
    analysis.pop("public_coverage", None)
    analysis["items"] = [
        x
        for x in (item_view(i, reg, v, shared) for i in analysis.get("items") or [])
        if x is not None
    ]
    analysis["conflicts"] = [
        x
        for x in (conflict_view(c, reg, v) for c in analysis.get("conflicts") or [])
        if x is not None
    ]
    analysis["stale"] = [
        x for x in (stale_view(s, reg, v) for s in analysis.get("stale") or []) if x is not None
    ]
    source = intake.analysis or {}
    analysis["coverage"] = [coverage_view(r, reg, v, source) for r in source.get("coverage") or []]
    # Which of the author's items matter, and what their text signals, is drawn from
    # the author's sources: only what a shared finding cites is listed.
    analysis["relevant_item_ids"] = [
        i for i in analysis.get("relevant_item_ids") or [] if uuid.UUID(i) in shared
    ]
    analysis["source_signals"] = {}
    analysis["shared_counts"] = counts(reg, v)
    return analysis
