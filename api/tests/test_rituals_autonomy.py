# ruff: noqa: F811 - the ritual fixtures are imported
"""H2 Cadence engine under H11 Autonomy (issue #519, item 3): the ``rituals``
responsibility's level decides whether Oracle starts a ritual's own run, the
``ritual_summary`` of its pre-read, when the ticker makes an occurrence ready.

- "Act within limits": Oracle starts it itself when its estimate is within
  ``max_run_usd``, once per occurrence, then tells the ritual's owner ("Oracle did",
  with Undo cancelling the run);
- above the limit, or below "Act within limits": no run; the pre-read's Inbox row
  reminds the attendees, and Summarize with Oracle stays a person's click (today's
  behaviour);
- Every pre-read (``ritual_summaries`` = ``always``) is the owner's own choice: it
  starts the run at every level, and is not reported as something Oracle chose.

Oracle's ritual clock is set by the tests; the fake runtime stands in for SwarmCloud, so
no model is called. Made-up people only.

Each test's card: protects=<the observable>; fails_when=<the wrong result it rejects>;
no_claim=<what green does not prove>.
"""

import uuid

import pytest
from sqlalchemy import select

from oracle.autonomy_models import OracleAction
from oracle.runs.models import Run
from oracle.swarm import FakeRuntime, Outcome, set_runtime
from oracle.tenancy import tenant_session
from tests.ritual_helpers import (  # noqa: F401 - fixtures
    at,
    ctx,
    only,
    ready_occurrence,
    tick,
)


@pytest.fixture
def summary_runtime():
    fake = FakeRuntime({"summary": [Outcome(artifacts={"summary.md": "Two goals slipped."})]})
    set_runtime(fake)
    yield fake
    set_runtime(None)


async def summary_runs(tenant_id: uuid.UUID) -> list[Run]:
    async with tenant_session(tenant_id) as db:
        return list(await db.scalars(select(Run).where(Run.flow == "ritual_summary")))


async def ritual_actions(tenant_id: uuid.UUID) -> list[OracleAction]:
    async with tenant_session(tenant_id) as db:
        return list(
            await db.scalars(select(OracleAction).where(OracleAction.responsibility == "rituals"))
        )


async def set_level(client, ctx, level: str, **limits) -> None:
    """An owner sets Run rituals on Settings › Autonomy (the screen's own route)."""
    body: dict = {"level": level, "reason": "Trying a new cadence"}
    if limits:
        body["limits"] = limits
    resp = await client.put("/v1/autonomy/rituals", json=body, headers=ctx.as_("owner"))
    assert resp.status_code == 200, resp.text


async def test_at_act_the_tick_starts_one_summary_and_tells_the_owner(
    client, ctx, at, summary_runtime
):
    """protects=item 3: at "Act within limits" (default $10 a run) and On demand, the
    tick that readies a covered occurrence starts exactly one ritual_summary run ($3.00)
    created by the ritual's owner, ten more ticks start no second, and one "Oracle did"
    row (responsibility rituals) reaches the owner's Inbox naming the ritual, with Undo
    cancelling that run; fails_when=no run starts, two start, it is created as someone
    else, or the owner is not told; no_claim=the summary's content or the Inbox screen
    (Playwright)."""
    await only(client, ctx, "goals_checkin")
    await set_level(client, ctx, "act")
    occ = await ready_occurrence(client, ctx, at, "goals_checkin")
    runs = await summary_runs(ctx.tenant_id)
    assert len(runs) == 1
    assert runs[0].created_by == ctx.users["owner"].id
    assert float(runs[0].estimate_usd) == 3.0
    for _ in range(10):
        await tick(ctx.tenant_id)
    assert len(await summary_runs(ctx.tenant_id)) == 1
    got = await client.get(f"/v1/ritual-occurrences/{occ['id']}", headers=ctx.as_("owner"))
    assert got.json()["summary_state"] == "running"
    assert got.json()["summary_run_id"] == str(runs[0].id)

    (action,) = await ritual_actions(ctx.tenant_id)
    assert action.notify_ids == [ctx.users["owner"].id]
    assert action.subject["occurrence_id"] == occ["id"]
    assert action.subject["run_id"] == str(runs[0].id)
    assert action.undo == {"method": "POST", "path": f"/v1/runs/{runs[0].id}/cancel", "body": None}
    inbox = (await client.get("/v1/inbox", headers=ctx.as_("owner"))).json()
    (row,) = [r for r in inbox["oracle_actions"] if r["responsibility"] == "rituals"]
    assert "Weekly goals check-in" in row["summary"] and row["counts"] is True
    assert "workspace" not in row["summary"].lower() and "tenant" not in row["summary"].lower()
    approver = (await client.get("/v1/inbox", headers=ctx.as_("approver"))).json()
    assert not [r for r in approver["oracle_actions"] if r["responsibility"] == "rituals"]


async def test_above_the_cost_limit_act_only_reminds(client, ctx, at, summary_runtime):
    """protects=item 3: at "Act within limits" with a $2 limit, a $3.00 summary is not
    started; the attendees still get the pre-read's Inbox row (the reminder);
    fails_when=a run starts over the limit or Oracle reports acting; no_claim=the
    Settings screen's limit field (Playwright)."""
    await only(client, ctx, "goals_checkin")
    await set_level(client, ctx, "act", max_run_usd=2)
    occ = await ready_occurrence(client, ctx, at, "goals_checkin")
    assert await summary_runs(ctx.tenant_id) == []
    assert await ritual_actions(ctx.tenant_id) == []
    inbox = (await client.get("/v1/inbox", headers=ctx.as_("approver"))).json()
    assert [r["reason"] for r in inbox["rituals"] if r["occurrence_id"] == occ["id"]] == [
        "pre_read"
    ]


@pytest.mark.parametrize("level", ["observe", "draft", "recommend"])
async def test_below_act_only_reminds(client, ctx, at, summary_runtime, level):
    """protects=item 3: below "Act within limits" (On demand) the tick starts no summary
    run and records nothing Oracle did; the pre-read's Inbox row is the reminder;
    fails_when=a run starts or an "Oracle did" row appears; no_claim=what Draft and
    Recommend add later (a drafted pre-read is today's behaviour)."""
    await only(client, ctx, "goals_checkin")
    await set_level(client, ctx, level)
    occ = await ready_occurrence(client, ctx, at, "goals_checkin")
    for _ in range(3):
        await tick(ctx.tenant_id)
    assert await summary_runs(ctx.tenant_id) == []
    assert await ritual_actions(ctx.tenant_id) == []
    inbox = (await client.get("/v1/inbox", headers=ctx.as_("owner"))).json()
    assert any(r["occurrence_id"] == occ["id"] for r in inbox["rituals"])


async def test_every_pre_read_is_the_owners_choice_not_oracles(client, ctx, at, summary_runtime):
    """protects=Every pre-read keeps its behaviour at "Act within limits": one run per
    occurrence, and no "Oracle did" row (an owner chose it; Oracle decided nothing);
    fails_when=two runs start or Oracle reports acting; no_claim=the summaries setting's
    estimate (test_rituals.py)."""
    await only(client, ctx, "goals_checkin")
    resp = await client.put(
        "/v1/rituals/summaries", json={"mode": "always"}, headers=ctx.as_("owner")
    )
    assert resp.status_code == 200, resp.text
    await set_level(client, ctx, "act")
    await ready_occurrence(client, ctx, at, "goals_checkin")
    assert len(await summary_runs(ctx.tenant_id)) == 1
    assert await ritual_actions(ctx.tenant_id) == []


async def test_a_changelog_occurrence_starts_no_run_at_act(client, ctx, at, summary_runtime):
    """protects=a kind with no run of its own (changelog: its pre-read is already a
    draft) starts nothing at "Act within limits"; fails_when=a summary run starts for it;
    no_claim=H8's update draft run (not started by rituals yet)."""
    await only(client, ctx, "changelog")
    await set_level(client, ctx, "act")
    await ready_occurrence(client, ctx, at, "changelog")
    assert await summary_runs(ctx.tenant_id) == []
    assert await ritual_actions(ctx.tenant_id) == []


async def test_run_rituals_is_wired(client, ctx):
    """protects=Settings › Autonomy shows Run rituals as built (its level now steers the
    ticker); fails_when=wired is false; no_claim=the screen's badge (Playwright)."""
    got = (await client.get("/v1/autonomy", headers=ctx.as_("viewer"))).json()
    by = {r["key"]: r for r in got["items"]}
    assert by["rituals"]["wired"] is True
