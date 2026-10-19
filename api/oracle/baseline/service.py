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
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Any

from sqlalchemy import func, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from oracle import audit
from oracle.auth.deps import Principal
from oracle.baseline import scoring
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

ENTITY_FIELDS = ("title", "body", "attrs", "status")
# attrs keys a module owns, and the routes that change them.
MANAGED_ATTRS = {"blocker": "the blocker routes (/v1/blockers)"}
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


@dataclass(frozen=True)
class Writer:
    principal: Principal | None
    origin: str  # user | agent | import
    run_id: uuid.UUID | None = None
    reason: str | None = None
    # MANAGED_ATTRS keys this writer may change (the owning module's writes only).
    manages: tuple[str, ...] = ()

    @property
    def actor(self) -> str:
        if self.principal is not None:
            return self.principal.actor
        return f"run:{self.run_id}" if self.run_id else "system"

    @property
    def locks(self) -> bool:
        return self.origin == "user"


@dataclass
class WriteResult:
    entity: Entity | None = None
    edge: Edge | None = None
    proposal: Proposal | None = None

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
    return _jsonable(
        {
            "type": e.type,
            "key": e.key,
            "title": e.title,
            "body": e.body,
            "attrs": dict(e.attrs or {}),
            "status": e.status,
        }
    )


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


def _initial_status(type_: str, status: str | None, writer: Writer) -> str:
    _check_status(status)
    if type_ == "goal":
        # B2: goals are proposed, then confirmed by an approver (POST .../confirm).
        if status == "confirmed":
            raise InvalidError("goals start proposed; confirm them with POST .../confirm")
        return status or "proposed"
    return status or ("confirmed" if writer.locks else "proposed")


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


async def list_proposals(db: AsyncSession, status: str | None = None) -> list[Proposal]:
    stmt = select(Proposal).order_by(Proposal.created_at.desc())
    if status:
        stmt = stmt.where(Proposal.status == status)
    return list((await db.scalars(stmt)).all())


async def decide_proposal(
    db: AsyncSession, proposal_id: uuid.UUID, principal: Principal, accept: bool, note: str | None
) -> Proposal:
    proposal = await db.get(Proposal, proposal_id)
    if proposal is None:
        raise NotFoundError("Proposal not found")
    if proposal.status != "open":
        raise ConflictError(f"Proposal is already {proposal.status}")
    if accept:
        p = proposal.payload
        reason = note or p.get("reason") or f"accepted proposal {proposal.id}"
        writer = Writer(principal, "user", run_id=proposal.run_id, reason=reason)
        fields = dict(p.get("fields") or {})
        if p["kind"] == "entity":
            if p["op"] == "create":
                await create_entity(db, writer, **_entity_create_args(fields))
            else:
                target = await get_entity(db, proposal.entity_id or fields.get("id"))
                if p["op"] == "update":
                    await update_entity(db, writer, target, fields)
                else:
                    await delete_entity(db, writer, target)
        else:
            if p["op"] == "create":
                await create_edge(db, writer, **_edge_create_args(fields))
            else:
                target = await get_edge(db, proposal.edge_id or fields.get("id"))
                if p["op"] == "update":
                    await update_edge(db, writer, target, fields)
                else:
                    await delete_edge(db, writer, target)
    proposal.status = "accepted" if accept else "rejected"
    proposal.decided_by = principal.id
    proposal.decided_at = _now()
    await audit.record(
        db,
        principal,
        "baseline.proposal." + proposal.status,
        "proposal",
        proposal.id,
        {"note": note} if note else None,
    )
    await db.flush()
    return proposal


def _entity_create_args(fields: dict[str, Any]) -> dict[str, Any]:
    try:
        return {
            "type_": fields["type"],
            "key": fields["key"],
            "title": fields["title"],
            "body": fields.get("body"),
            "attrs": fields.get("attrs") or {},
            "status": fields.get("status"),
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
    return await propose(db, writer, op=op, kind=kind, fields=fields, entity=entity, edge=edge)


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
) -> WriteResult:
    if type_ not in ENTITY_TYPES:
        raise InvalidError(f"type must be one of {', '.join(ENTITY_TYPES)}")
    if await find_entity(db, type_, key) is not None:
        raise ConflictError(f"{type_}:{key} already exists")
    check_managed_attrs(writer, {}, attrs)
    entity = Entity(
        type=type_,
        key=key,
        title=title,
        body=body,
        attrs=dict(attrs or {}),
        status=_initial_status(type_, status, writer),
        origin=writer.origin,
        run_id=writer.run_id,
        locked=False,
    )
    lock(entity, writer)
    db.add(entity)
    await db.flush()
    _revision(db, writer, None, entity_snapshot(entity), entity=entity)
    await db.flush()
    return WriteResult(entity=entity)


def _entity_changes(entity: Entity, changes: dict[str, Any]) -> dict[str, Any]:
    """The subset of ``changes`` that differs from the entity, attrs already merged."""
    out: dict[str, Any] = {}
    for f in ENTITY_FIELDS:
        if f not in changes or (changes[f] is None and f != "body"):
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
    diff = _entity_changes(entity, changes)
    if not diff:
        return WriteResult(entity=entity)
    if "attrs" in diff:
        check_managed_attrs(writer, entity.attrs, diff["attrs"])
    if entity.type == "goal" and diff.get("status") == "confirmed":
        raise InvalidError("confirm a goal with POST .../confirm")
    if entity.locked and not writer.locks:
        fields = {k: changes[k] for k in changes if k in diff}
        proposal = await propose(
            db, writer, op="update", kind="entity", fields=fields, entity=entity
        )
        return WriteResult(entity=entity, proposal=proposal)
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
    return WriteResult(entity=entity)


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
    return entity


async def delete_entity(db: AsyncSession, writer: Writer, entity: Entity) -> WriteResult:
    if entity.locked and not writer.locks:
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
    db: AsyncSession, *, entity_id: uuid.UUID | None = None, edge_id: uuid.UUID | None = None
) -> list[EntityRevision]:
    stmt = select(EntityRevision).order_by(EntityRevision.created_at.desc())
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
    if edge.locked and not writer.locks:
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
    return WriteResult(edge=edge)


async def delete_edge(db: AsyncSession, writer: Writer, edge: Edge) -> WriteResult:
    if edge.locked and not writer.locks:
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
    await db.delete(edge)
    await db.flush()
    if type_ == "supports":
        await scoring.rescore_around(db, [src_id])
    return WriteResult()
