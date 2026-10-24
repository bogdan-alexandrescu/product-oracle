"""Shared setup for the H3 Predicted versus actual tests: the H6 launch world (an
approved PRD, its track, a roadmap of three items built from it), with a typed goal at
38% and an outcome entity predicting 42% for payment-step, then the roadmap approved,
which captures the predictions. Made-up names only."""

import uuid
from datetime import UTC, date, datetime, timedelta

from sqlalchemy import select

from oracle.baseline.models import Edge, Entity, EntityRevision
from oracle.quality.models import OutcomeRecord
from oracle.tenancy import tenant_session
from tests.day_helpers import company_today
from tests.launch_helpers import approve_roadmap, build_roadmap, trace_features
from tests.test_roadmap import approved_prd, seed_baseline

GOAL_ATTRS = {
    "metric": "activated accounts",
    "unit": "%",
    "comparison": "at_least",
    "target": 45,
    "current": 38,
    "current_as_of": "2026-10-01",
    "horizon": "short",
}


async def typed_goal_and_outcome(tenant_id: uuid.UUID) -> None:
    """The seed goal with typed fields at 38%, and an outcome entity linked to
    payment-step predicting 42%. shipping-step has no numeric prediction."""
    async with tenant_session(tenant_id) as s:
        goal = await s.scalar(select(Entity).where(Entity.type == "goal"))
        goal.attrs = dict(GOAL_ATTRS)
        pay = await s.scalar(
            select(Entity).where(Entity.type == "feature", Entity.key == "payment-step")
        )
        outcome = Entity(
            type="outcome",
            key="faster-payment",
            title="Buyers finish payment",
            status="confirmed",
            origin="user",
            attrs={"metric": "activated accounts", "unit": "%", "target": 42},
        )
        s.add(outcome)
        await s.flush()
        s.add(
            Edge(src_id=pay.id, dst_id=outcome.id, type="supports", status="confirmed",
                 origin="user")
        )  # fmt: skip
        await s.commit()


async def outcome_world(client, auth, runtime, tenant_id) -> dict[str, dict]:
    """The roadmap approved with the typed goal: its outcome records by item key."""
    await approved_prd(client, auth)
    await seed_baseline(tenant_id)
    await typed_goal_and_outcome(tenant_id)
    await build_roadmap(client, auth, runtime)
    await trace_features(tenant_id)
    await approve_roadmap(client, auth)
    rows = (await client.get("/v1/outcomes", headers=auth)).json()
    return {r["roadmap_item_key"]: r for r in rows}


async def set_record(tenant_id: uuid.UUID, outcome_id: str, **values) -> None:
    async with tenant_session(tenant_id) as s:
        row = await s.get(OutcomeRecord, uuid.UUID(outcome_id))
        for k, v in values.items():
            setattr(row, k, v)
        await s.commit()


async def goal_history(tenant_id: uuid.UUID, *values: tuple[str, date]) -> None:
    """Revisions of the goal's ``attrs.current`` as text ("41%"), dated."""
    async with tenant_session(tenant_id) as s:
        goal = await s.scalar(select(Entity).where(Entity.type == "goal"))
        for current, on in values:
            at = datetime(on.year, on.month, on.day, 12, tzinfo=UTC)
            rev = EntityRevision(
                entity_id=goal.id,
                before=None,
                after={"attrs": {**GOAL_ATTRS, "current": current}},
                actor="user",
                reason="test",
            )
            s.add(rev)
            await s.flush()
            rev.created_at = at
        goal.attrs = {**(goal.attrs or {}), "current": None, "current_text": values[-1][0]}
        await s.commit()


def days_ago(n: int) -> date:
    return company_today() - timedelta(days=n)
