"""The ⌘K palette's index (build-palette, issue 1794): ``GET /v1/simple/palette`` lists the
PRDs, goals, key results and goal milestones one company's people can find, against
Postgres. Features come from the Simple roadmap read. Invented example data only.

Test cards (protects / fails_when / no_claim):
- test_every_role_reads_the_index (parametrized owner, approver, commenter, viewer):
  protects=each role reads PRDs with title and status, confirmed goals with their measure,
  key results with their goal and goal milestones with their code and date in words;
  fails_when=a kind or field is missing or a role is refused; no_claim=the palette's drawing
  (Playwright's palette specs).
- test_hidden_trashed_and_other_company_rows_are_left_out: protects=a PRD in Trash, an
  approvers-only document for a viewer, a deleted milestone, a proposed goal and every row of
  another company stay out; fails_when=one of them is listed; no_claim=other reads.
"""

from datetime import UTC, date, datetime

import pytest

from oracle.metrics.models import Metric
from oracle.roadmap.models import TrackMilestone
from oracle.tenancy import tenant_session
from tests.baseline_helpers import Ctx, make_ctx
from tests.test_simple_roadmap_api import Seed

URL = "/v1/simple/palette"


async def world(prefix: str = "") -> Ctx:
    ctx = await make_ctx()
    async with tenant_session(ctx.tenant_id) as s:
        seed = Seed(s)
        await seed.doc(f"{prefix}usage-alerts")
        hidden = await seed.doc(f"{prefix}board-update", kind="update", visibility="approvers")
        hidden.title = f"{prefix}Board update"
        gone = await seed.doc(f"{prefix}old-plan")
        gone.deleted_at = datetime(2026, 11, 1, tzinfo=UTC)
        roadmap = await seed.doc(f"{prefix}alerts-roadmap", kind="roadmap")
        growth = await seed.entity("goal", f"{prefix}growth", metric="sign-ups per rep")
        proposed = await seed.entity("goal", f"{prefix}proposed-goal")
        proposed.status = "proposed"
        await seed.add(
            Metric(
                title=f"{prefix}Sign-ups per rep per day",
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
    ms = {m["name"]: m for m in body["milestones"]}
    assert ms["50 sign-ups per rep"]["code"] == "M3"
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
