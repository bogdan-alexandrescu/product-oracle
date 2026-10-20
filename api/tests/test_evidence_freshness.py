"""Evidence freshness (S6, owner 2026-10-20): frozen only for runs. People read the live
confidence, which decays as the source ages and follows it as it changes upstream; a
run reads it as of the snapshot it pinned when it started, from the item as it was when
the evidence was taken. Synthetic placeholders only."""

import uuid
from datetime import UTC, datetime, timedelta

import pytest

from oracle import confidence
from oracle.auth.service import make_session_cookie
from oracle.baseline import scoring
from oracle.config import get_settings
from oracle.runs.models import Run
from oracle.sources.models import Snapshot, SourceItem
from oracle.tenancy import tenant_session
from tests.baseline_helpers import cite, entity, make_ctx, make_item

B = "/v1/baseline"


@pytest.fixture
async def ctx():
    return await make_ctx()


def _close(a: float, b: float) -> bool:
    return abs(a - b) <= 0.002


def _slack(latest_at: datetime, now: datetime) -> float:
    """A Slack message's score with one mention and no goal impact."""
    factors = confidence.Factors(source_kind="slack", item_kind="message", latest_at=latest_at)
    return confidence.score(factors, now=now).confidence


async def _rescore(ctx, entity_id: str, now: datetime) -> None:
    async with tenant_session(ctx.tenant_id) as s:
        await scoring.rescore_targets(s, entity_ids=[uuid.UUID(entity_id)], now=now)
        await s.commit()


async def _changed_upstream(ctx, item_id: uuid.UUID, when: datetime) -> None:
    """The item changed upstream (a sync wrote its new update time)."""
    async with tenant_session(ctx.tenant_id) as s:
        (await s.get(SourceItem, item_id)).source_updated_at = when
        await s.commit()


async def _run_pinned_at(ctx, who: str, as_of: datetime) -> dict[str, str]:
    """Headers of a run ``who`` started, which pinned its snapshot at ``as_of``."""
    async with tenant_session(ctx.tenant_id) as s:
        user = ctx.users[who].id
        snapshot = Snapshot(label="Run pin", as_of=as_of, created_by=user)
        s.add(snapshot)
        await s.flush()
        run = Run(flow="baseline_to_prd", status="running", snapshot_id=snapshot.id, created_by=user)
        s.add(run)
        await s.commit()
        run_id = run.id
    cookie = make_session_cookie(ctx.users[who])
    return {
        "Cookie": f"{get_settings().session_cookie_name}={cookie}",
        "x-oracle-run-id": str(run_id),
    }


async def _read(client, feat: dict, headers: dict[str, str]) -> tuple[dict, float | None]:
    """(the entity's one piece of evidence, the entity's confidence) as ``headers`` read."""
    resp = await client.get(f"{B}/entities/{feat['id']}", headers=headers)
    assert resp.status_code == 200, resp.text
    body = resp.json()
    [row] = body["evidence"]
    return row, body["confidence"]


async def test_people_see_live_freshness_that_decays_as_the_source_ages(client, ctx):
    feat = await entity(client, ctx, type="feature", key="guided-setup")
    now = datetime.now(UTC)
    updated = now - timedelta(days=10)
    item = await make_item(ctx, "owner", updated=updated)
    await cite(client, ctx, feat, who="owner", source_item_id=str(item))

    await _rescore(ctx, feat["id"], now)
    first, _ = await _read(client, feat, ctx.as_("viewer"))
    assert _close(first["confidence"], _slack(updated, now))

    # Two months on, nothing changed upstream: the source is older, the score lower.
    later_at = now + timedelta(days=60)
    await _rescore(ctx, feat["id"], later_at)
    later, aggregate = await _read(client, feat, ctx.as_("viewer"))
    assert later["confidence"] < first["confidence"]
    assert _close(later["confidence"], _slack(updated, later_at))
    assert datetime.fromisoformat(later["confidence_factors"]["inputs"]["latest_at"]) == updated
    assert _close(aggregate, later["confidence"])

    # The source changes upstream: people see it as fresh as it is now.
    await _changed_upstream(ctx, item, later_at - timedelta(days=1))
    await _rescore(ctx, feat["id"], later_at)
    fresh, _ = await _read(client, feat, ctx.as_("owner"))
    assert fresh["confidence"] > later["confidence"]
    assert _close(fresh["confidence"], _slack(later_at - timedelta(days=1), later_at))


async def test_a_run_reads_freshness_as_of_its_pinned_snapshot(client, ctx):
    feat = await entity(client, ctx, type="feature", key="guided-setup")
    updated = datetime.now(UTC) - timedelta(days=10)
    item = await make_item(ctx, "owner", updated=updated)
    await cite(client, ctx, feat, who="owner", source_item_id=str(item))
    pin = datetime.now(UTC)
    run = await _run_pinned_at(ctx, "owner", pin)

    before, aggregate_before = await _read(client, feat, run)
    # The item as it was when the evidence was taken, scored at the pin.
    assert _close(before["confidence"], _slack(updated, pin))
    assert datetime.fromisoformat(before["confidence_factors"]["inputs"]["latest_at"]) == updated
    assert datetime.fromisoformat(before["scored_at"]) == pin
    assert before["source_item"]["id"] == str(item)

    # The source ages two months and changes upstream: people's score moves both ways,
    # the run's stays as of its snapshot, its entity's aggregate too.
    later_at = pin + timedelta(days=60)
    await _rescore(ctx, feat["id"], later_at)
    aged, _ = await _read(client, feat, ctx.as_("owner"))
    assert aged["confidence"] < before["confidence"]
    assert await _read(client, feat, run) == (before, aggregate_before)
    await _changed_upstream(ctx, item, later_at - timedelta(days=1))
    await _rescore(ctx, feat["id"], later_at)
    live, _ = await _read(client, feat, ctx.as_("owner"))
    assert live["confidence"] > aged["confidence"]
    assert await _read(client, feat, run) == (before, aggregate_before)

    # A run pinned later reads the same evidence older, never as it changed upstream.
    later_run = await _run_pinned_at(ctx, "owner", later_at)
    late, _ = await _read(client, feat, later_run)
    assert _close(late["confidence"], _slack(updated, later_at))


async def test_a_run_without_a_pinned_snapshot_reads_the_stored_score(client, ctx):
    """A run token whose run pinned nothing yet (no snapshot) gets the stored score."""
    feat = await entity(client, ctx, type="feature", key="guided-setup")
    item = await make_item(ctx, "owner")
    await cite(client, ctx, feat, who="owner", source_item_id=str(item))
    cookie = make_session_cookie(ctx.users["owner"])
    headers = {
        "Cookie": f"{get_settings().session_cookie_name}={cookie}",
        "x-oracle-run-id": str(uuid.uuid4()),
    }
    theirs, _ = await _read(client, feat, headers)
    mine, _ = await _read(client, feat, ctx.as_("owner"))
    assert theirs["confidence"] == mine["confidence"]
    assert theirs["scored_at"] == mine["scored_at"]


async def test_intake_refs_people_live_runs_as_of_the_pin(client, ctx):
    """An intake's evidence refs: the item's owner (a person) reads its live freshness,
    scored now; a run reads the version shown, scored at the intake's pin."""
    from dataclasses import replace

    from oracle.auth.deps import Principal
    from oracle.intake import evidence as intake_evidence

    updated = datetime.now(UTC) - timedelta(days=10)
    item = await make_item(ctx, "owner", updated=updated)
    pin = datetime.now(UTC)
    owner = Principal(
        tenant_id=ctx.tenant_id, kind="user", role="owner", user_id=ctx.users["owner"].id
    )
    run = replace(owner, run_id=uuid.uuid4())

    async def read():
        async with tenant_session(ctx.tenant_id) as s:
            version = (await s.get(SourceItem, item)).current_version_id
            mine = await intake_evidence.refs(s, [item], owner, pin)
            theirs = await intake_evidence.refs(
                s, [item], run, pin, reveal={item}, released={item: version}
            )
        return mine[item], theirs[item]

    mine, theirs = await read()
    assert mine.visible and theirs.visible
    assert _close(mine.confidence, _slack(updated, datetime.now(UTC)))
    await _changed_upstream(ctx, item, datetime.now(UTC))
    mine_after, theirs_after = await read()
    assert mine_after.confidence > mine.confidence
    assert theirs_after.confidence == theirs.confidence
