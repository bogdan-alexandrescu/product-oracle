"""Lane A: roles on every endpoint, members, invites, last-owner protection, audit."""

import uuid
from dataclasses import dataclass

import pytest
from fastapi.routing import APIRoute
from sqlalchemy import select

from oracle.auth.models import ROLES, User
from oracle.auth.service import create_api_token, hash_password
from oracle.docs.router import router as docs_router
from oracle.export.router import router as export_router
from oracle.main import app
from oracle.members.models import Invite
from oracle.members.router import invites_router
from oracle.members.router import router as members_router
from oracle.models import AuditEvent
from oracle.review.router import router as review_router
from oracle.seed import seed
from oracle.tenancy import tenant_session
from tests.test_review import ANCHOR, add_version

V = "/v1/documents/{doc}/versions/{n}"
# The one section is brief (O1f), so the deck route has slides to return.
DRAFT = (
    "---\ndocument: checkout-redesign\ntitle: Checkout redesign PRD\nbrief: [t]\n---\n"
    "# Checkout {#t}\nBody.\n"
)


async def token_with_role(tenant_id: uuid.UUID, role: str) -> dict[str, str]:
    async with tenant_session(tenant_id) as s:
        token, raw = await create_api_token(s, f"{role}-token")
        token.role = role
        await s.commit()
    return {"Authorization": f"Bearer {raw}"}


async def add_user(tenant_id: uuid.UUID, email: str, role: str) -> uuid.UUID:
    async with tenant_session(tenant_id) as s:
        user = User(email=email, password_hash=hash_password("x"), role=role)
        s.add(user)
        await s.commit()
        return user.id


async def audit(tenant_id: uuid.UUID, prefix: str = "") -> list[tuple[str, dict]]:
    async with tenant_session(tenant_id) as s:
        events = (
            await s.scalars(
                select(AuditEvent)
                .where(AuditEvent.action.startswith(prefix))
                .order_by(AuditEvent.created_at)
            )
        ).all()
        return [(e.action, e.data) for e in events]


@dataclass
class World:
    tenant_id: uuid.UUID
    owner: dict[str, str]  # the seeded owner token
    admin_id: uuid.UUID
    comment_id: str
    feedback_id: str
    member_id: uuid.UUID
    invite_id: str
    token_id: uuid.UUID
    follow_up_id: uuid.UUID
    update: str
    request_id: uuid.UUID

    def ids(self) -> dict[str, object]:
        return {
            "doc": "checkout-redesign",
            "n": 1,
            "key": "goal-trace",
            "comment_id": self.comment_id,
            "feedback_id": self.feedback_id,
            "user_id": self.member_id,
            "invite_id": self.invite_id,
            "token_id": self.token_id,
            "follow_up_id": self.follow_up_id,
            "update": self.update,
            "request_id": self.request_id,
        }


@pytest.fixture
async def world(client) -> World:
    """One document version with a comment, a changes-requested verdict, a second member,
    an open invite and an investor update (H8), all made by the owner token."""
    r = await seed()
    # A token without a user (the seeded one acts as the admin, whose role changes here).
    async with tenant_session(r.tenant_id) as s:
        _, raw = await create_api_token(s, "owner-token")
        await s.commit()
    owner = {"Authorization": f"Bearer {raw}"}
    resp = await client.post(
        "/v1/documents/checkout-redesign/versions",
        content=DRAFT,
        headers={**owner, "Content-Type": "text/markdown"},
    )
    assert resp.status_code == 201, resp.text
    async with tenant_session(r.tenant_id) as s:
        admin_id = await s.scalar(select(User.id).where(User.email == "admin@example.com"))
        from oracle.docs.models import Document

        doc_id = await s.scalar(select(Document.id))
    # Version 2 with the review test's sections, so ANCHOR resolves; then drop to v1 paths.
    await add_version(r.tenant_id, doc_id, 2)
    c = await client.post(
        V.format(doc="checkout-redesign", n=2) + "/comments",
        json={"section_key": "goal-trace", "anchor": ANCHOR, "body": "Cite it"},
        headers=owner,
    )
    assert c.status_code == 201, c.text
    v = await client.put(
        V.format(doc="checkout-redesign", n=2) + "/sections/goal-trace/review",
        json={"verdict": "changes_requested", "note": "More"},
        headers=owner,
    )
    assert v.status_code == 200, v.text
    member_id = await add_user(r.tenant_id, "member@example.com", "approver")
    inv = await client.post(
        "/v1/invites", json={"email": "new@example.com", "role": "viewer"}, headers=owner
    )
    assert inv.status_code == 201, inv.text
    update = await client.post(
        "/v1/drafts",
        json={"kind": "update", "title": "Investor update", "template": "investor-update"},
        headers=owner,
    )
    assert update.status_code == 201, update.text
    async with tenant_session(r.tenant_id) as s:
        from oracle.members.models import MemberFollowUp

        bot, _ = await create_api_token(s, "member-bot", user_id=member_id)
        # A provider revoke a disable still owes (no copy of the credential: no call made).
        follow_up = MemberFollowUp(
            member_id=member_id, kind="provider_revoke", target_id=uuid.uuid4(), provider="github"
        )
        s.add(follow_up)
        # A5: a pending access request.
        from oracle.members.models import AccessRequest

        access_request = AccessRequest(email="asks@example.com")
        s.add(access_request)
        # An approved PRD scope (C6) for GET /v1/documents/{doc}/scope.
        from oracle.docs.models import Document
        from oracle.runs.models import Run
        from oracle.runs.scope_models import PrdScope

        doc_id = await s.scalar(select(Document.id).where(Document.slug == "checkout-redesign"))
        run = Run(flow="baseline_to_prd", knobs={"document_slug": "checkout-redesign"})
        s.add(run)
        await s.flush()
        s.add(
            PrdScope(
                run_id=run.id,
                segment_seq=2,
                attempt=1,
                status="approved",
                document_id=doc_id,
                check_result={},
            )
        )
        # A PRD review whose draft made version 2 (D10), for GET .../versions/2/run-review.
        from oracle.runs.models import Checkpoint

        s.add(
            Checkpoint(
                run_id=run.id,
                kind="prd_review",
                approver_role="approver",
                payload={
                    "import": {
                        "document_id": str(doc_id),
                        "version": 2,
                        "slug": "checkout-redesign",
                    }
                },
            )
        )
        await s.commit()
    return World(
        r.tenant_id,
        owner,
        admin_id,
        c.json()["id"],
        v.json()["feedback_item_id"],
        member_id,
        inv.json()["id"],
        bot.id,
        follow_up.id,
        update.json()["slug"],
        access_request.id,
    )


# (method, path, minimum role, request kwargs). Version 2 carries the review fixtures.
V2 = V.replace("{n}", "2")
MATRIX: list[tuple[str, str, str, dict]] = [
    ("GET", "/v1/documents", "viewer", {}),
    ("GET", "/v1/documents/{doc}", "viewer", {}),
    # H8: on an update (only an update's visibility changes); approvers to approvers.
    (
        "PATCH",
        "/v1/documents/{update}/visibility",
        "owner",
        {"json": {"visibility": "approvers", "reason": "Owners and approvers"}},
    ),
    (
        "POST",
        "/v1/documents/{doc}/versions",
        "approver",
        {
            "content": DRAFT.replace("Body.", "Body two."),
            "headers": {"Content-Type": "text/markdown"},
        },
    ),
    ("GET", "/v1/documents/{doc}/versions", "viewer", {}),
    ("GET", V, "viewer", {}),
    ("GET", V + "/markdown", "viewer", {}),
    # D10: the run review a version's review decides; any member reads it.
    ("GET", V2 + "/run-review", "viewer", {}),
    ("GET", "/v1/documents/{doc}/diff", "viewer", {"params": {"from": 1, "to": 2}}),
    (
        "POST",
        V2 + "/comments",
        "commenter",
        {"json": {"section_key": "goal-trace", "anchor": ANCHOR, "body": "Why?"}},
    ),
    ("GET", V2 + "/comments", "viewer", {}),
    ("POST", "/v1/comments/{comment_id}/replies", "commenter", {"json": {"body": "Agreed"}}),
    # Someone else's comment: below approver only the author may change it.
    ("PATCH", "/v1/comments/{comment_id}", "approver", {"json": {"resolved": True}}),
    (
        "PUT",
        V2 + "/sections/{key}/review",
        "approver",
        {"json": {"verdict": "approved", "note": None}},
    ),
    ("POST", V2 + "/feedback", "commenter", {"json": {"body": "Add a rollout section."}}),
    ("GET", "/v1/documents/{doc}/feedback", "viewer", {}),
    ("PATCH", "/v1/feedback/{feedback_id}", "approver", {"json": {"status": "declined"}}),
    ("POST", "/v1/feedback/{feedback_id}/stage-for-agents", "approver", {}),
    ("DELETE", "/v1/feedback/{feedback_id}/stage-for-agents", "approver", {}),
    ("GET", "/v1/documents/{doc}/scope", "viewer", {}),
    ("GET", V2 + "/feedback-package", "viewer", {}),
    ("GET", V2 + "/resolution-report", "viewer", {}),
    ("POST", V2 + "/approve", "approver", {}),
    ("GET", V + "/export", "viewer", {"params": {"format": "md"}}),
    ("GET", V + "/deck", "viewer", {}),
    # O5: the audience registry (what each audience hides); any member reads it.
    ("GET", "/v1/roadmap-audiences", "viewer", {}),
    ("GET", "/v1/members", "owner", {}),
    ("PATCH", "/v1/members/{user_id}", "owner", {"json": {"role": "commenter"}}),
    ("DELETE", "/v1/members/{user_id}", "owner", {}),
    ("POST", "/v1/members/{user_id}/disable", "owner", {}),
    ("POST", "/v1/members/{user_id}/restore", "owner", {}),
    # A5: member detail, the removal and demotion preview, approvals, hand-over.
    ("GET", "/v1/members/{user_id}", "owner", {}),
    ("GET", "/v1/members/{user_id}/impact", "owner", {"params": {"change": "remove"}}),
    ("GET", "/v1/members/{user_id}/approvals", "owner", {}),
    ("POST", "/v1/members/{user_id}/hand-over", "owner", {"json": {"hand_over": []}}),
    ("GET", "/v1/api-tokens", "owner", {}),
    ("DELETE", "/v1/api-tokens/{token_id}", "owner", {}),
    ("GET", "/v1/api-tokens/{token_id}/approvals", "owner", {}),
    # A5: approvers invite too (viewers and commenters, their own invites only).
    ("GET", "/v1/invites", "approver", {}),
    ("POST", "/v1/invites", "approver", {"json": {"email": "x@example.com", "role": "viewer"}}),
    ("DELETE", "/v1/invites/{invite_id}", "approver", {}),
    ("POST", "/v1/invites/{invite_id}/resend", "approver", {}),
    ("GET", "/v1/access-requests", "approver", {}),
    ("POST", "/v1/access-requests/{request_id}/approve", "approver", {"json": {"role": "viewer"}}),
    ("POST", "/v1/access-requests/{request_id}/decline", "approver", {}),
    ("POST", "/v1/access-requests/{request_id}/reopen", "approver", {}),
    ("GET", "/v1/sign-in-rules", "owner", {}),
    ("POST", "/v1/invites/{invite_id}/access", "owner", {}),
    ("POST", "/v1/invites/{invite_id}/email", "owner", {}),
    ("POST", "/v1/member-follow-ups/{follow_up_id}/retry", "owner", {}),
    ("POST", "/v1/member-follow-ups/{follow_up_id}/dismiss", "owner", {}),
]
# Past the role check, refused for what the row is (A5): an approver acts on the invites
# they sent only (the world's is the owner's: 404); a pending request cannot be reopened.
PAST_THE_ROLE = {
    ("DELETE", "/v1/invites/{invite_id}"): {"approver": 404},
    ("POST", "/v1/invites/{invite_id}/resend"): {"approver": 404},
    ("POST", "/v1/access-requests/{request_id}/reopen"): {"approver": 409, "owner": 409},
}


def _template(path: str) -> str:
    # {update}: the world's update (H8), on the documents routes' {doc}.
    return path.replace("/versions/2", "/versions/{n}").replace("{update}", "{doc}")


def test_matrix_covers_every_route():
    """Each route of the routers Lane A guards appears in MATRIX, so none goes unchecked."""
    routes = {
        (method, route.path)
        for r in (docs_router, review_router, export_router, members_router, invites_router)
        for route in r.routes
        if isinstance(route, APIRoute)
        for method in route.methods
    }
    assert routes == {(m, _template(p)) for m, p, _, _ in MATRIX}


def test_every_route_requires_a_role():
    """Every guarded route has a require_role dependency (directly or via its router)."""

    def checks(dependant) -> bool:
        return any(
            getattr(d.call, "__name__", "") == "check_role" or checks(d)
            for d in dependant.dependencies
        )

    guarded = {p for _, p, _, _ in MATRIX}
    for route in app.routes:
        if isinstance(route, APIRoute) and route.path in {_template(p) for p in guarded}:
            assert checks(route.dependant), route.path


@pytest.mark.parametrize("role", ROLES)
@pytest.mark.parametrize(
    ("method", "path", "min_role", "kwargs"), MATRIX, ids=[f"{m} {p}" for m, p, _, _ in MATRIX]
)
async def test_role_matrix(client, world, role, method, path, min_role, kwargs):
    headers = {**kwargs.get("headers", {}), **await token_with_role(world.tenant_id, role)}
    resp = await client.request(
        method, path.format(**world.ids()), **{**kwargs, "headers": headers}
    )
    refused = PAST_THE_ROLE.get((method, path), {}).get(role)
    if refused is not None:
        assert resp.status_code == refused, (role, resp.status_code, resp.text)
    elif ROLES.index(role) >= ROLES.index(min_role):
        assert resp.status_code < 400, (role, resp.status_code, resp.text)
    else:
        assert resp.status_code == 403, (role, resp.status_code, resp.text)
        above = [f"Requires the {r} role" for r in ROLES[ROLES.index(role) + 1 :]]
        assert resp.json()["detail"] in (
            *above,
            "Only the author or an approver can change this comment",
        )


async def test_denied_requests_change_nothing(client, world):
    viewer = await token_with_role(world.tenant_id, "viewer")
    before = await audit(world.tenant_id)
    for method, path, min_role, kwargs in MATRIX:
        if min_role == "viewer":
            continue
        headers = {**kwargs.get("headers", {}), **viewer}
        resp = await client.request(
            method, path.format(**world.ids()), **{**kwargs, "headers": headers}
        )
        assert resp.status_code == 403, path
    assert await audit(world.tenant_id) == before


# --- Comments: commenters change only their own --------------------------------------------


async def test_commenter_resolves_and_edits_only_their_own(client, world):
    commenter = await token_with_role(world.tenant_id, "commenter")
    url = V2.format(doc="checkout-redesign") + "/comments"
    mine = await client.post(
        url, json={"section_key": "goal-trace", "anchor": ANCHOR, "body": "Mine"}, headers=commenter
    )
    assert mine.status_code == 201
    mine_id = mine.json()["id"]

    resp = await client.patch(
        f"/v1/comments/{mine_id}",
        json={"resolved": True, "body": "Mine, edited"},
        headers=commenter,
    )
    assert resp.status_code == 200
    assert resp.json()["resolved_at"] and resp.json()["body"] == "Mine, edited"

    theirs = await client.patch(
        f"/v1/comments/{world.comment_id}", json={"resolved": True}, headers=commenter
    )
    assert theirs.status_code == 403
    # Replying to someone else's thread is fine.
    reply = await client.post(
        f"/v1/comments/{world.comment_id}/replies", json={"body": "+1"}, headers=commenter
    )
    assert reply.status_code == 201

    approver = await token_with_role(world.tenant_id, "approver")
    resp = await client.patch(f"/v1/comments/{mine_id}", json={"resolved": False}, headers=approver)
    assert resp.status_code == 200 and resp.json()["resolved_at"] is None


# --- Members -------------------------------------------------------------------------------


async def test_list_members(client, world):
    resp = await client.get("/v1/members", headers=world.owner)
    assert resp.status_code == 200
    assert [(m["email"], m["role"]) for m in resp.json()] == [
        ("admin@example.com", "owner"),
        ("member@example.com", "approver"),
    ]
    # No password hash; a removed member is disabled, not gone (C2).
    assert set(resp.json()[0]) == {
        "id",
        "email",
        "name",
        "role",
        "engineering_lead",
        "created_at",
        "disabled_at",
        "disabled_by",
        "status",
        "last_sign_in_at",
        "open_tokens",
        "access_pending",
    }
    assert resp.json()[0]["status"] == "active"


async def test_change_role_is_audited(client, world):
    resp = await client.patch(
        f"/v1/members/{world.member_id}", json={"role": "owner"}, headers=world.owner
    )
    assert resp.status_code == 200 and resp.json()["role"] == "owner"
    # Same role again: no change, no event.
    await client.patch(
        f"/v1/members/{world.member_id}", json={"role": "owner"}, headers=world.owner
    )
    assert await audit(world.tenant_id, "member.") == [
        ("member.role", {"before": "approver", "after": "owner"})
    ]


async def test_cannot_demote_the_last_owner(client, world):
    resp = await client.patch(
        f"/v1/members/{world.admin_id}", json={"role": "approver"}, headers=world.owner
    )
    assert resp.status_code == 409
    assert "last owner" in resp.json()["detail"]
    async with tenant_session(world.tenant_id) as s:
        assert (await s.get(User, world.admin_id)).role == "owner"
    assert await audit(world.tenant_id, "member.") == []

    # With a second owner, one can step down; then the other is the last again.
    await client.patch(
        f"/v1/members/{world.member_id}", json={"role": "owner"}, headers=world.owner
    )
    resp = await client.patch(
        f"/v1/members/{world.admin_id}", json={"role": "viewer"}, headers=world.owner
    )
    assert resp.status_code == 200
    resp = await client.patch(
        f"/v1/members/{world.member_id}", json={"role": "commenter"}, headers=world.owner
    )
    assert resp.status_code == 409


async def test_member_patch_validation(client, world):
    resp = await client.patch(
        f"/v1/members/{world.member_id}", json={"role": "admin"}, headers=world.owner
    )
    assert resp.status_code == 422
    resp = await client.patch(
        f"/v1/members/{uuid.uuid4()}", json={"role": "viewer"}, headers=world.owner
    )
    assert resp.status_code == 404


async def test_members_are_per_company(client, world):
    from tests.conftest import make_tenant

    other = await make_tenant("Other Co")
    other_user = await add_user(other, "someone@example.org", "owner")
    assert len((await client.get("/v1/members", headers=world.owner)).json()) == 2
    resp = await client.patch(
        f"/v1/members/{other_user}", json={"role": "viewer"}, headers=world.owner
    )
    assert resp.status_code == 404


# --- Invites -------------------------------------------------------------------------------


async def test_create_invite(client, world):
    resp = await client.post(
        "/v1/invites", json={"email": "  Pat@Example.COM ", "role": "approver"}, headers=world.owner
    )
    assert resp.status_code == 201, resp.text
    body = resp.json()
    assert (body["email"], body["role"], body["status"]) == ("pat@example.com", "approver", "open")
    assert body["invited_by"] is not None
    assert ("invite.create", {"email": "pat@example.com", "role": "approver"}) in await audit(
        world.tenant_id, "invite."
    )


@pytest.mark.parametrize(
    ("email", "code"),
    [
        ("new@example.com", 409),  # open invite exists
        ("NEW@example.com", 409),
        ("member@example.com", 409),  # already a member
        ("not-an-email", 422),
        ("a@b", 422),
    ],
)
async def test_create_invite_refusals(client, world, email, code):
    resp = await client.post(
        "/v1/invites", json={"email": email, "role": "viewer"}, headers=world.owner
    )
    assert resp.status_code == code, resp.text


async def test_revoke_invite(client, world):
    url = f"/v1/invites/{world.invite_id}"
    assert (await client.delete(url, headers=world.owner)).status_code == 204
    assert (await client.get("/v1/invites", headers=world.owner)).json() == []
    revoked = (await client.get("/v1/invites?status=revoked", headers=world.owner)).json()
    assert [(i["email"], i["status"]) for i in revoked] == [("new@example.com", "revoked")]
    # Twice is a no-op, and the email can be invited again.
    assert (await client.delete(url, headers=world.owner)).status_code == 204
    again = await client.post(
        "/v1/invites", json={"email": "new@example.com", "role": "approver"}, headers=world.owner
    )
    assert again.status_code == 201
    every = (await client.get("/v1/invites?status=all", headers=world.owner)).json()
    assert [i["status"] for i in every] == ["open", "revoked"]
    assert [a for a, _ in await audit(world.tenant_id, "invite.")] == [
        "invite.create",
        "invite.revoke",
        "invite.create",
    ]
    missing = await client.delete(f"/v1/invites/{uuid.uuid4()}", headers=world.owner)
    assert missing.status_code == 404


async def test_accepted_invite_cannot_be_revoked(client, world):
    from datetime import UTC, datetime

    async with tenant_session(world.tenant_id) as s:
        invite = await s.get(Invite, uuid.UUID(world.invite_id))
        invite.accepted_at = datetime.now(UTC)
        await s.commit()
    resp = await client.delete(f"/v1/invites/{world.invite_id}", headers=world.owner)
    assert resp.status_code == 409
    accepted = (await client.get("/v1/invites?status=accepted", headers=world.owner)).json()
    assert [i["status"] for i in accepted] == ["accepted"]
