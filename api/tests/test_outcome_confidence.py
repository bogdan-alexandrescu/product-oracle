"""Outcomes edits (Nov 13), Confidence and why: a prediction carries a Confidence (Low,
Medium, High) and a one-line Why; both are stored with it, and Confidence is the confidence
at prediction the Priorities track record reads (expected). Made-up names only.

Every test states its card: protects (the observable), fails_when (the wrong result
it rejects), no_claim (what green does not prove)."""

from datetime import UTC, datetime

from tests.outcome_helpers import outcome_world, set_record
from tests.test_roadmap import (  # noqa: F401 - fixtures
    owner,
    runtime,
)


async def test_confidence_and_why_are_stored_and_feed_the_track_record(client, owner, runtime):  # noqa: F811
    """protects=PATCH stores confidence and why in the prediction and sets the confidence
    at prediction (High = 0.8, as Priorities' confidence words); the track record's expected
    reads it once assessed; a word outside Low, Medium, High is refused; fails_when=either is
    dropped or the track record keeps the old figure; no_claim=the inspector's wording."""
    tenant_id, auth = owner
    by_item = await outcome_world(client, auth, runtime, tenant_id)
    ship = by_item["shipping-step"]
    url = f"/v1/outcomes/{ship['id']}"
    prediction = {
        "metric": "Orders shipped on time",
        "predicted": "95%",
        "unit": "%",
        "direction": "increase",
        "baseline_value": 90,
        "predicted_value": 95,
        "confidence": "high",
        "why": "Two carriers already pick up twice a day",
    }
    lock = ship["lock_version"]
    bad = {"prediction": {**prediction, "confidence": "certain"}, "lock_version": lock}
    assert (await client.patch(url, json=bad, headers=auth)).status_code == 422
    resp = await client.patch(
        url, json={"prediction": prediction, "lock_version": lock}, headers=auth
    )
    assert resp.status_code == 200, resp.text
    saved = resp.json()
    assert saved["prediction"]["confidence"] == "high"
    assert saved["prediction"]["why"] == "Two carriers already pick up twice a day"
    assert saved["confidence_at_prediction"] == 0.8

    await set_record(tenant_id, ship["id"], status="held", assessed_at=datetime.now(UTC))
    record = (await client.get("/v1/priorities/calibration", headers=auth)).json()
    assert record["company"]["n"] == 1 and record["company"]["expected"] == 0.8
