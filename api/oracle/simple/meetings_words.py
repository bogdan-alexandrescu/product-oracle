"""Simple meetings: the words of proposals, approvals, minutes' actions and posts."""

import re
import uuid
from datetime import date
from typing import Any

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from oracle import company_time, wording
from oracle.docs.models import Document, DocumentVersion, Section
from oracle.roadmap.models import RoadmapItem
from oracle.simple import change_words, drafts
from oracle.simple.meetings_common import (
    MAX_ACTIONS,
)
from oracle.simple.models import SimpleChange, SimpleMeeting

# walkc-meeting r2: what a proposal asked for, for one that did not happen ("Declined
# Ada's proposal: move Sample to Later"), never in the past tense of a change made.
PROPOSAL_WORDS = {
    "move_dates": "new dates for",
    "accept_date_suggestion": "accept Oracle's dates for",
    "change_horizon": "move",
    "reorder": "reorder",
    "cut": "cut",
    "restore": "restore",
    "edit_title": "rename",
    "edit_outcome": "new outcome for",
    "edit_note": "new notes for",
    "accept_risk": "accept a risk on",
    "shift_dependents": "move the dependents of",
    "move_dependency": "move the dependency of",
    "confirm_item": "confirm",
    "edit_line": "new wording for",
    "set_section_number": "new number in",
    "add_key_date": "add the key date",
    "edit_key_date": "change the key date",
    "remove_key_date": "remove the key date",
    "add_item": "add",
    "merge_item": "merge",
    "keep_both": "keep beside its look-alikes:",
    "cut_with_dependents": "cut with its dependents:",
    "set_confidence": "new confidence for",
    "set_track": "new track for",
    "set_prd": "new PRD for",
    "set_goal": "new goal for",
    "set_depends": "new dependencies for",
    "set_status": "new status for",
    "set_feature": "new feature for",
    "set_goals": "move to another goal:",
    "set_parent": "change what it is part of:",
    "set_code": "new code for",
}


async def describe(
    db: AsyncSession, c: SimpleChange, proposal: bool = False
) -> tuple[str, list[dict]]:
    """A change in words, and the subjects it names (its item, its PRD's line). With
    ``proposal``, what it asked for ("move Sample to Later"), for one not made."""
    t = c.target or {}
    subjects: list[dict] = []
    name = ""
    item_id = t.get("item_id")
    if item_id:
        try:
            row = await db.get(RoadmapItem, uuid.UUID(str(item_id)))
        except ValueError:
            row = None
        if row is not None:
            name = row.title
            subjects.append({"kind": "roadmap_item", "id": str(row.id), "ref": row.item_key})
    if c.op == "edit_line":
        doc = await db.get(Document, uuid.UUID(str(t.get("document_id")))) if t.get(
            "document_id") else None  # fmt: skip
        after = str((c.after or {}).get("line") or "")
        name = f"a line of {doc.title}: “{after[:120]}”" if doc else "a one-pager line"
        if doc is not None:
            subjects.append(
                {"kind": "section", "id": str(doc.id), "ref": f"line:{t.get('line_id')}"}
            )
    elif c.op == "set_section_number":
        doc = await db.get(Document, uuid.UUID(str(t.get("document_id")))) if t.get(
            "document_id") else None  # fmt: skip
        number = str((c.after or {}).get("number") or "")
        name = f"a section of {doc.title}: {number}" if doc else "a PRD section"
        if doc is not None:
            subjects.append({"kind": "section", "id": str(doc.id), "ref": str(t.get("section"))})
    elif c.op == "cut_with_dependents":
        # Review minor: every item the one change cut, the item first, each a subject.
        titles = [str(x) for x in t.get("titles") or []] or ([name] if name else [])
        name = titles[0] if len(titles) == 1 else f"{', '.join(titles[:-1])} and {titles[-1]}"
        for key in list(c.after or {}):
            if key == str(item_id):
                continue
            try:
                row = await db.get(RoadmapItem, uuid.UUID(str(key)))
            except ValueError:
                row = None
            if row is not None:
                subjects.append({"kind": "roadmap_item", "id": str(row.id), "ref": row.item_key})
    elif not name:
        name = str((c.after or {}).get("title") or t.get("title") or "")
    if proposal:
        words = PROPOSAL_WORDS.get(c.op) or c.op.replace("_", " ")
        h = change_words.HORIZON_WORDS.get(str((c.after or {}).get("horizon")))
        if c.op == "change_horizon" and name and h:
            return f"move {name} to {h}", subjects
        return f"{words} {name}".strip(), subjects
    words = drafts.OP_WORDS.get(c.op) or c.op.replace("_", " ").capitalize()
    if c.op == "change_horizon" and name:
        # qa4-simple-decide-12: a move says where to ("Moved Sample data import to Later").
        said = change_words.phrase(c.op, t, c.before or {}, c.after or {}, name)
        return said[:1].upper() + said[1:], subjects
    return f"{words} {name}".strip(), subjects


def published_words(d: Any, names: dict[uuid.UUID, str]) -> str:
    """ "published" only when the draft's version really is (#723, production); else what
    still holds it, in the meeting banner's words: "not yet published: Waiting on Rae's
    approval · Sections Scope need a reviewer"."""
    if d.status == "approved":
        return "published"
    why = []
    if d.waiting_on:
        who = drafts._people([names.get(i, "someone") for i in d.waiting_on])
        why.append(f"Waiting on {who}'s approval")
    why += list(d.blocked_by or [])
    return "not yet published: " + (" · ".join(why) or "its review is not complete")


def _sentence(text: str) -> str:
    text = text.strip()
    if not text:
        return text
    text = text[0].upper() + text[1:]
    return text if text.endswith((".", "?", "!")) else text + "."


def _section(key: str | None, headings: dict[str, str] | None = None) -> str | None:
    """A section's name: its own heading (walkc-meeting-r2: "Sources and data points" for
    "sources"), else made from its id ("what-we-build" -> "What we build")."""
    if not key:
        return None
    if headings and headings.get(key):
        return headings[key]
    return key.replace("-", " ").replace("_", " ").strip().capitalize() or None


_RAW = [
    (re.compile(r"\[c:[^\]]*\]"), lambda m, h: "a citation"),
    (re.compile(r"\s*\(\{#[^}]*\}\)"), lambda m, h: ""),
    (re.compile(r"\{#[^}]*\}"), lambda m, h: "a section label"),
    (re.compile(r"section id '([^']*)'"), lambda m, h: f"the section name “{_section(m[1], h)}”"),
    (re.compile(r"section '([^']*)'"), lambda m, h: f"the section “{_section(m[1], h)}”"),
]


def _plain_words(message: str, headings: dict[str, str] | None = None) -> str:
    """An importer message without its raw tokens ([c:key], {#sources}, section ids)."""
    for pattern, put in _RAW:
        message = pattern.sub(lambda m, put=put: put(m, headings), message)
    return _sentence(wording.date_words(message))


def _days(days: list[str]) -> str:
    return days[0] if len(days) == 1 else ", ".join(days[:-1]) + " and " + days[-1]


def _shown_date(p: Any) -> str:
    """walkc-meeting-r2: a date problem's date as people read it (doc_dates.problem_refs'
    ``shown``), never as the document wrote it ("2026-11-30")."""
    return p.refs.get("shown") or p.refs["date"]


def approve_problems(problems: list[Any], headings: dict[str, str] | None = None) -> dict[str, Any]:
    """walkc-meeting: why the meeting's Approve could not publish, as a short list a person
    reads: each problem said once, in plain words (what to do is in its message), where it
    is (the section's name), and how many times it came up; a section's dates without a
    confirmed schedule in one line that lists them. No codes, ids or raw lines."""
    seen: dict[tuple[str, str | None], dict[str, Any]] = {}
    dates: dict[str | None, list[Any]] = {}
    for p in problems:
        where = _section(getattr(p, "section_key", None), headings)
        refs = getattr(p, "refs", None) or {}
        if getattr(p, "code", None) == "unverified_date" and isinstance(refs.get("date"), str):
            dates.setdefault(where, []).append(p)
            continue
        what = _plain_words(str(getattr(p, "message", "") or ""), headings)
        key = (what, where)
        if key in seen:
            seen[key]["times"] += 1
        else:
            seen[key] = {"what": what, "where": where, "times": 1}
    out = list(seen.values())
    for where, group in dates.items():
        days = list(dict.fromkeys(_shown_date(p) for p in group))
        if len(days) == 1:
            what = _plain_words(str(group[0].message), headings)
        else:
            what = (
                f"{len(days)} dates are not backed by a confirmed schedule: {_days(days)}; "
                f"{wording.RECORD_DATE_BASIS} or drop them."
            )
        out.insert(0, {"what": what, "where": where, "times": len(group)})
    n = len(problems)
    message = (
        "Not approved: the draft has 1 problem to fix first."
        if n == 1
        else f"Not approved: the draft has {n} problems to fix first."
    )
    return {"code": "draft_problems", "message": message, "problems": out}


async def _headings(db: AsyncSession, document_ids: set[uuid.UUID]) -> dict[str, str]:
    """Each section's heading by its key, in the documents' latest versions."""
    if not document_ids:
        return {}
    await db.rollback()
    rows = await db.execute(
        select(Section.section_key, Section.heading)
        .join(DocumentVersion, DocumentVersion.id == Section.version_id)
        .where(DocumentVersion.document_id.in_(document_ids))
        .order_by(DocumentVersion.number)
    )
    return {key: heading for key, heading in rows.tuples() if heading}


def _clean_actions(raw: Any, members: set[uuid.UUID], default: uuid.UUID | None) -> list[dict]:
    out = []
    for a in raw if isinstance(raw, list) else []:
        if not isinstance(a, dict) or not str(a.get("title") or "").strip():
            continue
        owner = None
        try:
            owner = uuid.UUID(str(a.get("owner_id"))) if a.get("owner_id") else None
        except ValueError:
            owner = None
        if owner not in members:
            owner = default
        due = None
        try:
            due = date.fromisoformat(str(a["due_date"])).isoformat() if a.get("due_date") else None
        except ValueError:
            due = None
        row = {"title": " ".join(str(a["title"]).split())[:200],
               "owner_id": str(owner) if owner else None, "due_date": due}  # fmt: skip
        try:  # #1817: the item it is about
            if a.get("item_id"):
                row["item_id"] = str(uuid.UUID(str(a["item_id"])))
        except ValueError:
            pass
        if a.get("action_item_id"):  # one recorded in the meeting (Send skips it)
            row["action_item_id"] = str(a["action_item_id"])
        out.append(row)
    return out[:MAX_ACTIONS]


def _answer_actions(raw: Any) -> list[dict]:
    """The answer's action items, tidied; owners and dates checked against the record."""
    out = []
    for a in raw if isinstance(raw, list) else []:
        if not isinstance(a, dict) or not str(a.get("title") or "").strip():
            continue
        due = None
        try:
            due = date.fromisoformat(str(a["due_date"])).isoformat() if a.get("due_date") else None
        except ValueError:
            due = None
        out.append({"title": " ".join(str(a["title"]).split())[:200],
                    "owner_id": a.get("owner_id"), "due_date": due})  # fmt: skip
    return out


def _plain(m: SimpleMeeting, minutes: dict, names: dict, zone: str) -> str:
    # walkc-meeting r2 (5j): when the meeting was, month first with its time and zone.
    lines = [f"Minutes: {m.title}", f"Held {company_time.stamp(m.started_at, zone)}", "",
             minutes.get("summary") or ""]  # fmt: skip
    if minutes.get("open_questions"):
        lines += ["", "Open questions:", *[f"- {q}" for q in minutes["open_questions"]]]
    if minutes.get("action_items"):
        lines += ["", "Action items:"]
        for a in minutes["action_items"]:
            who = names.get(uuid.UUID(a["owner_id"]), "someone") if a.get("owner_id") else "someone"
            due = f" by {company_time.calendar_day(a['due_date'])}" if a.get("due_date") else ""
            lines.append(f"- {a['title']} ({who}{due})")
    if minutes.get("waits"):
        lines += ["", "Waiting:"]
        for x in minutes["waits"]:
            on = ", ".join(p.get("name", "someone") for p in x.get("on") or [])
            lines.append(f"- {x['what']}" + (f" (on {on})" if on else ""))
    return "\n".join(lines)
