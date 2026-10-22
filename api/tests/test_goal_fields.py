"""B5 typed goal fields: the checks, goal_check, the write paths, YAML leniency, Fill
from text and the figure reader (parity with Home's web/app/home/_goals.ts)."""

import uuid
from datetime import date

import pytest
from sqlalchemy import update

from oracle.baseline import figures, goals
from oracle.baseline.models import Entity
from oracle.tenancy import tenant_session
from tests.baseline_helpers import confirm, edge, entity, make_ctx

B = "/v1/baseline"
TODAY = date(2026, 10, 20)


@pytest.fixture
async def ctx():
    return await make_ctx()


@pytest.fixture
def frozen_today(monkeypatch):
    monkeypatch.setattr(goals, "today", lambda: TODAY)
    return TODAY


def typed(ctx, **over) -> dict:
    attrs = {
        "metric": "New accounts that finish setup within 7 days",
        "unit": "%",
        "comparison": "at_least",
        "target": 45,
        "start": 31,
        "horizon": "short",
        "due": "2026-12-31",
        "owner": str(ctx.users["approver"].id),
        "weight": 3,
    }
    attrs.update(over)
    return {k: v for k, v in attrs.items() if v is not None}


async def _goal(client, ctx, key="activation", attrs=None, **body) -> dict:
    return await entity(client, ctx, type="goal", key=key, attrs=attrs or {}, **body)


# --- unit: checks and goal_check --------------------------------------------------------


# protects=no goal stores a number without saying what it counts; fails_when=a target saves
# without unit or comparison; no_claim=whether the number is sensible.
def test_target_needs_unit():
    codes = [p["code"] for p in goals.field_problems({"target": 45})]
    assert codes == ["target_needs_unit"]
    assert goals.field_problems({"target": 45, "unit": "%", "comparison": "at_least"}) == []


# protects=each refusal of 3.1 has its code and its field; fails_when=a bad value passes or
# names the wrong code; no_claim=the owner's membership (needs the database, below).
@pytest.mark.parametrize(
    ("attrs", "code", "where"),
    [
        ({"unit": "Percent!", "comparison": "at_least", "target": 1}, "bad_unit", "unit"),
        ({"unit": "%", "comparison": "more", "target": 1}, "bad_comparison", "comparison"),
        ({"unit": "%", "comparison": "at_least", "target": "45%"}, "target_not_number", "target"),
        ({"unit": "%", "comparison": "at_least", "target": -1}, "percent_negative", "target"),
        ({"current": 3}, "current_needs_date", "current"),
        ({"current": 3, "current_as_of": "2026-10-21"}, "current_date_future", "current_as_of"),
        ({"horizon": "2026-Q4"}, "bad_horizon", "horizon"),
        ({"owner": "Growth Lead"}, "owner_not_member", "owner"),
        ({"weight": 0}, "weight_out_of_range", "weight"),
        ({"weight": 11}, "weight_out_of_range", "weight"),
        ({"metric": "x"}, "bad_metric", "metric"),
        ({"due": "Dec 31"}, "bad_date", "due"),
    ],
)
def test_each_bad_field_has_its_code(attrs, code, where):
    found = goals.field_problems(attrs, on=TODAY)
    assert {"code": code, "where": f"attrs.{where}"} in [
        {"code": p["code"], "where": p["where"]} for p in found
    ]


# protects=units are the listed ones or a counted noun; fails_when=a noun with capitals or
# digits passes, or "teams" fails; no_claim=currency symbols (the form maps them).
def test_units():
    for ok in ("%", "USD", "EUR", "GBP", "ms", "s", "min", "h", "days", "teams", "active clinics"):
        assert goals.unit_ok(ok), ok
    for bad in ("$", "Teams", "users2", "a" * 25, ""):
        assert not goals.unit_ok(bad), bad


# protects=criterion 5: missing lists exactly the absent fields in 3.2's order; fails_when=
# the order changes or a present field is listed; no_claim=warnings (next test).
def test_goal_check_missing_in_order():
    assert goals.goal_check({}, on=TODAY)["missing"] == list(goals.MEASURABLE)
    out = goals.goal_check({"metric": "Setups", "horizon": "short"}, on=TODAY)
    assert out == {
        "measurable": False,
        "missing": ["unit", "comparison", "target", "owner"],
        "warnings": [],
    }
    full = {"metric": "Setups", "unit": "%", "comparison": "at_least", "target": 45,
            "horizon": "short", "owner": str(uuid.uuid4())}  # fmt: skip
    assert goals.goal_check(full, on=TODAY) == {"measurable": True, "missing": [], "warnings": []}


# protects=criterion 5: each warning fires on its fixture and not otherwise; fails_when=a
# warning is missing or fires on a clean goal; no_claim=how the UI shows them.
def test_goal_check_warnings():
    base = {"metric": "Setups", "unit": "%", "comparison": "at_least", "target": 45,
            "horizon": "short", "owner": str(uuid.uuid4())}  # fmt: skip

    def warn(status=None, **over):
        return goals.goal_check({**base, **over}, status=status, on=TODAY)["warnings"]

    assert warn(start=31) == []
    assert warn(start=50) == ["target_already_met"]
    assert warn(current=45, current_as_of="2026-10-01") == ["target_already_met"]
    assert warn(comparison="above", current=45, current_as_of="2026-10-01") == []
    assert warn(due="2026-12-31") == []
    assert warn(due="2027-03-31") == ["due_outside_horizon"]
    assert warn(horizon="medium", due="2027-03-31") == []
    assert warn(horizon="long", due="2028-01-31") == []
    assert warn(due="2026-10-01") == []
    assert warn("confirmed", horizon="medium", due="2026-10-01") == [
        "due_outside_horizon",
        "due_past",
    ]
    assert warn(current=10, current_as_of="2026-09-10") == []
    assert warn(current=10, current_as_of="2026-09-10", status="x") == []
    assert warn(current=10, current_as_of="2026-08-01") == ["stale_current"]


# protects=the text port reads goal text like Home does (parity cases from
# web/e2e/goal-maths.spec.ts and _goals.ts); fails_when=a figure, unit, range or direction
# reads differently; no_claim=Home's distances.
@pytest.mark.parametrize(
    ("raw", "value", "unit", "currency", "rng"),
    [
        ("45%", 45, "%", "", None),
        ("400 clinics by 2027", 400, "clinics", "", None),
        ("FY26 revenue $4M", 4_000_000, "", "$", None),
        ("p95 < 200ms", 200, "ms", "", None),
        ("10-15%", 10, "%", "", (10, 15)),
        ("below 8%", 8, "%", "", None),
        ("1,200 teams", 1200, "teams", "", None),
        ("under 2 min", 2, "min", "", None),
        (38, 38, "", "", None),
    ],
)
def test_parse_figure_parity(raw, value, unit, currency, rng):
    f = figures.parse_figure(raw)
    assert f is not None
    assert (f.value, f.unit, f.currency, f.range) == (value, unit, currency, rng)


def test_parse_figure_none_and_direction():
    assert figures.parse_figure("soon") is None
    assert figures.parse_figure(True) is None
    assert figures.direction("below 8%") == figures.Direction("down", True)
    assert figures.direction("at most 2 min") == figures.Direction("down", False)
    assert figures.direction("more than 400 teams") == figures.Direction("up", True)
    assert figures.direction("at least 45%") == figures.Direction("up", False)
    assert figures.direction("45%") is None
    assert figures.period_end("2026-Q4") == date(2026, 12, 31)
    assert figures.period_end("2027-H1") == date(2027, 6, 30)
    assert figures.period_end("2026-Q3") == date(2026, 9, 30)


def test_target_words():
    attrs = {"metric": "New accounts that finish setup within 7 days", "unit": "%",
             "comparison": "at_least", "target": 45, "horizon": "short",
             "due": "2026-12-31"}  # fmt: skip
    assert goals.target_words(attrs) == (
        "at least 45% (new accounts that finish setup within 7 days), short horizon, due 2026-12-31"
    )
    assert goals.target_words({"metric": "x", "target_text": "45%"}) is None


# --- API: write paths ---------------------------------------------------------------------


# protects=criterion 1: the full typed set saves and reads measurable; fails_when=a valid
# goal is refused or goal_check is absent; no_claim=the UI.
async def test_patch_full_typed_set_is_measurable(client, ctx):
    goal = await _goal(client, ctx)
    assert goal["goal_check"]["measurable"] is False
    resp = await client.patch(
        f"{B}/entities/{goal['id']}", json={"attrs": typed(ctx)}, headers=ctx.as_("approver")
    )
    assert resp.status_code == 200, resp.text
    out = resp.json()["entity"]
    assert out["goal_check"] == {"measurable": True, "missing": [], "warnings": []}
    assert out["attrs"]["target"] == 45
    feat = await entity(client, ctx, type="feature", key="guided-setup")
    assert feat["goal_check"] is None


# protects=criteria 2 and 10: each refusal is 422 with its code and nothing is written;
# a non-member, a disabled member and a typed name are owner_not_member; fails_when=a bad
# field saves or the body lacks the code; no_claim=the UI's error placement.
async def test_bad_fields_are_422_and_nothing_written(client, ctx):
    goal = await _goal(client, ctx, attrs={"metric": "Setups"})
    async with tenant_session(ctx.tenant_id) as s:
        await s.execute(
            update(type(ctx.users["viewer"]))
            .where(type(ctx.users["viewer"]).id == ctx.users["viewer"].id)
            .values(disabled_at=date(2026, 1, 1))
        )
        await s.commit()
    cases = [
        ({"target": 45}, "target_needs_unit"),
        (typed(ctx, unit="Percent!"), "bad_unit"),
        (typed(ctx, comparison="more"), "bad_comparison"),
        (typed(ctx, target="45%"), "target_not_number"),
        (typed(ctx, target=-5), "percent_negative"),
        (typed(ctx, current=38), "current_needs_date"),
        (typed(ctx, current=38, current_as_of="2999-01-01"), "current_date_future"),
        (typed(ctx, horizon="2026-Q4"), "bad_horizon"),
        (typed(ctx, owner=str(uuid.uuid4())), "owner_not_member"),
        (typed(ctx, owner=str(ctx.users["viewer"].id)), "owner_not_member"),
        (typed(ctx, owner="Growth Lead"), "owner_not_member"),
        (typed(ctx, weight=12), "weight_out_of_range"),
    ]
    for attrs, code in cases:
        resp = await client.patch(
            f"{B}/entities/{goal['id']}", json={"attrs": attrs}, headers=ctx.as_("approver")
        )
        assert resp.status_code == 422, (code, resp.text)
        body = resp.json()
        assert body["detail"].startswith("goal fields rejected")
        assert code in [e["code"] for e in body["errors"]], (code, body)
        assert all(set(e) == {"code", "message", "where"} for e in body["errors"])
    revs = await client.get(f"{B}/entities/{goal['id']}/revisions", headers=ctx.as_("owner"))
    assert len(revs.json()) == 1
    now = (await client.get(f"{B}/entities/{goal['id']}", headers=ctx.as_("owner"))).json()
    assert now["attrs"] == {"metric": "Setups"}
    resp = await client.post(
        f"{B}/entities",
        json={"type": "goal", "key": "g2", "title": "G2", "attrs": {"target": 45}},
        headers=ctx.as_("approver"),
    )
    assert resp.status_code == 422
    assert resp.json()["errors"][0]["message"] == (
        "A target needs its unit and which way is success"
    )


# protects=criterion 3: a commenter's bad proposal is refused at creation; a valid one is
# accepted and locks the goal; fails_when=a bad proposal is stored or acceptance fails;
# no_claim=proposal sentences.
async def test_proposals_are_checked_at_creation(client, ctx):
    goal = await _goal(client, ctx, origin="agent")
    bad = await client.post(
        f"{B}/proposals",
        json={"op": "update", "kind": "entity", "entity_id": goal["id"],
              "fields": {"attrs": {"target": "about 40%"}}},
        headers=ctx.as_("commenter"),
    )  # fmt: skip
    assert bad.status_code == 422
    assert bad.json()["errors"][0]["code"] == "target_not_number"
    new = await client.post(
        f"{B}/proposals",
        json={"op": "create", "kind": "entity",
              "fields": {"type": "goal", "key": "g2", "title": "G2", "attrs": {"weight": 0}}},
        headers=ctx.as_("commenter"),
    )  # fmt: skip
    assert new.status_code == 422
    ok = await client.post(
        f"{B}/proposals",
        json={"op": "update", "kind": "entity", "entity_id": goal["id"],
              "fields": {"attrs": typed(ctx)}},
        headers=ctx.as_("commenter"),
    )  # fmt: skip
    assert ok.status_code == 201, ok.text
    resp = await client.post(f"{B}/proposals/{ok.json()['id']}/accept", headers=ctx.as_("approver"))
    assert resp.status_code == 200, resp.text
    now = (await client.get(f"{B}/entities/{goal['id']}", headers=ctx.as_("viewer"))).json()
    assert now["locked"] is True
    assert now["goal_check"]["measurable"] is True


# protects=criterion 10a: a goal that is not measurable is confirmed (allow, flagged) and a
# feature can trace to it; fails_when=confirm refuses it or the flag goes; no_claim=Home.
async def test_confirming_a_vague_goal_is_allowed(client, ctx):
    goal = await _goal(client, ctx, attrs={"metric": "Churn", "target_text": "below 8%"})
    out = await confirm(client, ctx, goal)
    assert out["status"] == "confirmed"
    assert out["goal_check"]["measurable"] is False
    feat = await entity(client, ctx, type="feature", key="exit-survey")
    assert (await edge(client, ctx, feat, goal, "supports", attrs={"contribution": 2}))["id"]


# protects=one vague goal never fails a run's merge (criterion 4); fails_when=the import
# raises or drops the value; no_claim=uses a hand-written baseline.yaml, not agent output.
async def test_yaml_keeps_bad_goal_field_as_text(client, ctx):
    doc = """\
version: 1
entities:
  - type: goal
    key: activation
    title: Raise activation
    attrs: {metric: activated accounts, target: "about 40%", weight: 3}
  - type: feature
    key: guided-setup
    title: Guided setup
"""
    resp = await client.post(
        f"{B}/yaml",
        content=doc.encode(),
        headers={**ctx.as_("approver"), "Content-Type": "application/yaml"},
    )
    assert resp.status_code == 200, resp.text
    result = resp.json()
    assert result["created"] == 2
    kept = [n for n in result["notes"] if n["code"] == "goal_field_kept_as_text"]
    assert len(kept) == 1 and "goal:activation" in kept[0]["message"]
    assert kept[0]["where"] == "entities[0].attrs.target"
    goals_ = (
        await client.get(f"{B}/entities", params={"type": "goal"}, headers=ctx.as_("viewer"))
    ).json()
    assert goals_[0]["attrs"] == {
        "metric": "activated accounts",
        "target_text": "about 40%",
        "weight": 3,
    }


# protects=an agent's write keeps a refused value as text instead of failing (conflict
# resolution and runs write this way); fails_when=it raises or drops the value;
# no_claim=proposals on locked goals.
async def test_agent_write_keeps_bad_value_as_text(client, ctx):
    goal = await _goal(client, ctx, origin="agent", attrs={"weight": "high"})
    assert goal["attrs"] == {"weight_text": "high"}


# protects=criterion 8: Fill from text applies, proposes on a locked goal, leaves a range as
# text and makes no model call; fails_when=any count or value differs; no_claim=the UI.
async def test_fill_from_text(client, ctx, frozen_today):
    first = await _goal(
        client, ctx, "activation", {"target_text": "45%", "horizon_text": "2026-Q4"}, origin="agent"
    )
    second = await _goal(client, ctx, "churn", {"target_text": "below 8%"})  # a person's: locked
    third = await _goal(client, ctx, "upsell", {"target_text": "10-15%"}, origin="agent")
    assert second["locked"] is True and first["locked"] is False
    resp = await client.post(f"{B}/goals/fill-from-text", headers=ctx.as_("commenter"))
    assert resp.status_code == 403
    resp = await client.post(f"{B}/goals/fill-from-text", headers=ctx.as_("approver"))
    assert resp.status_code == 200, resp.text
    out = resp.json()
    assert out["applied"] == 1 and out["proposed"] == 1
    assert out["left_as_text"] == [{"entity_id": third["id"], "field": "target", "text": "10-15%"}]
    a = (await client.get(f"{B}/entities/{first['id']}", headers=ctx.as_("viewer"))).json()
    assert a["attrs"] == {
        "target": 45,
        "unit": "%",
        "comparison": "at_least",
        "horizon": "short",
        "due": "2026-12-31",
    }
    proposals = (
        await client.get(f"{B}/proposals", params={"status": "open"}, headers=ctx.as_("viewer"))
    ).json()
    mine = [p for p in proposals if p["entity_id"] == second["id"]]
    assert len(mine) == 1
    attrs = mine[0]["payload"]["fields"]["attrs"]
    assert (attrs["target"], attrs["unit"], attrs["comparison"]) == (8, "%", "below")


# protects=criterion 9: goal-weighted scores read numeric weights as before; fails_when=a
# numeric weight is moved or changed by the checks; no_claim=the scoring formula.
async def test_numeric_weight_is_unchanged(client, ctx):
    goal = await _goal(client, ctx, attrs={"weight": 0.5})
    assert goal["attrs"] == {"weight": 0.5}
    async with tenant_session(ctx.tenant_id) as s:
        row = await s.get(Entity, uuid.UUID(goal["id"]))
        assert row.attrs["weight"] == 0.5
