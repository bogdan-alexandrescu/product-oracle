"""H9 Pricing input: who sees pricing memos and their decisions (H8's rule: owners and
approvers only), the checkpoint records of runs on hidden documents, another company's
ids, and run tokens acting as their run's creator. Against Postgres with the
FakeRuntime.

Each test's card: protects=<the observable>; fails_when=<the wrong result it rejects>;
no_claim=<what green does not prove>.
"""

import uuid

import pytest
from sqlalchemy import select

from oracle.docs.models import Document
from oracle.runs.models import Checkpoint, Run
from oracle.runtokens import mint_run_token
from oracle.swarm import FakeRuntime, set_runtime
from oracle.tenancy import tenant_session
from tests.baseline_helpers import make_ctx
from tests.decision_helpers import clock  # noqa: F401
from tests.pricing_helpers import QUESTION, approved_memo, drafted_by_run, memo_md, started_memo
from tests.test_mcp import mcp_client, text_of
from tests.update_helpers import drafted_by_run as update_drafted_by_run
from tests.update_helpers import investor_md, started

WORD = "per-seat"  # in the pricing memo only


@pytest.fixture
async def ctx():
    return await make_ctx()


@pytest.fixture
def runtime():
    fake = FakeRuntime()
    set_runtime(fake)
    yield fake
    set_runtime(None)


async def _doc_id(ctx, slug: str) -> uuid.UUID:
    async with tenant_session(ctx.tenant_id) as s:
        return await s.scalar(select(Document.id).where(Document.slug == slug))


def _leaks(body: str, slug: str, doc_id: uuid.UUID) -> bool:
    return slug in body or str(doc_id) in body or WORD in body or "Team plan pricing" in body


@pytest.mark.parametrize("who", ["commenter", "viewer"])
async def test_commenters_and_viewers_get_nothing(client, ctx, who):
    """protects=for a commenter and a viewer the memo is 404, absent from GET
    /v1/documents and search, GET /v1/pricing-memos is 404 and Decide is 404 too;
    fails_when=any returns the memo; no_claim=the UI (the e2e covers it)."""
    slug = await approved_memo(client, ctx)
    doc_id = await _doc_id(ctx, slug)
    me = ctx.as_(who)
    assert (await client.get("/v1/documents?kind=pricing", headers=me)).json() == []
    assert not _leaks((await client.get("/v1/documents", headers=me)).text, slug, doc_id)
    for path in (f"/v1/documents/{slug}", f"/v1/documents/{slug}/versions/2",
                 f"/v1/documents/{slug}/versions/2/markdown", "/v1/pricing-memos"):  # fmt: skip
        assert (await client.get(path, headers=me)).status_code == 404, path
    hits = (await client.get("/v1/search", params={"q": WORD}, headers=me)).json()["hits"]
    assert not any(_leaks(str(h), slug, doc_id) for h in hits)
    resp = await client.post(f"/v1/pricing-memos/{slug}/decide", headers=me)
    assert resp.status_code == 404


async def test_the_inbox_holds_no_review_row_for_a_commenter(client, ctx):
    """protects=a review campaign on the memo that names commenters leaves no Inbox row for
    the commenter; fails_when=the commenter hears about the memo; no_claim=Slack."""
    slug = await started_memo(client, ctx)
    doc_id = await _doc_id(ctx, slug)
    resp = await client.post(
        f"/v1/documents/{slug}/campaigns",
        json={"title": "Read the pricing memo", "audience_roles": ["commenter", "approver"]},
        headers=ctx.as_("owner"),
    )
    assert resp.status_code == 201, resp.text
    inbox = await client.get("/v1/inbox", headers=ctx.as_("commenter"))
    assert inbox.status_code == 200 and not _leaks(inbox.text, slug, doc_id)


async def test_the_pricing_decision_is_absent_for_a_commenter(client, ctx):
    """protects=the memo's decision is in an approver's GET /v1/decisions and absent from a
    commenter's, whose GET /v1/decisions/{number} is 404; fails_when=a commenter reads the
    pricing question through the decision log; no_claim=decisions about other documents."""
    slug = await approved_memo(client, ctx)
    d = (await client.post(f"/v1/pricing-memos/{slug}/decide", headers=ctx.as_("owner"))).json()
    listed = (await client.get("/v1/decisions", headers=ctx.as_("approver"))).json()
    assert any(row["number"] == d["number"] for row in listed)
    commenter = ctx.as_("commenter")
    resp = await client.get("/v1/decisions", headers=commenter)
    assert resp.status_code == 200
    assert all(row["number"] != d["number"] for row in resp.json())
    assert QUESTION not in resp.text
    for ref in (d["number"], d["id"]):
        assert (await client.get(f"/v1/decisions/{ref}", headers=commenter)).status_code == 404


async def test_review_stop_records_of_pricing_and_update_runs_are_absent(client, ctx, runtime):
    """protects=the checkpoint record an owner's Approve on a pricing_review stop writes,
    and the one of an update's update_review stop, are absent for a commenter and listed for
    an approver; fails_when=either record shows to a commenter; no_claim=checkpoint records
    of runs on company-wide documents (unchanged)."""
    runs = []
    slug = await started_memo(client, ctx)
    runs.append(await drafted_by_run(client, ctx, runtime, slug, memo_md(slug), who="owner"))
    update = await started(client, ctx)
    runs.append(await update_drafted_by_run(client, ctx, runtime, update, investor_md(update)))
    for run in runs:
        async with tenant_session(ctx.tenant_id) as s:
            cp = await s.scalar(
                select(Checkpoint).where(
                    Checkpoint.status == "pending", Checkpoint.run_id == uuid.UUID(run["id"])
                )
            )
        resp = await client.post(
            f"/v1/runs/{run['id']}/checkpoints/{cp.id}/decide",
            json={"decision": "approved"},
            headers=ctx.as_("owner"),
        )
        assert resp.status_code == 200, resp.text
    for run in runs:
        approver = await client.get(
            "/v1/decisions", params={"class": "checkpoint", "run_id": run["id"]},
            headers=ctx.as_("approver"),
        )  # fmt: skip
        assert len(approver.json()) == 1, run["flow"]
        commenter = await client.get(
            "/v1/decisions", params={"class": "checkpoint", "run_id": run["id"]},
            headers=ctx.as_("commenter"),
        )  # fmt: skip
        assert commenter.status_code == 200 and commenter.json() == [], run["flow"]


async def test_another_companys_memo_is_404(client, ctx):
    """protects=another company's owner gets 404 on the memo, an empty memo list and 404 on
    Decide; fails_when=any returns or decides it; no_claim=the tenancy layer's own tests."""
    slug = await approved_memo(client, ctx)
    other = await make_ctx("Other Co")
    them = other.as_("owner")
    assert (await client.get(f"/v1/documents/{slug}", headers=them)).status_code == 404
    assert (await client.get("/v1/pricing-memos", headers=them)).json() == []
    resp = await client.post(f"/v1/pricing-memos/{slug}/decide", headers=them)
    assert resp.status_code == 404


async def test_a_run_token_reads_memos_only_for_an_approver_or_owner_creator(client, ctx, runtime):
    """protects=over MCP, a run token of a run an approver started lists the pricing memos
    and cannot Decide; one of a run a commenter started gets 404; fails_when=the commenter's
    run reads them or a run decides; no_claim=reads of the document itself (H8's tests)."""
    slug = await approved_memo(client, ctx)
    for who, ok in (("approver", True), ("commenter", False)):
        async with tenant_session(ctx.tenant_id) as s:
            run = Run(flow="pricing_memo", created_by=ctx.users[who].id)
            s.add(run)
            await s.flush()
            raw = await mint_run_token(s, run.id, ["read:baseline"], ttl_seconds=600)
            await s.commit()
        async with mcp_client(raw) as c:
            got = await c.call_tool("list_pricing_memos", {})
            decided = await c.call_tool("decide_pricing_memo", {"doc": slug})
        if ok:
            assert not got.is_error, (who, text_of(got))
            assert slug in text_of(got)
        else:
            assert got.is_error and "HTTP 404" in text_of(got), who
        assert decided.is_error, who
