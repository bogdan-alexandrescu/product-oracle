"""H3 Predicted versus actual, capture: approving a roadmap version records one
``predicted`` outcome per item that serves a confirmed goal, filled from the goal, the
feature's outcome entity and the item; editing the prediction while predicted, frozen
once shipped; the "Add predictions" Inbox row; filters, run-token reads and isolation.
Against Postgres with the FakeRuntime.

Every test states its card: protects (the observable), fails_when (the wrong result
it rejects), no_claim (what green does not prove)."""

import pytest
from pydantic import ValidationError
from sqlalchemy import select

from oracle.models import AuditEvent
from oracle.quality.schemas import PredictionIn
from oracle.tenancy import tenant_session
from tests.launch_helpers import approve_roadmap
from tests.outcome_helpers import outcome_world, set_record
from tests.roadmap_helpers import other_company
from tests.test_roadmap import (  # noqa: F401 - fixtures
    as_user,
    owner,
    runtime,
)

# --------------------------------------------------------------------------- unit


def _p(**kw) -> dict:
    return {"metric": "activated accounts", "predicted": "42%", **kw}


def test_typed_prediction_must_move_in_its_direction():
    """protects=criterion 3's 422 rule; fails_when=a prediction below its baseline is
    accepted as an increase, or one above it as a decrease; no_claim=the route."""
    with pytest.raises(ValidationError):
        PredictionIn(**_p(direction="increase", baseline_value=38, predicted_value=30))
    with pytest.raises(ValidationError):
        PredictionIn(**_p(direction="decrease", baseline_value=38, predicted_value=40))
    with pytest.raises(ValidationError):
        PredictionIn(**_p(direction="increase", baseline_value=38, predicted_value=38))
    ok = PredictionIn(**_p(direction="decrease", baseline_value=12, predicted_value=8))
    assert ok.predicted_value == 8


def test_threshold_lies_between_baseline_and_prediction():
    """protects=the partly-held line sits between baseline and prediction; fails_when=a
    line beyond the prediction or behind the baseline is accepted; no_claim=text fields."""
    with pytest.raises(ValidationError):
        PredictionIn(
            **_p(direction="increase", baseline_value=38, predicted_value=42, threshold_value=45)
        )
    with pytest.raises(ValidationError):
        PredictionIn(
            **_p(direction="increase", baseline_value=38, predicted_value=42, threshold_value=30)
        )
    ok = PredictionIn(
        **_p(direction="increase", baseline_value=38, predicted_value=42, threshold_value=40)
    )
    assert ok.threshold_value == 40


# --------------------------------------------------------------------------- integration


async def test_approving_a_roadmap_captures_predictions_once(client, owner, runtime):  # noqa: F811
    """protects=criterion 1: one predicted record per item serving a confirmed goal, with
    goal, confidence and by set; none again on re-approval; none for an item with no goal;
    fails_when=an item without a feature gets a record, a field is empty, or approving
    again adds records; no_claim=roadmaps without traced features."""
    tenant_id, auth = owner
    by_item = await outcome_world(client, auth, runtime, tenant_id)
    assert set(by_item) == {"payment-step", "shipping-step"}
    pay, ship = by_item["payment-step"], by_item["shipping-step"]
    for r in (pay, ship):
        assert r["status"] == "predicted"
        assert r["goal_id"] and r["roadmap_item_id"] and r["track_id"]
        assert r["prediction"]["by"]
    # The item's word: high = 0.8, medium = 0.5.
    assert pay["confidence_at_prediction"] == 0.8
    assert ship["confidence_at_prediction"] == 0.5
    # payment-step: the outcome entity's 42 against the goal's current 38, upward.
    p = pay["prediction"]
    assert (p["baseline_value"], p["predicted_value"], p["unit"], p["direction"]) == (
        38,
        42,
        "%",
        "increase",
    )
    assert pay["needs_prediction"] is False
    assert ship["needs_prediction"] is True and ship["prediction"]["predicted_value"] is None

    await approve_roadmap(client, auth)
    assert len((await client.get("/v1/outcomes", headers=auth)).json()) == 2


async def test_add_predictions_inbox_row_for_the_approver(client, owner, runtime):  # noqa: F811
    """protects=criterion 2: the approver sees one counted "Add predictions" row naming the
    count; filling the prediction removes it; fails_when=no row, one row per item, or the
    row stays after the prediction is added; no_claim=the Inbox screen."""
    tenant_id, auth = owner
    by_item = await outcome_world(client, auth, runtime, tenant_id)
    inbox = (await client.get("/v1/inbox", headers=auth)).json()
    rows = [r for r in inbox["outcomes"] if r["reason"] == "needs_prediction"]
    assert len(rows) == 1
    assert rows[0]["counts"] is True and rows[0]["count"] == 1
    assert rows[0]["title"].startswith("Add predictions · ")
    assert rows[0]["title"].endswith(" · 1 item")
    before = inbox["total"]

    ship = by_item["shipping-step"]
    resp = await client.patch(
        f"/v1/outcomes/{ship['id']}",
        json={
            "prediction": {**ship["prediction"], "baseline_value": 38, "predicted_value": 41,
                           "threshold_value": 40, "direction": "increase", "unit": "%"},
            "lock_version": ship["lock_version"],
        },
        headers=auth,
    )  # fmt: skip
    assert resp.status_code == 200, resp.text
    assert resp.json()["needs_prediction"] is False
    inbox = (await client.get("/v1/inbox", headers=auth)).json()
    assert [r for r in inbox["outcomes"] if r["reason"] == "needs_prediction"] == []
    assert inbox["total"] == before - 1


async def test_prediction_edits_validated_audited_and_frozen(client, owner, runtime):  # noqa: F811
    """protects=criterion 3: a downward prediction for an increase is 422, an edit while
    predicted is audited, any prediction edit once tracking is 409 with the frozen words;
    fails_when=a bad prediction is stored or a shipped one changes; no_claim=owner edits."""
    tenant_id, auth = owner
    pay = (await outcome_world(client, auth, runtime, tenant_id))["payment-step"]
    url = f"/v1/outcomes/{pay['id']}"
    bad = {**pay["prediction"], "direction": "increase", "baseline_value": 38,
           "predicted_value": 30}  # fmt: skip
    resp = await client.patch(
        url, json={"prediction": bad, "lock_version": pay["lock_version"]}, headers=auth
    )
    assert resp.status_code == 422, resp.text

    good = {**pay["prediction"], "predicted_value": 43, "predicted": "43%"}
    resp = await client.patch(
        url, json={"prediction": good, "lock_version": pay["lock_version"]}, headers=auth
    )
    assert resp.status_code == 200, resp.text
    edited = resp.json()
    assert edited["prediction"]["predicted_value"] == 43
    async with tenant_session(tenant_id) as s:
        actions = (
            await s.scalars(
                select(AuditEvent.action).where(AuditEvent.action == "outcome.prediction_edited")
            )
        ).all()
    assert actions == ["outcome.prediction_edited"]

    await set_record(tenant_id, pay["id"], status="tracking")
    current = (await client.get(url, headers=auth)).json()
    resp = await client.patch(
        url, json={"prediction": good, "lock_version": current["lock_version"]}, headers=auth
    )
    assert resp.status_code == 409
    assert resp.json()["detail"] == "Shipped: the prediction is frozen"


async def test_filters_viewers_and_run_tokens(client, owner, runtime):  # noqa: F811
    """protects=GET /v1/outcomes filters by state and needs_prediction; viewers read but
    never edit; a read:baseline run token reads outcomes and the calibration; fails_when=a
    filter leaks other states, a viewer edits, or a run token is refused a read;
    no_claim=MCP tool names beyond the two read here."""
    from oracle.mcp.scopes import required_scope

    tenant_id, auth = owner
    by_item = await outcome_world(client, auth, runtime, tenant_id)
    got = (await client.get("/v1/outcomes?needs_prediction=true", headers=auth)).json()
    assert [r["roadmap_item_key"] for r in got] == ["shipping-step"]
    got = (await client.get("/v1/outcomes?state=predicted", headers=auth)).json()
    assert len(got) == 2
    assert (await client.get("/v1/outcomes?state=due", headers=auth)).json() == []
    assert (await client.get("/v1/outcomes?state=assessed", headers=auth)).json() == []

    viewer = await as_user(tenant_id, "viewer")
    pay = by_item["payment-step"]
    assert (await client.get(f"/v1/outcomes/{pay['id']}", headers=viewer)).status_code == 200
    resp = await client.patch(
        f"/v1/outcomes/{pay['id']}",
        json={"prediction": pay["prediction"], "lock_version": pay["lock_version"]},
        headers=viewer,
    )
    assert resp.status_code == 403
    resp = await client.post(f"/v1/outcomes/{pay['id']}/shipped", json={}, headers=viewer)
    assert resp.status_code == 403

    assert required_scope("GET", "/v1/outcomes") == "read:baseline"
    assert required_scope("GET", "/v1/priorities/calibration") == "read:baseline"
    assert required_scope("GET", "/v1/learnings") == "read:baseline"
    assert required_scope("PATCH", "/v1/outcomes/{outcome_id}") is None
    from tests.test_mcp import mcp_client, run_token, text_of, user_with_role

    pm = await user_with_role(tenant_id, "owner")
    token = await run_token(tenant_id, ["read:baseline"], pm.id)
    async with mcp_client(token) as c:
        got = await c.call_tool("get_priority_calibration", {})
        assert not got.is_error, text_of(got)
        assert got.structured_content["floor"] == 0.5
        got = await c.call_tool("list_outcomes", {})
        assert not got.is_error, text_of(got)


async def test_another_companys_outcomes_are_404(client, owner, runtime):  # noqa: F811
    """protects=criterion 8: every outcome route is 404 for another company's ids;
    fails_when=another company reads, edits, ships or assesses a record; no_claim=database
    isolation beyond the tenant session."""
    tenant_id, auth = owner
    pay = (await outcome_world(client, auth, runtime, tenant_id))["payment-step"]
    url = f"/v1/outcomes/{pay['id']}"
    other = await other_company()
    calls = [
        ("GET", url, None),
        ("PATCH", url, {"prediction": pay["prediction"], "lock_version": 1}),
        ("POST", f"{url}/shipped", {}),
        ("POST", f"{url}/assessments", {"verdict": "held", "observed": "41%"}),
    ]
    for method, path, body in calls:
        resp = await client.request(method, path, json=body, headers=other)
        assert resp.status_code == 404, (method, path, resp.status_code, resp.text)
    assert (await client.get("/v1/outcomes", headers=other)).json() == []
    cal = (await client.get("/v1/priorities/calibration", headers=other)).json()
    assert cal["goals"] == [] and cal["company"]["n"] == 0
