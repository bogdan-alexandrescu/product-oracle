# ruff: noqa: F811 - the ritual fixtures are imported
"""A scheduled baseline rebuild: the ``baseline_rebuild`` ritual kind (H2 rituals) that
starts B1's Build the baseline run on its cadence, under H11's ``baseline``
responsibility.

- the kind: "Baseline rebuild", the first Monday of the month at 09:00 Company time, no
  lead time, seeded paused (off by default);
- at Observe Oracle only reminds: no run; the pre-read's Inbox row is the reminder and
  its block links B1's Build the baseline sheet;
- at Draft or above Oracle starts one ``baseline`` run (standard depth, Confirm the
  baseline on) when its estimate is within Run rituals' ``max_run_usd``, created by the
  ritual's owner, then tells them ("Oracle did", with the estimate; Undo cancels it);
- above the limit, with a build already under way, or with an owner who can no longer
  start runs, nothing starts and the occurrence says why;
- the run's proposals land for review as B1's do (its checkpoint waits for a person).

Oracle's ritual clock is set by the tests; the fake runtime stands in for SwarmCloud, so
no model is called. Made-up people only.

Each test's card: protects=<the observable>; fails_when=<the wrong result it rejects>;
no_claim=<what green does not prove>.
"""

import uuid
from datetime import UTC, datetime

import pytest
from sqlalchemy import select

from oracle.autonomy_models import OracleAction
from oracle.rituals.kinds import KINDS
from oracle.runs.models import Checkpoint, Run
from oracle.swarm import FakeRuntime, set_runtime
from oracle.tenancy import tenant_session
from tests.ritual_helpers import (  # noqa: F401 - fixtures
    at,
    ctx,
    only,
    ready_occurrence,
    rituals_of,
    tick,
)

KIND = "baseline_rebuild"


@pytest.fixture
def runtime():
    fake = FakeRuntime()
    set_runtime(fake)
    yield fake
    set_runtime(None)


async def baseline_runs(tenant_id: uuid.UUID) -> list[Run]:
    async with tenant_session(tenant_id) as db:
        return list(
            await db.scalars(select(Run).where(Run.flow == "baseline").order_by(Run.created_at))
        )


async def baseline_actions(tenant_id: uuid.UUID) -> list[OracleAction]:
    async with tenant_session(tenant_id) as db:
        return list(
            await db.scalars(select(OracleAction).where(OracleAction.responsibility == "baseline"))
        )


async def set_level(client, ctx, key: str, level: str, **limits) -> None:
    """An owner sets a responsibility on Settings › Autonomy (the screen's own route)."""
    body: dict = {"level": level, "reason": "Trying the monthly rebuild"}
    if limits:
        body["limits"] = limits
    resp = await client.put(f"/v1/autonomy/{key}", json=body, headers=ctx.as_("owner"))
    assert resp.status_code == 200, resp.text


async def resumed(client, ctx) -> dict:
    """Seeds the built-ins, pauses every other one, and an owner turns the Baseline
    rebuild on (Company › Rituals › Resume)."""
    await only(client, ctx, KIND)
    ritual = (await rituals_of(ctx.tenant_id))[KIND]
    resp = await client.post(f"/v1/rituals/{ritual.id}/resume", headers=ctx.as_("owner"))
    assert resp.status_code == 200, resp.text
    return resp.json()


def test_the_kind_is_a_monthly_rebuild_off_by_default():
    """protects=the registry entry; fails_when=the title, default schedule, lead time or
    off-by-default changes, or it needs a feature that is not there; no_claim=seeding
    (next test)."""
    kind = KINDS[KIND]
    assert kind.title == "Baseline rebuild"
    assert kind.default_schedule == {
        "freq": "monthly", "week_of_month": 1, "weekday": 0, "time": "09:00"
    }  # fmt: skip
    assert kind.prep_hours == 0
    assert kind.blocks == ("baseline_rebuild",)
    assert kind.requires is None
    assert kind.enabled_by_default is False


async def test_it_is_seeded_paused_and_resumes_on_the_first_monday(client, ctx, at, runtime):
    """protects=off by default (seeded paused, no due time) and, once resumed, due the
    first Monday of the month at 09:00 in the Company time zone; fails_when=it is seeded
    active, or resumes on another day or hour; no_claim=the Rituals screen
    (Playwright)."""
    await tick(ctx.tenant_id)
    ritual = (await rituals_of(ctx.tenant_id))[KIND]
    assert ritual.status == "paused" and ritual.next_due_at is None
    assert ritual.builtin is True
    out = await resumed(client, ctx)
    # Monday 2 November 2026, 09:00 in Los Angeles (PST, after the 1 November shift).
    assert out["next_due_at"].startswith("2026-11-02T17:00:00")
    assert out["schedule"]["timezone"] == "America/Los_Angeles"


@pytest.mark.parametrize("level", ["draft", "recommend", "act"])
async def test_from_draft_up_the_occurrence_starts_one_build(client, ctx, at, runtime, level):
    """protects=at Draft or above, the occurrence that falls due starts exactly one
    Build the baseline run (standard, $7.00, Confirm the baseline on) created by the
    ritual's owner, ticks after it start no second, and the owner gets one "Oracle did"
    row (responsibility baseline) with the estimate and Undo cancelling the run;
    fails_when=no run starts, two start, it skips the checkpoint, it is created as
    someone else, or the owner is not told; no_claim=the Inbox screen (Playwright)."""
    await resumed(client, ctx)
    await set_level(client, ctx, "baseline", level)
    occ = await ready_occurrence(client, ctx, at, KIND)
    (run,) = await baseline_runs(ctx.tenant_id)
    assert run.created_by == ctx.users["owner"].id
    assert float(run.estimate_usd) == 7.0
    assert run.knobs["depth"] == "standard"
    assert run.knobs["checkpoints"]["baseline_confirm"] is True
    assert run.status == "running"
    for _ in range(5):
        await tick(ctx.tenant_id)
    assert len(await baseline_runs(ctx.tenant_id)) == 1
    got = (await client.get(f"/v1/ritual-occurrences/{occ['id']}", headers=ctx.as_("owner"))).json()
    assert got["summary_state"] == "running"
    assert got["summary_run_id"] == str(run.id)
    assert got["summary_offered"] is False

    (action,) = await baseline_actions(ctx.tenant_id)
    assert action.notify_ids == [ctx.users["owner"].id]
    assert action.subject == {
        "kind": "ritual", "key": occ["ritual_id"], "href": f"/company/rituals/{occ['id']}"
    }  # fmt: skip
    assert action.undo == {"method": "POST", "path": f"/v1/runs/{run.id}/cancel", "body": None}
    inbox = (await client.get("/v1/inbox", headers=ctx.as_("owner"))).json()
    (row,) = [r for r in inbox["oracle_actions"] if r["responsibility"] == "baseline"]
    assert row["summary"] == "Started the baseline rebuild · Estimate $7.00, within your $10 limit"
    assert row["counts"] is True


async def test_the_builds_proposals_wait_for_a_person(client, ctx, at, runtime):
    """protects=the run is B1's: once the runtime finishes, it waits at Confirm the
    baseline with its import, and the goals it read stay proposed; fails_when=the run
    ends on its own or a goal is confirmed without a person; no_claim=the review screen
    (B2's)."""
    from oracle.baseline.models import Entity

    await resumed(client, ctx)
    await ready_occurrence(client, ctx, at, KIND)
    (run,) = await baseline_runs(ctx.tenant_id)
    for _ in range(3):
        resp = await client.post("/v1/internal/tick", headers=ctx.as_("owner"))
        assert resp.status_code == 200, resp.text
    async with tenant_session(ctx.tenant_id) as db:
        status = await db.scalar(select(Run.status).where(Run.id == run.id))
        cps = list(await db.scalars(select(Checkpoint).where(Checkpoint.run_id == run.id)))
        goals = list(await db.scalars(select(Entity).where(Entity.type == "goal")))
    assert status == "awaiting_checkpoint"
    assert [(c.kind, c.status) for c in cps] == [("baseline_confirm", "pending")]
    assert all(g.status != "confirmed" for g in goals)


async def test_at_observe_oracle_only_reminds(client, ctx, at, runtime):
    """protects=at Observe no run starts and Oracle reports nothing it did; the
    attendees' pre-read Inbox row is the reminder, the occurrence says why, and its block
    links Build the baseline with the estimate; fails_when=a run starts, an "Oracle did"
    row appears, or no reminder reaches the attendees; no_claim=the sheet itself (B1's
    Playwright)."""
    await resumed(client, ctx)
    await set_level(client, ctx, "baseline", "observe")
    occ = await ready_occurrence(client, ctx, at, KIND)
    assert await baseline_runs(ctx.tenant_id) == []
    assert await baseline_actions(ctx.tenant_id) == []
    assert occ["summary_state"] == "not_started"
    assert occ["summary_note"] == (
        "Not started: Oracle is set to observe the baseline. Build it from the Baseline page."
    )
    (block,) = occ["pre_read"]["blocks"]
    assert block["key"] == "baseline_rebuild" and block["title"] == "Baseline rebuild"
    texts = [r["text"] for r in block["rows"]]
    assert "Estimate $7.00 at standard depth" in texts
    build = [r for r in block["rows"] if r.get("href") == "/baseline?build=1"]
    assert build and build[0]["label"] == "Build the baseline"
    inbox = (await client.get("/v1/inbox", headers=ctx.as_("approver"))).json()
    assert [r["reason"] for r in inbox["rituals"] if r["occurrence_id"] == occ["id"]] == [
        "pre_read"
    ]


async def test_above_the_cost_limit_nothing_starts(client, ctx, at, runtime):
    """protects=the cost limit: with Run rituals' limit at $5 a $7.00 build is not
    started and the occurrence names both figures; fails_when=a run starts over the
    limit or Oracle reports acting; no_claim=P3's over-$50 approval (B1's runs never
    reach it at default roles)."""
    await resumed(client, ctx)
    await set_level(client, ctx, "rituals", "act", max_run_usd=5)
    occ = await ready_occurrence(client, ctx, at, KIND)
    assert await baseline_runs(ctx.tenant_id) == []
    assert await baseline_actions(ctx.tenant_id) == []
    assert occ["summary_state"] == "not_started"
    assert occ["summary_note"] == (
        "Not started: the estimate $7.00 is above your $5 limit a run. "
        "Build it from the Baseline page."
    )


async def test_a_build_under_way_is_not_doubled(client, ctx, at, runtime):
    """protects=B1's one build at a time: with a person's build running, the occurrence
    starts none and says so; fails_when=a second build starts or the tick fails;
    no_claim=B1's own 409 (test_baseline_flow.py)."""
    await resumed(client, ctx)
    resp = await client.post(
        "/v1/runs", json={"flow": "baseline", "knobs": {}}, headers=ctx.as_("approver")
    )
    assert resp.status_code == 201, resp.text
    first = resp.json()["id"]
    assert (
        await client.post(f"/v1/runs/{first}/estimate", headers=ctx.as_("approver"))
    ).status_code == 200
    assert (
        await client.post(f"/v1/runs/{first}/start", headers=ctx.as_("approver"))
    ).status_code == 200
    occ = await ready_occurrence(client, ctx, at, KIND)
    assert [str(r.id) for r in await baseline_runs(ctx.tenant_id)] == [first]
    assert occ["summary_state"] == "not_started"
    assert (
        occ["summary_note"] == f"Not started: a baseline build is already under way (run {first})"
    )
    assert await baseline_actions(ctx.tenant_id) == []


async def test_undo_cancels_and_the_occurrence_says_it_failed(client, ctx, at, runtime):
    """protects=the Oracle-did row's Undo route cancels the build, and the occurrence
    then shows it as not finished; fails_when=the cancel is refused or the occurrence
    still says running; no_claim=the Undo button (Playwright)."""
    await resumed(client, ctx)
    occ = await ready_occurrence(client, ctx, at, KIND)
    (run,) = await baseline_runs(ctx.tenant_id)
    resp = await client.post(f"/v1/runs/{run.id}/cancel", headers=ctx.as_("owner"))
    assert resp.status_code == 200, resp.text
    got = (await client.get(f"/v1/ritual-occurrences/{occ['id']}", headers=ctx.as_("owner"))).json()
    assert got["summary_state"] == "failed"
    assert (
        got["summary_note"] == "The baseline build did not finish · Build it from the Baseline page"
    )


async def test_summarize_is_not_offered_and_the_estimate_leaves_it_out(client, ctx, at, runtime):
    """protects=a rebuild occurrence is no summary: Summarize with Oracle answers 409,
    and the summaries' monthly estimate does not count it; fails_when=a ritual_summary
    run starts on it or the estimate rises; no_claim=the button's absence on screen
    (Playwright)."""
    await resumed(client, ctx)
    await set_level(client, ctx, "baseline", "observe")
    occ = await ready_occurrence(client, ctx, at, KIND)
    resp = await client.post(
        f"/v1/ritual-occurrences/{occ['id']}/summary", headers=ctx.as_("owner")
    )
    assert resp.status_code == 409, resp.text
    assert resp.json()["detail"] == "Start the baseline rebuild from the Baseline page"
    est = (await client.get("/v1/rituals/summaries", headers=ctx.as_("owner"))).json()
    assert [r["title"] for r in est["estimate"]["rituals"]] == []


async def test_an_owner_who_cannot_start_runs_gets_a_note(client, ctx, at, runtime):
    """protects=the run is created as the ritual's owner; when they are disabled no run
    starts and the occurrence says why; fails_when=a run starts as someone else;
    no_claim=reassigning the ritual (Company › Rituals inspector)."""
    from oracle.auth.models import User

    await resumed(client, ctx)
    await tick(ctx.tenant_id)
    ritual = (await rituals_of(ctx.tenant_id))[KIND]
    async with tenant_session(ctx.tenant_id) as db:
        owner = await db.get(User, ritual.owner_id)
        owner.disabled_at = datetime(2026, 10, 20, tzinfo=UTC)
        await db.commit()
    at(ritual.next_due_at)
    await tick(ctx.tenant_id)
    assert await baseline_runs(ctx.tenant_id) == []
    async with tenant_session(ctx.tenant_id) as db:
        from oracle.rituals.models import RitualOccurrence

        (occ,) = list(
            await db.scalars(
                select(RitualOccurrence).where(RitualOccurrence.ritual_id == ritual.id)
            )
        )
    assert occ.summary_state == "not_started"
    assert occ.summary_note == "Not started: the ritual's owner can no longer start runs"
