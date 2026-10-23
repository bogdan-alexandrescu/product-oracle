"""Graph writes: entities and edges, locks, revisions and proposals.

Every write carries a :class:`Writer`. A ``user`` write (a person, or an API token
acting as one) applies and locks the item; an ``agent`` or ``import`` write applies
to an unlocked item but becomes a proposal on a locked one (B1: agents must ask
before overriding a user correction). Every applied change writes an
``entity_revisions`` row with the fields before and after.

Some attrs keys belong to a module with its own rules (:data:`MANAGED_ATTRS`): only a
writer that names the key in ``manages`` may set, change or remove it. Every other
path (PATCH, POST, proposals and their acceptance, agent writes, YAML imports,
conflict resolution) is refused, so a blocker's strategy cannot be weakened around
its recorded decisions. Likewise, archiving (rejecting) or deleting a constraint whose
blocker still gates publishing takes the B4 role on every path
(:func:`_check_archivable`).

The caller commits.
"""

import uuid
from collections.abc import AsyncIterator, Iterable
from contextlib import asynccontextmanager
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Any, Literal

from sqlalchemy import func, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from oracle import audit, changes
from oracle.auth.deps import Principal
from oracle.baseline import goals, scoring
from oracle.baseline.models import (
    EDGE_TYPES,
    ENTITY_TYPES,
    NODE_STATUSES,
    Edge,
    Entity,
    EntityRevision,
    Evidence,
    Proposal,
)
from oracle.baseline.schemas import ProposalRun
from oracle.v2 import links
from oracle.v2.models import DocumentSectionLink

ENTITY_FIELDS = ("title", "body", "attrs", "status", "parent_id")
# attrs keys a module owns, and the routes that change them.
MANAGED_ATTRS = {
    "blocker": "the blocker routes (/v1/blockers)",
    # A decided judgement call's entity (H1): the decision log keeps it in step.
    "decision_id": "the decision log (/v1/decisions)",
}
EDGE_FIELDS = ("attrs", "status")


class BaselineError(Exception):
    status_code = 400


class NotFoundError(BaselineError):
    status_code = 404


class InvalidError(BaselineError):
    status_code = 422


class ConflictError(BaselineError):
    status_code = 409


class ForbiddenError(BaselineError):
    status_code = 403


class GoalFieldsInvalid(InvalidError):
    """A person's goal write with bad typed fields (B5); 422 with every problem."""

    def __init__(self, problems: list[dict[str, str]]):
        self.problems = problems
        super().__init__(f"goal fields rejected: {len(problems)} problem(s)")


@dataclass(frozen=True)
class Writer:
    principal: Principal | None
    origin: str  # user | agent | import
    run_id: uuid.UUID | None = None
    reason: str | None = None
    # MANAGED_ATTRS keys this writer may change (the owning module's writes only).
    manages: tuple[str, ...] = ()
    # Every write becomes a proposal, as if the item were locked (H11: a run's
    # baseline.yaml while the baseline is below Act).
    proposals_only: bool = False

    @property
    def actor(self) -> str:
        if self.principal is not None:
            return self.principal.actor
        return f"run:{self.run_id}" if self.run_id else "system"

    @property
    def locks(self) -> bool:
        return self.origin == "user"

    def must_propose(self, item: "Entity | Edge | None") -> bool:
        """Whether a write to ``item`` (None: a new one) becomes a proposal."""
        if self.locks:
            return False
        return self.proposals_only or (item is not None and item.locked)


@dataclass
class WriteResult:
    entity: Entity | None = None
    edge: Edge | None = None
    proposal: Proposal | None = None
    # Goal fields an agent's or import's write kept as "<key>_text" (B5).
    kept_as_text: tuple[str, ...] = ()

    @property
    def applied(self) -> bool:
        return self.proposal is None


def _now() -> datetime:
    return datetime.now(UTC)


def _jsonable(value: Any) -> Any:
    if isinstance(value, uuid.UUID):
        return str(value)
    if isinstance(value, datetime):
        return value.isoformat()
    if isinstance(value, dict):
        return {k: _jsonable(v) for k, v in value.items()}
    if isinstance(value, list | tuple):
        return [_jsonable(v) for v in value]
    return value


def entity_snapshot(e: Entity) -> dict[str, Any]:
    out = {
        "type": e.type,
        "key": e.key,
        "title": e.title,
        "body": e.body,
        "attrs": dict(e.attrs or {}),
        "status": e.status,
    }
    if e.parent_id is not None:
        out["parent_id"] = e.parent_id
    return _jsonable(out)


def edge_snapshot(e: Edge) -> dict[str, Any]:
    return _jsonable(
        {
            "src_id": e.src_id,
            "dst_id": e.dst_id,
            "type": e.type,
            "attrs": dict(e.attrs or {}),
            "status": e.status,
        }
    )


def lock(item: Entity | Edge, writer: Writer) -> None:
    if writer.locks:
        item.locked = True
        item.locked_by = writer.principal.id if writer.principal else None
        item.locked_at = _now()


def _revision(
    db: AsyncSession,
    writer: Writer,
    before: dict | None,
    after: dict | None,
    *,
    entity: Entity | None = None,
    edge: Edge | None = None,
) -> None:
    db.add(
        EntityRevision(
            entity_id=entity.id if entity else None,
            edge_id=edge.id if edge else None,
            before=before,
            after=after,
            actor=writer.actor,
            reason=writer.reason,
            run_id=writer.run_id,
        )
    )


def merge_attrs(current: dict[str, Any], patch: dict[str, Any]) -> dict[str, Any]:
    """``patch`` merged into ``current``; a None value removes the key."""
    out = dict(current or {})
    for k, v in patch.items():
        if v is None:
            out.pop(k, None)
        else:
            out[k] = v
    return out


# --- lookups --------------------------------------------------------------------------


async def get_entity(db: AsyncSession, entity_id: uuid.UUID) -> Entity:
    entity = await db.get(Entity, entity_id)
    if entity is None:
        raise NotFoundError("Entity not found")
    return entity


async def get_edge(db: AsyncSession, edge_id: uuid.UUID) -> Edge:
    edge = await db.get(Edge, edge_id)
    if edge is None:
        raise NotFoundError("Edge not found")
    return edge


async def find_entity(db: AsyncSession, type_: str, key: str) -> Entity | None:
    return await db.scalar(select(Entity).where(Entity.type == type_, Entity.key == key))


async def find_edge(
    db: AsyncSession, src_id: uuid.UUID, dst_id: uuid.UUID, type_: str
) -> Edge | None:
    return await db.scalar(
        select(Edge).where(Edge.src_id == src_id, Edge.dst_id == dst_id, Edge.type == type_)
    )


async def evidence_counts(
    db: AsyncSession, *, entity_ids: list[uuid.UUID] = (), edge_ids: list[uuid.UUID] = ()
) -> dict[uuid.UUID, int]:
    out: dict[uuid.UUID, int] = {}
    if entity_ids:
        rows = await db.execute(
            select(Evidence.entity_id, func.count())
            .where(Evidence.entity_id.in_(list(entity_ids)))
            .group_by(Evidence.entity_id)
        )
        out.update({k: n for k, n in rows.all()})
    if edge_ids:
        rows = await db.execute(
            select(Evidence.edge_id, func.count())
            .where(Evidence.edge_id.in_(list(edge_ids)))
            .group_by(Evidence.edge_id)
        )
        out.update({k: n for k, n in rows.all()})
    return out


# --- validation --------------------------------------------------------------------------


def check_managed_attrs(
    writer: Writer, before: dict[str, Any] | None, after: dict[str, Any] | None
) -> None:
    """Refuse a change to a managed attrs key by a writer that does not manage it."""
    before, after = before or {}, after or {}
    for key, where in MANAGED_ATTRS.items():
        if key in writer.manages:
            continue
        if before.get(key) != after.get(key):
            raise InvalidError(
                f"attrs.{key} cannot be set, changed or removed here; change it through {where}"
            )


def _check_fields_managed_attrs(
    writer: Writer, entity: Entity | None, fields: dict[str, Any]
) -> None:
    """The managed-attrs rule for a proposal's entity fields (create or update)."""
    attrs = fields.get("attrs")
    if not isinstance(attrs, dict):
        return
    current = dict(entity.attrs or {}) if entity is not None else {}
    check_managed_attrs(writer, current, merge_attrs(current, attrs))


async def _check_archivable(
    db: AsyncSession, principal: Principal | None, entity: Entity, verb: str
) -> None:
    """B4: a blocker that still gates publishing is archived or deleted by an owner (the
    company's ``blocker_risk_acceptance_role``) only; the blocker module decides."""
    if entity.type != "constraint":
        return
    from oracle.blockers import service as blockers  # imports this module

    try:
        await blockers.require_archiver(db, principal, entity, verb)
    except blockers.ForbiddenError as e:
        raise ForbiddenError(str(e)) from None


def _check_status(status: str | None) -> None:
    if status is not None and status not in NODE_STATUSES:
        raise InvalidError(f"status must be one of {', '.join(NODE_STATUSES)}")


def _check_edge_attrs(type_: str, attrs: dict[str, Any]) -> None:
    if type_ != "supports":
        return
    c = attrs.get("contribution")
    if not isinstance(c, int) or isinstance(c, bool) or not 0 <= c <= 3:
        raise InvalidError("a supports edge needs attrs.contribution, an integer 0-3")


async def check_parent(
    db: AsyncSession, type_: str, parent_id: uuid.UUID | None, entity: Entity | None = None
) -> None:
    """#345: a subgoal's parent is a live goal that is not a subgoal itself (one level), and
    a goal with subgoals does not become one; so no goal is ever its own ancestor."""
    if parent_id is None:
        return
    if type_ != "goal":
        raise InvalidError("only a goal has a parent goal")
    if entity is not None and parent_id == entity.id:
        raise InvalidError("a goal cannot be its own parent (a cycle)")
    parent = await db.get(Entity, parent_id)
    if parent is None or parent.type != "goal":
        raise InvalidError("the parent must be a goal")
    if parent.status == "rejected":
        raise InvalidError("the parent goal is archived")
    if entity is not None and parent.parent_id == entity.id:
        raise InvalidError("the parent is a subgoal of this goal (a cycle)")
    if parent.parent_id is not None:
        raise InvalidError("the parent is a subgoal itself; subgoals are one level deep")
    if entity is not None and await db.scalar(
        select(Entity.id).where(Entity.parent_id == entity.id).limit(1)
    ):
        raise InvalidError("a goal with subgoals cannot become a subgoal")


def _initial_status(type_: str, status: str | None, writer: Writer) -> str:
    _check_status(status)
    if type_ == "goal":
        # B2: goals are proposed, then confirmed by an approver (POST .../confirm).
        if status == "confirmed":
            raise InvalidError("goals start proposed; confirm them with POST .../confirm")
        return status or "proposed"
    return status or ("confirmed" if writer.locks else "proposed")


async def check_goal_attrs(
    db: AsyncSession, attrs: dict[str, Any], before: dict[str, Any] | None = None
) -> None:
    """B5: refuse bad typed goal fields (a person's write, a proposal). ``before`` is the
    goal's attrs on an update: a problem it already had is refused only when touched."""
    try:
        await goals.check(db, attrs, before=before)
    except goals.GoalFieldsError as e:
        raise GoalFieldsInvalid(e.problems) from None


async def _goal_attrs(
    db: AsyncSession, writer: Writer, attrs: dict[str, Any], before: dict[str, Any] | None = None
) -> tuple[dict[str, Any], tuple[str, ...]]:
    """A goal's attrs as written: a person's are checked (422); an agent's or an
    import's keep a refused value as ``<key>_text`` instead."""
    if writer.locks:
        await check_goal_attrs(db, attrs, before)
        return attrs, ()
    kept, moved = await goals.keep_as_text(db, attrs)
    return kept, tuple(moved)


# --- proposals ---------------------------------------------------------------------------


async def propose(
    db: AsyncSession,
    writer: Writer,
    *,
    op: str,
    kind: str,
    fields: dict[str, Any],
    entity: Entity | None = None,
    edge: Edge | None = None,
) -> Proposal:
    """A proposal, or the identical open one already there (so repeats are idempotent)."""
    if kind == "entity" and op in ("create", "update"):
        _check_fields_managed_attrs(writer, entity, fields)
    payload = _jsonable(
        {"op": op, "kind": kind, "fields": fields, "reason": writer.reason, "origin": writer.origin}
    )
    stmt = select(Proposal).where(
        Proposal.status == "open",
        Proposal.entity_id == entity.id if entity else Proposal.entity_id.is_(None),
        Proposal.edge_id == edge.id if edge else Proposal.edge_id.is_(None),
    )
    for existing in (await db.scalars(stmt)).all():
        if existing.payload == payload:
            return existing
    proposal = Proposal(
        entity_id=entity.id if entity else None,
        edge_id=edge.id if edge else None,
        payload=payload,
        run_id=writer.run_id,
        actor=writer.actor,
        status="open",
    )
    db.add(proposal)
    await db.flush()
    return proposal


def _question_only_shape(payload: dict[str, Any]) -> bool:
    fields = payload.get("fields") or {}
    attrs = fields.get("attrs") or {}
    return (
        payload.get("origin") == "agent"
        and payload.get("op") == "create"
        and set(attrs) == {"gap_id", "category"}
    )


async def awaits_answer(db: AsyncSession, payload: dict[str, Any]) -> bool:
    """A question-only proposal an intake made of an answer to a finding shared as
    counts (S6): the category's question, the gap's id and category, no answer. It waits
    for the author to share the answer (a follow-up proposal carries it) and is never
    accepted itself: it would make an entity of the question. Told by its shape and by
    the intake gap it names (same id and category): any other proposal of that shape is
    an ordinary one."""
    from oracle.v2.models import KnowledgeGap

    if not _question_only_shape(payload):
        return False
    attrs = payload["fields"]["attrs"]
    try:
        gap_id = uuid.UUID(str(attrs["gap_id"]))
    except ValueError:
        return False
    gap = await db.get(KnowledgeGap, gap_id)
    return gap is not None and gap.intake_id is not None and gap.category == attrs["category"]


async def list_proposals(
    db: AsyncSession,
    status: str | None = None,
    run_id: uuid.UUID | Literal["none"] | None = None,
) -> list[Proposal]:
    """Proposals, newest first; a withdrawn one (its finding lowered back to private,
    S6) is never listed. ``run_id`` keeps one run's, or ``"none"`` those of no run."""
    stmt = (
        select(Proposal).where(Proposal.status != "withdrawn").order_by(Proposal.created_at.desc())
    )
    if status:
        stmt = stmt.where(Proposal.status == status)
    if run_id == "none":
        stmt = stmt.where(Proposal.run_id.is_(None))
    elif run_id is not None:
        stmt = stmt.where(Proposal.run_id == run_id)
    return list((await db.scalars(stmt)).all())


async def proposal_runs(
    db: AsyncSession, run_ids: Iterable[uuid.UUID | None]
) -> dict[uuid.UUID, ProposalRun]:
    """{run id: ProposalRun} for the runs that made these proposals, in one query."""
    from oracle.runs.flows import FLOWS
    from oracle.runs.models import Run

    ids = {i for i in run_ids if i is not None}
    if not ids:
        return {}
    rows = await db.execute(
        select(Run.id, Run.flow, Run.status, Run.created_at).where(Run.id.in_(ids))
    )
    return {
        r.id: ProposalRun(
            id=r.id,
            flow=r.flow,
            flow_title=FLOWS[r.flow].title if r.flow in FLOWS else r.flow,
            status=r.status,
            created_at=r.created_at,
        )
        for r in rows
    }


async def lock_proposal(db: AsyncSession, proposal_id: uuid.UUID) -> Proposal | None:
    """The proposal row, locked FOR UPDATE and read afresh: whoever decides or withdraws
    it holds the lock, so an accept and a withdraw never both win (the second sees what
    the first committed)."""
    return await db.scalar(
        select(Proposal)
        .where(Proposal.id == proposal_id)
        .with_for_update()
        .execution_options(populate_existing=True)
    )


def _snapshot_value(snapshot: dict[str, Any] | None, key: str) -> Any:
    if snapshot is None:
        return None
    if key.startswith("attrs."):
        return (snapshot.get("attrs") or {}).get(key.removeprefix("attrs."))
    return snapshot.get(key)


async def overlaps(db: AsyncSession, proposals: list[Proposal]) -> dict[uuid.UUID, list[dict]]:
    """{proposal id: [overlap]} (#268): the fields an open update would change whose value
    changed since it was written and is neither that value again nor the proposed one.
    ``by`` is "proposal" when the last change was accepting another proposal, else "edit"."""
    from oracle.baseline.describe import _changes, _old, _same

    out: dict[uuid.UUID, list[dict]] = {p.id: [] for p in proposals}
    todo = [
        p for p in proposals
        if p.status == "open" and p.payload.get("op") == "update" and (p.entity_id or p.edge_id)
    ]  # fmt: skip
    if not todo:
        return out
    ids = {p.entity_id or p.edge_id for p in todo}
    since = min(p.created_at for p in todo)
    on_targets = (EntityRevision.entity_id.in_(ids), EntityRevision.edge_id.in_(ids))
    revisions = (
        await db.scalars(
            select(EntityRevision)
            .where(or_(*on_targets), EntityRevision.created_at > since)
            .order_by(EntityRevision.created_at)
        )
    ).all()
    if not revisions:
        return out
    targets: dict[uuid.UUID, Entity | Edge] = {
        **{e.id: e for e in await db.scalars(select(Entity).where(Entity.id.in_(ids)))},
        **{e.id: e for e in await db.scalars(select(Edge).where(Edge.id.in_(ids)))},
    }
    accepted = (
        await db.scalars(
            select(Proposal).where(
                Proposal.status == "accepted",
                or_(Proposal.entity_id.in_(ids), Proposal.edge_id.in_(ids)),
                Proposal.decided_at > since,
            )
        )
    ).all()
    for p in todo:
        tid = p.entity_id or p.edge_id
        mine = [
            r
            for r in revisions
            if (r.entity_id or r.edge_id) == tid and r.created_at > p.created_at
        ]
        for key, proposed in _changes(p.payload.get("fields") or {}):
            changed = [
                r for r in mine
                if _snapshot_value(r.before, key) != _snapshot_value(r.after, key)
            ]  # fmt: skip
            if not changed or tid not in targets:
                continue
            current = _old(targets[tid], key)[1]
            if _same(current, _snapshot_value(changed[0].before, key)) or _same(current, proposed):
                continue
            last = _snapshot_value(changed[-1].after, key)
            by_proposal = any(
                (a.entity_id or a.edge_id) == tid
                and a.decided_at > p.created_at
                and any(
                    k == key and _same(last, v) for k, v in _changes(a.payload.get("fields") or {})
                )
                for a in accepted
            )
            out[p.id].append(
                {
                    "field": key,
                    "current": current,
                    "proposed": proposed,
                    "changed_at": changed[-1].created_at,
                    "by": "proposal" if by_proposal else "edit",
                }
            )
    return out


def _skipped(payload: dict[str, Any], skip_fields: list[str]) -> list[str]:
    """``skip_fields`` as the proposal's keys ("milestone" is "attrs.milestone")."""
    from oracle.baseline.describe import _changes

    if payload.get("op") != "update":
        raise InvalidError("only an update can skip fields")
    changes = {k for k, _ in _changes(payload.get("fields") or {})}
    out = []
    for f in skip_fields:
        key = f if f in ("title", "body", "status") or f.startswith("attrs.") else f"attrs.{f}"
        if key not in changes:
            raise InvalidError(f"this proposal does not change {f}")
        if key not in out:
            out.append(key)
    return out


def _without(fields: dict[str, Any], keys: list[str]) -> dict[str, Any]:
    out = {k: v for k, v in fields.items() if k not in keys}
    if isinstance(fields.get("attrs"), dict):
        attrs = {k: v for k, v in fields["attrs"].items() if f"attrs.{k}" not in keys}
        if attrs:
            out["attrs"] = attrs
        else:
            out.pop("attrs")
    return out


async def decide_proposal(
    db: AsyncSession,
    proposal_id: uuid.UUID,
    principal: Principal,
    accept: bool,
    note: str | None,
    skip_fields: list[str] | None = None,
) -> Proposal:
    """Accept or reject; an accept may keep some fields as they are (``skip_fields``, #268)."""
    proposal = await lock_proposal(db, proposal_id)
    if proposal is None or proposal.status == "withdrawn":
        raise NotFoundError("Proposal not found")
    if proposal.status != "open":
        raise ConflictError(f"Proposal is already {proposal.status}")
    if accept and await awaits_answer(db, proposal.payload):
        raise ConflictError("This proposal waits for the author to share the answer")
    skipped = _skipped(proposal.payload, skip_fields) if accept and skip_fields else []
    # B4: history reads the sentence the decider saw, written from the target before the change.
    from oracle.baseline.describe import summaries

    summary = (await summaries(db, [proposal]))[proposal.id]
    if accept:
        p = proposal.payload
        reason = note or p.get("reason") or f"accepted proposal {proposal.id}"
        writer = Writer(principal, "user", run_id=proposal.run_id, reason=reason)
        fields = _without(dict(p.get("fields") or {}), skipped)
        if p["kind"] == "entity":
            if p["op"] == "create":
                await create_entity(db, writer, **_entity_create_args(fields))
            else:
                target = await get_entity(db, proposal.entity_id or fields.get("id"))
                if p["op"] == "update":
                    await update_entity(db, writer, target, fields)
                else:
                    await _detach(db, proposal)
                    await delete_entity(db, writer, target)
        else:
            if p["op"] == "create":
                await create_edge(db, writer, **_edge_create_args(fields))
            else:
                target = await get_edge(db, proposal.edge_id or fields.get("id"))
                if p["op"] == "update":
                    await update_edge(db, writer, target, fields)
                else:
                    await _detach(db, proposal)
                    await delete_edge(db, writer, target)
    proposal.payload = {**proposal.payload, "summary": summary}
    if skipped:
        proposal.payload = {**proposal.payload, "skipped_fields": skipped}
    proposal.status = "accepted" if accept else "rejected"
    proposal.decided_by = principal.id
    proposal.decided_at = _now()
    await audit.record(
        db,
        principal,
        "baseline.proposal." + proposal.status,
        "proposal",
        proposal.id,
        {k: v for k, v in (("note", note), ("skipped_fields", skipped)) if v} or None,
    )
    if accept:
        # B6: a goals interview's proposal that leaves its goal measurable closes it.
        from oracle.baseline import goal_interview

        await goal_interview.on_proposal_accepted(db, proposal, principal)
    await db.flush()
    return proposal


async def _detach(db: AsyncSession, proposal: Proposal) -> None:
    """An accepted delete proposal outlives its target: the target's foreign key would
    cascade it away mid-decision. The payload keeps which item it was."""
    proposal.payload = {
        **proposal.payload,
        "fields": {**(proposal.payload.get("fields") or {}),
                   "id": str(proposal.entity_id or proposal.edge_id)},
    }  # fmt: skip
    proposal.entity_id = proposal.edge_id = None
    await db.flush()


def _uuid_or_none(value: Any) -> uuid.UUID | None:
    if value is None or isinstance(value, uuid.UUID):
        return value
    try:
        return uuid.UUID(str(value))
    except ValueError:
        raise InvalidError("parent_id must be a goal's id") from None


def _entity_create_args(fields: dict[str, Any]) -> dict[str, Any]:
    try:
        return {
            "type_": fields["type"],
            "key": fields["key"],
            "title": fields["title"],
            "body": fields.get("body"),
            "attrs": fields.get("attrs") or {},
            "status": fields.get("status"),
            "parent_id": _uuid_or_none(fields.get("parent_id")),
        }
    except KeyError as e:
        raise InvalidError(f"proposal is missing entity field {e.args[0]}") from None


def _edge_create_args(fields: dict[str, Any]) -> dict[str, Any]:
    try:
        return {
            "src_id": uuid.UUID(str(fields["src_id"])),
            "dst_id": uuid.UUID(str(fields["dst_id"])),
            "type_": fields["type"],
            "attrs": fields.get("attrs") or {},
            "status": fields.get("status"),
        }
    except (KeyError, ValueError) as e:
        raise InvalidError(f"proposal has a bad edge field: {e}") from None


async def submit_proposal(
    db: AsyncSession,
    writer: Writer,
    *,
    op: str,
    kind: str,
    fields: dict[str, Any],
    entity_id: uuid.UUID | None,
    edge_id: uuid.UUID | None,
) -> Proposal:
    """A proposal made explicitly (POST /proposals), checked against the graph."""
    entity = edge = None
    if op == "create":
        if entity_id or edge_id:
            raise InvalidError("a create proposal has no target")
        (_entity_create_args if kind == "entity" else _edge_create_args)(fields)
        if kind == "entity" and fields["type"] not in ENTITY_TYPES:
            raise InvalidError("unknown entity type")
        if kind == "edge" and fields["type"] not in EDGE_TYPES:
            raise InvalidError("unknown edge type")
    elif kind == "entity":
        if not entity_id or edge_id:
            raise InvalidError("an entity proposal targets entity_id")
        entity = await get_entity(db, entity_id)
    else:
        if not edge_id or entity_id:
            raise InvalidError("an edge proposal targets edge_id")
        edge = await get_edge(db, edge_id)
    attrs = fields.get("attrs")
    is_goal = (entity.type if entity is not None else fields.get("type")) == "goal"
    if kind == "entity" and op in ("create", "update") and is_goal and isinstance(attrs, dict):
        # B5: refused at creation, so an Accept never fails on a field (it re-checks owners).
        await check_goal_attrs(
            db,
            merge_attrs(entity.attrs if entity else {}, attrs),
            dict(entity.attrs or {}) if entity else None,
        )
    return await propose(db, writer, op=op, kind=kind, fields=fields, entity=entity, edge=edge)


def _change_subject(entity: Entity, before: dict[str, Any] | None) -> str | None:
    """The oracle.changes subject a change to ``entity`` is recorded under, or None when
    the blocker routes record it."""
    if entity.type == "requirement":
        return "requirement"
    if entity.type == "decision":
        return "decision"
    if before is not None and entity.type == "constraint":
        after = entity_snapshot(entity)
        old, new = dict(before.get("attrs") or {}), dict(after["attrs"])
        old_blocker, new_blocker = old.pop("blocker", None), new.pop("blocker", None)
        if old_blocker != new_blocker:
            # Only the blocker routes change attrs.blocker (MANAGED_ATTRS). They record
            # their own ``blocker_status`` changes for status, type and severity changes
            # and option selection (oracle.blockers.service._record). Any other strategy
            # field (threshold, timing, documents, impacted entities, scaling...) is not
            # recorded there, so it stays an ``entity`` change here: a duplicate event is
            # harmless, a missing one leaves dependents unmarked.
            rest = {**before, "attrs": old} != {**after, "attrs": new}
            if rest or _strip_route_recorded(old_blocker) != _strip_route_recorded(new_blocker):
                return "entity"
            return None
    return "entity"


# The blocker fields whose changes the blocker routes record themselves.
_ROUTE_RECORDED_BLOCKER_KEYS = ("status", "revision", "type", "severity", "selected_option_id")


def _strip_route_recorded(blocker: Any) -> Any:
    if not isinstance(blocker, dict):
        return blocker
    return {k: v for k, v in blocker.items() if k not in _ROUTE_RECORDED_BLOCKER_KEYS}


# Edge meaning for change propagation (as in oracle.trace.graph): for these types the
# destination is downstream of the source; for the rest (but owned_by) the source is.
DST_DOWNSTREAM_EDGES = ("affects", "blocks", "mitigates")
# A person named as owner is not content: nothing is recorded for it.
UNTRACED_EDGES = ("owned_by",)
# The destination is a whole the source belongs to: it changes when a part comes or goes.
WHOLE_EDGES = ("part_of", "verifies")
REMOVAL_PRIORITY = {"entity_deleted": 2, "entity_rejected": 1}
_BATCH = "baseline.change_batch"


def _entity_ref(entity: Entity) -> dict[str, Any]:
    return _jsonable(
        {"id": entity.id, "type": entity.type, "key": entity.key, "title": entity.title,
         "status": entity.status}
    )  # fmt: skip


async def _record_change(
    db: AsyncSession,
    actor: str,
    entity: Entity,
    before: dict[str, Any] | None,
    cause: str,
    *,
    edge: dict[str, Any] | None = None,
    wholes: list[uuid.UUID] | None = None,
    evidence_ids: list[uuid.UUID] | None = None,
) -> None:
    """v2 hook: what is built on this entity may now be stale (oracle.trace).

    Inside :func:`batched_changes` the change is collected instead (a deletion is
    always recorded at once, while the entity and its edges still exist).
    ``evidence_ids``: the evidence a deletion takes with it."""
    kind = _change_subject(entity, before)
    if kind is None:
        return
    after = entity_snapshot(entity)
    entry = {
        "kind": kind,
        "id": entity.id,
        "ref": f"{entity.type}:{entity.key}",
        "cause": cause,
        "actor": actor,
        "fields": sorted(k for k in after if (before or {}).get(k) != after.get(k)),
        "entity": _entity_ref(entity),
        "edge": edge,
        "wholes": [str(w) for w in wholes or []],
        "evidence_ids": [str(e) for e in evidence_ids or []],
    }
    batch = db.info.get(_BATCH)
    if batch is not None and cause != "entity_deleted":
        _collect(batch, entry)
        return
    await _record_one(db, entry)


def _collect(batch: dict[uuid.UUID, dict[str, Any]], entry: dict[str, Any]) -> None:
    """One entry per entity: fields and wholes merge, a removal outranks an update."""
    seen = batch.get(entry["id"])
    if seen is None:
        batch[entry["id"]] = entry
        return
    seen["fields"] = sorted(set(seen["fields"]) | set(entry["fields"]))
    seen["wholes"] = list(dict.fromkeys(seen["wholes"] + entry["wholes"]))
    seen["evidence_ids"] = list(dict.fromkeys(seen["evidence_ids"] + entry["evidence_ids"]))
    seen["entity"] = entry["entity"]
    if REMOVAL_PRIORITY.get(entry["cause"], 0) > REMOVAL_PRIORITY.get(seen["cause"], 0):
        seen["cause"] = entry["cause"]
    seen["edge"] = seen["edge"] or entry["edge"]


def _data(entry: dict[str, Any]) -> dict[str, Any]:
    data: dict[str, Any] = {"fields": entry["fields"], "entity": entry["entity"]}
    if entry["edge"] is not None:
        data["edge"] = entry["edge"]
    if entry["wholes"]:
        data["wholes"] = entry["wholes"]
    if entry["evidence_ids"]:
        data["evidence_ids"] = entry["evidence_ids"]
    return data


async def _record_one(db: AsyncSession, entry: dict[str, Any]) -> None:
    await changes.record_change(
        db,
        entry["kind"],
        cause=entry["cause"],
        actor=entry["actor"],
        subject_id=entry["id"],
        subject_ref=entry["ref"],
        data=_data(entry),
    )


@asynccontextmanager
async def batched_changes(db: AsyncSession) -> AsyncIterator[None]:
    """Collect the entity and edge changes of a bulk write (a YAML import, a run's
    baseline) and record them when the block ends: one change event per subject kind,
    so the trace handler walks the graph once per kind, not once per write. A single
    entity's change is recorded as it would be on its own; several go in one event
    with ``subject_id`` null and ``data["roots"]`` (and ``data["entity_ids"]``). Nested
    blocks join the outer one. Nothing is recorded if the block raises."""
    if _BATCH in db.info:
        yield
        return
    batch: dict[uuid.UUID, dict[str, Any]] = {}
    db.info[_BATCH] = batch
    try:
        yield
    finally:
        db.info.pop(_BATCH, None)
    by_kind: dict[str, list[dict[str, Any]]] = {}
    for entry in batch.values():
        by_kind.setdefault(entry["kind"], []).append(entry)
    for kind, entries in by_kind.items():
        if len(entries) == 1:
            await _record_one(db, entries[0])
            continue
        causes = {e["cause"] for e in entries}
        await changes.record_change(
            db,
            kind,
            cause=causes.pop() if len(causes) == 1 else "bulk_write",
            actor=entries[0]["actor"],
            subject_ref=f"{len(entries)} baseline items",
            data={
                "entity_ids": [str(e["id"]) for e in entries],
                "fields": sorted({f for e in entries for f in e["fields"]}),
                "roots": [
                    {"id": str(e["id"]), "ref": e["ref"], "cause": e["cause"], **_data(e)}
                    for e in entries
                ],
            },
        )


async def _record_edge_change(
    db: AsyncSession, actor: str, edge: Edge, cause: str, *, was: str | None
) -> None:
    """An edge created, removed or changed (a re-parent is a removal and a creation):
    recorded against its downstream end, with the whole it joins or leaves. Only an edge
    that is or was confirmed: a proposed (or rejected) edge is not in the trace, so
    nothing was built on it; confirming one is a change. ``was``: its status before."""
    if edge.type in UNTRACED_EDGES:
        return
    now = None if cause == "edge_deleted" else edge.status
    if "confirmed" not in (was, now):
        return
    target_id = edge.dst_id if edge.type in DST_DOWNSTREAM_EDGES else edge.src_id
    target = await db.get(Entity, target_id)
    if target is None:
        return
    wholes = [edge.dst_id] if edge.type in WHOLE_EDGES else []
    snapshot = {"id": str(edge.id), **edge_snapshot(edge)}
    await _record_change(
        db, actor, target, entity_snapshot(target), cause, edge=snapshot, wholes=wholes
    )


async def _evidence_of(
    db: AsyncSession, *, entity_ids: list[uuid.UUID] = (), edge_ids: list[uuid.UUID] = ()
) -> list[uuid.UUID]:
    conditions = []
    if entity_ids:
        conditions.append(Evidence.entity_id.in_(list(entity_ids)))
    if edge_ids:
        conditions.append(Evidence.edge_id.in_(list(edge_ids)))
    if not conditions:
        return []
    stmt = select(Evidence.id).where(or_(*conditions)).order_by(Evidence.created_at, Evidence.id)
    return list((await db.scalars(stmt)).all())


async def _release_edge_evidence(db: AsyncSession, actor: str, edge: Edge) -> set[uuid.UUID]:
    """An edge about to be deleted takes its evidence with it. When a section link cites
    that evidence, the deletion is recorded as removed evidence is (``evidence_deleted``,
    before the delete, whether or not the edge is confirmed or the edge change batched):
    the sections citing it may now be stale. Returns the evidence ids to release."""
    evidence_ids = await _evidence_of(db, edge_ids=[edge.id])
    if not evidence_ids:
        return set()
    cited = await db.scalar(
        select(DocumentSectionLink.id)
        .where(DocumentSectionLink.evidence_id.in_(evidence_ids))
        .limit(1)
    )
    if cited is not None:
        await changes.record_change(
            db,
            "source_permission",
            cause="evidence_deleted",
            actor=actor,
            subject_ref=f"evidence of a {edge.type.replace('_', ' ')} link",
            data={
                "evidence_ids": [str(e) for e in evidence_ids],
                "edge": {"id": str(edge.id), **edge_snapshot(edge)},
            },
        )
    return set(evidence_ids)


# --- entities ------------------------------------------------------------------------------


async def create_entity(
    db: AsyncSession,
    writer: Writer,
    *,
    type_: str,
    key: str,
    title: str,
    body: str | None = None,
    attrs: dict[str, Any] | None = None,
    status: str | None = None,
    parent_id: uuid.UUID | None = None,
) -> WriteResult:
    if type_ not in ENTITY_TYPES:
        raise InvalidError(f"type must be one of {', '.join(ENTITY_TYPES)}")
    if await find_entity(db, type_, key) is not None:
        raise ConflictError(f"{type_}:{key} already exists")
    await check_parent(db, type_, parent_id)
    check_managed_attrs(writer, {}, attrs)
    kept: tuple[str, ...] = ()
    if type_ == "goal":
        attrs, kept = await _goal_attrs(db, writer, dict(attrs or {}))
    if writer.must_propose(None):
        fields = {"type": type_, "key": key, "title": title, "body": body,
                  "attrs": dict(attrs or {}), "status": status}  # fmt: skip
        if parent_id is not None:
            fields["parent_id"] = str(parent_id)
        proposal = await propose(db, writer, op="create", kind="entity", fields=fields)
        return WriteResult(proposal=proposal, kept_as_text=kept)
    entity = Entity(
        type=type_,
        key=key,
        title=title,
        body=body,
        attrs=dict(attrs or {}),
        status=_initial_status(type_, status, writer),
        parent_id=parent_id,
        origin=writer.origin,
        run_id=writer.run_id,
        locked=False,
    )
    lock(entity, writer)
    db.add(entity)
    await db.flush()
    _revision(db, writer, None, entity_snapshot(entity), entity=entity)
    await db.flush()
    return WriteResult(entity=entity, kept_as_text=kept)


def _entity_changes(entity: Entity, changes: dict[str, Any]) -> dict[str, Any]:
    """The subset of ``changes`` that differs from the entity, attrs already merged."""
    out: dict[str, Any] = {}
    for f in ENTITY_FIELDS:
        if f not in changes or (changes[f] is None and f not in ("body", "parent_id")):
            continue
        value = changes[f]
        if f == "attrs":
            value = merge_attrs(entity.attrs, value)
        if value != getattr(entity, f):
            out[f] = value
    return out


async def update_entity(
    db: AsyncSession, writer: Writer, entity: Entity, changes: dict[str, Any]
) -> WriteResult:
    unknown = set(changes) - set(ENTITY_FIELDS)
    if unknown:
        raise InvalidError(f"cannot change {', '.join(sorted(unknown))}")
    _check_status(changes.get("status"))
    if "parent_id" in changes:
        changes = {**changes, "parent_id": _uuid_or_none(changes["parent_id"])}
        if changes["parent_id"] != entity.parent_id:
            await check_parent(db, entity.type, changes["parent_id"], entity)
    kept: tuple[str, ...] = ()
    if entity.type == "goal" and isinstance(changes.get("attrs"), dict):
        merged = merge_attrs(entity.attrs, changes["attrs"])
        if merged != (entity.attrs or {}):
            checked, kept = await _goal_attrs(db, writer, merged, dict(entity.attrs or {}))
            if kept:
                patch = dict(changes["attrs"])
                for k in kept:
                    patch[k], patch[f"{k}_text"] = None, checked[f"{k}_text"]
                changes = {**changes, "attrs": patch}
    diff = _entity_changes(entity, changes)
    if not diff:
        return WriteResult(entity=entity, kept_as_text=kept)
    if "attrs" in diff:
        check_managed_attrs(writer, entity.attrs, diff["attrs"])
    if entity.type == "goal" and diff.get("status") == "confirmed":
        raise InvalidError("confirm a goal with POST .../confirm")
    if writer.must_propose(entity):
        fields = {k: changes[k] for k in changes if k in diff}
        proposal = await propose(
            db, writer, op="update", kind="entity", fields=fields, entity=entity
        )
        return WriteResult(entity=entity, proposal=proposal, kept_as_text=kept)
    if diff.get("status") == "rejected":
        await _check_archivable(db, writer.principal, entity, "archive")
    before = entity_snapshot(entity)
    for f, value in diff.items():
        setattr(entity, f, value)
    lock(entity, writer)
    await db.flush()
    _revision(db, writer, before, entity_snapshot(entity), entity=entity)
    if "status" in diff:
        await scoring.rescore_around(db, [entity.id], include_supporters=True)
    await db.flush()
    await _record_change(db, writer.actor, entity, before, "entity_updated")
    return WriteResult(entity=entity, kept_as_text=kept)


async def set_entity_status(
    db: AsyncSession, principal: Principal, entity: Entity, status: str, reason: str | None
) -> Entity:
    """Confirm or reject (approver+). A person's decision, so it locks the entity."""
    writer = Writer(principal, "user", reason=reason or f"{status} by {principal.actor}")
    if entity.status != status:
        if status == "rejected":
            await _check_archivable(db, principal, entity, "archive")
        before = entity_snapshot(entity)
        entity.status = status
        lock(entity, writer)
        await db.flush()
        _revision(db, writer, before, entity_snapshot(entity), entity=entity)
        await scoring.rescore_around(db, [entity.id], include_supporters=True)
        await db.flush()
        await _record_change(db, writer.actor, entity, before, f"entity_{status}")
    return entity


async def delete_entity(db: AsyncSession, writer: Writer, entity: Entity) -> WriteResult:
    if writer.must_propose(entity):
        proposal = await propose(db, writer, op="delete", kind="entity", fields={}, entity=entity)
        return WriteResult(entity=entity, proposal=proposal)
    await _check_archivable(db, writer.principal, entity, "delete")
    # Neighbours whose goal impact depends on this entity (a goal being removed).
    supporters = (await db.scalars(select(Edge.src_id).where(Edge.dst_id == entity.id))).all()
    await audit.record(
        db,
        writer.principal,
        "baseline.entity.deleted",
        "entity",
        entity.id,
        {"before": entity_snapshot(entity), "origin": writer.origin, "reason": writer.reason},
    )
    # Before the delete: what was built on it is found through its links, and so are the
    # section links citing it, its evidence or its edges' evidence (all go with it). Then
    # those links are released as for removed evidence (oracle.v2.links): one that keeps
    # another target only drops the deleted ones, one left with none goes.
    edge_ids = (
        await db.scalars(
            select(Edge.id).where(or_(Edge.src_id == entity.id, Edge.dst_id == entity.id))
        )
    ).all()
    evidence_ids = await _evidence_of(db, entity_ids=[entity.id], edge_ids=list(edge_ids))
    await _record_change(
        db, writer.actor, entity, entity_snapshot(entity), "entity_deleted",
        evidence_ids=evidence_ids,
    )  # fmt: skip
    await links.release(db, entity_ids={entity.id}, evidence_ids=set(evidence_ids))
    await db.delete(entity)
    await db.flush()
    if supporters:
        await scoring.rescore_around(db, list(supporters))
    return WriteResult()


async def unlock(db: AsyncSession, principal: Principal, item: Entity | Edge) -> None:
    if not item.locked:
        return
    item.locked = False
    item.locked_by = None
    item.locked_at = None
    kind = "entity" if isinstance(item, Entity) else "edge"
    await audit.record(db, principal, f"baseline.{kind}.unlocked", kind, item.id)
    await db.flush()


async def list_entities(
    db: AsyncSession, type_: str | None = None, status: str | None = None
) -> list[Entity]:
    stmt = select(Entity).order_by(Entity.type, Entity.key)
    if type_:
        stmt = stmt.where(Entity.type == type_)
    if status:
        stmt = stmt.where(Entity.status == status)
    return list((await db.scalars(stmt)).all())


async def list_edges(
    db: AsyncSession,
    type_: str | None = None,
    entity_id: uuid.UUID | None = None,
) -> list[Edge]:
    stmt = select(Edge).order_by(Edge.type, Edge.created_at)
    if type_:
        stmt = stmt.where(Edge.type == type_)
    if entity_id:
        stmt = stmt.where(or_(Edge.src_id == entity_id, Edge.dst_id == entity_id))
    return list((await db.scalars(stmt)).all())


async def revisions(
    db: AsyncSession,
    *,
    entity_id: uuid.UUID | None = None,
    edge_id: uuid.UUID | None = None,
    limit: int | None = None,
) -> list[EntityRevision]:
    stmt = (
        select(EntityRevision)
        .order_by(EntityRevision.created_at.desc(), EntityRevision.id)
        .limit(limit)
    )
    if entity_id:
        stmt = stmt.where(EntityRevision.entity_id == entity_id)
    if edge_id:
        stmt = stmt.where(EntityRevision.edge_id == edge_id)
    return list((await db.scalars(stmt)).all())


# --- edges ----------------------------------------------------------------------------------


async def create_edge(
    db: AsyncSession,
    writer: Writer,
    *,
    src_id: uuid.UUID,
    dst_id: uuid.UUID,
    type_: str,
    attrs: dict[str, Any] | None = None,
    status: str | None = None,
) -> WriteResult:
    if type_ not in EDGE_TYPES:
        raise InvalidError(f"type must be one of {', '.join(EDGE_TYPES)}")
    if src_id == dst_id:
        raise InvalidError("an edge cannot point at its own source")
    await get_entity(db, src_id)
    await get_entity(db, dst_id)
    attrs = dict(attrs or {})
    _check_edge_attrs(type_, attrs)
    _check_status(status)
    if await find_edge(db, src_id, dst_id, type_) is not None:
        raise ConflictError(f"a {type_} edge between these entities already exists")
    if writer.must_propose(None):
        fields = {"src_id": src_id, "dst_id": dst_id, "type": type_, "attrs": attrs,
                  "status": status}  # fmt: skip
        proposal = await propose(db, writer, op="create", kind="edge", fields=fields)
        return WriteResult(proposal=proposal)
    edge = Edge(
        src_id=src_id,
        dst_id=dst_id,
        type=type_,
        attrs=attrs,
        status=status or ("confirmed" if writer.locks else "proposed"),
        origin=writer.origin,
        run_id=writer.run_id,
        locked=False,
    )
    lock(edge, writer)
    db.add(edge)
    await db.flush()
    _revision(db, writer, None, edge_snapshot(edge), edge=edge)
    if type_ == "supports":
        await scoring.rescore_around(db, [src_id])
    await db.flush()
    await _record_edge_change(db, writer.actor, edge, "edge_created", was=None)
    return WriteResult(edge=edge)


async def update_edge(
    db: AsyncSession, writer: Writer, edge: Edge, changes: dict[str, Any]
) -> WriteResult:
    unknown = set(changes) - set(EDGE_FIELDS)
    if unknown:
        raise InvalidError(f"cannot change {', '.join(sorted(unknown))}")
    _check_status(changes.get("status"))
    diff: dict[str, Any] = {}
    if changes.get("attrs") is not None:
        attrs = merge_attrs(edge.attrs, changes["attrs"])
        _check_edge_attrs(edge.type, attrs)
        if attrs != edge.attrs:
            diff["attrs"] = attrs
    if changes.get("status") is not None and changes["status"] != edge.status:
        diff["status"] = changes["status"]
    if not diff:
        return WriteResult(edge=edge)
    if writer.must_propose(edge):
        fields = {k: changes[k] for k in changes if k in diff}
        proposal = await propose(db, writer, op="update", kind="edge", fields=fields, edge=edge)
        return WriteResult(edge=edge, proposal=proposal)
    before = edge_snapshot(edge)
    for f, value in diff.items():
        setattr(edge, f, value)
    lock(edge, writer)
    await db.flush()
    _revision(db, writer, before, edge_snapshot(edge), edge=edge)
    if edge.type == "supports":
        await scoring.rescore_around(db, [edge.src_id])
    await db.flush()
    await _record_edge_change(db, writer.actor, edge, "edge_updated", was=before["status"])
    return WriteResult(edge=edge)


async def delete_edge(db: AsyncSession, writer: Writer, edge: Edge) -> WriteResult:
    if writer.must_propose(edge):
        proposal = await propose(db, writer, op="delete", kind="edge", fields={}, edge=edge)
        return WriteResult(edge=edge, proposal=proposal)
    src_id, type_ = edge.src_id, edge.type
    await audit.record(
        db,
        writer.principal,
        "baseline.edge.deleted",
        "edge",
        edge.id,
        {"before": edge_snapshot(edge), "origin": writer.origin, "reason": writer.reason},
    )
    evidence_ids = await _release_edge_evidence(db, writer.actor, edge)
    await _record_edge_change(db, writer.actor, edge, "edge_deleted", was=edge.status)
    await links.release(db, evidence_ids=evidence_ids)
    await db.delete(edge)
    await db.flush()
    if type_ == "supports":
        await scoring.rescore_around(db, [src_id])
    return WriteResult()


# --- merge (B2) ----------------------------------------------------------------------------


async def merge_entity(
    db: AsyncSession, principal: Principal, source: Entity, into: Entity, reason: str | None
) -> Entity:
    """Merge a duplicate a run created into ``into`` (B2 Merge into…): its evidence and
    edges move to the target (an edge the target already has, or one that would link the
    target to itself, is dropped), its open proposals are rejected "Merged into <title>",
    and it is deleted. A person's write: revisions on both and an audit row. Refused (409,
    nothing changed) unless both have the same type, a run created the source, nobody
    locked it and no PRD section links it."""
    from oracle.baseline.from_run import LINKED, LOCKED, NOT_SAME_TYPE, NOT_THIS_RUN

    if source.id == into.id or source.type != into.type:
        raise ConflictError(NOT_SAME_TYPE)
    if source.run_id is None:
        raise ConflictError(NOT_THIS_RUN)
    if source.locked:
        raise ConflictError(LOCKED)
    if await db.scalar(
        select(DocumentSectionLink.id).where(DocumentSectionLink.entity_id == source.id).limit(1)
    ):
        raise ConflictError(LINKED)
    writer = Writer(principal, "user", reason=reason or f"merged {source.type}:{source.key}")
    moved = list(await db.scalars(select(Evidence).where(Evidence.entity_id == source.id)))
    for ev in moved:
        ev.entity_id = into.id
    edges = list(
        await db.scalars(
            select(Edge).where(or_(Edge.src_id == source.id, Edge.dst_id == source.id))
        )
    )
    dropped = 0
    for edge in edges:
        src = into.id if edge.src_id == source.id else edge.src_id
        dst = into.id if edge.dst_id == source.id else edge.dst_id
        before = edge_snapshot(edge)
        if src == dst or await find_edge(db, src, dst, edge.type) is not None:
            await db.delete(edge)
            dropped += 1
            continue
        edge.src_id, edge.dst_id = src, dst
        await db.flush()
        _revision(db, writer, before, edge_snapshot(edge), edge=edge)
    await db.flush()
    note = f"Merged into {into.title}"
    for p in await db.scalars(
        select(Proposal).where(Proposal.entity_id == source.id, Proposal.status == "open")
    ):
        p.status = "rejected"
        p.decided_by = principal.id
        p.decided_at = _now()
        await _detach(db, p)
        p.payload = {**p.payload, "note": note}
        await audit.record(
            db, principal, "baseline.proposal.rejected", "proposal", p.id, {"note": note}
        )
    snapshot = entity_snapshot(into)
    _revision(
        db, writer, snapshot, {**snapshot, "merged_from": f"{source.type}:{source.key}"},
        entity=into,
    )  # fmt: skip
    _revision(db, writer, entity_snapshot(source), None, entity=source)
    await audit.record(
        db, principal, "baseline.entity.merged", "entity", into.id,
        {"source": entity_snapshot(source), "source_id": str(source.id), "reason": reason,
         "evidence_moved": len(moved), "edges_moved": len(edges) - dropped,
         "edges_dropped": dropped},
    )  # fmt: skip
    await db.flush()
    await delete_entity(db, writer, source)
    await scoring.rescore_around(db, [into.id], include_supporters=True)
    await db.flush()
    return into
