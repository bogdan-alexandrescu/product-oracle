"""CR-06 routes (build prompt §16.12, §16.22): every new review route is role guarded,
company scoped (another company's ids are 404s, including through MCP), audited when it
changes state, and an MCP tool derived from OpenAPI. Also campaigns, notifications and
the review queue."""

import uuid

import pytest
from sqlalchemy import select

from oracle.auth.service import create_api_token
from oracle.main import app
from oracle.mcp.tools import app_operations
from oracle.models import AuditEvent
from oracle.review.models import Notification
from oracle.tenancy import tenant_session
from tests.conftest import make_tenant
from tests.legacy.helpers import mcp_session
from tests.review_v2_helpers import DOC, DRAFT, Ctx, import_md, person, setup, states, verdict

D = "/v1/documents/{doc}"
V = D + "/versions/{n}"
NEW_ROUTES = [
    ("GET", V + "/section-states", "get_section_states", "viewer"),
    ("GET", D + "/section-assignments", "list_section_assignments", "viewer"),
    ("PUT", D + "/sections/{key}/assignment", "put_section_assignment", "approver"),
    ("GET", "/v1/me/review-queue", "get_my_review_queue", "viewer"),
    ("GET", D + "/review-policy", "get_review_policy", "viewer"),
    ("PUT", D + "/review-policy", "put_review_policy", "owner"),
    ("PUT", D + "/sections/{key}", "edit_document_section", "commenter"),
    ("GET", D + "/section-patches", "list_section_patches", "viewer"),
    ("GET", "/v1/section-patches/{patch_id}", "get_section_patch", "viewer"),
    ("POST", "/v1/section-patches/{patch_id}/accept", "accept_section_patch", "approver"),
    ("POST", "/v1/section-patches/{patch_id}/reject", "reject_section_patch", "approver"),
    ("POST", D + "/campaigns", "create_review_campaign", "approver"),
    ("GET", D + "/campaigns", "list_review_campaigns", "viewer"),
    ("GET", "/v1/campaigns/{campaign_id}", "get_review_campaign", "viewer"),
    ("PATCH", "/v1/campaigns/{campaign_id}", "update_review_campaign", "approver"),
    ("GET", "/v1/me/notifications", "list_my_notifications", "viewer"),
    ("POST", "/v1/notifications/{notification_id}/read", "read_notification", "viewer"),
    ("POST", "/v1/me/notifications/read-all", "read_all_notifications", "viewer"),
    ("GET", V + "/publish-check", "get_publish_check", "viewer"),
    ("POST", V + "/publish", "publish_version", "approver"),
    ("GET", D + "/publications", "list_publications", "viewer"),
    ("GET", D + "/publications/{p}", "get_publication", "viewer"),
    ("GET", D + "/publications/{p}/export", "export_publication", "viewer"),
]


def test_every_new_route_is_in_openapi_and_an_mcp_tool():
    paths = app.openapi()["paths"]
    ops = {(o.method, o.path): o for o in app_operations(app)}
    for method, path, op_id, _ in NEW_ROUTES:
        spec = paths[path][method.lower()]
        assert spec["operationId"] == op_id
        assert ops[(method, path)].excluded is None, op_id
        assert ops[(method, path)].tool_name == op_id


def _concrete(path: str) -> str:
    return path.format(
        doc=DOC,
        n=1,
        key="problem",
        p=1,
        patch_id=uuid.uuid4(),
        campaign_id=uuid.uuid4(),
        notification_id=uuid.uuid4(),
    )


@pytest.mark.parametrize(("method", "path", "op_id", "role"), NEW_ROUTES)
async def test_new_routes_require_auth(client, method, path, op_id, role):
    resp = await client.request(method, _concrete(path), json={})
    assert resp.status_code == 401


ROLES = ["viewer", "commenter", "approver", "owner"]
WRITE_BODIES = {
    "put_section_assignment": {},
    "put_review_policy": {},
    "edit_document_section": {"base_version": 1, "base_revision": "x", "body_md": "x"},
    "accept_section_patch": {"base_revision": "x", "lock_version": 1},
    "reject_section_patch": {"lock_version": 1},
    "create_review_campaign": {"title": "Feedback please"},
    "update_review_campaign": {"status": "closed", "lock_version": 1},
    "publish_version": {},
}


@pytest.mark.parametrize(
    ("method", "path", "op_id", "role"), [r for r in NEW_ROUTES if r[3] != "viewer"]
)
async def test_write_routes_refuse_lower_roles(client, method, path, op_id, role):
    ctx = await setup(client)
    for lower in ROLES[: ROLES.index(role)]:
        who = await person(ctx.tenant_id, lower)
        resp = await client.request(
            method, _concrete(path), json=WRITE_BODIES.get(op_id, {}), headers=who.headers
        )
        assert resp.status_code == 403, (op_id, lower, resp.text)


async def other_company(client) -> Ctx:
    tenant_id = await make_tenant("Other Co")
    async with tenant_session(tenant_id) as s:
        token, raw = await create_api_token(s, "other")
        token.role = "owner"
        await s.commit()
    auth = {"Authorization": f"Bearer {raw}"}
    assert (await import_md(client, auth, DRAFT)).status_code == 201
    return Ctx(tenant_id, auth)


async def _seed_review_data(client, ctx):
    """One of everything a reader might reach: assignment, campaign, notification,
    patch, publication."""
    reviewer = await person(ctx.tenant_id, "commenter", "reviewer")
    resp = await client.put(
        f"/v1/documents/{DOC}/sections/problem/assignment",
        json={"reviewer_ids": [str(reviewer.user_id)]},
        headers=ctx.auth,
    )
    assert resp.status_code == 200
    campaign = await client.post(
        f"/v1/documents/{DOC}/campaigns", json={"title": "All hands review"}, headers=ctx.auth
    )
    assert campaign.status_code == 201, campaign.text
    notes = (await client.get("/v1/me/notifications", headers=reviewer.headers)).json()
    assert notes
    assert (await client.post(ctx.v(1, "/approve"), headers=ctx.auth)).status_code == 200
    pub = await client.post(ctx.v(1, "/publish"), json={}, headers=ctx.auth)
    assert pub.status_code == 201, pub.text
    return reviewer, campaign.json()["id"], notes[0]["id"]


async def test_another_company_sees_none_of_it(client):
    ctx = await setup(client)
    reviewer, campaign_id, note_id = await _seed_review_data(client, ctx)
    other = await other_company(client)  # with its own document of that slug
    paths = [
        ctx.v(1, "/section-states"),
        f"/v1/documents/{DOC}/section-assignments",
        f"/v1/documents/{DOC}/campaigns",
        f"/v1/documents/{DOC}/publications",
    ]
    for path in paths:
        mine = (await client.get(path, headers=ctx.auth)).json()
        theirs = (await client.get(path, headers=other.auth)).json()
        assert mine != theirs, path
    assert (await client.get(f"/v1/documents/{DOC}/publications", headers=other.auth)).json() == []
    assert (
        await client.get(f"/v1/documents/{DOC}/publications/1", headers=other.auth)
    ).status_code == 404
    assert (await client.get(f"/v1/campaigns/{campaign_id}", headers=other.auth)).status_code == 404
    resp = await client.patch(
        f"/v1/campaigns/{campaign_id}",
        json={"status": "closed", "lock_version": 1},
        headers=other.auth,
    )
    assert resp.status_code == 404
    stranger = await person(other.tenant_id, "owner")
    assert (
        await client.post(f"/v1/notifications/{note_id}/read", headers=stranger.headers)
    ).status_code == 404
    # Same through MCP tools.
    token = other.auth["Authorization"].split(" ", 1)[1]
    async with mcp_session(token) as c:
        result = await c.call_tool("get_review_campaign", {"campaign_id": campaign_id})
        assert result.is_error
        result = await c.call_tool("list_publications", {"doc": DOC})
        assert not result.is_error
        assert "team-calendar" not in str(result.structured_content)


async def test_notifications_are_the_callers_own(client):
    ctx = await setup(client)
    reviewer, _, note_id = await _seed_review_data(client, ctx)
    colleague = await person(ctx.tenant_id, "approver", "colleague")
    # A colleague in the same company cannot read or mark another user's notification.
    assert (
        await client.post(f"/v1/notifications/{note_id}/read", headers=colleague.headers)
    ).status_code == 404
    resp = await client.post(f"/v1/notifications/{note_id}/read", headers=reviewer.headers)
    assert resp.status_code == 200 and resp.json()["read_at"]
    unread = (await client.get("/v1/me/notifications?unread=true", headers=reviewer.headers)).json()
    assert note_id not in [n["id"] for n in unread]
    marked = await client.post("/v1/me/notifications/read-all", headers=reviewer.headers)
    assert marked.status_code == 200
    assert (
        await client.get("/v1/me/notifications?unread=true", headers=reviewer.headers)
    ).json() == []
    # API tokens have no notifications.
    assert (await client.get("/v1/me/notifications", headers=ctx.auth)).json() == []


async def test_comment_notifications_reach_owner_reviewers_and_thread(client):
    ctx = await setup(client)
    owner = await person(ctx.tenant_id, "commenter", "owner")
    reviewer = await person(ctx.tenant_id, "commenter", "reviewer")
    author = await person(ctx.tenant_id, "commenter", "author")
    await client.put(
        f"/v1/documents/{DOC}/sections/solution/assignment",
        json={"owner_id": str(owner.user_id), "reviewer_ids": [str(reviewer.user_id)]},
        headers=ctx.auth,
    )
    created = await client.post(
        ctx.v(1, "/comments"),
        json={"section_key": "solution", "anchor": {"exact": "shared calendar"}, "body": "Why?"},
        headers=author.headers,
    )
    assert created.status_code == 201
    reply = await client.post(
        f"/v1/comments/{created.json()['id']}/replies",
        json={"body": "Because teams asked."},
        headers=owner.headers,
    )
    assert reply.status_code == 201
    async with tenant_session(ctx.tenant_id) as s:
        rows = (
            await s.scalars(select(Notification).where(Notification.kind.in_(("comment", "reply"))))
        ).all()
    got = sorted((r.kind, r.user_id) for r in rows)
    assert got == sorted(
        [
            ("comment", owner.user_id),
            ("comment", reviewer.user_id),
            ("reply", reviewer.user_id),
            ("reply", author.user_id),
        ]
    )


async def test_campaign_counts_and_closing(client):
    ctx = await setup(client)
    a = await person(ctx.tenant_id, "commenter", "a")
    await person(ctx.tenant_id, "viewer", "v")
    resp = await client.post(
        f"/v1/documents/{DOC}/campaigns",
        json={"title": "Org-wide review", "due_at": "2026-11-01T00:00:00Z"},
        headers=ctx.auth,
    )
    campaign = resp.json()
    # Commenters, approvers and owners are invited (the seeded admin, a); not viewers.
    assert campaign["invited"] == 2 and campaign["status"] == "open"
    await client.post(
        ctx.v(1, "/comments"),
        json={"section_key": "risks", "anchor": {"exact": "lag"}, "body": "How long?"},
        headers=a.headers,
    )
    got = (await client.get(f"/v1/campaigns/{campaign['id']}", headers=ctx.auth)).json()
    assert (got["comments"], got["participants"], got["open_change_requests"]) == (1, 1, 1)
    async with tenant_session(ctx.tenant_id) as s:
        invites = (
            await s.scalars(select(Notification).where(Notification.kind == "campaign"))
        ).all()
    assert a.user_id in {n.user_id for n in invites}
    stale = await client.patch(
        f"/v1/campaigns/{campaign['id']}", json={"status": "closed", "lock_version": 9},
        headers=ctx.auth,
    )  # fmt: skip
    assert stale.status_code == 409
    closed = await client.patch(
        f"/v1/campaigns/{campaign['id']}",
        json={"status": "closed", "lock_version": campaign["lock_version"]},
        headers=ctx.auth,
    )
    assert closed.status_code == 200 and closed.json()["closed_at"]


async def test_review_queue_lists_my_sections(client):
    ctx = await setup(client)
    me = await person(ctx.tenant_id, "approver", "me")
    await client.put(
        f"/v1/documents/{DOC}/sections/problem/assignment",
        json={"owner_id": str(me.user_id), "due_at": "2020-01-01T00:00:00Z"},
        headers=ctx.auth,
    )
    await client.put(
        f"/v1/documents/{DOC}/sections/risks/assignment",
        json={"reviewer_ids": [str(me.user_id)]},
        headers=ctx.auth,
    )
    queue = (await client.get("/v1/me/review-queue", headers=me.headers)).json()
    assert [(q["section_key"], q["role"], q["overdue"]) for q in queue] == [
        ("problem", "owner", True),
        ("risks", "reviewer", False),
    ]
    assert (await verdict(client, me.headers, 1, "problem")).status_code == 200
    queue = (await client.get("/v1/me/review-queue", headers=me.headers)).json()
    assert queue[0]["status"] == "approved" and queue[0]["overdue"] is False
    s1 = await states(client, ctx.auth, 1)
    assert s1["problem"]["owner_id"] == str(me.user_id)


async def test_state_changes_are_audited(client):
    ctx = await setup(client)
    await _seed_review_data(client, ctx)
    async with tenant_session(ctx.tenant_id) as s:
        actions = set(await s.scalars(select(AuditEvent.action)))
    assert {
        "section_assignment.update",
        "review_campaign.create",
        "version.approve",
        "document.publish",
    } <= actions
