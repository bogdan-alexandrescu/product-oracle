"""The structured review a send-back delivers to the agents (D4): ``review.yaml``.

Request changes builds one file from the checkpoint's shared draft (D8, the staged actions
only: a suggestion nobody staged is not sent), stores it on the checkpoint
(``Checkpoint.review``) and delivers it to the agents of the revise round: the rendered
YAML as the change request (segment mode, :func:`change_request`), or one line per entry
as the findings of the workflow's revise step (:func:`findings`). Agents with MCP read the
stored structure with ``get_checkpoint_review``.

The file's keys are fixed (:data:`KEYS`) and the same for every checkpoint kind. The
entries and their ``action`` words are per kind, built by :data:`ENTRY_BUILDERS`; a kind
with none sends ``items: []`` and the note as ``general_note``.
"""

import json
from collections.abc import Callable
from datetime import datetime
from typing import Any, Protocol

from oracle import safe_yaml
from oracle.runs.schemas import ReviewAction

VERSION = 1
KEYS = (
    "version", "checkpoint", "run", "segment", "attempt", "file", "items", "unchanged",
    "problems_open", "waived", "general_note",
)  # fmt: skip
# The posted findings, the lead line included (SwarmCloud's verdict form: a list of strings).
MAX_FINDINGS = 200
MORE = "(… more in get_checkpoint_review)"
BLOCKING = "blocking"
# The checkpoint kinds whose segment leaves an item file the draft reviews (D8).
ITEM_FILES = {"roadmap_items": "roadmap_items.yaml"}


# The order an entry's keys are written in (JSONB keeps no order: the stored review is put
# back in this one, so the file reads the same however it was read).
ENTRY_KEYS = (
    "id", "title", "action", "changes", "reorder", "after", "into", "with", "question", "asked_to",
    "answer", "answers", "note",
)  # fmt: skip
ROW_KEYS = ("id", "code", "reason", "text")


class _Checkpoint(Protocol):
    kind: str
    run_id: Any
    payload: dict[str, Any]


# (staged actions, the file's item ids in order, the reasons) -> (entries, waived)
EntryBuilder = Callable[
    [list[ReviewAction], list[str], list[dict[str, Any]]],
    tuple[list[dict[str, Any]], list[dict[str, Any]]],
]


def _answers(action: ReviewAction, reason: dict[str, Any]) -> bool:
    """As the D8 read counts them: a staged action answers a reason it names, every reason
    of its item when it names none, and a waiver answers them all. Questions answer
    nothing."""
    if action.kind == "question":
        return False
    return action.kind == "waive" or not action.answers or reason["code"] in action.answers


# --------------------------------------------------------------------------- roadmap_items

# D8 edit fields -> the item file's own field names.
_RENAMED = {"milestone_date": ("milestone", "date"), "milestone_name": ("milestone", "name")}


def _change(edits: list[ReviewAction]) -> dict[str, Any]:
    """The ``edit`` rows of one item, merged into one ``change`` entry."""
    changes: dict[str, Any] = {}
    entry: dict[str, Any] = {"id": edits[0].item_key, "action": "change"}
    for a in edits:
        f = a.field or ""
        if f == "order":
            entry["reorder"] = True
            after = a.value.get("after") if isinstance(a.value, dict) else None
            if after:
                entry["after"] = after
        elif f.startswith("clear:"):
            changes[f.removeprefix("clear:")] = None
        elif f in _RENAMED:
            parent, key = _RENAMED[f]
            changes.setdefault(parent, {})[key] = a.value
        else:
            changes[f] = a.value
    if changes:
        entry = {"id": entry["id"], "action": "change", "changes": changes, **entry}
    return entry


def _roadmap_items(
    staged: list[ReviewAction], items: list[str], reasons: list[dict[str, Any]]
) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    order = {key: n for n, key in enumerate(items)}
    by_item: dict[str, list[ReviewAction]] = {}
    for a in staged:
        by_item.setdefault(a.item_key, []).append(a)
    keys = sorted(by_item, key=lambda k: order.get(k, len(order)))
    entries: list[dict[str, Any]] = []
    waived: list[dict[str, Any]] = []
    for key in keys:
        mine = by_item[key]
        edits = [a for a in mine if a.kind == "edit"]
        for a in mine:
            if a.kind == "waive":
                why = a.value.get("reason") if isinstance(a.value, dict) else None
                codes = list(a.answers) or [r["code"] for r in reasons if r["item"] == key]
                waived += [{"id": key, "code": c, "reason": why} for c in codes or [None]]
                continue
            if a.kind == "edit":
                if a is not edits[0]:
                    continue
                entry = _change(edits)
                group = edits
            else:
                entry = {"id": key, "action": a.kind}
                group = [a]
                if a.kind == "split" and isinstance(a.value, dict):
                    entry["into"] = a.value.get("into")
                elif a.kind == "merge" and isinstance(a.value, dict):
                    entry["with"] = a.value.get("with")
                elif a.kind == "question":
                    q = a.question
                    text = a.value.get("text") if isinstance(a.value, dict) else None
                    entry["question"] = q.text if q else text
                    entry["asked_to"] = q.asked_to.name if q and q.asked_to else None
                    entry["answer"] = q.answer.body if q and q.answer else None
            answers = [c for g in group for c in g.answers]
            if answers:
                entry["answers"] = list(dict.fromkeys(answers))
            notes = [g.note for g in group if g.note]
            if notes:
                entry["note"] = " ".join(notes)
            entries.append(entry)
    return entries, waived


# --------------------------------------------------------------------------- baseline_confirm


def _baseline_confirm(
    staged: list[ReviewAction], items: list[str], reasons: list[dict[str, Any]]
) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    """B2: each staged Look again is an entry ``action: question`` with its note; each
    Leave proposed a waived goal. The baseline writes themselves already applied."""
    entries: list[dict[str, Any]] = []
    waived: list[dict[str, Any]] = []
    for a in staged:
        value = a.value if isinstance(a.value, dict) else {}
        if a.kind == "look_again":
            entries.append({"id": a.item_key, "action": "question", "note": value.get("note")})
        elif a.kind == "waive":
            codes = list(a.answers) or [r["code"] for r in reasons if r["item"] == a.item_key]
            waived += [{"id": a.item_key, "code": c, "reason": value.get("reason")} for c in codes]
    return entries, waived


def look_again_note(review: dict[str, Any]) -> str | None:
    """The Send back note of a Confirm the baseline stop (B2): the look-again items, then
    the note to the agents."""
    if review.get("checkpoint") != "baseline_confirm":
        return None
    lines: list[str] = []
    looks = [e for e in review.get("items") or [] if e.get("action") == "question"]
    if looks:
        lines.append("Look again at these items:")
        for e in looks:
            kind, _, key = str(e["id"]).partition(":")
            title = f" ({e['title']})" if e.get("title") else ""
            lines.append(f"- {kind} {key}{title}: {e.get('note') or ''}")
    if review.get("general_note"):
        lines.append(f"General: {review['general_note']}")
    return "\n".join(lines) + "\n" if lines else None


# The spec owning each checkpoint kind registers its entry builder here (C7, F4, D10, B2).
ENTRY_BUILDERS: dict[str, EntryBuilder] = {
    "roadmap_items": _roadmap_items,
    "baseline_confirm": _baseline_confirm,
}


# --------------------------------------------------------------------------- build


def build_review(
    cp: _Checkpoint,
    actions: list[ReviewAction],
    items: list[str],
    reasons: list[dict[str, Any]],
    note: str | None,
    attempt: int | None,
) -> dict[str, Any]:
    """The review file of a send-back at ``cp``: ``actions`` as the D8 read has them (only
    the staged are sent), ``items`` the reviewed file's item ids in order, ``reasons`` the
    D2 reasons as of now, ``note`` the note to the agents."""
    builder = ENTRY_BUILDERS.get(cp.kind)
    staged = [a for a in actions if a.state == "staged"]
    entries, waived = builder(staged, items, reasons) if builder else ([], [])
    entered = {e["id"] for e in entries} | {w["id"] for w in waived}
    open_reasons = [
        r for r in reasons if not any(_answers(a, r) for a in staged if a.item_key == r["item"])
    ]
    problems_open = [
        {"id": r["item"], "code": r["code"], "text": r.get("text")}
        for r in open_reasons
        if r.get("severity", BLOCKING) == BLOCKING
    ]
    with_open = {r["item"] for r in open_reasons}
    payload = cp.payload or {}
    return {
        "version": VERSION,
        "checkpoint": cp.kind,
        "run": str(cp.run_id),
        "segment": payload.get("segment"),
        "attempt": attempt,
        "file": ITEM_FILES.get(cp.kind),
        "items": entries,
        "unchanged": [k for k in items if k not in entered and k not in with_open]
        if builder
        else [],
        "problems_open": problems_open if builder else [],
        "waived": waived,
        "general_note": note or None,
    }


def _ordered(row: Any, keys: tuple[str, ...]) -> Any:
    if not isinstance(row, dict):
        return row
    rank = {k: n for n, k in enumerate(keys)}
    out = {k: row[k] for k in sorted(row, key=lambda k: (rank.get(k, len(rank)), k))}
    for k, v in out.items():
        if isinstance(v, dict):
            out[k] = _ordered(v, ())
    return out


def canonical(review: dict[str, Any]) -> dict[str, Any]:
    """The review in its fixed key order: the file's keys, each entry's, nested maps by
    name."""
    out = {k: review.get(k) for k in KEYS}
    out["items"] = [_ordered(e, ENTRY_KEYS) for e in out["items"] or []]
    for k in ("problems_open", "waived"):
        out[k] = [_ordered(r, ROW_KEYS) for r in out[k] or []]
    return out


def _what(review: dict[str, Any]) -> str:
    return review.get("file") or f"the {review.get('segment') or review['checkpoint']} output"


# --------------------------------------------------------------------------- render


def render_yaml(review: dict[str, Any], sent_on: datetime | None = None) -> str:
    """``review.yaml``: the two header comments, then the keys in their fixed order."""
    from oracle.runs.actions import KIND_WORDS

    words = KIND_WORDS.get(review["checkpoint"], review["checkpoint"].replace("_", " "))
    attempt = f", attempt {review['attempt']}" if review.get("attempt") else ""
    on = f" on {sent_on.date().isoformat()}" if sent_on else ""
    header = (
        f"# Review of {_what(review)}{attempt}, at the {words[:1].upper()}{words[1:]} "
        "checkpoint.\n"
        f"# Sent back by an approver{on}. Apply each entry; answer each in resolutions.\n"
    )
    body = safe_yaml.dump(
        canonical(review), sort_keys=False, allow_unicode=True, default_flow_style=False, width=4096
    )
    return header + body


def change_request(review: dict[str, Any], sent_on: datetime | None = None) -> str:
    """What a segment re-run gets as its change request: the instructions, then the YAML."""
    what = _what(review)
    note = look_again_note(review)
    return (note + "\n" if note else "") + (
        f"The reviewer sent {what} back with a structured review (review.yaml, below). "
        f"Start from your previous {what}. Apply every entry; do not change items under "
        "`unchanged` unless an entry forces it, and say so. Answer every entry under "
        "`resolutions`.\n\n" + render_yaml(review, sent_on)
    )


# --------------------------------------------------------------------------- findings


def _value(v: Any) -> str:
    if v is None:
        return "null"
    if isinstance(v, list):
        return ", ".join(str(x) for x in v)
    if isinstance(v, str):
        return json.dumps(v, ensure_ascii=False)
    return str(v)


def _line(entry: dict[str, Any]) -> str:
    parts: list[str] = []
    for field, v in (entry.get("changes") or {}).items():
        if isinstance(v, dict):
            parts.append(" ".join([field, *(f"{k} {_value(x)}" for k, x in v.items())]))
        else:
            parts.append(f"{field} {_value(v)}")
    if entry.get("reorder"):
        parts.append(f"reorder after {entry['after']}" if entry.get("after") else "reorder")
    if entry.get("into"):
        parts.append(f"into {_value(entry['into'])}")
    if entry.get("with"):
        parts.append(f"with {_value(entry['with'])}")
    if entry["action"] == "question":
        asked = f" asked to {entry['asked_to']}" if entry.get("asked_to") else ""
        answer = _value(entry["answer"]) if entry.get("answer") else "none yet"
        parts.append(f"{_value(entry.get('question'))}{asked}; answer {answer}")
    line = f"{entry['id']}: {entry['action']}"
    if parts:
        line += " " + "; ".join(parts)
    if entry.get("answers"):
        line += f" (answers: {', '.join(entry['answers'])})"
    if entry.get("note"):
        line += f". Note: {entry['note']}"
    return line


def findings(review: dict[str, Any], extra: list[str] | None = None) -> list[str]:
    """The workflow revise step's findings: a lead line, one line per entry, the items left
    alone, the note, then ``extra`` (Oracle's check, after the person's note as before D4);
    at most :data:`MAX_FINDINGS` lines."""
    review = canonical(review)
    entries = review["items"]
    attempt = f", attempt {review['attempt']}" if review.get("attempt") else ""
    lines = [
        f"Structured review of {_what(review)}{attempt}: {len(entries)} "
        f"{'entry' if len(entries) == 1 else 'entries'}. The full review: get_checkpoint_review."
    ]
    lines += [_line(e) for e in entries]
    if review.get("unchanged"):
        lines.append(f"Unchanged: {', '.join(review['unchanged'])}")
    if review.get("general_note"):
        lines.append(f"Note: {review['general_note']}")
    lines += extra or []
    if len(lines) > MAX_FINDINGS:
        lines = [*lines[: MAX_FINDINGS - 1], MORE]
    return lines


async def sent_review(db: Any, principal: Any, run: Any, cp: Any, note: str | None) -> dict:
    """The review file of a send-back being recorded at ``cp``, from its shared draft as
    the D8 read has it now (the caller holds the run's lock)."""
    from oracle.runs import actions

    draft = await actions.read(db, principal, run.id, cp.id)
    items = [i.key for i in draft.items if i.position is not None]
    reasons = [r.model_dump() for i in draft.items for r in i.reasons]
    staged = [a for i in draft.items for a in i.actions]
    review = build_review(cp, staged, items, reasons, note, draft.attempt)
    if cp.kind == "baseline_confirm":
        # B2: the Send back note names each item with its title.
        titles = {i.key: i.title for i in draft.items}
        for entry in review["items"]:
            entry["title"] = titles.get(entry["id"])
    return review
