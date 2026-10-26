"""Blocker strategy (CR-04, build prompt §6) on the baseline graph's constraint entities.

A blocker is a baseline ``constraint`` entity whose ``attrs["blocker"]`` holds the
strategy (:class:`~oracle.blockers.schemas.BlockerSpec`). Its options, feasibility
experiments and resolution events are the foundation's tables; their ``blocker_id``
references any ``entities.id``, so **this module is where ``type = 'constraint'`` is
enforced** (:func:`require_constraint`): every write path goes through it.

Entity writes go through :mod:`oracle.baseline.service` (a person's write: revisions,
lock). Every status change appends a :class:`~oracle.v2.models.BlockerResolutionEvent`
and calls :func:`oracle.changes.record_change` (subject ``blocker_status``) once per
document the blocker gates.

Only this module writes ``attrs["blocker"]`` (``baseline.MANAGED_ATTRS``: every other
baseline write path refuses to). On top of that the gate fails closed: every write
that changes what the gate reads (type, severity, status, gated documents) records a
snapshot of it on a resolution event (``data["gate"]``), and :func:`assess` treats a
strategy that disagrees with its last snapshot as ``critical``, so a strategy changed
around these functions (straight in the database) never clears the readiness gate.
Blockers recorded before snapshots existed got one from migration 0014; one it did not
reach is legacy-unrecorded: judged on its current strategy (critical only if that cannot
be read), and its first locked write records the snapshot (:func:`get_blocker`). Reads
never write.

B4 (company settings, default owner): only ``blocker_risk_acceptance_role`` accepts a
critical hard blocker's risk or approves its feasibility scope; lowering a blocker's
type or severity so that it stops gating takes that role (:func:`_require_lowerer`),
judged for a resolved blocker against the gate it had when resolved
(:func:`_resolve_floor`), so resolve, lower, reopen needs that role too; removing a
document a critical unresolved blocker gates takes it (:func:`_require_document_keeper`);
approvers may resolve it with a reason; a reclassification that makes an earlier
decision gate reopens it unless that role decided it or confirms it
(:func:`_decision_needs_confirmation`); and archiving or deleting a blocker that still gates
publishing takes that role too (:func:`require_archiver`, called from every baseline
path).

The caller commits.
"""

import uuid
from collections import defaultdict
from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta
from typing import Any

from pydantic import ValidationError
from sqlalchemy import func, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from oracle import audit, changes, company_time
from oracle.auth.deps import Principal
from oracle.auth.models import User
from oracle.authz import has_role
from oracle.baseline import service as baseline
from oracle.baseline.models import Edge, Entity, Evidence
from oracle.blockers import policy
from oracle.blockers.schemas import (
    BlockerCreate,
    BlockerGate,
    BlockerOptionCreate,
    BlockerOptionDecision,
    BlockerOptionFallback,
    BlockerOptionPatch,
    BlockerPatch,
    BlockerRiskAcceptanceIn,
    BlockerSpec,
    BlockerStatusIn,
    FeasibilityExperimentCreate,
    FeasibilityExperimentPatch,
    FeasibilityScopeIn,
    dump,
)
from oracle.docs.models import Document
from oracle.tenant_settings_api import get_setting
from oracle.v2.concurrency import expect_version, flush_or_conflict
from oracle.v2.models import (
    AssumptionDecision,
    BlockerOption,
    BlockerResolutionEvent,
    DocumentSectionLink,
    FeasibilityExperiment,
)

# What a blocker may impact (§6: outcomes, requirements, users) and which of those get
# an ``affects`` edge (the foundation: constraint -> requirement or feature).
IMPACT_TYPES = (
    "goal",
    "outcome",
    "product",
    "feature",
    "requirement",
    "acceptance_criterion",
    "person",
)
EDGE_IMPACT_TYPES = ("requirement", "feature")
UNRESOLVED = ("open", "mitigating")
# attrs key an intake answer sets on a constraint it suggests as a blocker
# (oracle.intake.answers, B4): the "suggested blocker" mark promoting it clears.
PROPOSED_KEY = "proposed_blocker"
LIVE_EXPERIMENT = ("planned", "running")
# An experiment carrying a feasibility scope keeps it while it is one of these.
SCOPE_EXPERIMENT = ("planned", "running", "succeeded")
EXPERIMENT_TERMINAL = ("succeeded", "failed", "inconclusive", "cancelled")
SEVERITY_RANK = {"critical": 0, "high": 1, "medium": 2, "low": 3}


class BlockerError(Exception):
    status_code = 400


class NotFoundError(BlockerError):
    status_code = 404


class InvalidError(BlockerError):
    status_code = 422


class NotAConstraintError(InvalidError):
    """The entity exists but is not a ``constraint``: no blocker rows may point at it."""


class ConflictError(BlockerError):
    status_code = 409


class ForbiddenError(BlockerError):
    status_code = 403


class NotABlockerError(ConflictError):
    """A constraint entity without a strategy yet."""


def _now() -> datetime:
    return datetime.now(UTC)


def _aware(value: datetime) -> datetime:
    return value if value.tzinfo else value.replace(tzinfo=UTC)


def _writer(principal: Principal, reason: str | None) -> baseline.Writer:
    # The only writer allowed to change attrs.blocker (baseline.MANAGED_ATTRS).
    return baseline.Writer(principal, "user", reason=reason, manages=("blocker",))


# --- lookups: the constraint-only rule ---------------------------------------------------


async def require_constraint(
    db: AsyncSession, entity_id: uuid.UUID, *, for_update: bool = False
) -> Entity:
    """The entity, if it is a ``constraint`` of this company; raises otherwise."""
    stmt = select(Entity).where(Entity.id == entity_id)
    if for_update:
        stmt = stmt.with_for_update()
    entity = await db.scalar(stmt)
    if entity is None:
        raise NotFoundError("Blocker not found")
    if entity.type != "constraint":
        raise NotAConstraintError(
            f"{entity.type}:{entity.key} is a {entity.type}, not a constraint; "
            "blockers, their options, experiments and events live on constraint entities"
        )
    return entity


def spec_of(entity: Entity) -> BlockerSpec:
    raw = (entity.attrs or {}).get("blocker")
    if raw is None:
        raise NotABlockerError(
            f"constraint:{entity.key} has no blocker strategy yet; "
            "make it one with POST /v1/blockers and its entity_id"
        )
    try:
        return BlockerSpec.model_validate(raw)
    except ValidationError as e:
        raise InvalidError(
            f"The blocker strategy of constraint:{entity.key} cannot be read: {e}"
        ) from e


async def get_blocker(
    db: AsyncSession, entity_id: uuid.UUID, *, for_update: bool = False
) -> tuple[Entity, BlockerSpec]:
    """The blocker and its strategy. ``for_update`` (every write that changes it) takes
    the row lock and, for a legacy-unrecorded blocker, records its first gate snapshot
    from the strategy as it stands before the write, under that lock."""
    entity = await require_constraint(db, entity_id, for_update=for_update)
    spec = spec_of(entity)
    if for_update:
        await _record_first_snapshot(db, entity, spec)
    return entity, spec


async def _record_first_snapshot(db: AsyncSession, entity: Entity, spec: BlockerSpec) -> None:
    """A blocker with no gate snapshot (migration 0014 did not reach it) gets one from its
    current strategy. The caller holds the blocker's row lock, so two writers do not
    both record it."""
    if entity.id in await _last_gate_snapshots(db, [entity.id]):
        return
    db.add(
        BlockerResolutionEvent(
            blocker_id=entity.id,
            kind="status_changed",
            reason="Gate snapshot taken from a blocker recorded before snapshots existed",
            actor="system:legacy-snapshot",
            data={"change": "legacy_snapshot", "gate": gate_snapshot(spec)},
            created_at=await _event_time(db, entity.id),
        )
    )
    await db.flush()


async def _option(db: AsyncSession, option_id: uuid.UUID) -> BlockerOption:
    option = await db.scalar(
        select(BlockerOption).where(BlockerOption.id == option_id).with_for_update()
    )
    if option is None:
        raise NotFoundError("Blocker option not found")
    return option


async def _experiment(db: AsyncSession, experiment_id: uuid.UUID) -> FeasibilityExperiment:
    exp = await db.scalar(
        select(FeasibilityExperiment)
        .where(FeasibilityExperiment.id == experiment_id)
        .with_for_update()
    )
    if exp is None:
        raise NotFoundError("Feasibility experiment not found")
    return exp


# --- validation of references (all company-scoped by the session) ----------------------


async def _check_entities(db: AsyncSession, ids: list[uuid.UUID]) -> list[Entity]:
    if not ids:
        return []
    rows = (await db.scalars(select(Entity).where(Entity.id.in_(ids)))).all()
    found = {e.id: e for e in rows}
    if missing := [str(i) for i in ids if i not in found]:
        raise InvalidError(f"Unknown impacted entities: {', '.join(missing)}")
    if wrong := [f"{e.type}:{e.key}" for e in rows if e.type not in IMPACT_TYPES]:
        raise InvalidError(f"A blocker impacts {', '.join(IMPACT_TYPES)}; not {', '.join(wrong)}")
    return [found[i] for i in ids]


async def _check_documents(db: AsyncSession, ids: list[uuid.UUID]) -> None:
    if not ids:
        return
    found = set((await db.scalars(select(Document.id).where(Document.id.in_(ids)))).all())
    if missing := [str(i) for i in ids if i not in found]:
        raise InvalidError(f"Unknown documents: {', '.join(missing)}")


async def _check_user(db: AsyncSession, user_id: uuid.UUID | None, what: str = "owner") -> None:
    if user_id is not None and await db.get(User, user_id) is None:
        raise InvalidError(f"The {what} is not a user of this company")


async def _check_evidence(db: AsyncSession, ids: list[uuid.UUID]) -> None:
    if not ids:
        return
    found = set((await db.scalars(select(Evidence.id).where(Evidence.id.in_(ids)))).all())
    if missing := [str(i) for i in ids if i not in found]:
        raise InvalidError(f"Unknown evidence: {', '.join(missing)}")


def _check_classification(spec: BlockerSpec) -> None:
    """§16 item 8: a third party's limit is capacity, eligibility, permission or policy."""
    if spec.third_party and spec.limit_kind not in policy.THIRD_PARTY_KINDS:
        raise InvalidError(
            "Classify a third-party limit: capacity (rate or capacity), eligibility (API "
            "eligibility), permission or policy"
        )


def _dedupe(ids: list[uuid.UUID]) -> list[uuid.UUID]:
    return list(dict.fromkeys(ids))


def gate_snapshot(spec: BlockerSpec) -> dict[str, Any]:
    """What the readiness gate reads from a strategy, as recorded on its events."""
    return {
        "type": spec.type,
        "severity": spec.severity,
        "status": spec.status,
        "document_ids": sorted(str(d) for d in spec.document_ids),
    }


def _gating(snapshot: dict[str, Any]) -> bool:
    return snapshot.get("type") == "hard" and snapshot.get("severity") == "critical"


def _gates_publish(snapshot: dict[str, Any] | None) -> bool:
    """Critical, hard and not resolved: an accepted risk or a feasibility scope still
    gates (it only lets a publish through for a while)."""
    return snapshot is not None and _gating(snapshot) and snapshot.get("status") != "resolved"


def _weakens(before: dict[str, Any] | None, after: dict[str, Any]) -> bool:
    """Whether ``after`` gates less than a gating ``before``: no longer critical and
    hard, or listing fewer of its documents."""
    if before is None or not _gating(before):
        return False
    dropped = set(before.get("document_ids") or []) - set(after.get("document_ids") or [])
    return not _gating(after) or bool(dropped)


# --- B4: who decides a critical hard blocker, and for how long ---------------------------


async def decider_role(db: AsyncSession) -> str:
    """B4: the company's ``blocker_risk_acceptance_role`` (default owner)."""
    return await get_setting(db, "blocker_risk_acceptance_role")


async def is_decider(db: AsyncSession, principal: Principal | None) -> bool:
    return principal is not None and has_role(principal.role, await decider_role(db))


async def _require_decider(db: AsyncSession, principal: Principal, spec: BlockerSpec, what: str):
    """B4: accepting a critical hard blocker's risk or approving its feasibility scope is
    for the company's ``blocker_risk_acceptance_role`` (default owner) and above. An
    approver is refused and nothing is stored (no pending proposals)."""
    if not _gating(gate_snapshot(spec)):
        return
    if not await is_decider(db, principal):
        role = await decider_role(db)
        raise ForbiddenError(
            f"Only an {role} can {what} (a critical hard blocker; company setting "
            "blocker_risk_acceptance_role)"
        )


async def _require_lowerer(
    db: AsyncSession,
    principal: Principal,
    before: list[dict[str, Any] | None],
    after: dict[str, Any],
) -> None:
    """B4 (owner, 2026-10-19): changing a blocker's type or severity so that it stops
    gating publish takes the B4 role. ``before`` is the strategy before the change and
    the gate's last recorded snapshot (and, for a resolved blocker, its resolution floor
    as if unresolved): any gating counts, so a strategy lowered in the database cannot
    be laundered into a new snapshot by an approver's edit. Resolving
    (``set_status``) stays open to approvers, with a reason."""
    if not any(_gates_publish(b) for b in before) or _gating(after):
        return
    if not await is_decider(db, principal):
        role = await decider_role(db)
        raise ForbiddenError(f"This blocker gates publishing. Only an {role} can lower it.")


async def _require_document_keeper(
    db: AsyncSession,
    principal: Principal,
    entity: Entity,
    before: list[dict[str, Any] | None],
    after: dict[str, Any],
) -> None:
    """B4 (owner, 2026-10-19): removing a document from a critical, unresolved blocker
    that still gates it takes the B4 role. Judged on the documents the blocker gates
    (listed or linked from one of their sections) before and after the change, whichever
    field the PATCH names; ``before`` as in :func:`_require_lowerer`."""
    gating = [b for b in before if _gates_publish(b)]
    if not gating:
        return
    linked = {str(d) for d in await _section_linked_documents(db, entity)}
    gated = {d for b in gating for d in b.get("document_ids") or []} | linked
    if not gated - (set(after.get("document_ids") or []) | linked):
        return
    if not await is_decider(db, principal):
        role = await decider_role(db)
        raise ForbiddenError(f"This blocker gates this document. Only an {role} can remove it.")


async def _resolve_floor(db: AsyncSession, blocker_id: uuid.UUID) -> dict[str, Any] | None:
    """For a resolved blocker, the gate a reopen must not fall below: the snapshot its
    resolution recorded, or the one the B4 role reclassified it to since
    (``data.by_decider``). None when it is not resolved or the resolution recorded no
    snapshot (a legacy blocker: it is judged on its first snapshot from then on)."""
    last = (await _last_status_events(db, [blocker_id])).get(blocker_id)
    if last is None or last.to_status != "resolved":
        return None
    floor = (last.data or {}).get("gate")
    if not isinstance(floor, dict):
        return None
    since = (
        await db.scalars(
            select(BlockerResolutionEvent)
            .where(
                BlockerResolutionEvent.blocker_id == blocker_id,
                BlockerResolutionEvent.data.contains({"change": "reclassified"}),
                BlockerResolutionEvent.created_at > last.created_at,
            )
            .order_by(BlockerResolutionEvent.created_at, BlockerResolutionEvent.id)
        )
    ).all()
    for event in since:
        gate = (event.data or {}).get("gate")
        if event.data.get("by_decider") is True and isinstance(gate, dict):
            floor = gate
    return floor


async def still_gates(db: AsyncSession, entity: Entity) -> bool:
    """Whether this constraint's blocker still gates publishing: it is critical and hard
    and not resolved (an accepted risk or a feasibility scope only lets a publish
    through for a while), or the gate fails closed on it (a strategy that cannot be
    read, or that disagrees with its last snapshot). A constraint that is no blocker,
    or a resolved or lesser blocker, does not."""
    if entity.type != "constraint":
        return False
    inputs = await gate_inputs(db, [entity.id])
    spec = safe_spec(entity)
    if spec is None and "blocker" not in (entity.attrs or {}):
        if entity.id not in inputs.recorded_gate:
            return False  # a plain constraint, never a blocker
    if assess(entity, spec, inputs).status == "critical":
        return True
    return spec is not None and _gating(gate_snapshot(spec)) and spec.status != "resolved"


async def require_archiver(
    db: AsyncSession, principal: Principal | None, entity: Entity, verb: str
) -> None:
    """B4 (owner, 2026-10-19): archiving (rejecting) or deleting a constraint whose
    blocker still gates publishing takes the B4 role (default owner); approvers may
    archive resolved or non-gating ones. ``verb`` is ``archive`` or ``delete``."""
    if await is_decider(db, principal) or not await still_gates(db, entity):
        return
    role = await decider_role(db)
    raise ForbiddenError(f"This blocker still gates publishing. Only an {role} can {verb} it.")


# --- affects edges for impacted requirements and features (§7) ---------------------------


async def _sync_affects(
    db: AsyncSession, principal: Principal, entity: Entity, impacted: list[Entity]
) -> None:
    wanted = {e.id for e in impacted if e.type in EDGE_IMPACT_TYPES}
    existing = {
        e.dst_id: e
        for e in (
            await db.scalars(select(Edge).where(Edge.src_id == entity.id, Edge.type == "affects"))
        ).all()
    }
    writer = _writer(principal, "blocker impact")
    for dst in wanted - set(existing):
        await baseline.create_edge(db, writer, src_id=entity.id, dst_id=dst, type_="affects")
    for dst in set(existing) - wanted:
        await baseline.delete_edge(db, writer, existing[dst])


# --- the strategy record ----------------------------------------------------------------


async def _save(
    db: AsyncSession,
    principal: Principal,
    entity: Entity,
    spec: BlockerSpec,
    reason: str | None,
    **fields: Any,
) -> None:
    """Write ``spec`` (and title/body) as a person's baseline edit; bumps the revision."""
    spec.revision += 1
    changes_ = {"attrs": {"blocker": dump(spec)}, **fields}
    await baseline.update_entity(db, _writer(principal, reason), entity, changes_)


async def _section_linked_documents(db: AsyncSession, entity: Entity) -> list[uuid.UUID]:
    return list(
        (
            await db.scalars(
                select(DocumentSectionLink.document_id)
                .where(DocumentSectionLink.entity_id == entity.id)
                .distinct()
            )
        ).all()
    )


async def linked_document_ids(
    db: AsyncSession, entity: Entity, spec: BlockerSpec
) -> list[uuid.UUID]:
    return _dedupe([*spec.document_ids, *await _section_linked_documents(db, entity)])


async def _event(
    db: AsyncSession,
    principal: Principal,
    entity: Entity,
    kind: str,
    *,
    from_status: str | None = None,
    to_status: str | None = None,
    reason: str | None = None,
    option_id: uuid.UUID | None = None,
    experiment_id: uuid.UUID | None = None,
    data: dict[str, Any] | None = None,
    spec: BlockerSpec | None = None,
) -> BlockerResolutionEvent:
    """Append a resolution event; with ``spec``, it records the gate's snapshot too."""
    data = dict(data or {})
    if spec is not None:
        data["gate"] = gate_snapshot(spec)
    event = BlockerResolutionEvent(
        blocker_id=entity.id,
        option_id=option_id,
        experiment_id=experiment_id,
        kind=kind,
        from_status=from_status,
        to_status=to_status,
        reason=reason,
        actor=principal.actor,
        data=data,
        created_at=await _event_time(db, entity.id),
    )
    db.add(event)
    await db.flush()
    return event


async def _event_time(db: AsyncSession, blocker_id: uuid.UUID) -> datetime:
    """A time after every recorded event of this blocker, so its events are strictly
    ordered by ``created_at`` even when the clock repeats a value (two events of one
    request, a coarse clock). Python's clock, not the transaction's. Writers hold the
    blocker's row lock, so two of them do not race for the same instant."""
    now = _now()
    latest = await db.scalar(
        select(func.max(BlockerResolutionEvent.created_at)).where(
            BlockerResolutionEvent.blocker_id == blocker_id
        )
    )
    if latest is not None and _aware(latest) >= now:
        return _aware(latest) + timedelta(microseconds=1)
    return now


async def _record(
    db: AsyncSession,
    principal: Principal,
    entity: Entity,
    spec: BlockerSpec,
    cause: str,
    data: dict[str, Any],
) -> None:
    """``record_change`` once per document the blocker gates (once with none)."""
    docs = await linked_document_ids(db, entity, spec)
    for doc_id in docs or [None]:
        await changes.record_change(
            db,
            "blocker_status",
            cause=cause,
            actor=principal,
            subject_id=entity.id,
            subject_ref=f"constraint:{entity.key}",
            document_id=doc_id,
            data=data,
        )


async def _transition(
    db: AsyncSession,
    principal: Principal,
    entity: Entity,
    spec: BlockerSpec,
    to_status: str,
    *,
    kind: str,
    reason: str | None,
    cause: str | None = None,
    option_id: uuid.UUID | None = None,
    experiment_id: uuid.UUID | None = None,
    data: dict[str, Any] | None = None,
    audit_action: str = "blocker.status_changed",
) -> BlockerResolutionEvent:
    """Change the blocker's status: event, entity write, change event and one audit
    event (``audit_action``: a risk acceptance or a feasibility scope is its own)."""
    from_status = spec.status
    spec.status = to_status  # type: ignore[assignment]
    await _save(db, principal, entity, spec, reason)
    event = await _event(
        db,
        principal,
        entity,
        kind,
        from_status=from_status,
        to_status=to_status,
        reason=reason,
        option_id=option_id,
        experiment_id=experiment_id,
        data=data,
        spec=spec,
    )
    payload = {
        "from_status": from_status,
        "to_status": to_status,
        "reason": reason,
        "event_id": str(event.id),
        "kind": kind,
        **(data or {}),
    }
    if option_id:
        payload["option_id"] = str(option_id)
    if experiment_id:
        payload["experiment_id"] = str(experiment_id)
    await _record(db, principal, entity, spec, cause or kind, payload)
    await audit.record(db, principal, audit_action, "entity", entity.id, payload)
    return event


async def _capture(
    db: AsyncSession,
    principal: Principal,
    entity: Entity,
    event: BlockerResolutionEvent,
    chosen: str,
    reason: str | None,
    review_at: datetime | None = None,
) -> None:
    """H1: a blocker's risk, option or feasibility scope is a judgement call in the
    decision log, one record per resolution event."""
    from oracle.decisions import capture

    await capture.blocker_decided(
        db, principal, entity, event, chosen=chosen, rationale=reason, review_at=review_at
    )


# --- blockers -------------------------------------------------------------------------------


async def create_blocker(db: AsyncSession, principal: Principal, body: BlockerCreate) -> Entity:
    # An existing constraint may take a new statement too (Promote's edited title).
    if (body.entity_id is None) == (body.key is None):
        raise InvalidError("Give either entity_id (an existing constraint) or key and statement")
    if body.entity_id is None and (body.key is None or body.statement is None):
        raise InvalidError("A new blocker needs both a key and a statement")
    impacted = await _check_entities(db, _dedupe(body.impacted_entity_ids or []))
    document_ids = _dedupe(body.document_ids or [])
    await _check_documents(db, document_ids)
    await _check_user(db, body.owner_id)
    spec = BlockerSpec(
        type=body.type,
        limit_kind=body.limit_kind or "other",
        third_party=body.third_party,
        severity=body.severity or "medium",
        status=body.status,
        timing=body.timing,
        threshold=body.threshold,
        impacted_entity_ids=[e.id for e in impacted],
        impacted_users=body.impacted_users or [],
        owner_id=body.owner_id,
        review_at=body.review_at,
        document_ids=document_ids,
        scaling=body.scaling or {},
        revision=1,
    )
    _check_classification(spec)
    writer = _writer(principal, body.reason or "blocker created")
    suggested = False
    if body.entity_id is not None:
        entity = await require_constraint(db, body.entity_id, for_update=True)
        if "blocker" in (entity.attrs or {}):
            raise ConflictError(f"constraint:{entity.key} is already a blocker; PATCH it")
        fields: dict[str, Any] = {"attrs": {"blocker": dump(spec)}}
        # An intake answer's suggested blocker (B4, owner 2026-10-20): promoting it
        # clears the mark in the same write, so it is never both or neither.
        suggested = PROPOSED_KEY in (entity.attrs or {})
        if suggested:
            fields["attrs"][PROPOSED_KEY] = None
        if body.statement is not None:
            fields["title"] = body.statement
        if body.detail is not None:
            fields["body"] = body.detail
        await baseline.update_entity(db, writer, entity, fields)
    else:
        if await baseline.find_entity(db, "constraint", body.key) is not None:
            raise ConflictError(f"constraint:{body.key} already exists; give its entity_id")
        result = await baseline.create_entity(
            db,
            writer,
            type_="constraint",
            key=body.key,
            title=body.statement,
            body=body.detail,
            attrs={"blocker": dump(spec)},
        )
        entity = result.entity
    await _sync_affects(db, principal, entity, impacted)
    await _event(
        db,
        principal,
        entity,
        "status_changed",
        to_status=spec.status,
        reason=body.reason or "Blocker recorded",
        spec=spec,
    )
    await audit.record(
        db,
        principal,
        "blocker.created",
        "entity",
        entity.id,
        {"key": entity.key, "blocker": dump(spec), **({"promoted": True} if suggested else {})},
    )
    return entity


async def update_blocker(
    db: AsyncSession, principal: Principal, entity_id: uuid.UUID, body: BlockerPatch
) -> Entity:
    entity, spec = await get_blocker(db, entity_id, for_update=True)
    if spec.revision != body.revision:
        raise ConflictError("Someone else changed this blocker since you loaded it; reload")
    given = body.model_fields_set - {"revision", "reason", "confirm_decision"}
    fields: dict[str, Any] = {}
    before = dump(spec)
    snapshot_before = gate_snapshot(spec)
    impacted: list[Entity] | None = None
    if "statement" in given and body.statement is not None:
        fields["title"] = body.statement
    if "detail" in given:
        fields["body"] = body.detail
    if "impacted_entity_ids" in given:
        impacted = await _check_entities(db, _dedupe(body.impacted_entity_ids or []))
        spec.impacted_entity_ids = [e.id for e in impacted]
    if "document_ids" in given:
        spec.document_ids = _dedupe(body.document_ids or [])
        await _check_documents(db, spec.document_ids)
    if "owner_id" in given:
        await _check_user(db, body.owner_id)
        spec.owner_id = body.owner_id
    for name in ("type", "limit_kind", "severity"):
        if name in given and getattr(body, name) is not None:
            setattr(spec, name, getattr(body, name))
    for name in ("third_party", "timing", "threshold", "review_at"):
        if name in given:
            setattr(spec, name, getattr(body, name))
    if "impacted_users" in given:
        spec.impacted_users = body.impacted_users or []
    if "scaling" in given and body.scaling is not None:
        spec.scaling = body.scaling
    _check_classification(spec)
    # B4 before anything is written: a refusal stores nothing.
    after_gate = gate_snapshot(spec)
    recorded = (await _last_gate_snapshots(db, [entity.id])).get(entity.id)
    gates_before: list[dict[str, Any] | None] = [snapshot_before, recorded]
    await _require_document_keeper(db, principal, entity, gates_before, after_gate)
    if snapshot_before["status"] == "resolved":
        # Resolving does not let an approver lower it: compare with the gate as it stood
        # when it was resolved (or as the B4 role reclassified it since).
        floor = await _resolve_floor(db, entity.id)
        if floor is not None:
            gates_before.append({**floor, "status": "open"})
    await _require_lowerer(db, principal, gates_before, after_gate)
    pending = await _decision_needs_confirmation(db, entity, spec, snapshot_before)
    if body.confirm_decision:
        if not await is_decider(db, principal):
            role = await decider_role(db)
            raise ForbiddenError(
                f"Only an {role} can confirm a risk acceptance or feasibility scope (company "
                "setting blocker_risk_acceptance_role)"
            )
        if pending is None:
            raise ConflictError(
                "Nothing to confirm: this change reopens no risk acceptance or feasibility "
                "scope (confirm_decision applies to a reclassification into critical and "
                "hard of a decision the B4 role did not make)"
            )
    if pending is not None and not (body.reason or "").strip():
        what = "keeps" if body.confirm_decision else "reopens"
        raise InvalidError(
            f"Say why: this reclassification {what} the blocker's {pending} (reason required)"
        )
    if impacted is not None:
        await _sync_affects(db, principal, entity, impacted)
    await _save(db, principal, entity, spec, body.reason, **fields)
    after = dump(spec)
    reclassified = None
    if gate_snapshot(spec) != snapshot_before:
        # What the gate reads changed: record it, so the gate trusts the new strategy.
        reclassified = await _event(
            db,
            principal,
            entity,
            "status_changed",
            reason=body.reason,
            data={
                "change": "reclassified",
                "before": snapshot_before,
                "by_decider": await is_decider(db, principal),
            },
            spec=spec,
        )
    if (before["type"], before["severity"]) != (after["type"], after["severity"]):
        await _record(
            db,
            principal,
            entity,
            spec,
            "blocker_reclassified",
            {
                "from_status": spec.status,
                "to_status": spec.status,
                "before": {"type": before["type"], "severity": before["severity"]},
                "after": {"type": after["type"], "severity": after["severity"]},
            },
        )
    if pending is not None and reclassified is not None:
        await _reopen_or_confirm(
            db, principal, entity, spec, pending, body.confirm_decision, body.reason, reclassified
        )
    await audit.record(
        db,
        principal,
        "blocker.updated",
        "entity",
        entity.id,
        {"fields": sorted(given), "reason": body.reason},
    )
    return entity


async def _decision_needs_confirmation(
    db: AsyncSession, entity: Entity, spec: BlockerSpec, snapshot_before: dict[str, Any]
) -> str | None:
    """The rule: a risk acceptance or feasibility scope decided while the blocker did not
    gate stands, once a reclassification makes it gate (critical and hard), only if the
    B4 role decided it (``data.by_decider``) or confirms it in that same request
    (``confirm_decision``); otherwise it is reopened, whoever reclassifies. A
    confirmation answers one reclassification: lowered and raised again, the decision
    needs a new one. Returns what needs confirming (``risk acceptance`` or ``feasibility
    scope``), or None."""
    if _gating(snapshot_before) or not _gating(gate_snapshot(spec)):
        return None
    if spec.status not in ("accepted_risk", "feasibility_only"):
        return None
    last = (await _last_status_events(db, [entity.id])).get(entity.id)
    if last is not None and (last.data or {}).get("by_decider") is True:
        return None
    return "risk acceptance" if spec.status == "accepted_risk" else "feasibility scope"


async def _reopen_or_confirm(
    db: AsyncSession,
    principal: Principal,
    entity: Entity,
    spec: BlockerSpec,
    what: str,
    confirm: bool,
    reason: str | None,
    reclassified: BlockerResolutionEvent,
) -> None:
    """Keep the decision (``confirm``: the caller is the B4 role, checked before anything
    was written), recorded as their decision on this reclassification (``data.answers``),
    or reopen the blocker. On a reopen, the scope's experiment, if planned or running,
    goes back to planned."""
    if confirm:
        confirmed = {
            "change": "confirmed",
            "confirmed": spec.status,
            "answers": str(reclassified.id),
        }
        event = await _event(
            db, principal, entity, "status_changed", reason=reason, data=confirmed, spec=spec
        )
        await audit.record(
            db,
            principal,
            "blocker.decision_confirmed",
            "entity",
            entity.id,
            {**confirmed, "event_id": str(event.id), "reason": reason},
        )
        return
    role = await decider_role(db)
    data: dict[str, Any] = {
        "change": "reopened_by_reclassification",
        "withdrawn": spec.status,
        "role": role,
    }
    experiment_id = None
    if spec.status == "feasibility_only":
        experiment_id = await _scope_experiment_id(db, entity.id)
    if experiment_id is not None:
        exp = await _experiment(db, experiment_id)
        data["experiment"] = {"from": exp.status, "to": exp.status}
        if exp.status in LIVE_EXPERIMENT:
            exp.status = "planned"
            data["experiment"]["to"] = "planned"
            await flush_or_conflict(db)
            await audit.record(
                db,
                principal,
                "feasibility_experiment.updated",
                "feasibility_experiment",
                exp.id,
                {"fields": ["status"], **data["experiment"], "reason": "scope withdrawn"},
            )
    await _transition(
        db,
        principal,
        entity,
        spec,
        "open",
        kind="status_changed",
        reason=f"Reclassified as critical and hard: its {what} was not decided by an "
        f"{role}, so the blocker is open again until an {role} decides",
        cause="blocker_reclassified",
        experiment_id=experiment_id,
        data=data,
    )


async def status_refusal(
    db: AsyncSession,
    principal: Principal,
    entity: Entity,
    spec: BlockerSpec,
    role: str | None = None,
) -> str | None:
    """Why ``principal`` may not change this blocker's status, or None when they may.
    Resolved, then lowered or narrowed by someone below the B4 role: reopening it as it is
    now would leave it open without the gate it had, so only the B4 role reopens it (and a
    resolved blocker's only change is a reopen). The strategy view reads the same answer,
    so the web shows Set status disabled with this reason. ``role``: the B4 role when the
    caller has read it already (a list of blockers reads it once)."""
    if spec.status != "resolved":
        return None
    if not _weakens(await _resolve_floor(db, entity.id), gate_snapshot(spec)):
        return None
    role = role or await decider_role(db)
    if has_role(principal.role, role):
        return None
    return (
        "This blocker gated publishing when it was resolved and was lowered or "
        f"narrowed since. Only an {role} can reopen it."
    )


async def set_status(
    db: AsyncSession, principal: Principal, entity_id: uuid.UUID, body: BlockerStatusIn
) -> Entity:
    entity, spec = await get_blocker(db, entity_id, for_update=True)
    if body.status == "resolved" and not (body.reason or "").strip():
        raise InvalidError("Say why the blocker is resolved")
    if body.status == spec.status:
        return entity
    refusal = await status_refusal(db, principal, entity, spec)
    if refusal is not None:
        raise ForbiddenError(refusal)
    kind = (
        "reopened" if body.status == "open" and spec.status not in UNRESOLVED else "status_changed"
    )
    await _transition(db, principal, entity, spec, body.status, kind=kind, reason=body.reason)
    return entity


async def accept_risk(
    db: AsyncSession, principal: Principal, entity_id: uuid.UUID, body: BlockerRiskAcceptanceIn
) -> Entity:
    """An authorized person accepts the risk of an unresolved blocker: who, why, until."""
    entity, spec = await get_blocker(db, entity_id, for_update=True)
    if not body.reason.strip():
        raise InvalidError("Say why the risk is accepted")
    review_at = _aware(body.review_at)
    if review_at <= _now():
        raise InvalidError("The review date of an accepted risk must be in the future")
    max_days = await get_setting(db, "blocker_risk_review_max_days")
    if review_at > _now() + timedelta(days=max_days):
        raise InvalidError(
            f"An accepted risk must be reviewed within {max_days} days (company setting "
            "blocker_risk_review_max_days); choose an earlier review date"
        )
    if spec.status == "resolved":
        raise ConflictError("The blocker is resolved; there is no risk left to accept")
    await _require_decider(db, principal, spec, "accept this risk")
    docs = await linked_document_ids(db, entity, spec)
    decision = AssumptionDecision(
        entity_id=entity.id,
        document_id=docs[0] if len(docs) == 1 else None,
        statement=entity.title,
        decision="accept_risk",
        rationale=body.reason,
        decided_by=principal.id,
        review_at=review_at,
    )
    db.add(decision)
    await db.flush()
    spec.review_at = review_at
    data = {
        "assumption_decision_id": str(decision.id),
        "review_at": review_at.isoformat(),
        "type": spec.type,
        "severity": spec.severity,
        "by_decider": await is_decider(db, principal),
    }
    event = await _transition(
        db,
        principal,
        entity,
        spec,
        "accepted_risk",
        kind="risk_accepted",
        reason=body.reason,
        data=data,
        audit_action="blocker.risk_accepted",
    )
    await _capture(db, principal, entity, event, "accept_risk", body.reason, review_at)
    return entity


async def approve_feasibility_scope(
    db: AsyncSession, principal: Principal, entity_id: uuid.UUID, body: FeasibilityScopeIn
) -> Entity:
    """Proceed only as a scoped feasibility experiment (§6): owner, threshold, gate."""
    entity, spec = await get_blocker(db, entity_id, for_update=True)
    exp = await db.get(FeasibilityExperiment, body.experiment_id)
    if exp is None or exp.blocker_id != entity.id:
        raise InvalidError("No such feasibility experiment on this blocker")
    if spec.status == "resolved":
        raise ConflictError("The blocker is resolved; it needs no feasibility scope")
    await _require_decider(db, principal, spec, "approve this feasibility scope")
    missing = []
    if exp.owner_id is None:
        missing.append("an owner")
    if not (exp.success_threshold or "").strip():
        missing.append("a success threshold")
    if exp.decision_gate_at is None:
        missing.append("a decision gate date")
    elif _aware(exp.decision_gate_at) <= _now():
        missing.append("a decision gate date in the future")
    if exp.status not in LIVE_EXPERIMENT:
        missing.append("a planned or running experiment")
    if missing:
        raise InvalidError(f"A feasibility scope needs {', '.join(missing)}")
    data = {
        "hypothesis": exp.hypothesis,
        "decision_gate_at": exp.decision_gate_at.isoformat(),
        "by_decider": await is_decider(db, principal),
    }
    event = await _transition(
        db,
        principal,
        entity,
        spec,
        "feasibility_only",
        kind="feasibility_scope_approved",
        reason=body.reason,
        experiment_id=exp.id,
        data=data,
        audit_action="blocker.feasibility_scope_approved",
    )
    await _capture(db, principal, entity, event, "feasibility_scope", body.reason)
    return entity


# --- options --------------------------------------------------------------------------------


def option_texts(
    title: str | None, description: str | None, details: dict[str, Any] | None
) -> list[str]:
    texts = [title or "", description or ""]
    texts += [v for v in (details or {}).values() if isinstance(v, str)]
    return texts


def flags_of(option: BlockerOption) -> list[policy.BlockerPolicyFlag]:
    return policy.screen(*option_texts(option.title, option.description, option.details))


async def create_option(
    db: AsyncSession, principal: Principal, blocker_id: uuid.UUID, body: BlockerOptionCreate
) -> BlockerOption:
    entity, _spec = await get_blocker(db, blocker_id)
    await _check_evidence(db, body.evidence_ids)
    await _check_user(db, body.owner_id)
    details = body.details.model_dump(mode="json", exclude_none=True)
    flags = policy.screen(*option_texts(body.title, body.description, details))
    option = BlockerOption(
        blocker_id=entity.id,
        title=body.title,
        approach=body.approach,
        description=body.description,
        technical_feasibility=body.technical_feasibility,
        policy_feasibility="low" if flags else body.policy_feasibility,
        compliance="non_compliant" if flags else "needs_review",
        status="rejected" if flags else "proposed",
        details=details,
        evidence_ids=_dedupe(body.evidence_ids),
        owner_id=body.owner_id,
        created_by=principal.id,
    )
    db.add(option)
    await db.flush()
    await audit.record(
        db,
        principal,
        "blocker_option.created",
        "blocker_option",
        option.id,
        {
            "blocker_id": str(entity.id),
            "approach": option.approach,
            "compliance": option.compliance,
            "policy_flags": [f.model_dump() for f in flags],
        },
    )
    return option


async def update_option(
    db: AsyncSession, principal: Principal, option_id: uuid.UUID, body: BlockerOptionPatch
) -> BlockerOption:
    option = await _option(db, option_id)
    await get_blocker(db, option.blocker_id)
    expect_version(option, body.lock_version)
    given = body.model_fields_set - {"lock_version", "reason"}
    decided = option.status in ("selected", "fallback")
    if decided and given & {"title", "approach", "description"}:
        raise ConflictError(
            f"The {option.status} option is a decision on this exact text; add another "
            "option instead of rewriting it"
        )
    title = body.title if "title" in given and body.title else option.title
    description = body.description if "description" in given else option.description
    details = option.details
    if "details" in given and body.details is not None:
        details = body.details.model_dump(mode="json", exclude_none=True)
    flags = policy.screen(*option_texts(title, description, details))
    if flags and decided:
        raise InvalidError(
            f"A {option.status} option must stay within platform rules: "
            + "; ".join(f"{f.message} ('{f.match}')" for f in flags)
        )
    if flags and body.compliance == "compliant":
        raise InvalidError(
            "Flagged text cannot be marked compliant: "
            + "; ".join(f"{f.message} ('{f.match}')" for f in flags)
        )
    if body.compliance is not None and body.compliance != "compliant" and decided:
        raise InvalidError(f"Reject the {option.status} option before changing its review")
    if "evidence_ids" in given:
        await _check_evidence(db, body.evidence_ids or [])
        option.evidence_ids = _dedupe(body.evidence_ids or [])
    if "owner_id" in given:
        await _check_user(db, body.owner_id)
        option.owner_id = body.owner_id
    text_changed = (title, description, details, option.approach) != (
        option.title,
        option.description,
        option.details,
        body.approach or option.approach,
    )
    option.title, option.description, option.details = title, description, details
    for name in ("approach", "technical_feasibility", "policy_feasibility"):
        if name in given and getattr(body, name) is not None:
            setattr(option, name, getattr(body, name))
    if flags:
        option.compliance = "non_compliant"
        option.policy_feasibility = "low"
        option.status = "rejected"
    elif body.compliance is not None:
        option.compliance = body.compliance
    elif text_changed and option.compliance == "compliant" and not decided:
        # The review was of the old text.
        option.compliance = "needs_review"
    await flush_or_conflict(db)
    await audit.record(
        db,
        principal,
        "blocker_option.updated",
        "blocker_option",
        option.id,
        {
            "fields": sorted(given),
            "compliance": option.compliance,
            "reason": body.reason,
            "policy_flags": [f.model_dump() for f in flags],
        },
    )
    return option


def _require_choosable(option: BlockerOption, what: str) -> None:
    if option.status == "rejected":
        raise InvalidError(f"A rejected option cannot be the {what}")
    if option.compliance != "compliant":
        raise InvalidError(
            f"Only an option reviewed as compliant can be the {what} (it is "
            f"{option.compliance.replace('_', ' ')})"
        )
    if flags := flags_of(option):
        raise InvalidError(
            f"The {what} must stay within platform rules: "
            + "; ".join(f"{f.message} ('{f.match}')" for f in flags)
        )


async def select_option(
    db: AsyncSession, principal: Principal, option_id: uuid.UUID, body: BlockerOptionDecision
) -> Entity:
    option = await _option(db, option_id)
    entity, spec = await get_blocker(db, option.blocker_id, for_update=True)
    expect_version(option, body.lock_version)
    _require_choosable(option, "selected option")
    others = (
        await db.scalars(
            select(BlockerOption)
            .where(
                BlockerOption.blocker_id == entity.id,
                BlockerOption.status == "selected",
                BlockerOption.id != option.id,
            )
            .with_for_update()
        )
    ).all()
    for other in others:
        other.status = "evaluating"
    option.status = "selected"
    option.selected_reason = body.reason
    await flush_or_conflict(db)
    previous = spec.selected_option_id
    spec.selected_option_id = option.id
    from_status = spec.status
    to_status = "mitigating" if spec.status == "open" else None
    if to_status:
        spec.status = to_status  # type: ignore[assignment]
    await _save(db, principal, entity, spec, body.reason)
    data = {
        "from_status": from_status,
        "to_status": to_status or from_status,
        "option_id": str(option.id),
        "previous_option_id": str(previous) if previous else None,
        "reason": body.reason,
    }
    event = await _event(
        db,
        principal,
        entity,
        "option_selected",
        from_status=from_status,
        to_status=to_status,
        reason=body.reason,
        option_id=option.id,
        data={"previous_option_id": data["previous_option_id"]},
        spec=spec,
    )
    await _record(db, principal, entity, spec, "option_selected", data)
    await _capture(db, principal, entity, event, str(option.id), body.reason)
    await audit.record(db, principal, "blocker_option.selected", "blocker_option", option.id, data)
    return entity


async def mark_fallback(
    db: AsyncSession, principal: Principal, option_id: uuid.UUID, body: BlockerOptionFallback
) -> BlockerOption:
    option = await _option(db, option_id)
    await get_blocker(db, option.blocker_id)
    expect_version(option, body.lock_version)
    if option.status == "selected":
        raise ConflictError("The selected option cannot also be its own fallback")
    _require_choosable(option, "fallback")
    option.status = "fallback"
    await flush_or_conflict(db)
    await audit.record(
        db,
        principal,
        "blocker_option.fallback",
        "blocker_option",
        option.id,
        {"reason": body.reason},
    )
    return option


async def reject_option(
    db: AsyncSession, principal: Principal, option_id: uuid.UUID, body: BlockerOptionDecision
) -> BlockerOption:
    option = await _option(db, option_id)
    entity, spec = await get_blocker(db, option.blocker_id, for_update=True)
    expect_version(option, body.lock_version)
    was_selected = option.status == "selected"
    option.status = "rejected"
    await flush_or_conflict(db)
    if was_selected or spec.selected_option_id == option.id:
        spec.selected_option_id = None
        await _save(db, principal, entity, spec, body.reason)
        await _record(
            db,
            principal,
            entity,
            spec,
            "option_rejected",
            {
                "from_status": spec.status,
                "to_status": spec.status,
                "option_id": str(option.id),
                "reason": body.reason,
            },
        )
    await audit.record(
        db,
        principal,
        "blocker_option.rejected",
        "blocker_option",
        option.id,
        {"reason": body.reason, "was_selected": was_selected},
    )
    return option


# --- experiments ----------------------------------------------------------------------------


async def create_experiment(
    db: AsyncSession, principal: Principal, blocker_id: uuid.UUID, body: FeasibilityExperimentCreate
) -> FeasibilityExperiment:
    entity, _spec = await get_blocker(db, blocker_id)
    if body.option_id is not None:
        option = await db.get(BlockerOption, body.option_id)
        if option is None or option.blocker_id != entity.id:
            raise InvalidError("The option is not one of this blocker's options")
    await _check_user(db, body.owner_id)
    await _check_evidence(db, body.evidence_ids)
    exp = FeasibilityExperiment(
        blocker_id=entity.id,
        option_id=body.option_id,
        hypothesis=body.hypothesis,
        method=body.method,
        success_threshold=body.success_threshold,
        owner_id=body.owner_id,
        decision_gate_at=body.decision_gate_at,
        evidence_ids=_dedupe(body.evidence_ids),
    )
    db.add(exp)
    await db.flush()
    await audit.record(
        db,
        principal,
        "feasibility_experiment.created",
        "feasibility_experiment",
        exp.id,
        {
            "blocker_id": str(entity.id),
            "option_id": str(body.option_id) if body.option_id else None,
        },
    )
    return exp


async def update_experiment(
    db: AsyncSession,
    principal: Principal,
    experiment_id: uuid.UUID,
    body: FeasibilityExperimentPatch,
) -> FeasibilityExperiment:
    exp = await _experiment(db, experiment_id)
    entity, spec = await get_blocker(db, exp.blocker_id, for_update=True)
    expect_version(exp, body.lock_version)
    given = body.model_fields_set - {"lock_version"}
    old_status = exp.status
    new_status = body.status if "status" in given and body.status else old_status
    if new_status != old_status:
        if old_status in EXPERIMENT_TERMINAL:
            raise ConflictError(f"The experiment already concluded ({old_status})")
        if new_status == "planned":
            raise InvalidError("A started experiment cannot go back to planned")
    if "owner_id" in given:
        await _check_user(db, body.owner_id)
    if "evidence_ids" in given:
        await _check_evidence(db, body.evidence_ids or [])
        exp.evidence_ids = _dedupe(body.evidence_ids or [])
    for name in (
        "hypothesis",
        "method",
        "success_threshold",
        "owner_id",
        "decision_gate_at",
        "result",
    ):
        if name in given and not (name == "hypothesis" and body.hypothesis is None):
            setattr(exp, name, getattr(body, name))
    if new_status in ("succeeded", "failed", "inconclusive") and not (exp.result or "").strip():
        raise InvalidError("Record the result when an experiment concludes")
    exp.status = new_status
    await flush_or_conflict(db)
    if new_status != old_status:
        kind = "experiment_started" if new_status == "running" else "experiment_concluded"
        await _event(
            db,
            principal,
            entity,
            kind,
            experiment_id=exp.id,
            option_id=exp.option_id,
            data={"from": old_status, "to": new_status, "result": exp.result},
        )
        if (
            new_status in EXPERIMENT_TERMINAL
            and new_status != "succeeded"
            and spec.status == "feasibility_only"
            and await _scope_experiment_id(db, entity.id) == exp.id
        ):
            await _transition(
                db,
                principal,
                entity,
                spec,
                "open",
                kind="status_changed",
                reason=f"The feasibility experiment {new_status}; its scope no longer holds",
                cause="feasibility_scope_withdrawn",
                experiment_id=exp.id,
            )
    await audit.record(
        db,
        principal,
        "feasibility_experiment.updated",
        "feasibility_experiment",
        exp.id,
        {"fields": sorted(given), "from": old_status, "to": new_status},
    )
    return exp


async def _scope_experiment_id(db: AsyncSession, blocker_id: uuid.UUID) -> uuid.UUID | None:
    last = await _last_status_events(db, [blocker_id])
    event = last.get(blocker_id)
    if event is not None and event.kind == "feasibility_scope_approved":
        return event.experiment_id
    return None


# --- the readiness gate per blocker ------------------------------------------------------


async def _last_status_events(
    db: AsyncSession, blocker_ids: list[uuid.UUID]
) -> dict[uuid.UUID, BlockerResolutionEvent]:
    """The latest recorded event that set each blocker's status."""
    if not blocker_ids:
        return {}
    rows = (
        await db.scalars(
            select(BlockerResolutionEvent)
            .where(
                BlockerResolutionEvent.blocker_id.in_(blocker_ids),
                BlockerResolutionEvent.to_status.is_not(None),
            )
            .order_by(BlockerResolutionEvent.created_at.desc(), BlockerResolutionEvent.id.desc())
        )
    ).all()
    out: dict[uuid.UUID, BlockerResolutionEvent] = {}
    for r in rows:
        out.setdefault(r.blocker_id, r)
    return out


async def _last_gate_snapshots(
    db: AsyncSession, blocker_ids: list[uuid.UUID]
) -> dict[uuid.UUID, dict[str, Any]]:
    """The gate snapshot the latest recording event left for each blocker."""
    if not blocker_ids:
        return {}
    rows = (
        await db.scalars(
            select(BlockerResolutionEvent)
            .where(
                BlockerResolutionEvent.blocker_id.in_(blocker_ids),
                BlockerResolutionEvent.data.has_key("gate"),
            )
            .order_by(BlockerResolutionEvent.created_at.desc(), BlockerResolutionEvent.id.desc())
        )
    ).all()
    out: dict[uuid.UUID, dict[str, Any]] = {}
    for r in rows:
        if r.blocker_id not in out and isinstance(r.data.get("gate"), dict):
            out[r.blocker_id] = r.data["gate"]
    return out


@dataclass
class GateInputs:
    """What :func:`assess` needs, loaded in bulk for many blockers."""

    last_event: dict[uuid.UUID, BlockerResolutionEvent] = field(default_factory=dict)
    decisions: dict[uuid.UUID, AssumptionDecision] = field(default_factory=dict)
    experiments: dict[uuid.UUID, FeasibilityExperiment] = field(default_factory=dict)
    # The gate snapshot last recorded for each blocker (see gate_snapshot); none for a
    # legacy-unrecorded blocker. Loading these never writes.
    recorded_gate: dict[uuid.UUID, dict[str, Any]] = field(default_factory=dict)
    # The Company time zone: the rationales name their days in it (#463).
    zone: str = company_time.DEFAULT_ZONE


async def gate_inputs(db: AsyncSession, blocker_ids: list[uuid.UUID]) -> GateInputs:
    last = await _last_status_events(db, blocker_ids)
    decision_ids = []
    for e in last.values():
        raw = (e.data or {}).get("assumption_decision_id")
        if e.kind == "risk_accepted" and raw:
            try:
                decision_ids.append(uuid.UUID(raw))
            except ValueError:
                pass
    experiment_ids = [e.experiment_id for e in last.values() if e.experiment_id]
    decisions = {}
    if decision_ids:
        decisions = {
            d.id: d
            for d in (
                await db.scalars(
                    select(AssumptionDecision).where(AssumptionDecision.id.in_(decision_ids))
                )
            ).all()
        }
    experiments = {}
    if experiment_ids:
        experiments = {
            x.id: x
            for x in (
                await db.scalars(
                    select(FeasibilityExperiment).where(
                        FeasibilityExperiment.id.in_(experiment_ids)
                    )
                )
            ).all()
        }
    recorded_gate = await _last_gate_snapshots(db, blocker_ids)
    zone = await company_time.company_time_zone(db)
    return GateInputs(last, decisions, experiments, recorded_gate, zone)


def _name(entity: Entity) -> str:
    return f"'{entity.title}' ({entity.key})"


def _date(value: Any) -> datetime | None:
    if isinstance(value, datetime):
        return _aware(value)
    if isinstance(value, str):
        try:
            return _aware(datetime.fromisoformat(value))
        except ValueError:
            return None
    return None


def _day(moment: datetime, inputs: GateInputs) -> str:
    """A rationale's day: the Company day of ``moment`` (#463)."""
    return company_time.day(moment, inputs.zone).isoformat()


def assess(entity: Entity, spec: BlockerSpec | None, inputs: GateInputs) -> BlockerGate:
    """This blocker's readiness: ``critical`` for a critical hard blocker that is
    unresolved, unless its status rests on a recorded, still valid decision: a
    resolution, a risk acceptance before its review date, or a scoped feasibility
    experiment within its decision gate. Fails closed: a strategy that cannot be read,
    or that disagrees with the last snapshot its events recorded, is ``critical``. A
    blocker with no snapshot at all (legacy-unrecorded: migration 0014 did not reach it
    and no write has recorded one yet) is judged on its current strategy."""
    if spec is None:
        return BlockerGate(
            status="critical",
            rationale=f"The blocker strategy of {_name(entity)} cannot be read; it cannot vouch "
            "for readiness until it is fixed",
        )
    recorded_gate = inputs.recorded_gate.get(entity.id)
    if recorded_gate is None:
        recorded_gate = gate_snapshot(spec)
    if recorded_gate != gate_snapshot(spec):
        return BlockerGate(
            status="critical",
            rationale=f"Blocker {_name(entity)} was changed outside the blocker strategy "
            "(its type, severity, status or documents differ from the last recorded "
            "decision); restore it or change it through the blocker routes",
        )
    gating = _gating(recorded_gate)
    if not gating:
        if spec.status in UNRESOLVED and (
            spec.type in ("hard", "unknown") or spec.severity == "critical"
        ):
            what = f"{spec.type.capitalize()} {spec.severity}"
            return BlockerGate(
                status="warning",
                rationale=f"{what} blocker {_name(entity)} is {spec.status}; "
                "research it or decide a path",
            )
        return BlockerGate(status="pass", rationale=f"{_name(entity)} does not stop a publish")
    event = inputs.last_event.get(entity.id)
    recorded = event.to_status if event else None
    if recorded != spec.status:
        return BlockerGate(
            status="critical",
            rationale=f"Critical hard blocker {_name(entity)} says '{spec.status}', but that "
            "status was set outside the blocker strategy (no recorded decision); set it "
            "through the blocker routes",
        )
    if spec.status in UNRESOLVED:
        return BlockerGate(
            status="critical",
            rationale=f"Critical hard blocker {_name(entity)} is unresolved ({spec.status}); "
            "resolve it, approve a scoped feasibility experiment or accept the risk",
        )
    if spec.status == "resolved":
        return BlockerGate(
            status="pass",
            rationale=f"{_name(entity)} is resolved: {event.reason or 'no reason given'}",
        )
    if spec.status == "accepted_risk":
        raw = (event.data or {}).get("assumption_decision_id")
        decision = None
        try:
            decision = inputs.decisions.get(uuid.UUID(raw)) if raw else None
        except ValueError:
            decision = None
        if (
            event.kind != "risk_accepted"
            or decision is None
            or decision.decision != "accept_risk"
            or decision.entity_id != entity.id
        ):
            return BlockerGate(
                status="critical",
                rationale=f"{_name(entity)} has no valid risk acceptance on record",
            )
        if decision.review_at is not None and _aware(decision.review_at) <= _now():
            return BlockerGate(
                status="critical",
                rationale=f"The accepted risk of {_name(entity)} is past its review date "
                f"({_day(decision.review_at, inputs)}); review it again",
            )
        until = _day(decision.review_at, inputs) if decision.review_at else "no date"
        return BlockerGate(
            status="pass",
            rationale=f"Risk of {_name(entity)} accepted by {event.actor} until {until}: "
            f"{decision.rationale}",
        )
    # feasibility_only
    exp = inputs.experiments.get(event.experiment_id) if event.experiment_id else None
    if event.kind != "feasibility_scope_approved" or exp is None:
        return BlockerGate(
            status="critical",
            rationale=f"{_name(entity)} has no approved feasibility experiment on record",
        )
    if exp.status not in SCOPE_EXPERIMENT:
        return BlockerGate(
            status="critical",
            rationale=f"The feasibility experiment of {_name(entity)} {exp.status}; the scope "
            "no longer holds",
        )
    missing = [
        what
        for what, ok in (
            ("an owner", exp.owner_id is not None),
            ("a success threshold", bool((exp.success_threshold or "").strip())),
        )
        if not ok
    ]
    if missing:
        return BlockerGate(
            status="critical",
            rationale=f"The feasibility experiment of {_name(entity)} no longer has "
            f"{' or '.join(missing)}; the scope no longer holds",
        )
    # The scope holds until the decision gate approved with it; moving the experiment's
    # date later needs a new approval, moving it earlier shortens the scope.
    dates = [
        d
        for d in (_date((event.data or {}).get("decision_gate_at")), _date(exp.decision_gate_at))
        if d is not None
    ]
    gate_at = min(dates) if dates else None
    if gate_at is None or gate_at <= _now():
        when = _day(gate_at, inputs) if gate_at else "no date"
        if exp.status == "succeeded":
            return BlockerGate(
                status="critical",
                rationale=f"The feasibility experiment of {_name(entity)} succeeded, but its "
                f"time box ended at its decision gate ({when}); resolve the blocker or "
                "approve a new scope",
            )
        return BlockerGate(
            status="critical",
            rationale=f"The feasibility scope of {_name(entity)} passed its decision gate "
            f"({when}); decide: resolve the blocker, accept the risk or approve a new scope",
        )
    return BlockerGate(
        status="pass",
        rationale=f"{_name(entity)} proceeds only as a scoped feasibility experiment "
        f"({exp.status}) until {_day(gate_at, inputs)}: {exp.hypothesis}",
    )


def safe_spec(entity: Entity) -> BlockerSpec | None:
    try:
        return spec_of(entity)
    except BlockerError:
        return None


# --- reads ----------------------------------------------------------------------------------


async def blockers_for_document(db: AsyncSession, document_id: uuid.UUID) -> list[Entity]:
    """Constraint entities with a strategy that gate this document: listed in their
    ``document_ids``, linked from one of its sections, or listed in their last recorded
    gate snapshot (so a strategy edited or removed around the blocker routes still
    gates, and fails closed in :func:`assess`). An archived (rejected) or deleted
    constraint no longer gates; archiving one that still gates takes the B4 role
    (:func:`require_archiver`)."""
    linked = set(
        (
            await db.scalars(
                select(DocumentSectionLink.entity_id).where(
                    DocumentSectionLink.document_id == document_id,
                    DocumentSectionLink.entity_id.is_not(None),
                )
            )
        ).all()
    )
    recorded = select(BlockerResolutionEvent.blocker_id).where(
        BlockerResolutionEvent.data.contains({"gate": {"document_ids": [str(document_id)]}})
    )
    with_events = select(BlockerResolutionEvent.blocker_id).where(
        BlockerResolutionEvent.data.has_key("gate")
    )
    listed = Entity.attrs.contains({"blocker": {"document_ids": [str(document_id)]}})
    stmt = select(Entity).where(
        Entity.type == "constraint",
        Entity.status != "rejected",
        or_(Entity.attrs.has_key("blocker"), Entity.id.in_(with_events)),
        or_(listed, Entity.id.in_(linked), Entity.id.in_(recorded)),
    )
    candidates = list((await db.scalars(stmt)).all())
    snapshots = await _last_gate_snapshots(db, [e.id for e in candidates])
    doc = str(document_id)
    out = []
    for e in candidates:
        raw = (e.attrs or {}).get("blocker")
        in_attrs = isinstance(raw, dict) and doc in [str(d) for d in raw.get("document_ids") or []]
        in_snapshot = doc in (snapshots.get(e.id) or {}).get("document_ids", [])
        if in_attrs or e.id in linked or in_snapshot:
            out.append(e)
    return out


async def all_blockers(db: AsyncSession) -> list[Entity]:
    stmt = select(Entity).where(Entity.type == "constraint", Entity.attrs.has_key("blocker"))
    return list((await db.scalars(stmt.order_by(Entity.created_at, Entity.id))).all())


def rank(entity: Entity, spec: BlockerSpec | None, gate: BlockerGate) -> tuple:
    order = {"critical": 0, "warning": 1, "pass": 2, "not_applicable": 3}
    sev = SEVERITY_RANK.get(spec.severity, 9) if spec else -1
    return (sev, order[gate.status], entity.title.lower(), str(entity.id))


def recommended_option(options: list[BlockerOption]) -> uuid.UUID | None:
    """The best reviewed, compliant, unflagged and not rejected option (advisory)."""
    score = {"high": 3, "medium": 2, "low": 1, "unknown": 0}
    candidates = [
        o
        for o in options
        if o.compliance == "compliant" and o.status != "rejected" and not flags_of(o)
    ]
    if not candidates:
        return None
    best = max(
        candidates,
        key=lambda o: (
            score[o.technical_feasibility] + score[o.policy_feasibility],
            score[o.policy_feasibility],
            -o.created_at.timestamp(),
        ),
    )
    return best.id


def grouped(rows: list[Any], attr: str = "blocker_id") -> dict[uuid.UUID, list[Any]]:
    out: dict[uuid.UUID, list[Any]] = defaultdict(list)
    for r in rows:
        out[getattr(r, attr)].append(r)
    return out
