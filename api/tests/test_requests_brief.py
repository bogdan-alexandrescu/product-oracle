"""C1 Requests, lane 2: Start a PRD from requests, the brief's "Requests behind it".

The brief (C4 One New PRD door) takes the qualified requests behind it; creating the
intake links them (``intake_id``) and the PRD its run makes links them (``document_id``),
so the people who asked see where their request went.

Each test's card is one line: protects / fails_when / no_claim. Synthetic placeholders
only.
"""

import uuid

import pytest
from sqlalchemy import select

from oracle.models import AuditEvent
from oracle.requests import service as requests_service
from oracle.runs.models import Run
from oracle.swarm import FakeRuntime, set_runtime
from oracle.tenancy import tenant_session
from tests.baseline_helpers import Ctx, make_ctx
from tests.intake_helpers import create_intake
from tests.test_requests import act, add, get, goal


@pytest.fixture
async def ctx() -> Ctx:
    return await make_ctx()


@pytest.fixture
def runtime():
    fake = FakeRuntime()
    set_runtime(fake)
    yield fake
    set_runtime(None)


async def qualified(client, ctx: Ctx, title: str, goal_id: str) -> dict:
    r = await add(client, ctx, title=title, goal_ids=[goal_id])
    resp = await act(client, ctx, r["id"], "qualify", note="Asked often")
    assert resp.status_code == 200, resp.text
    return resp.json()


async def test_brief_links_the_requests_behind_it(client, ctx):
    """protects=C1 brief field (creating the intake sets each request's intake_id, and the
    requesters see the brief on their request); fails_when=a request named in the brief is
    left unlinked, another request is linked, or the brief's title is missing from the
    request; no_claim=the PRD link (test_the_run_s_prd_links_the_requests)."""
    g = await goal(client, ctx)
    a = await qualified(client, ctx, "Keep the address", g["id"])
    b = await qualified(client, ctx, "Saved cards", g["id"])
    other = await qualified(client, ctx, "Dark mode", g["id"])
    out = await create_intake(client, ctx, request_ids=[a["id"], b["id"], a["id"]])
    intake_id = out["intake"]["id"]
    for r in (a, b):
        seen = await get(client, ctx, r["id"], who="viewer")
        assert seen["intake_id"] == intake_id
        assert seen["intake"] == {"id": intake_id, "title": "Saved addresses"}
        assert seen["document"] is None
    assert (await get(client, ctx, other["id"]))["intake_id"] is None
    resp = await client.get(
        "/v1/requests", params={"intake_id": intake_id}, headers=ctx.as_("viewer")
    )
    assert resp.status_code == 200, resp.text
    assert {r["id"] for r in resp.json()["items"]} == {a["id"], b["id"]}
    async with tenant_session(ctx.tenant_id) as s:
        [event] = list(
            await s.scalars(select(AuditEvent).where(AuditEvent.action == "intake.created"))
        )
    assert sorted(event.data["request_ids"]) == sorted([a["id"], b["id"]])


async def test_brief_takes_qualified_requests_only(client, ctx):
    """protects=C1 "qualified requests only, else 422"; fails_when=a New, merged or
    unknown request is linked, or a refused brief links anything; no_claim=who may see
    the requests (any member reads the queue)."""
    g = await goal(client, ctx)
    good = await qualified(client, ctx, "Keep the address", g["id"])
    fresh = await add(client, ctx, title="Not yet qualified")
    for bad in (fresh["id"], str(uuid.uuid4())):
        await create_intake(client, ctx, expect=422, request_ids=[good["id"], bad])
    assert (await get(client, ctx, good["id"]))["intake_id"] is None
    resp = await client.post(
        "/v1/intakes",
        json={
            "title": "Too many",
            "brief": "Returning buyers retype their address at every checkout.",
            "request_ids": [str(uuid.uuid4()) for _ in range(51)],
        },
        headers=ctx.as_("commenter"),
    )
    assert resp.status_code == 422


async def test_the_run_s_prd_links_the_requests(client, ctx, runtime):
    """protects=C1 rule 7 (Start a PRD sets document_id when the intake's run makes the
    PRD); fails_when=the requests behind the brief keep no PRD, a request linked to another
    PRD is overwritten, or a request outside the brief is linked; no_claim=the draft
    import itself (runs tests)."""
    from tests.v2_helpers import seed_v2

    seeded = await seed_v2(ctx.tenant_id)
    g = await goal(client, ctx)
    a = await qualified(client, ctx, "Keep the address", g["id"])
    b = await qualified(client, ctx, "Saved cards", g["id"])
    outside = await qualified(client, ctx, "Dark mode", g["id"])
    out = await create_intake(client, ctx, request_ids=[a["id"], b["id"]])
    intake_id = out["intake"]["id"]
    async with tenant_session(ctx.tenant_id) as s:
        run = Run(
            flow="baseline_to_prd",
            status="running",
            knobs={"intake_id": intake_id},
            document_id=seeded.document_id,
        )
        s.add(run)
        await s.flush()
        assert await requests_service.link_run_document(s, run) == 2
        await s.commit()
    for r in (a, b):
        seen = await get(client, ctx, r["id"])
        assert seen["document"]["id"] == str(seeded.document_id)
    assert (await get(client, ctx, outside["id"]))["document"] is None
    # A run with no intake, or before it has a PRD, links nothing.
    async with tenant_session(ctx.tenant_id) as s:
        assert await requests_service.link_run_document(s, Run(flow="baseline_to_prd")) == 0
        bare = Run(flow="baseline_to_prd", knobs={"intake_id": intake_id})
        assert await requests_service.link_run_document(s, bare) == 0


async def test_converting_the_brief_links_its_prd(client, ctx, runtime):
    """protects=C1 rule 7 through the intake's own run (a run on an existing PRD links the
    requests when it starts); fails_when=starting the run leaves the requests without the
    PRD; no_claim=a run that drafts a new PRD (its import calls the same link)."""
    from tests.v2_helpers import seed_v2

    seeded = await seed_v2(ctx.tenant_id)
    g = await goal(client, ctx)
    a = await qualified(client, ctx, "Keep the address", g["id"])
    out = await create_intake(client, ctx, request_ids=[a["id"]])
    intake_id = out["intake"]["id"]
    approver = ctx.as_("approver")
    resp = await client.post(
        f"/v1/intakes/{intake_id}/runs", json={"document": "checkout-redesign"}, headers=approver
    )
    assert resp.status_code in (200, 201), resp.text
    run_id = resp.json()["id"]
    assert (await client.post(f"/v1/runs/{run_id}/estimate", headers=approver)).status_code == 200
    assert (await get(client, ctx, a["id"]))["document"] is None
    resp = await client.post(f"/v1/runs/{run_id}/start", headers=approver)
    assert resp.status_code == 200, resp.text
    seen = await get(client, ctx, a["id"])
    assert seen["document"]["id"] == str(seeded.document_id)


async def _intake_count(ctx: Ctx) -> int:
    from sqlalchemy import func

    from oracle.v2.models import ProductIntake

    async with tenant_session(ctx.tenant_id) as s:
        return await s.scalar(select(func.count()).select_from(ProductIntake)) or 0


@pytest.mark.parametrize("who", ["commenter", "approver"])
async def test_a_request_behind_a_brief_or_a_prd_is_not_taken_over(client, ctx, who):
    """protects=C1 rules 2 and 7 (#569 review MAJOR 1: a request already behind a brief, or
    linked to a PRD, cannot be put behind another brief; 409 in words naming that brief or
    PRD); fails_when=a commenter or approver moves a request to brief B, a refused brief is
    created, or the request's brief or PRD changes; no_claim=the picker hiding them (web
    e2e requests-start-prd)."""
    from tests.v2_helpers import seed_v2

    seeded = await seed_v2(ctx.tenant_id)
    g = await goal(client, ctx)
    behind = await qualified(client, ctx, "Keep the address", g["id"])
    with_prd = await qualified(client, ctx, "Saved cards", g["id"])
    free = await qualified(client, ctx, "Dark mode", g["id"])
    a = (await create_intake(client, ctx, request_ids=[behind["id"]]))["intake"]
    resp = await client.patch(
        f"/v1/requests/{with_prd['id']}",
        json={
            "lock_version": (await get(client, ctx, with_prd["id"]))["lock_version"],
            "document_id": str(seeded.document_id),
        },
        headers=ctx.as_("approver"),
    )
    assert resp.status_code == 200, resp.text
    prd_title = resp.json()["document"]["title"]
    before = {r["id"]: await get(client, ctx, r["id"]) for r in (behind, with_prd, free)}
    intakes = await _intake_count(ctx)
    for taken, named in ((behind, a["title"]), (with_prd, prd_title)):
        resp = await client.post(
            "/v1/intakes",
            json={
                "title": "Brief B",
                "brief": "Returning buyers retype their address at every checkout.",
                "ai_extraction": False,
                "request_ids": [free["id"], taken["id"]],
            },
            headers=ctx.as_(who),
        )
        assert resp.status_code == 409, resp.text
        detail = resp.json()["detail"]
        assert taken["title"] in detail and named in detail, detail
        assert "already" in detail
    assert await _intake_count(ctx) == intakes
    for rid, was in before.items():
        now = await get(client, ctx, rid)
        assert (now["intake_id"], now["document"], now["lock_version"]) == (
            was["intake_id"],
            was["document"],
            was["lock_version"],
        )


async def test_unlinking_the_prd_takes_the_request_off_its_brief(client, ctx, runtime):
    """protects=#569 review minor (an approver who unlinks a request's PRD takes it off the
    brief too, so a retried draft import on that brief's run cannot link the PRD back, and
    the request may go behind another brief); fails_when=the request keeps the brief after
    the unlink, or the brief's run links the PRD again; no_claim=the import path itself."""
    from tests.v2_helpers import seed_v2

    seeded = await seed_v2(ctx.tenant_id)
    g = await goal(client, ctx)
    r = await qualified(client, ctx, "Keep the address", g["id"])
    a = (await create_intake(client, ctx, request_ids=[r["id"]]))["intake"]
    async with tenant_session(ctx.tenant_id) as s:
        run = Run(
            flow="baseline_to_prd",
            status="running",
            knobs={"intake_id": a["id"]},
            document_id=seeded.document_id,
        )
        s.add(run)
        await s.flush()
        assert await requests_service.link_run_document(s, run) == 1
        await s.commit()
        run_id = run.id
    seen = await get(client, ctx, r["id"])
    resp = await client.patch(
        f"/v1/requests/{r['id']}",
        json={"lock_version": seen["lock_version"], "document_id": None},
        headers=ctx.as_("approver"),
    )
    assert resp.status_code == 200, resp.text
    assert resp.json()["document"] is None and resp.json()["intake_id"] is None
    async with tenant_session(ctx.tenant_id) as s:
        run = await s.get(Run, run_id)
        assert await requests_service.link_run_document(s, run) == 0
        await s.commit()
    assert (await get(client, ctx, r["id"]))["document"] is None
    b = (await create_intake(client, ctx, title="Brief B", request_ids=[r["id"]]))["intake"]
    assert (await get(client, ctx, r["id"]))["intake_id"] == b["id"]
