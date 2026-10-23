"""F7 Link tracker issues: a roadmap item tied to the GitHub issues that build it, kept
fresh from sync, read-only (oracle.roadmap.links). Against Postgres.

Synced issues are written with the GitHub connector's own item builders through
``sources.store.upsert_item`` (the sync's write); GitHub itself is never called.

Test cards (protects / fails_when / no_claim):

- test_issue_facts_read_every_state_the_connector_writes: protects=the State line to
  tracker state map, read from ``_issue_item``'s own output; fails_when=the format and
  its reader drift apart; no_claim=pull requests are never linkable (refused elsewhere).
- test_milestone_due_round_trip: protects=``github_milestone_due`` reads
  ``_milestone_item``'s Due line; fails_when=a due date is lost or misread; no_claim=none.
- test_link_an_issue_to_an_approved_item: protects=the stored record (state, target date
  from the milestone, track, PRD, linker) and that the items view shows it; fails_when=a
  field is not copied from the synced item; no_claim=Projects v2 estimates.
- test_link_by_url_and_refusals: protects=linking by pasted URL; 422 for an unknown item
  key, a pull request, a URL that is no GitHub issue; fails_when=a refusal is missing;
  no_claim=fetching by URL from GitHub (never done).
- test_link_a_draft_item_then_the_track_starts: protects=a track-less record matched by
  PRD and item key in the Plan, adopted by the PRD's track when it starts;
  fails_when=the draft item shows no issue or the record keeps no track; no_claim=none.
- test_a_draft_items_issue_stays_once_the_track_starts: protects=a draft item keeps its
  linked issue in the Plan and the items view after its PRD's track starts and adopts the
  record; fails_when=the adopted record drops out and the item reads untracked;
  no_claim=none.
- test_a_second_link_conflicts_then_moves: protects=409 naming the first item, then a
  move audited as tracker.issue_moved; fails_when=an issue silently moves;
  no_claim=the UI's question (Playwright covers it).
- test_another_members_issue_is_not_found: protects=AUD-9 (only the owner of the source
  item may share it); fails_when=search or link reveals it; no_claim=none.
- test_sync_keeps_the_record_fresh: protects=a written issue or milestone version
  refreshes state, title, target date and observed_at and re-monitors the track;
  fails_when=the record keeps the old state or date; no_claim=F2's events and slip alerts
  (F2 is not on main).
- test_a_deleted_source_relinks_or_marks_lost: protects=relink to another member's live
  item of the same issue, else refresh_lost_at with the last state kept;
  fails_when=the record is dropped or keeps a deleted item; no_claim=narrowing paths
  other than source deletion and item deletion.
- test_unlink_clears_the_item: protects=204, item and track cleared, the record stays,
  alignment counts the item untracked; fails_when=the record still counts; no_claim=none.
- test_scoping_and_roles: protects=another company's PRD and record are 404, run tokens
  and commenters 403, an engineering lead may link; fails_when=a role leaks;
  no_claim=the MCP transport (scopes are checked as oracle.mcp does).
- test_no_request_reaches_github: protects=search, link and unlink make no outbound
  HTTP; fails_when=any transport is used; no_claim=the sync's own GitHub calls.
"""

import uuid
from datetime import UTC, date, datetime
from typing import Any

import httpx
import pytest
from sqlalchemy import select

from oracle.auth.deps import RUN_TOKEN_HEADER
from oracle.mcp import scopes
from oracle.models import AuditEvent
from oracle.roadmap.models import ProductTrack, TrackerRecord
from oracle.runs.models import Run
from oracle.runtokens import mint_run_token
from oracle.sources import store
from oracle.sources.connectors import github
from oracle.sources.models import Source, SourceItem
from oracle.tenancy import tenant_session
from tests.baseline_helpers import Ctx, make_ctx
from tests.test_plan import Seed, by_key, plan

REPO = "acme/app"
BETA_DUE = "2026-11-30T08:00:00Z"
_REPO = github._Repo(
    key=REPO, full_name=REPO, html_url=f"https://github.com/{REPO}",
    default_branch="main", acl={"visibility": "private", "repo": REPO},
)  # fmt: skip


def issue_event(
    number: int = 412,
    title: str = "Saved cards checkout",
    state: str = "open",
    reason: str | None = None,
    milestone: str | None = "Beta",
    updated: str = "2026-10-20T10:00:00Z",
    pull: bool = False,
):
    data: dict[str, Any] = {
        "number": number, "title": title, "state": state, "state_reason": reason,
        "html_url": f"https://github.com/{REPO}/{'pull' if pull else 'issues'}/{number}",
        "created_at": "2026-10-01T10:00:00Z", "updated_at": updated,
        "milestone": {"title": milestone} if milestone else None,
    }  # fmt: skip
    if pull:
        data["pull_request"] = {"merged_at": None}
    return github._issue_item(_REPO, data)


def milestone_event(title: str = "Beta", due: str | None = BETA_DUE, number: int = 3):
    return github._milestone_item(
        _REPO,
        {"number": number, "title": title, "state": "open", "due_on": due,
         "html_url": f"https://github.com/{REPO}/milestone/{number}",
         "updated_at": "2026-10-20T10:00:00Z"},
    )  # fmt: skip


async def github_source(ctx: Ctx, who: str, events: list | None = None) -> uuid.UUID:
    """A GitHub source of ``who`` with the issue #412 and the Beta milestone synced."""
    async with tenant_session(ctx.tenant_id) as s:
        source = Source(
            owner_user_id=ctx.users[who].id,
            kind="github",
            name=f"github-{uuid.uuid4().hex[:6]}",
            config={"repos": [REPO]},
        )
        s.add(source)
        await s.flush()
        for event in events if events is not None else [issue_event(), milestone_event()]:
            await store.upsert_item(s, source, event)
        await s.commit()
        return source.id


async def sync(ctx: Ctx, source_id: uuid.UUID, *events) -> None:
    async with tenant_session(ctx.tenant_id) as s:
        source = await s.get(Source, source_id)
        for event in events:
            await store.upsert_item(s, source, event)
        await s.commit()


async def item_id(ctx: Ctx, source_id: uuid.UUID, number: int = 412) -> str:
    async with tenant_session(ctx.tenant_id) as s:
        return str(
            await s.scalar(
                select(SourceItem.id).where(
                    SourceItem.source_id == source_id,
                    SourceItem.external_id.like(f"%:{number}"),
                )
            )
        )


async def seed_prd_a(ctx: Ctx) -> None:
    """prd-a: approved, tracked, roadmap v1 approved with a1 and a2 in Now."""
    async with tenant_session(ctx.tenant_id) as s:
        await Seed(s).approved_roadmap("prd-a", ["a1", "a2"])
        await s.commit()


async def record(ctx: Ctx, ref: str = f"{REPO}#412") -> TrackerRecord:
    async with tenant_session(ctx.tenant_id) as s:
        return await s.scalar(select(TrackerRecord).where(TrackerRecord.external_ref == ref))


async def link(client, ctx: Ctx, who: str = "approver", status: int = 201, **body) -> dict:
    resp = await client.post("/v1/tracker/links", json=body, headers=ctx.as_(who))
    assert resp.status_code == status, resp.text
    return resp.json()


async def actions(ctx: Ctx) -> list[str]:
    async with tenant_session(ctx.tenant_id) as s:
        return list(
            await s.scalars(
                select(AuditEvent.action)
                .where(AuditEvent.action.like("tracker.issue_%"))
                .order_by(AuditEvent.created_at)
            )
        )


# --- parsing ---------------------------------------------------------------------------------


@pytest.mark.parametrize(
    ("state", "reason", "expected", "raw"),
    [
        ("open", None, "todo", "open"),
        ("closed", "completed", "done", "closed (completed)"),
        ("closed", None, "done", "closed"),
        ("closed", "not_planned", "cancelled", "closed (not planned)"),
        ("closed", "reopened", "unknown", "closed (reopened)"),
    ],
)
def test_issue_facts_read_every_state_the_connector_writes(state, reason, expected, raw):
    facts = github.github_issue_facts(issue_event(state=state, reason=reason).content)
    assert facts["state"] == expected and facts["raw_status"] == raw
    assert facts["milestone"] == "Beta" and facts["repository"] == REPO
    assert facts["number"] == 412
    assert github.github_issue_facts(issue_event(milestone=None).content)["milestone"] is None


def test_milestone_due_round_trip():
    assert github.github_milestone_due(milestone_event().content) == date(2026, 11, 30)
    assert github.github_milestone_due(milestone_event(due=None).content) is None
    assert github.github_milestone_due(issue_event().content) is None


# --- linking ---------------------------------------------------------------------------------


async def test_link_an_issue_to_an_approved_item(client):
    ctx = await make_ctx()
    await seed_prd_a(ctx)
    source = await github_source(ctx, "approver")
    si = await item_id(ctx, source)

    found = (await client.get("/v1/tracker/issues", params={"q": "#412"},
                              headers=ctx.as_("approver"))).json()  # fmt: skip
    assert [i["external_ref"] for i in found] == [f"{REPO}#412"]
    assert found[0]["milestone"] == {"title": "Beta", "due": "2026-11-30"}
    assert found[0]["state"] == "todo" and found[0]["linked"] is None
    for q in ("acme/app#412", "saved cards", f"https://github.com/{REPO}/issues/412"):
        resp = await client.get("/v1/tracker/issues", params={"q": q}, headers=ctx.as_("approver"))
        assert [i["source_item_id"] for i in resp.json()] == [si], q

    out = await link(client, ctx, prd="prd-a", item_key="a1", source_item_id=si)
    assert out["tracker"] == "github" and out["external_ref"] == f"{REPO}#412"
    assert out["state"] == "todo" and out["raw_status"] == "open"
    assert out["target_date"] == "2026-11-30" and out["estimate"] is None
    assert out["title"] == "Saved cards checkout"
    assert out["url"] == f"https://github.com/{REPO}/issues/412"
    assert out["source_item_id"] == si and out["item_key"] == "a1"
    assert out["linked_by"] == str(ctx.users["approver"].id) and out["linked_at"]
    assert out["observed_at"].startswith("2026-10-20T10:00:00")
    async with tenant_session(ctx.tenant_id) as s:
        track = await s.scalar(select(ProductTrack))
    assert out["track_id"] == str(track.id)
    assert out["prd_document_id"] == str(track.prd_document_id)

    items = (await client.get("/v1/roadmaps/prd-a-roadmap/items",
                              headers=ctx.as_("viewer"))).json()["items"]  # fmt: skip
    eng = {i["item_key"]: i["engineering"] for i in items}
    assert [r["external_ref"] for r in eng["a1"]] == [f"{REPO}#412"] and eng["a2"] == []
    assert eng["a1"][0]["id"] == out["id"]
    found = (await client.get("/v1/tracker/issues", params={"q": "412"},
                              headers=ctx.as_("approver"))).json()  # fmt: skip
    assert found[0]["linked"] == {"prd": "prd-a", "item_key": "a1", "record_id": out["id"],
                                  "item_title": "A1"}  # fmt: skip
    assert await actions(ctx) == ["tracker.issue_linked"]


async def test_link_by_url_and_refusals(client):
    ctx = await make_ctx()
    await seed_prd_a(ctx)
    source = await github_source(
        ctx, "approver", [issue_event(), milestone_event(), issue_event(number=9, pull=True)]
    )
    out = await link(client, ctx, prd="prd-a", item_key="a1",
                     url=f"https://github.com/{REPO}/issues/412")  # fmt: skip
    assert out["source_item_id"] == await item_id(ctx, source)
    await link(
        client, ctx, status=422, prd="prd-a", item_key="nope", source_item_id=out["source_item_id"]
    )
    pr = await item_id(ctx, source, 9)
    await link(client, ctx, status=422, prd="prd-a", item_key="a2", source_item_id=pr)
    await link(client, ctx, status=422, prd="prd-a", item_key="a2", url="https://example.com/x/412")
    await link(client, ctx, status=404, prd="prd-a", item_key="a2",
               url=f"https://github.com/{REPO}/issues/999")  # fmt: skip
    await link(client, ctx, status=404, prd="no-such-prd", item_key="a2",
               source_item_id=out["source_item_id"])  # fmt: skip


async def test_link_a_draft_item_then_the_track_starts(client):
    ctx = await make_ctx()
    async with tenant_session(ctx.tenant_id) as s:
        seed = Seed(s)
        prd = await seed.doc("prd-b", status="approved")
        p1 = await seed.version(prd, 1, approved=True)
        roadmap = await seed.doc("prd-b-roadmap", kind="roadmap")
        r1 = await seed.version(roadmap, 1, source=p1)
        await seed.item(r1, "b1", p1)
        await s.commit()
    source = await github_source(ctx, "owner")
    out = await link(client, ctx, "owner", prd="prd-b", item_key="b1",
                     source_item_id=await item_id(ctx, source))  # fmt: skip
    assert out["track_id"] is None and out["prd_document_id"] == str(prd.id)
    b1 = by_key(await plan(client, ctx, "viewer"))["b1"]
    assert b1["origin"] == "draft"
    assert [r["external_ref"] for r in b1["engineering"]["records"]] == [f"{REPO}#412"]
    assert b1["engineering"]["tracked"] is True

    resp = await client.post("/v1/tracks", json={"prd": "prd-b"}, headers=ctx.as_("approver"))
    assert resp.status_code == 201, resp.text
    assert str((await record(ctx)).track_id) == resp.json()["id"]


async def test_a_draft_items_issue_stays_once_the_track_starts(client):
    ctx = await make_ctx()
    async with tenant_session(ctx.tenant_id) as s:
        seed = Seed(s)
        prd = await seed.doc("prd-b", status="approved")
        p1 = await seed.version(prd, 1, approved=True)
        roadmap = await seed.doc("prd-b-roadmap", kind="roadmap")
        r1 = await seed.version(roadmap, 1, source=p1)
        await seed.item(r1, "b1", p1)
        await s.commit()
    source = await github_source(ctx, "owner")
    await link(client, ctx, "owner", prd="prd-b", item_key="b1",
               source_item_id=await item_id(ctx, source))  # fmt: skip
    resp = await client.post("/v1/tracks", json={"prd": "prd-b"}, headers=ctx.as_("approver"))
    assert resp.status_code == 201, resp.text
    assert str((await record(ctx)).track_id) == resp.json()["id"]

    b1 = by_key(await plan(client, ctx, "viewer"))["b1"]
    assert b1["origin"] == "draft"
    assert [r["external_ref"] for r in b1["engineering"]["records"]] == [f"{REPO}#412"]
    assert b1["engineering"]["tracked"] is True
    items = (await client.get("/v1/roadmaps/prd-b-roadmap/items",
                              headers=ctx.as_("viewer"))).json()["items"]  # fmt: skip
    eng = {i["item_key"]: i["engineering"] for i in items}
    assert [r["external_ref"] for r in eng["b1"]] == [f"{REPO}#412"]


async def test_a_second_link_conflicts_then_moves(client):
    ctx = await make_ctx()
    await seed_prd_a(ctx)
    si = await item_id(ctx, await github_source(ctx, "approver"))
    first = await link(client, ctx, prd="prd-a", item_key="a1", source_item_id=si)
    # The same item again is no conflict.
    await link(client, ctx, prd="prd-a", item_key="a1", source_item_id=si)
    conflict = await link(client, ctx, status=409, prd="prd-a", item_key="a2", source_item_id=si)
    assert conflict["detail"]["linked"] == {"prd": "prd-a", "item_key": "a1", "item_title": "A1"}
    assert "A1" in conflict["detail"]["message"]
    moved = await link(client, ctx, prd="prd-a", item_key="a2", source_item_id=si, move=True)
    assert moved["id"] == first["id"] and moved["item_key"] == "a2"
    assert await actions(ctx) == [
        "tracker.issue_linked", "tracker.issue_linked", "tracker.issue_moved"
    ]  # fmt: skip


async def test_another_members_issue_is_not_found(client):
    ctx = await make_ctx()
    await seed_prd_a(ctx)
    theirs = await item_id(ctx, await github_source(ctx, "owner"))
    resp = await client.get("/v1/tracker/issues", params={"q": "412"}, headers=ctx.as_("approver"))
    assert resp.status_code == 200 and resp.json() == []
    body = await link(client, ctx, status=404, prd="prd-a", item_key="a1", source_item_id=theirs)
    assert "412" not in str(body) and "Saved cards" not in str(body)
    await link(client, ctx, status=404, prd="prd-a", item_key="a1",
               url=f"https://github.com/{REPO}/issues/412")  # fmt: skip


# --- keeping it fresh ------------------------------------------------------------------------


async def test_sync_keeps_the_record_fresh(client):
    ctx = await make_ctx()
    await seed_prd_a(ctx)
    source = await github_source(ctx, "approver")
    await link(client, ctx, prd="prd-a", item_key="a1", source_item_id=await item_id(ctx, source))
    async with tenant_session(ctx.tenant_id) as s:
        await s.execute(ProductTrack.__table__.update().values(monitored_at=None))
        await s.commit()

    await sync(ctx, source, issue_event(state="closed", reason="completed",
                                        title="Saved cards at checkout",
                                        updated="2026-10-21T09:00:00Z"))  # fmt: skip
    r = await record(ctx)
    assert r.state == "done" and r.raw_status == "closed (completed)"
    assert r.title == "Saved cards at checkout"
    assert r.observed_at == datetime(2026, 10, 21, 9, tzinfo=UTC)
    async with tenant_session(ctx.tenant_id) as s:
        assert (await s.scalar(select(ProductTrack))).monitored_at is not None

    await sync(ctx, source, milestone_event(due="2026-12-15T08:00:00Z"))
    assert (await record(ctx)).target_date == date(2026, 12, 15)
    # Another repository's milestone of the same title changes nothing.
    other = github._Repo(key="acme/web", full_name="acme/web", html_url="https://github.com/acme/web",
                         default_branch="main", acl={})  # fmt: skip
    await sync(ctx, source, github._milestone_item(
        other, {"number": 1, "title": "Beta", "due_on": "2027-01-01T08:00:00Z"}))  # fmt: skip
    assert (await record(ctx)).target_date == date(2026, 12, 15)


async def test_a_deleted_source_relinks_or_marks_lost(client):
    ctx = await make_ctx()
    await seed_prd_a(ctx)
    mine = await github_source(ctx, "approver")
    theirs = await github_source(ctx, "owner")
    await link(client, ctx, prd="prd-a", item_key="a1", source_item_id=await item_id(ctx, mine))

    resp = await client.delete(f"/v1/sources/{mine}", headers=ctx.as_("approver"))
    assert resp.status_code == 204, resp.text
    r = await record(ctx)
    assert str(r.source_item_id) == await item_id(ctx, theirs) and r.refresh_lost_at is None
    assert r.item_key == "a1"

    await sync(ctx, theirs, issue_event(state="closed", reason="not_planned"))
    assert (await record(ctx)).state == "cancelled"
    resp = await client.delete(f"/v1/sources/{theirs}", headers=ctx.as_("owner"))
    assert resp.status_code == 204, resp.text
    r = await record(ctx)
    assert r.source_item_id is None and r.refresh_lost_at is not None
    assert r.state == "cancelled" and r.item_key == "a1"
    eng = (await client.get("/v1/tracker/records", headers=ctx.as_("viewer"))).json()
    assert eng[0]["refresh_lost_at"] is not None


async def test_a_deleted_item_marks_the_record_lost(client):
    ctx = await make_ctx()
    await seed_prd_a(ctx)
    source = await github_source(ctx, "approver")
    await link(client, ctx, prd="prd-a", item_key="a1", source_item_id=await item_id(ctx, source))
    async with tenant_session(ctx.tenant_id) as s:
        src = await s.get(Source, source)
        from oracle.sources.base import ItemDelete

        assert await store.delete_item(s, src, ItemDelete(external_id=f"{REPO}:issue:412"))
        await s.commit()
    assert (await record(ctx)).refresh_lost_at is not None


# --- unlink, scoping, roles ------------------------------------------------------------------


async def test_unlink_clears_the_item(client):
    ctx = await make_ctx()
    await seed_prd_a(ctx)
    si = await item_id(ctx, await github_source(ctx, "approver"))
    out = await link(client, ctx, prd="prd-a", item_key="a1", source_item_id=si)
    report = (await client.get("/v1/roadmaps/prd-a-roadmap/alignment",
                               headers=ctx.as_("viewer"))).json()  # fmt: skip
    assert report["counts"]["untracked"] == 1

    resp = await client.delete(f"/v1/tracker/links/{out['id']}", headers=ctx.as_("approver"))
    assert resp.status_code == 204, resp.text
    r = await record(ctx)
    assert r is not None and r.item_key is None and r.track_id is None
    assert r.prd_document_id is None
    report = (await client.get("/v1/roadmaps/prd-a-roadmap/alignment",
                               headers=ctx.as_("viewer"))).json()  # fmt: skip
    assert report["counts"]["untracked"] == 2 and report["counts"]["unplanned"] == 0
    assert await actions(ctx) == ["tracker.issue_linked", "tracker.issue_unlinked"]


async def test_scoping_and_roles(client):
    ctx = await make_ctx()
    await seed_prd_a(ctx)
    si = await item_id(ctx, await github_source(ctx, "commenter"))
    for who in ("commenter", "viewer"):
        resp = await client.get("/v1/tracker/issues", params={"q": "412"}, headers=ctx.as_(who))
        assert resp.status_code == 403, who
        await link(client, ctx, who, 403, prd="prd-a", item_key="a1", source_item_id=si)
    # A commenter flagged engineering lead may link (A3).
    async with tenant_session(ctx.tenant_id) as s:
        from oracle.auth.models import User

        (await s.get(User, ctx.users["commenter"].id)).engineering_lead = True
        await s.commit()
    out = await link(client, ctx, "commenter", prd="prd-a", item_key="a1", source_item_id=si)

    other = await make_ctx("Other Co")
    await link(client, other, "owner", status=404, prd="prd-a", item_key="a1", source_item_id=si)
    resp = await client.delete(f"/v1/tracker/links/{out['id']}", headers=other.as_("owner"))
    assert resp.status_code == 404
    resp = await client.delete(f"/v1/tracker/links/{uuid.uuid4()}", headers=ctx.as_("owner"))
    assert resp.status_code == 404

    async with tenant_session(ctx.tenant_id) as s:
        run = Run(flow="baseline_to_prd", created_by=ctx.users["owner"].id, status="running")
        s.add(run)
        await s.flush()
        raw = await mint_run_token(s, run.id, ["read:documents", "read:baseline",
                                               "read:sources"], 600)  # fmt: skip
        await s.commit()
    run_headers = {**ctx.as_("owner"), RUN_TOKEN_HEADER: raw}
    resp = await client.get("/v1/tracker/issues", params={"q": "412"}, headers=run_headers)
    assert resp.status_code == 403
    body = {"prd": "prd-a", "item_key": "a1", "source_item_id": si}
    resp = await client.post("/v1/tracker/links", headers=run_headers, json=body)
    assert resp.status_code == 403
    assert scopes.required_scope("GET", "/v1/tracker/issues") is None
    from oracle.main import app

    ops = {op["operationId"] for p in app.openapi()["paths"].values() for op in p.values()}
    assert {"search_tracker_issues", "link_tracker_issue", "unlink_tracker_issue"} <= ops


async def test_no_request_reaches_github(client, monkeypatch):
    ctx = await make_ctx()
    await seed_prd_a(ctx)
    si = await item_id(ctx, await github_source(ctx, "approver"))

    async def refuse(self, request):
        raise AssertionError(f"outbound request to {request.url}")

    monkeypatch.setattr(httpx.AsyncHTTPTransport, "handle_async_request", refuse)
    resp = await client.get("/v1/tracker/issues", params={"q": "412"}, headers=ctx.as_("approver"))
    assert resp.status_code == 200
    out = await link(client, ctx, prd="prd-a", item_key="a1", source_item_id=si)
    resp = await client.delete(f"/v1/tracker/links/{out['id']}", headers=ctx.as_("approver"))
    assert resp.status_code == 204
