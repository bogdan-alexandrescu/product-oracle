"""Outcomes edits (Nov 13), Hold bets: a third prediction direction beside Up and Down,
"Hold at most": a level to stay at or under (0 account restrictions). The baseline may equal
the prediction; the partly-held mark is at or above it; the check marks Held at or under the
prediction, Partly held at or under the mark. Made-up names only.

Every test states its card: protects (the observable), fails_when (the wrong result
it rejects), no_claim (what green does not prove)."""

import pytest
from pydantic import ValidationError

from oracle.quality.schemas import PredictionIn
from oracle.quality.shipping import verdict
from tests.outcome_helpers import outcome_world
from tests.test_roadmap import (  # noqa: F401 - fixtures
    owner,
    runtime,
)

HOLD = {"metric": "Account restrictions", "predicted": "0", "direction": "hold",
        "baseline_value": 0, "predicted_value": 0, "threshold_value": 2}  # fmt: skip


def test_a_hold_bet_may_equal_its_baseline_and_its_mark_is_at_or_above():
    """protects=PredictionIn takes hold with the baseline equal to the prediction and a mark
    at or above it, and refuses a mark below it; fails_when=hold is refused or a mark under the
    prediction is taken; no_claim=the web form."""
    assert PredictionIn(**HOLD).direction == "hold"
    assert PredictionIn(**{**HOLD, "baseline_value": 3, "threshold_value": None}).direction
    with pytest.raises(ValidationError, match="at or above the prediction"):
        PredictionIn(**{**HOLD, "predicted_value": 2, "threshold_value": 1})


@pytest.mark.parametrize(
    ("actual", "want"),
    [(0, "held"), (-1, "held"), (1, "partially_held"), (2, "partially_held"), (3, "not_held")],
)
def test_the_check_reads_a_hold_bet(actual, want):
    """protects=Held at or under the prediction, Partly held at or under the mark, else Not
    held; fails_when=a hold is read as a rise or a fall; no_claim=where the actual comes from."""
    assert verdict(HOLD, actual) == want
    assert verdict({**HOLD, "threshold_value": None}, 1) == "not_held"


async def test_an_approver_saves_a_hold_prediction(client, owner, runtime):  # noqa: F811
    """protects=PATCH saves a hold prediction equal to its baseline; fails_when=it is refused
    as a decrease was; no_claim=the inspector's wording."""
    tenant_id, auth = owner
    by_item = await outcome_world(client, auth, runtime, tenant_id)
    ship = by_item["shipping-step"]
    resp = await client.patch(
        f"/v1/outcomes/{ship['id']}",
        json={"prediction": HOLD, "lock_version": ship["lock_version"]},
        headers=auth,
    )
    assert resp.status_code == 200, resp.text
    saved = resp.json()["prediction"]
    assert saved["direction"] == "hold" and saved["predicted_value"] == 0
