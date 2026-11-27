"""The ⌘K palette's index (build-palette, issue 1794): ``GET /v1/simple/palette`` lists the
PRDs, goals, key results and goal milestones one company's people can find, against
Postgres. Features come from the Simple roadmap read. Invented example data only.

Test cards (protects / fails_when / no_claim):
- test_every_role_reads_the_index (parametrized owner, approver, commenter, viewer):
  protects=each role reads PRDs with title and status, confirmed top goals with their measure,
  key results (confirmed subgoals) with their top goal and goal milestones with their roadmap
  code and date in words; fails_when=a kind or field is missing or a role is refused;
  no_claim=the palette's drawing (Playwright's palette specs).
- test_hidden_trashed_and_other_company_rows_are_left_out: protects=a PRD in Trash, an
  approvers-only document for a viewer, a deleted milestone, a proposed goal and every row of
  another company stay out; fails_when=one of them is listed; no_claim=other reads.
- test_key_results_are_the_confirmed_live_subgoals: protects=a confirmed subgoal is a key result
  of its top goal (at any depth) and no goal; a metric is neither; an archived or proposed goal, a
  subgoal of an archived goal and an archived subgoal stay out; fails_when=one is listed or in the
  wrong group; no_claim=the Goal map's drawing of key results.
- test_milestones_carry_the_roadmaps_own_codes: protects=two goals' milestones read the one
  code by date the roadmap read gives each (never two M1); fails_when=a goal's own code is
  listed; no_claim=how codes are numbered (test_simple_roadmap_codes).
- test_a_prd_milestone_folded_into_a_goals_is_listed_once: protects=a PRD's milestone and the
  goal's twin of it are one row, by the goal's date; fails_when=both are listed.
- test_a_hidden_prds_milestones_are_left_out (viewer, commenter, approver): protects=an
  approvers-only PRD's milestone, and one whose PRD is in Trash, is not listed to who may not
  read the PRD; fails_when=its name or date is listed; no_claim=the roadmap read itself.
- test_a_track_milestone_with_no_goal_milestone_is_listed: protects=a track milestone the
  roadmap read codes, with no goal milestone of its code, is a row by its own id; fails_when=it
  is missing.
- test_confirmed_features_on_no_roadmap_are_listed: protects=a confirmed live feature no item
  holds is listed by code and name; fails_when=it is missing, or an item's, a proposed, a
  trashed or another company's feature is listed.
- test_a_feature_only_an_older_version_holds_is_listed: protects=a confirmed feature held by v1
  only, with approved v2 without it, is listed (the roadmap read shows v2); fails_when=an item of
  any version or draft counts as holding it.
"""

from datetime import UTC, date, datetime
from uuid import UUID, uuid4

import pytest

from oracle.baseline.models import Entity
from oracle.docs.models import Document
from oracle.metrics.models import Metric
from oracle.roadmap.models import TrackMilestone
from oracle.tenancy import tenant_session
from tests.baseline_helpers import Ctx, make_ctx
from tests.test_simple_goal_milestones_api import (
    MILESTONES,
    get_roadmap,
    seed_prd_roadmap,
    seed_roadmap,
)
from tests.test_simple_roadmap_api import Seed

URL = "/v1/simple/palette"


async def world(prefix: str = "") -> Ctx:
    ctx = await make_ctx(f"{prefix}Example Co {uuid4().hex[:8]}")
    async with tenant_session(ctx.tenant_id) as s:
        seed = Seed(s)
        await seed.doc(f"{prefix}usage-alerts")
        hidden = await seed.doc(f"{prefix}board-update", visibility="approvers")
        hidden.title = f"{prefix}Board update"
        gone = await seed.doc(f"{prefix}old-plan")
        gone.deleted_at = datetime(2026, 11, 1, tzinfo=UTC)
        roadmap = await seed.doc(f"{prefix}alerts-roadmap", kind="roadmap")
        growth = await seed.entity("goal", f"{prefix}growth", metric="sign-ups per rep")
        kr = await seed.entity("goal", f"{prefix}sign-ups-per-rep-per-day")
        kr.title, kr.parent_id = f"{prefix}Sign-ups per rep per day", growth.id
        proposed = await seed.entity("goal", f"{prefix}proposed-goal")
        proposed.status = "proposed"
        await seed.add(
            Metric(
                title=f"{prefix}Weekly sign-ups",
                description="Each rep's daily sign-ups",
                kind="output",
                unit="",
                direction="up",
                source="manual",
                goal_id=growth.id,
                owner_id=ctx.users["owner"].id,
            )
        )
        await seed.add(
            TrackMilestone(
                roadmap_id=roadmap.id,
                goal_id=growth.id,
                code="M3",
                name=f"{prefix}50 sign-ups per rep",
                horizon="now",
                kind="delivery",
                target_date=date(2026, 12, 2),
            )
        )
        await seed.add(
            TrackMilestone(
                roadmap_id=roadmap.id,
                goal_id=growth.id,
                code="M9",
                name=f"{prefix}Dropped step",
                horizon="now",
                kind="delivery",
                deleted_at=datetime(2026, 11, 1, tzinfo=UTC),
            )
        )
        await s.commit()
    return ctx


async def read(client, ctx: Ctx, role: str) -> dict:
    r = await client.get(URL, headers=ctx.as_(role))
    assert r.status_code == 200, r.text
    return r.json()


@pytest.mark.parametrize("role", ["owner", "approver", "commenter", "viewer"])
async def test_every_role_reads_the_index(client, role):
    """Every role finds PRDs, goals, key results and milestones from the palette."""
    ctx = await world()
    body = await read(client, ctx, role)
    prds = {p["title"]: p for p in body["prds"]}
    assert prds["Usage Alerts"]["status"] == "approved"
    assert prds["Usage Alerts"]["slug"] == "usage-alerts"
    goals = {g["name"]: g for g in body["goals"]}
    assert goals["Growth"]["measure"] == "sign-ups per rep"
    krs = {k["name"]: k for k in body["key_results"]}
    assert krs["Sign-ups per rep per day"]["goal"] == "Growth"
    assert krs["Sign-ups per rep per day"]["goal_id"] == goals["Growth"]["id"]
    ms = {m["name"]: m for m in body["milestones"]}
    # Its code on the roadmap (the only one there), not the goal's own M3.
    assert ms["50 sign-ups per rep"]["code"] == "M1"
    assert ms["50 sign-ups per rep"]["date"] == "Dec 2"


async def test_hidden_trashed_and_other_company_rows_are_left_out(client):
    """The palette never lists a hidden, trashed or another company's row."""
    ctx = await world()
    await world(prefix="other-")
    viewer = await read(client, ctx, "viewer")
    owner = await read(client, ctx, "owner")
    titles = {p["title"] for p in viewer["prds"]}
    assert "Old Plan" not in titles
    assert "Board update" not in titles
    assert "Alerts Roadmap" not in titles  # a roadmap is not a PRD
    assert "Board update" in {p["title"] for p in owner["prds"]}
    assert "Proposed Goal" not in {g["name"] for g in owner["goals"]}
    assert "Dropped step" not in {m["name"] for m in owner["milestones"]}
    everything = str(owner) + str(viewer)
    assert "other" not in everything.lower()


async def test_key_results_are_the_confirmed_live_subgoals(client):
    """A key result is a confirmed live subgoal, under its top goal; a metric is none."""
    ctx = await make_ctx(f"Example Co {uuid4().hex[:8]}")
    async with tenant_session(ctx.tenant_id) as s:
        seed = Seed(s)

        async def goal(title: str, parent: Entity | None = None, status: str = "confirmed"):
            g = await seed.entity("goal", title.lower().replace(" ", "-"))
            g.title, g.status = title, status
            g.parent_id = parent.id if parent is not None else None
            return g

        growth = await goal("Growth")
        daily = await goal("Daily sign-ups", growth)
        await goal("Sign-ups by phone", daily)
        await goal("Proposed key result", growth, "proposed")
        await goal("Archived key result", growth, "rejected")
        gone = await goal("Archived goal", status="rejected")
        await goal("Key result of an archived goal", gone)
        for title, status in (("A live metric", "active"), ("An archived metric", "archived")):
            await seed.add(
                Metric(
                    title=title,
                    description="",
                    kind="output",
                    unit="",
                    direction="up",
                    source="manual",
                    status=status,
                    goal_id=growth.id,
                    owner_id=ctx.users["owner"].id,
                )
            )
        await s.commit()
        top = str(growth.id)
    body = await read(client, ctx, "viewer")
    assert [g["name"] for g in body["goals"]] == ["Growth"]
    assert {(k["name"], k["goal"], k["goal_id"]) for k in body["key_results"]} == {
        ("Daily sign-ups", "Growth", top),
        ("Sign-ups by phone", "Growth", top),
    }
    assert "metric" not in str(body)


async def test_milestones_carry_the_roadmaps_own_codes(client):
    """Two goals' milestones read the roadmap's one code by date, as the roadmap read."""
    ctx = await make_ctx(f"Example Co {uuid4().hex[:8]}")
    ids = await seed_roadmap(ctx)
    async with tenant_session(ctx.tenant_id) as s:
        other = await Seed(s).entity("goal", "retention")
        await s.commit()
        other_id = str(other.id)
    for name, when, goal in [
        ("Prove it", "2026-11-27", ids["goal_id"]),
        ("Keep teams", "2026-12-04", other_id),
        ("Scale volume", "2026-12-18", ids["goal_id"]),
    ]:
        body = {"roadmap_id": ids["roadmap_id"], "name": name, "date": when, "goal_id": goal}
        r = await client.post(MILESTONES, json=body, headers=ctx.as_("owner"))
        assert r.status_code == 201, r.text
    got = (await read(client, ctx, "viewer"))["milestones"]
    assert [(m["code"], m["name"], m["date"]) for m in got] == [
        ("M1", "Prove it", "Nov 27"),
        ("M2", "Keep teams", "Dec 4"),
        ("M3", "Scale volume", "Dec 18"),
    ]
    shown = (await get_roadmap(client, ctx, "viewer"))["goal_milestones"]
    assert {(m["id"], m["code"]) for m in got} == {(m["id"], m["roadmap_code"]) for m in shown}


async def test_a_prd_milestone_folded_into_a_goals_is_listed_once(client):
    """A goal's "M1 Prove it" and the PRD's twin of it are one row, dated by the goal's."""
    ctx = await make_ctx(f"Example Co {uuid4().hex[:8]}")
    ids = await seed_prd_roadmap(ctx, ctx.users["owner"].id)
    async with tenant_session(ctx.tenant_id) as s:
        goal = await Seed(s).entity("goal", "activation")
        await s.commit()
        goal_id = str(goal.id)
    body = {"roadmap_id": ids["roadmap_id"], "name": "Prove it", "date": "2026-11-20",
            "goal_id": goal_id}  # fmt: skip
    r = await client.post(MILESTONES, json=body, headers=ctx.as_("owner"))
    assert r.status_code == 201, r.text
    shown = (await get_roadmap(client, ctx, "owner"))["goal_milestones"]
    assert len([m for m in shown if m["name"] == "Prove it"]) == 2  # the read keeps both twins
    got = (await read(client, ctx, "viewer"))["milestones"]
    assert [(m["code"], m["name"], m["date"]) for m in got] == [
        ("M1", "Prove it", "Nov 20"),
        ("M2", "Scale volume", ""),
    ]
    assert got[0]["id"] == r.json()["id"]


@pytest.mark.parametrize(
    "role, sees", [("viewer", False), ("commenter", False), ("approver", True)]
)
async def test_a_hidden_prds_milestones_are_left_out(client, role, sees):
    """An approvers-only PRD's milestones are found by approvers alone; a trashed PRD's by none."""
    ctx = await make_ctx(f"Example Co {uuid4().hex[:8]}")
    ids = await seed_prd_roadmap(ctx, ctx.users["owner"].id)
    # The approver's read makes the PRD's milestones rows of the roadmap.
    assert (await get_roadmap(client, ctx, "approver"))["goal_milestones"]
    async with tenant_session(ctx.tenant_id) as s:
        prd = await s.get(Document, UUID(ids["prd_id"]))
        prd.visibility = "approvers"
        await s.commit()
    names = {m["name"] for m in (await read(client, ctx, role))["milestones"]}
    assert ("Prove it" in names) is sees
    async with tenant_session(ctx.tenant_id) as s:
        prd = await s.get(Document, UUID(ids["prd_id"]))
        prd.visibility, prd.deleted_at = "company", datetime(2026, 11, 1, tzinfo=UTC)
        await s.commit()
    body = await read(client, ctx, role)
    assert "Prove it" not in {m["name"] for m in body["milestones"]}


async def test_a_track_milestone_with_no_goal_milestone_is_listed(client):
    """A track's "Beta", on the roadmap with no goal milestone of its code, is a row of its own,
    by its roadmap code, date and id (the Roadmap opens it by that id)."""
    ctx = await make_ctx(f"Example Co {uuid4().hex[:8]}")
    async with tenant_session(ctx.tenant_id) as s:
        seed = Seed(s)
        _, pv, rm, rv = await seed.roadmap("launch")
        track = await seed.track(pv, rm, title="Guided setup")
        item = await seed.item(rv, pv, "item-0", track_id=track.id)
        beta = await seed.add(
            TrackMilestone(
                track_id=track.id,
                name="Beta",
                horizon="now",
                item_keys=["item-0"],
                target_date=date(2026, 11, 30),
                basis_ids=[item.id],
            )
        )
        await s.commit()
        beta_id = str(beta.id)
    shown = (await get_roadmap(client, ctx, "viewer"))["milestones"]
    assert [(m["name"], m["roadmap_code"]) for m in shown] == [("Beta", "M1")]
    got = (await read(client, ctx, "viewer"))["milestones"]
    assert [(m["id"], m["code"], m["name"], m["date"]) for m in got] == [
        (beta_id, "M1", "Beta", "Nov 30")
    ]


async def test_confirmed_features_on_no_roadmap_are_listed(client):
    """A confirmed Ground Truth feature no roadmap item holds is found by code and name; one an
    item holds, a proposed one, one in Trash and another company's are not."""
    await features_world("other-")
    ctx, referral = await features_world()
    for role in ("viewer", "owner"):
        got = (await read(client, ctx, role))["features"]
        assert [(f["code"], f["name"]) for f in got] == [("F-12", "Referral link")]
        assert got[0]["id"] == referral


async def test_a_feature_only_an_older_version_holds_is_listed(client):
    """F-12 Referral link was on roadmap v1; approved v2 holds F-13 only. The roadmap read
    shows v2's items, so F-12 is on no roadmap and is found."""
    ctx = await make_ctx(f"Example Co {uuid4().hex[:8]}")
    async with tenant_session(ctx.tenant_id) as s:
        seed = Seed(s)
        _, pv, rm, v1 = await seed.roadmap("launch")
        v2 = await seed.version(rm, n=2)
        referral = await seed.entity("feature", "F-12")
        referral.title = "Referral link"
        invites = await seed.entity("feature", "F-13")
        invites.title = "Team invites"
        await seed.item(v1, pv, "f-12", feature_id=referral.id)
        await seed.item(v1, pv, "f-13", feature_id=invites.id)
        await seed.item(v2, pv, "f-13", feature_id=invites.id)
        await s.commit()
        referral_id = str(referral.id)
    shown = (await get_roadmap(client, ctx, "viewer"))["items"]
    assert [i["code"] for i in shown] == ["F-13"]
    got = (await read(client, ctx, "viewer"))["features"]
    assert [(f["id"], f["code"], f["name"]) for f in got] == [
        (referral_id, "F-12", "Referral link")
    ]


async def features_world(prefix: str = "") -> tuple[Ctx, str]:
    ctx = await make_ctx(f"{prefix}Example Co {uuid4().hex[:8]}")
    async with tenant_session(ctx.tenant_id) as s:
        seed = Seed(s)
        _, pv, _, rv = await seed.roadmap(f"{prefix}launch")

        async def feature(key: str, title: str, status: str = "confirmed") -> Entity:
            f = await seed.entity("feature", key)
            f.title, f.status = f"{prefix}{title}", status
            return f

        referral = await feature("F-12", "Referral link")
        held = await feature("F-03", "Guided setup")
        await seed.item(rv, pv, "f-03", feature_id=held.id)
        await feature("F-20", "Team invites", status="proposed")
        trashed = await feature("F-21", "Old export")
        trashed.deleted_at = datetime(2026, 11, 1, tzinfo=UTC)
        await s.commit()
        referral_id = str(referral.id)
    return ctx, referral_id


async def test_a_goal_measure_that_is_not_text_reads_empty(client):
    """A goal whose metric is stored as an object reads no measure, never its Python text."""
    ctx = await make_ctx(f"Example Co {uuid4().hex[:8]}")
    async with tenant_session(ctx.tenant_id) as s:
        await Seed(s).entity("goal", "growth", metric={"name": "sign-ups"})
        await s.commit()
    goals = (await read(client, ctx, "viewer"))["goals"]
    assert [(g["name"], g["measure"]) for g in goals] == [("Growth", "")]
