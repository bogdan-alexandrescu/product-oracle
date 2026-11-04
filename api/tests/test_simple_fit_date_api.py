"""Bring a date in, through the API (oracle.simple.fit_date_router), on an approved PRD.

Test cards (protects / fails_when / no_claim):

- test_answer_reads_the_approved_plan: protects=the answer names the goal, the target, the
  date on today's plan and the team (from the PRD's team line), ranks the changes, locks the
  PRD's guardrail feature and says when no set reaches the target; fails_when=a locked item
  is offered or the team is not the PRD's; no_claim=the ranking rules (test_simple_fit_date).
- test_live_date_of_a_picked_set: protects=the live route answers the date of the picks
  from the capacity queue; fails_when=a pick does not move it.
- test_approve_makes_the_next_version_live: protects=approving the picks on an approved
  PRD writes its next version (the re-plan, the new target when none reaches it), approved
  at once, and the answer then reads that version; sliced items need a new estimate;
  fails_when=the approved version is edited in place, or the next answer still reads the
  old dates; no_claim=the roadmap's Simple draft (prd_roadmap's own tests).
- test_viewer_cannot_draft_or_approve: protects=only approvers draft and approve.
- test_approve_makes_the_roadmap_follow (review blocker): protects=approving the re-plan
  writes the roadmap's next version with the PRD's items at their re-planned dates, approved
  by the roadmap's decider, so the board, the Gantt, Priorities and Home read them;
  fails_when=only the PRD's version changes and the roadmap keeps the old dates.
- test_hard_case_says_what_an_engineer_does (review): protects=when no set reaches the
  target the answer says what one more engineer, counted after a 3-week start, does to the
  best date; fails_when=the hard case gives no reason more people do not help.
- test_draft_claims_no_run (review): protects=the draft, computed from the capacity queue,
  claims no run time or cost; fails_when=a fixed "40 seconds, $0.20" is sent.
"""

import re

import pytest
from sqlalchemy import select

from oracle.docs.models import Document, DocumentVersion
from oracle.roadmap.models import RoadmapItem
from oracle.tenancy import tenant_session
from tests.baseline_helpers import make_ctx
from tests.test_simple_plan_api import FIXTURE, clock, seed  # noqa: F401

BODY = "---\ntitle: Guided setup\nkind: prd\n---\n\n" + re.sub(
    r"^(#+ )(.+)$",
    lambda m: f"{m[1]}{m[2]} {{#{m[2].lower().replace(' ', '-')}}}",
    FIXTURE.replace(
        "| F-05 | Usage digest |",
        "| F-06 | Bulk invite | M2 | 4 | Activation | then |\n| F-05 | Usage digest |",
    )
    + "\nTeam: 2 engineers at 50% focus.\n\n## Must keep\n\n"
    + "- F-01 Setup checklist: Guardrail: setup never skips the consent step.\n",
    flags=re.M,
)
URL = "/v1/simple/prds/guided-setup/fit-date"


async def test_answer_reads_the_approved_plan(client):
    ctx = await make_ctx()
    await seed(ctx, BODY)
    r = await client.get(URL, params={"milestone": "M2"}, headers=ctx.as_("viewer"))
    assert r.status_code == 200, r.text
    a = r.json()
    assert a["goal"] == "Activation" and a["milestone_name"] == "M2 Scale volume"
    assert a["target"] == "2026-12-25"
    assert a["team"] == {"engineers": 2, "focus": 0.5}
    assert a["today"] > a["target"] and a["late_days"] > 0
    assert a["changes"][0]["id"] == "F-03b" and "F-06" in [c["id"] for c in a["changes"]]
    assert {c["lever"] for c in a["changes"]} >= {"ungate", "slice", "capacity"}
    assert all(c["id"] != "F-01" for c in a["changes"])
    f06 = next(c for c in a["changes"] if c["id"] == "F-06")
    assert f06["effect"] == "4 person-weeks down to 2"
    assert [x["item"] for x in a["locked"]] == []  # F-01 is M1's, not the asked milestone's
    m1 = await client.get(URL, params={"milestone": "M1"}, headers=ctx.as_("viewer"))
    assert [x["item"] for x in m1.json()["locked"]] == ["Setup checklist"]
    assert a["reachable"] is (a["best_date"] <= a["target"])
    listed = await client.get("/v1/simple/fit-date", headers=ctx.as_("viewer"))
    assert listed.status_code == 200, listed.text
    assert {(g["milestone"], g["late_days"] > 0) for g in listed.json()} >= {("M2", True)}


async def test_live_date_of_a_picked_set(client):
    ctx = await make_ctx()
    await seed(ctx, BODY)
    h = ctx.as_("viewer")
    none = (
        await client.post(f"{URL}/live", json={"milestone": "M2", "picks": []}, headers=h)
    ).json()
    one = await client.post(f"{URL}/live", json={"milestone": "M2", "picks": ["F-06"]}, headers=h)
    assert one.status_code == 200, one.text
    assert one.json()["date"] < none["date"]
    assert one.json()["pw_saved"] == 2


async def test_approve_makes_the_next_version_live(client):
    ctx = await make_ctx()
    ids = await seed(ctx, BODY)
    h = ctx.as_("owner")
    picks = {"milestone": "M2", "picks": ["F-03b", "F-06", "focus"]}
    d = await client.post(f"{URL}/draft", json=picks, headers=h)
    assert d.status_code == 200, d.text
    draft = d.json()
    assert draft["prd_version"] == 1 and draft["next_version"] == 2
    assert [e["item"] for e in draft["needs_estimate"]] == ["Bulk invite"]
    assert any(x["what"] == "M2 Scale volume" and x["kind"] == "in" for x in draft["dates"])
    r = await client.post(f"{URL}/approve", json=picks, headers=h)
    assert r.status_code == 200, r.text
    assert r.json()["version"] == 2
    async with tenant_session(ctx.tenant_id) as s:
        q = select(DocumentVersion).where(DocumentVersion.document_id == ids["prd"])
        vs = list(await s.scalars(q.order_by(DocumentVersion.number)))
    assert [v.approved_at is not None for v in vs] == [True, True]
    assert vs[0].markdown == BODY
    assert "## Re-plan" in vs[1].markdown
    again = (await client.get(URL, params={"milestone": "M2"}, headers=h)).json()
    assert again["prd_version"] == 2
    assert again["today"] == draft["date"]
    assert again["target"] == (draft["new_target"] or "2026-12-25")
    assert again["approved"]["version"] == 2 and again["approved"]["by_me"] is True
    assert again["approved"]["date"] == draft["date"] and again["approved"]["was"] > draft["date"]
    assert again["roadmap"]["slug"] == "setup-roadmap"


@pytest.mark.parametrize("route", ["draft", "approve"])
async def test_viewer_cannot_draft_or_approve(client, route):
    ctx = await make_ctx()
    await seed(ctx, BODY)
    r = await client.post(f"{URL}/{route}", json={"milestone": "M2", "picks": ["F-06"]},
                          headers=ctx.as_("viewer"))  # fmt: skip
    assert r.status_code == 403, r.text


async def test_approve_makes_the_roadmap_follow(client):
    ctx = await make_ctx()
    await seed(ctx, BODY, items=("f-06", "f-03"))
    h = ctx.as_("decider")
    picks = {"milestone": "M2", "picks": ["F-03b", "F-06", "focus"]}
    r = await client.post(f"{URL}/approve", json=picks, headers=h)
    assert r.status_code == 200, r.text
    assert r.json()["roadmap_version"] == 2
    again = (await client.get(URL, params={"milestone": "M2"}, headers=h)).json()
    planned = {i["id"]: i["date"] for lane in again["lanes"] for i in lane["items"]}
    async with tenant_session(ctx.tenant_id) as s:
        rm = await s.scalar(select(Document).where(Document.slug == "setup-roadmap"))
        vs = list(await s.scalars(select(DocumentVersion).where(
            DocumentVersion.document_id == rm.id).order_by(DocumentVersion.number)))  # fmt: skip
        assert [v.approved_at is not None for v in vs] == [True, True]
        rows = {r.item_key: r for r in await s.scalars(
            select(RoadmapItem).where(RoadmapItem.roadmap_version_id == vs[1].id))}  # fmt: skip
    assert set(rows) == {"f-06", "f-03"}
    assert rows["f-06"].end_date.isoformat() == planned["F-06"]
    assert rows["f-03"].end_date.isoformat() == max(
        d for k, d in planned.items() if k.startswith("F-03") and d
    )


async def test_draft_claims_no_run(client):
    ctx = await make_ctx()
    await seed(ctx, BODY)
    d = await client.post(f"{URL}/draft", json={"milestone": "M2", "picks": ["F-06"]},
                          headers=ctx.as_("owner"))  # fmt: skip
    assert d.status_code == 200, d.text
    assert "run_seconds" not in d.json() and "run_usd" not in d.json()
    a = await client.get(URL, params={"milestone": "M2"}, headers=ctx.as_("owner"))
    assert "run_seconds" not in a.json() and "run_usd" not in a.json()


async def test_hard_case_says_what_an_engineer_does(client):
    ctx = await make_ctx()
    await seed(ctx, BODY)
    a = (await client.get(URL, params={"milestone": "M2"}, headers=ctx.as_("owner"))).json()
    assert a["reachable"] is False
    hire = a["hire"]
    assert hire["start_weeks"] == 3
    assert hire["date"] <= a["best_date"]
    assert hire["reaches"] is (hire["date"] <= a["target"])
