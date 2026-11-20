"""Simple meetings: a live meeting's notes and agenda."""

import json
import uuid
from datetime import timedelta
from typing import Any

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from oracle import audit, company_time
from oracle.authz import has_role
from oracle.roadmap.models import RoadmapItem
from oracle.simple.meetings_common import (
    MeetingError,
    PrdWho,
    _me,
)
from oracle.simple.models import (
    SimpleMeeting,
)


async def _live(db: AsyncSession, meeting_id: uuid.UUID) -> SimpleMeeting:
    m = await db.get(SimpleMeeting, meeting_id, with_for_update=True)
    if m is None:
        raise MeetingError(404, "No such meeting")
    if m.status == "ended":
        raise MeetingError(409, "This meeting has ended")
    return m


async def add_note(db: AsyncSession, principal: Any, meeting_id: uuid.UUID, kind: str,
                   text_: str, card_id: uuid.UUID | None = None) -> str:  # fmt: skip
    """A minutes note or open question added during the meeting (chat-actions); it shows on
    the meeting's screen and goes into Oracle's drafted minutes. The caller commits."""
    m = await _live(db, meeting_id)
    note = {"id": str(uuid.uuid4()), "kind": kind, "text": text_.strip()[:1000],
            "by": str(_me(principal)), "at": company_time.now().isoformat(),
            "card_id": str(card_id) if card_id else None}  # fmt: skip
    m.notes = [*(m.notes or []), note]
    await db.flush()
    return note["id"]


async def remove_note(db: AsyncSession, meeting_id: uuid.UUID, note_id: str) -> None:
    m = await _live(db, meeting_id)
    m.notes = [n for n in m.notes or [] if n.get("id") != note_id]
    await db.flush()


async def set_agenda(db: AsyncSession, meeting_id: uuid.UUID, item_id: uuid.UUID | None,
                     move: str) -> dict:  # fmt: skip
    """Take an item next or skip it (``move``: next, skip), or put back an agenda
    (``move`` restore with ``item_id`` None is the caller's: :func:`restore_agenda`).
    Returns the agenda as it was, for Undo."""
    m = await _live(db, meeting_id)
    was = dict(m.agenda or {})
    skipped = [i for i in was.get("skipped") or [] if i != str(item_id)]
    nxt = was.get("next")
    if move == "next":
        nxt = str(item_id)
    else:
        skipped.append(str(item_id))
        if nxt == str(item_id):
            nxt = None
    m.agenda = {**was, "next": nxt, "skipped": skipped}
    await db.flush()
    return {"next": was.get("next"), "skipped": list(was.get("skipped") or [])}


async def restore_agenda(db: AsyncSession, meeting_id: uuid.UUID, agenda: dict) -> None:
    m = await _live(db, meeting_id)
    m.agenda = {**(m.agenda or {}), "next": agenda.get("next"),
                "skipped": list(agenda.get("skipped") or [])}  # fmt: skip
    await db.flush()


def _agenda_right(principal: Any, w: PrdWho) -> str:
    """agenda-sheet: an owner or the PRD's decider saves agenda changes; an approver who
    is not the decider proposes them; everyone else reads."""
    me = _me(principal)
    if has_role(principal.role, "owner") or (
        me is not None and me == w.decider and has_role(principal.role, "commenter")
    ):
        return "save"
    return "propose" if has_role(principal.role, "approver") else "read"


def _agenda_apply(a: dict, rows: list[dict], titles: dict[str, str], me: uuid.UUID,
                  body: dict) -> dict:  # fmt: skip
    """Apply one sheet op to ``rows`` (in place); returns its clause for the Undo line
    (:func:`_agenda_words`)."""
    states = dict(zip([x["id"] for x in rows], _states(a, rows), strict=True))

    def find(i: str | None) -> dict:
        x = next((x for x in rows if x["id"] == i), None)
        if x is None:
            raise MeetingError(404, "That item is not on the agenda")
        return x

    op = body["op"]
    if op == "add":
        if body.get("feature_id"):
            f = str(body["feature_id"])
            if f not in titles:
                raise MeetingError(404, "That feature is not in the meeting's PRD")
            if any(x.get("feature_id") == f for x in rows):
                raise MeetingError(409, "That feature is on the agenda already")
            rows.append({"id": f, "feature_id": f, "title": None, "was": titles[f],
                         "mins": FEATURE_MINS, "by": str(me)})  # fmt: skip
            return {"op": "add", "id": f, "name": titles[f]}
        title = (body.get("title") or "").strip()
        if not title:
            raise MeetingError(422, "Give the topic a name")
        i = str(uuid.uuid4())
        rows.append({"id": i, "feature_id": None, "title": title, "mins": TOPIC_MINS,
                     "by": str(me)})  # fmt: skip
        return {"op": "add", "id": i, "name": title}
    x = find(body.get("item_id"))
    if states[x["id"]] in ("done", "now"):
        raise MeetingError(409, "The current item and done ones stay where they are")
    was = _row_name(x, titles, "the item")
    if op == "rename":
        title = (body.get("title") or "").strip()
        if not title:
            raise MeetingError(422, "Give the item a name")
        x["title"] = title
        return {"op": "rename", "id": x["id"], "name": was, "to": title}
    if op == "remove":
        # port-an-decisions: the row and where it stood, for its Trash entry's Restore.
        at = rows.index(x)
        rows.remove(x)
        return {"op": "remove", "id": x["id"], "name": was, "row": dict(x), "at": at}
    # move: never before the current item or a done one.
    first = max(
        (k + 1 for k, y in enumerate(rows) if states[y["id"]] in ("done", "now")), default=0
    )
    at = rows.index(x)
    to = max(first, min(int(body.get("to") or 0), len(rows) - 1))
    rows.remove(x)
    rows.insert(to, x)
    return {"op": "move", "id": x["id"], "name": was, "dir": "up" if to < at else "down"}


def _row_name(x: dict, titles: dict[str, str], none: str) -> str:
    """A row's name: its own, its feature's, else the name its feature last had here."""
    return x.get("title") or titles.get(x.get("feature_id") or "") or x.get("was") or none


def _agenda_words(clauses: list[dict]) -> list[str]:
    """The batch's clauses as words; a move and a rename of one item read as one clause
    ("moved Quiet hours up and renamed it"), named as the item was when first touched."""
    out: list[dict] = []
    for c in clauses:
        same = next(
            (o for o in out if o["id"] == c["id"] and o["op"] in ("move", "rename", "both")),
            None,
        ) if c["op"] in ("move", "rename") else None  # fmt: skip
        if same is None:
            out.append(dict(c))
        elif c["op"] == "move":
            same.update(op="both" if same["op"] != "move" else "move", dir=c["dir"])
        else:
            same.update(op="both" if same["op"] != "rename" else "rename", to=c["to"])
    words = {
        "add": "added {name}",
        "remove": "removed {name}",
        "move": "moved {name} {dir}",
        "rename": "renamed {name} to {to}",
        "both": "moved {name} {dir} and renamed it",
    }
    return [words[c["op"]].format(**c) for c in out]


async def _trash_removed(
    db: AsyncSession, principal: Any, m: SimpleMeeting, clauses: list[dict]
) -> list[str]:
    """port-an-decisions: each agenda item the batch removed goes to Settings › Trash, its
    row kept in the entry (the agenda is the meeting's JSON); returns the entries' ids, so
    the batch's Undo takes them back out and the sheet offers Open Trash."""
    from oracle.trash import service as trash
    from oracle.trash.models import RETENTION_DAYS, TrashEntry

    out: list[str] = []
    for c in clauses:
        if c.get("op") != "remove":
            continue
        at = trash.now()
        root = {"type": "agenda_item", "id": c["id"], "slug": None, "title": c["name"],
                "kind": "agenda_item", "meeting_id": str(m.id), "meeting": m.title, "row": c["row"],
                "at": c["at"]}  # fmt: skip
        entry = TrashEntry(id=uuid.uuid4(), root_type="agenda_item", root_id=uuid.UUID(c["id"]),
                           root=json.loads(json.dumps(root, default=str)), items=[],
                           deleted_by=principal.id,
                           deleted_by_name=await trash._actor_name(db, principal),
                           published=False,
                           purge_after=at + timedelta(days=RETENTION_DAYS))  # fmt: skip
        entry.created_at = at
        db.add(entry)
        await audit.record(db, principal, "trash.delete", "agenda_item", entry.root_id,
                           {"entry_id": str(entry.id), "root": root, "items": []})  # fmt: skip
        out.append(str(entry.id))
    await db.flush()
    return out


async def _untrash(db: AsyncSession, entry_ids: list[str]) -> None:
    """An Undo of the batch that removed them: their Trash entries go (the rows are back)."""
    from sqlalchemy import delete

    from oracle.trash.models import TrashEntry

    if entry_ids:
        await db.execute(
            delete(TrashEntry).where(TrashEntry.id.in_([uuid.UUID(i) for i in entry_ids]))
        )


async def restore_agenda_item(db: AsyncSession, entry: Any) -> None:
    """port-an-decisions: Trash's Restore of a removed agenda item puts its row back where it
    stood (never before the current item or a done one). Refused (409) when its meeting has
    ended or is gone, or the item is on the agenda again."""
    from oracle.trash import service as trash

    root = entry.root
    m = await db.get(SimpleMeeting, uuid.UUID(root["meeting_id"]), with_for_update=True,
                     populate_existing=True)  # fmt: skip
    if m is None:
        raise trash.Conflict("Its meeting was deleted: there is no agenda to put it back on")
    if m.status == "ended":
        raise trash.Conflict("Its meeting has ended: the agenda is closed")
    a = dict(m.agenda or {})
    rows = [dict(x) for x in a.get("items") or []]
    row = dict(root["row"])
    if any(x["id"] == row["id"] for x in rows):
        raise trash.Conflict(f"'{root['title']}' is on the agenda again already")
    states = _states(a, rows)
    first = max((k + 1 for k, st in enumerate(states) if st in ("done", "now")), default=0)
    rows.insert(max(first, min(int(root.get("at") or 0), len(rows))), row)
    a["items"] = rows
    a["trashed"] = [i for i in a.get("trashed") or [] if i != str(entry.id)]
    m.agenda = json.loads(json.dumps(a, default=str))
    await db.flush()


async def _agenda_features(db: AsyncSession, document_id: uuid.UUID) -> list[RoadmapItem]:
    """The PRD's features in roadmap order, one row per item key (its every version)."""
    rows = await db.scalars(
        select(RoadmapItem)
        .where(RoadmapItem.prd_document_id == document_id)
        .order_by(RoadmapItem.position, RoadmapItem.item_key)
    )
    seen: dict[str, RoadmapItem] = {}
    for r in rows:
        seen.setdefault(r.item_key, r)
    return list(seen.values())


FEATURE_MINS, TOPIC_MINS = 10, 5


def _rows(m: SimpleMeeting, features: list[RoadmapItem]) -> list[dict]:
    """agenda-sheet: the agenda's rows as stored; before the first edit, the PRD's
    features in order (each row's id is its feature's id, so it stays put once stored)."""
    a = m.agenda or {}
    if "items" in a:
        return [dict(x) for x in a["items"]]
    return [{"id": str(r.id), "feature_id": str(r.id), "title": None, "was": r.title,
             "mins": FEATURE_MINS} for r in features]  # fmt: skip


def _states(a: dict, rows: list[dict]) -> list[str]:
    """Rows decided in the meeting are done; the chat's skipped ones skipped; the first
    other row is now."""
    skipped = set(a.get("skipped") or [])
    done = set(a.get("done") or [])
    out, now = [], False
    for x in rows:
        if x.get("done") or (x.get("feature_id") or "") in done:
            out.append("done")
        elif x["id"] in skipped or (x.get("feature_id") or "") in skipped:
            out.append("skipped")
        elif not now:
            now = True
            out.append("now")
        else:
            out.append("next")
    return out
