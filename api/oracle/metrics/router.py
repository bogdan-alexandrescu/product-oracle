"""Metrics review API (H5): the metric catalog, weekly values and variances.

Every member reads. Approvers and owners add, edit, archive and pull metrics. A week's
value by hand or by API is recorded by an approver or the metric's owner (whatever their
role), and so are an explanation and Don't know yet; Noise is an approver's. A run's
token reads only (oracle.mcp.scopes): an agent never writes a weekly value.
"""

import uuid
from datetime import date
from typing import Annotated, Literal

from fastapi import APIRouter, Depends, HTTPException, Query, Response, status

from oracle import audit
from oracle.auth.deps import Principal, TenantDB
from oracle.authz import has_role, recheck_caller, require_role
from oracle.metrics import posthog, service
from oracle.metrics.models import Metric, MetricVariance
from oracle.metrics.schemas import (
    ExplainIn,
    MetricCreate,
    MetricDetail,
    MetricOut,
    MetricPatch,
    MetricTestOut,
    MetricValueOut,
    NoiseIn,
    QueryIn,
    UnknownIn,
    ValueIn,
    VarianceOut,
)

router = APIRouter(prefix="/v1", tags=["metrics"])

Viewer = Annotated[Principal, Depends(require_role("viewer"))]
Approver = Annotated[Principal, Depends(require_role("approver"))]

_ERRORS = {404: {"description": "Not found"}, 409: {"description": "Conflict"}}


def _fail(exc: service.MetricError) -> HTTPException:
    return HTTPException(exc.status_code, str(exc))


def _owner_or_approver(principal: Principal, metric: Metric) -> None:
    """The metric's owner (whatever their role) or an approver; 403 otherwise."""
    if principal.user_id == metric.owner_id or has_role(principal.role, "approver"):
        return
    raise HTTPException(
        status.HTTP_403_FORBIDDEN, "Only the metric's owner or an approver does this"
    )


async def _one(db: TenantDB, metric_id: uuid.UUID) -> Metric:
    try:
        return await service.get(db, metric_id, for_update=True)
    except service.MetricError as exc:
        raise _fail(exc) from None


async def _variance(db: TenantDB, variance_id: uuid.UUID) -> tuple[MetricVariance, Metric]:
    try:
        row = await service.get_variance(db, variance_id, for_update=True)
        return row, await service.get(db, row.metric_id)
    except service.MetricError as exc:
        raise _fail(exc) from None


async def _metric_out(db: TenantDB, metric: Metric) -> MetricOut:
    [out] = await service.outs(db, [metric])
    return out


async def _variance_out(db: TenantDB, row: MetricVariance) -> VarianceOut:
    [out] = await service.variance_outs(db, [row])
    return out


@router.get("/metrics", response_model=list[MetricOut])
async def list_metrics(
    principal: Viewer, db: TenantDB, include_archived: Annotated[bool, Query()] = False
) -> list[MetricOut]:
    """The company's weekly metrics: outputs, each followed by the inputs that drive it,
    with last week's value, its change and the last 12 weeks."""
    return await service.listed(db, include_archived)


@router.post(
    "/metrics", response_model=MetricOut, status_code=status.HTTP_201_CREATED, responses=_ERRORS
)
async def create_metric(body: MetricCreate, principal: Approver, db: TenantDB) -> MetricOut:
    """Add a metric. A PostHog metric reads its last 12 complete weeks at once (409 when
    PostHog is not connected)."""
    await recheck_caller(db, principal, "approver")
    try:
        metric = await service.create(db, principal.id, body)
    except service.MetricError as exc:
        raise _fail(exc) from None
    await audit.record(db, principal, "metric.created", "metric", metric.id,
                       {"title": metric.title, "source": metric.source})  # fmt: skip
    await db.commit()
    return await _metric_out(db, metric)


@router.post("/metrics/test", response_model=MetricTestOut, responses=_ERRORS)
async def test_metric_query(body: QueryIn, principal: Approver, db: TenantDB) -> MetricTestOut:
    """Run a PostHog query for the last 4 complete weeks; nothing is stored. 422 when
    the query is not one read-only SELECT over the allowed tables; a failure is a fixed
    sentence in ``error`` (PostHog's own text is in the server log)."""
    try:
        values, error = await service.test_query(db, body.query)
    except service.MetricError as exc:
        raise _fail(exc) from None
    return MetricTestOut(values=values, error=error)


@router.get("/metrics/{metric_id}", response_model=MetricDetail, responses=_ERRORS)
async def get_metric(metric_id: uuid.UUID, principal: Viewer, db: TenantDB) -> MetricDetail:
    """A metric with up to 52 weekly values, its variances and its definition history."""
    try:
        metric = await service.get(db, metric_id)
    except service.MetricError as exc:
        raise _fail(exc) from None
    return await service.detail(db, metric)


@router.patch("/metrics/{metric_id}", response_model=MetricOut, responses=_ERRORS)
async def update_metric(
    metric_id: uuid.UUID, body: MetricPatch, principal: Approver, db: TenantDB
) -> MetricOut:
    """Edit a metric (``lock_version``). A query or unit change raises its definition
    version: later values carry the new one."""
    await recheck_caller(db, principal, "approver")
    metric = await _one(db, metric_id)
    try:
        await service.update(db, metric, body)
    except service.MetricError as exc:
        raise _fail(exc) from None
    await audit.record(db, principal, "metric.updated", "metric", metric.id,
                       {"fields": sorted(body.model_fields_set - {"lock_version"}),
                        "definition_version": metric.definition_version})  # fmt: skip
    await db.commit()
    return await _metric_out(db, metric)


async def _archive(metric_id: uuid.UUID, principal: Principal, db: TenantDB, archived: bool):
    await recheck_caller(db, principal, "approver")
    metric = await _one(db, metric_id)
    try:
        await service.set_archived(db, metric, archived)
    except service.MetricError as exc:
        raise _fail(exc) from None
    action = "metric.archived" if archived else "metric.restored"
    await audit.record(db, principal, action, "metric", metric.id, {"title": metric.title})
    await db.commit()
    return await _metric_out(db, metric)


@router.post("/metrics/{metric_id}/archive", response_model=MetricOut, responses=_ERRORS)
async def archive_metric(metric_id: uuid.UUID, principal: Approver, db: TenantDB) -> MetricOut:
    """Archive a metric: it is no longer read or reviewed; its values stay."""
    return await _archive(metric_id, principal, db, True)


@router.post("/metrics/{metric_id}/restore", response_model=MetricOut, responses=_ERRORS)
async def restore_metric(metric_id: uuid.UUID, principal: Approver, db: TenantDB) -> MetricOut:
    """Restore an archived metric."""
    return await _archive(metric_id, principal, db, False)


@router.post(
    "/metrics/{metric_id}/pull",
    response_model=MetricOut,
    responses={**_ERRORS, 502: {"description": "PostHog refused or failed the query"}},
)
async def pull_metric(metric_id: uuid.UUID, principal: Approver, db: TenantDB) -> MetricOut:
    """Pull now: read the last complete week from PostHog again and replace its value
    (409 unless the metric's source is PostHog; 502 with a fixed message, PostHog's
    own text in the server log)."""
    await recheck_caller(db, principal, "approver")
    metric = await _one(db, metric_id)
    try:
        await service.pull_now(db, metric)
    except service.MetricError as exc:
        raise _fail(exc) from None
    except posthog.PostHogError as exc:
        await db.commit()
        raise HTTPException(status.HTTP_502_BAD_GATEWAY, exc.message) from None
    await audit.record(db, principal, "metric.pulled", "metric", metric.id, {})
    await db.commit()
    return await _metric_out(db, metric)


@router.put(
    "/metrics/{metric_id}/values/{week_start}", response_model=MetricValueOut, responses=_ERRORS
)
async def record_metric_value(
    metric_id: uuid.UUID, week_start: date, body: ValueIn, principal: Viewer, db: TenantDB
) -> MetricValueOut:
    """Record a week's value on a metric typed by hand or written by API (an approver or
    the metric's owner). 409 for a PostHog metric; 422 for a week_start that is not a
    Monday or a week that has not ended."""
    await recheck_caller(db, principal, "viewer")
    metric = await _one(db, metric_id)
    _owner_or_approver(principal, metric)
    try:
        row = await service.record_value(db, metric, week_start, body.value, body.note,
                                         principal.id)  # fmt: skip
    except service.MetricError as exc:
        raise _fail(exc) from None
    await audit.record(db, principal, "metric.value_recorded", "metric", metric.id,
                       {"week_start": week_start.isoformat(), "value": body.value})  # fmt: skip
    out = MetricValueOut(
        week_start=row.week_start, value=float(row.value), source=row.source,  # type: ignore[arg-type]
        definition_version=row.definition_version, note=row.note,
        recorded_by=row.recorded_by, recorded_at=row.recorded_at,
    )  # fmt: skip
    await db.commit()
    return out


@router.delete(
    "/metrics/{metric_id}/values/{week_start}",
    status_code=status.HTTP_204_NO_CONTENT,
    responses=_ERRORS,
)
async def delete_metric_value(
    metric_id: uuid.UUID, week_start: date, principal: Approver, db: TenantDB
) -> Response:
    """Delete a week's value typed by hand or written by API."""
    await recheck_caller(db, principal, "approver")
    metric = await _one(db, metric_id)
    try:
        await service.delete_value(db, metric, week_start)
    except service.MetricError as exc:
        raise _fail(exc) from None
    await audit.record(db, principal, "metric.value_deleted", "metric", metric.id,
                       {"week_start": week_start.isoformat()})  # fmt: skip
    await db.commit()
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.get("/metric-variances", response_model=list[VarianceOut])
async def list_metric_variances(
    principal: Viewer,
    db: TenantDB,
    status_: Annotated[
        Literal["open", "explained", "unknown", "noise"] | None, Query(alias="status")
    ] = None,
    metric_id: Annotated[uuid.UUID | None, Query()] = None,
) -> list[VarianceOut]:
    """The variances, latest week first: each with its possible causes, its explanation
    state and Oracle's draft if any."""
    return await service.list_variances(db, status_, metric_id)


@router.post("/metric-variances/{variance_id}/explain", response_model=VarianceOut,
             responses=_ERRORS)  # fmt: skip
async def explain_metric_variance(
    variance_id: uuid.UUID, body: ExplainIn, principal: Viewer, db: TenantDB
) -> VarianceOut:
    """Explain a variance (10 to 1,000 characters): the metric's owner or an approver."""
    await recheck_caller(db, principal, "viewer")
    row, metric = await _variance(db, variance_id)
    _owner_or_approver(principal, metric)
    try:
        await service.explain(db, row, body.explanation, principal.user_id, body.lock_version)
    except service.MetricError as exc:
        raise _fail(exc) from None
    await audit.record(db, principal, "metric_variance.explained", "metric_variance", row.id,
                       {"metric_id": str(metric.id)})  # fmt: skip
    await db.commit()
    return await _variance_out(db, row)


@router.post("/metric-variances/{variance_id}/unknown", response_model=VarianceOut,
             responses=_ERRORS)  # fmt: skip
async def mark_metric_variance_unknown(
    variance_id: uuid.UUID, body: UnknownIn, principal: Viewer, db: TenantDB
) -> VarianceOut:
    """Don't know yet, with a day to find out by (1 to 28 days ahead): the metric's owner
    or an approver."""
    await recheck_caller(db, principal, "viewer")
    row, metric = await _variance(db, variance_id)
    _owner_or_approver(principal, metric)
    try:
        await service.unknown(db, row, body.find_out_by, body.lock_version)
    except service.MetricError as exc:
        raise _fail(exc) from None
    await audit.record(db, principal, "metric_variance.unknown", "metric_variance", row.id,
                       {"find_out_by": body.find_out_by.isoformat()})  # fmt: skip
    await db.commit()
    return await _variance_out(db, row)


@router.post("/metric-variances/{variance_id}/noise", response_model=VarianceOut,
             responses=_ERRORS)  # fmt: skip
async def mark_metric_variance_noise(
    variance_id: uuid.UUID, body: NoiseIn, principal: Approver, db: TenantDB
) -> VarianceOut:
    """Mark a variance as noise, with a reason (approvers)."""
    await recheck_caller(db, principal, "approver")
    row, _ = await _variance(db, variance_id)
    try:
        await service.noise(db, row, body.reason, principal.user_id, body.lock_version)
    except service.MetricError as exc:
        raise _fail(exc) from None
    await audit.record(db, principal, "metric_variance.noise", "metric_variance", row.id, {})
    await db.commit()
    return await _variance_out(db, row)
