"""S8 production finding (#723): the decider's Approve in a review meeting on a PRD whose
policy has required sections. Against Postgres. The invented PRD of
test_simple_one_pager_api (approved as version 1, a decider named by its policy), with
``section_approval = required_sections`` and no section owner or reviewer assigned (a PRD
started from an empty skeleton), then the same with a required reviewer who is absent.

Test cards (protects / fails_when / no_claim):

- test_required_sections_without_reviewers_publish: protects=the decider's Approve in a
  meeting really publishes a PRD whose required sections have no reviewer: version 2 is
  approved, the working draft is gone, the one-pager reads version 2 with the edited line,
  the decision says "(published)"; fails_when=Approve leaves version 2 unapproved (the
  required sections' approvals missing) while recording "published"; no_claim=sections
  with a named reviewer, Studio's own approve.
- test_absent_required_reviewer_waits: protects=with an absent required reviewer the
  meeting's Approve does not publish and says so: the draft waits on them, the one-pager
  stays on version 1, the decision reads "not yet published: Waiting on <name>'s
  approval", in the banner's words; then their own approve publishes version 2;
  fails_when=the decision says "published" while version 2 is unapproved, its wording
  differs from the banner's, or their approve does not publish; no_claim=the Inbox row
  (test_simple_drafts_api).
- test_section_reviewer_absent_waits_then_approves: protects=a required section whose
  assigned reviewer is absent is not approved over their head: the draft waits on them
  (their Inbox request), the decision reads "Waiting on <name>'s approval"; their own
  approve of the draft approves the section and publishes version 2; fails_when=it says
  "published", they get no Inbox row, or they can't see or approve the draft;
  no_claim=several sections' wording.
- test_section_reviewer_approves_in_studio_publishes: protects=the absent section
  reviewer's approval of the section in Studio settles the PRD's Simple draft: version 2
  publishes; fails_when=the draft stays submitted (only roadmaps settled);
  no_claim=a rejection in Studio.
- test_live_poll_reads_holds_without_recomputing: protects=the meeting's read (polled
  every 5 s) shows what the decider's Approve recorded as holding a draft, without the
  review policy's checks; fails_when=it words the policy's blockers per read; no_claim=Studio
  edits after the Approve.
- test_published_words_match_the_banner: protects=the recorded decision words a held
  draft as the meeting's banner does ("Waiting on", " · "); fails_when=they differ.
"""

import uuid
from types import SimpleNamespace

from sqlalchemy import select

from oracle.auth.models import User
from oracle.docs.models import Document, DocumentVersion
from oracle.review.models import DocumentReviewPolicy, SectionReviewState
from oracle.simple import drafts, meetings
from oracle.tenancy import tenant_session
from tests import test_simple_one_pager_api as op

MEETINGS = "/v1/simple/meetings"
REQUIRED = ["problem", "build", "outcomes"]


async def _world(client, reviewer: bool = False, section_reviewer: bool = False):
    ctx = await op.world(client)
    async with tenant_session(ctx.tenant_id) as s:
        rev = None
        if reviewer or section_reviewer:
            rev = User(email="rae@example.com", name="Rae Viewer", password_hash="x",
                       role="approver")  # fmt: skip
            s.add(rev)
            await s.flush()
            ctx.users["reviewer"] = rev
        doc = await s.scalar(select(Document).where(Document.slug == "guided-setup"))
        policy = await s.scalar(
            select(DocumentReviewPolicy).where(DocumentReviewPolicy.document_id == doc.id)
        )
        policy.required_section_keys = REQUIRED
        policy.section_approval = "required_sections"
        if reviewer:
            policy.mandatory_reviewer_ids = [rev.id]
        if section_reviewer:
            s.add(SectionReviewState(document_id=doc.id, section_key="build",
                                     reviewer_ids=[rev.id], invalidated_review_ids=[],
                                     lock_version=1))  # fmt: skip
        await s.commit()
    return ctx


async def _meeting_with_an_edit(client, ctx) -> dict:
    r = await client.post(MEETINGS, json={"prd": "guided-setup", "title": "Setup review"},
                          headers=ctx.as_("decider"))  # fmt: skip
    assert r.status_code == 201, r.text
    m = r.json()
    view = await op.get(client, ctx, "decider")
    assert view["version"] == 1
    r = await client.post("/v1/simple/changes", json={
        "op": "edit_line", "session_id": m["session_id"],
        "target": {"document_id": view["document"]["id"], "line_id": "bets-1"},
        "before": {"line": op.line(view, "bets-1")["text"]},
        "after": {"line": "A checklist with two steps"},
    }, headers=ctx.as_("decider"))  # fmt: skip
    assert r.status_code == 201, r.text
    return m


async def _approved_at(ctx, number: int):
    async with tenant_session(ctx.tenant_id) as s:
        doc = await s.scalar(select(Document).where(Document.slug == "guided-setup"))
        v = await s.scalar(
            select(DocumentVersion).where(
                DocumentVersion.document_id == doc.id, DocumentVersion.number == number
            )
        )
        return v.approved_at


def _approval_title(out: dict) -> str:
    return next(d["title"] for d in out["meeting_decisions"] if d["title"].startswith("Approved"))


async def test_required_sections_without_reviewers_publish(client):
    ctx = await _world(client)
    m = await _meeting_with_an_edit(client, ctx)
    r = await client.post(f"{MEETINGS}/{m['id']}/approve", headers=ctx.as_("decider"))
    assert r.status_code == 200, r.text
    out = r.json()
    assert await _approved_at(ctx, 2) is not None
    after = await op.get(client, ctx, "viewer")
    assert after["version"] == 2, after["version"]
    assert op.line(after, "bets-1")["text"] == "A checklist with two steps"
    mine = await op.get(client, ctx, "decider")
    assert mine["draft"] is None, mine["draft"]
    assert _approval_title(out).endswith("(published)"), _approval_title(out)


async def test_absent_required_reviewer_waits(client):
    ctx = await _world(client, reviewer=True)
    m = await _meeting_with_an_edit(client, ctx)
    r = await client.post(f"{MEETINGS}/{m['id']}/approve", headers=ctx.as_("decider"))
    assert r.status_code == 200, r.text
    out = r.json()
    assert await _approved_at(ctx, 2) is None
    title = _approval_title(out)
    assert "published)" not in title.replace("not yet published", ""), title
    assert "not yet published: Waiting on Rae Viewer's approval)" in title, title
    assert (await op.get(client, ctx, "viewer"))["version"] == 1
    draft = (await client.get("/v1/simple/drafts", headers=ctx.as_("reviewer"))).json()
    draft = next(d for d in (draft if isinstance(draft, list) else draft["drafts"])
                 if d["status"] == "submitted")  # fmt: skip
    assert draft["waiting_on"] == [str(ctx.users["reviewer"].id)]
    r = await client.post(f"/v1/simple/drafts/{draft['id']}/approve", headers=ctx.as_("reviewer"))
    assert r.status_code == 200, r.text
    assert r.json()["status"] == "approved", r.json()
    assert await _approved_at(ctx, 2) is not None
    assert (await op.get(client, ctx, "viewer"))["version"] == 2


async def _approved_with_absent_section_reviewer(client):
    ctx = await _world(client, section_reviewer=True)
    m = await _meeting_with_an_edit(client, ctx)
    r = await client.post(f"{MEETINGS}/{m['id']}/approve", headers=ctx.as_("decider"))
    assert r.status_code == 200, r.text
    out = r.json()
    assert await _approved_at(ctx, 2) is None
    assert (await op.get(client, ctx, "viewer"))["version"] == 1
    return ctx, m, out


async def test_section_reviewer_absent_waits_then_approves(client):
    ctx, _, out = await _approved_with_absent_section_reviewer(client)
    rae = str(ctx.users["reviewer"].id)
    title = _approval_title(out)
    assert "not yet published: Waiting on Rae Viewer's approval)" in title, title
    draft = next(d for d in out["drafts"] if d["status"] == "submitted")
    assert draft["waiting_on"] == [rae], draft
    assert draft["blocked_by"] == [], draft["blocked_by"]
    inbox = (await client.get("/v1/inbox", headers=ctx.as_("reviewer"))).json()
    assert [a["draft_id"] for a in inbox["simple_approvals"]] == [draft["id"]], inbox
    r = await client.get(f"/v1/simple/drafts/{draft['id']}", headers=ctx.as_("reviewer"))
    assert r.status_code == 200, r.text
    assert r.json()["can_approve"] is True, r.json()
    r = await client.post(f"/v1/simple/drafts/{draft['id']}/approve", headers=ctx.as_("reviewer"))
    assert r.status_code == 200, r.text
    assert r.json()["status"] == "approved", r.json()
    assert await _approved_at(ctx, 2) is not None
    after = await op.get(client, ctx, "viewer")
    assert after["version"] == 2, after["version"]
    assert op.line(after, "bets-1")["text"] == "A checklist with two steps"
    assert (await op.get(client, ctx, "decider"))["draft"] is None


async def test_section_reviewer_approves_in_studio_publishes(client):
    ctx, _, _ = await _approved_with_absent_section_reviewer(client)
    r = await client.put(
        "/v1/documents/guided-setup/versions/2/sections/build/review",
        json={"verdict": "approved"},
        headers=ctx.as_("reviewer"),
    )
    assert r.status_code == 200, r.text
    assert await _approved_at(ctx, 2) is not None
    assert (await op.get(client, ctx, "viewer"))["version"] == 2
    assert (await op.get(client, ctx, "decider"))["draft"] is None


async def test_live_poll_reads_holds_without_recomputing(client, monkeypatch):
    ctx, m, _ = await _approved_with_absent_section_reviewer(client)

    async def boom(*a, **k):
        raise AssertionError("the meeting's read recomputed the draft's holds")

    monkeypatch.setattr(drafts, "_blocker_words", boom)
    r = await client.get(f"{MEETINGS}/{m['id']}", headers=ctx.as_("decider"))
    assert r.status_code == 200, r.text
    d = next(d for d in r.json()["drafts"] if d["status"] == "submitted")
    assert d["waiting_on"] == [str(ctx.users["reviewer"].id)], d
    # The banner names them though they were not invited (attendees).
    assert [p["name"] for p in r.json()["waiting_people"]] == ["Rae Viewer"], r.json()


def test_published_words_match_the_banner():
    rae, sam = uuid.uuid4(), uuid.uuid4()
    d = SimpleNamespace(status="submitted", waiting_on=[rae, sam],
                        blocked_by=["Sections Scope need a reviewer"])  # fmt: skip
    words = meetings.published_words(d, {rae: "Rae", sam: "Sam"})
    assert words == (
        "not yet published: Waiting on Rae and Sam's approval · Sections Scope need a reviewer"
    ), words
