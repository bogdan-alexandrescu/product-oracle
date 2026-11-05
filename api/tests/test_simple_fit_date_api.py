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
- test_smaller_goal_keeps_locked_work_whole (review 3): protects=under a smaller goal a
  must-include item and a guardrail item of the goal, in the asked milestone, keep their
  full size while the goal's other unlocked work shrinks; fails_when=build_plan scales a
  locked or must-include item.
- test_smaller_goal_floor (review 3): protects=a target just above the start counts the
  goal's own work at the 10% floor, never less; fails_when=the floor is removed.
- test_approve_lands_on_the_company_roadmap (train review): protects=with a company roadmap,
  the answer and the re-plan read and write it, even when the PRD's track points at an
  older roadmap; fails_when=the re-plan is written or approved on the track's old roadmap.
- test_smaller_goal_floor_rounds_to_a_tenth_of_a_week (fit-date follow-ups): protects=the
  10% floor is rounded to one decimal like every engineer-week in fit a date, a 0.3-week
  item keeping 0.1; fails_when=the floor is pw * 0.1 unrounded (0.33 for a 3.3-week item).
- test_a_slice_never_grows_an_item (fit-date follow-ups, round 1): protects=a sliced item's
  slice is capped at its own size, and a slice or split that saves nothing is not offered;
  fails_when=a 4-week item shrunk to 0.4 slices to ceil(0.4) / 2 = 0.5 and its change reads
  "Saves -0.1 person-weeks".
- test_smaller_goal_shrinks_each_item_to_a_tenth_at_least (smaller goal, owner): protects=each
  of the goal's own unlocked items counts at least 10% of its effort, a 0.3-week one too, and
  a safety item keeps its full size like guardrail and must-include ones; fails_when=a small
  item is rounded down to nothing.
"""

import re

import pytest
from sqlalchemy import func, select

from oracle.auth.models import User
from oracle.docs.models import Document, DocumentVersion
from oracle.review.models import DocumentReviewPolicy
from oracle.roadmap.models import RoadmapItem
from oracle.simple import drafts
from oracle.simple.models import SimpleDraft
from oracle.tenancy import tenant_session
from tests.baseline_helpers import make_ctx
from tests.test_simple_plan_api import FIXTURE, clock, seed, version  # noqa: F401

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

    attrs = {"metric": "new teams that finish setup", "unit": "%", "comparison": "at_least",
             "target": target, "start": 40}  # fmt: skip
    return await entity(client, ctx, type="goal", key="activation", title="Activation",
                        attrs=attrs)  # fmt: skip


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
    listed = (await client.get("/v1/simple/fit-date", headers=h)).json()
    assert next(g for g in listed if g["milestone"] == "M2")["today"] == after["today"]


# Bulk invite (must-include) and Consent log (guardrail) are the Activation goal's own M2
# work, as is Setup tips, which is neither.
RULED = HARD.replace(
    "| F-06 | Bulk invite | M2 | 4 | Activation | then |\n",
    "| F-06 | Bulk invite | M2 | 4 | Activation | then |\n"
    "| F-07 | Consent log | M2 | 3 | Activation | then |\n"
    "| F-08 | Setup tips | M2 | 2 | Activation | then |\n",
).replace(
    "- F-01 Setup checklist: Guardrail: setup never skips the consent step.\n",
    "- F-01 Setup checklist: Guardrail: setup never skips the consent step.\n"
    "- F-06 Bulk invite: Must-include: the goal cannot move without it.\n"
    "- F-07 Consent log: Guardrail: every invite is logged with its consent.\n",
)


def _sizes(a: dict) -> tuple[float, float, float]:
    must = next(c for c in a["changes"] if c["id"] == "F-06")
    tips = next(c for c in a["changes"] if c["id"] == "F-08")
    guard = next(x for x in a["locked"] if x["item"] == "Consent log")
    assert must["pickable"] is False and must["cost_kind"] == "must"
    return must["pw_saved"], guard["pw"], tips["pw_saved"]


async def test_smaller_goal_keeps_locked_work_whole(client):
    ctx = await make_ctx()
    await seed(ctx, RULED)
    goal = await _activation(client, ctx)
    h = ctx.as_("owner")
    before = (await client.get(URL, params={"milestone": "M2"}, headers=h)).json()
    assert _sizes(before) == (4, 3, 2)
    r = await client.patch(f"/v1/baseline/entities/{goal['id']}", json={"attrs": {"target": 44}},
                           headers=h)  # fmt: skip
    assert r.status_code == 200, r.text
    after = (await client.get(URL, params={"milestone": "M2"}, headers=h)).json()
    assert after["baseline_goal"]["smaller"] is True
    # The scale is (44 - 40) / (55 - 40): only Setup tips shrinks.
    assert _sizes(after) == (4, 3, round(2 * 4 / 15, 1))


async def test_smaller_goal_floor(client):
    from oracle.simple.fit_date_router import FitBaselineGoalOut, _scale

    g = FitBaselineGoalOut(id="00000000-0000-0000-0000-000000000001", title="Activation",
                           target=40.5, unit="%", comparison="at_least", start=40, due=None,
                           plan_target=55, can_edit=True)  # fmt: skip
    assert _scale(g) == 0.1
    ctx = await make_ctx()
    await seed(ctx, RULED)
    goal = await _activation(client, ctx, target=40.5)
    a = (await client.get(URL, params={"milestone": "M2"}, headers=ctx.as_("owner"))).json()
    assert a["baseline_goal"]["smaller"] is True and goal["attrs"]["target"] == 40.5
    assert _sizes(a) == (4, 3, 0.2)


async def test_approve_lands_on_the_company_roadmap(client):
    """one-roadmap-many-prds (train review): the PRD's track still points at its own older
    roadmap, but the re-plan is written and approved on the company roadmap, the one Simple
    Roadmap, Priorities and Home read; the older roadmap is left as history."""
    ctx = await make_ctx()
    ids = await seed(ctx, BODY, items=("f-06", "f-03"))
    async with tenant_session(ctx.tenant_id) as s:
        old = await s.scalar(select(Document).where(Document.slug == "setup-roadmap"))
        one = Document(slug="product-roadmap", title="Product roadmap", kind="roadmap",
                       status="approved", visibility="company", company_roadmap=True)  # fmt: skip
        s.add(one)
        await s.flush()
        cv = await version(s, one, 1, "# Product roadmap\n")
        s.add(DocumentReviewPolicy(document_id=one.id, decider_id=ctx.users["decider"].id))
        pv = await s.scalar(select(DocumentVersion.id).where(
            DocumentVersion.document_id == ids["prd"]))  # fmt: skip
        for n, key in enumerate(("f-06", "f-03")):
            s.add(RoadmapItem(roadmap_document_id=one.id, roadmap_version_id=cv.id,
                              item_key=key, prd_document_id=ids["prd"], prd_version_id=pv,
                              prd_section_key=key, title=key.upper(), horizon="now",
                              position=n))  # fmt: skip
        await s.commit()
        old_id, one_id = old.id, one.id
    h = ctx.as_("decider")
    before = (await client.get(URL, params={"milestone": "M2"}, headers=h)).json()
    assert before["roadmap"]["slug"] == "product-roadmap", before["roadmap"]
    picks = {"milestone": "M2", "picks": ["F-03b", "F-06", "focus"]}
    r = await client.post(f"{URL}/approve", json=picks, headers=h)
    assert r.status_code == 200, r.text
    assert r.json()["roadmap_version"] == 2
    async with tenant_session(ctx.tenant_id) as s:
        n_old = await s.scalar(select(func.count()).select_from(DocumentVersion).where(
            DocumentVersion.document_id == old_id))  # fmt: skip
        vs = list(await s.scalars(select(DocumentVersion).where(
            DocumentVersion.document_id == one_id).order_by(DocumentVersion.number)))  # fmt: skip
        assert [v.approved_at is not None for v in vs] == [True, True]
        rows = {r.item_key for r in await s.scalars(
            select(RoadmapItem).where(RoadmapItem.roadmap_version_id == vs[1].id))}  # fmt: skip
    assert n_old == 1
    assert rows == {"f-06", "f-03"}


# Help link (0.3 weeks) is the Activation goal's own unlocked M2 work; Audit trail its safety
# item.
TINY = RULED.replace(
    "| F-08 | Setup tips | M2 | 2 | Activation | then |\n",
    "| F-08 | Setup tips | M2 | 2 | Activation | then |\n"
    "| F-09 | Help link | M2 | 0.3 | Activation | then |\n"
    "| F-10 | Audit trail | M2 | 2 | Activation | then |\n",
).replace(
    "- F-07 Consent log: Guardrail: every invite is logged with its consent.\n",
    "- F-07 Consent log: Guardrail: every invite is logged with its consent.\n"
    "- F-10 Audit trail: Safety: every admin change can be traced.\n",
)


def test_smaller_goal_shrinks_each_item_to_a_tenth_at_least():
    """At the floor scale each of the goal's own unlocked items counts at least 10% of its
    effort, a small one too (never rounded down to nothing); guardrail, safety and
    must-include items keep their full size."""
    import datetime as dt

    from oracle.simple import plan
    from oracle.simple.fit_date_router import build_plan

    today = dt.date(2026, 11, 2)
    view = plan.compute(plan.parse(TINY, today))
    p = build_plan(TINY, view, "M2", today, scale=0.1)
    pw = {i.id: i.pw for i in p.items}
    assert pw["F-08"] == pytest.approx(0.2)
    assert pw["F-09"] >= 0.03 - 1e-9, pw
    assert (pw["F-06"], pw["F-07"], pw["F-10"]) == (4, 3, 2)


ODD = TINY.replace(
    "| F-10 | Audit trail | M2 | 2 | Activation | then |\n",
    "| F-10 | Audit trail | M2 | 2 | Activation | then |\n"
    "| F-11 | Saved filters | M2 | 3.3 | Activation | then |\n",
)


@pytest.mark.parametrize("scale", [0.1, 0.13, 0.5])
def test_smaller_goal_floor_rounds_to_a_tenth_of_a_week(scale):
    """The 10% floor is rounded to a tenth of an engineer-week, as every other size in fit a
    date is: a 3.3-week item counts 0.3 at the floor, never 0.33; a 0.3-week one keeps 0.1."""
    import datetime as dt

    from oracle.simple import plan
    from oracle.simple.fit_date_router import build_plan

    today = dt.date(2026, 11, 2)
    view = plan.compute(plan.parse(ODD, today))
    p = build_plan(ODD, view, "M2", today, scale=scale)
    pw = {i.id: i.pw for i in p.items}
    for code in ("F-08", "F-09", "F-11"):
        assert pw[code] == round(pw[code], 1), pw
    if scale == 0.1:
        assert (pw["F-09"], pw["F-11"]) == (0.1, 0.3), pw


SLICED = TINY.replace(
    "| F-10 | Audit trail | M2 | 2 | Activation | then |\n",
    "| F-10 | Audit trail | M2 | 2 | Activation | then |\n"
    "| F-12 | Bulk invite | M2 | 4 | Activation | then |\n",
)


@pytest.mark.parametrize("scale", [1.0, 0.5, 0.1, 0.05])
def test_a_slice_never_grows_an_item(scale):
    """A slice is at most the item's own size: a 4-week slice item a smaller goal shrinks to
    0.4 never slices to ceil(0.4) / 2 = 0.5, and a change that saves nothing is not offered."""
    import datetime as dt

    from oracle.simple import fit_date as fd
    from oracle.simple import plan
    from oracle.simple.fit_date_router import build_plan

    today = dt.date(2026, 11, 2)
    view = plan.compute(plan.parse(SLICED, today))
    p = build_plan(SLICED, view, "M2", today, scale=scale)
    item = next(i for i in p.items if i.id == "F-12")
    assert item.lever == "slice"
    for i in p.items:
        assert i.slice_pw is None or i.slice_pw <= i.pw, (i.id, i.pw, i.slice_pw)
    changes = {c.id: c for c in fd.answer(p).changes}
    for c in changes.values():
        if c.lever in ("slice", "split"):
            assert c.pw_saved > 0, (c.id, c.pw_saved)
    if scale == 1.0:
        assert (item.slice_pw, changes["F-12"].pw_saved) == (2, 2)
    if scale == 0.1:
        # 0.4 slices to 0.4: nothing saved, so no slice is offered.
        assert (item.pw, item.slice_pw) == (0.4, 0.4)
        assert "F-12" not in changes
