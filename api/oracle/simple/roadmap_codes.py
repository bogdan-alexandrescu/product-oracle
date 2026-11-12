"""roadmap-milestone-codes (the owner, Nov 9): one list of milestones per roadmap read, each
with one code M1, M2, M3 ... by date across the whole read, so every surface and export
shows the same code ("milestones should have a unique number (m1, m2, m3) and shouldn't
show up more than once on the roadmap").

The list holds the goal milestones (a roadmap's own, a key result's, the goal ladder's and
each PRD's) and the track milestones. A goal milestone that is the same milestone as a
track milestone is folded into it and shares its code (the one place of that rule; Home's
plan reads it as one row): the track milestone is the one of that code holding items on the
goal milestone's roadmap, and either the goal milestone has no goal (a PRD's or the
roadmap's own) and it is the one such track, or their names match (one's words lead the
other's), whatever else of the code the roadmap holds; one with no name matches only as the
roadmap's only one of that code (the owner's "Join
whenever names match", Nov 9). A goal's milestone whose name matches a PRD's (or the roadmap's
own) milestone of its code on its roadmap is that milestone too, and so is a goal's own
milestone whose name matches a PRD's milestone of any code on its roadmap (the Goal map's
twins, Nov 10), only when that PRD milestone serves the same goal or none and its group holds
no other goal's milestone ("Join only within the same goal", Nov 11). The joins by code (to a
track milestone, to the roadmap's own, and a PRD's to either) are made first, unchecked, so a
group a track or the roadmap's own milestone holds may join several goals; then a goal's own
joins a PRD milestone, seeing every goal that group already holds, whatever the goal order. Of
several such PRD milestones the closest in date joins, then the one of its exact name; at most
one goal's own milestone joins a given group by a PRD milestone (goal order first), so a later
goal's own joins another PRD milestone it may join by these rules (another "Beta launch"),
else keeps its own code. A group with a track milestone is dated by it, or, if it has no
date, by the earliest date of any member (a PRD's too); any other group by its earliest
goal's own milestone, else by its earliest. No name is hidden: each surface shows the longer
name and lists the other ("Also: ...").

Codes go by date (undated last); on one date by goal order (``oracle.baseline.goal_order``,
no goal last), then by name. No suffixes, no repeats: a milestone added or moved earlier
renumbers the later ones. A dropped track milestone and a PRD plan's own track milestone
(start and end dated; its PRD milestone is listed) get none. Beyond ordering milestones of one
date, codes do not depend on goal order, except the one tie-break above: when two goals' own
milestones contend for one PRD milestone, the first goal in goal order takes it.
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
    # Join whenever names match (the owner, Nov 9): a goal milestone is the same milestone as a
    # track milestone (or a PRD's, or the roadmap's own, milestone) of its code on its roadmap
    # whose name it leads or follows, whatever else of the code the roadmap holds.
    into: dict[uuid.UUID, uuid.UUID] = {}

    def best(
        gm: SimpleGoalMilestone, of: list, alone: bool, near: bool = False
    ) -> uuid.UUID | None:
        # Two names match when one's words lead the other's; one with no name only as the
        # roadmap's only one of its code (a bare "M3" never takes every goal's M3).
        name = split(gm.name)[1]

        def ok(m: SimpleGoalMilestone | SimpleMilestone) -> bool:
            other = split(m.name)[1]
            return _match(name, other) if _words(name) and _words(other) else alone

        def gap(m: SimpleGoalMilestone | SimpleMilestone) -> float:
            if not near or gm.date is None or m.date is None:
                return float("inf")
            return abs((m.date - gm.date).days)

        hits = sorted(
            (m for m in of if ok(m)),
            key=lambda m: (gap(m), _words(split(m.name)[1]) != _words(name), str(m.id)),
        )
        return hits[0].id if hits else None

    far = len(goal_rank) + 1

    # No goal first, then a PRD's of a goal (a goal's own may join either), then a goal's own
    # by goal order (the first takes a PRD milestone its name matches).
    def order(g: SimpleGoalMilestone) -> tuple:
        own = g.prd is None and g.goal_id is not None
        rank = goal_rank.get(g.goal_id, far) if own and g.goal_id else 0
        return (g.goal_id is not None) + own, rank, str(g.id)

    prds = {g.id for g in goal_ms if g.prd is not None}
    taken: set[uuid.UUID] = set()  # groups a goal's own milestone has joined by a PRD milestone

    def mine(gm: SimpleGoalMilestone, m: SimpleGoalMilestone) -> bool:
        """A PRD milestone a goal's own may join: its group holds no milestone of another goal."""
        return all(
            not isinstance(x, SimpleGoalMilestone) or x.goal_id in (None, gm.goal_id)
            for x in groups.get(into.get(m.id, m.id), ())
        )

    def join(gm: SimpleGoalMilestone, to: uuid.UUID | None) -> None:
        if to is None:
            groups[gm.id] = [gm]
            return
        to = into.get(to, to)
        into[gm.id] = to
        groups.setdefault(to, []).append(gm)

    # First every join by code; a goal's own that makes none waits for the PRD joins below.
    later: list[tuple[SimpleGoalMilestone, list[SimpleGoalMilestone]]] = []
    for gm in sorted(goal_ms, key=order):
        code = _gm_code(gm)
        own = gm.prd is None and gm.goal_id is not None
        there = [
            tm
            for tm in tracks
            if code and split(tm.name)[0] == code and gm.roadmap_id in held.get(tm.id, ())
        ]
        if gm.goal_id is None and len(there) == 1:
            join(gm, there[0].id)
            continue
        plain = [
            g
            for g in goal_ms
            if code and g.goal_id is None and g is not gm
            and g.roadmap_id == gm.roadmap_id and _gm_code(g) == code
        ]  # fmt: skip
        alike = {
            (g.goal_id, g.prd.id if g.prd else None)
            for g in goal_ms
            if g.roadmap_id == gm.roadmap_id and _gm_code(g) == code
        }
        alone = len(alike) == 1 and len(there) == 1
        to = best(gm, there, alone)
        if to is None and gm.goal_id is not None:
            to = best(gm, [g for g in plain if not own or g.id not in prds], False)
        if to is None and own:
            later.append((gm, [g for g in plain if g.id in prds]))
            continue
        join(gm, to)

    # Then a goal's own joins a PRD milestone, by goal order: of its code, else its twin (the
    # Goal map's, Nov 10: of the same name, whatever the PRD's code, its plan's), of its goal or
    # none and only if the group holds no other goal's milestone ("Join only within the same
    # goal", the owner, Nov 11), every join by code already in it.
    for gm, plain in later:
        twins = [
            g
            for g in goal_ms
            if g.prd is not None and g is not gm and g.roadmap_id == gm.roadmap_id
            and g.goal_id in (None, gm.goal_id) and mine(gm, g)
        ]  # fmt: skip
        to = best(gm, [g for g in plain if mine(gm, g)], False) or best(gm, twins, False, near=True)
        # One goal's own milestone per joined group; another stays its own.
        if to is not None:
            if into.get(to, to) in taken:
                to = None
            else:
                taken.add(into.get(to, to))
        join(gm, to)

    def key(members: list[SimpleGoalMilestone | SimpleMilestone]) -> tuple:
        lead = members[0]
        dates = [m.date for m in members if m.date is not None]
        # A joined group goes by its earliest goal's own milestone (its track milestone's first),
        # never by the first goal's, so goal order does not move it (round-3 review).
        own = [
            m.date
            for m in members
            if isinstance(m, SimpleGoalMilestone) and m.goal_id and m.prd is None and m.date
        ]
        if isinstance(lead, SimpleMilestone):
            when: date | None = lead.date or (min(dates) if dates else None)
        else:
            when = min(own) if own else (min(dates) if dates else None)
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
