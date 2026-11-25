"""panel-stages (#1815 5): the feature panel's "give this item the feature's code".

``take_feature_code`` on an item that has a code of its own (its title's lead) while another
item of its feature reads the feature's code: the item drops its own code, so it reads the
feature's, and the item that had it takes the next free number. One change keyed by item id
(changes.KEYED: ``{item id: {"title"}}``), so one Undo puts both titles back. A commenter's is
a proposal, as every panel change is (changes.create).
"""

from types import SimpleNamespace
from typing import Any

from sqlalchemy.ext.asyncio import AsyncSession

from oracle.simple import drafts, service

OP = "take_feature_code"
# A draft's list of changes names it (drafts.OP_WORDS; drafts.py is at its size limit).
drafts.OP_WORDS[OP] = "Feature code given to"


async def plan(
    db: AsyncSession, entry: Any, body: Any, target: dict[str, Any], read_: Any
) -> tuple[dict[str, Any], dict[str, Any]]:
    """(before, after) keyed by item id; 422 when the item has nothing to take, 409 when
    its code is not the one the caller saw."""
    from oracle.roadmap import codes
    from oracle.simple import additions
    from oracle.simple.changes import (
        ChangeError,
        _conflict,
        _lock,
        _with_code,
        read,
    )

    by_id = read_.by_id()
    by_feature = await codes.feature_codes(db)
    feature = by_feature.get(entry.row.feature_id) if entry.row.feature_id else None
    own, name = service.coded_title(entry.row.title, None)
    if feature is None:
        raise ChangeError(422, "It is not part of a Ground Truth feature")
    if own is None or own == feature:
        raise ChangeError(422, "It already has its feature's code")
    if "code" not in body.before:
        raise ChangeError(422, "before: code as you saw it")
    if body.before["code"] != own:
        raise await _conflict(db, {"code": own}, {str(entry.row.id)}, "Changed since you saw it")
    holder = next(
        (
            d
            for d in by_id.values()
            if d is not entry
            and d.row.feature_id == entry.row.feature_id
            and d.status not in ("cut", "merged")
            and codes.title_code(d.row.title) is None
        ),
        None,
    )
    rows = [entry] + ([holder] if holder else [])
    await _lock(db, [e.row.id for e in rows])
    before = {str(e.row.id): read(e.row, ("title",), target) for e in rows}
    after: dict[str, Any] = {str(entry.row.id): {"title": name}}
    target.update(code=feature, titles=[e.row.title for e in rows])
    if holder is not None:
        new = await additions._next_code(db, read_)  # the one numbering rule
        after[str(holder.row.id)] = {"title": _with_code(new, holder.row.title)}
        target.update(other=holder.row.title, new_code=new)
    return before, after


def phrase(target: dict[str, Any], x: str) -> str:
    """What was done: gave Routing by team the code F-51; Alert routing is now F-65."""
    out = f"gave {x} the code {target.get('code')}"
    if target.get("other"):
        out += f"; {target['other']} is now {target.get('new_code')}"
    return out


async def title_code(db: AsyncSession, entry: Any, title: str, read_: Any) -> None:
    """every-field: a title leading with a code other than the item's own ("F-31 Alerts",
    any code the read takes from a title: service.coded_title) gives the item that code: it is
    checked as set_code checks it, in its words. ``entry`` None: an item being added."""
    from oracle.simple.changes import _code_of, _not_taken

    lead = service.coded_title(title, None)[0]
    if not lead:
        return
    if entry is not None:
        # panel-stages (#1815): every item, its code from its feature or PRD too; only the
        # code it reads already is no new code.
        await service.item_codes(db, [entry])
        if lead in (service.coded_title(entry.row.title, None)[0], _code_of(entry)):
            return
    new = SimpleNamespace(row=SimpleNamespace(id=None))
    await _not_taken(db, entry if entry is not None else new, lead, read_.by_id())
