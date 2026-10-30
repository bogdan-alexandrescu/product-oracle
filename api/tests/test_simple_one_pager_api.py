"""Simple S5 (#723): one-pagers (``GET /v1/simple/one-pagers/{doc}``, the ``edit_line`` op of
POST /v1/simple/changes, the PRD's working draft, the ``one_pager`` job and the PDF). Against
Postgres. One invented PRD, imported over REST and approved as version 1; people: the four
roles plus a decider (an approver) named by the PRD's review policy.

Test cards (protects / fails_when / no_claim):

- test_fallback_blocks_capped_with_source_keys: protects=a PRD whose template names no
  blocks shows D5's six blocks, each capped (problem <= 60 words, 3-5 bets, 2-4 outcomes
  with from -> to, not doing and risks <= 5), every line names its source sections, the
  timeline strip is the PRD's roadmap slice; the header names version, owner and decider;
  fails_when=a block is missing or over its cap, a line loses its section keys;
  no_claim=the model's wording (the job's test).
- test_cached_per_version_and_section_hash: protects=one row and one queued ``one_pager``
  job per version and mapped-section hash: a second read reuses both, a new version with a
  changed mapped section rebuilds; fails_when=every read rebuilds or a changed section
  keeps the old lines; no_claim=the worker's scheduling (tests/test_llm_jobs.py).
- test_job_answer_held_to_caps_and_keys: protects=the job's answer replaces the quick read
  (built_by oracle; one failing its checks, for owners), lines naming another block's
  sections are dropped, a block left
  short fails its checks and is held for owners while others keep the quick read
  (tests/test_simple_generation_quality.py has the checks); fails_when=a line points at a
  section it does not rest on; no_claim=the prompt's quality.
- test_template_blocks: protects=a template's ``one_pager.blocks`` front matter replaces
  the six blocks and maps sections by key; fails_when=the fallback ignores the template;
  no_claim=template editing.
- test_edit_line_per_role: protects=the decider's and an owner's line edit applies into
  the PRD's one shared working draft with a section patch for EVERY source section
  (before/after), visible to them and as a margin note with Undo, while viewers read the
  published line; a commenter's edit is a proposal routed to the decider, who accepts it;
  a viewer is 403; a stale ``before`` is 409; undo restores line and sections together;
  fails_when=a line and its section disagree, a proposal writes, or a viewer edits;
  no_claim=Detailed's editor.
- test_submit_publishes_patched_sections: protects=submitting the PRD's draft imports the
  next version with the patched sections in review; the decider's approval publishes it
  and the one-pager reads the new line from the new version; fails_when=the import loses
  the patch or publishes without the decider; no_claim=required reviewers (S3b's tests).
- test_proposer_withdraws_their_proposal: protects=a commenter's proposal note offers Undo
  to them only; their undo withdraws it (declined, decided by them, note gone, PRD line
  unchanged) while anyone else's undo is 403; fails_when=the proposer cannot withdraw,
  another person can, or the withdraw writes the PRD; no_claim=the web's margin note.
- test_pdf_one_page: protects=Export PDF answers a one-page PDF (or 503 without
  WeasyPrint's libraries) for every reader; fails_when=it is refused to a reader or runs
  past a page; no_claim=the brand's logo pixels.
"""

import uuid

import pytest
from sqlalchemy import select

from oracle import company_time
from oracle.auth.models import User
from oracle.docs.models import Document, DocumentVersion
from oracle.jobs.models import LlmJob
from oracle.review.models import DocumentReviewPolicy
from oracle.simple import one_pager
from oracle.simple.models import SimpleDraft, SimpleOnePager
from oracle.tenancy import tenant_session
from tests.baseline_helpers import Ctx, make_ctx
from tests.test_simple_roadmap_api import NOW

URL = "/v1/simple/one-pagers"
MD = {"Content-Type": "text/markdown"}
CHANGES = "/v1/simple/changes"

PRD = """---
title: Guided setup
---

## Problem and who has it {#problem}

New workspace admins stall during setup. Half of them never invite a teammate in the first
week. They do not know which step comes next.

## Who has it {#who}

Admins of new teams with fewer than ten people.

## What we will build {#build}

- A setup checklist that shows the next step
- Invite suggestions from the admin's calendar
- A sample project created on day one
- A progress meter on the home page

## Outcomes and how we measure them {#outcomes}

- Teammate invited in week one from 48% to 65%
- Setup finished in a day from 30% to 50%
- Fewer support tickets about setup

## Not doing {#not-doing}

- Single sign-on setup
- A mobile setup flow

## Risks and open decisions {#risks}

- Calendar access may scare admins away
- Decide whether the sample project can be deleted
"""


@pytest.fixture(autouse=True)
def clock(monkeypatch):
    monkeypatch.setattr(company_time, "now", lambda: NOW)


async def world(client) -> Ctx:
    ctx = await make_ctx()
    async with tenant_session(ctx.tenant_id) as s:
        user = User(email="decider@example.com", name="Dee Cider", password_hash="x",
                    role="approver")  # fmt: skip
        s.add(user)
        await s.commit()
        ctx.users["decider"] = user
    r = await client.post("/v1/documents/guided-setup/versions", content=PRD.encode(),
                          headers=MD | ctx.as_("owner"))  # fmt: skip
    assert r.status_code in (200, 201), r.text
    async with tenant_session(ctx.tenant_id) as s:
        doc = await s.scalar(select(Document).where(Document.slug == "guided-setup"))
        v = await s.scalar(select(DocumentVersion).where(DocumentVersion.document_id == doc.id))
        v.approved_at = NOW
        s.add(DocumentReviewPolicy(document_id=doc.id, decider_id=ctx.users["decider"].id))
        await s.commit()
    return ctx


async def get(client, ctx: Ctx, who: str = "owner", doc: str = "guided-setup") -> dict:
    r = await client.get(f"{URL}/{doc}", headers=ctx.as_(who))
    assert r.status_code == 200, r.text
    return r.json()


def block(view: dict, key: str) -> dict:
    return next(b for b in view["blocks"] if b["key"] == key)


def line(view: dict, line_id: str) -> dict:
    return next(x for b in view["blocks"] for x in b["lines"] if x["id"] == line_id)


async def edit(client, ctx: Ctx, who: str, view: dict, line_id: str, text: str, **over):
    body = {
        "op": "edit_line",
        "target": {"document_id": view["document"]["id"], "line_id": line_id},
        "before": {"line": over.pop("before", line(view, line_id)["text"])},
        "after": {"line": text},
    }
    return await client.post(CHANGES, json=body, headers=ctx.as_(who))


async def test_fallback_blocks_capped_with_source_keys(client):
    ctx = await world(client)
    view = await get(client, ctx, "viewer")
    assert [b["key"] for b in view["blocks"]] == [
        "problem", "bets", "outcomes", "not_doing", "risks", "timeline",
    ]  # fmt: skip
    problem = block(view, "problem")["lines"]
    assert len(problem) == 1 and len(problem[0]["text"].split()) <= 60
    assert set(problem[0]["source_keys"]) == {"problem", "who"}
    assert 3 <= len(block(view, "bets")["lines"]) <= 5
    outcomes = block(view, "outcomes")["lines"]
    assert 2 <= len(outcomes) <= 4
    assert outcomes[0]["metric"] == {"name": "Teammate invited in week one", "from": "48%",
                                     "to": "65%"}  # fmt: skip
    assert len(block(view, "not_doing")["lines"]) <= 5
    assert len(block(view, "risks")["lines"]) <= 5
    for b in view["blocks"]:
        for x in b["lines"]:
            assert x["source_keys"] and x["id"].startswith(b["key"] + "-")
    assert view["version"] == 1 and view["decider"]["name"] == "Dee Cider"
    assert view["built_by"] == "extract" and view["timeline"] == []
    assert view["can_edit"] is False and view["can_propose"] is False
    assert (await get(client, ctx, "commenter"))["can_propose"] is True
    assert (await get(client, ctx, "decider"))["can_edit"] is True


async def test_can_start_follows_the_meeting_start_rule(client):
    """Review finding (qa-simple-prd-10): Start review shows by meetings.may_start (an owner or
    the PRD's decider), not by who edits lines; a decider-less track owner who is an approver
    edits but does not start a review, and the start API refuses them."""
    from oracle.roadmap.models import ProductTrack

    ctx = await world(client)
    assert (await get(client, ctx, "owner"))["can_start"] is True
    assert (await get(client, ctx, "decider"))["can_start"] is True
    assert (await get(client, ctx, "approver"))["can_start"] is False
    assert (await get(client, ctx, "viewer"))["can_start"] is False
    async with tenant_session(ctx.tenant_id) as s:
        doc = await s.scalar(select(Document).where(Document.slug == "guided-setup"))
        policy = await s.scalar(select(DocumentReviewPolicy))
        policy.decider_id = None
        s.add(
            ProductTrack(prd_document_id=doc.id, title="Setup", owner_id=ctx.users["approver"].id)
        )
        await s.commit()
    view = await get(client, ctx, "approver")
    assert view["can_edit"] is True and view["can_start"] is False
    opts = await client.get("/v1/simple/meetings/options", headers=ctx.as_("approver"))
    assert opts.status_code == 200, opts.text
    prd = next(p for p in opts.json()["prds"] if p["document"]["slug"] == "guided-setup")
    assert prd["can_start"] is view["can_start"]


async def test_cached_per_version_and_section_hash(client):
    ctx = await world(client)
    await get(client, ctx)
    await get(client, ctx, "viewer")
    async with tenant_session(ctx.tenant_id) as s:
        assert len(list(await s.scalars(select(SimpleOnePager)))) == 1
        assert len(list(await s.scalars(select(LlmJob).where(LlmJob.kind == "one_pager")))) == 1
    changed = PRD.replace("A sample project created on day one", "A guided tour on day one")
    r = await client.post("/v1/documents/guided-setup/versions", content=changed.encode(),
                          headers=MD | ctx.as_("owner"))  # fmt: skip
    assert r.status_code in (200, 201), r.text
    async with tenant_session(ctx.tenant_id) as s:
        v2 = await s.scalar(select(DocumentVersion).where(DocumentVersion.number == 2))
        v2.approved_at = NOW
        await s.commit()
    view = await get(client, ctx)
    assert view["version"] == 2
    assert "A guided tour on day one" in [x["text"] for x in block(view, "bets")["lines"]]
    async with tenant_session(ctx.tenant_id) as s:
        assert len(list(await s.scalars(select(SimpleOnePager)))) == 2


async def test_job_answer_held_to_caps_and_keys(client):
    ctx = await world(client)
    await get(client, ctx)
    answer = {"blocks": [
        {"key": "problem", "lines": [{"text": "Admins stall.", "source_keys": ["problem"]}]},
        {"key": "bets", "lines": [
            {"text": "Checklist", "source_keys": ["build"]},
            {"text": "Invites", "source_keys": ["build"]},
            {"text": "Sample", "source_keys": ["build"]},
            {"text": "Wrong", "source_keys": ["risks"]},
        ]},
        {"key": "outcomes", "lines": [
            {"text": "Invites up", "source_keys": ["outcomes"],
             "metric": {"name": "Invited", "from": "48%", "to": "65%"}},
            {"text": "Setup", "source_keys": ["outcomes"],
             "metric": {"name": "Setup", "from": "30%", "to": "50%"}},
        ]},
        {"key": "not_doing", "lines": [{"text": "No SSO", "source_keys": ["not-doing"]}]},
        {"key": "risks", "lines": [{"text": "Calendar", "source_keys": ["risks"]}]},
    ]}  # fmt: skip

    async def ask(kind, payload):
        assert kind == "one_pager" and [b["key"] for b in payload["blocks"]][0] == "problem"
        return answer

    async with tenant_session(ctx.tenant_id) as s:
        job = await s.scalar(select(LlmJob).where(LlmJob.kind == "one_pager"))
        # The line naming another block's section fails its checks: held for owners.
        assert (await one_pager.run_job(s, job, ask))["held"] is True
        await s.commit()
    view = await get(client, ctx)
    assert view["built_by"] == "oracle"
    assert [x["text"] for x in block(view, "bets")["lines"]] == ["Checklist", "Invites", "Sample"]
    # A block left short of its minimum fails its checks (oracle.simple.quality): asked
    # again and failing again, it is held for owners; people below owner keep the quick read.
    answer["blocks"][1]["lines"] = answer["blocks"][1]["lines"][:1]
    async with tenant_session(ctx.tenant_id) as s:
        job = await s.scalar(select(LlmJob).where(LlmJob.kind == "one_pager"))
        out = await one_pager.run_job(s, job, ask)
        assert "1 bet; a one-pager has 3 to 5" in out["checks"]
        await s.commit()
    assert (await get(client, ctx, "commenter"))["built_by"] == "extract"


def test_template_blocks():
    body = (
        "---\none_pager:\n  blocks:\n    - key: why\n      title: Why now\n"
        "      sections: [problem]\n    - key: plan\n      title: The plan\n"
        "      sections: [build]\n      max_lines: 3\n---\n# Template\n"
    )
    specs = one_pager._template_specs(body)
    assert [(s.key, s.title, s.max_lines) for s in specs] == [("why", "Why now", 5),
                                                              ("plan", "The plan", 3)]  # fmt: skip
    assert one_pager._template_specs("# No front matter\n") is None


async def test_edit_line_per_role(client):
    ctx = await world(client)
    view = await get(client, ctx, "decider")
    old = line(view, "bets-1")["text"]
    r = await edit(
        client, ctx, "decider", view, "bets-1", "A setup checklist with the next two steps"
    )
    assert r.status_code == 201, r.text
    change = r.json()["change"]
    assert change["status"] == "applied" and len(change["draft_ids"]) == 1
    patch = change["after"]["sections"]["build"]
    assert "A setup checklist with the next two steps" in patch["body"] and old not in patch["body"]
    mine = await get(client, ctx, "decider")
    assert line(mine, "bets-1")["state"] == "edited"
    [note] = mine["notes"]
    assert note["kind"] == "change" and note["can_undo"] and note["adds_feature"]
    assert note["sections"][0]["key"] == "build" and old in note["sections"][0]["before"]
    assert mine["draft"]["changes"] == 1 and mine["draft"]["base_version"] == 1
    seen = await get(client, ctx, "viewer")
    assert line(seen, "bets-1")["text"] == old and seen["notes"] == []
    assert seen["changes_in_review"] == 1 and seen["draft"] is None
    # A line resting on two sections patches both.
    p = line(mine, "problem-1")
    r = await edit(client, ctx, "owner", mine, "problem-1", "New admins stall in setup.")
    assert r.status_code == 201, r.text
    assert (
        set(r.json()["change"]["after"]["sections"]) == set(p["source_keys"]) == {"problem", "who"}
    )
    async with tenant_session(ctx.tenant_id) as s:
        [d] = list(await s.scalars(select(SimpleDraft)))
        assert set(d.overlay["sections"]) == {"build", "problem", "who"}
    # A commenter proposes; it goes to the decider, writes nothing until accepted.
    r = await edit(client, ctx, "commenter", await get(client, ctx, "commenter"), "risks-1",
                   "Calendar access may worry admins")  # fmt: skip
    assert r.status_code == 201, r.text
    prop = r.json()["change"]
    assert prop["status"] == "proposed" and prop["routed_to"] == [str(ctx.users["decider"].id)]
    dec = await get(client, ctx, "decider")
    pnote = next(n for n in dec["notes"] if n["kind"] == "proposal")
    assert pnote["can_decide"] and line(dec, "risks-1")["state"] == "proposal"
    assert not next(n for n in (await get(client, ctx, "commenter"))["notes"])["can_decide"]
    acc = await client.post(f"{CHANGES}/{prop['id']}/accept", headers=ctx.as_("decider"))
    assert acc.status_code == 200, acc.text
    assert (
        line(await get(client, ctx, "decider"), "risks-1")["text"]
        == "Calendar access may worry admins"
    )
    # Viewers read; a stale before is 409.
    assert (await edit(client, ctx, "viewer", view, "bets-2", "x")).status_code == 403
    stale = await edit(client, ctx, "decider", view, "bets-1", "Again", before=old)
    assert stale.status_code == 409
    # Undo restores the line and its section together.
    u = await client.post(f"{CHANGES}/{change['id']}/undo", headers=ctx.as_("decider"))
    assert u.status_code in (200, 201), u.text
    back = await get(client, ctx, "decider")
    assert line(back, "bets-1")["text"] == old and line(back, "bets-1")["state"] == "published"
    async with tenant_session(ctx.tenant_id) as s:
        d = await s.scalar(select(SimpleDraft))
        assert "build" not in d.overlay["sections"]


async def test_submit_publishes_patched_sections(client):
    ctx = await world(client)
    view = await get(client, ctx, "decider")
    r = await edit(
        client, ctx, "decider", view, "bets-2", "Invite suggestions from shared contacts"
    )
    assert r.status_code == 201, r.text
    draft_id = (await get(client, ctx, "decider"))["draft"]["id"]
    sub = await client.post(f"/v1/simple/drafts/{draft_id}/submit", headers=ctx.as_("decider"))
    assert sub.status_code == 200, sub.text
    assert sub.json()["version"] == 2
    async with tenant_session(ctx.tenant_id) as s:
        v2 = await s.scalar(select(DocumentVersion).where(DocumentVersion.number == 2))
        assert "Invite suggestions from shared contacts" in v2.markdown
        assert "from the admin's calendar" not in v2.markdown and v2.approved_at is None
    # Still version 1 for readers until the decider approves.
    assert (await get(client, ctx, "viewer"))["version"] == 1
    ok = await client.post(f"/v1/simple/drafts/{draft_id}/approve", headers=ctx.as_("decider"))
    assert ok.status_code == 200, ok.text
    after = await get(client, ctx, "viewer")
    assert after["version"] == 2
    assert line(after, "bets-2")["text"] == "Invite suggestions from shared contacts"


async def test_pdf_one_page(client):
    from oracle.export.pdf import page_count, pdf_available

    ctx = await world(client)
    r = await client.get(f"{URL}/guided-setup/pdf", headers=ctx.as_("viewer"))
    if not pdf_available():
        assert r.status_code == 503
    else:
        assert r.status_code == 200 and r.content.startswith(b"%PDF")
    async with tenant_session(ctx.tenant_id) as s:
        from oracle.auth.deps import Principal

        p = Principal(tenant_id=ctx.tenant_id, kind="user", role="viewer",
                      user_id=ctx.users["viewer"].id)  # fmt: skip
        html, stem = await one_pager.pdf_html(s, p, "guided-setup")
        assert stem == "guided-setup-v1-one-pager" and "Guided setup" in html
        if pdf_available():
            assert page_count(html) == 1
    assert (await client.get(f"{URL}/{uuid.uuid4()}", headers=ctx.as_("viewer"))).status_code == 404


# --------------------------------------------------------------------------- review (#734)


async def test_proposal_reads_the_published_line_when_the_draft_is_hidden(client):
    """A commenter who cannot see the working draft proposes against the published line and
    section; neither the proposal nor a conflict carries the draft's words."""
    ctx = await world(client)
    seen = await get(client, ctx, "commenter")
    r = await edit(client, ctx, "owner", await get(client, ctx), "bets-1", "Owners-only wording")
    assert r.status_code == 201, r.text
    r = await edit(client, ctx, "commenter", seen, "bets-1", "A checklist of next steps")
    assert r.status_code == 201, r.text
    prop = r.json()["change"]
    assert prop["status"] == "proposed"
    assert prop["before"]["line"] == line(seen, "bets-1")["text"]
    assert "Owners-only wording" not in r.text
    stale = await edit(client, ctx, "commenter", seen, "bets-1", "Other", before="Not the line")
    assert stale.status_code == 409 and "Owners-only wording" not in stale.text


async def test_proposer_withdraws_their_proposal(client):
    ctx = await world(client)
    seen = await get(client, ctx, "commenter")
    old = line(seen, "risks-1")["text"]
    r = await edit(client, ctx, "commenter", seen, "risks-1", "Calendar access may worry admins")
    assert r.status_code == 201, r.text
    prop = r.json()["change"]
    assert prop["status"] == "proposed"
    [mine] = (await get(client, ctx, "commenter"))["notes"]
    assert mine["kind"] == "proposal" and mine["can_undo"] and not mine["can_decide"]
    [theirs] = (await get(client, ctx, "decider"))["notes"]
    assert theirs["kind"] == "proposal" and theirs["can_decide"] and not theirs["can_undo"]
    # Someone else (the decider, an owner) cannot withdraw it.
    for who in ("decider", "owner"):
        no = await client.post(f"{CHANGES}/{prop['id']}/undo", headers=ctx.as_(who))
        assert no.status_code == 403, no.text
        assert "Only the person who proposed it withdraws it" in no.text
    u = await client.post(f"{CHANGES}/{prop['id']}/undo", headers=ctx.as_("commenter"))
    assert u.status_code in (200, 201), u.text
    out = u.json()["change"]
    assert out["status"] == "declined" and out["decided_by"] == str(ctx.users["commenter"].id)
    assert out["decision_reason"] == "Withdrawn by its author"
    for who in ("commenter", "decider"):
        after = await get(client, ctx, who)
        assert after["notes"] == []
        assert line(after, "risks-1")["text"] == old
        assert line(after, "risks-1")["state"] == "published"
    async with tenant_session(ctx.tenant_id) as s:
        assert list(await s.scalars(select(SimpleDraft))) == []
    # Withdrawn once: a second undo and a late accept are 409.
    again = await client.post(f"{CHANGES}/{prop['id']}/undo", headers=ctx.as_("commenter"))
    assert again.status_code == 409, again.text
    late = await client.post(f"{CHANGES}/{prop['id']}/accept", headers=ctx.as_("decider"))
    assert late.status_code == 409, late.text


async def test_track_owner_submits_a_prd_draft_without_decider(client):
    """With no decider, the PRD's track owner (an approver) edits lines and submits the
    draft: drafts.who reads the PRD's tracks (prd_document_id)."""
    from oracle.roadmap.models import ProductTrack

    ctx = await world(client)
    async with tenant_session(ctx.tenant_id) as s:
        doc = await s.scalar(select(Document).where(Document.slug == "guided-setup"))
        policy = await s.scalar(select(DocumentReviewPolicy))
        policy.decider_id = None
        s.add(
            ProductTrack(prd_document_id=doc.id, title="Setup", owner_id=ctx.users["approver"].id)
        )
        await s.commit()
    view = await get(client, ctx, "approver")
    assert view["can_edit"] is True
    r = await edit(client, ctx, "approver", view, "bets-2", "Invite suggestions from contacts")
    assert r.status_code == 201 and r.json()["change"]["status"] == "applied", r.text
    draft = (await get(client, ctx, "approver"))["draft"]
    assert draft["can_submit"] is True
    got = await client.get(f"/v1/simple/drafts/{draft['id']}", headers=ctx.as_("approver"))
    assert got.status_code == 200, got.text
    sub = await client.post(f"/v1/simple/drafts/{draft['id']}/submit", headers=ctx.as_("approver"))
    assert sub.status_code == 200, sub.text


async def test_edited_metric_line_shows_its_new_numbers(client):
    """An edited outcome's metric is read from its new words; the PDF keeps the published."""
    ctx = await world(client)
    view = await get(client, ctx)
    r = await edit(
        client, ctx, "owner", view, "outcomes-1", "Teammate invited in week one from 48% to 70%"
    )
    assert r.status_code == 201, r.text
    m = line(await get(client, ctx), "outcomes-1")["metric"]
    assert m == {"name": "Teammate invited in week one", "from": "48%", "to": "70%"}
    async with tenant_session(ctx.tenant_id) as s:
        from oracle.auth.deps import Principal

        p = Principal(tenant_id=ctx.tenant_id, kind="user", role="owner",
                      user_id=ctx.users["owner"].id)  # fmt: skip
        html, _ = await one_pager.pdf_html(s, p, "guided-setup")
        assert "65%" in html and "70%" not in html


async def test_job_answer_never_moves_a_drafted_line(client):
    """The job's answer does not replace the quick read while the working draft holds a
    line edit: line ids stay on the line that was edited."""
    ctx = await world(client)
    view = await get(client, ctx)
    before = {x["id"]: x["text"] for b in view["blocks"] for x in b["lines"]}
    r = await edit(client, ctx, "owner", view, "bets-2", "Invite suggestions from contacts")
    assert r.status_code == 201, r.text
    answer = {"blocks": [
        {"key": "problem", "lines": [{"text": "Admins stall.", "source_keys": ["problem"]}]},
        {"key": "bets", "lines": [{"text": t, "source_keys": ["build"]}
                                  for t in ("Sample", "Checklist", "Invites")]},
        {"key": "outcomes", "lines": [{"text": t, "source_keys": ["outcomes"]}
                                      for t in ("Invites up", "Setup")]},
    ]}  # fmt: skip

    async def ask(kind, payload):
        return answer

    async with tenant_session(ctx.tenant_id) as s:
        job = await s.scalar(select(LlmJob).where(LlmJob.kind == "one_pager"))
        assert (await one_pager.run_job(s, job, ask))["built"] is False
        await s.commit()
    after = await get(client, ctx)
    assert line(after, "bets-2")["text"] == "Invite suggestions from contacts"
    assert line(after, "bets-1")["text"] == before["bets-1"]
    assert line(after, "bets-3")["text"] == before["bets-3"]


def test_patch_replaces_the_source_fact_or_refuses():
    body = (
        "- A setup checklist that shows the next step\n"
        "- Invite suggestions from the admin's calendar\n"
    )
    # A paraphrased line (the job's wording) replaces the bullet it rests on.
    out = one_pager.patch(body, "Checklist showing the next setup step", "A guided tour")
    assert out == "- A guided tour\n- Invite suggestions from the admin's calendar\n"
    # A truncated line replaces its bullet.
    out = one_pager.patch(body, "Invite suggestions from the…", "Invites from contacts")
    assert out == "- A setup checklist that shows the next step\n- Invites from contacts\n"
    # Nothing to replace: refused, never appended.
    assert one_pager.patch(body, "Pricing changes for large teams", "x") is None


async def test_problem_line_patches_each_of_its_sections(client):
    """The Problem line spans two sections: its new words replace the first section's facts
    and the second loses the facts the line no longer says; nothing old is kept beside it."""
    ctx = await world(client)
    view = await get(client, ctx)
    r = await edit(client, ctx, "owner", view, "problem-1", "New admins stall in setup.")
    assert r.status_code == 201, r.text
    secs = r.json()["change"]["after"]["sections"]
    assert secs["problem"]["body"].strip() == "New admins stall in setup."
    assert "fewer than ten people" not in secs["who"]["body"]
    # A line no section holds is refused with the way to the detailed view.
    async with tenant_session(ctx.tenant_id) as s:
        row = await s.scalar(select(SimpleOnePager))
        blocks = [dict(b) for b in row.blocks]
        blocks[3] = {**blocks[3], "lines": [{"id": "not_doing-1", "text": "Pricing for big teams",
                                             "source_keys": ["not-doing"]}]}  # fmt: skip
        row.blocks = blocks
        await s.commit()
    view = await get(client, ctx)
    r = await edit(client, ctx, "owner", view, "not_doing-1", "No pricing work")
    assert r.status_code == 409 and "detailed view" in r.text


async def test_first_reads_race_on_a_new_version(client):
    """Two first reads of a new version build one row; neither fails."""
    ctx = await world(client)
    async with tenant_session(ctx.tenant_id) as s1, tenant_session(ctx.tenant_id) as s2:
        doc1 = await s1.scalar(select(Document))
        doc2 = await s2.scalar(select(Document))
        a = await one_pager.built(s1, doc1, queue=False)
        import asyncio

        task = asyncio.create_task(one_pager.built(s2, doc2, queue=False))
        await asyncio.sleep(0.3)
        await s1.commit()
        b = await task
        await s2.commit()
        assert a.row.id == b.row.id
    async with tenant_session(ctx.tenant_id) as s:
        assert len(list(await s.scalars(select(SimpleOnePager)))) == 1


async def test_viewer_read_writes_nothing(client):
    """A viewer's GET builds the page in memory: no cached row, no job."""
    ctx = await world(client)
    view = await get(client, ctx, "viewer")
    assert block(view, "bets")["lines"]
    async with tenant_session(ctx.tenant_id) as s:
        assert list(await s.scalars(select(SimpleOnePager))) == []
        assert list(await s.scalars(select(LlmJob).where(LlmJob.kind == "one_pager"))) == []


async def test_read_carries_the_source_sections_text(client):
    """The drill-down shows each source section's heading and text."""
    ctx = await world(client)
    view = await get(client, ctx)
    build = next(s for s in view["sections"] if s["key"] == "build")
    assert build["heading"] == "What we will build"
    assert "Invite suggestions from the admin's calendar" in build["body"]


# --------------------------------------------------------------------------- Remind


async def in_review(client, ctx: Ctx, reviewers=("approver",)) -> dict:
    """The decider's line edit submitted: the draft waits on ``reviewers``."""
    async with tenant_session(ctx.tenant_id) as s:
        policy = await s.scalar(select(DocumentReviewPolicy))
        policy.mandatory_reviewer_ids = [ctx.users[r].id for r in reviewers]
        ctx.users["approver"].name = "Ann Prover"
        s.add(ctx.users["approver"])
        await s.commit()
    view = await get(client, ctx, "decider")
    r = await edit(client, ctx, "decider", view, "bets-2", "Invite suggestions from contacts")
    assert r.status_code == 201, r.text
    draft_id = (await get(client, ctx, "decider"))["draft"]["id"]
    sub = await client.post(f"/v1/simple/drafts/{draft_id}/submit", headers=ctx.as_("decider"))
    assert sub.status_code == 200, sub.text
    return await get(client, ctx, "decider")


async def nudges(ctx: Ctx) -> list:
    from oracle.review.models import Notification

    async with tenant_session(ctx.tenant_id) as s:
        return list(
            await s.scalars(
                select(Notification)
                .where(Notification.kind == "review_reminder")
                .order_by(Notification.created_at)
            )
        )


async def remind(client, ctx: Ctx, who: str):
    return await client.post(f"{URL}/guided-setup/remind", headers=ctx.as_(who))


async def test_remind_per_role(client):
    from oracle.models import AuditEvent
    from oracle.roadmap.models import ProductTrack

    ctx = await world(client)
    async with tenant_session(ctx.tenant_id) as s:
        lead = User(email="lead@example.com", name="Lee Track", password_hash="x",
                    role="approver")  # fmt: skip
        s.add(lead)
        await s.flush()
        doc = await s.scalar(select(Document).where(Document.slug == "guided-setup"))
        s.add(ProductTrack(prd_document_id=doc.id, title="Setup", owner_id=lead.id))
        await s.commit()
        ctx.users["lead"] = lead
    view = await in_review(client, ctx)
    d = view["draft"]
    assert d["status"] == "submitted"
    assert [p["name"] for p in d["waiting_on"]] == ["Ann Prover"]
    assert d["can_remind"] is True and d["reminded_at"] is None
    for who in ("approver", "commenter", "viewer"):
        seen = (await get(client, ctx, who))["draft"]
        assert seen is None or seen["can_remind"] is False, who
        r = await remind(client, ctx, who)
        assert r.status_code == 403, (who, r.text)
    assert (await get(client, ctx, "lead"))["draft"]["can_remind"] is True
    assert (await get(client, ctx, "owner"))["draft"]["can_remind"] is True
    assert await nudges(ctx) == []

    r = await remind(client, ctx, "decider")
    assert r.status_code == 200, r.text
    body = r.json()
    assert [p["name"] for p in body["reminded"]] == ["Ann Prover"] and body["reminded_at"]
    [n] = await nudges(ctx)
    assert n.user_id == ctx.users["approver"].id
    assert n.title == "Dee Cider is waiting for your review of Guided setup"
    assert n.document_id == uuid.UUID(view["document"]["id"])
    assert n.data["href"] == "/simple/one-pagers/guided-setup"
    assert n.data["draft_id"] == d["id"] and "Version 2" in n.data["waits"]
    async with tenant_session(ctx.tenant_id) as s:
        ev = await s.scalar(select(AuditEvent).where(AuditEvent.action == "simple_draft.reminded"))
        assert ev is not None and ev.data["reviewer_ids"] == [str(ctx.users["approver"].id)]


async def test_remind_at_most_once_a_day_per_reviewer(client, monkeypatch):
    from datetime import timedelta

    ctx = await world(client)
    await in_review(client, ctx)
    assert (await remind(client, ctx, "decider")).status_code == 200
    again = await remind(client, ctx, "owner")
    assert again.status_code == 409, again.text
    assert len(await nudges(ctx)) == 1
    d = (await get(client, ctx, "owner"))["draft"]
    assert d["reminded_at"] is not None and d["can_remind"] is False

    # A reviewer added to the waiting list since is still due.
    async with tenant_session(ctx.tenant_id) as s:
        draft = await s.scalar(select(SimpleDraft))
        draft.waiting_on = [ctx.users["approver"].id, ctx.users["owner"].id]
        await s.commit()
    assert (await get(client, ctx, "decider"))["draft"]["can_remind"] is True
    r = await remind(client, ctx, "decider")
    assert r.status_code == 200 and [p["id"] for p in r.json()["reminded"]] == [
        str(ctx.users["owner"].id)
    ]
    assert len(await nudges(ctx)) == 2

    # A day later, both are due again.
    monkeypatch.setattr(company_time, "now", lambda: NOW + timedelta(hours=24, minutes=1))
    assert (await get(client, ctx, "decider"))["draft"]["can_remind"] is True
    r = await remind(client, ctx, "decider")
    assert r.status_code == 200 and len(r.json()["reminded"]) == 2
    assert len(await nudges(ctx)) == 4


async def test_remind_needs_a_submitted_draft(client):
    ctx = await world(client)
    view = await get(client, ctx, "decider")
    r = await edit(client, ctx, "decider", view, "bets-2", "Invite suggestions from contacts")
    assert r.status_code == 201, r.text
    d = (await get(client, ctx, "decider"))["draft"]
    assert d["status"] == "working" and d["can_remind"] is False
    r = await remind(client, ctx, "decider")
    assert r.status_code == 409, r.text
    assert await nudges(ctx) == []
