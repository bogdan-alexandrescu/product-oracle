"""Load the baseline into the scoring inputs; store and read priority snapshots; people's
moves and pins on the ranking (C9), checked by Oracle's pushback before they are stored.

Readers see saved snapshots unless they ask for another status (C8): a run's order is
proposed until its priority stop is approved (oracle.priorities.run_order)."""

import hashlib
import uuid
from datetime import UTC, datetime, timedelta
from typing import Any

from sqlalchemy import func, or_, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from oracle import audit
from oracle import confidence as confidence_rules
from oracle.auth.deps import Principal
from oracle.auth.models import ApiToken, User
from oracle.baseline import evidence as baseline_evidence
from oracle.baseline import scoring as baseline_scoring
from oracle.baseline.models import Edge, Entity, Evidence
from oracle.models import AuditEvent
from oracle.priorities import pushback, reason_check
from oracle.priorities.models import PriorityOverride, PrioritySnapshot
from oracle.priorities.schemas import (
    CompareCheckpoint,
    CompareOut,
    CompareRow,
    CompareRun,
    OverrideCreate,
    OverrideOut,
    PriorityRanking,
    PrioritySnapshotOut,
    PrioritySnapshotSummary,
    RankedFeature,
    RankingCounts,
    SnapshotDocument,
)
from oracle.priorities.scoring import (
    EvidenceRef,
    FeatureInput,
    GoalLink,
    OverrideIn,
    apply_overrides,
    rank,
)
from oracle.sources.models import Source, SourceItem
from oracle.tenant_settings import TenantSetting


class NotFoundError(LookupError):
    pass


class InvalidError(ValueError):
    pass


class ConflictError(RuntimeError):
    pass


class ForbiddenError(PermissionError):
    pass


class Pushback(Exception):  # noqa: N818 - an answer, not a failure
    """Oracle disagrees: nothing was stored; the body is ``PushbackOut``."""

    def __init__(self, body: dict[str, Any]):
        super().__init__(body["detail"])
        self.body = body


def _float(value: Any) -> float | None:
    if isinstance(value, bool):
        return None
    if isinstance(value, int | float):
        return float(value)
    try:
        return float(value) if value is not None else None
    except (TypeError, ValueError):
        return None


def _contribution(value: Any) -> int | None:
    number = _float(value)
    return None if number is None else int(min(3, max(0, round(number))))


# The kind shown for a source item the reader may not see: its source is its owner's.
PRIVATE_KIND = "private_source"
# A source item cited: (title, kind of source, date, owner, deleted upstream).
CitedItem = tuple[str | None, str, datetime | None, uuid.UUID, bool]


def _cited_as(
    ev: Evidence, item: CitedItem | None, *, shown: bool, run: bool = False
) -> dict[str, str | None]:
    """Title, kind of source and date a person cites a piece of evidence by.

    A source item is its owner's (S3, S6): a reader who may not see it (``shown``
    false, see :func:`_shown_items`) cites it as ``baseline.evidence.present`` shows
    it, by the evidence's stored ref or url, with no kind or date. A run reads its
    user's own item by the title as read (S6, titles), never the current one.
    """
    if ev.source_item_id is not None and (item is None or not shown):
        return {
            "title": (ev.ref or ev.url or "Evidence").strip(),
            "source_kind": PRIVATE_KIND,
            "date": None,
        }
    title, kind, at = item[:3] if item else (None, None, None)
    if run:
        title = None
    when = at or ev.retrieved_at or ev.created_at
    return {
        "title": (title or ev.ref or ev.url or (ev.excerpt or "")[:80] or "Evidence").strip(),
        "source_kind": kind or ev.kind or "link",
        "date": when.date().isoformat() if when else None,
    }


async def _shown_items(
    db: AsyncSession, principal: Principal | None, items: dict[uuid.UUID, CitedItem]
) -> set[uuid.UUID]:
    """The items ``principal`` may see cited, as ``baseline.evidence.present`` decides:
    its user's own only; a run never one its user's intakes withhold, one frozen with
    no version released, or one deleted upstream (S6). No principal (a record everyone
    reads: a snapshot, an override and its pushback) sees none."""
    if principal is None or principal.user_id is None:
        return set()
    own = {i for i, item in items.items() if item[3] == principal.user_id}
    if not own:
        return set()
    withheld = await baseline_evidence.withheld_from(db, principal)
    frozen = await baseline_evidence.run_versions(db, principal, own)
    return {
        i
        for i in own
        if i not in withheld
        and not (i in frozen and frozen[i] is None)
        and not (principal.is_run and items[i][4])
    }


async def _cited_items(db: AsyncSession, item_ids: set[uuid.UUID]) -> dict[uuid.UUID, CitedItem]:
    if not item_ids:
        return {}
    return {
        item_id: (title, kind, at, owner, deleted is not None)
        for item_id, title, kind, at, owner, deleted in (
            await db.execute(
                select(
                    SourceItem.id,
                    SourceItem.title,
                    Source.kind,
                    func.coalesce(SourceItem.occurred_at, SourceItem.source_updated_at),
                    Source.owner_user_id,
                    SourceItem.deleted_at,
                )
                .join(Source, Source.id == SourceItem.source_id)
                .where(SourceItem.id.in_(item_ids))
            )
        ).all()
    }


async def load_features(
    db: AsyncSession, *, rescore: bool = True, principal: Principal | None = None
) -> list[FeatureInput]:
    """Features (not rejected) with their confirmed-goal links, evidence and dependencies.

    Scores unscored evidence in the session (flushed, not committed); ``rescore=False``
    reads only (readiness checks never write), leaving unscored evidence unscored.
    """
    entities = list(
        await db.scalars(
            select(Entity).where(Entity.type.in_(["feature", "goal"]), Entity.status != "rejected")
        )
    )
    features = {e.id: e for e in entities if e.type == "feature"}
    goals = {e.id: e for e in entities if e.type == "goal" and e.status == "confirmed"}
    inputs = {
        e.id: FeatureInput(
            id=str(e.id),
            key=e.key,
            title=e.title,
            status=e.status,
            attrs=dict(e.attrs or {}),
            stored_confidence=float(e.confidence) if e.confidence is not None else None,
        )
        for e in features.values()
    }
    if not inputs:
        return []
    edges = await db.scalars(
        select(Edge).where(
            Edge.type.in_(["supports", "depends_on", "blocks"]), Edge.status != "rejected"
        )
    )
    for edge in edges:
        if edge.type == "supports" and edge.src_id in inputs and edge.dst_id in goals:
            goal = goals[edge.dst_id]
            inputs[edge.src_id].goals.append(
                GoalLink(
                    goal_key=goal.key,
                    goal_title=goal.title,
                    weight=_float((goal.attrs or {}).get("weight")),
                    contribution=_contribution((edge.attrs or {}).get("contribution")),
                    edge_status=edge.status,
                )
            )
        elif edge.type == "depends_on" and edge.src_id in inputs and edge.dst_id in inputs:
            inputs[edge.src_id].depends_on.append(inputs[edge.dst_id].key)
        elif edge.type == "blocks" and edge.src_id in inputs and edge.dst_id in inputs:
            inputs[edge.dst_id].depends_on.append(inputs[edge.src_id].key)
    evidence = list(await db.scalars(select(Evidence).where(Evidence.entity_id.in_(list(inputs)))))
    # Evidence the baseline has not scored yet is scored now, through the baseline's own
    # scoring (source, freshness, mentions, goal impact), so every feature's confidence
    # comes from the same numbers the Baseline screen shows.
    unscored = {ev.entity_id for ev in evidence if ev.confidence is None}
    if unscored and rescore:
        await baseline_scoring.rescore_targets(db, entity_ids=unscored)
    items = await _cited_items(db, {ev.source_item_id for ev in evidence if ev.source_item_id})
    removed = {item_id for item_id, item in items.items() if item[4]}
    shown = await _shown_items(db, principal, items)
    run = principal is not None and principal.is_run
    # A run reads every score as of its pin, as the entity detail does (S6).
    view = await baseline_evidence.run_view(db, principal, entity_ids=list(inputs))
    if view is not None:
        for f in features.values():
            inputs[f.id].stored_confidence = view.confidence("entity", f.id)
    for ev in evidence:
        inputs[ev.entity_id].evidence.append(  # type: ignore[index]
            EvidenceRef(
                id=str(ev.id),
                confidence=(
                    view.by_evidence.get(ev.id)
                    if view is not None
                    else (float(ev.confidence) if ev.confidence is not None else None)
                ),
                ref=ev.url or ev.ref,
                source_removed=ev.source_item_id in removed,
                **_cited_as(
                    ev,
                    items.get(ev.source_item_id) if ev.source_item_id else None,
                    shown=ev.source_item_id in shown,
                    run=run,
                ),
            )
        )
    for f in inputs.values():
        f.goals.sort(key=lambda g: g.goal_key)
        f.depends_on.sort()
    return sorted(inputs.values(), key=lambda f: f.key)


async def compute(
    db: AsyncSession,
    method: str,
    principal: Principal | None = None,
    *,
    overrides: bool = True,
) -> PriorityRanking:
    """The ranking by ``method``; with ``overrides`` (the default) people's active moves
    and pins on the live ranking applied after the formula (C9), else Oracle's order."""
    features = await load_features(db, principal=principal)
    active = await active_overrides(db) if overrides else []
    result = apply_overrides(rank(features, method), await _override_inputs(db, active, features))
    return _ranking(result)


def _ranking(result: dict[str, Any]) -> PriorityRanking:
    features = [RankedFeature.model_validate(r) for r in result["features"]]
    return PriorityRanking(
        method=result["method"],
        formula=result["formula"],
        generated_at=datetime.now(UTC),
        features=features,
        cycles=result["cycles"],
        counts=RankingCounts(
            features=len(features),
            no_goal=sum(1 for f in features if not f.serves_goal),
            unscored=sum(1 for f in features if f.score is None),
            in_cycles=sum(len(c) for c in result["cycles"]),
        ),
    )


def _summary(s: PrioritySnapshot, document: SnapshotDocument | None) -> dict[str, Any]:
    return {
        "id": s.id,
        "method": s.method,
        "created_by": s.created_by,
        "created_at": s.created_at,
        "note": (s.params or {}).get("note"),
        "feature_count": len(s.ranking or []),
        "top": [r["key"] for r in (s.ranking or [])[:5]],
        "status": s.status,
        "run_id": s.run_id,
        "document": document,
        "decided_by": s.decided_by,
        "decided_at": s.decided_at,
    }


async def _documents(
    db: AsyncSession, snapshots: list[PrioritySnapshot]
) -> dict[uuid.UUID, SnapshotDocument]:
    """The PRD of each run snapshot: its document, else the slug its run writes."""
    from oracle.docs.models import Document
    from oracle.runs.models import Run

    doc_ids = {s.document_id for s in snapshots if s.document_id}
    run_ids = {s.run_id for s in snapshots if s.run_id and not s.document_id}
    docs = (
        {d.id: d for d in await db.scalars(select(Document).where(Document.id.in_(doc_ids)))}
        if doc_ids
        else {}
    )
    runs = (
        {r.id: r for r in await db.scalars(select(Run).where(Run.id.in_(run_ids)))}
        if run_ids
        else {}
    )
    out: dict[uuid.UUID, SnapshotDocument] = {}
    for s in snapshots:
        if s.document_id in docs:
            d = docs[s.document_id]
            out[s.id] = SnapshotDocument(id=d.id, slug=d.slug, title=d.title)
        elif s.run_id in runs and (slug := (runs[s.run_id].knobs or {}).get("document_slug")):
            out[s.id] = SnapshotDocument(slug=str(slug))
    return out


def _out(s: PrioritySnapshot, document: SnapshotDocument | None) -> PrioritySnapshotOut:
    return PrioritySnapshotOut(
        **_summary(s, document),
        params=s.params or {},
        ranking=[RankedFeature.model_validate(r) for r in s.ranking or []],
        checkpoint_id=s.checkpoint_id,
        scope_id=s.scope_id,
        check_result=s.check_result or None,
    )


async def create_snapshot(
    db: AsyncSession, method: str, note: str | None, principal: Principal
) -> PrioritySnapshotOut:
    ranking = await compute(db, method)
    # The ranking as shown, with the overrides that shaped it (C9).
    applied = [f.override.id for f in ranking.features if f.override is not None]
    snapshot = PrioritySnapshot(
        method=method,
        params={
            "note": note,
            "overrides": applied,
            "formula": ranking.formula,
            "generated_at": ranking.generated_at.isoformat(),
            "cycles": ranking.cycles,
            "counts": ranking.counts.model_dump(),
        },
        ranking=[f.model_dump(mode="json") for f in ranking.features],
        created_by=principal.id,
    )
    db.add(snapshot)
    await db.flush()
    await audit.record(
        db,
        principal,
        "priority_snapshot.created",
        "priority_snapshot",
        snapshot.id,
        {"method": method, "features": len(ranking.features)},
    )
    await db.commit()
    await db.refresh(snapshot)
    return PrioritySnapshotOut(
        **_summary(snapshot, None), params=snapshot.params, ranking=ranking.features
    )


def _status_filter(status: str):
    return None if status == "all" else PrioritySnapshot.status == status


async def list_snapshots(
    db: AsyncSession, limit: int = 50, status: str = "saved"
) -> list[PrioritySnapshotSummary]:
    q = select(PrioritySnapshot).order_by(PrioritySnapshot.created_at.desc()).limit(limit)
    if (where := _status_filter(status)) is not None:
        q = q.where(where)
    rows = list(await db.scalars(q))
    docs = await _documents(db, rows)
    return [PrioritySnapshotSummary(**_summary(s, docs.get(s.id))) for s in rows]


async def _snapshot(db: AsyncSession, snapshot_id: uuid.UUID, status: str) -> PrioritySnapshot:
    s = await db.get(PrioritySnapshot, snapshot_id)
    if s is None or (status != "all" and s.status != status):
        raise NotFoundError("priority snapshot not found")
    return s


async def read_snapshot(
    db: AsyncSession, snapshot_id: uuid.UUID, status: str = "saved"
) -> PrioritySnapshotOut:
    s = await _snapshot(db, snapshot_id, status)
    return _out(s, (await _documents(db, [s])).get(s.id))


async def compare(db: AsyncSession, snapshot_id: uuid.UUID, principal: Principal) -> CompareOut:
    """A snapshot in any status next to the live ranking of its method, restricted to the
    features it ranks, with the check's problems per row (C8), and the run and checkpoint
    that decide it."""
    from oracle.priorities import run_order

    s = await _snapshot(db, snapshot_id, "all")
    live = await compute(db, s.method)
    stored = {r["key"]: r for r in s.ranking or []}
    check = s.check_result or {}
    order = check.get("order") or [
        {"key": r["key"], "rank": r["rank"], "explanation": r.get("run_explanation")}
        for r in s.ranking or []
    ]
    order = sorted(order, key=lambda r: r["rank"])
    live_rows = [f.model_dump(mode="json") for f in live.features]
    ranks = run_order.live_ranks([r["key"] for r in order], live_rows)
    by_key = {f.key: f for f in live.features}
    problems = [p for p in check.get("problems") or [] if p.get("feature")]
    rows = []
    for r in order:
        key = r["key"]
        f = by_key.get(key)
        live_rank = ranks.get(key)
        rows.append(
            CompareRow(
                key=key,
                title=f.title if f else (stored.get(key) or {}).get("title") or key,
                run_rank=r["rank"],
                live_rank=live_rank,
                delta=None if live_rank is None else live_rank - r["rank"],
                run_explanation=r.get("explanation"),
                live_explanation=_live_explanation(f) if f else None,
                problems=[p for p in problems if p["feature"] == key],
            )
        )
    run, checkpoint = await _deciding(db, s, principal)
    return CompareOut(
        snapshot=_out(s, (await _documents(db, [s])).get(s.id)),
        rows=rows,
        live_generated_at=live.generated_at,
        run=run,
        checkpoint=checkpoint,
    )


def _live_explanation(f: RankedFeature) -> str:
    e = f.explanation
    return " ".join(p for p in [e.formula, *e.steps[:3], *e.order[:2]] if p)[:400]


async def _deciding(
    db: AsyncSession, s: PrioritySnapshot, principal: Principal
) -> tuple[CompareRun | None, CompareCheckpoint | None]:
    from oracle.authz import has_role
    from oracle.runs import flows, gate
    from oracle.runs.models import Checkpoint, Run
    from oracle.runs.service import _cannot_approve, approve_gate_of

    run = await db.get(Run, s.run_id) if s.run_id else None
    if run is None:
        return None, None
    flow = flows.FLOWS.get(run.flow)
    out = CompareRun(
        id=run.id,
        flow_title=flow.title if flow else run.flow,
        status=run.status,
        document_slug=(run.knobs or {}).get("document_slug"),
    )
    if out.document_slug is None and run.document_id:
        from oracle.docs.models import Document

        doc = await db.get(Document, run.document_id)
        out.document_slug = doc.slug if doc else None
    cp = await db.get(Checkpoint, s.checkpoint_id) if s.checkpoint_id else None
    if cp is None:
        return out, None
    # As the run page: not imported, else the approve gate's blocking problems (D3).
    shut = await approve_gate_of(db, cp) if cp.status == "pending" else None
    return out, CompareCheckpoint(
        id=cp.id,
        status=cp.status,
        approver_role=cp.approver_role,
        cannot_approve=_cannot_approve(cp)
        or (gate.message(shut) if shut is not None and not shut.open else None),
        can_decide=cp.status == "pending" and has_role(principal.role, cp.approver_role),  # type: ignore[arg-type]
    )


# --- overrides (C9 Move and pin) ---------------------------------------------------------

PUSHBACK_DETAIL = "Oracle disagrees with this change"
# How long a pushback the person saw stays theirs to keep (its reason check is copied).
KEEP_WINDOW = timedelta(minutes=15)
REASON_SEEN = (
    "Oracle read your reason against the evidence and found that the evidence contradicts it."
)


async def active_overrides(
    db: AsyncSession, snapshot_id: uuid.UUID | None = None
) -> list[PriorityOverride]:
    """Active overrides on the live ranking (or on ``snapshot_id``), in creation order."""
    where = (
        PriorityOverride.snapshot_id.is_(None)
        if snapshot_id is None
        else PriorityOverride.snapshot_id == snapshot_id
    )
    return list(
        await db.scalars(
            select(PriorityOverride)
            .where(PriorityOverride.removed_at.is_(None), where)
            .order_by(PriorityOverride.created_at, PriorityOverride.id)
        )
    )


async def _names(db: AsyncSession, ids: set[uuid.UUID]) -> dict[uuid.UUID, str]:
    """A label for each user (email) or API token (name) id."""
    ids = {i for i in ids if i}
    if not ids:
        return {}
    out: dict[uuid.UUID, str] = dict(
        (await db.execute(select(User.id, User.email).where(User.id.in_(ids)))).all()
    )
    if rest := ids - set(out):
        out.update(
            (
                await db.execute(select(ApiToken.id, ApiToken.name).where(ApiToken.id.in_(rest)))
            ).all()
        )
    return out


async def _override_inputs(
    db: AsyncSession, rows: list[PriorityOverride], features: list[FeatureInput]
) -> list[OverrideIn]:
    keys = {uuid.UUID(f.id): f.key for f in features}
    names = await _names(db, {o.created_by for o in rows})
    out = []
    for o in rows:
        # A feature or anchor no longer ranked keeps an id the ranking does not know:
        # apply_overrides drops it.
        above = None
        if o.above_feature_id is not None:
            above = keys.get(o.above_feature_id, str(o.above_feature_id))
        out.append(
            OverrideIn(
                id=str(o.id),
                feature=keys.get(o.feature_id, str(o.feature_id)),
                kind=o.kind,
                above=above,
                position=o.position,
                info={
                    "by": names.get(o.created_by, "someone"),
                    "reason": o.reason,
                    "kept_after_pushback": o.kept_after_pushback,
                    "above": above,
                    "position": o.position,
                    "created_at": o.created_at.isoformat() if o.created_at else None,
                },
            )
        )
    return out


async def _feature(db: AsyncSession, entity_id: uuid.UUID, field: str) -> Entity:
    e = await db.get(Entity, entity_id)
    if e is None or e.type != "feature" or e.status == "rejected":
        raise InvalidError(f"{field} must be a feature of the baseline that is not rejected")
    return e


async def _low_threshold(db: AsyncSession) -> float:
    row = await db.scalar(select(TenantSetting).where(TenantSetting.key == "confidence_weights"))
    overrides = row.value if row is not None and isinstance(row.value, dict) else None
    return float(confidence_rules.merged(overrides)["low"])


async def _open_blockers(db: AsyncSession, feature: Entity) -> list[str]:
    """Titles of the open blockers that gate publishing and are linked to ``feature``."""
    from oracle.blockers import service as blockers  # imports the baseline service

    edges = await db.scalars(
        select(Edge).where(
            or_(Edge.src_id == feature.id, Edge.dst_id == feature.id), Edge.status != "rejected"
        )
    )
    other = {e.dst_id if e.src_id == feature.id else e.src_id for e in edges}
    if not other:
        return []
    titles = []
    for c in await db.scalars(
        select(Entity)
        .where(Entity.id.in_(other), Entity.type == "constraint", Entity.status != "rejected")
        .order_by(Entity.key)
    ):
        spec = blockers.safe_spec(c)
        if spec is not None and blockers._gates_publish(blockers.gate_snapshot(spec)):
            titles.append(c.title)
    return titles


async def _evidence_items(
    db: AsyncSession, rows: list[Evidence]
) -> dict[uuid.UUID, reason_check.EvidenceItem]:
    # Chips are stored (pushback) or read by everyone (the override log), and the
    # model's prompt is no item owner's own: a source item is cited as no one sees it.
    out = {}
    for ev in rows:
        cited = _cited_as(ev, None, shown=False)
        out[ev.id] = reason_check.EvidenceItem(
            id=str(ev.id),
            title=cited["title"] or "Evidence",
            source_kind=cited["source_kind"] or "link",
            date=cited["date"],
            confidence=float(ev.confidence) if ev.confidence is not None else None,
            text=(ev.excerpt or "")[: reason_check.MAX_TEXT],
        )
    return out


async def _evidence_rows(db: AsyncSession, ids: list[uuid.UUID]) -> list[Evidence]:
    if not ids:
        return []
    return list(await db.scalars(select(Evidence).where(Evidence.id.in_(ids))))


def _reason_hash(reason: str) -> str:
    return hashlib.sha256(reason.encode()).hexdigest()


def _row(rows: list[dict[str, Any]], key: str) -> dict[str, Any] | None:
    return next((r for r in rows if r["key"] == key), None)


async def _seen_check(
    db: AsyncSession, principal: Principal, feature: Entity, reason: str
) -> AuditEvent | None:
    """The person's latest reason check of this feature and reason in the keep window."""
    return await db.scalar(
        select(AuditEvent)
        .where(
            AuditEvent.action == reason_check.EVENT,
            AuditEvent.actor == principal.actor,
            AuditEvent.entity_id == feature.id,
            AuditEvent.data["reason_sha256"].astext == _reason_hash(reason),
            AuditEvent.created_at >= datetime.now(UTC) - KEEP_WINDOW,
        )
        .order_by(AuditEvent.created_at.desc())
        .limit(1)
    )


async def create_override(
    db: AsyncSession, data: OverrideCreate, principal: Principal
) -> OverrideOut:
    """Check a move or pin and store it, or raise :class:`Pushback` (nothing stored).

    The four rules run on the goal-weighted order (Oracle's recommendation, decision O3),
    then Oracle reads the reason (``reason_check``), unless ``confirm``: then the change
    is stored as the person saw it pushed back, with that check's result, and no second
    check. Replaces the feature's active override, if any.
    """
    if principal.is_run:
        raise ForbiddenError("A run cannot move or pin priorities; people decide the order")
    if data.snapshot_id is not None:
        # Run mode (pick C8 Priority order snapshot) changes a proposed run snapshot whose
        # stop is waiting; a saved snapshot is a record and never changes.
        raise ConflictError(
            "Only a run's proposed priority order, while its stop is waiting, takes changes; "
            "this snapshot is saved"
        )
    feature = await _feature(db, data.feature_id, "feature_id")
    above = (
        await _feature(db, data.above_feature_id, "above_feature_id")
        if data.above_feature_id
        else None
    )
    cited_ids = list(dict.fromkeys(data.evidence_ids))
    cited_rows = (
        list(await db.scalars(select(Evidence).where(Evidence.id.in_(cited_ids))))
        if cited_ids
        else []
    )
    if len(cited_rows) != len(cited_ids) or any(e.entity_id != feature.id for e in cited_rows):
        raise InvalidError("evidence_ids must each be evidence of the feature")

    features = await load_features(db, principal=principal)
    base = rank(features, "goal_weighted")
    active = await active_overrides(db)
    inputs = await _override_inputs(db, active, features)
    before = apply_overrides(base, inputs)
    change = OverrideIn(
        id="new",
        feature=feature.key,
        kind=data.kind,
        above=above.key if above else None,
        position=data.position,
    )
    after = apply_overrides(base, [i for i in inputs if i.feature != feature.key] + [change])
    row = _row(after["features"], feature.key)
    preview_rank = row["rank"] if row else None
    held_below = row["held_below"] if row else None
    blockers = {feature.key: await _open_blockers(db, feature)}
    messages = pushback.rules(
        before["features"],
        after["features"],
        feature.key,
        low=await _low_threshold(db),
        blockers=blockers,
    )

    if not data.confirm:
        check = await _check_reason(
            db, principal, feature, data, cited_rows, before["features"], after["features"]
        )
        if check.message is not None:
            messages.append(check.message)
        stored_check = check.stored()
        if messages:
            await db.commit()  # the reason check's audit event stays
            raise Pushback(
                {
                    "detail": PUSHBACK_DETAIL,
                    "pushback": messages,
                    "reason_check": stored_check,
                    "preview_rank": preview_rank,
                    "held_below": held_below,
                }
            )
    else:
        seen = await _seen_check(db, principal, feature, data.reason)
        stored_check = (
            {"status": seen.data.get("status"), "ms": seen.data.get("ms")}
            if seen is not None
            else {"status": "skipped", "ms": None}
        )
        if seen is not None and seen.data.get("status") == "contradiction":
            ids = [uuid.UUID(i) for i in seen.data.get("evidence_ids") or []]
            rows = await _evidence_rows(db, ids)
            chips = await _evidence_items(db, [e for e in rows if e.entity_id == feature.id])
            messages.append(
                {
                    "code": "reason_contradicts_evidence",
                    "message": REASON_SEEN,
                    "evidence": [chips[i].chip() for i in ids if i in chips],
                }
            )

    o = await _store(db, principal, data, feature, above, cited_ids, messages, stored_check)
    out = (await _outs(db, [o]))[0]
    return out.model_copy(update={"preview_rank": preview_rank, "held_below": held_below})


async def _check_reason(
    db: AsyncSession,
    principal: Principal,
    feature: Entity,
    data: OverrideCreate,
    cited_rows: list[Evidence],
    before: list[dict[str, Any]],
    after: list[dict[str, Any]],
) -> reason_check.ReasonCheck:
    """Oracle's reading of the reason, audited once per model call (no text)."""
    own = list(
        await db.scalars(
            select(Evidence)
            .where(Evidence.entity_id == feature.id)
            .order_by(Evidence.confidence.desc().nulls_last(), Evidence.created_at)
            .limit(reason_check.MAX_EVIDENCE + reason_check.MAX_CITED)
        )
    )
    items = await _evidence_items(db, [*cited_rows, *own])
    row = _row(after, feature.key) or {}
    explanation = row.get("explanation") or {}
    context = {
        "key": feature.key,
        "title": feature.title,
        "goals": [
            {"title": g["title"], "weight": g["weight"], "contribution": g["contribution"]}
            for g in explanation.get("goals") or []
        ],
        "score": row.get("score"),
        "confidence": (explanation.get("confidence") or {}).get("value"),
        "passes": [
            {
                "key": p["key"],
                "title": p["title"],
                "score": p["score"],
                "confidence": p["explanation"]["confidence"]["value"],
            }
            for p in pushback.passes(before, after, feature.key)[:10]
        ],
    }
    check = await reason_check.check_reason(
        db,
        context,
        {
            "reason": data.reason,
            "change": {
                "kind": data.kind,
                "to_rank": row.get("rank"),
                "formula_rank": row.get("formula_rank"),
            },
        },
        {
            "cited": [items[e.id] for e in cited_rows],
            "items": [items[e.id] for e in own if e.id not in {c.id for c in cited_rows}],
        },
    )
    if check.called:
        await audit.record(
            db,
            principal,
            reason_check.EVENT,
            "entity",
            feature.id,
            {
                "status": check.status,
                "ms": check.ms,
                "usage": check.usage,
                "account_label": check.account_label,
                "via": check.via,
                "reason_sha256": _reason_hash(data.reason),
                "evidence_ids": [e["id"] for e in (check.message or {}).get("evidence") or []],
            },
        )
    return check


def _change_label(kind: str, feature: Entity, above: Entity | None, position: int | None) -> str:
    if kind == "move" and above is not None:
        return f"Move {feature.title} above {above.title}"
    return f"Pin {feature.title} at #{position}"


async def _store(
    db: AsyncSession,
    principal: Principal,
    data: OverrideCreate,
    feature: Entity,
    above: Entity | None,
    cited_ids: list[uuid.UUID],
    messages: list[dict[str, Any]],
    stored_check: dict[str, Any],
) -> PriorityOverride:
    from oracle.decisions import capture  # the decision log (H1) imports the baseline

    now = datetime.now(UTC)
    old = await db.scalar(
        select(PriorityOverride)
        .where(
            PriorityOverride.feature_id == feature.id,
            PriorityOverride.snapshot_id.is_(None),
            PriorityOverride.removed_at.is_(None),
        )
        .with_for_update()
    )
    if old is not None:
        old.removed_at = now
        old.removed_by = principal.id
        old.removed_reason = "Replaced by a new change"
        await db.flush()
    kept = bool(messages) and data.confirm
    o = PriorityOverride(
        feature_id=feature.id,
        snapshot_id=None,
        kind=data.kind,
        above_feature_id=above.id if above else None,
        position=data.position,
        reason=data.reason,
        evidence_ids=cited_ids,
        pushback=messages,
        reason_check=stored_check,
        kept_after_pushback=kept,
        created_by=principal.id,
    )
    db.add(o)
    try:
        await db.flush()
    except IntegrityError:
        # Another change to this feature was stored at the same moment (one active each).
        await db.rollback()
        raise ConflictError(
            "Someone else changed this feature's place at the same moment; reload and try again"
        ) from None
    if old is not None:
        old.replaced_by = o.id
        await audit.record(
            db,
            principal,
            "priority_override.replaced",
            "priority_override",
            old.id,
            {"replaced_by": str(o.id), "feature_id": str(feature.id)},
        )
    await audit.record(
        db,
        principal,
        "priority_override.created",
        "priority_override",
        o.id,
        {
            "feature_id": str(feature.id),
            "kind": o.kind,
            "above_feature_id": str(above.id) if above else None,
            "position": o.position,
            "evidence_ids": [str(i) for i in cited_ids],
            # Codes and numbers only: a message may quote the reason.
            "pushback": [{"code": m["code"], "numbers": m.get("numbers")} for m in messages],
            "reason_check": stored_check,
            "kept_after_pushback": kept,
        },
    )
    # The decision log (H1): a priority moved against Oracle's order is a judgement call.
    label = _change_label(o.kind, feature, above, o.position)
    reason_evidence = [
        uuid.UUID(e["id"])
        for m in messages
        for e in m.get("evidence") or []
        if m["code"] == "reason_contradicts_evidence"
    ]
    await capture.capture(
        db,
        principal,
        origin="priority_override",
        source_kind="priority_override",
        source_id=o.id,
        title=label,
        options=[
            {"key": "keep_change", "label": label},
            {"key": "oracle_order", "label": "Keep Oracle's order", "recommended": True},
        ],
        chosen_option="keep_change",
        rationale=o.reason,
        context="\n".join(
            ["Oracle pushed back; kept after pushback." if kept else "Oracle did not push back."]
            + [f"- {m['message']}" for m in messages]
        ),
        approver_id=principal.user_id or principal.id,
        evidence_ids=[*cited_ids, *reason_evidence],
        subjects=[{"kind": "entity", "id": str(feature.id), "ref": f"feature:{feature.key}"}],
    )
    await db.commit()
    await db.refresh(o)
    return o


async def remove_override(
    db: AsyncSession, override_id: uuid.UUID, reason: str | None, principal: Principal
) -> OverrideOut:
    """End an override: the feature returns to Oracle's order. The log keeps it."""
    if principal.is_run:
        raise ForbiddenError("A run cannot remove a person's change to priorities")
    o = await db.get(PriorityOverride, override_id, with_for_update=True)
    if o is None:
        raise NotFoundError("priority override not found")
    if o.removed_at is not None:
        raise ConflictError("This change was already removed or replaced")
    o.removed_at = datetime.now(UTC)
    o.removed_by = principal.id
    o.removed_reason = (reason or "").strip() or None
    await audit.record(
        db,
        principal,
        "priority_override.removed",
        "priority_override",
        o.id,
        {"feature_id": str(o.feature_id)},
    )
    await db.commit()
    await db.refresh(o)
    return (await _outs(db, [o]))[0]


async def list_overrides(
    db: AsyncSession,
    snapshot_id: uuid.UUID | None = None,
    include_removed: bool = False,
    limit: int = 50,
) -> list[OverrideOut]:
    """The override log, newest first: active only, or every one ever made."""
    stmt = select(PriorityOverride).where(
        PriorityOverride.snapshot_id.is_(None)
        if snapshot_id is None
        else PriorityOverride.snapshot_id == snapshot_id
    )
    if not include_removed:
        stmt = stmt.where(PriorityOverride.removed_at.is_(None))
    rows = list(
        await db.scalars(
            stmt.order_by(PriorityOverride.created_at.desc(), PriorityOverride.id).limit(limit)
        )
    )
    return await _outs(db, rows)


async def _outs(db: AsyncSession, rows: list[PriorityOverride]) -> list[OverrideOut]:
    entity_ids = {o.feature_id for o in rows}
    entity_ids |= {o.above_feature_id for o in rows if o.above_feature_id}
    entities = {}
    if entity_ids:
        entities = {
            e.id: e for e in await db.scalars(select(Entity).where(Entity.id.in_(entity_ids)))
        }
    people = {o.created_by for o in rows} | {o.removed_by for o in rows if o.removed_by}
    names = await _names(db, people)
    cited = list({i for o in rows for i in o.evidence_ids or []})
    chips = await _evidence_items(db, await _evidence_rows(db, cited))

    def ref(entity_id: uuid.UUID | None) -> dict[str, Any] | None:
        if entity_id is None:
            return None
        e = entities.get(entity_id)
        return {"id": entity_id, "key": e.key if e else "", "title": e.title if e else "Removed"}

    def person(pid: uuid.UUID | None) -> dict[str, Any] | None:
        return None if pid is None else {"id": pid, "name": names.get(pid, "someone")}

    def gone(entity_id: uuid.UUID | None) -> bool:
        e = entities.get(entity_id) if entity_id else None
        return entity_id is not None and (e is None or e.status == "rejected")

    return [
        OverrideOut.model_validate(
            {
                "id": o.id,
                "feature": ref(o.feature_id),
                "kind": o.kind,
                "above": ref(o.above_feature_id),
                "position": o.position,
                "reason": o.reason,
                "evidence_ids": list(o.evidence_ids or []),
                "evidence": [chips[i].chip() for i in o.evidence_ids or [] if i in chips],
                "pushback": o.pushback or [],
                "kept_after_pushback": o.kept_after_pushback,
                "reason_check": o.reason_check or {"status": "skipped"},
                "snapshot_id": o.snapshot_id,
                "created_by": person(o.created_by),
                "created_at": o.created_at,
                "removed_at": o.removed_at,
                "removed_by": person(o.removed_by),
                "removed_reason": o.removed_reason,
                "replaced_by": o.replaced_by,
                "no_longer_applies": o.removed_at is None
                and (gone(o.feature_id) or gone(o.above_feature_id)),
            }
        )
        for o in rows
    ]
