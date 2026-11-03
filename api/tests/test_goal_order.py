"""Goals keep one order on every page (goal-order): a goal's ``attrs.position`` (1 = first)
orders every API list of goals; goals without a position follow those with one, then by
creation time, then by title. Against Postgres.

The world: five confirmed goals made in this order, with positions out of that order:
alpha (3), bravo (1), charlie (none), delta (2), echo (none, made with charlie). Each is
served by its own feature and roadmap item, so every grouped read shows every goal.
The one order is bravo, delta, alpha, charlie, echo (charlie and echo tie on creation:
by title).

Test cards (protects / fails_when / no_claim):

- test_baseline_lists_follow_the_rule: protects=GET /v1/baseline/entities?type=goal and
  /v1/baseline/graph list goals in the one order, each with its position;
  fails_when=goals come by key or creation, or position is missing; no_claim=the web.
- test_simple_roadmap_groups_follow_the_rule: protects=Simple Roadmap's goal groups and
  each item's goal carry the order and the position; fails_when=groups come by key;
  no_claim=other groupings.
- test_simple_priorities_buckets_follow_the_rule: protects=Simple Priorities' goal buckets
  come in the one order, No goal last; fails_when=buckets come by key; no_claim=the rank.
- test_strategy_stack_follows_the_rule: protects=Strategy's stack lists a choice's goals and
  the unaligned goals in the one order with positions; fails_when=they come by key;
  no_claim=drift findings.
- test_simple_goal_suggestions_follow_the_rule: protects=Simple Roadmap's goal cards come in
  the one order; fails_when=they come by key; no_claim=the suggestions.
- test_position_must_be_a_whole_number: protects=a goal's Edit saves a position of 1 or
  more and refuses 0 or a word with a field problem; a tie on position goes to the older
  goal; fails_when=a bad position is stored; no_claim=the web form.
"""

from datetime import UTC, datetime, timedelta
from types import SimpleNamespace

import pytest

from oracle import company_time
from oracle.baseline.goal_order import sort_goals
from oracle.baseline.models import Entity
from oracle.tenancy import tenant_session
from tests.baseline_helpers import make_ctx
from tests.strategy_helpers import STRATEGY, approved, choice, imported, strategy_md
from tests.test_simple_changes_api import make_people
from tests.test_simple_roadmap_api import NOW, Seed

ORDER = ["bravo", "delta", "alpha", "charlie", "echo"]
POSITIONS = {"alpha": 3, "bravo": 1, "charlie": None, "delta": 2, "echo": None}
MADE = {"alpha": 0, "bravo": 1, "charlie": 2, "delta": 3, "echo": 2}


@pytest.fixture(autouse=True)
def clock(monkeypatch):
    monkeypatch.setattr(company_time, "now", lambda: NOW)


async def seed_goals(ctx) -> dict[str, str]:
    """The five goals, a feature and a Now roadmap item each; returns goal ids by key."""
    start = datetime(2026, 9, 1, tzinfo=UTC)
    async with tenant_session(ctx.tenant_id) as s:
        seed = Seed(s)
        _, pv, rm, rv = await seed.roadmap("payments")
        track = await seed.track(pv, rm)
        ids = {}
        for i, key in enumerate(["echo", "delta", "charlie", "bravo", "alpha"]):
            attrs = {"weight": 1} if POSITIONS[key] is None else {"position": POSITIONS[key]}
            goal = await seed.entity("goal", key, **attrs)
            goal.created_at = start + timedelta(days=MADE[key])
            feature = await seed.entity("feature", f"{key}-work", effort=1)
            await seed.supports(feature, goal)
            await seed.item(rv, pv, f"pay-{i}", position=i, feature_id=feature.id,
                            track_id=track.id)  # fmt: skip
            ids[key] = str(goal.id)
        await s.commit()
    return ids


async def test_baseline_lists_follow_the_rule(client):
    ctx = await make_ctx()
    await seed_goals(ctx)
    r = await client.get("/v1/baseline/entities", params={"type": "goal"},
                         headers=ctx.as_("viewer"))  # fmt: skip
    assert r.status_code == 200, r.text
    assert [g["key"] for g in r.json()] == ORDER
    assert {g["key"]: g["position"] for g in r.json()} == POSITIONS
    r = await client.get("/v1/baseline/graph", headers=ctx.as_("viewer"))
    goals = [e for e in r.json()["entities"] if e["type"] == "goal"]
    assert [g["key"] for g in goals] == ORDER


async def test_simple_roadmap_groups_follow_the_rule(client):
    ctx = await make_ctx()
    ids = await seed_goals(ctx)
    r = await client.get("/v1/simple/roadmap", params={"group": "goal"},
                         headers=ctx.as_("owner"))  # fmt: skip
    assert r.status_code == 200, r.text
    body = r.json()
    assert [g["key"] for g in body["groups"]] == [ids[k] for k in ORDER]
    goals = {i["goal"]["key"]: i["goal"]["position"] for i in body["items"] if i["goal"]}
    assert goals == POSITIONS


async def test_simple_priorities_buckets_follow_the_rule(client):
    ctx = await make_people()
    await seed_goals(ctx)
    r = await client.get("/v1/simple/priorities", headers=ctx.as_("owner"))
    assert r.status_code == 200, r.text
    buckets = r.json()["buckets"]
    assert [b["key"] for b in buckets if not b["no_goal"]] == ORDER
    assert [b["position"] for b in buckets if not b["no_goal"]] == [1, 2, 3, None, None]


async def test_strategy_stack_follows_the_rule(client):
    ctx = await make_ctx()
    await seed_goals(ctx)
    owner = ctx.as_("owner")
    focus = ["alpha", "bravo", "delta", "echo"]
    await imported(client, owner, STRATEGY, strategy_md([choice("one", goals=focus)]))
    await approved(client, owner, STRATEGY, 1)
    stack = (await client.get("/v1/strategy/stack", headers=ctx.as_("viewer"))).json()
    (one,) = stack["strategy"]["choices"]
    assert [g["key"] for g in one["goals"]] == ["bravo", "delta", "alpha", "echo"]
    assert [g["position"] for g in one["goals"]] == [1, 2, 3, None]


async def test_position_must_be_a_whole_number(client):
    ctx = await make_ctx()
    ids = await seed_goals(ctx)
    url = f"/v1/baseline/entities/{ids['charlie']}"
    owner = ctx.as_("owner")
    for bad in (0, "first", 1.5):
        r = await client.patch(url, json={"attrs": {"position": bad}, "origin": "user"},
                               headers=owner)  # fmt: skip
        assert r.status_code == 422, (bad, r.text)
        assert "attrs.position" in r.text
    r = await client.patch(url, json={"attrs": {"position": 1}, "origin": "user"}, headers=owner)
    assert r.status_code == 200, r.text
    assert r.json()["entity"]["position"] == 1
    async with tenant_session(ctx.tenant_id) as s:
        assert (await s.get(Entity, ids["charlie"])).attrs["position"] == 1
    r = await client.get("/v1/baseline/entities", params={"type": "goal"}, headers=owner)
    assert [g["key"] for g in r.json()] == ["bravo", "charlie", "delta", "alpha", "echo"]


async def test_simple_goal_suggestions_follow_the_rule(client):
    """protects=Simple Roadmap's goal cards (GET /v1/simple/goal-suggestions) list goals in
    the one order with positions; fails_when=they come by key; no_claim=the suggestions."""
    ctx = await make_ctx()
    await seed_goals(ctx)
    r = await client.get("/v1/simple/goal-suggestions", headers=ctx.as_("owner"))
    assert r.status_code == 200, r.text
    goals = [g["goal"] for g in r.json()["goals"]]
    assert [g["key"] for g in goals] == ORDER
    assert [g["position"] for g in goals] == [1, 2, 3, None, None]


async def test_baseline_trace_follows_the_rule(client):
    """protects=Detailed > Baseline > Flagged's Goal coverage (GET /v1/baseline/trace) lists
    goals in the one order, each with its position; fails_when=they come by key or
    position is missing; no_claim=the features' own order."""
    ctx = await make_ctx()
    await seed_goals(ctx)
    r = await client.get("/v1/baseline/trace", headers=ctx.as_("viewer"))
    assert r.status_code == 200, r.text
    goals = r.json()["goals"]
    assert [g["key"] for g in goals] == ORDER
    assert [g["position"] for g in goals] == [1, 2, 3, None, None]


def test_a_full_tie_goes_by_title_then_id():
    """protects=goals tied on position and creation order by title (case-folded, then as
    written), then by id, as the web's byGoalOrder does; fails_when=a full tie keeps the
    order the goals came in; no_claim=the web."""
    made = datetime(2026, 9, 1, tzinfo=UTC)

    def goal(gid: str, title: str) -> SimpleNamespace:
        return SimpleNamespace(id=gid, title=title, attrs={"position": 1}, created_at=made)

    goals = [goal("a", "same"), goal("c", "Same"), goal("b", "Same"), goal("d", "Other")]
    assert [g.id for g in sort_goals(goals)] == ["d", "b", "c", "a"]
