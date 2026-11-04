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
- test_roadmap_waits_on_its_decider (review 2): protects=when the approver does not decide
  the roadmap, the re-plan's roadmap draft is still submitted as its next version, in review
  with its decider, and the answer says it is not live and who decides it;
  fails_when=the draft is left unsubmitted or the version is called live.
- test_approve_refuses_a_foreign_draft_edit (review 2): protects=approving never publishes
  someone else's unsubmitted edits in the roadmap's working draft: it refuses, naming them,
  and nothing is written; fails_when=the PRD or the roadmap gets a new version.
- test_resized_items_wait_on_an_estimate (review 2): protects=when the roadmap follows, an
  item the re-plan sliced or split is marked estimate pending on the roadmap's new version
  and its owner is asked for a new estimate (an Inbox notification); the board's item says
  so; fails_when=the resized item's date reads as settled or nobody is asked.
- test_draft_claims_no_run (review): protects=the draft, computed from the capacity queue,
  claims no run time or cost; fails_when=a fixed "40 seconds, $0.20" is sent.
- test_answer_ties_its_baseline_goal (smaller goal): protects=the answer names the Baseline
  goal the milestone's gate counts toward (id, target, the PRD's target) and whether the
  reader may edit it; fails_when=the answer only has the plan's goal text.
- test_no_baseline_goal_reads_none (smaller goal): protects=no goal by that name reads
  None, so the panel shows no dead button.
- test_smaller_goal_reaches_the_date (smaller goal): protects=after the goal's target is
  lowered through the Baseline edit, the answer and the live date count the goal's own work
  in proportion and the hard case reaches its date; fails_when=the answer ignores the goal.
"""

import re

import pytest
from sqlalchemy import func, select

from oracle.auth.models import User
from oracle.docs.models import Document, DocumentVersion
from oracle.roadmap.models import RoadmapItem
from oracle.simple import drafts
from oracle.simple.models import SimpleDraft
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
    await seed(ctx, BODY.replace("| 30 Nov 2026 | 25 Dec 2026 |", "| 30 Nov 2026 | 1 Dec 2026 |"))
    a = (await client.get(URL, params={"milestone": "M2"}, headers=ctx.as_("owner"))).json()
    assert a["reachable"] is False, a
    hire = a["hire"]
    assert hire["start_weeks"] == 3
    assert hire["date"] <= a["best_date"]
    assert hire["reaches"] is (hire["date"] <= a["target"])


async def test_roadmap_waits_on_its_decider(client):
    ctx = await make_ctx()
    await seed(ctx, BODY, items=("f-06", "f-03"))
    async with tenant_session(ctx.tenant_id) as s:
        (await s.get(User, ctx.users["decider"].id)).name = "Dana Decider"
        await s.commit()
    h = ctx.as_("approver")
    picks = {"milestone": "M2", "picks": ["F-03b", "F-06", "focus"]}
    r = await client.post(f"{URL}/approve", json=picks, headers=h)
    assert r.status_code == 200, r.text
    out = r.json()
    assert out["roadmap_version"] == 2 and out["roadmap_live"] is False
    assert out["roadmap_decider"] == "Dana Decider"
    async with tenant_session(ctx.tenant_id) as s:
        rm = await s.scalar(select(Document).where(Document.slug == "setup-roadmap"))
        d = await s.scalar(select(SimpleDraft).where(SimpleDraft.document_id == rm.id))
        assert d.status == "submitted"
        v2 = await s.get(DocumentVersion, d.version_id)
        assert v2.number == 2 and v2.approved_at is None
    a = (await client.get(URL, params={"milestone": "M2"}, headers=h)).json()
    assert a["approved"]["roadmap_version"] == 2
    assert a["approved"]["roadmap_live"] is False
    assert a["approved"]["roadmap_decider"] == "Dana Decider"


async def test_approve_refuses_a_foreign_draft_edit(client):
    ctx = await make_ctx()
    ids = await seed(ctx, BODY, items=("f-06", "f-03"))
    async with tenant_session(ctx.tenant_id) as s:
        rm = await s.scalar(select(Document).where(Document.slug == "setup-roadmap"))
        v1 = await s.scalar(select(DocumentVersion).where(DocumentVersion.document_id == rm.id))
        other = RoadmapItem(roadmap_document_id=rm.id, roadmap_version_id=v1.id,
                            item_key="help-centre", title="Help centre", horizon="next",
                            position=9)  # fmt: skip
        s.add(other)
        rae = User(email="rae@example.com", name="Rae Example", password_hash="x", role="owner")
        s.add(rae)
        await s.flush()
        changed = drafts.overlaid(other, drafts.snapshot(other))
        changed.title = "Help centre, renamed"
        s.add(SimpleDraft(document_id=rm.id, base_version_id=v1.id, status="working",
                          overlay={str(other.id): drafts.snapshot(changed)},
                          created_by=rae.id, participant_ids=[rae.id]))  # fmt: skip
        await s.commit()
    picks = {"milestone": "M2", "picks": ["F-03b", "F-06", "focus"]}
    r = await client.post(f"{URL}/approve", json=picks, headers=ctx.as_("decider"))
    assert r.status_code == 409, r.text
    assert r.json()["detail"] == (
        "Rae Example has unsaved changes in this roadmap's draft; "
        "ask them to submit or discard first."
    )
    async with tenant_session(ctx.tenant_id) as s:
        n_prd = await s.scalar(select(func.count()).select_from(DocumentVersion).where(
            DocumentVersion.document_id == ids["prd"]))  # fmt: skip
        n_rm = await s.scalar(select(func.count()).select_from(DocumentVersion).where(
            DocumentVersion.document_id == rm.id))  # fmt: skip
        d = await s.scalar(select(SimpleDraft).where(SimpleDraft.document_id == rm.id))
    assert (n_prd, n_rm) == (1, 1) and d.status == "working"


async def test_resized_items_wait_on_an_estimate(client):
    from oracle.review.models import Notification

    ctx = await make_ctx()
    await seed(ctx, BODY, items=("f-06", "f-03"))
    async with tenant_session(ctx.tenant_id) as s:
        for row in await s.scalars(select(RoadmapItem)):
            row.owner_id = ctx.users["commenter"].id
        await s.commit()
    h = ctx.as_("decider")
    picks = {"milestone": "M2", "picks": ["F-03b", "F-06", "focus"]}
    r = await client.post(f"{URL}/approve", json=picks, headers=h)
    assert r.status_code == 200, r.text
    assert [e["item"] for e in r.json()["needs_estimate"]] == ["Bulk invite"]
    async with tenant_session(ctx.tenant_id) as s:
        rm = await s.scalar(select(Document).where(Document.slug == "setup-roadmap"))
        v2 = await s.scalar(select(DocumentVersion).where(
            DocumentVersion.document_id == rm.id, DocumentVersion.number == 2))  # fmt: skip
        rows = {r.item_key: r for r in await s.scalars(
            select(RoadmapItem).where(RoadmapItem.roadmap_version_id == v2.id))}  # fmt: skip
        asked = list(await s.scalars(select(Notification).where(
            Notification.kind == "estimate_requested")))  # fmt: skip
    assert rows["f-06"].estimate_pending is True and rows["f-03"].estimate_pending is False
    assert [(n.user_id, n.title) for n in asked] == [
        (ctx.users["commenter"].id, "Bulk invite needs a new estimate: the re-plan resized it")
    ]
    board = await client.get("/v1/simple/roadmap", params={"roadmap": "setup-roadmap"},
                             headers=ctx.as_("viewer"))  # fmt: skip
    assert board.status_code == 200, board.text
    pending = {i["key"]: i.get("estimate_pending") for i in board.json()["items"]}
    assert pending.get("f-06") is True, pending


# --------------------------------------------------------------------------- smaller goal

# M2 ends Dec 21: no set of cuts reaches it while the Activation goal asks for 55%.
HARD = BODY.replace("| 30 Nov 2026 | 25 Dec 2026 |", "| 30 Nov 2026 | 21 Dec 2026 |")


async def _activation(client, ctx, target=55):
    from tests.baseline_helpers import entity

    return await entity(client, ctx, type="goal", key="activation", title="Activation",
                        attrs={"metric": "new teams that finish setup", "unit": "%",
                               "comparison": "at_least", "target": target, "start": 40})  # fmt: skip


async def test_answer_ties_its_baseline_goal(client):
    ctx = await make_ctx()
    await seed(ctx, HARD)
    goal = await _activation(client, ctx)
    a = (await client.get(URL, params={"milestone": "M2"}, headers=ctx.as_("owner"))).json()
    g = a["baseline_goal"]
    assert g["id"] == goal["id"] and g["title"] == "Activation"
    assert g["target"] == 55 and g["unit"] == "%" and g["plan_target"] == 55
    assert g["smaller"] is False and g["can_edit"] is True
    viewer = await client.get(URL, params={"milestone": "M2"}, headers=ctx.as_("viewer"))
    assert viewer.json()["baseline_goal"]["can_edit"] is False


async def test_no_baseline_goal_reads_none(client):
    ctx = await make_ctx()
    await seed(ctx, HARD)
    a = (await client.get(URL, params={"milestone": "M2"}, headers=ctx.as_("owner"))).json()
    assert a["baseline_goal"] is None


async def test_smaller_goal_reaches_the_date(client):
    """Lowering the Baseline goal's target (PATCH /v1/baseline/entities/{id}) shrinks the
    goal's own work in the milestone in proportion, so the answer, the live date and the
    draft read the date against the smaller goal."""
    ctx = await make_ctx()
    await seed(ctx, HARD)
    goal = await _activation(client, ctx)
    h = ctx.as_("owner")
    before = (await client.get(URL, params={"milestone": "M2"}, headers=h)).json()
    assert before["reachable"] is False, before
    r = await client.patch(f"/v1/baseline/entities/{goal['id']}", json={"attrs": {"target": 44}},
                           headers=h)  # fmt: skip
    assert r.status_code == 200, r.text
    after = (await client.get(URL, params={"milestone": "M2"}, headers=h)).json()
    assert after["target"] == before["target"]
    assert after["baseline_goal"]["target"] == 44 and after["baseline_goal"]["smaller"] is True
    assert after["reachable"] is True, after
    assert after["best_date"] < before["best_date"]
    live = await client.post(f"{URL}/live", json={"milestone": "M2", "picks": after["pick"]},
                             headers=h)  # fmt: skip
    assert live.json()["over_days"] <= 0
