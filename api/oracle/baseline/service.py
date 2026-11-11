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

import re
import uuid
from collections.abc import AsyncIterator, Iterable
from contextlib import asynccontextmanager
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Any, Literal

from sqlalchemy import and_, func, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from oracle import audit, changes
from oracle.auth.deps import Principal
from oracle.baseline import goals, scoring
from oracle.baseline.goal_order import goal_sort_key
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
# H5: the ``reading`` writer (a weekly value read from a goal's linked metric) changes
# only these goal attrs; it applies even to a locked goal and never locks it.
READING_ATTRS = ("current", "current_as_of")
# attrs keys a module owns, and the routes that change them.
MANAGED_ATTRS = {
    "blocker": "the blocker routes (/v1/blockers)",
    # A decided judgement call's entity (H1): the decision log keeps it in step.
    "decision_id": "the decision log (/v1/decisions)",
    # An intake answer's marks (B4): which intake and gap it came from and the blocker it
    # suggests. Set only by the answer's own proposal; Promote clears the suggestion.
    "proposed_blocker": "an intake answer (POST /v1/questions/{id}/answers)",
    "gap_id": "an intake answer (POST /v1/questions/{id}/answers)",
    "intake_id": "an intake answer (POST /v1/questions/{id}/answers)",
}
INTAKE_ATTRS = ("proposed_blocker", "gap_id", "intake_id")
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
    origin: str  # user | agent | import | reading
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
        if self.locks or self.origin == "reading":
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


def revise(
    db: AsyncSession,
    actor: str,
    entity: Entity,
    before: dict[str, Any] | None,
    reason: str | None = None,
) -> None:
    """goal-target-kept: a write made outside :func:`update_entity` (Simple's goal edits)
    still leaves its revision, ``before`` being :func:`entity_snapshot` taken before it
    (None: it was created); nothing when it changed nothing."""
    after = entity_snapshot(entity)
    if after != before:
        db.add(EntityRevision(entity_id=entity.id, before=before, after=after, actor=actor,
                              reason=reason))  # fmt: skip


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
    """The entity of that type and key; for a feature, also the one that had ``key`` before
    (its code given when it joined the Ground Truth: the old key stays its alias)."""
    if type_ == "feature":
        from oracle.baseline import fixes

        return (await fixes.features_by_keys(db, [key])).get(key)
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


def _check_reading(entity: Entity, changes: dict[str, Any]) -> None:
    """A reading writes a goal's current value and its day, nothing else."""
    attrs = changes.get("attrs")
    if (
        entity.type != "goal"
        or set(changes) != {"attrs"}
        or not isinstance(attrs, dict)
        or set(attrs) - set(READING_ATTRS)
    ):
        raise InvalidError("a metric's reading changes only a goal's current value")


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
    role: str | None = None,
) -> Proposal:
    """A proposal, or the identical open one already there (so repeats are idempotent).
    A run's proposal of a change it already proposed is marked as that one's duplicate."""
    if kind == "entity" and op in ("create", "update"):
        _check_fields_managed_attrs(writer, entity, fields)
    payload = _jsonable(
        {"op": op, "kind": kind, "fields": fields, "reason": writer.reason, "origin": writer.origin}
    )
    if role:
        # The run's role that made it ("writer", "critic"): "Also proposed by Critic".
        payload["role"] = role
    if writer.manages:
        # Its acceptance may write these keys too (:func:`intake_made`).
        payload["manages"] = list(writer.manages)
    stmt = select(Proposal).where(
        Proposal.status == "open",
        Proposal.entity_id == entity.id if entity else Proposal.entity_id.is_(None),
        Proposal.edge_id == edge.id if edge else Proposal.edge_id.is_(None),
    )
    siblings = (await db.scalars(stmt.order_by(Proposal.created_at))).all()
    for existing in siblings:
        if existing.payload == payload:
            return existing
    if writer.run_id is not None:
        for existing in siblings:
            if existing.run_id == writer.run_id and same_change(existing.payload, payload):
                payload["duplicate_of"] = existing.payload.get("duplicate_of") or str(existing.id)
                break
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


_TITLE_LEAD = re.compile(r"^(add|new|a|an|the)\s+")


def _title_words(title: Any) -> list[str]:
    """A new item's title as words for comparing: no case, no leading "Add", no plural."""
    words = _TITLE_LEAD.sub("", str(title or "").strip().lower())
    return re.findall(r"[a-z0-9]+", re.sub(r"s\b", "", words))


def near_titles(a: Any, b: Any) -> bool:
    """Near-identical titles: "Saved carts" and "Add saved cart", "Saved addresses" and
    "Saved address" (the same words, the last with up to two letters more). A word or a
    number more is another item: "Search" and "Search v2", "Sharing" and "Sharing UI"."""
    x, y = sorted((_title_words(a), _title_words(b)), key=lambda w: len("".join(w)))
    if not x or len(x) != len(y) or x[:-1] != y[:-1] or not y[-1].startswith(x[-1]):
        return False
    more = y[-1][len(x[-1]) :]
    return not more or (len("".join(x)) >= 5 and len(more) <= 2 and more.isalpha())


def same_change(a: dict[str, Any], b: dict[str, Any]) -> bool:
    """Whether two proposals (on the same target) propose the same change, whatever the
    values: the same fields, the same link, a new item of the same type and key or a
    near-identical title, or the same removal."""
    from oracle.baseline.describe import _changes

    if (a.get("op"), a.get("kind")) != (b.get("op"), b.get("kind")):
        return False
    fa, fb = a.get("fields") or {}, b.get("fields") or {}
    if a.get("op") == "update":
        keys = {k for k, _ in _changes(fa)}
        return bool(keys) and keys == {k for k, _ in _changes(fb)}
    if a.get("op") == "delete":
        return True
    if a.get("kind") == "edge":
        return all(str(fa.get(k)) == str(fb.get(k)) for k in ("src_id", "dst_id", "type"))
    return fa.get("type") == fb.get("type") and (
        fa.get("key") == fb.get("key") or near_titles(fa.get("title"), fb.get("title"))
    )


def agrees(a: dict[str, Any], b: dict[str, Any]) -> bool:
    """Two marked duplicates that set every field alike (an update's values differ when
    they disagree: one sets Planned, the other Proposed)."""
    from oracle.baseline.describe import _changes, _same

    if a.get("op") != "update":
        return True
    theirs = dict(_changes(b.get("fields") or {}))
    return all(_same(v, theirs.get(k)) for k, v in _changes(a.get("fields") or {}))


async def duplicates(
    db: AsyncSession, proposals: list[Proposal]
) -> tuple[dict[uuid.UUID, uuid.UUID | None], dict[uuid.UUID, list[Proposal]]]:
    """({id: the open proposal it duplicates}, {id: its open duplicates, oldest first}),
    for the open proposals among these."""
    dup_of: dict[uuid.UUID, uuid.UUID | None] = {p.id: None for p in proposals}
    also: dict[uuid.UUID, list[Proposal]] = {p.id: [] for p in proposals}
    open_ = [p for p in proposals if p.status == "open"]
    roots = {str(r) for p in open_ if (r := _uuid_or_none(p.payload.get("duplicate_of")))}
    keys = roots | {str(p.id) for p in open_}
    if not keys:
        return dup_of, also
    rows = await db.scalars(
        select(Proposal)
        .where(Proposal.status == "open", Proposal.payload["duplicate_of"].astext.in_(keys))
        .order_by(Proposal.created_at)
    )
    groups: dict[str, list[Proposal]] = {}
    for d in rows.all():
        groups.setdefault(d.payload["duplicate_of"], []).append(d)
    live = set(
        (await db.scalars(select(Proposal.id).where(
            Proposal.id.in_([uuid.UUID(r) for r in groups]), Proposal.status == "open"
        ))).all()
    )  # fmt: skip
    for root, group in groups.items():
        # A group whose first proposal closed alone stays one card, on its oldest.
        lead = uuid.UUID(root) if uuid.UUID(root) in live else group[0].id
        for d in group:
            if d.id == lead:
                continue
            if lead in also:
                also[lead].append(d)
            if d.id in dup_of:
                dup_of[d.id] = lead
    return dup_of, also


ALREADY_DONE_NOTE = "Already done"
NOT_CHOSEN_NOTE = "Another choice was accepted"


async def _no_op(db: AsyncSession, p: Proposal) -> bool:
    """Whether an open proposal would change nothing now."""
    from oracle.baseline.describe import _changes, _real

    payload, fields = p.payload, p.payload.get("fields") or {}
    if payload.get("op") == "update":
        target = await db.get(Entity, p.entity_id) if p.entity_id else None
        if p.edge_id:
            target = await db.get(Edge, p.edge_id)
        return target is not None and not _real(_changes(fields), target)
    if payload.get("op") != "create":
        return False
    if payload.get("kind") == "edge":
        src, dst = _uuid_or_none(fields.get("src_id")), _uuid_or_none(fields.get("dst_id"))
        return bool(src and dst) and await find_edge(db, src, dst, fields.get("type")) is not None
    return await find_entity(db, fields.get("type"), fields.get("key")) is not None


async def close_siblings(db: AsyncSession, accepted: Proposal, principal: Principal) -> list[str]:
    """After an accept: the open proposals it made no-ops close as already done, at once;
    a disagreeing duplicate of it closes as not chosen. Those that would undo it stay open
    (their overlaps say so). Returns the ids closed as already done."""
    from oracle.baseline.describe import summaries

    root = accepted.payload.get("duplicate_of") or str(accepted.id)
    near = [Proposal.payload["duplicate_of"].astext == root, Proposal.id == uuid.UUID(root)]
    if accepted.payload.get("op") == "create":
        # Only a new item of its type (a link between the same two items) can be made a no-op.
        made, fields = accepted.payload.get("fields") or {}, Proposal.payload["fields"]
        same_item = (
            [fields[k].astext == str(made.get(k)) for k in ("src_id", "dst_id", "type")]
            if accepted.payload.get("kind") == "edge"
            else [fields["type"].astext == str(made.get("type"))]
        )
        near.append(and_(
            Proposal.entity_id.is_(None), Proposal.edge_id.is_(None),
            Proposal.payload["op"].astext == "create",
            Proposal.payload["kind"].astext == accepted.payload.get("kind"),
            *same_item,
        ))  # fmt: skip
    if accepted.entity_id:
        near.append(Proposal.entity_id == accepted.entity_id)
    if accepted.edge_id:
        near.append(Proposal.edge_id == accepted.edge_id)
    rows = (
        await db.scalars(
            select(Proposal)
            .where(Proposal.status == "open", Proposal.id != accepted.id, or_(*near))
            .order_by(Proposal.created_at)
        )
    ).all()
    closing: list[tuple[Proposal, str]] = []
    for p in rows:
        grouped = (p.payload.get("duplicate_of") or str(p.id)) == root
        if grouped and not agrees(accepted.payload, p.payload):
            closing.append((p, "not_chosen"))
        elif (grouped and same_change(accepted.payload, p.payload)) or await _no_op(db, p):
            closing.append((p, "already_done"))
    sentences = await summaries(db, [p for p, _ in closing])
    for p, outcome in closing:
        note = ALREADY_DONE_NOTE if outcome == "already_done" else NOT_CHOSEN_NOTE
        p.status = "accepted" if outcome == "already_done" else "rejected"
        p.decided_by, p.decided_at = principal.id, _now()
        p.payload = {**p.payload, "summary": sentences[p.id], "outcome": outcome, "note": note}
        await audit.record(
            db, principal, f"baseline.proposal.{p.status}", "proposal", p.id,
            {"note": note, "after": str(accepted.id)},
        )  # fmt: skip
    return [str(p.id) for p, outcome in closing if outcome == "already_done"]


SUPERSEDED_NOTE = "Superseded: the same run later applied this change directly"


async def supersede_run_proposals(db: AsyncSession, writer: Writer, entity: Entity) -> None:
    """A run's file applied to ``entity`` directly (a retried import, at Act): the same
    run's open proposals to create or change it are closed, as superseded by that change."""
    if writer.run_id is None:
        return
    fields = Proposal.payload["fields"]
    stmt = select(Proposal).where(
        Proposal.status == "open",
        Proposal.run_id == writer.run_id,
        Proposal.payload["kind"].astext == "entity",
        or_(
            and_(Proposal.entity_id == entity.id, Proposal.payload["op"].astext == "update"),
            and_(
                Proposal.entity_id.is_(None),
                Proposal.payload["op"].astext == "create",
                fields["type"].astext == entity.type,
                fields["key"].astext == entity.key,
            ),
        ),
    )
    for p in (await db.scalars(stmt)).all():
        p.status = "rejected"
        p.decided_by = writer.principal.id if writer.principal else None
        p.decided_at = _now()
        p.payload = {**p.payload, "note": SUPERSEDED_NOTE}
        await audit.record(
            db, writer.principal, "baseline.proposal.rejected", "proposal", p.id,
            {"note": SUPERSEDED_NOTE},
        )  # fmt: skip
    await db.flush()


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


async def intake_made(db: AsyncSession, proposals: list[Proposal]) -> set[uuid.UUID]:
    """The proposals an intake answer made, of those carrying an intake's marks: its
    writer managed them (``payload.manages``), or, proposed before payloads recorded
    that, it names an answer to the gap it carries, or it is that gap's question-only
    proposal. Anyone else's is not, whatever its attrs say."""
    from oracle.v2.models import StakeholderAnswer, StakeholderQuestion

    out: set[uuid.UUID] = set()
    for p in proposals:
        payload = p.payload or {}
        attrs = (payload.get("fields") or {}).get("attrs") or {}
        if not isinstance(attrs, dict) or not set(attrs) & set(INTAKE_ATTRS):
            continue
        if set(INTAKE_ATTRS) <= set(payload.get("manages") or ()):
            out.add(p.id)
        elif payload.get("origin") != "agent" or p.run_id is not None:
            continue
        elif "answer_id" in attrs:
            try:
                answer_id = uuid.UUID(str(attrs["answer_id"]))
            except ValueError:
                continue
            gap_id = await db.scalar(
                select(StakeholderQuestion.gap_id)
                .join(StakeholderAnswer, StakeholderAnswer.question_id == StakeholderQuestion.id)
                .where(StakeholderAnswer.id == answer_id)
            )
            if gap_id is not None and str(gap_id) == str(attrs.get("gap_id")):
                out.add(p.id)
        elif await awaits_answer(db, payload):
            out.add(p.id)
    return out


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
    """{run id: ProposalRun} for the runs that made these proposals, with their sources."""
    from oracle.docs.models import Document
    from oracle.docs.service import version_sources
    from oracle.runs.flows import FLOWS
    from oracle.runs.models import Run

    ids = {i for i in run_ids if i is not None}
    if not ids:
        return {}
    runs = (await db.scalars(select(Run).where(Run.id.in_(ids)))).all()

    def source_id(run: Run) -> uuid.UUID | None:
        raw = (run.knobs or {}).get("source_version_id")
        return uuid.UUID(raw) if raw else None

    sources = await version_sources(db, [source_id(r) for r in runs])
    doc_ids = {r.document_id for r in runs if r.document_id is not None}
    titles: dict[uuid.UUID, str] = {}
    if doc_ids:
        rows = await db.execute(select(Document.id, Document.title).where(Document.id.in_(doc_ids)))
        titles = {doc_id: title for doc_id, title in rows.all()}

    def source_title(run: Run) -> str | None:
        sid = source_id(run)
        found = sources.get(sid) if sid is not None else None
        if found is not None:
            return found.title
        return titles.get(run.document_id) if run.document_id is not None else None

    return {
        r.id: ProposalRun(
            id=r.id,
            flow=r.flow,
            flow_title=FLOWS[r.flow].title if r.flow in FLOWS else r.flow,
            status=r.status,
            created_at=r.created_at,
            source_title=source_title(r),
        )
        for r in runs
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
        # Only an intake answer's own proposal writes its marks (MANAGED_ATTRS).
        manages = INTAKE_ATTRS if proposal.id in await intake_made(db, [proposal]) else ()
        writer = Writer(principal, "user", run_id=proposal.run_id, reason=reason, manages=manages)
        fields = _without(dict(p.get("fields") or {}), skipped)
        if p.get("fix"):
            # A commenter's Ground Truth fix (Give it a code, Link to a feature).
            from oracle.baseline import fixes

            await fixes.apply_proposal(db, writer, proposal)
        elif p["kind"] == "entity":
            if p["op"] == "create":
                made = await create_entity(db, writer, **_entity_create_args(fields))
                if made.entity is not None:
                    await link_new_feature(
                        db, writer, made.entity, fields.get("serves"), fields.get("roadmap_item_id")
                    )
            else:
                target = await get_entity(db, proposal.entity_id or fields.get("id"))
                if p["op"] == "update":
                    await update_entity(db, writer, target, fields)
                else:
                    await _detach(db, proposal)
                    await delete_entity(db, writer, target)
        else:
            if p["op"] == "create":
                args = _edge_create_args(fields)
                if await find_edge(db, args["src_id"], args["dst_id"], args["type_"]):
                    # Made since it was proposed: nothing to do, and no error.
                    proposal.payload = {**proposal.payload, "outcome": "already_done",
                                        "note": "This link already exists"}  # fmt: skip
                else:
                    await create_edge(db, writer, **args)
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
        closed = await close_siblings(db, proposal, principal)
        if closed:
            proposal.payload = {**proposal.payload, "closed_as_done": closed}
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
    role: str | None = None,
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
        if kind == "entity" and (fields.get("serves") or fields.get("roadmap_item_id")):
            # lane-gt-ui: a commenter's Add to Ground Truth carries the goal and the item.
            if fields["type"] != "feature":
                raise InvalidError("Only a feature serves a goal or is a roadmap item.")
            for f in ("serves", "roadmap_item_id"):
                if fields.get(f) is not None:
                    fields[f] = str(_uuid_or_none(fields[f]))
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
    return await propose(
        db, writer, op=op, kind=kind, fields=fields, entity=entity, edge=edge, role=role
    )


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
            subject_ref=f"{len(entries)} Ground Truth items",
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
    if type_ == "feature":
        from oracle.baseline import fixes

        # A code key is stored as the check reads it (F-9 is F-09), and is one feature's.
        if (code := fixes.canonical_code(key)) is not None:
            key = code
            if await fixes.code_taken(db, code):
                raise ConflictError(f"Another feature already has the code {code}.")
    if (found := await find_entity(db, type_, key)) is not None:
        if found.key != key:
            # A key a feature had before it was given its code stays that feature's.
            name = f"{found.key} {found.title}" if fixes.canonical_code(found.key) else found.title
            raise ConflictError(f"The key {key} is {name}'s old key.")
        raise ConflictError(f"{type_}:{key} already exists")
    await check_parent(db, type_, parent_id)
    check_managed_attrs(writer, {}, attrs)
    kept: tuple[str, ...] = ()
    if type_ == "goal":
        attrs, kept = await _goal_attrs(db, writer, dict(attrs or {}))
        title, body = _goal_words(title, key), goals.without_placeholders(body)
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
    if type_ == "feature":
        # Its code as a revision of its own, so the key it was added with stays its alias.
        before = entity_snapshot(entity)
        await fixes.code_on_join(db, entity)
        fixes.took(db, entity)
        if entity.key != before["key"]:
            _revision(db, writer, before, entity_snapshot(entity), entity=entity)
    await db.flush()
    return WriteResult(entity=entity, kept_as_text=kept)


def _goal_words(title: str, key: str) -> str:
    """A goal's name, stripped, with no unfilled placeholder; a blank name is refused."""
    if not title.strip():
        raise InvalidError("A goal needs a name")
    return goals.goal_name(title, key)


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
    if writer.origin == "reading":
        _check_reading(entity, changes)
    _check_status(changes.get("status"))
    if "parent_id" in changes:
        changes = {**changes, "parent_id": _uuid_or_none(changes["parent_id"])}
        if changes["parent_id"] != entity.parent_id:
            await check_parent(db, entity.type, changes["parent_id"], entity)
    kept: tuple[str, ...] = ()
    if entity.type == "goal":
        if isinstance(changes.get("title"), str):
            changes = {**changes, "title": _goal_words(changes["title"], entity.key)}
        if isinstance(changes.get("body"), str):
            changes = {**changes, "body": goals.without_placeholders(changes["body"])}
    if entity.type == "goal" and isinstance(changes.get("attrs"), dict):
        target = changes["attrs"].get("target")
        if (
            isinstance(target, int | float)
            and not isinstance(target, bool)
            and "target_text" not in changes["attrs"]
            and (entity.attrs or {}).get("target_text")
        ):
            # A numeric target replaces an older typed one, so the goal never reads stale text.
            changes = {**changes, "attrs": {**changes["attrs"], "target_text": None}}
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
    if diff.get("status") == "confirmed":
        from oracle.baseline import fixes

        await fixes.code_on_join(db, entity)
    _revision(db, writer, before, entity_snapshot(entity), entity=entity)
    if entity.type == "goal" and ("title" in diff or "body" in diff):
        # A goal's name or description changed (the goal panel's Edit): who, from what, to what.
        await audit.record(
            db,
            writer.principal or writer.actor,
            "baseline.goal.renamed",
            "entity",
            entity.id,
            {
                "before": {"title": before["title"], "body": before.get("body")},
                "after": {"title": entity.title, "body": entity.body},
                "status": entity.status,
                "origin": writer.origin,
            },
        )
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
        if status == "confirmed":
            from oracle.baseline import fixes

            await fixes.code_on_join(db, entity)
        _revision(db, writer, before, entity_snapshot(entity), entity=entity)
        await scoring.rescore_around(db, [entity.id], include_supporters=True)
        await db.flush()
        await _record_change(db, writer.actor, entity, before, f"entity_{status}")
        if entity.type == "goal" and status == "confirmed":
            # The first confirmed goal turns on the built-in rituals waiting for it.
            from oracle.rituals.service import wake_on_first_goal

            await wake_on_first_goal(db)
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
    rows = list((await db.scalars(stmt)).all())
    # goal-order: goals in the one goal order, other types by key.
    return sorted(rows, key=lambda e: (e.type, goal_sort_key(e) if e.type == "goal" else ()))


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
        raise ConflictError("This link already exists")
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
    db: AsyncSession,
    principal: Principal,
    source: Entity,
    into: Entity,
    reason: str | None,
    any_run: bool = False,
) -> Entity:
    """Merge a duplicate a run created into ``into`` (B2 Merge into…): its evidence and
    edges move to the target (an edge the target already has, or one that would link the
    target to itself, is dropped), its open proposals are rejected "Merged into <title>",
    and it is deleted. A person's write: revisions on both and an audit row. Refused (409,
    nothing changed) unless both have the same type, a run created the source, nobody
    locked it and no PRD section links it. ``any_run``: a source a person made too (Simple
    Priorities' Same name merge, oracle.simple.priorities.merge_twin)."""
    from oracle.baseline.from_run import LINKED, LOCKED, NOT_SAME_TYPE, NOT_THIS_RUN

    if source.id == into.id or source.type != into.type:
        raise ConflictError(NOT_SAME_TYPE)
    if source.run_id is None and not any_run:
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
    from oracle.simple import twin_merges

    # A commenter's waiting proposal to merge it (Priorities' Propose a merge…) is closed too.
    await twin_merges.close_open(db, principal, source.id, note)
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


async def link_new_feature(
    db: AsyncSession,
    writer: Writer,
    feature: Entity,
    serves: Any = None,
    roadmap_item_id: Any = None,
) -> None:
    """lane-gt-ui: Add to Ground Truth in one write. The new feature serves ``serves`` (a
    supports link) and is the feature of roadmap item ``roadmap_item_id``: a set_feature change
    in the item's roadmap's working draft, made as the person (applied when they decide the
    roadmap, else a proposal to its decider, like every roadmap edit). Not committed."""
    from oracle.simple import changes, drafts
    from oracle.simple.schemas import SimpleChangeIn

    if serves:
        goal = _uuid_or_none(serves)
        g = await db.get(Entity, goal)
        if g is None or g.type != "goal":
            raise InvalidError("serves must be a goal")
        if await find_edge(db, feature.id, goal, "supports") is None:  # type: ignore[arg-type]
            await create_edge(db, writer, src_id=feature.id, dst_id=goal, type_="supports",
                              attrs={"contribution": 2})  # type: ignore[arg-type]  # fmt: skip
    if roadmap_item_id:
        from oracle.roadmap.models import RoadmapItem

        row = await db.get(RoadmapItem, _uuid_or_none(roadmap_item_id))
        if row is None:
            raise InvalidError("roadmap_item_id must be a roadmap item")
        now = (await drafts.effective_row(db, row)).feature_id
        body = SimpleChangeIn(op="set_feature", target={"item_id": str(row.id)},
                              before={"feature_id": str(now) if now else None},
                              after={"feature_id": str(feature.id)})  # fmt: skip
        try:
            await changes.create(db, writer.principal, body, commit=False)
        except changes.ChangeError as exc:
            raise InvalidError(str(exc)) from exc
        except drafts.DraftError as exc:
            # A submitted draft of the roadmap waits for approval: no change until it is decided.
            raise ConflictError(
                f"“{row.title}” can't be linked yet: its roadmap has a draft waiting for "
                "approval. Add it once that draft is approved or withdrawn."
                if exc.status == 409
                else str(exc)
            ) from exc
