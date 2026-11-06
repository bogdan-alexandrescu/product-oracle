"""A Simple working draft with no base version (opened on an item added in Simple, which sits
on no version yet) is sent and approved on the version readers see (hotfix 2, Nov 6: the
company roadmap's draft, never approved, answered 409 to Approve and publish)."""

import uuid

from sqlalchemy import update

from oracle.docs.models import Document, DocumentVersion
from oracle.simple.models import SimpleDraft
from oracle.tenancy import tenant_session
from tests.test_simple_changes_api import World, make_people
from tests.test_simple_changes_api import clock as clock  # noqa: F401

DRAFTS = "/v1/simple/drafts"


async def _draft_without_base(client, ctx, w, *, never_approved: bool) -> str:
    if never_approved:
        async with tenant_session(ctx.tenant_id) as s:
            await s.execute(
                update(DocumentVersion)
                .where(DocumentVersion.document_id == uuid.UUID(w.roadmap_id))
                .values(approved_at=None)
            )
            await s.commit()
    r = await w.post(client, "decider", "move_dates")
    assert r.status_code == 201, r.text
    draft_id = r.json()["change"]["draft_ids"][0]
    async with tenant_session(ctx.tenant_id) as s:
        await s.execute(
            update(SimpleDraft)
            .where(SimpleDraft.id == uuid.UUID(draft_id))
            .values(base_version_id=None)
        )
        await s.commit()
    return draft_id


async def _numbers(ctx, roadmap_id: str) -> list[int]:
    async with tenant_session(ctx.tenant_id) as s:
        rm = await s.get(Document, uuid.UUID(roadmap_id))
        return sorted(
            n
            for (n,) in (
                await s.execute(
                    DocumentVersion.__table__.select()
                    .with_only_columns(DocumentVersion.number)
                    .where(DocumentVersion.document_id == rm.id)
                )
            ).all()
        )


async def test_a_never_approved_roadmap_publishes_a_draft_with_no_base(client):
    ctx = await make_people()
    w = await World(ctx).build(decider=True, ops=["move_dates"])
    draft_id = await _draft_without_base(client, ctx, w, never_approved=True)
    before = await _numbers(ctx, w.roadmap_id)
    r = await client.post(f"{DRAFTS}/{draft_id}/approve", headers=ctx.as_("decider"))
    assert r.status_code == 200, r.text
    assert r.json()["status"] == "approved"
    assert await _numbers(ctx, w.roadmap_id) == [*before, max(before) + 1]


async def test_an_approved_roadmap_publishes_a_draft_with_no_base(client):
    ctx = await make_people()
    w = await World(ctx).build(decider=True, ops=["move_dates"])
    draft_id = await _draft_without_base(client, ctx, w, never_approved=False)
    r = await client.post(f"{DRAFTS}/{draft_id}/approve", headers=ctx.as_("decider"))
    assert r.status_code == 200, r.text
    assert r.json()["status"] == "approved"
