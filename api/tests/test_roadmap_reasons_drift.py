"""H4 §5 Drift checks in the roadmap items review: "Outside the strategy" and "Stopped in
the strategy" as reasons to confirm (drift is advisory: decided 2026-10-21, "Drift gate").

Each test's card: protects=<the observable>; fails_when=<the wrong result it rejects>;
no_claim=<what green does not prove>.
"""

import uuid

from oracle.runs.reasons import ItemDrift, ReasonContext, TracedFeature, reasons_for
from tests.strategy_helpers import STRATEGY, add_entity, approved, choice, imported, strategy_md
from tests.test_roadmap import (  # noqa: F401 - fixtures
    approved_prd,
    as_user,
    owner,
    runtime,
    seed_baseline,
)
from tests.test_roadmap_reasons import SECOND, item, roadmap_items_check


def ctx(**kw) -> ReasonContext:
    return ReasonContext(**{"low": 0.5, **kw})


STOP = uuid.uuid4()


def test_outside_and_stopped_are_reasons_to_confirm_with_their_fixes():
    """protects=each drift kind is one reason to confirm with its label, sentence and
    fixes (no plain Accept: a finding is acted on or waived with a reason);
    fails_when=a drift reason blocks, Accept is offered, or Move to Later is missing for a
    stopped item; no_claim=the drift rules themselves (test_strategy_drift)."""
    items = [item("pay", horizon="next"), item("push", horizon="later")]
    drift = {
        "pay": [
            ItemDrift("stopped_but_planned", "high", "The product strategy stops Custom "
                      "checkout, and this item is in Next.", ("custom-checkout",)),
        ],
        "push": [
            ItemDrift("outside_strategy", "warning", "Raise activation is under no focus "
                      "choice of the product strategy.", goals=("activation",)),
        ],
    }  # fmt: skip
    out = reasons_for(items, [], ctx(drift=drift))
    assert [(r["item"], r["code"], r["severity"], r["label"]) for r in out] == [
        ("pay", "stopped_but_planned", "confirm", "Stopped in the strategy"),
        ("push", "outside_strategy", "confirm", "Outside the strategy"),
    ]
    pay, push = out
    assert pay["text"] == "The product strategy stops Custom checkout, and this item is in Next."
    assert [f["label"] for f in pay["fixes"]] == ["Move to Later", "Drop", "Waive…"]
    assert pay["data"] == {"severity": "high", "choices": ["custom-checkout"], "goals": []}
    assert [f["label"] for f in push["fixes"]] == ["Drop", "Waive…"]
    assert push["data"]["goals"] == ["activation"]


def test_drift_reasons_follow_serves_no_goal_and_are_advisory_only():
    """protects=drift reasons come after the item's other reasons to confirm of the
    catalogue before them and never without a context; fails_when=they are listed first,
    or appear with only the blocking reasons; no_claim=none."""
    items = [item("push", horizon="now")]
    features = {"push": TracedFeature("mobile-push", "Mobile push", ("serves_no_goal",))}
    drift = {"push": [ItemDrift("stopped_but_planned", "high", "x.", ("c",))]}
    out = reasons_for(items, [], ctx(features=features, drift=drift))
    assert [r["code"] for r in out] == ["serves_no_goal", "stopped_but_planned"]
    assert reasons_for(items, [], ReasonContext(advisory=False, drift=drift)) == []


async def _strategy(client, auth, tenant_id) -> None:
    """A strategy whose focus is a goal other than activation, and that stops the payment
    step (seed_baseline: both features serve activation)."""
    await add_entity(tenant_id, "goal", "retention")
    md = strategy_md(
        [
            choice("retain", goals=["retention"], title="Retain teams"),
            choice("custom-checkout", "stop", features=["payment-step"], title="Custom checkout"),
        ]
    )
    await imported(client, auth, STRATEGY, md)
    await approved(client, auth, STRATEGY, 1)


async def test_the_review_shows_drift_against_the_approved_strategy(client, owner, runtime):  # noqa: F811
    """protects=the roadmap items check names the payment step (Next, its feature stopped,
    its goal under no focus) as stopped and outside the strategy, in words a person reads;
    an item with no traced feature gets serves_no_goal only; the counts are to confirm;
    fails_when=a drift reason is missing, blocks, or doubles serves_no_goal;
    no_claim=E1 per-draft roadmaps."""
    tenant_id, auth = owner
    await approved_prd(client, auth)
    await seed_baseline(tenant_id)
    await _strategy(client, auth, tenant_id)
    _, check = await roadmap_items_check(client, auth, runtime, SECOND)
    by = {(r["item"], r["code"]): r for r in check["reasons"]}
    stopped = by[("payment-step", "stopped_but_planned")]
    assert stopped["severity"] == "confirm"
    assert stopped["text"] == (
        "The product strategy stops Custom checkout, and this item is in Next."
    )
    outside = by[("payment-step", "outside_strategy")]
    assert outside["text"] == "Raise activation is under no focus choice of the product strategy."
    assert ("mobile-push", "outside_strategy") not in by
    assert ("mobile-push", "serves_no_goal") in by
    assert check["blocking"] == 1  # gift-cards' unknown section only


async def test_no_strategy_no_drift_reasons(client, owner, runtime):  # noqa: F811
    """protects=without an approved strategy the review adds no drift reason (no_strategy
    is a Plan banner only); fails_when=every item is outside a strategy that does not
    exist; no_claim=none."""
    tenant_id, auth = owner
    await approved_prd(client, auth)
    await seed_baseline(tenant_id)
    _, check = await roadmap_items_check(client, auth, runtime, SECOND)
    assert not {r["code"] for r in check["reasons"]} & {"outside_strategy", "stopped_but_planned"}


async def test_only_an_owner_waives_a_stopped_item_approvers_waive_outside(client, owner, runtime):  # noqa: F811
    """protects=the owner decision: approvers waive Outside the strategy with a reason, only
    an owner waives Stopped in the strategy; a waiver needs a reason; fails_when=an
    approver's stopped waiver is staged, or a reasonless waiver is accepted;
    no_claim=carrying the waiver to the stored finding after the roadmap's approval."""
    tenant_id, auth = owner
    await approved_prd(client, auth)
    await seed_baseline(tenant_id)
    await _strategy(client, auth, tenant_id)
    run, _ = await roadmap_items_check(client, auth, runtime, SECOND)
    cp = next(c for c in run["checkpoints"] if c["status"] == "pending")
    base = f"/v1/runs/{run['id']}/checkpoints/{cp['id']}/actions"
    approver = await as_user(tenant_id, "approver")

    def waive(code: str, reason: str = "Committed to the pilot customer") -> dict:
        return {"item_key": "payment-step", "kind": "waive", "answers": [code],
                "value": {"reason": reason}}  # fmt: skip

    resp = await client.post(base, json=waive("stopped_but_planned"), headers=approver)
    assert resp.status_code == 403, resp.text
    assert "owner" in resp.json()["detail"]
    resp = await client.post(base, json=waive("outside_strategy", " "), headers=approver)
    assert resp.status_code == 422, resp.text
    resp = await client.post(base, json=waive("outside_strategy"), headers=approver)
    assert resp.status_code == 200, resp.text
    resp = await client.post(base, json=waive("stopped_but_planned"), headers=auth)
    assert resp.status_code == 200, resp.text
