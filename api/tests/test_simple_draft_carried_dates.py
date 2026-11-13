"""A Simple working draft changes the roadmap's items, not its text: dates in the sections it
carries over from the base version (its summary, its items by quarter) are not checked again
when it becomes the next version (hotfix 3, Nov 6: the company roadmap's Approve and publish
answered 422 for five dates in the old version's summary).

Test card (protects / fails_when / no_claim):

- test_a_draft_publishes_over_a_summary_date_with_no_schedule_basis: protects=a draft whose
  base version's summary names a date with no schedule basis is approved (200, status
  "approved") and published; fails_when=Approve answers 422 (or anything but 200) because of
  that carried-over date; no_claim=the version's text after approval, or how dates the draft
  itself writes are checked.
"""

import hashlib
import uuid

from sqlalchemy import select

from oracle.docs.models import DocumentVersion, Section
from oracle.tenancy import tenant_session
from tests.test_simple_changes_api import World, make_people
from tests.test_simple_changes_api import clock as clock  # noqa: F401

DRAFTS = "/v1/simple/drafts"


async def test_a_draft_publishes_over_a_summary_date_with_no_schedule_basis(client):
    ctx = await make_people()
    w = await World(ctx).build(decider=True, ops=["move_dates"])
    async with tenant_session(ctx.tenant_id) as s:
        base = await s.scalar(
            select(DocumentVersion)
            .where(DocumentVersion.document_id == uuid.UUID(w.roadmap_id))
            .order_by(DocumentVersion.number.desc())
            .limit(1)
        )
        s.add(
            Section(
                version_id=base.id,
                section_key="summary",
                heading="Summary",
                level=2,
                ordinal=0,
                body_md="The payment step lands on Apr 2, 2027.",
                content_hash=hashlib.sha256(b"The payment step lands on Apr 2, 2027.").hexdigest(),
            )
        )
        await s.commit()
    r = await w.post(client, "decider", "move_dates")
    assert r.status_code == 201, r.text
    draft_id = r.json()["change"]["draft_ids"][0]
    r = await client.post(f"{DRAFTS}/{draft_id}/approve", headers=ctx.as_("decider"))
    assert r.status_code == 200, r.text
    assert r.json()["status"] == "approved"
