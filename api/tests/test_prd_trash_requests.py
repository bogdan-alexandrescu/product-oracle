"""New PRD: a PRD moved to Trash releases the requests linked to it.

Moving a PRD to Trash clears each linked request's PRD and brief links, so a new brief may
take it; restoring the PRD links back each request that is still free. A request still
linked to a PRD in Trash (from before this release) is refused by a new brief in words
that name the PRD and say it is in Trash, and Release it frees it.

Each test's card is one line: protects / fails_when / no_claim. Synthetic placeholders
only.
"""

import uuid

import pytest

from oracle.requests.models import ProductRequest
from oracle.tenancy import tenant_session
from tests.baseline_helpers import Ctx, make_ctx
from tests.intake_helpers import create_intake
from tests.test_requests import get, goal
from tests.test_requests_brief import qualified

BRIEF = "Returning buyers retype their address at every checkout."


@pytest.fixture
async def ctx() -> Ctx:
    return await make_ctx()


async def _link(client, ctx: Ctx, request_id: str, document_id: uuid.UUID) -> None:
    resp = await client.patch(
        f"/v1/requests/{request_id}",
        json={
            "lock_version": (await get(client, ctx, request_id))["lock_version"],
            "document_id": str(document_id),
        },
        headers=ctx.as_("approver"),
    )
    assert resp.status_code == 200, resp.text


async def _trash(client, ctx: Ctx, slug: str) -> dict:
    resp = await client.request("DELETE", f"/v1/documents/{slug}", headers=ctx.as_("owner"))
    assert resp.status_code == 200, resp.text
    return resp.json()


async def test_trashing_a_prd_releases_its_requests_and_restore_relinks_the_free_ones(client, ctx):
    """protects=New PRD (4) (moving a PRD to Trash releases its request links; restoring
    re-links each request still free); fails_when=a request keeps the trashed PRD, a new
    brief is refused it, restore leaves a free request unlinked, or restore takes back a
    request a new brief has since taken; no_claim=the Trash dialog (web e2e)."""
    from tests.v2_helpers import seed_v2

    seeded = await seed_v2(ctx.tenant_id)
    g = await goal(client, ctx)
    taken = await qualified(client, ctx, "Keep the address", g["id"])
    free = await qualified(client, ctx, "Saved cards", g["id"])
    for r in (taken, free):
        await _link(client, ctx, r["id"], seeded.document_id)

    entry = await _trash(client, ctx, "checkout-redesign")
    for r in (taken, free):
        seen = await get(client, ctx, r["id"])
        assert seen["document"] is None and seen["intake_id"] is None, seen

    b = (await create_intake(client, ctx, title="Brief B", request_ids=[taken["id"]]))["intake"]
    assert (await get(client, ctx, taken["id"]))["intake_id"] == b["id"]

    resp = await client.post(f"/v1/trash/{entry['id']}/restore", headers=ctx.as_("owner"))
    assert resp.status_code == 200, resp.text
    back = await get(client, ctx, free["id"])
    assert back["document"]["id"] == str(seeded.document_id)
    still = await get(client, ctx, taken["id"])
    assert still["document"] is None and still["intake_id"] == b["id"]


async def test_a_request_still_on_a_trashed_prd_names_it_and_release_frees_it(client, ctx):
    """protects=New PRD (4) (the 409 names the PRD, says it is in Trash, and Release it
    frees the request); fails_when=the message says "another PRD", leaves out Trash, or
    the request stays refused after Release it; no_claim=requests on a live PRD (their
    409 is test_requests_brief)."""
    from tests.v2_helpers import seed_v2

    seeded = await seed_v2(ctx.tenant_id)
    g = await goal(client, ctx)
    r = await qualified(client, ctx, "Keep the address", g["id"])
    await _trash(client, ctx, "checkout-redesign")
    # A link from before Trash released them.
    async with tenant_session(ctx.tenant_id) as s:
        row = await s.get(ProductRequest, uuid.UUID(r["id"]))
        row.document_id = seeded.document_id
        await s.commit()

    body = {"title": "Brief B", "brief": BRIEF, "ai_extraction": False, "request_ids": [r["id"]]}
    resp = await client.post("/v1/intakes", json=body, headers=ctx.as_("commenter"))
    assert resp.status_code == 409, resp.text
    detail = resp.json()["detail"]
    assert "Checkout redesign PRD" in detail and "in Trash" in detail, detail
    assert "another PRD" not in detail

    resp = await client.post(
        "/v1/requests/release-from-trash",
        json={"request_ids": [r["id"]]},
        headers=ctx.as_("commenter"),
    )
    assert resp.status_code == 200, resp.text
    assert resp.json() == {"released": [r["id"]]}
    await create_intake(client, ctx, title="Brief B", request_ids=[r["id"]])


async def test_release_from_trash_leaves_a_live_prd_link(client, ctx):
    """protects=New PRD (4) (Release it frees only links to a PRD in Trash); fails_when=a
    request on a live PRD loses its link; no_claim=the approver's own unlink."""
    from tests.v2_helpers import seed_v2

    seeded = await seed_v2(ctx.tenant_id)
    g = await goal(client, ctx)
    r = await qualified(client, ctx, "Keep the address", g["id"])
    await _link(client, ctx, r["id"], seeded.document_id)
    resp = await client.post(
        "/v1/requests/release-from-trash",
        json={"request_ids": [r["id"]]},
        headers=ctx.as_("commenter"),
    )
    assert resp.status_code == 200, resp.text
    assert resp.json() == {"released": []}
    assert (await get(client, ctx, r["id"]))["document"]["id"] == str(seeded.document_id)
