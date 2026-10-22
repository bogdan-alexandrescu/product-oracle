"""H3 Predicted versus actual, track record: assessed outcomes give each goal (and the
company) a factor in [0.5, 1.0] that lowers priority confidence; ``show`` only displays
it; below the minimum nothing applies; snapshots keep the factor they used. Against
Postgres.

Every test states its card: protects (the observable), fails_when (the wrong result
it rejects), no_claim (what green does not prove)."""

import uuid
from datetime import UTC, datetime, timedelta

import pytest
from sqlalchemy import select

from oracle.baseline.models import Entity
from oracle.priorities.scoring import FeatureInput, GoalLink, score_feature
from oracle.quality import calibration
from oracle.quality.models import OutcomeRecord
from oracle.tenancy import tenant_session
from oracle.tenant_settings import TenantSetting
from tests.test_roadmap import (  # noqa: F401 - fixtures
    as_user,
    owner,
    seed_baseline,
)

# --------------------------------------------------------------------------- unit


def test_factor_formula_floor_and_ceiling():
    """protects=criterion 6's formula and the "only lower it" bounds; fails_when=a good
    record lifts confidence above 1, a poor one drops below 0.5, or (3+1)/(4.2+1) is not
    0.77; no_claim=which outcomes are counted."""
    assert calibration.FLOOR == 0.5 and calibration.CEILING == 1.0
    assert calibration.factor(3, 4.2) == 0.77
    assert calibration.factor(6, 3.0) == 1.0
    assert calibration.factor(0, 6.0) == 0.5


def test_score_scales_by_the_factor_and_show_does_not():
    """protects=scoring multiplies confidence by the factor and explains it; with apply
    off the score is unchanged and the factor still shown; fails_when=the factor is
    ignored, applied under show, or missing from the explanation; no_claim=the database."""
    base = dict(
        id="f", key="pay", title="Pay", status="confirmed", attrs={"effort": 2, "confidence": 0.8},
        goals=[GoalLink("activation", "Raise activation", None, 2, "confirmed")],
    )  # fmt: skip
    plain = score_feature(FeatureInput(**base), "goal_weighted")
    assert "calibration" not in plain.explanation or plain.explanation["calibration"] is None
    basis = "Goal 'Raise activation': 3 of 6 assessed predictions held (expected 4.2)"
    tuned = score_feature(
        FeatureInput(**base, calibration=0.77, calibration_basis=basis, calibration_n=6),
        "goal_weighted",
    )
    assert tuned.score == pytest.approx(plain.score * 0.77, abs=1e-4)
    assert tuned.explanation["calibration"] == {
        "factor": 0.77, "applied": True, "basis": basis, "n": 6,
    }  # fmt: skip
    assert "track record" in tuned.explanation["formula"]
    shown = score_feature(
        FeatureInput(
            **base, calibration=0.77, calibration_basis=basis, calibration_n=6,
            calibration_apply=False,
        ),
        "goal_weighted",
    )  # fmt: skip
    assert shown.score == plain.score
    assert shown.explanation["calibration"]["applied"] is False


# --------------------------------------------------------------------------- integration


async def _assessed(tenant_id: uuid.UUID, verdicts: list[str], confidences: list[float]) -> None:
    async with tenant_session(tenant_id) as s:
        goal = await s.scalar(select(Entity).where(Entity.type == "goal"))
        now = datetime.now(UTC)
        for i, (v, c) in enumerate(zip(verdicts, confidences, strict=True)):
            s.add(
                OutcomeRecord(
                    title=f"Item {i}", goal_id=goal.id, status=v, confidence_at_prediction=c,
                    prediction={"metric": "activated accounts", "predicted": "42%"},
                    assessments=[], assessed_at=now - timedelta(days=10),
                )
            )  # fmt: skip
        # Older than a year and inconclusive ones never count.
        s.add(
            OutcomeRecord(
                title="Old", goal_id=goal.id, status="not_held", confidence_at_prediction=0.9,
                prediction={"metric": "m", "predicted": "1"}, assessments=[],
                assessed_at=now - timedelta(days=400),
            )
        )  # fmt: skip
        s.add(
            OutcomeRecord(
                title="Unclear", goal_id=goal.id, status="inconclusive",
                confidence_at_prediction=0.9, prediction={"metric": "m", "predicted": "1"},
                assessments=[], assessed_at=now,
            )
        )  # fmt: skip
        await s.commit()


SIX = (["held"] * 3 + ["not_held"] * 3, [0.8, 0.8, 0.7, 0.7, 0.6, 0.6])


async def test_track_record_lowers_priority_and_route_shows_it(client, owner):  # noqa: F811
    """protects=criteria 6 and 7: six assessed outcomes on a goal (3 held, sum 4.2) give
    0.77 on the route and on each feature serving it, whose score is 0.77 x before;
    fails_when=the old or inconclusive ones count, the factor misses a feature, or the
    score is unchanged; no_claim=goals with several factors (the smallest is used)."""
    tenant_id, auth = owner
    await seed_baseline(tenant_id)
    before = (await client.get("/v1/priorities", headers=auth)).json()
    before = {f["key"]: f for f in before["features"]}
    await _assessed(tenant_id, *SIX)

    cal = (await client.get("/v1/priorities/calibration", headers=auth)).json()
    assert cal["setting"] == "apply" and cal["min_outcomes"] == 5
    assert (cal["floor"], cal["ceiling"]) == (0.5, 1.0)
    assert cal["company"] == {"n": 6, "score": 3.0, "expected": 4.2, "factor": 0.77}
    [goal] = cal["goals"]
    assert (goal["title"], goal["n"], goal["held"], goal["factor"]) == (
        "Raise activation", 6, 3, 0.77,
    )  # fmt: skip

    after = (await client.get("/v1/priorities", headers=auth)).json()
    pay = next(f for f in after["features"] if f["key"] == "payment-step")
    c = pay["explanation"]["calibration"]
    assert c["factor"] == 0.77 and c["applied"] is True and c["n"] == 6
    assert c["basis"] == "Goal 'Raise activation': 3 of 6 assessed predictions held (expected 4.2)"
    assert pay["score"] == pytest.approx(before["payment-step"]["score"] * 0.77, abs=1e-3)
    assert "track record" in after["formula"]

    # A snapshot keeps the factor it used.
    resp = await client.post("/v1/priorities/snapshots", json={}, headers=auth)
    assert resp.status_code == 201, resp.text
    snap = (await client.get(f"/v1/priorities/snapshots/{resp.json()['id']}", headers=auth)).json()
    row = next(r for r in snap["ranking"] if r["key"] == "payment-step")
    assert row["explanation"]["calibration"]["factor"] == 0.77


async def test_show_setting_displays_without_applying(client, owner):  # noqa: F811
    """protects=criterion 6's show setting: the score stays, the factor is still shown;
    fails_when=show changes the score or hides the factor; no_claim=the settings screen."""
    tenant_id, auth = owner
    await seed_baseline(tenant_id)
    before = (await client.get("/v1/priorities", headers=auth)).json()
    await _assessed(tenant_id, *SIX)
    resp = await client.put(
        "/v1/settings/outcome_calibration", json={"value": "show"}, headers=auth
    )
    assert resp.status_code == 200, resp.text
    bad = await client.put("/v1/settings/outcome_calibration", json={"value": "x"}, headers=auth)
    assert bad.status_code == 422
    after = (await client.get("/v1/priorities", headers=auth)).json()
    pay = next(f for f in after["features"] if f["key"] == "payment-step")
    old = next(f for f in before["features"] if f["key"] == "payment-step")
    assert pay["score"] == old["score"]
    assert pay["explanation"]["calibration"] == {
        **pay["explanation"]["calibration"], "factor": 0.77, "applied": False,
    }  # fmt: skip
    cal = (await client.get("/v1/priorities/calibration", headers=auth)).json()
    assert cal["setting"] == "show"


async def test_below_the_minimum_nothing_applies(client, owner):  # noqa: F811
    """protects=criterion 6's minimum: four outcomes with the company also below five give
    no factor; fails_when=a factor applies on too few outcomes; no_claim=a lowered
    minimum (calibration_min_outcomes)."""
    tenant_id, auth = owner
    await seed_baseline(tenant_id)
    await _assessed(tenant_id, ["held", "not_held", "not_held", "not_held"], [0.8] * 4)
    cal = (await client.get("/v1/priorities/calibration", headers=auth)).json()
    assert cal["company"]["n"] == 4 and cal["company"]["factor"] is None
    assert cal["goals"][0]["factor"] is None
    ranking = (await client.get("/v1/priorities", headers=auth)).json()
    pay = next(f for f in ranking["features"] if f["key"] == "payment-step")
    assert pay["explanation"].get("calibration") is None


async def test_company_record_covers_goals_below_the_minimum(client, owner):  # noqa: F811
    """protects=the company-wide fallback: a goal with too few outcomes takes the
    company's factor; fails_when=such a goal gets none while the company has enough;
    no_claim=per-goal factors (test_track_record_lowers_priority_and_route_shows_it)."""
    tenant_id, auth = owner
    await seed_baseline(tenant_id)
    await _assessed(tenant_id, *SIX)
    async with tenant_session(tenant_id) as s:
        s.add(TenantSetting(key="calibration_min_outcomes", value=7))
        other = Entity(type="goal", key="retention", title="Keep buyers", status="confirmed",
                       origin="user")  # fmt: skip
        s.add(other)
        await s.flush()
        for i in range(2):
            s.add(
                OutcomeRecord(
                    title=f"R{i}", goal_id=other.id, status="held", confidence_at_prediction=0.5,
                    prediction={"metric": "m", "predicted": "1"}, assessments=[],
                    assessed_at=datetime.now(UTC),
                )
            )  # fmt: skip
        await s.commit()
    cal = (await client.get("/v1/priorities/calibration", headers=auth)).json()
    # Company: 8 outcomes, score 5, expected 5.2: (5+1)/(5.2+1) = 0.97.
    assert cal["company"]["n"] == 8 and cal["company"]["factor"] == 0.97
    ranking = (await client.get("/v1/priorities", headers=auth)).json()
    pay = next(f for f in ranking["features"] if f["key"] == "payment-step")
    assert pay["explanation"]["calibration"]["factor"] == 0.97
    assert pay["explanation"]["calibration"]["basis"].startswith("Company:")
