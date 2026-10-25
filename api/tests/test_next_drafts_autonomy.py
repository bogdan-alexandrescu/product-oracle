"""D12 One Build next draft under H11 Autonomy: the ``next_drafts`` responsibility.

- Observe: Oracle counts staged changes and builds nothing: the plan says so (both
  engines), and the built-in build and the agents' run are refused (409);
- Draft (default): an approver clicks Build next draft (today, covered by
  test_next_draft.py);
- Recommend: the staged list says the staged changes are worth a draft once as many as
  ``min_staged`` wait;
- Act within limits: :func:`next_draft.oracle_builds_due` (the ticker's) queues the
  built-in build itself once ``min_staged`` changes wait, tells the people who staged
  them, never starts the agents' run and never applies the draft.

The model is a fake transport. Made-up people only.

Each test's card: protects=<the observable>; fails_when=<the wrong result it rejects>;
no_claim=<what green does not prove>.
"""

import pytest
from sqlalchemy import select

from oracle.auth.models import User
from oracle.autonomy_models import OracleAction
from oracle.jobs import next_draft
from oracle.jobs.models import LlmJob
from oracle.llm import gateway
from oracle.runs.models import Run
from oracle.seed import seed
from oracle.tenancy import tenant_session
from tests.claude_account_helpers import add_account, window
from tests.test_llm_jobs import (
    SLUG,
    FakeClaude,
    comment,
    feedback,
    import_draft,
    review_answer,
    tick,
)

DOC = f"/v1/documents/{SLUG}"
OBSERVE = next_draft.OBSERVING


@pytest.fixture
def fake():
    claude = FakeClaude()
    previous = gateway.set_transports(gateway.Transports(plan=claude, api_key=claude))
    yield claude
    gateway.set_transports(previous)


@pytest.fixture
async def ctx():
    r = await seed(token_name="test")
    return {"tenant_id": r.tenant_id, "headers": {"Authorization": f"Bearer {r.token}"}}


@pytest.fixture
async def pool(ctx):
    return await add_account(ctx["tenant_id"], "personal", windows={"five_hour": window(0.2)})


TEXTS = {
    "goal-trace": "Serves activation: teams reaching a first report.",
    "problem": "Most new teams never invite a teammate.",
    "solution": "A guided checklist that teams can skip.",
}


async def stage(client, ctx, fake, keys=("goal-trace", "problem", "solution")) -> list[str]:
    """Draft 1 (imported once) and one accepted section-text suggestion per key: one
    staged text change each. Returns the suggestion ids."""
    if (await client.get(f"{DOC}/versions", headers=ctx["headers"])).status_code != 200:
        await import_draft(client, ctx)
    fids = [await comment(client, ctx, k, f"Change {k}, please.") for k in keys]
    fake.script["review_comments"].append(
        review_answer(
            [
                {
                    "feedback_id": fid,
                    "classification": "change_request",
                    "suggestion": {"kind": "section_text", "section_key": k, "text": TEXTS[k]},
                }
                for fid, k in zip(fids, keys, strict=True)
            ]
        )
    )
    await tick(client, ctx)
    fb = await feedback(client, ctx)
    out = []
    for fid in fids:
        sid = fb[fid]["suggestion"]["id"]
        resp = await client.post(f"/v1/suggestions/{sid}/accept", json={}, headers=ctx["headers"])
        assert resp.status_code == 200, resp.text
        out.append(sid)
    return out


async def set_level(client, ctx, level: str, **limits) -> None:
    """An owner sets Build next drafts on Settings › Autonomy (the screen's own route)."""
    body: dict = {"level": level, "reason": "Trying how drafts get built"}
    if limits:
        body["limits"] = limits
    resp = await client.put("/v1/autonomy/next_drafts", json=body, headers=ctx["headers"])
    assert resp.status_code == 200, resp.text


async def staged(client, ctx) -> dict:
    resp = await client.get(f"{DOC}/staged-changes", headers=ctx["headers"])
    assert resp.status_code == 200, resp.text
    return resp.json()


async def builds_due(tenant_id) -> int:
    async with tenant_session(tenant_id) as db:
        n = await next_draft.oracle_builds_due(db)
        await db.commit()
        return n


async def batch_jobs(tenant_id) -> list[LlmJob]:
    async with tenant_session(tenant_id) as db:
        return list(
            await db.scalars(
                select(LlmJob).where(LlmJob.kind == next_draft.KIND).order_by(LlmJob.created_at)
            )
        )


async def draft_actions(tenant_id) -> list[OracleAction]:
    async with tenant_session(tenant_id) as db:
        return list(
            await db.scalars(
                select(OracleAction).where(OracleAction.responsibility == "next_drafts")
            )
        )


# --- observe -----------------------------------------------------------------------------


async def test_observe_counts_staged_changes_and_builds_nothing(client, ctx, pool, fake):
    """protects=at Observe the staged list still counts the staged changes, the plan says
    Oracle builds nothing (refused, in plain words) and Build next draft and the agents'
    run are both refused 409 with the same words, so no job and no run exist;
    fails_when=a build or run starts at Observe, the count disappears, or the plan does
    not say why; no_claim=the sheet's disabled Build button (Playwright)."""
    await stage(client, ctx, fake)
    await set_level(client, ctx, "observe")
    assert len((await staged(client, ctx))["items"]) == 3

    resp = await client.post(f"{DOC}/next-draft/plan", json={}, headers=ctx["headers"])
    assert resp.status_code == 200, resp.text
    assert (resp.json()["engine"], resp.json()["refused"]) == ("oracle", OBSERVE)

    resp = await client.post(f"{DOC}/next-draft", json={}, headers=ctx["headers"])
    assert (resp.status_code, resp.json()["detail"]) == (409, OBSERVE)
    resp = await client.post(f"{DOC}/next-draft/run", json={}, headers=ctx["headers"])
    assert (resp.status_code, resp.json()["detail"]) == (409, OBSERVE)
    assert await batch_jobs(ctx["tenant_id"]) == []

    await set_level(client, ctx, "draft")
    resp = await client.post(f"{DOC}/next-draft", json={}, headers=ctx["headers"])
    assert resp.status_code == 201, resp.text


# --- recommend ---------------------------------------------------------------------------


async def test_recommend_says_a_draft_is_worth_building_from_min_staged(client, ctx, pool, fake):
    """protects=at Recommend the staged list's worth_a_draft says "N changes wait: worth
    building draft 2." once min_staged changes wait (3 here), nothing under it, nothing at
    Draft or Act, and nothing while a build is pending; fails_when=the sentence shows
    under the limit, at another level, or alongside a pending build; no_claim=the
    sheet's wording on screen (Playwright)."""
    await stage(client, ctx, fake, keys=("goal-trace", "problem"))
    await set_level(client, ctx, "recommend", min_staged=3)
    assert (await staged(client, ctx))["worth_a_draft"] is None

    await stage(client, ctx, fake, keys=("solution",))
    assert (await staged(client, ctx))["worth_a_draft"] == (
        "3 changes wait: worth building draft 2."
    )
    await set_level(client, ctx, "draft")
    assert (await staged(client, ctx))["worth_a_draft"] is None
    await set_level(client, ctx, "act")
    assert (await staged(client, ctx))["worth_a_draft"] is None

    await set_level(client, ctx, "recommend")
    resp = await client.post(f"{DOC}/next-draft", json={}, headers=ctx["headers"])
    assert resp.status_code == 201, resp.text
    assert (await staged(client, ctx))["worth_a_draft"] is None


# --- act ---------------------------------------------------------------------------------


async def test_act_builds_once_at_min_staged_and_tells_who_staged(client, ctx, pool, fake):
    """protects=at Act (min_staged 3) Oracle queues exactly one built-in build of every
    staged change, with no requester and by oracle, records one "Oracle did" row naming
    the document whose Undo discards that build and notifies the person who accepted the
    changes; a second pass starts nothing while it is pending; the draft is not applied;
    fails_when=no build, two builds, someone else is told, Undo points elsewhere, or a
    version is imported; no_claim=the ticker wiring (the lead's) or the Inbox screen."""
    sids = await stage(client, ctx, fake)
    await set_level(client, ctx, "act", min_staged=3)
    assert await builds_due(ctx["tenant_id"]) == 1
    assert await builds_due(ctx["tenant_id"]) == 0

    [job] = await batch_jobs(ctx["tenant_id"])
    assert job.requested_by is None
    assert job.input["by"] == "oracle"
    assert sorted(job.input["suggestion_ids"]) == sorted(sids)

    [action] = await draft_actions(ctx["tenant_id"])
    async with tenant_session(ctx["tenant_id"]) as db:
        [owner] = list(await db.scalars(select(User.id)))
    assert action.notify_ids == [owner]
    assert action.summary == "Started draft 2 of 'Onboarding revamp PRD' from 3 staged changes"
    assert action.subject == {
        "kind": "document",
        "key": SLUG,
        "href": f"/documents/{SLUG}/v/1?build=1",
    }
    assert action.undo == {
        "method": "POST",
        "path": f"{DOC}/next-draft/{job.id}/discard",
        "body": None,
    }
    # Undo, replayed as the person, discards the build; the changes stay staged.
    resp = await client.post(action.undo["path"], headers=ctx["headers"])
    assert resp.status_code == 200, resp.text
    s = await staged(client, ctx)
    assert (s["latest_version"], len(s["items"]), s["draft_job"]) == (1, 3, None)


async def test_a_discarded_build_waits_for_a_new_staged_change(client, ctx, pool, fake):
    """protects=after a person discards Oracle's build, later passes start nothing while
    the same changes wait, and one new staged change makes Oracle build again (taking
    all four); fails_when=Oracle rebuilds a discarded draft every tick, or never again;
    no_claim=timing of the ticker."""
    await stage(client, ctx, fake)
    await set_level(client, ctx, "act", min_staged=3)
    assert await builds_due(ctx["tenant_id"]) == 1
    [job] = await batch_jobs(ctx["tenant_id"])
    resp = await client.post(f"{DOC}/next-draft/{job.id}/discard", headers=ctx["headers"])
    assert resp.status_code == 200, resp.text
    assert await builds_due(ctx["tenant_id"]) == 0
    assert await builds_due(ctx["tenant_id"]) == 0

    # A fourth change, on a section already changed, is new to Oracle's last build.
    fid = await comment(client, ctx, "problem", "Name the cohort.")
    fake.script["review_comments"].append(
        review_answer(
            [
                {
                    "feedback_id": fid,
                    "classification": "change_request",
                    "suggestion": {
                        "kind": "section_text",
                        "section_key": "problem",
                        "text": "Most new teams (2026 cohort) never invite a teammate.",
                    },
                }
            ]
        )
    )
    await tick(client, ctx)
    sid = (await feedback(client, ctx))[fid]["suggestion"]["id"]
    resp = await client.post(f"/v1/suggestions/{sid}/accept", json={}, headers=ctx["headers"])
    assert resp.status_code == 200, resp.text
    assert await builds_due(ctx["tenant_id"]) == 1
    jobs = await batch_jobs(ctx["tenant_id"])
    assert len(jobs) == 2 and len(jobs[-1].input["suggestion_ids"]) == 4
    assert len(await draft_actions(ctx["tenant_id"])) == 2


async def test_below_act_or_under_min_staged_oracle_builds_nothing(client, ctx, pool, fake):
    """protects=at Draft and Recommend, and at Act with fewer staged changes than
    min_staged (default 5), oracle_builds_due starts nothing and records nothing;
    fails_when=Oracle builds below Act or under the limit; no_claim=Observe (refused
    above)."""
    await stage(client, ctx, fake)
    for level in ("draft", "recommend"):
        await set_level(client, ctx, level, min_staged=3)
        assert await builds_due(ctx["tenant_id"]) == 0
    await set_level(client, ctx, "act", min_staged=5)
    assert await builds_due(ctx["tenant_id"]) == 0
    assert await batch_jobs(ctx["tenant_id"]) == []
    assert await draft_actions(ctx["tenant_id"]) == []


async def test_act_never_starts_the_agents_run(client, ctx, pool, fake):
    """protects=when a staged item needs the agents (an item staged for them), Oracle at
    Act starts neither the agents' paid run nor a built-in build: that stays a person's
    click; fails_when=a Run or a refinement_batch job appears, or an action is recorded;
    no_claim=the agents' run itself (test_next_draft_engine.py)."""
    await stage(client, ctx, fake)
    fid = await comment(client, ctx, "solution", "Rethink the whole onboarding flow.")
    resp = await client.post(f"/v1/feedback/{fid}/stage-for-agents", headers=ctx["headers"])
    assert resp.status_code == 200, resp.text
    await set_level(client, ctx, "act", min_staged=3)
    assert await builds_due(ctx["tenant_id"]) == 0
    assert await batch_jobs(ctx["tenant_id"]) == []
    assert await draft_actions(ctx["tenant_id"]) == []
    async with tenant_session(ctx["tenant_id"]) as db:
        assert list(await db.scalars(select(Run))) == []
