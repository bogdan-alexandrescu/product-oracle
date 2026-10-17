"""Priorities: each scoring method and its explanation, dependency order, cycles,
features that serve no confirmed goal, and snapshots."""

import uuid
from decimal import Decimal

import pytest
from sqlalchemy import update

from oracle.auth.models import ApiToken
from oracle.auth.service import create_api_token
from oracle.baseline.models import Edge, Entity, Evidence
from oracle.priorities.scoring import EvidenceRef, FeatureInput, GoalLink, rank, score_feature
from oracle.tenancy import tenant_session
from tests.conftest import make_tenant


def feature(key: str, *, goals=(), attrs=None, deps=(), evidence=(), stored=None) -> FeatureInput:
    return FeatureInput(
        id=f"id-{key}",
        key=key,
        title=key.title(),
        status="confirmed",
        attrs=attrs or {},
        stored_confidence=stored,
        evidence=[EvidenceRef(id=f"e{i}", confidence=c, ref=None) for i, c in enumerate(evidence)],
        goals=[GoalLink(g, g.upper(), w, c, "confirmed") for g, w, c in goals],
        depends_on=list(deps),
    )


# --- methods ----------------------------------------------------------------------


def test_goal_weighted_sums_goals_times_confidence_over_effort():
    f = feature(
        "checkout",
        goals=[("activation", 3, 2), ("revenue", 2, 1)],
        attrs={"effort": 4},
        evidence=[0.8, 0.6],
    )
    s = score_feature(f, "goal_weighted")
    # (3*2 + 2*1) * 0.7 / 4
    assert s.score == pytest.approx(1.4)
    e = s.explanation
    assert e["formula"].startswith("score = Σ(goal weight × contribution)")
    assert e["confidence"]["source"] == "evidence"
    assert e["confidence"]["value"] == pytest.approx(0.7)
    assert [ev["confidence"] for ev in e["confidence"]["evidence"]] == [0.8, 0.6]
    assert [(t["goal"], t["term"]) for t in e["goals"]] == [("activation", 6), ("revenue", 2)]
    assert e["inputs"]["effort"]["value"] == 4
    assert any("= 1.4" in step for step in e["steps"])
    assert s.flags == []


def test_confidence_falls_back_to_stored_then_attrs_then_default():
    base = {"goals": [("g", 1, 1)], "attrs": {"effort": 1}}
    assert (
        score_feature(feature("a", stored=0.9, **base), "goal_weighted").explanation["confidence"][
            "source"
        ]
        == "baseline"
    )
    attrs = score_feature(
        feature("b", goals=[("g", 1, 1)], attrs={"effort": 1, "confidence": "low"}), "goal_weighted"
    )
    assert attrs.explanation["confidence"] == {
        "value": 0.3,
        "source": "attrs",
        "explain": "attrs.confidence 'low' read as 0.3",
        "evidence": [],
    }
    assert "low_confidence" in attrs.flags
    pct = score_feature(
        feature("c", goals=[("g", 1, 1)], attrs={"effort": 1, "confidence": 80}), "goal_weighted"
    )
    assert pct.explanation["confidence"]["value"] == 0.8
    default = score_feature(feature("d", **base), "goal_weighted")
    assert default.explanation["confidence"]["source"] == "default"
    assert "no_confidence" in default.flags


def test_assumed_weight_and_contribution_are_marked():
    f = feature("x", goals=[("g", None, None)], attrs={"effort": "M"}, evidence=[1.0])
    s = score_feature(f, "goal_weighted")
    term = s.explanation["goals"][0]
    assert term["weight_assumed"] and term["contribution_assumed"]
    assert s.explanation["inputs"]["effort"]["value"] == 2  # t-shirt M
    assert s.score == pytest.approx(0.5)


def test_missing_effort_is_not_scored_and_flagged():
    s = score_feature(feature("x", goals=[("g", 1, 3)]), "goal_weighted")
    assert s.score is None
    assert s.explanation["missing"] == ["effort"]
    assert "missing_inputs" in s.flags
    assert s.group == 1


def test_rice():
    f = feature(
        "x",
        goals=[("g", 1, 1)],
        attrs={"reach": 500, "impact": 2, "effort": 5},
        evidence=[0.5],
    )
    s = score_feature(f, "rice")
    assert s.score == pytest.approx(100)
    assert s.explanation["formula"] == "score = reach × impact × confidence ÷ effort"
    assert {"reach", "impact", "effort"} <= set(s.explanation["inputs"])
    assert s.explanation["steps"] == ["score = 500 × 2 × 0.5 ÷ 5 = 100.0"]
    missing = score_feature(feature("y", goals=[("g", 1, 1)], attrs={"effort": 1}), "rice")
    assert missing.score is None and missing.explanation["missing"] == ["reach", "impact"]


def test_wsjf():
    f = feature(
        "x",
        goals=[("g", 1, 1)],
        attrs={"business_value": 8, "time_criticality": 5, "risk_reduction": 3, "job_size": 4},
    )
    s = score_feature(f, "wsjf")
    assert s.score == pytest.approx(4)
    assert s.explanation["steps"] == ["cost of delay = 8 + 5 + 3 = 16", "score = 16 ÷ 4 = 4.0"]


def test_moscow_orders_by_category_then_goal_value():
    features = [
        feature("could", goals=[("g", 5, 3)], attrs={"moscow": "could"}),
        feature("must-small", goals=[("g", 1, 1)], attrs={"moscow": "Must"}),
        feature("must-big", goals=[("g", 3, 3)], attrs={"moscow": "must"}),
        feature("wont", goals=[("g", 1, 1)], attrs={"moscow": "won't"}),
        feature("unset", goals=[("g", 1, 1)]),
    ]
    result = rank(features, "moscow")
    assert [r["key"] for r in result["features"]] == [
        "must-big",
        "must-small",
        "could",
        "wont",
        "unset",
    ]
    assert result["features"][-1]["flags"] == ["missing_inputs", "no_confidence"]


# --- order --------------------------------------------------------------------------


def test_features_serving_no_goal_sink_and_are_flagged():
    features = [
        feature("orphan", attrs={"effort": 0.1}, evidence=[1.0]),
        feature("low", goals=[("g", 1, 1)], attrs={"effort": 10}),
        feature("high", goals=[("g", 3, 3)], attrs={"effort": 1}),
    ]
    rows = rank(features)["features"]
    assert [r["key"] for r in rows] == ["high", "low", "orphan"]
    orphan = rows[-1]
    assert not orphan["serves_goal"]
    assert "no_confirmed_goal" in orphan["flags"]
    assert orphan["score"] == 0  # no goal value


def test_dependencies_come_first_and_pull_prerequisites_up():
    features = [
        feature("top", goals=[("g", 3, 3)], attrs={"effort": 1}, deps=["base"]),
        feature("mid", goals=[("g", 2, 2)], attrs={"effort": 1}),
        feature("base", goals=[("g", 1, 1)], attrs={"effort": 1}),
        feature("infra", attrs={"effort": 1}),  # serves no goal, but "mid" needs it
    ]
    features[1].depends_on = ["infra"]
    rows = rank(features)["features"]
    order = [r["key"] for r in rows]
    assert order == ["base", "top", "infra", "mid"]
    base = rows[0]
    assert base["score_rank"] == 3 and base["rank"] == 1
    assert "moved_for_dependency" in base["flags"]
    assert base["explanation"]["order"] == ["placed earlier because top depend(s) on it"]
    assert rows[1]["explanation"]["order"] == ["placed after its prerequisite(s) base"]
    infra = rows[2]
    assert "no_confirmed_goal" in infra["flags"] and "moved_for_dependency" in infra["flags"]
    assert infra["dependents"] == ["mid"]


def test_cycles_are_reported_not_hidden():
    features = [
        feature("a", goals=[("g", 1, 3)], attrs={"effort": 1}, deps=["b"]),
        feature("b", goals=[("g", 1, 1)], attrs={"effort": 1}, deps=["c"]),
        feature("c", goals=[("g", 1, 2)], attrs={"effort": 1}, deps=["a"]),
        feature("d", goals=[("g", 1, 1)], attrs={"effort": 2}, deps=["a"]),
    ]
    result = rank(features)
    assert result["cycles"] == [["a", "b", "c"]]
    rows = {r["key"]: r for r in result["features"]}
    for key in "abc":
        assert "dependency_cycle" in rows[key]["flags"]
    assert "dependency_cycle" not in rows["d"]["flags"]
    order = [r["key"] for r in result["features"]]
    # Every feature is listed once; the cycle stays together, by score; d after it.
    assert order == ["a", "c", "b", "d"]


# --- API ----------------------------------------------------------------------------


async def _token(tenant_id: uuid.UUID, role: str = "owner") -> dict[str, str]:
    async with tenant_session(tenant_id) as s:
        token, raw = await create_api_token(s, f"{role}-token")
        await s.execute(update(ApiToken).where(ApiToken.id == token.id).values(role=role))
        await s.commit()
    return {"Authorization": f"Bearer {raw}"}


async def _baseline(tenant_id: uuid.UUID) -> None:
    async with tenant_session(tenant_id) as s:

        def entity(type_, key, status="confirmed", **attrs):
            e = Entity(
                type=type_,
                key=key,
                title=key.replace("-", " ").title(),
                attrs=attrs,
                status=status,
                origin="user",
            )
            s.add(e)
            return e

        activation = entity("goal", "activation", weight=3)
        retention = entity("goal", "retention", weight=2)
        draft_goal = entity("goal", "draft-goal", status="proposed", weight=5)
        checkout = entity("feature", "checkout", effort=2)
        alerts = entity("feature", "usage-alerts", effort=1, confidence="high")
        theme = entity("feature", "dark-mode", effort=1)
        rejected = entity("feature", "rejected-idea", status="rejected", effort=1)
        await s.flush()

        def edge(src, dst, type_, **attrs):
            s.add(
                Edge(
                    src_id=src.id,
                    dst_id=dst.id,
                    type=type_,
                    attrs=attrs,
                    status="confirmed",
                    origin="user",
                )
            )

        edge(checkout, activation, "supports", contribution=3)
        edge(checkout, retention, "supports", contribution=1)
        edge(alerts, retention, "supports", contribution=2)
        edge(theme, draft_goal, "supports", contribution=3)  # goal not confirmed
        edge(alerts, checkout, "blocks")  # checkout waits for alerts
        edge(rejected, activation, "supports", contribution=3)
        s.add(
            Evidence(entity_id=checkout.id, url="https://example.com/a", confidence=Decimal("0.8"))
        )
        s.add(
            Evidence(entity_id=checkout.id, url="https://example.com/b", confidence=Decimal("0.6"))
        )
        s.add(Evidence(entity_id=checkout.id, url="https://example.com/unscored"))
        await s.commit()


async def test_api_ranks_baseline_features(client, tenant_id):
    await _baseline(tenant_id)
    headers = await _token(tenant_id, "viewer")
    resp = await client.get("/v1/priorities", headers=headers)
    assert resp.status_code == 200
    body = resp.json()
    assert body["method"] == "goal_weighted"
    rows = body["features"]
    assert [r["key"] for r in rows] == ["usage-alerts", "checkout", "dark-mode"]
    checkout = rows[1]
    # (3*3 + 2*1) * mean(0.8, 0.6) / 2 = 11 * 0.7 / 2
    assert checkout["score"] == pytest.approx(3.85)
    assert checkout["explanation"]["confidence"]["source"] == "evidence"
    assert len(checkout["explanation"]["confidence"]["evidence"]) == 2
    assert checkout["depends_on"] == ["usage-alerts"]
    alerts = rows[0]
    # 2*2 * 0.8 / 1 = 3.2: scored below checkout, placed above it as its prerequisite.
    assert alerts["score"] == pytest.approx(3.2) and alerts["score_rank"] == 2
    assert alerts["explanation"]["confidence"]["source"] == "attrs"
    dark = rows[2]
    assert dark["flags"] == ["no_confidence", "no_confirmed_goal"]
    assert body["counts"] == {"features": 3, "no_goal": 1, "unscored": 0, "in_cycles": 0}

    rice = (await client.get("/v1/priorities?method=rice", headers=headers)).json()
    assert rice["method"] == "rice"
    assert all(r["score"] is None for r in rice["features"])
    assert (await client.get("/v1/priorities?method=nope", headers=headers)).status_code == 422


async def test_snapshots_need_an_approver_and_store_the_ranking(client, tenant_id):
    await _baseline(tenant_id)
    viewer = await _token(tenant_id, "viewer")
    approver = await _token(tenant_id, "approver")
    payload = {"method": "goal_weighted", "note": "Q4 planning"}
    resp = await client.post("/v1/priorities/snapshots", json=payload, headers=viewer)
    assert resp.status_code == 403
    resp = await client.post("/v1/priorities/snapshots", json=payload, headers=approver)
    assert resp.status_code == 201
    snap = resp.json()
    assert snap["method"] == "goal_weighted"
    assert snap["note"] == "Q4 planning"
    assert [r["key"] for r in snap["ranking"]] == ["usage-alerts", "checkout", "dark-mode"]
    assert snap["params"]["formula"].startswith("score =")

    listed = (await client.get("/v1/priorities/snapshots", headers=viewer)).json()
    assert [s["id"] for s in listed] == [snap["id"]]
    assert listed[0]["top"] == ["usage-alerts", "checkout", "dark-mode"]
    got = await client.get(f"/v1/priorities/snapshots/{snap['id']}", headers=viewer)
    assert got.status_code == 200
    assert got.json()["ranking"][1]["explanation"]["confidence"]["value"] == 0.7
    missing = await client.get(f"/v1/priorities/snapshots/{uuid.uuid4()}", headers=viewer)
    assert missing.status_code == 404


async def test_priorities_are_tenant_scoped(client, tenant_id):
    await _baseline(tenant_id)
    other = await make_tenant("Other Co")
    resp = await client.get("/v1/priorities", headers=await _token(other))
    assert resp.json()["features"] == []
    assert (await client.get("/v1/priorities")).status_code == 401
