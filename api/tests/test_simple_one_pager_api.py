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
  (built_by oracle), lines naming another block's sections are dropped, a block left
  short keeps the quick read; fails_when=a line points at a section it does not rest on;
  no_claim=the prompt's quality.
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
        assert (await one_pager.run_job(s, job, ask))["built"] is True
        await s.commit()
    view = await get(client, ctx)
    assert view["built_by"] == "oracle"
    assert [x["text"] for x in block(view, "bets")["lines"]] == ["Checklist", "Invites", "Sample"]
    # A block left short of its minimum keeps the quick read.
    answer["blocks"][1]["lines"] = answer["blocks"][1]["lines"][:1]
    async with tenant_session(ctx.tenant_id) as s:
        job = await s.scalar(select(LlmJob).where(LlmJob.kind == "one_pager"))
        assert (await one_pager.run_job(s, job, ask))["built"] is False


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
