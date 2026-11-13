"""Outcomes edits (Nov 13), Real refusal reasons: a refused prediction (422) says why in a
sentence a person reads, which the prediction form shows as it is. Made-up names only.

Every test states its card: protects (the observable), fails_when (the wrong result
it rejects), no_claim (what green does not prove)."""

from tests.outcome_helpers import outcome_world
from tests.test_roadmap import (  # noqa: F401 - fixtures
    owner,
    runtime,
)


async def test_a_refused_prediction_says_why(client, owner, runtime):  # noqa: F811
    """protects=a Down prediction above its baseline is refused with "a decrease prediction
    must be below its baseline" (the value error's own words); fails_when=the sentence is
    ungrammatical ("an decrease") or missing; no_claim=the web's reading of it."""
    tenant_id, auth = owner
    by_item = await outcome_world(client, auth, runtime, tenant_id)
    ship = by_item["shipping-step"]
    prediction = {"metric": "Late orders", "predicted": "42", "direction": "decrease",
                  "baseline_value": 38, "predicted_value": 42}  # fmt: skip
    resp = await client.patch(
        f"/v1/outcomes/{ship['id']}",
        json={"prediction": prediction, "lock_version": ship["lock_version"]},
        headers=auth,
    )
    assert resp.status_code == 422
    [error] = resp.json()["detail"]
    assert error["type"] == "value_error"
    assert error["msg"] == "Value error, a decrease prediction must be below its baseline"
