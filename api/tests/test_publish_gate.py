"""The publish gate (T2 follow-up, owner 2026-10-19): the API refuses to approve a PRD
version whose readiness verdict for purpose ``publish`` is blocked, with a 409 naming the
blocks, on every path (REST, MCP); only the latest version is published (C5). Other kinds
keep their own checks. GET .../readiness takes ``?purpose=advisory|publish``."""

import hashlib
import uuid

from sqlalchemy import func, select

import oracle.main  # noqa: F401 - registers the lanes' checks
from oracle import readiness
from oracle.docs.models import Document, DocumentVersion
from oracle.models import AuditEvent
from oracle.readiness import CheckOutcome, ReadinessContext
from oracle.tenancy import tenant_session
from tests.baseline_helpers import Ctx, make_ctx, set_token_role
from tests.blocker_helpers import RATE_LIMIT, create_blocker
from tests.test_mcp import mcp_client, text_of


async def make_doc(ctx: Ctx, slug: str = "checkout-redesign", kind: str = "prd") -> uuid.UUID:
    async with tenant_session(ctx.tenant_id) as s:
        doc = Document(slug=slug, title="Checkout redesign", kind=kind)
        s.add(doc)
        await s.commit()
        return doc.id


async def add_version(ctx: Ctx, doc_id: uuid.UUID, n: int) -> None:
    markdown = f"# Checkout redesign v{n}\n\nShip to saved addresses first.\n"
    async with tenant_session(ctx.tenant_id) as s:
        s.add(
            DocumentVersion(
                document_id=doc_id,
                number=n,
                markdown=markdown,
                content_hash=hashlib.sha256(markdown.encode()).hexdigest(),
            )
        )
        await s.commit()


async def blocked_prd(client, ctx: Ctx, slug: str = "checkout-redesign", kind: str = "prd"):
    doc_id = await make_doc(ctx, slug, kind)
    await add_version(ctx, doc_id, 1)
    blocker = (await create_blocker(client, ctx, document_ids=[str(doc_id)]))["blocker"]
    return doc_id, blocker


def approve_url(slug: str, n: int = 1) -> str:
    return f"/v1/documents/{slug}/versions/{n}/approve"


async def assert_nothing_recorded(ctx: Ctx, doc_id: uuid.UUID) -> None:
    async with tenant_session(ctx.tenant_id) as s:
        doc = await s.get(Document, doc_id)
        assert doc.status != "approved"
        stamped = await s.scalar(
            select(func.count())
            .select_from(DocumentVersion)
            .where(DocumentVersion.document_id == doc_id, DocumentVersion.approved_at.is_not(None))
        )
        assert stamped == 0
        audited = await s.scalar(
            select(func.count())
            .select_from(AuditEvent)
            .where(AuditEvent.action == "version.approve")
        )
        assert audited == 0


async def test_approving_a_blocked_prd_is_409_naming_the_blocks(client):
    ctx = await make_ctx()
    doc_id, blocker = await blocked_prd(client, ctx)
    resp = await client.post(approve_url("checkout-redesign"), headers=ctx.as_("approver"))
    assert resp.status_code == 409, resp.text
    body = resp.json()
    assert body["detail"] == f"1 block: {RATE_LIMIT['statement']}"
    assert body["blocking"] == [
        {
            "key": "critical_blockers",
            "id": blocker["id"],
            "title": RATE_LIMIT["statement"],
            "rationale": body["blocking"][0]["rationale"],
        }
    ]
    assert body["blocking"][0]["rationale"]
    await assert_nothing_recorded(ctx, doc_id)


async def test_clearing_the_block_lets_the_prd_approve(client):
    ctx = await make_ctx()
    doc_id, blocker = await blocked_prd(client, ctx)
    assert (
        await client.post(approve_url("checkout-redesign"), headers=ctx.as_("approver"))
    ).status_code == 409
    resolved = await client.post(
        f"/v1/blockers/{blocker['id']}/status",
        json={"status": "resolved", "reason": "The provider raised our tier"},
        headers=ctx.as_("approver"),
    )
    assert resolved.status_code == 200, resolved.text
    resp = await client.post(approve_url("checkout-redesign"), headers=ctx.as_("approver"))
    assert resp.status_code == 200, resp.text
    assert resp.json()["document_status"] == "approved"


async def test_an_unblocked_prd_approves(client):
    ctx = await make_ctx()
    doc_id = await make_doc(ctx)
    await add_version(ctx, doc_id, 1)
    resp = await client.post(approve_url("checkout-redesign"), headers=ctx.as_("approver"))
    assert resp.status_code == 200, resp.text
    assert resp.json()["version"]["approved_at"]


async def test_a_blocked_prd_is_refused_over_mcp_too(client):
    ctx = await make_ctx()
    doc_id, _ = await blocked_prd(client, ctx)
    await set_token_role(ctx, "approver")
    async with mcp_client(ctx.token) as c:
        result = await c.call_tool("approve_version", {"doc": "checkout-redesign", "n": 1})
    assert result.is_error
    assert "409" in text_of(result)
    assert f"1 block: {RATE_LIMIT['statement']}" in text_of(result)
    await assert_nothing_recorded(ctx, doc_id)


async def test_other_kinds_keep_their_own_checks(client):
    """The gate is the PRD's: a roadmap (and the spec kind, when it lands) is unaffected,
    even with a critical blocker linked to it."""
    ctx = await make_ctx()
    await blocked_prd(client, ctx, slug="checkout-roadmap", kind="roadmap")
    resp = await client.post(approve_url("checkout-roadmap"), headers=ctx.as_("approver"))
    assert resp.status_code == 200, resp.text
    assert resp.json()["document_status"] == "approved"


async def test_only_the_latest_prd_version_is_published(client):
    """C5: to publish older text, restore it as a new version first."""
    ctx = await make_ctx()
    doc_id = await make_doc(ctx)
    await add_version(ctx, doc_id, 1)
    await add_version(ctx, doc_id, 2)
    resp = await client.post(approve_url("checkout-redesign", 1), headers=ctx.as_("approver"))
    assert resp.status_code == 409, resp.text
    assert resp.json()["detail"] == "v2 exists: only the latest version can be published"
    assert resp.json()["blocking"] == []
    await assert_nothing_recorded(ctx, doc_id)
    ok = await client.post(approve_url("checkout-redesign", 2), headers=ctx.as_("approver"))
    assert ok.status_code == 200, ok.text


async def _publish_only(ctx: ReadinessContext) -> CheckOutcome:
    if ctx.purpose == "publish":
        return CheckOutcome(status="critical", rationale="Stricter when publishing.")
    return CheckOutcome(status="pass", rationale="Fine for advice.")


async def test_readiness_takes_a_purpose_and_approve_asks_for_publish(client):
    ctx = await make_ctx()
    doc_id = await make_doc(ctx)
    await add_version(ctx, doc_id, 1)
    url = "/v1/documents/checkout-redesign/versions/1/readiness"
    with readiness.isolated_checks():
        readiness.register_check("publish_probe", _publish_only, hard=True)
        default = (await client.get(url, headers=ctx.as_("viewer"))).json()
        assert default["purpose"] == "advisory" and default["blocked"] is False
        advisory = (await client.get(url + "?purpose=advisory", headers=ctx.as_("viewer"))).json()
        assert advisory["blocked"] is False
        publish = await client.get(url + "?purpose=publish", headers=ctx.as_("viewer"))
        assert publish.status_code == 200, publish.text
        assert publish.json()["purpose"] == "publish"
        assert publish.json()["blocked"] is True
        assert publish.json()["blocking"] == ["publish_probe"]
        bad = await client.get(url + "?purpose=final", headers=ctx.as_("viewer"))
        assert bad.status_code == 422

        resp = await client.post(approve_url("checkout-redesign"), headers=ctx.as_("approver"))
        assert resp.status_code == 409, resp.text
        assert resp.json()["detail"] == "1 block: Publish probe"
    await assert_nothing_recorded(ctx, doc_id)
