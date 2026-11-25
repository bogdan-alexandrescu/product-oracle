"""#1866 (the owner, Nov 24: "the API names them"): the goals, features and milestones whose
codes a note a person wrote mentions ("hold G-2 until F-104 has a date"), each with its code
and name, so a page shows the code with its name. The note itself is never rewritten.

Read with the caller's tenant session, so another company's names are never sent. A code
that names nothing, or a milestone code two milestones of different names share, is left
as written (no entry). Notes with no code cost no read.
"""

import re
from collections.abc import Iterable
from typing import Any

from sqlalchemy import select

from oracle.simple.schemas_meetings import SimpleNoteCode

# A code as people write it: a feature's (F-104, F-15b), a goal's (G-2, G2, G-B) or a
# milestone's (M7, M-7); never inside a word or a longer code.
_CODE = re.compile(r"(?<![\w-])([A-Z]{1,3}-\d{1,5}[a-j]?|[A-Z]\d{1,4}|[A-Z]-[A-Z]\d{0,3})(?![\w-])")
_GOAL = re.compile(r"G-?(?:\d+|[A-Z]\d*)")
_MILESTONE = re.compile(r"M-?(\d+)")


def written(note: str | None) -> list[str]:
    """The codes ``note`` writes, each once, in its order."""
    return list(dict.fromkeys(m.group(1) for m in _CODE.finditer(note or "")))


def _flat(code: str) -> str:
    return code.replace("-", "").casefold()


async def names(db: Any, notes: Iterable[str | None]) -> dict[str, SimpleNoteCode]:
    """Each code ``notes`` write that names a goal, feature or milestone of the company, by
    the code as written."""
    from oracle.baseline.models import Entity
    from oracle.roadmap import codes as roadmap_codes
    from oracle.roadmap.models import TrackMilestone
    from oracle.simple.service import coded_title

    wanted = {c for n in notes for c in written(n)}
    if not wanted:
        return {}
    out: dict[str, SimpleNoteCode] = {}
    features = {c for c in wanted if not _GOAL.fullmatch(c) and not _MILESTONE.fullmatch(c)}
    if features:
        by_id = {
            fid: code for fid, code in (await roadmap_codes.feature_codes(db)).items()
            if code in features
        }  # fmt: skip
        if by_id:
            rows = await db.execute(
                select(Entity.id, Entity.title).where(
                    Entity.id.in_(by_id), Entity.deleted_at.is_(None)
                )
            )
            for fid, title in rows.all():
                code = by_id[fid]
                name = coded_title(title or "", code)[1].strip()
                if name and name != code:
                    out[code] = SimpleNoteCode(code=code, name=name, kind="feature")
    goals = {_flat(c): c for c in wanted if _GOAL.fullmatch(c)}
    if goals:
        rows = await db.execute(
            select(Entity.key, Entity.title).where(
                Entity.type == "goal",
                Entity.status == "confirmed",
                Entity.deleted_at.is_(None),
            )
        )
        for key, title in rows.all():
            code = goals.get(_flat(key or ""))
            if code and (title or "").strip():
                out[code] = SimpleNoteCode(code=code, name=title.strip(), kind="goal")
    milestones = {f"M{m.group(1)}": c for c in wanted if (m := _MILESTONE.fullmatch(c))}
    if milestones:
        rows = await db.execute(
            select(TrackMilestone.code, TrackMilestone.name).where(
                TrackMilestone.code.in_(milestones), TrackMilestone.deleted_at.is_(None)
            )
        )
        found: dict[str, set[str]] = {}
        for code, name in rows.all():
            if (name or "").strip():
                found.setdefault(code, set()).add(name.strip())
        for code, shown in found.items():
            if len(shown) == 1:
                written_as = milestones[code]
                out[written_as] = SimpleNoteCode(
                    code=written_as, name=next(iter(shown)), kind="milestone"
                )
    return out


def of(note: str | None, named: dict[str, SimpleNoteCode]) -> list[SimpleNoteCode]:
    """The named codes ``note`` writes, in its order."""
    return [named[c] for c in written(note) if c in named]
