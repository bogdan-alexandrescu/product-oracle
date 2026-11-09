"""roadmap-milestone-codes (the owner, Nov 9): one list of milestones per roadmap read, each
with one code M1, M2, M3 ... by date across the whole read, so every surface and export
shows the same code ("milestones should have a unique number (m1, m2, m3) and shouldn't
show up more than once on the roadmap").

The list holds the goal milestones (a roadmap's own, a key result's, the goal ladder's and
each PRD's) and the track milestones. A goal milestone that is the same milestone as a
track milestone is folded into it and shares its code (the one place of that rule; Home's
plan reads it as one row): the track milestone is the one of that code holding items on the
goal milestone's roadmap, and either the goal milestone has no goal (a PRD's or the
roadmap's own) or it is the roadmap's only milestone of that code with a name that matches
(one's words lead the other's, or one has none).

Codes go by date (undated last); on one date by goal order (``oracle.baseline.goal_order``,
no goal last), then by name. No suffixes, no repeats: a milestone added or moved earlier
renumbers the later ones. A dropped track milestone and a PRD plan's own track milestone
(start and end dated; its PRD milestone is listed) get none.
"""

import re
import uuid
from datetime import date

from oracle.simple.schemas import SimpleGoalMilestone, SimpleMilestone, SimpleRoadmapItem

_CODE = re.compile(r"^(M\d{1,2})(?![\w.])\s*[·:\-–—]?\s*(.*)$", re.IGNORECASE)  # noqa: RUF001


def split(name: str) -> tuple[str | None, str]:
    """A milestone name's own code ("M1") and the rest of it."""
    m = _CODE.match(name.strip())
    return (m[1].upper(), m[2].strip()) if m else (None, name.strip())


def _unwrap(name: str) -> str:
    """A name with one pair of brackets round it, read without them ("[Launch (beta)]")."""
    n = name.strip()
    if len(n) > 1 and (n[0], n[-1]) in (("[", "]"), ("(", ")")) and _CLOSE.fullmatch(n[1:-1]):
        return n[1:-1].strip()
    return n


_CLOSE = re.compile(r"[^\[\]()]*(?:(?:\[[^\[\]]*\]|\([^()]*\))[^\[\]()]*)*")


def _words(name: str) -> list[str]:
    return _unwrap(name).lower().split()


def _match(a: str, b: str) -> bool:
    x, y = sorted((_words(a), _words(b)), key=len)
    return not x or x == y[: len(x)]


def _gm_code(gm: SimpleGoalMilestone) -> str | None:
    return gm.code.strip().upper() or split(gm.name)[0]


def assign(
    goal_ms: list[SimpleGoalMilestone],
    track_ms: list[SimpleMilestone],
    items: list[SimpleRoadmapItem],
    goal_rank: dict[uuid.UUID, int],
) -> None:
    """Sets ``roadmap_code`` on each milestone of the read (see the module's rule)."""
    tracks = [m for m in track_ms if m.status != "dropped" and not (m.start_date and m.end_date)]
    for m in [*goal_ms, *track_ms]:
        m.roadmap_code = None
    roadmap_of = {i.id: i.roadmap.id for i in items}
    held: dict[uuid.UUID, set[uuid.UUID]] = {}
    for i in items:
        rid = i.milestone.record_id if i.milestone else None
        if rid is not None:
            held.setdefault(rid, set()).add(i.roadmap.id)
    for tm in tracks:
        held.setdefault(tm.id, set()).update(roadmap_of[x] for x in tm.item_ids if x in roadmap_of)
    # One entry per milestone: a track milestone with the goal milestones folded into it.
    groups: dict[uuid.UUID, list[SimpleGoalMilestone | SimpleMilestone]] = {
        tm.id: [tm] for tm in tracks
    }
    for gm in goal_ms:
        code = _gm_code(gm)
        there = [
            tm
            for tm in tracks
            if code and split(tm.name)[0] == code and gm.roadmap_id in held.get(tm.id, ())
        ]
        alike = {
            (g.goal_id, g.prd.id if g.prd else None)
            for g in goal_ms
            if g.roadmap_id == gm.roadmap_id and _gm_code(g) == code
        }
        plain = gm.goal_id is None
        same = len(alike) == 1 and len(there) == 1 and _match(gm.name, split(there[0].name)[1])
        if len(there) == 1 and (plain or same):
            groups[there[0].id].append(gm)
        else:
            groups[gm.id] = [gm]
    far = len(goal_rank) + 1

    def key(members: list[SimpleGoalMilestone | SimpleMilestone]) -> tuple:
        lead = members[0]
        dates = [m.date for m in members if m.date is not None]
        when: date | None = lead.date or (min(dates) if dates else None)
        ranks = [
            goal_rank.get(m.goal_id, far)
            for m in members
            if isinstance(m, SimpleGoalMilestone) and m.goal_id
        ]
        name = split(lead.name)[1] if isinstance(lead, SimpleMilestone) else lead.name
        rank = min(ranks, default=far)
        return (when is None, when or date.min, rank, name.casefold(), str(lead.id))

    for n, members in enumerate(sorted(groups.values(), key=key), start=1):
        for m in members:
            m.roadmap_code = f"M{n}"
