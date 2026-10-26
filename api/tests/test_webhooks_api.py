"""I1 lane 1: the webhooks API (spec-I1 "API", "Who can do what", "Secrets"; owner answers
Q1, Q2 and Q4 as changed on 2026-10-25: any write credential may create a webhook or rotate
its secret, run tokens never). Invented data only."""

import uuid

import pytest
from oracle.webhooks.models import Webhook
from sqlalchemy import select

from oracle import crypto
from oracle.models import AuditEvent
from oracle.tenancy import tenant_session
from tests.conftest import make_tenant
from tests.connection_helpers import make_person
from tests.test_mcp import api_token, mcp_client, run_token, text_of

URL = "https://hooks.example.test/oracle"
BODY = {"name": "Team bot", "url": URL, "event_types": ["run.started", "run.succeeded"]}


@pytest.fixture
def local_runtime():
    from oracle.swarm import FakeRuntime, set_runtime

    set_runtime(FakeRuntime())
    yield
    set_runtime(None)


@pytest.fixture
async def owner(tenant_id):
    return await make_person(tenant_id, "owner@example.com", "owner")


@pytest.fixture
async def approver(tenant_id):
    return await make_person(tenant_id, "approver@example.com", "approver")


def bearer(raw: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {raw}"}


async def create(client, headers, **body):
    return await client.post("/v1/webhooks", json={**BODY, **body}, headers=headers)


async def created(client, headers, **body) -> dict:
    resp = await create(client, headers, **body)
    assert resp.status_code == 201, resp.text
    return resp.json()


async def audits(tenant_id, prefix: str = "webhook.") -> list[AuditEvent]:
    async with tenant_session(tenant_id) as s:
        rows = await s.scalars(
            select(AuditEvent)
            .where(AuditEvent.action.startswith(prefix))
            .order_by(AuditEvent.created_at, AuditEvent.action)
        )
        return list(rows)


# --- create, the secret shown once ---------------------------------------------------------


async def test_an_approver_creates_a_webhook_and_sees_the_secret_once(client, tenant_id, approver):
    """protects=AC1: create returns the secret once; it is encrypted at rest and every
    later read shows only its last 4 characters; fails_when=a read, list or audit row
    carries the secret, or the row stores it in clear."""
    body = await created(client, approver.headers)
    secret = body["secret"]
    assert secret.startswith("whsec_") and len(secret) > 40
    hook = body["webhook"]
    assert hook["secret_hint"] == secret[-4:] and hook["host"] == "hooks.example.test"
    assert hook["status"] == "active" and hook["include_approvers_content"] is False
    assert hook["created_by"] == {"name": "Approver"}
    assert hook["event_types"] == ["run.started", "run.succeeded"]
    one = await client.get(f"/v1/webhooks/{hook['id']}", headers=approver.headers)
    listed = await client.get("/v1/webhooks", headers=approver.headers)
    assert one.status_code == 200 and listed.status_code == 200
    assert "whsec_" not in one.text and "whsec_" not in listed.text
    assert [h["id"] for h in listed.json()] == [hook["id"]]
    async with tenant_session(tenant_id) as s:
        row = await s.get(Webhook, uuid.UUID(hook["id"]))
        assert secret.encode() not in row.ciphertext
        assert crypto.decrypt(row.ciphertext).decode() == secret
        assert row.key_version == crypto.KEY_VERSION
    trail = await audits(tenant_id)
    assert [a.action for a in trail] == ["webhook.create"]
    assert "whsec_" not in str(trail[0].data)
    assert trail[0].data["credential"] == {"kind": "browser"}


async def test_an_api_token_with_write_scope_may_create_and_is_audited_with_it(client, tenant_id):
    """protects=owner Q4 (changed): an API token may create a webhook and get its secret
    once; the audit names the token; fails_when=403, or the audit lacks the credential."""
    raw = await api_token(tenant_id, "owner")
    body = await created(client, bearer(raw))
    assert body["secret"].startswith("whsec_")
    (row,) = await audits(tenant_id)
    assert row.data["credential"]["kind"] == "api_token" and row.actor_token_id is not None
    assert row.data["credential"]["token_id"] == str(row.actor_token_id)


async def test_create_refuses_bad_urls_unknown_types_and_more_than_ten(client, owner):
    """protects=spec API 422s; fails_when=one of them is accepted."""
    for url in ("http://hooks.example.test/x", "https://user:pw@hooks.example.test/x",
                "https://" + "a" * 2050 + ".example.test", "not a url"):  # fmt: skip
        assert (await create(client, owner.headers, url=url)).status_code == 422, url
    assert (await create(client, owner.headers, event_types=["run.exploded"])).status_code == 422
    assert (await create(client, owner.headers, event_types=[])).status_code == 422
    assert (await create(client, owner.headers, name="")).status_code == 422
    for i in range(10):
        await created(client, owner.headers, name=f"Hook {i}")
    assert (await create(client, owner.headers, name="Eleventh")).status_code == 422


async def test_only_an_owner_turns_on_approvers_content_and_with_a_reason(
    client, tenant_id, owner, approver
):
    """protects=AC8, Q2: an approver can't turn on owners-and-approvers content (422); an
    owner needs a reason; on an approver's webhook it stays off; fails_when=any passes."""
    flag = {"include_approvers_content": True}
    assert (await create(client, approver.headers, **flag, reason="x")).status_code == 422
    assert (await create(client, owner.headers, **flag)).status_code == 422
    body = await created(client, owner.headers, **flag, reason="The board bot needs updates")
    assert body["webhook"]["include_approvers_content"] is True
    actions = sorted(a.action for a in await audits(tenant_id))
    assert actions == ["webhook.approvers_content_on", "webhook.create"]
    theirs = (await created(client, approver.headers, name="Theirs"))["webhook"]
    resp = await client.patch(
        f"/v1/webhooks/{theirs['id']}", json={**flag, "reason": "x"}, headers=owner.headers
    )
    assert resp.status_code == 422
    mine = body["webhook"]["id"]
    resp = await client.patch(
        f"/v1/webhooks/{mine}", json={"include_approvers_content": False}, headers=owner.headers
    )
    assert resp.status_code == 422  # a reason both ways
    resp = await client.patch(
        f"/v1/webhooks/{mine}",
        json={"include_approvers_content": False, "reason": "Not needed now"},
        headers=owner.headers,
    )
    assert resp.status_code == 200 and resp.json()["include_approvers_content"] is False
    assert (await audits(tenant_id, "webhook.approvers_content_off"))[0].data["reason"]


# --- roles and the absent rule --------------------------------------------------------------


async def test_commenters_and_viewers_get_404_on_every_route(client, tenant_id, owner):
    """protects=AC8 and H8's absent rule; fails_when=a 403 or a 200 below approver."""
    hook = (await created(client, owner.headers))["webhook"]["id"]
    zero = str(uuid.uuid4())
    for role in ("commenter", "viewer"):
        person = await make_person(tenant_id, f"{role}@example.com", role)
        calls = [
            ("GET", "/v1/webhook-event-types", None),
            ("GET", "/v1/webhooks", None),
            ("POST", "/v1/webhooks", BODY),
            ("GET", f"/v1/webhooks/{hook}", None),
            ("PATCH", f"/v1/webhooks/{hook}", {"name": "x"}),
            ("DELETE", f"/v1/webhooks/{hook}", None),
            ("POST", f"/v1/webhooks/{hook}/rotate-secret", {}),
            ("POST", f"/v1/webhooks/{hook}/take-over", None),
            ("GET", f"/v1/webhooks/{hook}/deliveries", None),
            ("GET", f"/v1/webhooks/{hook}/deliveries/{zero}", None),
        ]
        for method, path, body in calls:
            resp = await client.request(method, path, json=body, headers=person.headers)
            assert resp.status_code == 404, (role, method, path, resp.status_code)


async def test_an_approver_sees_only_their_own_and_an_owner_sees_all(client, owner, approver):
    """protects=AC8, Q1: another person's webhook is 404 for an approver; an owner lists
    and manages every one; fails_when=an approver reads or changes the owner's webhook."""
    mine = (await created(client, approver.headers, name="Mine"))["webhook"]["id"]
    theirs = (await created(client, owner.headers, name="Owner's"))["webhook"]["id"]
    listed = (await client.get("/v1/webhooks", headers=approver.headers)).json()
    assert [h["id"] for h in listed] == [mine]
    for method, path, body in (
        ("GET", f"/v1/webhooks/{theirs}", None),
        ("PATCH", f"/v1/webhooks/{theirs}", {"name": "x"}),
        ("DELETE", f"/v1/webhooks/{theirs}", None),
        ("POST", f"/v1/webhooks/{theirs}/rotate-secret", {}),
        ("GET", f"/v1/webhooks/{theirs}/deliveries", None),
    ):
        resp = await client.request(method, path, json=body, headers=approver.headers)
        assert resp.status_code == 404, (method, path)
    everyone = (await client.get("/v1/webhooks", headers=owner.headers)).json()
    assert {h["id"] for h in everyone} == {mine, theirs}
    resp = await client.patch(
        f"/v1/webhooks/{mine}", json={"status": "paused"}, headers=owner.headers
    )
    assert resp.status_code == 200
    assert resp.json()["status"] == "paused" and resp.json()["paused_reason"] == "manual"


async def test_a_run_token_is_refused_403_on_every_route(client, tenant_id, owner, local_runtime):
    """protects=spec roles table (run tokens 403, not_for_runs) over REST and MCP;
    fails_when=a run token lists, reads or creates a webhook."""
    hook = (await created(client, owner.headers))["webhook"]["id"]
    token = await run_token(tenant_id, ["read:baseline", "read:documents"], owner.user.id)
    for method, path, body in (
        ("GET", "/v1/webhook-event-types", None),
        ("GET", "/v1/webhooks", None),
        ("POST", "/v1/webhooks", BODY),
        ("GET", f"/v1/webhooks/{hook}", None),
        ("POST", f"/v1/webhooks/{hook}/rotate-secret", {}),
    ):
        # A run token's REST call is its creator's credential marked with the run token.
        headers = {**owner.headers, "x-oracle-run-token": token}
        resp = await client.request(method, path, json=body, headers=headers)
        assert resp.status_code == 403, (method, path, resp.status_code)
    async with mcp_client(token) as c:
        names = {t.name for t in (await c.list_tools()).tools}
        assert not {n for n in names if "webhook" in n}


async def test_a_read_only_token_reads_and_cannot_write(client, tenant_id, owner):
    """protects=spec roles (read-only credentials list and read; every write 403);
    fails_when=an oracle:read token creates or changes one."""
    from oracle.auth.service import create_api_token

    hook = (await created(client, owner.headers))["webhook"]["id"]
    async with tenant_session(tenant_id) as s:
        token, raw = await create_api_token(s, "reader", user_id=owner.user.id, scope="oracle:read")
        await s.commit()
    assert (await client.get("/v1/webhooks", headers=bearer(raw))).status_code in (200, 404)
    for method, path, body in (
        ("POST", "/v1/webhooks", BODY),
        ("PATCH", f"/v1/webhooks/{hook}", {"name": "x"}),
        ("POST", f"/v1/webhooks/{hook}/rotate-secret", {}),
        ("DELETE", f"/v1/webhooks/{hook}", None),
    ):
        resp = await client.request(method, path, json=body, headers=bearer(raw))
        assert resp.status_code == 403, (method, path)


async def test_mcp_offers_every_webhook_operation_and_never_returns_a_secret(
    client, tenant_id, owner
):
    """protects=AC13 as changed by Q4: every webhook operation is an MCP tool (create and
    rotate included), with REST's role results; no tool result but create's and rotate's
    own carries a whsec_ string; fails_when=a tool is missing or a read leaks the secret."""
    ops = {
        "list_webhook_event_types", "list_webhooks", "create_webhook", "get_webhook",
        "update_webhook", "delete_webhook", "rotate_webhook_secret", "take_over_webhook",
        "list_webhook_deliveries", "get_webhook_delivery",
    }  # fmt: skip
    raw = await api_token(tenant_id, "owner")
    async with mcp_client(raw) as c:
        names = {t.name for t in (await c.list_tools()).tools}
        assert ops <= names, ops - names
        made = await c.call_tool("create_webhook", {"body": BODY})
        assert not made.is_error, text_of(made)
        hook = made.structured_content["webhook"]["id"]
        for name, args in (
            ("list_webhooks", {}),
            ("get_webhook", {"webhook_id": hook}),
            ("update_webhook", {"webhook_id": hook, "body": {"name": "Renamed"}}),
            ("list_webhook_deliveries", {"webhook_id": hook}),
            ("list_webhook_event_types", {}),
        ):
            got = await c.call_tool(name, args)
            assert not got.is_error, (name, text_of(got))
            assert "whsec_" not in text_of(got), name
    commenter = await api_token(tenant_id, "commenter")
    async with mcp_client(commenter) as c:
        got = await c.call_tool("get_webhook", {"webhook_id": hook})
        assert got.is_error


# --- change, rotate, delete, take over ------------------------------------------------------


async def test_rotate_returns_a_new_secret_once_and_keeps_the_old_for_24_hours(
    client, tenant_id, owner
):
    """protects=spec Secrets (rotation overlap) and AC12's stored half; fails_when=the old
    secret is dropped at once without end_old_now, or kept with it."""
    first = await created(client, owner.headers)
    hook = first["webhook"]["id"]
    resp = await client.post(f"/v1/webhooks/{hook}/rotate-secret", json={}, headers=owner.headers)
    assert resp.status_code == 200, resp.text
    second = resp.json()["secret"]
    assert second.startswith("whsec_") and second != first["secret"]
    assert resp.json()["webhook"]["secret_hint"] == second[-4:]
    async with tenant_session(tenant_id) as s:
        row = await s.get(Webhook, uuid.UUID(hook))
        assert crypto.decrypt(row.ciphertext).decode() == second
        assert crypto.decrypt(row.previous_ciphertext).decode() == first["secret"]
        overlap = (row.previous_expires_at - row.secret_rotated_at).total_seconds()
        assert 23.9 * 3600 < overlap <= 24 * 3600 + 1
    resp = await client.post(
        f"/v1/webhooks/{hook}/rotate-secret", json={"end_old_now": True}, headers=owner.headers
    )
    async with tenant_session(tenant_id) as s:
        row = await s.get(Webhook, uuid.UUID(hook))
        assert row.previous_ciphertext is None and row.previous_expires_at is None
    trail = [a for a in await audits(tenant_id) if a.action == "webhook.rotate_secret"]
    assert len(trail) == 2 and all("whsec_" not in str(a.data) for a in trail)
    assert trail[0].data["credential"] == {"kind": "browser"}


async def test_an_approver_changing_the_url_tells_every_owner(client, tenant_id, owner, approver):
    """protects=spec API (URL change audited with old and new host; owners get an Inbox
    row); fails_when=no audit or no Inbox row."""
    hook = (await created(client, approver.headers))["webhook"]["id"]
    resp = await client.patch(
        f"/v1/webhooks/{hook}",
        json={"url": "https://elsewhere.example.test/in"},
        headers=approver.headers,
    )
    assert resp.status_code == 200 and resp.json()["host"] == "elsewhere.example.test"
    (row,) = await audits(tenant_id, "webhook.update")
    assert row.data["host"] == {"before": "hooks.example.test", "after": "elsewhere.example.test"}
    inbox = (await client.get("/v1/me/notifications", headers=owner.headers)).json()
    titles = [n["title"] for n in inbox]
    assert "Approver changed where webhook Team bot sends" in titles


async def test_an_owner_pausing_someone_elses_webhook_tells_its_creator(
    client, tenant_id, owner, approver
):
    """protects=spec roles ("<Owner> paused your webhook <name>"); fails_when=no row."""
    hook = (await created(client, approver.headers))["webhook"]["id"]
    resp = await client.patch(
        f"/v1/webhooks/{hook}", json={"status": "paused"}, headers=owner.headers
    )
    assert resp.status_code == 200
    titles = [
        n["title"]
        for n in (await client.get("/v1/me/notifications", headers=approver.headers)).json()
    ]
    assert "Owner paused your webhook Team bot" in titles


async def test_delete_removes_the_row_and_its_secret(client, tenant_id, approver):
    """protects=spec Secrets (a deleted webhook's secret goes with it); fails_when=a row
    is left or the delete is not audited."""
    hook = (await created(client, approver.headers))["webhook"]["id"]
    resp = await client.delete(f"/v1/webhooks/{hook}", headers=approver.headers)
    assert resp.status_code == 204
    assert (await client.get(f"/v1/webhooks/{hook}", headers=approver.headers)).status_code == 404
    async with tenant_session(tenant_id) as s:
        assert await s.get(Webhook, uuid.UUID(hook)) is None
    assert [a.action for a in await audits(tenant_id)][-1] == "webhook.delete"


async def test_an_owner_takes_over_a_paused_webhook(client, tenant_id, owner, approver):
    """protects=AC14's take-over half; fails_when=an approver may take over, an active
    one can be taken, or the creator does not change."""
    hook = (await created(client, approver.headers))["webhook"]["id"]
    path = f"/v1/webhooks/{hook}/take-over"
    assert (await client.post(path, headers=owner.headers)).status_code == 409
    await client.patch(f"/v1/webhooks/{hook}", json={"status": "paused"}, headers=owner.headers)
    assert (await client.post(path, headers=approver.headers)).status_code == 403
    resp = await client.post(path, headers=owner.headers)
    assert resp.status_code == 200 and resp.json()["created_by"] == {"name": "Owner"}
    assert (await client.get(f"/v1/webhooks/{hook}", headers=approver.headers)).status_code == 404
    assert "webhook.take_over" in [a.action for a in await audits(tenant_id)]


async def test_the_event_types_route_lists_the_registry(client, approver):
    """protects=spec Events (GET /v1/webhook-event-types reads EVENT_TYPES)."""
    from oracle.webhooks.events import EVENT_TYPES

    resp = await client.get("/v1/webhook-event-types", headers=approver.headers)
    assert resp.status_code == 200
    assert [t["type"] for t in resp.json()] == list(EVENT_TYPES)
    assert {t["group"] for t in resp.json()} == {"runs", "drafts", "approvals"}


async def test_each_company_sees_only_its_own_webhooks(client):
    """protects=waves.md cross-company rule; fails_when=another company's webhook is
    listed, read or changed."""
    a, b = await make_tenant("A Co"), await make_tenant("B Co")
    owner_a = await make_person(a, "owner-a@example.com", "owner")
    owner_b = await make_person(b, "owner-b@example.com", "owner")
    hook = (await created(client, owner_a.headers))["webhook"]["id"]
    assert (await client.get("/v1/webhooks", headers=owner_b.headers)).json() == []
    assert (await client.get(f"/v1/webhooks/{hook}", headers=owner_b.headers)).status_code == 404
    resp = await client.delete(f"/v1/webhooks/{hook}", headers=owner_b.headers)
    assert resp.status_code == 404
    resp = await client.get(f"/v1/webhooks/{hook}/deliveries", headers=owner_b.headers)
    assert resp.status_code == 404
