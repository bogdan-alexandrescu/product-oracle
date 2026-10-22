"""#254: a PRD version whose sections all hold only the template's text (nothing written)
is refused by Approve and by Publish, and a roadmap is never built from one."""

from datetime import UTC, datetime

from sqlalchemy import func, select, update

import oracle.main  # noqa: F401 - registers the lanes' checks
from oracle.docs.models import Document, DocumentVersion
from oracle.tenancy import tenant_session
from tests.baseline_helpers import Ctx, make_ctx
from tests.fixtures import MARKDOWN

SLUG = "lantern-trial"


async def start_prd(client, ctx: Ctx) -> None:
    resp = await client.post(
        "/v1/drafts",
        json={"kind": "prd", "title": "Lantern trial", "template": "oracle-default", "slug": SLUG},
        headers=ctx.as_("approver"),
    )
    assert resp.status_code == 201, resp.text


async def stamp_approved(ctx: Ctx, n: int = 1) -> None:
    """A version approved before the refusal existed."""
    async with tenant_session(ctx.tenant_id) as s:
        doc_id = await s.scalar(select(Document.id).where(Document.slug == SLUG))
        await s.execute(
            update(DocumentVersion)
            .where(DocumentVersion.document_id == doc_id, DocumentVersion.number == n)
            .values(approved_at=datetime.now(UTC))
        )
        await s.commit()


async def test_approving_a_template_only_prd_is_409_nothing_written(client):
    ctx = await make_ctx()
    await start_prd(client, ctx)
    resp = await client.post(f"/v1/documents/{SLUG}/versions/1/approve", headers=ctx.as_("approver"))
    assert resp.status_code == 409, resp.text
    assert resp.json()["detail"].startswith("Nothing is written yet")
    async with tenant_session(ctx.tenant_id) as s:
        stamped = await s.scalar(
            select(func.count())
            .select_from(DocumentVersion)
            .where(DocumentVersion.approved_at.is_not(None))
        )
        assert stamped == 0


async def test_a_prd_with_one_written_section_approves(client):
    ctx = await make_ctx()
    await start_prd(client, ctx)
    h = ctx.as_("approver")
    md = (await client.get(f"/v1/documents/{SLUG}/versions/1/markdown", headers=h)).text
    head, rest = md.split("{#summary}\n", 1)
    written = head + "{#summary}\nLantern lets field crews log a trial in one tap.\n" + rest
    resp = await client.post(
        f"/v1/documents/{SLUG}/versions", content=written.encode(), headers={**h, **MARKDOWN}
    )
    assert resp.status_code == 201, resp.text
    resp = await client.post(f"/v1/documents/{SLUG}/versions/2/approve", headers=h)
    assert resp.status_code == 200, resp.text


async def test_publish_check_blocks_a_template_only_prd(client):
    ctx = await make_ctx()
    await start_prd(client, ctx)
    await stamp_approved(ctx)
    resp = await client.get(f"/v1/documents/{SLUG}/versions/1/publish-check", headers=ctx.as_("approver"))
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["can_publish"] is False
    blocker = next(b for b in body["blockers"] if b["code"] == "nothing_written")
    assert blocker["message"].startswith("Nothing is written yet")


async def test_a_roadmap_is_not_built_from_a_template_only_prd(client):
    ctx = await make_ctx()
    await start_prd(client, ctx)
    await stamp_approved(ctx)
    resp = await client.post(
        "/v1/runs",
        json={"flow": "prd_to_roadmap", "source": SLUG},
        headers=ctx.as_("approver"),
    )
    assert resp.status_code == 422, resp.text
    assert "Nothing is written yet" in resp.json()["detail"]
