"""walkb-roadmap review 5a: GET /v1/simple/drafts says whether the draft's roadmap has an
approved version (``published``), so the Simple roadmap's working-draft banner never claims
an approved roadmap that does not exist (a roadmap built from a PRD, not approved yet).

Test card: protects=``published`` is true while the roadmap has an approved version and
false when none is approved; fails_when=the draft has no such field or says a roadmap with
no approved version is published; no_claim=the banner's words (web/e2e/walkb-review-5a).
"""

import uuid

from sqlalchemy import update

from oracle.docs.models import DocumentVersion
from oracle.tenancy import tenant_session
from tests.test_simple_changes_api import clock as clock  # noqa: F401
from tests.test_simple_drafts_api import edit_title, the_draft, world


async def test_draft_says_whether_its_roadmap_has_an_approved_version(client):
    w = await world()
    r = await edit_title(client, w, "decider")
    assert r.status_code == 201, r.text
    assert (await the_draft(client, w))["published"] is True
    async with tenant_session(w.ctx.tenant_id) as s:
        await s.execute(
            update(DocumentVersion)
            .where(DocumentVersion.document_id == uuid.UUID(w.roadmap_id))
            .values(approved_at=None, approved_by=None)
        )
        await s.commit()
    assert (await the_draft(client, w))["published"] is False
