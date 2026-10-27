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

Changes go through the change engine (``/v1/simple/changes``): ``override_priority`` (with
each row's ``before_override``), ``estimate_feature`` and ``confirm_item``. It writes
nothing.
"""

import uuid
from datetime import date
from typing import Any

from fastapi import APIRouter
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from oracle.auth.deps import TenantDB
from oracle.authz import has_role
from oracle.priorities import service as priorities
from oracle.priorities.schemas import RankedFeature
from oracle.roadmap.models import HORIZONS
from oracle.simple import changes, drafts, service, targets
from oracle.simple.models import SimpleChange
from oracle.simple.router import Reader
from oracle.simple.schemas import (
    SimpleGoalBucket,
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
            flow=None,
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


def _buckets(rows: list[SimplePriorityRow]) -> tuple[list[SimpleGoalBucket], float]:
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
        if r.horizon == "now":
            b.weeks += r.effort or 0
            b.codes.append(r.code)
    out = [goals[k] for k in sorted(goals)] + ([none] if none is not None else [])
    total = round(sum(b.weeks for b in out), 3)
    for b in out:
        b.weeks = round(b.weeks, 3)
        b.share = round(b.weeks / total, 3) if total else 0
    return out, total


async def build(db: AsyncSession, principal: Any) -> SimplePrioritiesOut:
    ranking = await priorities.compute(db, METHOD, principal, overrides=True)
    read_ = await service.load(db, await drafts.overlays_for(db, principal))
    items = _items(read_)
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
    for f in ranking.features:
        e = items.get(f.entity_id)
        deps[f.entity_id] = [id_of[d] for d in f.depends_on if d in id_of]
        gv = f.explanation.inputs.get("goal_value")
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
                value_estimated=bool(isinstance(gv, dict) and gv.get("estimated")),
                depends_on=[code_of[d] for d in f.depends_on if d in code_of],
                override=SimplePriorityOverride(
                    by_name=names.get(o.created_by, f.override.by) if o else f.override.by,
                    reason=f.override.reason,
                    at=f.override.created_at,
                )
                if f.override is not None
                else None,
                above_line=e is not None and e.row.horizon == "now",
                no_goal=not f.serves_goal,
                can_reorder=can_change and e is not None,
                applies=e is not None and service.can_decide(principal, e, read_.deciders),
                before_override=targets._snap(by_feature.get(f.entity_id)),
            )
        )
    _after(rows, deps)
    buckets, total = _buckets(rows)
    return SimplePrioritiesOut(
        today=read_.today,
        quarter=quarter(read_.today),
        method=METHOD,
        formula=ranking.formula,
        rows=rows,
        proposals=await _proposals(db, principal, read_.by_id()),
        drafts=_drafts(read_, principal),
        buckets=buckets,
        weeks_total=total,
        can_change=can_change,
    )


@router.get("/priorities", response_model=SimplePrioritiesOut, name="get_simple_priorities")
async def get_simple_priorities(principal: Reader, db: TenantDB) -> SimplePrioritiesOut:
    """The live goal-weighted ranking in the company's order joined with the roadmap items
    the caller sees: each row's Oracle rank, goal, horizon, goal value (a person's estimate
    or the goals'), effort, score, the dependency it waits for, the override that placed it
    and whether the caller's change applies or is proposed; the open priority and estimate
    proposals, the draft items with what they may merge into, and this quarter's
    engineer-weeks per goal."""
    return await build(db, principal)
