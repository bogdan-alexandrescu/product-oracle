# ruff: noqa: F811 - the ritual fixtures are imported
"""H2 Cadence engine on the ticker: seeding the built-in rituals, creating each
occurrence once, failure isolation, missed occurrences, and the Every pre-read summary
start. Oracle's ritual clock is set by the tests; the fake runtime stands in for
SwarmCloud, so no model is called.

Each test's card: protects=<the observable>; fails_when=<the wrong result it rejects>;
no_claim=<what green does not prove>.
"""

import asyncio
import uuid
from datetime import timedelta

import pytest
from sqlalchemy import select

from oracle.rituals import blocks
from oracle.rituals import service as rituals
from oracle.runs.models import Run
from oracle.swarm import FakeRuntime, Outcome, set_runtime
from oracle.tenancy import tenant_session
from oracle.ticker import router as ticker
from tests.ritual_helpers import (  # noqa: F401 - fixtures
    at,
    ctx,
    occurrences_of,
    ready_occurrence,
    rituals_of,
    tick,
)


async def summary_runs(tenant_id: uuid.UUID) -> list[Run]:
    async with tenant_session(tenant_id) as db:
        return list(await db.scalars(select(Run).where(Run.flow == "ritual_summary")))


async def set_mode(client, ctx, mode: str) -> None:
    resp = await client.put("/v1/rituals/summaries", json={"mode": mode}, headers=ctx.as_("owner"))
    assert resp.status_code == 200, resp.text


async def test_the_first_tick_seeds_the_built_ins_once(ctx, at):
    """protects=criterion 2: the first tick seeds the built-ins whose feature exists, the
    three on today's data active, owned by the earliest owner with owners and approvers
    attending; a second tick seeds nothing; fails_when=a kind whose feature is missing is
    seeded, a built-in is seeded twice, or the owner/attendees are wrong; no_claim=the
    H1/H4/H6/H8 kinds once their block builders are registered."""
    await tick(ctx.tenant_id)
    seeded = await rituals_of(ctx.tenant_id)
    assert set(seeded) == {"goals_checkin", "roadmap_refresh", "goals_review"}
    for r in seeded.values():
        assert r.status == "active" and r.builtin
        assert r.owner_id == ctx.users["owner"].id
        assert set(r.attendee_ids) == {ctx.users["owner"].id, ctx.users["approver"].id}
        assert r.schedule["timezone"] == "UTC" and r.next_due_at is not None
    assert "investor_update" not in seeded and "board_meeting" not in seeded
    await tick(ctx.tenant_id)
    assert len(await rituals_of(ctx.tenant_id)) == 3


async def test_an_occurrence_is_created_once_at_its_preparation_moment(ctx, at):
    """protects=criterion 3: a ritual due at T with 24 h of preparation is ready on the
    first tick at or after T-24h, and ten more ticks (two of them overlapping) create no
    second occurrence; fails_when=it is prepared early, twice, or never; no_claim=the
    content of the blocks (test_rituals.py)."""
    await tick(ctx.tenant_id)
    ritual = (await rituals_of(ctx.tenant_id))["roadmap_refresh"]
    due = ritual.next_due_at
    assert ritual.prep_hours == 24
    at(due - timedelta(hours=24, minutes=1))
    await tick(ctx.tenant_id)
    assert await occurrences_of(ctx.tenant_id, ritual.id) == []
    at(due - timedelta(hours=24))
    await tick(ctx.tenant_id)
    (occ,) = await occurrences_of(ctx.tenant_id, ritual.id)
    assert occ.status == "ready" and occ.due_at == due
    assert occ.ends_at == due + timedelta(minutes=60)
    for _ in range(4):
        await tick(ctx.tenant_id)
    await asyncio.gather(tick(ctx.tenant_id), tick(ctx.tenant_id))
    for _ in range(4):
        await tick(ctx.tenant_id)
    assert len(await occurrences_of(ctx.tenant_id, ritual.id)) == 1
    after = (await rituals_of(ctx.tenant_id))["roadmap_refresh"]
    assert after.next_due_at > due


async def test_a_failing_builder_retries_three_times_then_fails_into_the_inbox(
    client, ctx, at, monkeypatch
):
    """protects=criterion 4: a builder that raises leaves the occurrence scheduled with
    attempts counted, the third failure makes it failed with an owners' Inbox row, and
    the company's other rituals are still prepared in the same tick; fails_when=one
    failure stops the others, it retries forever, or no row appears; no_claim=Retry from
    the screen."""
    await tick(ctx.tenant_id)
    seeded = await rituals_of(ctx.tenant_id)
    original = blocks.BUILDERS["tracks"]

    async def broken(*args, **kwargs):
        raise RuntimeError("tracks unavailable")

    monkeypatch.setitem(blocks.BUILDERS, "tracks", broken)
    at(max(r.next_due_at for r in seeded.values()))
    await tick(ctx.tenant_id)
    by_ritual = {o.ritual_id: o for o in await occurrences_of(ctx.tenant_id)}
    refresh = by_ritual[seeded["roadmap_refresh"].id]
    assert refresh.status == "scheduled" and refresh.attempts == 1
    # The other rituals were prepared in the same tick (the check-in's has since ended).
    for kind in ("goals_checkin", "goals_review"):
        other = by_ritual[seeded[kind].id]
        assert other.pre_read_built_at is not None and other.attempts == 0
    await tick(ctx.tenant_id)
    await tick(ctx.tenant_id)
    by_ritual = {o.ritual_id: o for o in await occurrences_of(ctx.tenant_id)}
    refresh = by_ritual[seeded["roadmap_refresh"].id]
    assert refresh.status == "failed" and refresh.attempts == 3
    inbox = (await client.get("/v1/inbox", headers=ctx.as_("owner"))).json()
    failed = [r for r in inbox["rituals"] if r["reason"] == "failed"]
    assert [r["occurrence_id"] for r in failed] == [str(refresh.id)]
    assert failed[0]["counts"] is True
    # Retry (Prepare now) rebuilds it once the builder works again.
    monkeypatch.setitem(blocks.BUILDERS, "tracks", original)
    resp = await client.post(
        f"/v1/rituals/{seeded['roadmap_refresh'].id}/prepare", headers=ctx.as_("owner")
    )
    assert resp.status_code == 200, resp.text
    assert resp.json()["id"] == str(refresh.id) and resp.json()["status"] == "ready"


async def test_a_ready_occurrence_with_nothing_recorded_is_missed_after_seven_days(client, ctx, at):
    """protects=criterion 7: ready and nothing recorded 7 days after its end is missed,
    and its rows leave the Inbox; fails_when=it stays ready or keeps an Inbox row;
    no_claim=held or skipped ones (never missed)."""
    occ = await ready_occurrence(client, ctx, at)
    ends = rituals.parse_time(occ["ends_at"])
    at(ends + timedelta(days=7) - timedelta(minutes=1))
    await tick(ctx.tenant_id)
    inbox = (await client.get("/v1/inbox", headers=ctx.as_("owner"))).json()
    assert any(r["occurrence_id"] == occ["id"] for r in inbox["rituals"])
    at(ends + timedelta(days=7))
    await tick(ctx.tenant_id)
    got = await client.get(f"/v1/ritual-occurrences/{occ['id']}", headers=ctx.as_("owner"))
    assert got.json()["status"] == "missed"
    inbox = (await client.get("/v1/inbox", headers=ctx.as_("owner"))).json()
    assert not any(r["occurrence_id"] == occ["id"] for r in inbox["rituals"])


async def test_the_ticker_calls_the_rituals_step(ctx, at, monkeypatch):
    """protects=the scheduled ticker runs rituals.tick_due for each company, in its own
    try; fails_when=the step is not wired or its failure stops the tick; no_claim=the
    ticker's other steps (test_run_ticker.py)."""
    seen = []

    async def fake(db):
        seen.append(db)
        raise RuntimeError("boom")

    monkeypatch.setattr(rituals, "tick_due", fake)
    out = ticker.TickerOut()
    failures = ticker._Failures(out)
    await ticker._tick_company(ctx.tenant_id, out, failures)
    assert len(seen) == 1


@pytest.fixture
def summary_runtime():
    fake = FakeRuntime({"summary": [Outcome(artifacts={"summary.md": "Two tracks slipped."})]})
    set_runtime(fake)
    yield fake
    set_runtime(None)


async def test_every_pre_read_starts_one_summary_per_covered_occurrence(
    client, ctx, at, summary_runtime
):
    """protects=criterion 9b: with Every pre-read, the tick that readies a covered
    occurrence starts exactly one ritual_summary run created by the ritual's owner, and
    ten more ticks start no second; fails_when=none starts, two start, or it is created
    as someone else; no_claim=the run's content."""
    await set_mode(client, ctx, "always")
    occ = await ready_occurrence(client, ctx, at, "goals_checkin")
    runs = await summary_runs(ctx.tenant_id)
    assert len(runs) == 1
    assert runs[0].created_by == ctx.users["owner"].id
    for _ in range(10):
        await tick(ctx.tenant_id)
    assert len(await summary_runs(ctx.tenant_id)) == 1
    got = await client.get(f"/v1/ritual-occurrences/{occ['id']}", headers=ctx.as_("owner"))
    assert got.json()["summary_state"] == "running"
    assert got.json()["summary_run_id"] == str(runs[0].id)


async def test_on_demand_starts_no_summary_on_the_tick(client, ctx, at, summary_runtime):
    """protects=criterion 9b: with On demand (the default) no tick starts a summary run;
    fails_when=a run starts anyway; no_claim=the button (test_rituals.py)."""
    await ready_occurrence(client, ctx, at, "goals_checkin")
    for _ in range(3):
        await tick(ctx.tenant_id)
    assert await summary_runs(ctx.tenant_id) == []


async def test_an_owner_who_cannot_start_runs_gets_not_started(client, ctx, at, summary_runtime):
    """protects=criterion 9b: with the ritual's owner demoted to commenter, no run starts
    and the occurrence says why; fails_when=a run starts as a commenter, or the reason is
    missing; no_claim=disabled owners (the same check)."""
    await set_mode(client, ctx, "always")
    async with tenant_session(ctx.tenant_id) as db:
        user = await db.get(type(ctx.users["owner"]), ctx.users["owner"].id)
        await tick(ctx.tenant_id)
        user.role = "commenter"
        await db.commit()
    ritual = (await rituals_of(ctx.tenant_id))["goals_checkin"]
    at(ritual.next_due_at)
    await tick(ctx.tenant_id)
    assert await summary_runs(ctx.tenant_id) == []
    (occ,) = await occurrences_of(ctx.tenant_id, ritual.id)
    assert occ.summary_state == "not_started"
    assert occ.summary_note == "Summary not started: the ritual's owner can no longer start runs"


async def test_a_failed_summary_run_leaves_the_pre_read_and_can_be_retried(client, ctx, at):
    """protects=criterion 9b: a summary run that fails sets summary_state failed and
    leaves the pre-read as it was; POST …/summary then starts a new one; fails_when=the
    pre-read changes, the state stays running, or the retry is refused; no_claim=the
    runtime's own retry rules."""
    set_runtime(FakeRuntime({"summary": [Outcome(state="failed", error="runtime down")]}))
    try:
        await set_mode(client, ctx, "always")
        occ = await ready_occurrence(client, ctx, at, "goals_checkin")
        resp = await client.post("/v1/internal/tick", headers=ctx.as_("owner"))
        assert resp.status_code == 200, resp.text
        await client.post("/v1/internal/tick", headers=ctx.as_("owner"))
        got = (
            await client.get(f"/v1/ritual-occurrences/{occ['id']}", headers=ctx.as_("owner"))
        ).json()
        assert got["summary_state"] == "failed"
        assert got["pre_read"] == occ["pre_read"]
        resp = await client.post(
            f"/v1/ritual-occurrences/{occ['id']}/summary", headers=ctx.as_("approver")
        )
        assert resp.status_code == 201, resp.text
        assert len(await summary_runs(ctx.tenant_id)) == 2
    finally:
        set_runtime(None)


async def test_a_changelog_occurrence_is_not_covered():
    """protects=criterion 9b: changelog, investor_update and board_meeting are never
    summarised automatically (their pre-read is a draft); fails_when=one is covered;
    no_claim=those kinds' availability (they need H6/H8 builders)."""
    from oracle.rituals.summaries import COVERED

    assert "changelog" not in COVERED
    assert "investor_update" not in COVERED and "board_meeting" not in COVERED
    assert {"goals_checkin", "roadmap_refresh", "goals_review", "custom"} <= COVERED
