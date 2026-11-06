"""A roadmap that was never approved: a newer version left in review by a run does not block
its Simple working draft (hotfix, Nov 6: the company roadmap's draft could not be approved
while a Nov 4 run's version 7 waited in review)."""

import hashlib
import uuid

from oracle.docs.models import Document, DocumentVersion
from oracle.tenancy import tenant_session
from tests.test_simple_changes_api import World, make_people
from tests.test_simple_changes_api import clock as clock  # noqa: F401

DRAFTS = "/v1/simple/drafts"


async def test_a_never_approved_roadmap_publishes_its_draft_over_a_run_version_in_review(client):
    ctx = await make_people()
    w = await World(ctx).build(decider=True, ops=["move_dates"])
    async with tenant_session(ctx.tenant_id) as s:
        rm = await s.get(Document, uuid.UUID(w.roadmap_id))
        for v in (
            await s.execute(
                DocumentVersion.__table__.select().where(DocumentVersion.document_id == rm.id)
            )
        ).all():
            await s.execute(
                DocumentVersion.__table__.update()
                .where(DocumentVersion.id == v.id)
                .values(approved_at=None)
            )
        await s.commit()
    r = await w.post(client, "decider", "move_dates")
    assert r.status_code == 201, r.text
    draft_id = r.json()["change"]["draft_ids"][0]
    # A run imports version 2 after the draft opened; it waits in review, never approved.
    async with tenant_session(ctx.tenant_id) as s:
        body = "# run v2\n"
        s.add(DocumentVersion(document_id=uuid.UUID(w.roadmap_id), number=2, markdown=body,
                              content_hash=hashlib.sha256(body.encode()).hexdigest()))  # fmt: skip
        await s.commit()
    r = await client.post(f"{DRAFTS}/{draft_id}/approve", headers=ctx.as_("decider"))
    assert r.status_code == 200, r.text
    assert r.json()["status"] == "approved"
