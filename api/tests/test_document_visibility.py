"""H8 (owner 2026-10-21 "Update view"): who sees an update. Owners and approvers do;
for a commenter or viewer an ``approvers`` document is absent on every read path (lists,
direct reads, versions, markdown, exports, search, comments, notifications, the Inbox,
MCP). Approvers comment; owners set verdicts, approve, and open a document to the company
(or back) with a reason. A run token reads it only when its run's creator may. Against
Postgres.

Each test's card: protects=<the observable>; fails_when=<the wrong result it rejects>;
no_claim=<what green does not prove>.
"""

import re
import uuid

import pytest
from sqlalchemy import select

from oracle.docs import visibility
from oracle.docs.models import Document
from oracle.models import AuditEvent
from oracle.review.models import Notification
from oracle.runs.models import Run
from oracle.runtokens import mint_run_token
from oracle.swarm import FakeRuntime, set_runtime
from oracle.tenancy import tenant_session
from tests.baseline_helpers import make_ctx
from tests.fixtures import draft
from tests.test_mcp import api_token, mcp_client, text_of
from tests.update_helpers import drafted_by_run, import_md, investor_md, started

WORD = "Larkspur"  # in the seeded update only
ANCHOR = {"exact": "Weekly active teams", "prefix": "", "suffix": ""}


@pytest.fixture
async def ctx():
    return await make_ctx()


@pytest.fixture
def runtime():
    fake = FakeRuntime()
    set_runtime(fake)
    yield fake
    set_runtime(None)


async def _update(client, ctx) -> tuple[str, uuid.UUID]:
    """An investor update with a version 2 that has numbers and the word only it uses."""
    slug = await started(client, ctx)
    resp = await import_md(client, ctx.as_("owner"), slug, investor_md(slug))
    assert resp.status_code == 201, resp.text
    async with tenant_session(ctx.tenant_id) as s:
        doc_id = await s.scalar(select(Document.id).where(Document.slug == slug))
    return slug, doc_id


def _leaks(body: str, slug: str, doc_id: uuid.UUID) -> bool:
    return slug in body or str(doc_id) in body or WORD in body or "Investor update" in body


# --------------------------------------------------------------------------- the rule


def test_the_rule_in_one_place():
    """protects=visible_to and can_see: approvers and owners see approvers documents,
    commenters and viewers do not, Oracle's own work (no principal) sees all;
    fails_when=a role sees what it should not or the reverse; no_claim=the read paths (the
    route tests below)."""

    class P:
        def __init__(self, role):
            self.role = role

    shared = Document(slug="a", title="a", visibility="company")
    kept = Document(slug="b", title="b", visibility="approvers")
    for role, sees in (("owner", True), ("approver", True), ("commenter", False),
                       ("viewer", False)):  # fmt: skip
        assert visibility.can_see(P(role), shared)
        assert visibility.can_see(P(role), kept) is sees, role
        assert visibility.restricted(P(role)) is not sees
    assert not visibility.restricted(None)


@pytest.mark.parametrize("who", ["commenter", "viewer"])
async def test_commenters_and_viewers_get_nothing(client, ctx, who):
    """protects=for a commenter and a viewer: GET /v1/documents?kind=update is [], the
    document, its version, markdown, export and deck are 404, the full list has no row and
    search has no hit for a word only in the update; fails_when=any of them returns the
    update; no_claim=the UI (the e2e covers it)."""
    slug, doc_id = await _update(client, ctx)
    me = ctx.as_(who)
    assert (await client.get("/v1/documents?kind=update", headers=me)).json() == []
    assert all(d["slug"] != slug for d in (await client.get("/v1/documents", headers=me)).json())
    for path in (f"/v1/documents/{slug}", f"/v1/documents/{doc_id}",
                 f"/v1/documents/{slug}/versions/1", f"/v1/documents/{slug}/versions/2/markdown",
                 f"/v1/documents/{slug}/versions/2/export", f"/v1/documents/{slug}/versions/2/deck",
                 f"/v1/documents/{slug}/versions"):  # fmt: skip
        assert (await client.get(path, headers=me)).status_code == 404, path
    hits = (await client.get("/v1/search", params={"q": WORD}, headers=me)).json()["hits"]
    assert not any(_leaks(str(h), slug, doc_id) for h in hits)


@pytest.mark.parametrize("who", ["approver", "owner"])
async def test_approvers_and_owners_see_it(client, ctx, who):
    """protects=an approver and an owner list, read and export the update; fails_when=the
    rule hides it from them; no_claim=their write rights (tested apart)."""
    slug, _ = await _update(client, ctx)
    me = ctx.as_(who)
    listed = (await client.get("/v1/documents?kind=update", headers=me)).json()
    assert [d["slug"] for d in listed] == [slug]
    assert listed[0]["visibility"] == "approvers"
    assert listed[0]["period"] == {"from": "2026-10-01", "to": "2026-10-31"}
    for path in (f"/v1/documents/{slug}", f"/v1/documents/{slug}/versions/2",
                 f"/v1/documents/{slug}/versions/2/markdown",
                 f"/v1/documents/{slug}/versions/2/export"):  # fmt: skip
        assert (await client.get(path, headers=me)).status_code == 200, path


async def test_prds_stay_company_wide(client, ctx):
    """protects=PRDs keep company visibility: a commenter still reads them; fails_when=the
    rule hides documents that are not approvers-only; no_claim=roadmaps (same column)."""
    resp = await import_md(client, ctx.as_("owner"), "checkout-redesign", draft("prd_v1.md"))
    assert resp.status_code == 201, resp.text
    doc = (await client.get("/v1/documents/checkout-redesign", headers=ctx.as_("viewer"))).json()
    assert doc["visibility"] == "company"


# --------------------------------------------------------------------------- rights


async def test_approvers_comment_but_only_owners_set_verdicts_and_approve(client, ctx):
    """protects=an approver's comment on an update is stored; an approver's section verdict
    and approval are 403, an owner's are 200; a commenter cannot comment (404);
    fails_when=an approver sets a verdict or approves, or cannot comment; no_claim=the
    comment's notifications (next test)."""
    slug, _ = await _update(client, ctx)
    url = f"/v1/documents/{slug}/versions/2"
    resp = await client.post(
        f"{url}/comments",
        json={"section_key": "metrics", "anchor": ANCHOR, "body": "Add last month's number."},
        headers=ctx.as_("approver"),
    )
    assert resp.status_code == 201, resp.text
    resp = await client.post(
        f"{url}/comments",
        json={"section_key": "metrics", "anchor": ANCHOR, "body": "x"},
        headers=ctx.as_("commenter"),
    )
    assert resp.status_code == 404
    resp = await client.put(
        f"{url}/sections/metrics/review", json={"verdict": "approved"}, headers=ctx.as_("approver")
    )
    assert resp.status_code == 403
    assert resp.json()["detail"] == "Only an owner can set a section verdict on an update"
    assert (await client.post(f"{url}/approve", headers=ctx.as_("approver"))).status_code == 403
    resp = await client.put(
        f"{url}/sections/metrics/review", json={"verdict": "approved"}, headers=ctx.as_("owner")
    )
    assert resp.status_code == 200, resp.text
    assert (await client.post(f"{url}/approve", headers=ctx.as_("owner"))).status_code == 200


async def test_the_inbox_and_notifications_hold_nothing_for_a_commenter(client, ctx):
    """protects=a campaign asking commenters too, a comment naming the commenter, and a
    notification about the update written before it was closed leave no row in the
    commenter's notifications or Inbox, while the approver is notified; fails_when=the
    commenter hears about the update anywhere; no_claim=Slack (none is sent in wave 1)."""
    slug, doc_id = await _update(client, ctx)
    resp = await client.post(
        f"/v1/documents/{slug}/campaigns",
        json={"title": "Read the October update", "audience_roles": ["commenter", "approver"]},
        headers=ctx.as_("owner"),
    )
    assert resp.status_code == 201, resp.text
    resp = await client.post(
        f"/v1/documents/{slug}/versions/2/comments",
        json={"section_key": "metrics", "anchor": ANCHOR,
              "body": "@commenter@example.com can you check this?"},
        headers=ctx.as_("approver"),
    )  # fmt: skip
    assert resp.status_code == 201, resp.text
    async with tenant_session(ctx.tenant_id) as s:
        s.add(Notification(user_id=ctx.users["commenter"].id, kind="comment",
                           title="New comment on metrics in Investor update",
                           actor="system", document_id=doc_id))  # fmt: skip
        await s.commit()
        mine = list(await s.scalars(select(Notification)))
    assert any(n.user_id == ctx.users["approver"].id for n in mine)

    commenter = ctx.as_("commenter")
    notes = await client.get("/v1/me/notifications", headers=commenter)
    assert notes.status_code == 200 and notes.json() == []
    inbox = await client.get("/v1/inbox", headers=commenter)
    assert inbox.status_code == 200 and not _leaks(inbox.text, slug, doc_id)
    queue = await client.get("/v1/me/review-queue", headers=commenter)
    assert not _leaks(queue.text, slug, doc_id)
    approver_notes = (await client.get("/v1/me/notifications", headers=ctx.as_("approver"))).json()
    assert any(n["document_id"] == str(doc_id) for n in approver_notes)


async def test_a_run_token_reads_it_only_for_an_approver_or_owner_creator(client, ctx, runtime):
    """protects=over MCP, a run token of a run created by an owner or an approver reads the
    update; one of a run created by a commenter gets 404; fails_when=the commenter's run
    reads it or the owner's cannot; no_claim=writes (push_draft has its own tests)."""
    slug, _ = await _update(client, ctx)
    for who, ok in (("owner", True), ("approver", True), ("commenter", False)):
        async with tenant_session(ctx.tenant_id) as s:
            run = Run(flow="update_draft", created_by=ctx.users[who].id)
            s.add(run)
            await s.flush()
            raw = await mint_run_token(s, run.id, ["read:documents"], ttl_seconds=600)
            await s.commit()
        async with mcp_client(raw) as c:
            got = await c.call_tool("get_document", {"doc": slug})
        if ok:
            assert not got.is_error, (who, text_of(got))
            assert got.structured_content["slug"] == slug
        else:
            assert got.is_error and "HTTP 404" in text_of(got), who


# --------------------------------------------------------------------------- the switch


async def test_an_owner_opens_it_to_the_company_with_a_reason(client, ctx):
    """protects=PATCH visibility company by an owner makes the update readable to a
    commenter and audits document.visibility with before, after and the reason; back to
    approvers hides it again; an approver gets 403 and no reason is a 422;
    fails_when=a non-owner switches it, a reasonless switch passes, or no audit is kept;
    no_claim=the Updates page (the e2e covers it)."""
    slug, doc_id = await _update(client, ctx)
    url = f"/v1/documents/{slug}/visibility"
    resp = await client.patch(
        url, json={"visibility": "company", "reason": "Board pack"}, headers=ctx.as_("approver")
    )
    assert resp.status_code == 403
    resp = await client.patch(url, json={"visibility": "company"}, headers=ctx.as_("owner"))
    assert resp.status_code == 422
    resp = await client.patch(
        url, json={"visibility": "company", "reason": "  "}, headers=ctx.as_("owner")
    )
    assert resp.status_code == 422
    resp = await client.patch(
        url, json={"visibility": "company", "reason": "Shared at the all-hands"},
        headers=ctx.as_("owner"),
    )  # fmt: skip
    assert resp.status_code == 200, resp.text
    assert resp.json()["visibility"] == "company"
    got = await client.get(f"/v1/documents/{slug}/versions/2", headers=ctx.as_("commenter"))
    assert got.status_code == 200
    async with tenant_session(ctx.tenant_id) as s:
        (event,) = list(
            await s.scalars(select(AuditEvent).where(AuditEvent.action == "document.visibility"))
        )
    assert event.entity_id == doc_id
    assert event.data == {"before": "approvers", "after": "company",
                          "reason": "Shared at the all-hands"}  # fmt: skip
    resp = await client.patch(
        url, json={"visibility": "approvers", "reason": "Draft again"}, headers=ctx.as_("owner")
    )
    assert resp.status_code == 200
    assert (
        await client.get(f"/v1/documents/{slug}", headers=ctx.as_("commenter"))
    ).status_code == 404


async def test_only_updates_change_visibility(client, ctx):
    """protects=PATCH visibility by an owner on a PRD or a roadmap is refused (422) and the
    document stays company-wide, readable by a commenter, with no audit event; an update
    switches (the test above); fails_when=an owner hides a PRD or a roadmap (out of scope:
    everything but an update stays company); no_claim=the web menu (shown on updates only)."""
    owner = ctx.as_("owner")
    resp = await import_md(client, owner, "checkout-redesign", draft("prd_v1.md"))
    assert resp.status_code == 201, resp.text
    resp = await client.post(
        "/v1/drafts",
        json={"kind": "roadmap", "title": "Next year", "template": "now-next-later"},
        headers=owner,
    )
    assert resp.status_code == 201, resp.text
    for slug in ("checkout-redesign", resp.json()["slug"]):
        resp = await client.patch(
            f"/v1/documents/{slug}/visibility",
            json={"visibility": "approvers", "reason": "Board only"},
            headers=owner,
        )
        assert resp.status_code == 422, (slug, resp.text)
        assert "update" in resp.text, resp.text
        got = await client.get(f"/v1/documents/{slug}", headers=ctx.as_("commenter"))
        assert got.status_code == 200 and got.json()["visibility"] == "company", slug
    async with tenant_session(ctx.tenant_id) as s:
        events = list(
            await s.scalars(select(AuditEvent).where(AuditEvent.action == "document.visibility"))
        )
    assert events == []


@pytest.mark.parametrize(
    ("who", "sees"),
    [("owner", True), ("approver", True), ("commenter", False), ("viewer", False)],
)
async def test_the_run_that_drafts_an_update_follows_it(client, ctx, runtime, who, sees):
    """protects=the update_draft run of an approvers update, and its update.md, are in an
    owner's and an approver's GET /v1/runs, GET /v1/runs/{id} and artifact route, and
    absent for a commenter and a viewer (no row, 404, 404); fails_when=a commenter or viewer
    reads the hidden draft through the run or its artifact; no_claim=MCP (next test)."""
    slug, doc_id = await _update(client, ctx)
    run = await drafted_by_run(client, ctx, runtime, slug, investor_md(slug))
    seq = run["segments"][0]["seq"]
    artifact = f"/v1/runs/{run['id']}/segments/{seq}/artifacts/update.md"
    owned = await client.get(artifact, headers=ctx.as_("owner"))
    assert owned.status_code == 200 and WORD in owned.text, owned.text
    me = ctx.as_(who)
    listed = await client.get("/v1/runs", headers=me)
    assert listed.status_code == 200, listed.text
    assert (run["id"] in {r["id"] for r in listed.json()}) is sees, listed.text
    if not sees:
        assert not _leaks(listed.text, slug, doc_id), listed.text
    got = await client.get(f"/v1/runs/{run['id']}", headers=me)
    assert got.status_code == (200 if sees else 404), got.text
    got = await client.get(artifact, headers=me)
    assert got.status_code == (200 if sees else 404), got.text
    assert (WORD in got.text) is sees


async def test_the_update_run_is_absent_over_mcp_for_a_commenter(client, ctx, runtime):
    """protects=over MCP a commenter's client gets no row for the update_draft run from
    list_runs and an error (404) from get_run and get_run_artifact, while an approver's
    client reads them; fails_when=a person's MCP client reads the hidden draft through a
    run; no_claim=run tokens (tested above)."""
    slug, doc_id = await _update(client, ctx)
    run = await drafted_by_run(client, ctx, runtime, slug, investor_md(slug))
    seq = run["segments"][0]["seq"]
    args = {"run_id": run["id"], "seq": seq, "name": "update.md"}
    for role, sees in (("approver", True), ("commenter", False)):
        async with mcp_client(await api_token(ctx.tenant_id, role)) as c:
            listed = await c.call_tool("list_runs", {})
            got = await c.call_tool("get_run", {"run_id": run["id"]})
            art = await c.call_tool("get_run_artifact", args)
        assert not listed.is_error, text_of(listed)
        assert (run["id"] in text_of(listed)) is sees, role
        if sees:
            assert not got.is_error and not art.is_error, role
            assert WORD in text_of(art)
        else:
            assert not _leaks(text_of(listed), slug, doc_id)
            assert got.is_error and "HTTP 404" in text_of(got), text_of(got)
            assert art.is_error and "HTTP 404" in text_of(art), text_of(art)
            assert WORD not in text_of(art)


# --------------------------------------------------------------------------- every route


async def test_every_documents_review_export_and_search_get_route_misses_it(client, ctx, runtime):
    """protects=walking every GET route of the documents, review, export and search areas
    (and every other GET route that takes a document) as a commenter against an approvers
    update, with real ids for its comment, campaign and section patch: none returns it
    (404, or a body that never names it); the owner gets the same routes; fails_when=any
    route a new lane adds forgets the rule; no_claim=POST routes beyond the comment reply
    checked at the end."""
    from oracle.main import app

    slug, doc_id = await _update(client, ctx)
    owner = ctx.as_("owner")
    url = f"/v1/documents/{slug}/versions/2"
    comment = await client.post(
        f"{url}/comments",
        json={"section_key": "metrics", "anchor": ANCHOR, "body": f"{WORD} note"},
        headers=ctx.as_("approver"),
    )
    assert comment.status_code == 201, comment.text
    campaign = await client.post(
        f"/v1/documents/{slug}/campaigns", json={"title": "Read it"}, headers=owner
    )
    assert campaign.status_code == 201, campaign.text
    # A section patch: the owner approves Metrics, then a run's draft changes it.
    resp = await client.put(
        f"{url}/sections/metrics/review", json={"verdict": "approved"}, headers=owner
    )
    assert resp.status_code == 200, resp.text
    await drafted_by_run(
        client, ctx, runtime, slug, investor_md(slug, metrics="- Weekly active teams: 412.")
    )
    patches = (await client.get(f"/v1/documents/{slug}/section-patches", headers=owner)).json()
    assert patches, "no section patch to walk"
    values = {
        "doc": slug,
        "n": "2",
        "p": "1",
        "campaign_id": campaign.json()["id"],
        "patch_id": patches[0]["id"],
        "job_id": str(uuid.uuid4()),
        # A roadmap's change-set route (#346), walked with the update's slug: an update is
        # never a roadmap, so this only proves the route is walked. That a real change set
        # of a hidden roadmap is hidden is test_roadmap_change_sets'
        # test_a_hidden_roadmaps_change_sets_are_hidden.
        "set_id": str(uuid.uuid4()),
    }

    areas = {"documents", "review", "export", "search"}
    routes = [
        path
        for path, ops in app.openapi()["paths"].items()
        if "get" in ops and ("{doc}" in path or areas & set(ops["get"].get("tags", [])))
    ]
    assert len(routes) >= 35, routes
    commenter = ctx.as_("commenter")
    walked = []
    for route in routes:
        path = re.sub(r"{(\w+)}", lambda m: values[m.group(1)], route)
        params = {"q": WORD} if route == "/v1/search" else {}
        if route.endswith("/diff"):
            params = {"from": 1, "to": 2}
        resp = await client.get(path, params=params, headers=commenter)
        assert resp.status_code != 500, (route, resp.text)
        if resp.status_code < 400:
            # Search echoes the query: its hits are what must not name the update.
            body = str(resp.json()["hits"]) if route == "/v1/search" else resp.text
            assert not _leaks(body, slug, doc_id), (route, resp.text[:300])
        walked.append(route)
        # The same id with the document's uuid.
        if "{doc}" in route:
            resp = await client.get(path.replace(slug, str(doc_id)), params=params,
                                    headers=commenter)  # fmt: skip
            assert resp.status_code >= 400 or not _leaks(resp.text, slug, doc_id), route
    assert "/v1/documents/{doc}/versions/{n}/comments" in walked
    assert "/v1/section-patches/{patch_id}" in walked
    assert "/v1/campaigns/{campaign_id}" in walked
    assert "/v1/roadmaps/{doc}/change-sets/{set_id}" in walked
    # The owner reads what the commenter cannot.
    for path in (f"{url}/comments", f"/v1/section-patches/{values['patch_id']}",
                 f"/v1/campaigns/{values['campaign_id']}"):  # fmt: skip
        assert (await client.get(path, headers=owner)).status_code == 200, path
    # A reply by comment id is as absent.
    resp = await client.post(
        f"/v1/comments/{comment.json()['id']}/replies", json={"body": "me too"}, headers=commenter
    )
    assert resp.status_code == 404, resp.text


async def test_the_approval_decision_follows_the_update(client, ctx):
    """protects=the decision an owner's approval of an update captures ("Publish <update>
    v<n>") is absent from a commenter's decision log, its direct read and the Inbox, and
    shown to an approver; fails_when=a commenter reads the update's title through the
    decision log; no_claim=decisions about other documents (unchanged)."""
    slug, doc_id = await _update(client, ctx)
    resp = await client.post(f"/v1/documents/{slug}/versions/2/approve", headers=ctx.as_("owner"))
    assert resp.status_code == 200, resp.text
    listed = (await client.get("/v1/decisions", headers=ctx.as_("approver"))).json()
    (mine,) = [d for d in listed if "Investor update" in d["title"]]
    commenter = ctx.as_("commenter")
    resp = await client.get("/v1/decisions", headers=commenter)
    assert resp.status_code == 200 and not _leaks(resp.text, slug, doc_id)
    assert (await client.get(f"/v1/decisions/{mine['id']}", headers=commenter)).status_code == 404
    inbox = await client.get("/v1/inbox", headers=commenter)
    assert not _leaks(inbox.text, slug, doc_id)


@pytest.mark.parametrize("who", ["commenter", "viewer"])
async def test_the_runs_checkpoint_decisions_follow_the_update(client, ctx, runtime, who):
    """protects=a checkpoint record of an approvers update's run (its stop sent back by the
    owner: a decision with source_kind checkpoint) and a decision whose subject is the update
    are absent from a commenter's and a viewer's decision log and direct read, and shown to an
    approver (#519 item 2); fails_when=only "Publish <update> v<n>" is hidden and the run's
    stop names the update in Company › Decisions; no_claim=the Decisions page (the e2e)."""
    slug, doc_id = await _update(client, ctx)
    run = await drafted_by_run(client, ctx, runtime, slug, investor_md(slug))
    cp = next(c for c in run["checkpoints"] if c["status"] == "pending")
    resp = await client.post(
        f"/v1/runs/{run['id']}/checkpoints/{cp['id']}/decide",
        json={"decision": "changes_requested", "note": "Tighten the metrics."},
        headers=ctx.as_("owner"),
    )
    assert resp.status_code == 200, resp.text
    from oracle.decisions import capture

    async with tenant_session(ctx.tenant_id) as s:
        await capture.capture(
            s,
            None,
            origin="oracle",
            source_kind="discussion",
            source_id=uuid.uuid4(),
            title="Investor update · October 2026 leads with metrics",
            options=[{"key": "yes", "label": "Yes"}],
            chosen_option="yes",
            rationale="Asked for",
            approver_id=ctx.users["owner"].id,
            subjects=[{"kind": "document", "id": str(doc_id), "ref": slug}],
        )
        await s.commit()
    listed = (await client.get("/v1/decisions", headers=ctx.as_("approver"))).json()
    mine = [d for d in listed if "Investor update" in d["title"]]
    assert len(mine) == 2, listed
    me = ctx.as_(who)
    resp = await client.get("/v1/decisions", headers=me)
    assert resp.status_code == 200 and not _leaks(resp.text, slug, doc_id), resp.text
    for d in mine:
        assert (await client.get(f"/v1/decisions/{d['id']}", headers=me)).status_code == 404
    resp = await client.get(f"/v1/runs/{run['id']}/decisions", headers=me)
    assert resp.status_code in (200, 404) and not _leaks(resp.text, slug, doc_id), resp.text
