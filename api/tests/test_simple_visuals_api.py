"""Simple S10 (#723, D26): visual proposals (oracle.simple.visuals, ``/v1/simple/visuals``).
Against Postgres. The invented PRD of the one-pager tests (imported over REST, approved,
with a decider) and an invented roadmap; the ``simple_visual`` job runs with a fake ``ask``,
never a live model.

Test cards (protects / fails_when / no_claim):

- test_drafted_with_each_proposal_kind: protects=Oracle drafts the visual WITH the
  proposal: a one-pager bet's edit (a change), an outcome change on a roadmap item, the
  bets of a built one-pager (one_pager_line), a roadmap feature asked for by its decider,
  and S7/S9's subjects through ``request_visual``; once drawn, the one-pager note, the
  bet line, the roadmap item and the priorities proposal carry the flow that train T
  served as null; fails_when=a proposal kind queues no job, a job draws no version, or a
  card's ``flow`` stays null after the drawing; no_claim=the model's drawing quality.
- test_sanitising_refuses_script: protects=an answer whose SVG or wireframe would run code
  (a script, an on* handler, a javascript: link) draws nothing; Oracle's own drawing is
  static (no script, no handler) and keeps only annotations whose target is in the drawing
  and whose section is the PRD's; fails_when=a script reaches a stored version or an
  annotation points at nothing; no_claim=the sanitiser's full allowlist (test_specs_*).
- test_revise_adds_a_version: protects=comments on the newest drawing, then Revise, make
  Oracle draw version 2 from the open comments (they are in the job's payload and marked
  addressed by 2); the card shows version 2, version 1 stays readable; Revise with nothing
  to revise from is 409; fails_when=a revise overwrites the drawing or loses a comment;
  no_claim=how well the model follows a comment.
- test_role_rules: protects=viewers read, commenters (and approvers) comment, only who
  changes the subject's document directly (an owner, its decider) revises or asks for a
  drawing; a viewer's comment and a commenter's revise are 403; a restricted reader does
  not see a visual of a document it cannot see; fails_when=a role does more than its
  rule; no_claim=the web's buttons (the Playwright spec).
- test_draft_change_visual_follows_the_draft: protects=the visual of a change applied
  into a working draft is read by who sees the draft (its author, the decider, owners),
  not by a viewer, who reads the published version; fails_when=a viewer reads a draft's
  visual; no_claim=publishing (S3b's tests).
- test_flow_for_contract: protects=the contract other lanes call: ``flow_for`` answers None
  without a drawing and the stored bundle as ``SimpleFlow`` after; ``request_visual``
  queues one job per subject (twice is once) and none for a switched-off document;
  fails_when=a second request queues a second job or the switch is ignored;
  no_claim=the other lanes' screens.
"""

import uuid

import pytest
from sqlalchemy import select

from oracle import company_time
from oracle.jobs.models import LlmJob
from oracle.simple import one_pager, visuals
from oracle.simple.models import SimpleVisual, SimpleVisualVersion
from oracle.tenancy import tenant_session
from tests.test_simple_one_pager_api import edit, get, line, world
from tests.test_simple_roadmap_api import NOW, Seed

URL = "/v1/simple/visuals"
CHANGES = "/v1/simple/changes"

ANSWER = {
    "title": "Invite a teammate from the checklist",
    "goal": "Teammate invited in week one",
    "steps": [
        {"id": "s1", "label": "Open the home page", "feature": "Progress meter",
         "change": "same", "section_key": "build"},
        {"id": "s2", "label": "See the next step", "feature": "Setup checklist",
         "change": "new", "section_key": "build"},
        {"id": "s3", "label": "Invite now?", "kind": "decision", "change": "new"},
        {"id": "s4", "label": "Invite a teammate", "feature": "Invite suggestions",
         "change": "changed"},
    ],
    "screen": {"title": "Home", "regions": ["Header", "Setup checklist", "Invite suggestions"]},
    "annotations": [
        {"target": "s2", "note": "The checklist shows the next step", "section_key": "build",
         "requirement": "R1"},
        {"target": "r2", "note": "The checklist region", "section_key": "build"},
        {"target": "nowhere", "note": "Points at nothing"},
        {"target": "s4", "note": "Names a section the PRD lacks", "section_key": "nope"},
    ],
}  # fmt: skip


@pytest.fixture(autouse=True)
def clock(monkeypatch):
    monkeypatch.setattr(company_time, "now", lambda: NOW)


async def jobs(ctx) -> list[LlmJob]:
    async with tenant_session(ctx.tenant_id) as s:
        return list(
            await s.scalars(
                select(LlmJob).where(LlmJob.kind == "simple_visual").order_by(LlmJob.created_at)
            )
        )


async def run_visual_jobs(ctx, answer=ANSWER, seen: list | None = None) -> list[dict]:
    """Run every queued visual job with a fake model answer, as the worker would."""

    async def ask(kind, payload):
        assert kind == "simple_visual"
        if seen is not None:
            seen.append(payload)
        return answer

    outs = []
    async with tenant_session(ctx.tenant_id) as s:
        queued = list(
            await s.scalars(
                select(LlmJob).where(LlmJob.kind == "simple_visual", LlmJob.status == "queued")
            )
        )
        for job in queued:
            out = await visuals.run_job(s, job, ask)
            job.status, job.output = "succeeded", out
            outs.append(out)
        await s.commit()
    return outs


async def visual(client, ctx, who, kind, sid) -> dict:
    r = await client.get(f"{URL}/{kind}/{sid}", headers=ctx.as_(who))
    assert r.status_code == 200, r.text
    return r.json()


async def roadmap_world(ctx):
    async with tenant_session(ctx.tenant_id) as s:
        seed = Seed(s)
        _, pv, rm, rv = await seed.roadmap("onboarding")
        item = await seed.item(rv, pv, "checklist", outcome="Admins finish setup")
        await s.commit()
        return rm, item


async def test_drafted_with_each_proposal_kind(client):
    ctx = await world(client)
    # A one-pager bet reworded (a commenter's proposal): its visual is queued with it.
    view = await get(client, ctx, "commenter")
    r = await edit(client, ctx, "commenter", view, "bets-1", "A setup checklist with invites")
    assert r.status_code == 201, r.text
    change_id = r.json()["change"]["id"]
    assert len(await jobs(ctx)) == 1
    # A non-bet line is no feature: no visual.
    r = await edit(client, ctx, "commenter", view, "risks-1", "Calendar access scares admins")
    assert r.status_code == 201, r.text
    assert len(await jobs(ctx)) == 1
    assert (await run_visual_jobs(ctx))[0]["drawn"] is True
    out = await visual(client, ctx, "decider", "change", change_id)
    assert out["flow"]["version"] == 1 and out["flow"]["steps"][1] == "See the next step"
    assert out["flow"]["svg"].startswith("<svg") and "Home" in out["flow"]["wireframe"]
    note = next(n for n in (await get(client, ctx, "decider"))["notes"] if n["line_id"] == "bets-1")
    assert note["flow"]["title"] == ANSWER["title"] and note["flow"]["screen"] == "Home"

    # The one-pager job draws each bet's visual with the page.
    answer = {"blocks": [
        {"key": "problem", "lines": [{"text": "Admins stall.", "source_keys": ["problem"]}]},
        {"key": "bets", "lines": [{"text": t, "source_keys": ["build"]}
                                  for t in ("Checklist", "Invites", "Sample")]},
        {"key": "outcomes", "lines": [
            {"text": "Invites up", "source_keys": ["outcomes"],
             "metric": {"name": "Invited", "from": "48%", "to": "65%"}},
            {"text": "Setup", "source_keys": ["outcomes"],
             "metric": {"name": "Setup", "from": "30%", "to": "50%"}}]},
        {"key": "not_doing", "lines": [{"text": "No SSO", "source_keys": ["not-doing"]}]},
        {"key": "risks", "lines": [{"text": "Calendar", "source_keys": ["risks"]}]},
    ]}  # fmt: skip

    async def ask(kind, payload):
        return answer

    # Line ids are positions: the job waits while a draft holds them; drop the proposals.
    async with tenant_session(ctx.tenant_id) as s:
        from oracle.simple.models import SimpleChange

        for c in await s.scalars(select(SimpleChange)):
            c.status = "declined"
        job = await s.scalar(select(LlmJob).where(LlmJob.kind == "one_pager"))
        assert (await one_pager.run_job(s, job, ask))["built"] is True
        await s.commit()
    assert len([j for j in await jobs(ctx) if j.status == "queued"]) == 3
    await run_visual_jobs(ctx)
    page = await get(client, ctx, "viewer")
    bet = line(page, "bets-2")
    assert bet["flow"]["title"] == ANSWER["title"] and bet["flow_subject"]
    assert line(page, "problem-1").get("flow") is None

    # A roadmap item's outcome changed (a feature reshaped) comes with a visual.
    rm, item = await roadmap_world(ctx)
    body = {"op": "edit_outcome", "target": {"item_id": str(item.id)},
            "before": {"outcome": "Admins finish setup"},
            "after": {"outcome": "Admins invite a teammate on day one"}}  # fmt: skip
    r = await client.post(CHANGES, json=body, headers=ctx.as_("commenter"))
    assert r.status_code == 201, r.text
    assert r.json()["change"]["status"] == "proposed"
    outcome_change = r.json()["change"]["id"]
    # A roadmap feature with no visual: its decider (an owner here) asks Oracle to draw it.
    r = await client.post(f"{URL}/feature/{item.id}/request", json={"brief": "The checklist"},
                          headers=ctx.as_("owner"))  # fmt: skip
    assert r.status_code == 202, r.text and r.json()["pending"] is True
    await run_visual_jobs(ctx)
    assert (await visual(client, ctx, "owner", "change", outcome_change))["flow"] is not None
    rmap = (await client.get("/v1/simple/roadmap", headers=ctx.as_("viewer"))).json()
    shown = next(i for i in rmap["items"] if i["id"] == str(item.id))
    assert shown["flow"]["title"] == ANSWER["title"] and shown["flow"]["nodes"][2]["kind"] == (
        "decision"
    )
    pri = (await client.get("/v1/simple/priorities", headers=ctx.as_("owner"))).json()
    prop = [p for p in pri["proposals"] if p["change_id"] == outcome_change]
    assert not prop or prop[0]["flow"] is not None

    # S7's suggestions and S9's chat cards come through the hook (request_visual).
    sid = uuid.uuid4()
    async with tenant_session(ctx.tenant_id) as s:
        await visuals.request_visual(s, None, "chat_card", sid, "Add a guided tour",
                                     document_id=rm.id)  # fmt: skip
        await visuals.request_visual(s, None, "suggestion", uuid.uuid4(), "A sample project")
        await s.commit()
    assert len(await run_visual_jobs(ctx)) == 2
    assert (await visual(client, ctx, "viewer", "chat_card", sid))["flow"]["version"] == 1


async def test_sanitising_refuses_script(client):
    ctx = await world(client)
    sid = uuid.uuid4()
    async with tenant_session(ctx.tenant_id) as s:
        await visuals.request_visual(s, None, "suggestion", sid, "A new flow")
        await s.commit()
    bad_svg = {**ANSWER, "flow_svg": '<svg xmlns="http://www.w3.org/2000/svg"><script>'
               "alert(1)</script><rect id=\"s1\" width=\"5\" height=\"5\"/></svg>"}  # fmt: skip
    bad_html = {**ANSWER, "wireframe_html": '<div onclick="steal()">Header</div>'
                '<a href="javascript:alert(1)">x</a>'}  # fmt: skip
    for answer in (bad_svg, bad_html):
        (out,) = await run_visual_jobs(ctx, answer)
        assert out["drawn"] is False and out["problems"], out
        async with tenant_session(ctx.tenant_id) as s:
            assert not list(await s.scalars(select(SimpleVisualVersion)))
            job = await s.scalar(select(LlmJob).where(LlmJob.kind == "simple_visual"))
            job.status = "queued"
            await s.commit()
    (out,) = await run_visual_jobs(ctx)
    assert out["drawn"] is True
    flow = (await visual(client, ctx, "owner", "suggestion", sid))["flow"]
    for content in (flow["svg"], flow["wireframe"]):
        low = content.lower()
        assert "<script" not in low and "onclick" not in low and "javascript:" not in low
    # Only the annotations on something drawn stay (numbered 1..n); the unknown section
    # is not checked here (a suggestion has no PRD), so it stays as written.
    assert [(a["n"], a["target"]) for a in flow["annotations"]] == [
        (1, "s2"), (2, "r2"), (3, "s4"),
    ]  # fmt: skip
    # With a PRD to check against, a section the PRD lacks is dropped from the annotation.
    checked = visuals.check_answer(ANSWER, {"build", "problem"})
    assert [a["section_key"] for a in checked.annotations] == ["build", "build", None]
    assert any("nowhere" in r for r in checked.removed)


async def test_revise_adds_a_version(client):
    ctx = await world(client)
    view = await get(client, ctx, "commenter")
    r = await edit(client, ctx, "commenter", view, "bets-1", "A setup checklist with invites")
    cid = r.json()["change"]["id"]
    await run_visual_jobs(ctx)
    path = f"{URL}/change/{cid}"
    r = await client.post(f"{path}/revise", json={}, headers=ctx.as_("decider"))
    assert r.status_code == 409, r.text  # nothing to revise from yet
    r = await client.post(f"{path}/comments", json={"body": "Show the skip path", "annotation": 1},
                          headers=ctx.as_("commenter"))  # fmt: skip
    assert r.status_code == 201, r.text
    r = await client.post(f"{path}/comments", json={"body": "x", "annotation": 9},
                          headers=ctx.as_("commenter"))  # fmt: skip
    assert r.status_code == 422, r.text
    r = await client.post(f"{path}/revise", json={"note": "Keep it short"},
                          headers=ctx.as_("decider"))  # fmt: skip
    assert r.status_code == 202, r.text and r.json()["pending"] is True
    revised = {**ANSWER, "title": "Invite a teammate, or skip"}
    seen: list = []
    (out,) = await run_visual_jobs(ctx, revised, seen)
    assert out == {"drawn": True, "version": 2, "removed": out["removed"]}
    assert seen[0]["mode"] == "revise" and seen[0]["note"] == "Keep it short"
    assert seen[0]["comments"] == [{"annotation": 1, "body": "Show the skip path"}]
    got = await visual(client, ctx, "commenter", "change", cid)
    assert got["flow"]["version"] == 2 and got["flow"]["title"] == "Invite a teammate, or skip"
    assert [v["number"] for v in got["versions"]] == [2, 1]
    assert got["comments"][0]["addressed_in"] == 2
    r = await client.get(f"{path}/versions/1", headers=ctx.as_("commenter"))
    assert r.status_code == 200 and r.json()["title"] == ANSWER["title"]


@pytest.mark.parametrize(
    "role,comment,revise",
    [
        ("viewer", 403, 403),
        ("commenter", 201, 403),
        ("approver", 201, 403),
        ("decider", 201, 202),
        ("owner", 201, 202),
    ],
)
async def test_role_rules(client, role, comment, revise):
    ctx = await world(client)
    view = await get(client, ctx, "commenter")
    r = await edit(client, ctx, "commenter", view, "bets-1", "A setup checklist with invites")
    cid = r.json()["change"]["id"]
    await run_visual_jobs(ctx)
    path = f"{URL}/change/{cid}"
    got = await client.get(path, headers=ctx.as_(role))
    # A proposal's visual: who may read the proposal (its author, who decides it, owners).
    if role in ("approver", "viewer"):
        assert got.status_code == 404
        # The published bet's visual is for every reader.
        bet = line(await get(client, ctx, role), "bets-2")
        sid = bet["flow_subject"]
        async with tenant_session(ctx.tenant_id) as s:
            doc_id = (await s.scalar(select(SimpleVisual))).document_id
            await visuals.request_visual(s, None, "one_pager_line", sid, bet["text"],
                                         document_id=doc_id)  # fmt: skip
            await s.commit()
        await run_visual_jobs(ctx)
        path = f"{URL}/one_pager_line/{sid}"
        got = await client.get(path, headers=ctx.as_(role))
    assert got.status_code == 200, got.text
    assert got.json()["can_comment"] is (comment == 201)
    assert got.json()["can_revise"] is (revise == 202)
    r = await client.post(f"{path}/comments", json={"body": "Add the skip path"},
                          headers=ctx.as_(role))  # fmt: skip
    assert r.status_code == comment, r.text
    if comment != 201:
        async with tenant_session(ctx.tenant_id) as s:
            v = await s.scalar(select(SimpleVisual).where(SimpleVisual.subject_kind != "change"))
            r2 = await client.post(f"{path}/comments", json={"body": "seed"},
                                   headers=ctx.as_("commenter"))  # fmt: skip
            assert r2.status_code == 201 and v is not None
    r = await client.post(f"{path}/revise", json={}, headers=ctx.as_(role))
    assert r.status_code == revise, r.text


async def test_flow_for_contract(client):
    ctx = await world(client)
    rm, item = await roadmap_world(ctx)
    async with tenant_session(ctx.tenant_id) as s:
        assert await visuals.flow_for(s, "feature", item.id) is None
        await visuals.request_visual(s, None, "feature", item.id, "The checklist")
        await visuals.request_visual(s, None, "feature", item.id, "The checklist again")
        await s.commit()
    assert len(await jobs(ctx)) == 1
    await run_visual_jobs(ctx)
    async with tenant_session(ctx.tenant_id) as s:
        flow = await visuals.flow_for(s, "feature", item.id)
        assert flow is not None and flow.screen.title == "Home" and flow.subject_id == item.id
        # Drawn already: a new request queues nothing.
        await visuals.request_visual(s, None, "feature", item.id, "Again")
        # A document whose "Draw visuals" switch is off queues nothing.
        from oracle.docs.models import Document

        doc = await s.get(Document, rm.id)
        doc.disabled_llm_jobs = ["simple_visual"]
        other = uuid.uuid4()
        await visuals.request_visual(s, None, "chat_card", other, "x", document_id=rm.id)
        await s.commit()
    assert len(await jobs(ctx)) == 1
    with pytest.raises(visuals.VisualError):
        async with tenant_session(ctx.tenant_id) as s:
            await visuals.request_visual(s, None, "nonsense", uuid.uuid4(), "x")


async def test_draft_change_visual_follows_the_draft(client):
    ctx = await world(client)
    view = await get(client, ctx, "decider")
    r = await edit(client, ctx, "decider", view, "bets-1", "A setup checklist with invites")
    assert r.status_code == 201 and r.json()["change"]["status"] == "applied", r.text
    cid = r.json()["change"]["id"]
    await run_visual_jobs(ctx)
    assert (await visual(client, ctx, "decider", "change", cid))["flow"]["version"] == 1
    assert (await visual(client, ctx, "owner", "change", cid))["flow"] is not None
    r = await client.get(f"{URL}/change/{cid}", headers=ctx.as_("viewer"))
    assert r.status_code == 404, r.text
