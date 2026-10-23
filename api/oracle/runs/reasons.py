"""Why each roadmap item needs a person: the reasons of the Roadmap items checkpoint.

Every item of ``roadmap_items.yaml`` gets zero or more reasons. A reason is **blocking**
(a rule problem :func:`oracle.runs.roadmap.check_items` found on the item) or **to
confirm** (advisory: low confidence, serves no goal, moved, new, dropped, a top rank in
Later, an open blocker, a changed PRD section). Each has a short chip label, one plain
sentence, and the fixes that fit it, as data (``{label, action}``) a person's edits can
apply without a model call. File-level problems (no item) are not reasons: they stay
``problems`` and are counted in ``file_problems``.

:func:`reasons_for` is pure and deterministic (item position, then blocking before to
confirm, then :data:`CATALOGUE` order). :func:`reason_context` loads what it reads from
the database: the company's low confidence threshold, each item's traced feature and
blockers, the comparison base and the PRD's newer section hashes. Moved, new and dropped
come from the one item diff (:func:`oracle.roadmap.diff.diff_items`).
"""

import json
import math
import re
import uuid
from dataclasses import dataclass, field
from datetime import date, datetime
from typing import Any, NamedTuple

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from oracle.baseline import trace as baseline_trace
from oracle.baseline.models import Entity
from oracle.blockers.service import UNRESOLVED
from oracle.docs.models import Document, DocumentVersion, Section
from oracle.roadmap import diff as item_diff
from oracle.roadmap.models import RoadmapItem
from oracle.runs import batch, roadmap
from oracle.runs.models import Run

# A rank this good or better placed in Later is flagged (rank_vs_horizon).
TOP_RANKS = 3

ITEMS_FILE = "roadmap_items.yaml"
BLOCKING = "blocking"
CONFIRM = "confirm"

# The field a malformed-field problem names.
MALFORMED = {
    "invalid_milestone": "milestone",
    "invalid_depends_on": "depends_on",
    "invalid_confidence": "confidence",
    "invalid_priority": "priority",
    "unexplained_priority": "priority",
    "invalid_feature": "feature",
    "invalid_requirements": "requirements",
    "invalid_blockers": "blockers",
    "invalid_validation_gates": "validation_gates",
    "invalid_economics": "economics",
}
FIELD_WORDS = {
    "prd_section": "PRD section",
    "depends_on": "dependencies",
    "validation_gates": "validation gates",
}
# The fix for a missing field: its label and the field it edits. A missing id has none.
MISSING_FIX = {
    "title": ("Edit title", "title"),
    "outcome": ("Edit outcome", "outcome"),
    "horizon": ("Set horizon", "horizon"),
    "prd_section": ("Link section", "prd_section"),
}
DEPENDENCY_CODES = ("unknown_dependency", "order_breaks_dependency", "horizon_breaks_dependency")


class LinkedBlocker(NamedTuple):
    key: str
    title: str
    status: str
    id: str | None = None


@dataclass(frozen=True)
class TracedFeature:
    key: str
    title: str
    flags: tuple[str, ...] = ()


@dataclass(frozen=True)
class ReasonContext:
    """What the advisory reasons read; built by :func:`reason_context`, or by hand."""

    low: float = 0.4
    # item id -> its traced feature, or None when no feature resolved (absent: unknown).
    features: dict[str, TracedFeature | None] = field(default_factory=dict)
    blockers: dict[str, list[LinkedBlocker]] = field(default_factory=dict)
    # ReasonBase as JSON ({kind, label, version, attempt}), or None (no comparison).
    base: dict[str, Any] | None = None
    # item id -> {"horizon", "raw"} of the base, in its order.
    base_items: dict[str, dict[str, Any]] = field(default_factory=dict)
    # section key -> (the newest PRD version where it differs, the section is gone there).
    section_changes: dict[str, tuple[int, bool]] = field(default_factory=dict)
    # item id -> the heading of its PRD section.
    prd_titles: dict[str, str] = field(default_factory=dict)
    prd_title: str | None = None
    prd_version: int | None = None
    # False: only the blocking reasons (the context could not be loaded).
    advisory: bool = True


# --------------------------------------------------------------------------- fixes


def _action(kind: str, item: str, field_: str | None = None, value: Any = None) -> dict:
    return {"kind": kind, "item": item, "field": field_, "value": value}


def _fix(label: str, kind: str, item: str, field_: str | None = None, value: Any = None):
    return {"label": label, "action": _action(kind, item, field_, value)}


def accept(item: str, label: str = "Accept") -> dict:
    return _fix(label, "accept", item)


def drop(item: str, label: str = "Drop") -> dict:
    return _fix(label, "drop", item)


def move(item: str, horizon: str, label: str | None = None) -> dict:
    return _fix(label or f"Move to {_h(horizon)}", "edit", item, "horizon", horizon)


def remove_date(item: str) -> dict:
    return _fix("Remove date", "edit", item, "milestone_date", None)


def remove_dependency(item: str, dep: str) -> dict:
    return _fix("Remove dependency", "edit", item, "depends_on", {"remove": [dep]})


# --------------------------------------------------------------------------- words


def _h(horizon: Any) -> str:
    return str(horizon).capitalize() if horizon in roadmap.HORIZONS else str(horizon)


def _word(name: str) -> str:
    return FIELD_WORDS.get(name, name.replace("_", " "))


def _and(words: list[str], last: str = "and") -> str:
    return words[0] if len(words) == 1 else f"{', '.join(words[:-1])} {last} {words[-1]}"


def _sentence(message: str) -> str:
    text = re.sub(r"^item \S+: ", "", message).strip()
    text = text[:1].upper() + text[1:]
    return text if text.endswith(".") else f"{text}."


def _day(value: Any) -> str:
    if isinstance(value, datetime):
        return value.date().isoformat()
    if isinstance(value, date):
        return value.isoformat()
    return str(value)


def _plain(value: Any) -> Any:
    """``value`` as plain JSON: reasons are stored as JSONB, and an item's raw YAML values
    (a date, a datetime) or a non-finite number would fail the segment's flush."""
    if value is None or isinstance(value, str | bool | int):
        return value
    if isinstance(value, float):
        return value if math.isfinite(value) else str(value)
    if isinstance(value, dict):
        return {str(k): _plain(v) for k, v in value.items()}
    if isinstance(value, list | tuple):
        return [_plain(v) for v in value]
    if isinstance(value, set | frozenset):
        return sorted(str(v) for v in value)
    return str(value)


def _milestone_date(item: dict[str, Any]) -> str:
    milestone = item.get("milestone")
    return _day(milestone.get("date")) if isinstance(milestone, dict) else ""


def _prd(ctx: ReasonContext) -> str:
    if ctx.prd_title and ctx.prd_version:
        return f"{ctx.prd_title} v{ctx.prd_version}"
    return "the PRD version"


def _rank(item: dict[str, Any]) -> int | None:
    return item_diff._rank(item.get("priority"))


def _low(item: dict[str, Any], low: float) -> bool:
    value = item.get("confidence")
    if value == "low":
        return True
    return isinstance(value, int | float) and not isinstance(value, bool) and value < low


# --------------------------------------------------------------------------- catalogue


@dataclass(frozen=True)
class Entry:
    severity: str
    label: str
    sentence: str
    fixes: str


# code -> (severity, label template, sentence template, fixes); the templates' words are
# filled in by the builders below. Order is the order reasons of one item are listed in.
CATALOGUE: dict[str, Entry] = {
    "unverified_date": Entry(
        BLOCKING,
        "Date unverified",
        "No verified estimate, capacity or commitment supports {date}.",
        "Remove date; Record basis (once date bases ship)",
    ),
    "date_outside_now": Entry(
        BLOCKING,
        "Date outside Now",
        "Dated milestones belong only in Now; this item is in {horizon}.",
        "Remove date; Move to Now",
    ),
    "undated_source": Entry(
        BLOCKING,
        "Date has no source",
        "The date names no source.",
        "Remove date; Record basis (once date bases ship)",
    ),
    "invalid_date": Entry(BLOCKING, "Date unreadable", "{value} is not a date.", "Remove date"),
    "horizon_breaks_dependency": Entry(
        BLOCKING,
        "Depends on a later item",
        "Needs {dep_title}, which is in {dep_horizon}. An item cannot ship before what it "
        "depends on.",
        "Move to {dep_horizon}; Pull dependency to {horizon}; Remove dependency",
    ),
    "order_breaks_dependency": Entry(
        BLOCKING, "Listed before what it needs", "It is listed before {dep_title}.", "Fix order"
    ),
    "unknown_dependency": Entry(
        BLOCKING,
        "Depends on an unknown item",
        "{dep} is not an item in this file.",
        "Remove dependency",
    ),
    "unknown_prd_section": Entry(
        BLOCKING, "No PRD section", "Section {key} is not in {prd}.", "Link section"
    ),
    "missing_field": Entry(
        BLOCKING,
        "Missing {fields}",
        "It has no {fields}.",
        "Edit outcome / Edit title / Set horizon / Link section (none for an id)",
    ),
    "duplicate_id": Entry(BLOCKING, "Same id twice", "Two items use {id}.", "Drop this one"),
    "invalid_horizon": Entry(
        BLOCKING, "Unknown horizon", "{value} is not Now, Next or Later.", "Set horizon"
    ),
    **{
        code: Entry(BLOCKING, "Malformed {field}", "{message}", "Clear {field}")
        for code in MALFORMED
    },
    "low_confidence": Entry(
        CONFIRM,
        "Low confidence",
        "Confidence {value}, under the company's low threshold ({low}).",
        "Accept; Move to Later; Drop",
    ),
    "serves_no_goal": Entry(
        CONFIRM,
        "Serves no goal",
        "{feature} supports no confirmed goal. / Oracle could not trace it to a baseline "
        "feature, so no goal is known.",
        "Accept; Drop",
    ),
    "horizon_changed": Entry(
        CONFIRM, "Moved from {old} ({base})", "It was in {old} in {base}.", "Accept; Keep in {old}"
    ),
    "new_item": Entry(CONFIRM, "New since {base}", "Not in {base}.", "Accept; Drop"),
    "dropped_item": Entry(
        CONFIRM,
        "Dropped since {base}",
        "It was in {base} and is not in this file.",
        "Accept drop; Keep",
    ),
    "rank_vs_horizon": Entry(
        CONFIRM,
        "Top priority in Later",
        "Ranked {rank} but placed in Later.",
        "Accept; Move to Next",
    ),
    "linked_blocker": Entry(
        CONFIRM, "Open blocker", "{blocker} is {status}.", "Accept; Move to Later; Open blocker"
    ),
    "stale_section": Entry(
        CONFIRM,
        "PRD section changed",
        "{section} changed in {prd} v{m} after this item was derived from v{n}.",
        "Accept; Send back (re-derive)",
    ),
}
_ORDER = {code: n for n, code in enumerate(CATALOGUE)}
_SEVERITY = {BLOCKING: 0, CONFIRM: 1}


def _reason(
    item: str,
    code: str,
    label: str,
    text: str,
    fixes: list[dict],
    data: dict[str, Any] | None = None,
    title: str | None = None,
) -> dict[str, Any]:
    entry = CATALOGUE.get(code)
    return {
        "item": item,
        "item_title": title,
        "code": code,
        "severity": entry.severity if entry else BLOCKING,
        "label": label,
        "text": text,
        "data": _plain(data or {}),
        "fixes": _plain(fixes),
    }


# --------------------------------------------------------------------------- blocking


def _dependency_events(items: list[dict[str, Any]]) -> list[tuple[str, str, str]]:
    """(item, code, dependency) in the order check_items adds dependency problems."""
    index = {i["id"]: n for n, i in enumerate(items)}
    out: list[tuple[str, str, str]] = []
    for n, item in enumerate(items):
        for dep in item.get("depends_on") or []:
            if dep not in index:
                out.append((item["id"], "unknown_dependency", dep))
                continue
            if index[dep] > n:
                out.append((item["id"], "order_breaks_dependency", dep))
            mine, theirs = item.get("horizon"), items[index[dep]].get("horizon")
            if (
                mine in roadmap.HORIZONS
                and theirs in roadmap.HORIZONS
                and roadmap.HORIZONS.index(theirs) > roadmap.HORIZONS.index(mine)
            ):
                out.append((item["id"], "horizon_breaks_dependency", dep))
    return out


def _blocking(
    problem: dict[str, Any],
    item: dict[str, Any],
    dep: str | None,
    by_id: dict[str, dict[str, Any]],
    ctx: ReasonContext,
) -> dict[str, Any]:
    code, key = problem["code"], problem["item"]
    title = roadmap._text(item.get("title"))
    entry = CATALOGUE.get(code)

    def r(text: str, fixes: list[dict], data: dict | None = None, label: str | None = None):
        return _reason(
            key, code, label or (entry.label if entry else code), text, fixes, data, title
        )

    horizon = item.get("horizon")
    if code == "unverified_date":
        when = _milestone_date(item)
        return r(CATALOGUE[code].sentence.format(date=when), [remove_date(key)], {"date": when})
    if code == "date_outside_now":
        return r(
            CATALOGUE[code].sentence.format(horizon=_h(horizon)),
            [remove_date(key), move(key, "now")],
            {"horizon": roadmap._text(horizon)},
        )
    if code == "undated_source":
        return r(CATALOGUE[code].sentence, [remove_date(key)])
    if code == "invalid_date":
        value = _milestone_date(item)
        return r(CATALOGUE[code].sentence.format(value=value), [remove_date(key)], {"value": value})
    if code in DEPENDENCY_CODES and dep is not None:
        other = by_id.get(dep) or {}
        dep_title = roadmap._text(other.get("title")) or dep
        data = {"dependency": dep}
        if code == "unknown_dependency":
            return r(f"{dep} is not an item in this file.", [remove_dependency(key, dep)], data)
        if code == "order_breaks_dependency":
            fixes = [_fix("Fix order", "edit", key, "order", {"after": dep})]
            return r(f"It is listed before {dep_title}.", fixes, data)
        theirs = other.get("horizon")
        data["dependency_horizon"] = theirs
        return r(
            CATALOGUE[code].sentence.format(dep_title=dep_title, dep_horizon=_h(theirs)),
            [
                move(key, theirs),
                move(dep, horizon, f"Pull dependency to {_h(horizon)}"),
                remove_dependency(key, dep),
            ],
            data,
        )
    if code == "unknown_prd_section":
        section = roadmap._text(item.get("prd_section")) or ""
        return r(
            f"Section {section} is not in {_prd(ctx)}.",
            [_fix("Link section", "edit", key, "prd_section", None)],
            {"section": section},
        )
    if code == "missing_field":
        _, _, tail = problem["message"].partition(" lacks ")
        fields = [f.strip() for f in tail.split(",") if f.strip()]
        words = [_word(f) for f in fields]
        fixes = [
            _fix(MISSING_FIX[f][0], "edit", key, MISSING_FIX[f][1], None)
            for f in fields
            if f in MISSING_FIX
        ]
        return r(
            f"It has no {_and(words, 'or')}.",
            fixes,
            {"fields": fields},
            label=f"Missing {', '.join(words)}",
        )
    if code == "duplicate_id":
        return r(f"Two items use {key}.", [drop(key, "Drop this one")])
    if code == "invalid_horizon":
        value = roadmap._text(item.get("horizon"))
        return r(
            f"{value} is not Now, Next or Later.",
            [_fix("Set horizon", "edit", key, "horizon", None)],
            {"value": value},
        )
    if code in MALFORMED:
        name = MALFORMED[code]
        return r(
            _sentence(problem["message"]),
            [_fix(f"Clear {_word(name)}", "edit", key, f"clear:{name}", None)],
            {"field": name},
            label=f"Malformed {_word(name)}",
        )
    # A rule this catalogue does not know yet: shown as the check words it, no fix.
    return r(_sentence(problem["message"]), [])


# --------------------------------------------------------------------------- to confirm


def _advisory(
    key: str,
    item: dict[str, Any],
    ctx: ReasonContext,
    moved: item_diff.ItemDiff | None,
) -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []
    title = roadmap._text(item.get("title"))
    horizon = item.get("horizon")

    def r(code: str, label: str, text: str, fixes: list[dict], data: dict | None = None):
        out.append(_reason(key, code, label, text, fixes, data, title))

    def later_fixes() -> list[dict]:
        return [move(key, "later")] if horizon != "later" else []

    if _low(item, ctx.low):
        value = item.get("confidence")
        r(
            "low_confidence",
            "Low confidence",
            f"Confidence {value}, under the company's low threshold ({ctx.low:g}).",
            [accept(key), *later_fixes(), drop(key)],
            {"confidence": value, "low": ctx.low},
        )
    if key in ctx.features:
        feature = ctx.features[key]
        if feature is None:
            r(
                "serves_no_goal",
                "Serves no goal",
                "Oracle could not trace it to a baseline feature, so no goal is known.",
                [accept(key), drop(key)],
                {"feature": None},
            )
        elif "serves_no_goal" in feature.flags:
            r(
                "serves_no_goal",
                "Serves no goal",
                f"{feature.title} supports no confirmed goal.",
                [accept(key), drop(key)],
                {"feature": feature.key},
            )
    if ctx.base is not None and moved is not None:
        base = ctx.base["label"]
        if moved.status == "added":
            r("new_item", f"New since {base}", f"Not in {base}.", [accept(key), drop(key)])
        else:
            change = moved.changed("horizon")
            if change is not None and change.before in roadmap.HORIZONS:
                old = change.before
                r(
                    "horizon_changed",
                    f"Moved from {_h(old)} ({base})",
                    f"It was in {_h(old)} in {base}.",
                    [accept(key), move(key, old, f"Keep in {_h(old)}")],
                    {"from": old, "to": change.after},
                )
    rank = _rank(item)
    if rank is not None and rank <= TOP_RANKS and horizon == "later":
        r(
            "rank_vs_horizon",
            "Top priority in Later",
            f"Ranked {rank} but placed in Later.",
            [accept(key), move(key, "next")],
            {"rank": rank},
        )
    for blocker in ctx.blockers.get(key, []):
        if blocker.status in UNRESOLVED:
            r(
                "linked_blocker",
                "Open blocker",
                f"{blocker.title} is {blocker.status}.",
                [accept(key), *later_fixes()],
                {"blocker": blocker.key, "blocker_id": blocker.id, "status": blocker.status},
            )
    section = roadmap._text(item.get("prd_section"))
    if section and section in ctx.section_changes:
        newer, gone = ctx.section_changes[section]
        name = ctx.prd_titles.get(key) or f"Section {section}"
        prd = ctx.prd_title or "the PRD"
        n = ctx.prd_version
        text = (
            f"{name} is gone from {prd} v{newer}; this item was derived from v{n}."
            if gone
            else f"{name} changed in {prd} v{newer} after this item was derived from v{n}."
        )
        # Send back (re-derive) is the checkpoint's own Request changes, not an edit.
        r(
            "stale_section",
            "PRD section changed",
            text,
            [accept(key)],
            {"section": section, "version": newer, "gone": gone, "send_back": True},
        )
    return out


def _dropped(key: str, raw: dict[str, Any], base: str) -> dict[str, Any]:
    return _reason(
        key,
        "dropped_item",
        f"Dropped since {base}",
        f"It was in {base} and is not in this file.",
        [accept(key, "Accept drop"), _fix("Keep", "restore", key)],
        {},
        roadmap._text(raw.get("title")),
    )


# --------------------------------------------------------------------------- reasons_for


def reasons_for(
    items: list[dict[str, Any]],
    problems: list[dict[str, Any]],
    ctx: ReasonContext | None,
) -> list[dict[str, Any]]:
    """Every item's reasons: its rule problems (blocking) and, with a context, the advisory
    ones (to confirm). ``items`` and ``problems`` are :func:`check_items`' (ids filled in,
    ``depends_on`` lists of strings). Pure: the same input gives the same list."""
    ctx = ctx or ReasonContext(advisory=False)
    by_id: dict[str, dict[str, Any]] = {}
    for item in items:
        by_id.setdefault(item["id"], item)
    # Where each reason is listed: the head's order, dropped items in their base place.
    slots: dict[tuple[str, int], int] = {}
    diffs: dict[int, item_diff.ItemDiff] = {}
    dropped: list[tuple[int, str, dict[str, Any]]] = []
    if ctx.advisory and ctx.base is not None:
        base = [
            item_diff.snapshot_from_raw(
                {**(v.get("raw") or {}), "id": k, "horizon": v.get("horizon")}, n
            )
            for n, (k, v) in enumerate(ctx.base_items.items())
        ]
        head = [item_diff.snapshot_from_raw(i, n) for n, i in enumerate(items)]
        result = item_diff.diff_items(base, head)
        slot = 0
        for d in result.items:
            if d.head is not None:
                diffs[d.head.position] = d
                slots[("head", d.head.position)] = slot
            else:
                dropped.append((slot, d.key, (ctx.base_items.get(d.key) or {}).get("raw") or {}))
            slot += 1
    for n in range(len(items)):
        slots.setdefault(("head", n), n)

    out: list[tuple[tuple[int, int, int, int], dict[str, Any]]] = []
    seq = 0

    def add(slot: int, reason: dict[str, Any]) -> None:
        nonlocal seq
        order = (slot, _SEVERITY[reason["severity"]], _ORDER.get(reason["code"], len(_ORDER)), seq)
        out.append((order, reason))
        seq += 1

    # Blocking: each problem on an item, placed on that item (the first with its id; a
    # duplicate's problems on the later one).
    events = _dependency_events(items)
    dep_problems = [p for p in problems if p.get("item") and p["code"] in DEPENDENCY_CODES]
    deps = (
        [e[2] for e in events]
        if [(e[0], e[1]) for e in events] == [(p["item"], p["code"]) for p in dep_problems]
        else [None] * len(dep_problems)
    )
    dep_of = {id(p): d for p, d in zip(dep_problems, deps, strict=True)}
    # Where each id first appears, so a problem's item is found without a scan per problem.
    first_index: dict[str, int] = {}
    for n, i in enumerate(items):
        first_index.setdefault(i["id"], n)
    pointer = 0
    for p in problems:
        key = p.get("item")
        if not key:
            continue
        if p["code"] not in DEPENDENCY_CODES:
            if p["code"] == "duplicate_id":
                # The check's problems of a duplicate start here: they are the later item's.
                pointer += 1
            while pointer < len(items) and items[pointer]["id"] != key:
                pointer += 1
        index = (
            pointer
            if pointer < len(items) and items[pointer]["id"] == key
            else first_index.get(key, len(items))
        )
        item = items[index] if index < len(items) else {"id": key}
        add(
            slots.get(("head", index), index),
            _blocking(p, item, dep_of.get(id(p)), by_id, ctx),
        )

    if ctx.advisory:
        for n, item in enumerate(items):
            for reason in _advisory(item["id"], item, ctx, diffs.get(n)):
                add(slots[("head", n)], reason)
        if ctx.base is not None:
            for slot, key, raw in dropped:
                add(slot, _dropped(key, raw, ctx.base["label"]))
    return [r for _, r in sorted(out, key=lambda x: x[0])]


def summarize(
    check: dict[str, Any],
    reasons: list[dict[str, Any]],
    base: dict[str, Any] | None,
    partial: bool = False,
) -> dict[str, Any]:
    """The check's JSON with its reasons and their counts."""
    return {
        **check,
        "reasons": reasons,
        "blocking": sum(1 for r in reasons if r["severity"] == BLOCKING),
        "to_confirm": sum(1 for r in reasons if r["severity"] == CONFIRM),
        "file_problems": sum(1 for p in check.get("problems") or [] if not p.get("item")),
        "base": base,
        "reasons_partial": partial,
    }


# --------------------------------------------------------------------------- context


def _raw_of(row: RoadmapItem) -> dict[str, Any]:
    return {
        "id": row.item_key,
        "title": row.title,
        "outcome": row.outcome,
        "horizon": row.horizon,
        "milestone": row.milestone,
        "depends_on": list(row.depends_on or []),
        "priority": row.priority,
        "confidence": row.confidence,
        "prd_section": row.prd_section_key,
    }


async def _target_document(db: AsyncSession, run: Run) -> uuid.UUID | None:
    if run.document_id is not None:
        return run.document_id
    slug = (run.knobs or {}).get("document_slug")
    if not slug:
        return None
    return await db.scalar(
        select(Document.id).where(Document.slug == slug, Document.kind == "roadmap")
    )


async def _base(
    db: AsyncSession, run: Run
) -> tuple[dict[str, Any] | None, dict[str, dict[str, Any]]]:
    """The comparison base: the latest version of the target roadmap with items, else none
    (a first roadmap). D5 Re-run keeps its output (#163) will feed the previous attempt's
    file as a base ahead of it."""
    document_id = await _target_document(db, run)
    if document_id is None:
        return None, {}
    latest = (
        await db.execute(
            select(DocumentVersion.id, DocumentVersion.number)
            .join(RoadmapItem, RoadmapItem.roadmap_version_id == DocumentVersion.id)
            .where(DocumentVersion.document_id == document_id)
            .order_by(DocumentVersion.number.desc())
            .limit(1)
        )
    ).first()
    if latest is None:
        return None, {}
    rows = (
        await db.scalars(
            select(RoadmapItem)
            .where(RoadmapItem.roadmap_version_id == latest.id)
            .order_by(RoadmapItem.position)
        )
    ).all()
    base = {"kind": "roadmap_version", "label": f"roadmap v{latest.number}",
            "version": latest.number, "attempt": None}  # fmt: skip
    return base, {r.item_key: {"horizon": r.horizon, "raw": _raw_of(r)} for r in rows}


async def _sections(db: AsyncSession, version_id: uuid.UUID) -> dict[str, Section]:
    rows = await db.scalars(select(Section).where(Section.version_id == version_id))
    return {s.section_key: s for s in rows}


async def _prd_version(
    db: AsyncSession, source_id: uuid.UUID | None
) -> tuple[
    DocumentVersion | None, str | None, int | None, dict[str, tuple[int, bool]], dict[str, str]
]:
    """The run's PRD version, its title and number, its sections changed in a newer version
    and their headings."""
    version = await db.get(DocumentVersion, source_id) if source_id is not None else None
    prd_title = prd_version = None
    section_changes: dict[str, tuple[int, bool]] = {}
    headings: dict[str, str] = {}
    if version is not None:
        document = await db.get(Document, version.document_id)
        prd_title = document.title if document is not None else None
        prd_version = version.number
        mine = await _sections(db, version.id)
        headings = {k: s.heading for k, s in mine.items()}
        # Every newer version, not only the newest: a section changed in v3 and put back
        # in v4 still changed after this item was derived. The newest that differs is named.
        newer = (
            await db.execute(
                select(DocumentVersion.id, DocumentVersion.number).where(
                    DocumentVersion.document_id == version.document_id,
                    DocumentVersion.number > version.number,
                )
            )
        ).all()
        hashes: dict[uuid.UUID, dict[str, str | None]] = {v.id: {} for v in newer}
        if newer:
            rows = await db.execute(
                select(Section.version_id, Section.section_key, Section.content_hash).where(
                    Section.version_id.in_([v.id for v in newer])
                )
            )
            for version_id, key, content_hash in rows:
                hashes[version_id][key] = content_hash
        for v in sorted(newer, key=lambda v: v.number):
            theirs = hashes[v.id]
            for key, section in mine.items():
                if key not in theirs:
                    section_changes[key] = (v.number, True)
                elif theirs[key] != section.content_hash:
                    section_changes[key] = (v.number, False)
    return version, prd_title, prd_version, section_changes, headings


async def _entities(db: AsyncSession, ids: list[uuid.UUID]) -> dict[uuid.UUID, Entity]:
    """The entities, each read once per Inbox call (:mod:`oracle.runs.batch`)."""

    async def load(missing: list[uuid.UUID]) -> dict[uuid.UUID, Entity]:
        if not missing:
            return {}
        return {e.id: e for e in await db.scalars(select(Entity).where(Entity.id.in_(missing)))}

    return await batch.many("entity", ids, load)


def _canonical(item: dict[str, Any]) -> str:
    return json.dumps(item, sort_keys=True, default=str)


async def _traces(
    db: AsyncSession, version: DocumentVersion | None, items: list[dict[str, Any]]
) -> dict[str, dict[str, Any]]:
    """Each item's trace by its id (the first item of an id), the traces not yet read in
    this Inbox call (:mod:`oracle.runs.batch`) derived together, in a few queries."""
    from oracle.roadmap.items import derive_traces

    firsts: dict[str, dict[str, Any]] = {}
    for item in items:
        firsts.setdefault(item["id"], item)
    by_text = {_canonical(item): item for item in firsts.values()}

    async def load(missing: list[str]) -> dict[str, dict[str, Any]]:
        found = await derive_traces(db, version, [by_text[t] for t in missing])
        return dict(zip(missing, found, strict=True))

    traced = await batch.many(
        ("trace", version.id if version is not None else None), list(by_text), load
    )
    return {key: traced[_canonical(item)] for key, item in firsts.items()}


async def read_ahead(db: AsyncSession, runs_items: list[tuple[Run, list[dict[str, Any]]]]) -> None:
    """In one Inbox call (:mod:`oracle.runs.batch`): the traces of every checkpoint's items
    and their features and blockers, read together for :func:`reason_context` to share."""
    from oracle.runs.service import _source_id

    by_source: dict[uuid.UUID | None, list[dict[str, Any]]] = {}
    for run, items in runs_items:
        by_source.setdefault(_source_id(run), []).extend(items)
    ids: list[uuid.UUID] = []
    for source_id, items in by_source.items():
        version = (await batch.once(("prd", source_id), lambda s=source_id: _prd_version(db, s)))[0]
        for t in (await _traces(db, version, items)).values():
            ids += [f for f in [t["feature_id"]] if f is not None] + t["blocker_ids"]
    await _entities(db, ids)


async def reason_context(
    db: AsyncSession,
    run: Run,
    items: list[dict[str, Any]],
) -> ReasonContext:
    """Everything the advisory reasons read, for the run's items, as of now. In one Inbox
    call (:func:`oracle.runs.batch.batched`) the company-wide reads, the items' traces and
    their entities are read once, for all its checkpoints together (:func:`read_ahead`)."""
    from oracle.runs.service import _low_threshold, _source_id

    low = await batch.once(("low_threshold",), lambda: _low_threshold(db))
    source_id = _source_id(run)
    version, prd_title, prd_version, section_changes, headings = await batch.once(
        ("prd", source_id), lambda: _prd_version(db, source_id)
    )

    # Without a user on purpose: only the features' flags are read, for "serves no goal".
    report = await batch.once(("trace_report",), lambda: baseline_trace.report(db))
    flags = {f.id: f for f in report.features}
    traced = await _traces(db, version, items)
    feature_ids = {t["feature_id"] for t in traced.values() if t["feature_id"] is not None}
    blocker_ids = {b for t in traced.values() for b in t["blocker_ids"]}
    entities = await _entities(db, list(feature_ids | blocker_ids))
    features: dict[str, TracedFeature | None] = {}
    blockers: dict[str, list[LinkedBlocker]] = {}
    for key, t in traced.items():
        fid = t["feature_id"]
        if fid is None:
            features[key] = None
        else:
            entity = entities.get(fid)
            found = flags.get(fid)
            features[key] = TracedFeature(
                entity.key if entity else str(fid),
                entity.title if entity else str(fid),
                tuple(found.flags) if found is not None else (),
            )
        linked = []
        for bid in t["blocker_ids"]:
            entity = entities.get(bid)
            spec = (entity.attrs or {}).get("blocker") if entity is not None else None
            if isinstance(spec, dict) and spec.get("status"):
                linked.append(LinkedBlocker(entity.key, entity.title, spec["status"], str(bid)))
        blockers[key] = linked

    base, base_items = await batch.once(
        ("roadmap_base", run.document_id, (run.knobs or {}).get("document_slug")),
        lambda: _base(db, run),
    )
    prd_titles = {
        item["id"]: headings[s]
        for item in items
        if (s := roadmap._text(item.get("prd_section"))) and s in headings
    }
    return ReasonContext(
        low=low,
        features=features,
        blockers=blockers,
        base=base,
        base_items=base_items,
        section_changes=section_changes,
        prd_titles=prd_titles,
        prd_title=prd_title,
        prd_version=prd_version,
    )
