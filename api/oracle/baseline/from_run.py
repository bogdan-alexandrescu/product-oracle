"""What a run wrote to the baseline, for a person to review (B2 Baseline review from this
run).

A run's rows are every entity it created (``entities.run_id``), changed
(``entity_revisions.run_id``) or proposed a change to (``proposals.run_id``), with the edges
it created or changed counted under them. Each row carries the reasons it needs a person,
recomputed on every read (a goal confirmed anywhere clears its reason), in D3's two levels:

- ``goal_undecided`` (blocking, waivable): a goal from the run still proposed. These are the
  approve gate's reasons at Confirm the baseline (:func:`gate_reasons`); Leave proposed is a
  staged ``waive`` of it.
- to confirm (never blocking): ``goal_not_measurable`` (what B5 Typed goal fields'
  ``goal_check`` finds missing), ``low_confidence`` (below
  the company's low threshold), ``no_evidence``, ``serves_no_goal`` (a feature),
  ``changes_your_edit`` (an open proposal of the run on a locked item) and
  ``material_conflict`` (an open material conflict on the item).

A reason is answered by a staged action of the shared draft (D8): a waiver answers the
reasons it names, a look again answers its item's to-confirm reasons (the item goes back to
the agents) but never ``goal_undecided``: as in the approve gate, only a staged waive (Leave
proposed) answers that, so the tally and the Inbox match the gate. A
person's write (confirm, reject, edit: it locks the item) answers the to-confirm reasons of
the item itself; a proposal or a conflict is answered only by deciding it.

Rows come grouped (goals, products, features, the rest); a subgoal (#345) comes right
after its parent goal when the run touched both, and is a goal to decide like any other.

Nothing here writes.
"""

import uuid
from collections import defaultdict
from dataclasses import dataclass, field
from typing import Any

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from oracle import confidence
from oracle.baseline import goals, scoring, service
from oracle.baseline.models import Conflict, Edge, Entity, EntityRevision, Proposal
from oracle.baseline.schemas import EntityOut
from oracle.runs import batch
from oracle.runs.schemas import (
    FromRunEdges,
    FromRunMerge,
    FromRunProposal,
    FromRunRow,
    FromRunSummary,
    ReasonFix,
    ReviewAction,
    RowReason,
)
from oracle.v2.models import DocumentSectionLink

BLOCKING, CONFIRM = "blocking", "confirm"
GOAL_UNDECIDED = "goal_undecided"
# Rows grouped: goals, then products, features, the rest.
GROUP = {"goal": 0, "product": 1, "feature": 2}
# Reasons only deciding the proposal or the conflict answers (not a person's write).
DECIDED_ELSEWHERE = frozenset({"changes_your_edit", "material_conflict"})
ACCEPT_KEEPS_LOCKED = (
    "The run proposes a change to an item a person edited. Accepting applies it, and the "
    "item stays locked against Oracle's changes until a person unlocks it; or reject it."
)

LINKED = "Linked from a PRD section: edit or reject it instead"
LOCKED = "Locked: a person edited it"
NOT_SAME_TYPE = "Only items of the same type can be merged"
NOT_THIS_RUN = "Only items this run created can be merged here"


def item_key(e: Entity) -> str:
    return f"{e.type}:{e.key}"


def _order(ents: dict[uuid.UUID, Entity]) -> list[Entity]:
    """Grouped, by key; a subgoal right after its parent goal when that is a row too."""

    def place(e: Entity) -> tuple[int, str, str, int, str]:
        parent = ents.get(e.parent_id) if e.parent_id is not None else None
        if e.type == "goal" and parent is not None and parent.type == "goal":
            return (GROUP["goal"], e.type, parent.key, 1, e.key)
        return (GROUP.get(e.type, 3), e.type, e.key, 0, "")

    return sorted(ents.values(), key=place)


@dataclass
class Members:
    """The run's entities by id, how each came in, and the edges counted under each."""

    entities: dict[uuid.UUID, Entity] = field(default_factory=dict)
    change: dict[uuid.UUID, str] = field(default_factory=dict)
    proposals: dict[uuid.UUID, list[Proposal]] = field(default_factory=lambda: defaultdict(list))
    edges: dict[uuid.UUID, FromRunEdges] = field(default_factory=dict)


async def members(db: AsyncSession, run_id: uuid.UUID) -> Members:
    """One query each: entities by run, revisions by run, proposals by run, the edges.
    Read once per Inbox call (oracle.runs.batch), for every run's stop together."""
    return (await batch.many("from_run_members", [run_id], lambda ids: _members(db, ids)))[run_id]


async def _members(db: AsyncSession, run_ids: list[uuid.UUID]) -> dict[uuid.UUID, Members]:
    """:func:`members` of each of ``run_ids``, in the same five queries for them all."""
    out = {r: Members() for r in run_ids}
    created: dict[uuid.UUID, set[uuid.UUID]] = defaultdict(set)
    for e, r in (
        await db.execute(select(Entity.id, Entity.run_id).where(Entity.run_id.in_(run_ids)))
    ).all():
        created[r].add(e)
    revised: dict[uuid.UUID, list[tuple[uuid.UUID | None, uuid.UUID | None]]] = defaultdict(list)
    for e, g, r in (
        await db.execute(
            select(EntityRevision.entity_id, EntityRevision.edge_id, EntityRevision.run_id).where(
                EntityRevision.run_id.in_(run_ids)
            )
        )
    ).all():
        revised[r].append((e, g))
    for p in await db.scalars(
        select(Proposal)
        .where(
            Proposal.run_id.in_(run_ids),
            Proposal.status != "withdrawn",
            Proposal.entity_id.is_not(None),
        )
        .order_by(Proposal.created_at)
    ):
        out[p.run_id].proposals[p.entity_id].append(p)  # type: ignore[index]
    ids_of = {
        r: created[r] | {e for e, _ in revised[r] if e is not None} | set(out[r].proposals)
        for r in run_ids
    }
    wanted = {i for ids in ids_of.values() for i in ids}
    if not wanted:
        return out
    ents = list(await db.scalars(select(Entity).where(Entity.id.in_(wanted))))
    edge_ids = {r: {g for _, g in revised[r] if g is not None} for r in run_ids}
    edges = list(
        await db.scalars(
            select(Edge).where(
                Edge.run_id.in_([r for r in run_ids if ids_of[r]])
                | Edge.id.in_({g for r in run_ids if ids_of[r] for g in edge_ids[r]})
            )
        )
    )
    for run_id in run_ids:
        found = out[run_id]
        if not ids_of[run_id]:
            continue
        for e in ents:
            if e.id in ids_of[run_id]:
                found.entities[e.id] = e
                found.change[e.id] = (
                    "new"
                    if e.id in created[run_id]
                    else "proposal"
                    if e.id in found.proposals
                    else "changed"
                )
        for edge in edges:
            if edge.run_id != run_id and edge.id not in edge_ids[run_id]:
                continue
            owner = edge.src_id if edge.src_id in found.entities else edge.dst_id
            if owner not in found.entities:
                continue
            counts = found.edges.setdefault(owner, FromRunEdges())
            if edge.run_id == run_id:
                counts.new += 1
            else:
                counts.changed += 1
    return out


async def _scalars(db: AsyncSession, query: Any) -> list[Any]:
    return list(await db.scalars(query))


async def read_ahead(db: AsyncSession, run_ids: list[uuid.UUID]) -> None:
    """In one Inbox call (oracle.runs.batch): every run's members, and their entities'
    evidence, conflicts, goals served and section links, read together for each run's
    :func:`build` and :func:`gate_reasons` to share."""
    if not run_ids:
        return
    found = await batch.many("from_run_members", run_ids, lambda ids: _members(db, ids))
    ids = list({i for m in found.values() for i in m.entities})
    await _evidence(db, ids)
    await _row_reads(db, ids)


async def _evidence(db: AsyncSession, ids: list[uuid.UUID]) -> dict[uuid.UUID, int]:
    return await batch.many(
        "from_run_evidence", ids, lambda keys: service.evidence_counts(db, entity_ids=keys)
    )


async def _row_reads(
    db: AsyncSession, ids: list[uuid.UUID]
) -> tuple[dict[uuid.UUID, list[uuid.UUID]], set[uuid.UUID], set[uuid.UUID]]:
    """(open material conflicts by entity, entities serving a confirmed goal, entities
    linked from a PRD section) of ``ids``."""

    async def conflicts_of(keys: list[uuid.UUID]) -> dict[uuid.UUID, list[uuid.UUID]]:
        out: dict[uuid.UUID, list[uuid.UUID]] = defaultdict(list)
        for c in await db.scalars(
            select(Conflict).where(
                Conflict.entity_id.in_(keys), Conflict.status == "open", Conflict.material
            )
        ):
            out[c.entity_id].append(c.id)  # type: ignore[index]
        return out

    async def served_of(keys: list[uuid.UUID]) -> dict[uuid.UUID, bool]:
        return dict.fromkeys(
            await db.scalars(
                select(Edge.src_id)
                .join(Entity, Entity.id == Edge.dst_id)
                .where(
                    Edge.src_id.in_(keys),
                    Edge.type == "supports",
                    Edge.status != "rejected",
                    Entity.type == "goal",
                    Entity.status == "confirmed",
                )
            ),
            True,
        )

    async def linked_of(keys: list[uuid.UUID]) -> dict[uuid.UUID, bool]:
        return dict.fromkeys(
            await db.scalars(
                select(DocumentSectionLink.entity_id).where(DocumentSectionLink.entity_id.in_(keys))
            ),
            True,
        )

    if not ids:
        return defaultdict(list), set(), set()
    conflicts = await batch.many("from_run_conflicts", ids, conflicts_of)
    served = await batch.many("from_run_served", ids, served_of)
    linked = await batch.many("from_run_linked", ids, linked_of)
    return defaultdict(list, conflicts), set(served), set(linked)


def _reason(e: Entity, code: str, severity: str, label: str, text: str, **kw: Any) -> RowReason:
    return RowReason(
        item=item_key(e), item_title=e.title, code=code, severity=severity, label=label,
        text=text, **kw,
    )  # fmt: skip


def _goal_undecided(e: Entity) -> RowReason:
    return _reason(
        e, GOAL_UNDECIDED, BLOCKING, "Not decided",
        "The run proposed this goal and nobody decided it: confirm it, reject it, or leave it "
        "proposed with a reason.",
        waivable=True,
        fixes=[ReasonFix.model_validate({"label": "Leave proposed",
                                         "action": {"kind": "waive", "item": item_key(e)}})],
    )  # fmt: skip


async def gate_reasons(db: AsyncSession, run_id: uuid.UUID) -> list[dict[str, Any]]:
    """The approve gate's reasons at Confirm the baseline: each goal from the run still
    proposed (D3's reason shape)."""
    found = await members(db, run_id)
    return [
        _goal_undecided(e).model_dump()
        for e in sorted(found.entities.values(), key=lambda e: e.key)
        if e.type == "goal" and e.status == "proposed" and found.change[e.id] != "proposal"
    ]


def _answers(action: ReviewAction, reason: RowReason) -> bool:
    """A staged waiver answers the reasons it names (all when none), and Leave proposed
    (a waiver of ``goal_undecided``) is the person's call on the goal, so it answers its
    to-confirm reasons too; a staged look again answers every reason of its item but
    ``goal_undecided``, which only a waiver answers (as in the approve gate)."""
    if action.state != "staged":
        return False
    if action.kind == "look_again":
        return reason.code != GOAL_UNDECIDED
    if action.kind != "waive":
        return False
    answers = action.answers or []
    return (
        not answers
        or reason.code in answers
        or (GOAL_UNDECIDED in answers and reason.severity == CONFIRM)
    )


@dataclass
class Built:
    rows: list[FromRunRow]
    summary: FromRunSummary
    other_proposed_goals: list[EntityOut]


async def build(db: AsyncSession, run_id: uuid.UUID, actions: list[ReviewAction]) -> Built:
    """The run's rows with their reasons, the shared draft's ``actions`` on each key, its
    state, whether Merge into… is allowed, and the summary."""
    found = await members(db, run_id)
    ents = found.entities
    ids = list(ents)
    weights = await batch.once("company_weights", lambda: scoring.company_weights(db))
    low = float(confidence.merged(weights)["low"])
    counts = await _evidence(db, ids)
    conflicts, served, linked = await _row_reads(db, ids)
    by_key: dict[str, list[ReviewAction]] = defaultdict(list)
    for a in actions:
        by_key[a.item_key].append(a)

    summary = FromRunSummary()
    rows: list[FromRunRow] = []
    for e in _order(ents):
        key = item_key(e)
        open_proposals = [p for p in found.proposals.get(e.id, []) if p.status == "open"]
        reasons: list[RowReason] = []
        # A row the run only proposed a change to is about the proposal, not the item.
        own = found.change[e.id] != "proposal"
        if e.status != "rejected" and own:
            if e.type == "goal" and e.status == "proposed":
                reasons.append(_goal_undecided(e))
            if e.type == "goal":
                missing = goals.goal_check(e.attrs or {}, status=e.status)["missing"]
                if missing:
                    reasons.append(_reason(
                        e, "goal_not_measurable", CONFIRM, "Not measurable",
                        "The goal is not measurable yet: it may be confirmed and stays flagged.",
                        detail=f"Missing: {goals.missing_words(missing)}",
                    ))  # fmt: skip
            if e.confidence is not None and float(e.confidence) < low:
                score = round(float(e.confidence) * 100)
                reasons.append(_reason(
                    e, "low_confidence", CONFIRM, f"Low confidence {score}",
                    f"Its evidence scores {score}, below the company's low threshold.",
                ))  # fmt: skip
            if not counts.get(e.id):
                reasons.append(_reason(
                    e, "no_evidence", CONFIRM, "No evidence", "Nothing cites it yet.",
                ))  # fmt: skip
            if e.type == "feature" and e.id not in served:
                reasons.append(_reason(
                    e, "serves_no_goal", CONFIRM, "Serves no goal",
                    "No supports link to a confirmed goal.",
                ))  # fmt: skip
        if e.status != "rejected":
            if open_proposals and e.locked:
                reasons.append(_reason(
                    e, "changes_your_edit", CONFIRM, "Changes a locked item",
                    ACCEPT_KEEPS_LOCKED,
                ))  # fmt: skip
            if conflicts.get(e.id):
                reasons.append(_reason(
                    e, "material_conflict", CONFIRM, "Sources disagree",
                    "Sources disagree on a field that changes a decision: pick a side.",
                ))  # fmt: skip
        mine = by_key.get(key, [])
        open_reasons = [
            r
            for r in reasons
            if not any(_answers(a, r) for a in mine)
            and not (e.locked and r.severity == CONFIRM and r.code not in DECIDED_ELSEWHERE)
        ]
        if open_reasons:
            state = "needs_you"
        elif reasons or e.locked or any(a.state == "staged" for a in mine):
            state = "handled"
        else:
            state = "fine"
        undecided = any(r.code == GOAL_UNDECIDED for r in open_reasons)
        summary.items += 1
        summary.need_you += state == "needs_you"
        summary.handled += state == "handled"
        summary.not_decided += undecided
        summary.left_proposed += (
            e.type == "goal"
            and e.status == "proposed"
            and not undecided
            and any(a.kind == "waive" and a.state == "staged" for a in mine)
        )
        why_not = None
        if e.run_id != run_id:
            why_not = NOT_THIS_RUN
        elif e.locked:
            why_not = LOCKED
        elif e.id in linked:
            why_not = LINKED
        rows.append(
            FromRunRow(
                key=key,
                entity=EntityOut.model_validate(e).model_copy(
                    update={"evidence_count": counts.get(e.id, 0)}
                ),
                change=found.change[e.id],  # type: ignore[arg-type]
                proposal_ids=[p.id for p in open_proposals],
                proposals=[
                    FromRunProposal(id=p.id, status=p.status) for p in found.proposals.get(e.id, [])
                ],
                conflict_ids=conflicts.get(e.id, []),
                edges=found.edges.get(e.id, FromRunEdges()),
                reasons=reasons,
                actions=mine,
                state=state,  # type: ignore[arg-type]
                merge=FromRunMerge(allowed=why_not is None, why_not=why_not),
            )
        )
    # The company's proposed goals, read once per Inbox call (oracle.runs.batch).
    proposed = await batch.once(
        "from_run_proposed_goals",
        lambda: _scalars(
            db,
            select(Entity)
            .where(Entity.type == "goal", Entity.status == "proposed")
            .order_by(Entity.key),
        ),
    )
    others = [e for e in proposed if e.id not in ents]
    other_counts = await _evidence(db, [e.id for e in others])
    summary.other_proposed_goals = len(others)
    return Built(
        rows=rows,
        summary=summary,
        other_proposed_goals=[
            EntityOut.model_validate(e).model_copy(
                update={"evidence_count": other_counts.get(e.id, 0)}
            )
            for e in others
        ],
    )


def row_tally(rows: list[FromRunRow]) -> dict[str, int]:
    """The Inbox row's counts (D9's summary): rows needing a person, goals not decided,
    rows needing a person for to-confirm reasons only, rows handled."""
    blocking = to_confirm = 0
    for r in rows:
        if r.state != "needs_you":
            continue
        undecided = any(
            x.code == GOAL_UNDECIDED and not any(_answers(a, x) for a in r.actions)
            for x in r.reasons
        )
        blocking += undecided
        to_confirm += not undecided
    return {
        "need_you": sum(r.state == "needs_you" for r in rows),
        "blocking": blocking,
        "to_confirm": to_confirm,
        "handled": sum(r.state == "handled" for r in rows),
    }
