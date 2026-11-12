"""One PRD's one-pager drafts were always refused ("draft rejected: 1 problem(s)"): the PRD
cites a Ground Truth item in its front matter that was later rejected or moved to Trash, and
every submit re-imports the published text, so that one citation, which no one in Simple can
edit, refused every draft. Against Postgres; the invented PRD of test_simple_one_pager_api.

- test_a_draft_keeps_a_citation_whose_item_is_gone: protects=a draft of a PRD whose published
  version cites an item since rejected or trashed is submitted, the citation flagged "Not in
  the Ground Truth" on the sections citing it; fails_when=the submit is a 422 invalid_citation.
- test_a_new_citation_of_no_item_is_still_refused: protects=a citation the draft adds (or
  changes) to name no Ground Truth item is still refused; fails_when=it is kept.
- test_a_prd_draft_line_with_a_date_is_submitted: protects=the API never checks a PRD's
  dates against date sources (only a roadmap's and an update's, test_one_pager_draft_dates);
  fails_when=a PRD's draft is refused for a date its edited line writes.
"""

from datetime import UTC, datetime

import pytest
from sqlalchemy import select, update

from oracle.auth.models import User
from oracle.baseline.models import Entity
from oracle.docs.models import Document, DocumentVersion
from oracle.review.models import DocumentReviewPolicy
from oracle.tenancy import tenant_session
from tests.baseline_helpers import make_ctx
from tests.test_simple_one_pager_api import (
    MD,
    PRD,
    clock,  # noqa: F401 - the autouse clock
    edit,
    get,
    world,
)
from tests.test_simple_roadmap_api import NOW

CITED = PRD.replace(
    "title: Guided setup\n",
    "title: Guided setup\ncitations:\n  - id: o-g1\n    source: oracle\n"
    "    ref: baseline goal g1 (activation)\n    title: 'Goal G1: Activation'\n",
).replace(
    "They do not know which step comes next.",
    "They do not know which step comes next [c:o-g1].",
)


async def cited_world(client, gone: str | None):
    ctx = await make_ctx()
    async with tenant_session(ctx.tenant_id) as s:
        user = User(email="decider@example.com", name="Dee Cider", password_hash="x",
                    role="approver")  # fmt: skip
        s.add(user)
        s.add(Entity(type="goal", key="g1", title="Activation", origin="user", status="confirmed"))
        await s.commit()
        ctx.users["decider"] = user
    r = await client.post("/v1/documents/guided-setup/versions", content=CITED.encode(),
                          headers=MD | ctx.as_("owner"))  # fmt: skip
    assert r.status_code in (200, 201), r.text
    async with tenant_session(ctx.tenant_id) as s:
        doc = await s.scalar(select(Document).where(Document.slug == "guided-setup"))
        v = await s.scalar(select(DocumentVersion).where(DocumentVersion.document_id == doc.id))
        v.approved_at = NOW
        s.add(DocumentReviewPolicy(document_id=doc.id, decider_id=ctx.users["decider"].id))
        now = {"rejected": {"status": "rejected"}, "trashed": {"deleted_at": datetime.now(UTC)}}
        if gone:
            await s.execute(update(Entity).where(Entity.key == "g1").values(**now[gone]))
        await s.commit()
    return ctx


async def submit(client, ctx):
    draft_id = (await get(client, ctx, "decider"))["draft"]["id"]
    return await client.post(f"/v1/simple/drafts/{draft_id}/submit", headers=ctx.as_("decider"))


@pytest.mark.parametrize("gone", ["rejected", "trashed"])
async def test_a_draft_keeps_a_citation_whose_item_is_gone(client, gone):
    ctx = await cited_world(client, gone)
    view = await get(client, ctx, "decider")
    r = await edit(client, ctx, "decider", view, "bets-2", "Invite suggestions from contacts")
    assert r.status_code == 201, r.text
    sub = await submit(client, ctx)
    assert sub.status_code == 200, sub.text
    async with tenant_session(ctx.tenant_id) as s:
        v2 = await s.scalar(select(DocumentVersion).where(DocumentVersion.number == 2))
        (flag,) = [w for w in v2.warnings if w["code"] == "citation_not_in_ground_truth"]
    assert flag["section_keys"] == ["problem"]
    assert flag["refs"]["cite_key"] == "o-g1"
    assert flag["message"].startswith("Not in the Ground Truth")
    assert "o-g1" not in flag["message"]


@pytest.mark.parametrize("change", ["added", "changed"])
async def test_a_new_citation_of_no_item_is_still_refused(client, change):
    ctx = await cited_world(client, None)
    if change == "added":
        md = CITED.replace(
            "    title: 'Goal G1: Activation'\n",
            "    title: 'Goal G1: Activation'\n  - id: o-g9\n    source: oracle\n"
            "    ref: baseline goal g9 (made up)\n",
        ).replace("Single sign-on setup", "Single sign-on setup [c:o-g9]")
    else:
        md = CITED.replace("baseline goal g1 (activation)", "baseline goal g9 (made up)")
    r = await client.post("/v1/documents/guided-setup/versions?base_version=1",
                          content=md.encode(), headers=MD | ctx.as_("owner"))  # fmt: skip
    assert r.status_code == 422, r.text
    assert [e["code"] for e in r.json()["errors"]] == ["invalid_citation"]


async def test_a_prd_draft_line_with_a_date_is_submitted(client):
    ctx = await world(client)
    view = await get(client, ctx, "decider")
    r = await edit(client, ctx, "decider", view, "bets-1", "A setup checklist live by Dec 15, 2026")
    assert r.status_code == 201, r.text
    sub = await submit(client, ctx)
    assert sub.status_code == 200, sub.text
