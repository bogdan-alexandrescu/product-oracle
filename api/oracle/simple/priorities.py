"""Simple S6 (#723): the priorities read (``GET /v1/simple/priorities``). For people: a run's
token is refused (oracle.simple.router._people).

The live goal-weighted ranking (oracle.priorities.service.compute, people's overrides
applied; each row keeps Oracle's rank as ``oracle_rank``) joined with the roadmap items the
reader sees (oracle.simple.service.load over the working drafts they see): a feature's row
takes its item in the earliest horizon (now, next, later), then the lowest key, never a
draft item (drafts are not ranked yet: they sit among the drafts); a feature with no visible
non-draft item is still a row (no item, not reorderable, no weeks in a bucket). Besides the
rows: the open ``override_priority`` and ``estimate_feature`` proposals the caller may see
(each with its item's feature, so one on a feature's other item shows under its row) and
the ``confirm_item``, ``merge_item`` (S7's Merge; train T's was a ``cut`` with a note) and
``cut`` proposals on draft items, the visible
draft items with the items they may merge into, and this quarter's engineer-weeks per goal.

**The line** (roadmap-plus): above the line is this quarter's plan (the Now horizon) by
default; ``?line=`` draws it at a day instead: ``key_date:<id>`` (a roadmap's key date),
``milestone:<id>`` (a dated track milestone) or ``date:<YYYY-MM-DD>``; then a row is above
the line when its item is planned to finish by that day (its stored or estimated end). An
unknown line reads as Now. ``lines`` offers Now, every key date and every dated milestone
the reader sees; the web keeps a person's pick in their preferences (``priorities_line``).

Changes go through the change engine (``/v1/simple/changes``): ``override_priority`` (with
each row's ``before_override``), ``estimate_feature`` and ``confirm_item``. It writes
nothing.
"""

import re
import uuid
from datetime import date
from typing import Annotated, Any

from fastapi import APIRouter, Query
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from oracle.auth.deps import TenantDB
from oracle.authz import has_role
from oracle.baseline.models import Entity
from oracle.priorities import service as priorities
from oracle.priorities.schemas import RankedFeature
from oracle.roadmap.models import HORIZONS, RoadmapItem
from oracle.simple import changes, drafts, key_dates, service, targets
from oracle.simple.models import SimpleChange
from oracle.simple.router import Reader
from oracle.simple.schemas import (
    SimpleDocRef,
    SimpleGoalBucket,
    SimpleLine,
    SimplePlanOut,
    SimplePrioritiesOut,
    SimplePriorityAfter,
    SimplePriorityDraft,
    SimplePriorityGoal,
    SimplePriorityMerge,
    SimplePriorityOverride,
    SimplePriorityProposal,
    SimplePriorityRow,
    SimpleQuarter,
)

router = APIRouter(prefix="/v1/simple", tags=["simple"])

METHOD = "goal_weighted"
PROPOSED_OPS = ("override_priority", "estimate_feature")
# Confirm and Merge of a draft item, shown under the draft.
DRAFT_OPS = ("confirm_item", "cut", "merge_item")
MERGE_MAX = 8
NONE = "none"


def quarter(today: date) -> SimpleQuarter:
    """The calendar quarter of ``today``."""
    q = (today.month - 1) // 3
    start = date(today.year, 3 * q + 1, 1)
    end = date(today.year + 1, 1, 1) if q == 3 else date(today.year, 3 * q + 4, 1)
    return SimpleQuarter(start=start, end=date.fromordinal(end.toordinal() - 1),
                         label=f"Q{q + 1} {today.year}")  # fmt: skip


async def plan_quarter(
    db: AsyncSession, read_: service.Read
) -> tuple[SimpleQuarter, set[uuid.UUID] | None]:
    """plan-model: "this quarter" is the plan's span (the plan running today, else the next
    to start) of the PRDs on the roadmap; the calendar quarter only with no dated plan.
    With the plan's span, also the items it places in that span (a slice overlapping it);
    None: the calendar quarter, whose items are the Now horizon's."""
    from oracle.simple import plan

    views = await plan.views(db, {e.prd.id for e in read_.entries if e.prd})
    span = plan.current_span(list(views.values()), read_.today)
    if span is None:
        return quarter(read_.today), None
    inside = {
        e.row.id
        for e in read_.entries
        if e.prd is not None
        and e.prd.id in views
        and any(
            x.start_date is not None
            and x.end_date is not None
            and x.start_date <= span.end
            and x.end_date >= span.start
            for x in views[e.prd.id].slices_of(service._prd_code(e.row.prd_section_key))
        )
    }
    return SimpleQuarter(start=span.start, end=span.end, label=span.label), inside


async def plan_in_play(
    db: AsyncSession, read_: service.Read
) -> tuple[SimpleQuarter, SimplePlanOut | None]:
    """The quarter and plan-charts' plan: the plan "this quarter" is (its PRD on the roadmap
    the reader sees, its milestones, slices and engineer-weeks per goal per milestone)."""
    from oracle.simple import plan

    prds = {e.prd.id: e.prd for e in read_.entries if e.prd}
    picked = plan.current(await plan.views(db, set(prds)), read_.today)
    if picked is None or picked[1].span is None:
        return quarter(read_.today), None
    pid, view = picked
    span = view.span
    doc = prds[pid]
    return SimpleQuarter(start=span.start, end=span.end, label=span.label), SimplePlanOut(
        prd=SimpleDocRef(id=doc.id, slug=doc.slug, title=doc.title),
        status="ready", source=view.milestones[0].source if view.milestones else None,
        dated=view.dated, message=view.message, milestones=view.milestones,
        slices=view.slices, goals=view.goals, goal_weeks=view.goal_weeks, span=span,
        holidays=view.holidays,
    )  # fmt: skip


def _items(read_: service.Read) -> dict[str, service.Entry]:
    """Feature id -> its item: the earliest horizon, then the lowest key (cut and draft items
    never: a draft is not ranked yet)."""
    out: dict[str, service.Entry] = {}

    def key(e: service.Entry) -> tuple:
        h = e.row.horizon
        return (HORIZONS.index(h) if h in HORIZONS else len(HORIZONS), e.row.item_key)

    for e in read_.entries:
        if e.row.feature_id is None or e.status == "cut" or e.row.draft:
            continue
        fid = str(e.row.feature_id)
        if fid not in out or key(e) < key(out[fid]):
            out[fid] = e
    return out


def _goal(f: RankedFeature, e: service.Entry | None) -> SimplePriorityGoal | None:
    if e is not None and e.goal is not None:
        return SimplePriorityGoal(key=e.goal.key, title=e.goal.title)
    if f.explanation.goals:
        g = f.explanation.goals[0]
        return SimplePriorityGoal(key=g.goal, title=g.title)
    return None


def _value(f: RankedFeature, name: str) -> Any:
    v = f.explanation.inputs.get(name)
    return v.get("value") if isinstance(v, dict) else None


def _after(rows: list[SimplePriorityRow], deps: dict[str, list[str]]) -> None:
    """A row scored above some row ranked above it waits for a dependency: name the nearest
    one above it among what it needs (transitively)."""
    position = {r.feature_id: i for i, r in enumerate(rows)}
    for i, r in enumerate(rows):
        if r.score is None or not any(o.score is not None and o.score < r.score for o in rows[:i]):
            continue
        seen: set[str] = set()
        todo = list(deps.get(r.feature_id, []))
        while todo:
            d = todo.pop()
            if d not in seen:
                seen.add(d)
                todo.extend(deps.get(d, []))
        above = [d for d in seen if d in position and position[d] < i]
        if above:
            nearest = rows[max(position[d] for d in above)]
            r.after = SimplePriorityAfter(code=nearest.code, title=nearest.title)


async def _proposals(
    db: AsyncSession, principal: Any, by_id: dict[uuid.UUID, service.Entry]
) -> list[SimplePriorityProposal]:
    rows = list(
        await db.scalars(
            select(SimpleChange)
            .where(
                SimpleChange.status == "proposed",
                SimpleChange.op.in_(PROPOSED_OPS + DRAFT_OPS),
            )
            .order_by(SimpleChange.at, SimpleChange.id)
        )
    )
    if not rows:
        return []
    v = await changes._view(db, principal, rows)
    shown = []
    for c in rows:
        try:
            e = by_id.get(uuid.UUID(str(c.target.get("item_id"))))
        except ValueError:
            e = None
        if e is not None and (c.op in PROPOSED_OPS or e.row.draft) and v.sees(c):
            shown.append((c, e))
    from oracle.simple import visuals

    by_change = await visuals.flows_for(db, "change", [c.id for c, _ in shown])
    by_item = await visuals.flows_for(db, "feature", [e.row.id for _, e in shown])
    names = await changes._names(db, {c.by for c, _ in shown} | {
        p for c, _ in shown for p in v.route(c)
    })  # fmt: skip
    return [
        SimplePriorityProposal(
            change_id=c.id,
            op=c.op,
            item_id=e.row.id,
            feature_id=str(e.row.feature_id) if e.row.feature_id is not None else None,
            code=e.row.item_key,  # type: ignore[arg-type]
            title=e.row.title,
            by_name=names.get(c.by, "someone"),
            at=c.at,
            reason=c.reason,
            after=c.after,
            waiting_for=[names.get(p, "someone") for p in v.route(c)],
            can_decide=v.may_decide(c),
            can_withdraw=c.by == getattr(principal, "user_id", None),
            flow=by_change.get(c.id) or by_item.get(e.row.id),
        )  # fmt: skip
        for c, e in shown
    ]


def _drafts(read_: service.Read, principal: Any) -> list[SimplePriorityDraft]:
    out = []
    live = [e for e in read_.entries if e.status not in ("cut", "merged")]
    for e in live:
        if not e.row.draft:
            continue
        goal = e.goal.id if e.goal is not None else None
        cands = sorted(
            (o for o in live if o.roadmap.id == e.roadmap.id and not o.row.draft),
            key=lambda o: (
                not (goal is not None and o.goal is not None and o.goal.id == goal),
                o.row.position,
                o.row.item_key,
            ),
        )[:MERGE_MAX]
        out.append(
            SimplePriorityDraft(
                item_id=e.row.id,
                code=e.row.item_key,
                title=e.row.title,
                goal=SimplePriorityGoal(key=e.goal.key, title=e.goal.title) if e.goal else None,
                roadmap=service._ref(e.roadmap),  # type: ignore[arg-type]
                applies=service.can_decide(principal, e, read_.deciders),
                merge_into=[
                    SimplePriorityMerge(item_id=o.row.id, code=o.row.item_key, title=o.row.title)
                    for o in cands
                ],
            )  # fmt: skip
        )
    return out


FEATURE_CODE = re.compile(r"[A-Z]{1,3}-\d+")


def _initials(key: str) -> str:
    """Initials of up to three words of ``key``; a one-word key's first two letters."""
    words = re.findall(r"[a-z]+", key.lower())
    if len(words) >= 2:
        return "".join(w[0] for w in words[:3]).upper()
    return ((words[0] if words else "") + "xx")[:2].upper()


PRD_SECTION_CODE = re.compile(r"([a-z]{1,3})-(\d+)", re.IGNORECASE)


def prd_code(section_key: str | None) -> str | None:
    """The PRD's own code of a section an item was imported from ("f-06" -> "F-06"); None
    for a section key that is no code ("problem", "goals")."""
    m = PRD_SECTION_CODE.fullmatch((section_key or "").strip())
    return f"{m.group(1).upper()}-{m.group(2)}" if m else None


def short_codes(keys: list[str], prd: dict[str, str] | None = None) -> list[str]:
    """Each feature's short code, for feature keys in the features' creation order: the key
    when it is a code (F-12), else the PRD code of the section its roadmap item was imported
    from (``prd``: "F-06"), else its initials, a digit added on a clash (DI, DI2) in creation
    order. From the feature alone, never the item a reader sees, nor the key's order or the
    rank: every reader reads the same code, and a new feature never renames an older one."""
    prd = prd or {}
    out: list[str | None] = [None] * len(keys)
    taken: set[str] = set()
    # Codes (the key's own, else the PRD's) in creation order: the older feature keeps a
    # code; a later one that would read the same reads it with a digit (F-06.2).
    for i, k in enumerate(keys):
        own = k if FEATURE_CODE.fullmatch(k) else prd.get(k)
        if own is None:
            continue
        if own in taken and not FEATURE_CODE.fullmatch(k):
            continue  # a PRD code already taken: initials below
        code, n = own, 1
        while code in taken:
            n += 1
            code = f"{own}.{n}"
        out[i] = code
        taken.add(code)
    for i, k in enumerate(keys):
        if out[i] is not None:
            continue
        base = _initials(k)
        code, n = base, 1
        while code in taken:
            n += 1
            code = f"{base}{n}"
        taken.add(code)
        out[i] = code
    return out  # type: ignore[return-value]


async def _short_codes(db: AsyncSession) -> dict[str, str]:
    """Every feature's short code by its key, over all the company's features (dropped ones
    keep theirs, so no code moves when one goes). A feature whose roadmap item came from a
    PRD section with a code ("f-06") reads as the PRD names it (F-06)."""
    rows = (
        await db.execute(
            select(Entity.id, Entity.key)
            .where(Entity.type == "feature")
            .order_by(Entity.created_at, Entity.key)
        )
    ).all()
    keys = [k for _, k in rows]
    key_of = {i: k for i, k in rows}
    prd: dict[str, str] = {}
    for fid, section in await db.execute(
        select(RoadmapItem.feature_id, RoadmapItem.prd_section_key)
        .where(
            RoadmapItem.feature_id.is_not(None),
            RoadmapItem.prd_section_key.is_not(None),
            # Published roadmaps only: a draft's code is not every reader's.
            RoadmapItem.roadmap_version_id.is_not(None),
        )
        .order_by(RoadmapItem.created_at)
    ):
        code = prd_code(section)
        if code and fid in key_of:
            prd.setdefault(key_of[fid], code)
    return dict(zip(keys, short_codes(keys, prd), strict=True))


def _buckets(
    rows: list[SimplePriorityRow], inside: set[uuid.UUID] | None = None
) -> tuple[list[SimpleGoalBucket], float]:
    """Engineer-weeks per goal this quarter: the plan's items in its span (``inside``), else
    the Now horizon's."""
    goals: dict[str, SimpleGoalBucket] = {}
    none: SimpleGoalBucket | None = None
    for r in rows:
        if r.goal is None:
            if none is None:
                none = SimpleGoalBucket(key=NONE, title="No goal", weeks=0, share=0, codes=[],
                                        no_goal=True)  # fmt: skip
            b = none
        else:
            if r.goal.key not in goals:
                goals[r.goal.key] = SimpleGoalBucket(
                    key=r.goal.key, title=r.goal.title, weeks=0, share=0, codes=[]
                )
            b = goals[r.goal.key]
        if (r.item_id in inside) if inside is not None else r.horizon == "now":
            b.weeks += r.effort or 0
            b.codes.append(r.code)
    out = [goals[k] for k in sorted(goals)] + ([none] if none is not None else [])
    total = round(sum(b.weeks for b in out), 3)
    for b in out:
        b.weeks = round(b.weeks, 3)
        b.share = round(b.weeks / total, 3) if total else 0
    return out, total


def _day(d: date) -> str:
    return f"{d:%b} {d.day}, {d.year}"


NOW_LINE = SimpleLine(key="now", kind="now", label="This quarter (Now)")


async def lines(db: AsyncSession, principal: Any, read_: service.Read) -> list[SimpleLine]:
    """The lines offered: Now, each key date and each dated milestone the reader sees."""
    docs = {e.roadmap.id: e.roadmap for e in read_.entries}
    kds, _ = await key_dates.roadmap_key_dates(db, principal, docs)
    tracks = {e.track.id for e in read_.entries if e.track is not None}
    out = [NOW_LINE]
    out += [
        SimpleLine(
            key=f"key_date:{k.id}", kind="key_date", label=f"{k.name} · {_day(k.date)}", date=k.date
        )  # fmt: skip
        for k in kds
    ]
    out += [
        SimpleLine(
            key=f"milestone:{m.id}",
            kind="milestone",
            label=f"{m.name} · {_day(m.target_date)}",
            date=m.target_date,
        )  # fmt: skip
        for m in read_.milestones
        if m.target_date is not None and m.track_id in tracks and m.status != "dropped"
    ]
    # Key dates and milestones in date order, one list (Now first).
    return [out[0], *sorted(out[1:], key=lambda x: x.date or date.max)]


# A picked day earlier than this is a half-typed one (year 1, 20, 202), never a line.
FIRST_LINE_YEAR = 2000


def pick_line(key: str | None, offered: list[SimpleLine]) -> SimpleLine:
    """The line ``key`` names among those offered, or a picked day; else Now."""
    if key and key.startswith("date:"):
        try:
            day = date.fromisoformat(key[5:])
        except ValueError:
            return NOW_LINE
        if day.year < FIRST_LINE_YEAR:
            return NOW_LINE
        return SimpleLine(key=f"date:{day.isoformat()}", kind="date", label=f"By {_day(day)}",
                          date=day)  # fmt: skip
    return next((x for x in offered if x.key == key), NOW_LINE)


def above(e: service.Entry | None, line: SimpleLine) -> bool:
    if e is None:
        return False
    if line.date is None:
        return e.row.horizon == "now"
    return e.resolved.end.date <= line.date


async def build(
    db: AsyncSession, principal: Any, line_key: str | None = None
) -> SimplePrioritiesOut:
    ranking = await priorities.compute(db, METHOD, principal, overrides=True)
    read_ = await service.load(db, await drafts.overlays_for(db, principal))
    items = _items(read_)
    offered = await lines(db, principal, read_)
    line = pick_line(line_key, offered)
    active = {str(o.id): o for o in await priorities.active_overrides(db)}
    by_feature = {str(o.feature_id): o for o in active.values()}
    names = await changes._names(db, {o.created_by for o in active.values()})
    can_change = has_role(principal.role, "commenter")
    code_of = {
        f.key: (items[f.entity_id].row.item_key if f.entity_id in items else f.key)
        for f in ranking.features
    }
    id_of = {f.key: f.entity_id for f in ranking.features}
    rows: list[SimplePriorityRow] = []
    deps: dict[str, list[str]] = {}
    prd_of: list[str | None] = []
    for f in ranking.features:
        e = items.get(f.entity_id)
        deps[f.entity_id] = [id_of[d] for d in f.depends_on if d in id_of]
        gv = f.explanation.inputs.get("goal_value")
        prd_of.append(str(e.prd.id) if e is not None and e.prd is not None else None)
        o = active.get(f.override.id) if f.override is not None else None
        rows.append(
            SimplePriorityRow(
                rank=f.rank,
                oracle_rank=f.formula_rank,
                feature_id=f.entity_id,
                item_id=e.row.id if e is not None else None,
                code=e.row.item_key if e is not None else f.key,
                title=e.row.title if e is not None else f.title,
                goal=_goal(f, e),
                milestone=e.milestone.name if e is not None and e.milestone is not None else None,
                horizon=e.row.horizon if e is not None else None,  # type: ignore[arg-type]
                goal_value=_value(f, "goal_value"),
                effort=_value(f, "effort"),
                score=f.score,
                confidence=round(f.explanation.confidence.value, 2),
                value_estimated=bool(isinstance(gv, dict) and gv.get("estimated")),
                depends_on=[code_of[d] for d in f.depends_on if d in code_of],
                override=SimplePriorityOverride(
                    by_name=names.get(o.created_by, f.override.by) if o else f.override.by,
                    reason=f.override.reason,
                    at=f.override.created_at,
                )
                if f.override is not None
                else None,
                above_line=above(e, line),
                end_date=e.resolved.end.date if e is not None else None,
                end_estimated=e is not None and e.resolved.end.estimated,
                no_goal=not f.serves_goal,
                can_reorder=can_change and e is not None,
                applies=e is not None and service.can_decide(principal, e, read_.deciders),
                before_override=targets._snap(by_feature.get(f.entity_id)),
            )
        )
    short = await _short_codes(db)
    for f, r in zip(ranking.features, rows, strict=True):
        r.short_code = short.get(f.key, f.key)
    _after(rows, deps)
    this_quarter, inside = await plan_quarter(db, read_)
    buckets, total = _buckets(rows, inside)
    _, plan_out = await plan_in_play(db, read_)
    if plan_out is not None:
        for r, pid in zip(rows, prd_of, strict=True):
            r.in_plan = pid == str(plan_out.prd.id)
    return SimplePrioritiesOut(
        today=read_.today,
        quarter=this_quarter,
        plan=plan_out,
        method=METHOD,
        formula=ranking.formula,
        rows=rows,
        proposals=await _proposals(db, principal, read_.by_id()),
        drafts=_drafts(read_, principal),
        buckets=buckets,
        weeks_total=total,
        can_change=can_change,
        line=line,
        lines=offered,
    )


@router.get("/priorities", response_model=SimplePrioritiesOut, name="get_simple_priorities")
async def get_simple_priorities(
    principal: Reader, db: TenantDB, line: Annotated[str | None, Query(max_length=80)] = None
) -> SimplePrioritiesOut:
    """The live goal-weighted ranking in the company's order joined with the roadmap items
    the caller sees: each row's Oracle rank, goal, horizon, goal value (a person's estimate
    or the goals'), effort, score, the dependency it waits for, the override that placed it
    and whether the caller's change applies or is proposed; the open priority and estimate
    proposals, the draft items with what they may merge into, and this quarter's
    engineer-weeks per goal. ``line``: where the line is drawn (Now, a key date, a dated
    milestone or a day; see the module)."""
    return await build(db, principal, line)
