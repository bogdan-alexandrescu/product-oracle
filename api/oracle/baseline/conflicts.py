"""Competing claims about one field of an entity or edge (B3).

A claim's confidence is ``confidence.aggregate`` of its evidence. The higher
confidence wins (``confidence.prefer``); within the tie margin the source precedence
decides (code > tracker > docs > meetings > chat), then the newer claim. A conflict
is **material** when the winner would change a feature's status, a goal link or an
input to prioritisation: it stays ``open`` (escalated) for an approver. Otherwise it
is ``logged``, and a winner that differs from the current value is written as an
agent write (so a locked item gets a proposal instead).
"""

import functools
import uuid
from datetime import datetime
from typing import Any

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from oracle import audit, confidence
from oracle.auth.deps import Principal
from oracle.baseline import scoring
from oracle.baseline.models import Conflict, Edge, Entity, Evidence
from oracle.baseline.schemas import ClaimIn
from oracle.baseline.service import (
    ConflictError,
    InvalidError,
    NotFoundError,
    Writer,
    get_edge,
    get_entity,
    lock,
    update_edge,
    update_entity,
)
from oracle.sources.models import Source, SourceItem

# Strongest first (B3: code > tracker > docs > chat; meetings sit between docs and chat).
PRECEDENCE = ("code", "tracker", "docs", "meeting", "chat")
SOURCE_CLASS = {
    "github": "code",
    "github:pull_request": "code",
    "github:release": "code",
    "github:readme": "code",
    "github:file": "code",
    "github:issue": "tracker",
    "github:milestone": "tracker",
    "linear": "tracker",
    "jira": "tracker",
    "notion": "docs",
    "google_docs": "docs",
    "upload": "docs",
    "fireflies": "meeting",
    "slack": "chat",
}
# Feature fields that feed prioritisation (goal-weighted, RICE, MoSCoW, WSJF).
PRIORITY_INPUTS = {
    "effort",
    "confidence",
    "reach",
    "impact",
    "value",
    "priority",
    "moscow",
    "business_value",
    "time_criticality",
    "risk_reduction",
    "job_size",
}


def source_class(kind: str | None) -> str | None:
    if not kind:
        return None
    if kind in PRECEDENCE:
        return kind
    return SOURCE_CLASS.get(kind) or SOURCE_CLASS.get(kind.split(":", 1)[0])


def _rank(kind: str | None) -> int:
    cls = source_class(kind)
    return PRECEDENCE.index(cls) if cls else len(PRECEDENCE)


def normalize_field(field: str, *, edge: bool) -> str:
    plain = ("status",) if edge else ("title", "body", "status")
    if field in plain or field.startswith("attrs."):
        if field.startswith("attrs.") and len(field) == len("attrs."):
            raise InvalidError("attrs field needs a key, e.g. attrs.effort")
        return field
    if field in ("title", "body"):
        raise InvalidError(f"an edge has no {field}")
    return f"attrs.{field}"


def current_value(target: Entity | Edge, field: str) -> Any:
    if field.startswith("attrs."):
        return (target.attrs or {}).get(field[len("attrs.") :])
    return getattr(target, field)


def changes_for(field: str, value: Any) -> dict[str, Any]:
    if field.startswith("attrs."):
        return {"attrs": {field[len("attrs.") :]: value}}
    return {field: value}


def is_material_field(target: Entity | Edge, field: str) -> bool:
    if isinstance(target, Edge):
        return target.type == "supports"  # a goal link
    key = field[len("attrs.") :] if field.startswith("attrs.") else field
    if target.type == "feature":
        return key == "status" or key in PRIORITY_INPUTS
    if target.type == "goal":
        return key in ("status", "weight")
    return False


async def _claim_rows(db: AsyncSession, claims: list[ClaimIn]) -> list[dict[str, Any]]:
    ids = {i for c in claims for i in c.evidence_ids}
    evidence = {
        e.id: e for e in (await db.scalars(select(Evidence).where(Evidence.id.in_(ids)))).all()
    }
    missing = ids - set(evidence)
    if missing:
        raise InvalidError(f"unknown evidence: {', '.join(sorted(map(str, missing)))}")
    item_ids = {e.source_item_id for e in evidence.values() if e.source_item_id}
    kinds: dict[uuid.UUID, str] = {}
    if item_ids:
        rows = await db.execute(
            select(SourceItem, Source)
            .join(Source, Source.id == SourceItem.source_id)
            .where(SourceItem.id.in_(item_ids))
        )
        kinds = {i.id: scoring.source_kind_of(s, i) for i, s in rows.all()}

    out = []
    for c in claims:
        evs = [evidence[i] for i in c.evidence_ids]
        conf = confidence.aggregate([float(e.confidence) for e in evs if e.confidence is not None])
        kind = c.source_kind
        if kind is None:
            candidates = [kinds.get(e.source_item_id, scoring.FREE_STANDING_KIND) for e in evs]
            kind = min(candidates, key=_rank) if candidates else None
        observed = c.observed_at
        if observed is None:
            stamps = []
            for e in evs:
                latest = ((e.confidence_factors or {}).get("inputs") or {}).get("latest_at")
                stamps.append(datetime.fromisoformat(latest) if latest else e.retrieved_at)
            stamps = [s for s in stamps if s]
            observed = max(stamps) if stamps else None
        out.append(
            {
                "value": c.value,
                "evidence_ids": [str(i) for i in c.evidence_ids],
                "source_kind": kind,
                "source_class": source_class(kind),
                "observed_at": observed.isoformat() if observed else None,
                "confidence": conf,
            }
        )
    return out


def _compare(a: dict, b: dict, settings: dict) -> tuple[int, str]:
    """>0 when a wins, <0 when b wins, 0 on a full tie; with the deciding rule."""
    ca, cb = a["confidence"] or 0.0, b["confidence"] or 0.0
    by_conf = confidence.prefer(ca, cb, settings)
    if by_conf:
        return by_conf, f"confidence {max(ca, cb):.2f} beats {min(ca, cb):.2f}"
    tie = f"confidence tie ({ca:.2f} vs {cb:.2f})"
    ra, rb = _rank(a["source_kind"]), _rank(b["source_kind"])
    if ra != rb:
        win, lose = (a, b) if ra < rb else (b, a)
        return (1 if ra < rb else -1), (
            f"{tie}; {win['source_class'] or win['source_kind']} beats "
            f"{lose['source_class'] or lose['source_kind'] or 'unknown source'}"
        )
    oa, ob = a["observed_at"] or "", b["observed_at"] or ""
    if oa != ob:
        newer, older = (oa, ob) if oa > ob else (ob, oa)
        return (1 if oa > ob else -1), (
            f"{tie}; same precedence; newer ({newer[:10]}) beats older ({older[:10] or 'undated'})"
        )
    return 0, f"{tie}; same precedence and date"


def pick_winner(claims: list[dict], settings: dict) -> tuple[int | None, str]:
    """Index of the winning claim and why; None when the top two cannot be separated."""
    order = sorted(
        range(len(claims)),
        key=functools.cmp_to_key(lambda i, j: -_compare(claims[i], claims[j], settings)[0]),
    )
    first, second = order[0], order[1]
    result, reason = _compare(claims[first], claims[second], settings)
    return (first if result else None), reason


async def _target(
    db: AsyncSession, entity_id: uuid.UUID | None, edge_id: uuid.UUID | None
) -> Entity | Edge:
    if (entity_id is None) == (edge_id is None):
        raise InvalidError("a conflict is about exactly one entity_id or edge_id")
    return await get_entity(db, entity_id) if entity_id else await get_edge(db, edge_id)


async def _apply(
    db: AsyncSession, writer: Writer, target: Entity | Edge, field: str, value: Any
) -> dict[str, Any]:
    changes = changes_for(field, value)
    if isinstance(target, Entity):
        result = await update_entity(db, writer, target, changes)
    else:
        result = await update_edge(db, writer, target, changes)
    proposal_id = str(result.proposal.id) if result.proposal else None
    return {"applied": result.applied, "proposal_id": proposal_id}


async def record(
    db: AsyncSession,
    principal: Principal,
    *,
    entity_id: uuid.UUID | None,
    edge_id: uuid.UUID | None,
    field: str,
    claims: list[ClaimIn],
    run_id: uuid.UUID | None = None,
) -> Conflict:
    target = await _target(db, entity_id, edge_id)
    field = normalize_field(field, edge=isinstance(target, Edge))
    rows = await _claim_rows(db, claims)
    settings = await scoring.company_weights(db)
    winner, reason = pick_winner(rows, settings)
    current = current_value(target, field)

    conflict = Conflict(
        entity_id=entity_id, edge_id=edge_id, field=field, claims=rows, material=False
    )
    resolution: dict[str, Any] = {"rule": reason, "decided_by": "precedence", "current": current}
    material_field = is_material_field(target, field)
    if winner is None:
        # Nothing separates the claims: ask a person when it matters, else keep as is.
        conflict.material = material_field
        conflict.status = "open" if material_field else "logged"
        resolution.update(winner=None, applied=False)
    else:
        value = rows[winner]["value"]
        resolution.update(winner=winner, value=value)
        if value == current:
            conflict.status = "logged"
            resolution["applied"] = False
        elif material_field:
            conflict.material = True
            conflict.status = "open"
            resolution["applied"] = False
        else:
            conflict.status = "logged"
            writer = Writer(principal, "agent", run_id=run_id, reason=f"conflict: {reason}")
            resolution.update(await _apply(db, writer, target, field, value))
    conflict.resolution = resolution
    db.add(conflict)
    await db.flush()
    await audit.record(
        db,
        principal,
        "baseline.conflict.recorded",
        "conflict",
        conflict.id,
        {"status": conflict.status, "material": conflict.material},
    )
    return conflict


async def resolve(
    db: AsyncSession,
    principal: Principal,
    conflict_id: uuid.UUID,
    *,
    claim: int | None,
    value: Any,
    note: str | None,
) -> Conflict:
    conflict = await db.get(Conflict, conflict_id)
    if conflict is None:
        raise NotFoundError("Conflict not found")
    if conflict.status == "resolved":
        raise ConflictError("Conflict is already resolved")
    if claim is not None:
        if not 0 <= claim < len(conflict.claims):
            raise InvalidError("claim index out of range")
        value = conflict.claims[claim]["value"]
    elif value is None:
        raise InvalidError("pick a claim or give a value")
    target = await _target(db, conflict.entity_id, conflict.edge_id)
    writer = Writer(principal, "user", reason=note or f"resolved conflict {conflict.id}")
    applied = await _apply(db, writer, target, conflict.field, value)
    # A person's call, even when it keeps the current value: agents must ask to change it.
    lock(target, writer)
    conflict.resolution = {
        **(conflict.resolution or {}),
        "winner": claim,
        "value": value,
        "decided_by": principal.actor,
        "note": note,
        **applied,
    }
    conflict.status = "resolved"
    await audit.record(db, principal, "baseline.conflict.resolved", "conflict", conflict.id)
    await db.flush()
    return conflict


async def list_conflicts(
    db: AsyncSession, status: str | None = None, material: bool | None = None
) -> list[Conflict]:
    stmt = select(Conflict).order_by(Conflict.created_at.desc())
    if status:
        stmt = stmt.where(Conflict.status == status)
    if material is not None:
        stmt = stmt.where(Conflict.material == material)
    return list((await db.scalars(stmt)).all())
