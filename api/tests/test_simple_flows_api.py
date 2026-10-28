"""Simple flows (the owner's 2026-10-28 picks: a live thumbnail, an opened view, a
full-screen viewer and a storyboard): what the one Flow component reads from
``/v1/simple/visuals``. Against Postgres, with the invented world of the S10 tests; the
``simple_visual`` job runs with a fake ``ask``, never a live model.

Test cards (protects / fails_when / no_claim):

- test_steps_carry_who_and_yes_no: protects=each drawn step keeps who does it (``actor``)
  and a decision keeps what its Yes and its No lead to, for the storyboard's cards; a step
  that is no decision carries no Yes/No even when the model sends them; the job runs with
  the simple_visual.v2 prompt; fails_when=the actor or a decision's Yes/No is dropped, or a
  plain step shows a Yes/No; no_claim=the model's wording.
- test_drawing_state_names_stage_and_start: protects=while Oracle draws, the visual says
  when it was asked for (``started_at``), how far it got (``stage`` 0 queued, 1 running)
  and the subject with its code (``subject_name``) for "Read F-06 ... → Draw the steps →
  Draw the screen"; once drawn these clear; fails_when=a drawing visual lacks its start or
  stage, or the stage does not move when the job runs; no_claim=the web's bar (the
  Playwright spec).
- test_roles_read_the_flow_fields: protects=every role (owner, decider, approver,
  commenter, viewer) reads the new fields of a published flow; only who changes the
  subject asks for a drawing (owner, decider: 202; approver, commenter, viewer: 403);
  fails_when=a reader is refused the flow or a non-changer starts a drawing;
  no_claim=comment and revise rules (test_simple_visuals_api.test_role_rules).
"""

import uuid

import pytest
from sqlalchemy import select

from oracle import company_time
from oracle.jobs import prompting
from oracle.jobs.models import LlmJob
from oracle.simple import visuals
from oracle.simple.models import SimpleVisual
from oracle.tenancy import tenant_session
from tests.test_simple_one_pager_api import get, line, world
from tests.test_simple_roadmap_api import NOW
from tests.test_simple_visuals_api import ANSWER, jobs, roadmap_world, run_visual_jobs, visual

URL = "/v1/simple/visuals"

WHO = {
    **ANSWER,
    "steps": [
        {"id": "s1", "label": "Open the plan", "actor": "User", "change": "same",
         "yes": "Ignored on a plain step"},
        {"id": "s2", "label": "Is the user signed in?", "kind": "decision", "actor": "App",
         "yes": "The plan opens.", "no": "The sign-in page opens.", "change": "same"},
        {"id": "s3", "label": "Approve the new plan", "actor": "Admin", "change": "new"},
    ],
}  # fmt: skip


@pytest.fixture(autouse=True)
def clock(monkeypatch):
    monkeypatch.setattr(company_time, "now", lambda: NOW)


async def test_steps_carry_who_and_yes_no(client):
    assert prompting.CURRENT["simple_visual"] == "simple_visual.v2"
    assert '"actor"' in prompting.load("simple_visual.v2")
    ctx = await world(client)
    _, item = await roadmap_world(ctx)
    r = await client.post(f"{URL}/feature/{item.id}/request", json={"brief": ""},
                          headers=ctx.as_("owner"))  # fmt: skip
    assert r.status_code == 202, r.text
    await run_visual_jobs(ctx, answer=WHO)
    nodes = (await visual(client, ctx, "viewer", "feature", item.id))["flow"]["nodes"]
    assert [n["actor"] for n in nodes] == ["User", "App", "Admin"]
    assert nodes[0]["yes"] is None and nodes[0]["no"] is None
    assert nodes[1]["kind"] == "decision"
    assert (nodes[1]["yes"], nodes[1]["no"]) == ("The plan opens.", "The sign-in page opens.")
    assert nodes[2]["yes"] is None


async def test_drawing_state_names_stage_and_start(client):
    ctx = await world(client)
    _, item = await roadmap_world(ctx)
    r = await client.post(f"{URL}/feature/{item.id}/request", json={"brief": ""},
                          headers=ctx.as_("owner"))  # fmt: skip
    assert r.status_code == 202, r.text
    out = await visual(client, ctx, "owner", "feature", item.id)
    assert out["pending"] is True and out["stage"] == 0
    assert out["started_at"] is not None
    assert item.title in out["subject_name"]
    async with tenant_session(ctx.tenant_id) as s:
        job = await s.scalar(select(LlmJob).where(LlmJob.kind == "simple_visual"))
        job.status = "running"
        await s.commit()
    assert (await visual(client, ctx, "owner", "feature", item.id))["stage"] == 1
    async with tenant_session(ctx.tenant_id) as s:
        job = await s.scalar(select(LlmJob).where(LlmJob.kind == "simple_visual"))
        job.status = "queued"
        await s.commit()
    await run_visual_jobs(ctx, answer=WHO)
    out = await visual(client, ctx, "owner", "feature", item.id)
    assert out["pending"] is False and out["started_at"] is None and out["stage"] == 0
    assert out["flow"]["made_at"] is not None and len(await jobs(ctx)) == 1


@pytest.mark.parametrize(
    "role,ask",
    [("owner", 202), ("decider", 202), ("approver", 403), ("commenter", 403), ("viewer", 403)],
)
async def test_roles_read_the_flow_fields(client, role, ask):
    ctx = await world(client)
    page = await get(client, ctx, role)
    bet = line(page, "bets-2")
    sid = bet["flow_subject"]
    doc_id = uuid.UUID(page["document"]["id"])
    async with tenant_session(ctx.tenant_id) as s:
        await visuals.request_visual(s, None, "one_pager_line", sid, bet["text"],
                                     document_id=doc_id)  # fmt: skip
        await s.commit()
    await run_visual_jobs(ctx, answer=WHO)
    out = await visual(client, ctx, role, "one_pager_line", sid)
    assert out["flow"]["nodes"][1]["no"] == "The sign-in page opens."
    other = line(page, "bets-3")["flow_subject"]
    r = await client.post(f"{URL}/one_pager_line/{other}/request",
                          json={"brief": "", "document_id": str(doc_id)},
                          headers=ctx.as_(role))  # fmt: skip
    assert r.status_code == ask, r.text
    async with tenant_session(ctx.tenant_id) as s:
        asked = await s.scalar(
            select(SimpleVisual).where(SimpleVisual.subject_id == uuid.UUID(other))
        )
    assert (asked is not None) is (ask == 202)
