# ruff: noqa: F811 - the ritual fixtures are imported
"""Built-in rituals start paused until the first confirmed goal (owner decision
2026-10-29, "Start paused until goals"): a new company's built-ins that are on by
default wait paused while it has no confirmed goal; the first confirmed goal turns them
on, not the ones a person paused; a company with goals is unchanged.

Each test's card: protects=<the observable>; fails_when=<the wrong result it rejects>;
no_claim=<what green does not prove>.
"""

from datetime import timedelta

import pytest
from sqlalchemy import update

from oracle.baseline.models import Entity
from oracle.tenancy import tenant_session
from tests.baseline_helpers import confirm, entity
from tests.ritual_helpers import START, at, ctx, occurrences_of, rituals_of, tick  # noqa: F401

pytestmark = pytest.mark.rituals_wait_for_goal

# The built-ins on by default (kinds.enabled_by_default; F6's report is on by default).
DEFAULTS = {
    "goals_checkin", "roadmap_refresh", "goals_review", "decision_review",
    "strategy_review", "changelog", "alignment_report",
}  # fmt: skip
OFF = {"investor_update", "board_meeting", "metrics_review", "competitive_digest",
       "baseline_rebuild"}  # fmt: skip


async def goal(client, ctx, title: str = "Halve support tickets") -> dict:
    return await entity(client, ctx, type="goal", key="halve-tickets", title=title)


async def listed(client, ctx) -> dict[str, dict]:
    resp = await client.get("/v1/rituals", headers=ctx.as_("viewer"))
    assert resp.status_code == 200, resp.text
    return {r["kind"]: r for r in resp.json()}


async def test_a_new_company_s_tick_leaves_the_built_ins_paused(client, ctx, at):
    """protects=a company with no confirmed goal gets its built-ins paused, each default
    one saying it waits for the first goal; no tick prepares a pre-read or puts a row in
    the Inbox; fails_when=the first tick turns them on (the old behaviour), or a paused
    one is prepared; no_claim=the web's words (rituals-wait-for-goal.spec.ts)."""
    await goal(client, ctx)  # proposed only: not a confirmed goal
    await tick(ctx.tenant_id)
    seeded = await rituals_of(ctx.tenant_id)
    assert set(seeded) == DEFAULTS | OFF
    for r in seeded.values():
        assert r.status == "paused" and r.next_due_at is None
        assert r.waits_for_goal == (r.kind in DEFAULTS)
    out = await listed(client, ctx)
    assert {k for k, r in out.items() if r["waits_for_goal"]} == DEFAULTS
    # Weeks of ticks: nothing prepared, nothing in the Inbox.
    for days in (1, 3, 7, 14, 35):
        at(START + timedelta(days=days))
        await tick(ctx.tenant_id)
    assert await occurrences_of(ctx.tenant_id) == []
    inbox = (await client.get("/v1/inbox", headers=ctx.as_("owner"))).json()
    assert inbox["rituals"] == []


async def test_confirming_the_first_goal_turns_the_defaults_on(client, ctx, at):
    """protects=the first confirmed goal turns the default built-ins on, each with its
    next meeting, and leaves the ones off by default paused; fails_when=they stay paused,
    or an off-by-default one (Investor update) is turned on; no_claim=a goal confirmed
    by another path than its Confirm (the tick catches those: the next test)."""
    await tick(ctx.tenant_id)
    await confirm(client, ctx, await goal(client, ctx))
    out = await listed(client, ctx)
    for kind, r in out.items():
        on = kind in DEFAULTS
        assert r["status"] == ("active" if on else "paused"), kind
        assert (r["next_due_at"] is not None) == on, kind
        assert not r["waits_for_goal"]
    # The tick now prepares them as before: the goals check-in on its Monday.
    at(START + timedelta(days=7))
    await tick(ctx.tenant_id)
    checkin = (await rituals_of(ctx.tenant_id))["goals_checkin"]
    assert await occurrences_of(ctx.tenant_id, checkin.id)


async def test_a_goal_confirmed_before_the_first_tick_seeds_them_on(client, ctx, at):
    """protects=a company that already has a confirmed goal is unchanged: its first tick
    seeds the defaults on, as before; fails_when=they are seeded paused; no_claim=-."""
    await confirm(client, ctx, await goal(client, ctx))
    await tick(ctx.tenant_id)
    for r in (await rituals_of(ctx.tenant_id)).values():
        assert r.status == ("active" if r.kind in DEFAULTS else "paused"), r.kind
        assert not r.waits_for_goal


async def test_a_ritual_a_person_paused_stays_paused(client, ctx, at):
    """protects=a waiting built-in a person paused (or resumed and paused again) is theirs:
    the first confirmed goal and later ticks leave it paused; one a person turned on stays
    on; fails_when=the goal turns a hand-paused ritual on; no_claim=-."""
    await tick(ctx.tenant_id)
    seeded = await rituals_of(ctx.tenant_id)
    checkin, refresh = seeded["goals_checkin"], seeded["roadmap_refresh"]
    h = ctx.as_("owner")
    assert (await client.post(f"/v1/rituals/{checkin.id}/pause", headers=h)).status_code == 200
    assert (await client.post(f"/v1/rituals/{refresh.id}/resume", headers=h)).status_code == 200
    assert (await client.post(f"/v1/rituals/{refresh.id}/pause", headers=h)).status_code == 200
    out = await listed(client, ctx)
    assert not out["goals_checkin"]["waits_for_goal"]
    assert not out["roadmap_refresh"]["waits_for_goal"]
    await confirm(client, ctx, await goal(client, ctx))
    await tick(ctx.tenant_id)
    out = await listed(client, ctx)
    assert out["goals_checkin"]["status"] == "paused"
    assert out["roadmap_refresh"]["status"] == "paused"
    assert out["goals_review"]["status"] == "active"


async def test_an_existing_company_s_rituals_are_unchanged(client, ctx, at):
    """protects=a company whose built-ins were on before this change (no waiting mark, as
    the migration leaves every row) keeps them on with no confirmed goal; a goal confirmed
    later changes nothing; fails_when=the tick pauses an existing company's rituals;
    no_claim=-."""
    await confirm(client, ctx, await goal(client, ctx))
    await tick(ctx.tenant_id)
    before = {k: (r.status, r.next_due_at) for k, r in (await rituals_of(ctx.tenant_id)).items()}
    # Its only goal back to proposed: no confirmed goal, and nothing is paused.
    async with tenant_session(ctx.tenant_id) as db:
        await db.execute(update(Entity).where(Entity.type == "goal").values(status="proposed"))
        await db.commit()
    await tick(ctx.tenant_id)
    after = {k: (r.status, r.next_due_at) for k, r in (await rituals_of(ctx.tenant_id)).items()}
    assert after == before


async def test_a_goal_confirmed_another_way_turns_them_on_at_the_tick(client, ctx, at):
    """protects=a goal that became confirmed by another path (here written straight to the
    row) turns the defaults on at the next tick; fails_when=only the Confirm route wakes
    them; no_claim=-."""
    await tick(ctx.tenant_id)
    g = await goal(client, ctx)
    async with tenant_session(ctx.tenant_id) as db:
        await db.execute(update(Entity).where(Entity.id == g["id"]).values(status="confirmed"))
        await db.commit()
    assert (await rituals_of(ctx.tenant_id))["goals_checkin"].status == "paused"
    await tick(ctx.tenant_id)
    assert (await rituals_of(ctx.tenant_id))["goals_checkin"].status == "active"
