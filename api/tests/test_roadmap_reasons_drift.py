"""H4 §5 Drift checks in the roadmap items review: "Outside the strategy" and "Stopped in
the strategy" as reasons to confirm (drift is advisory: decided 2026-10-21, "Drift gate").

Each test's card: protects=<the observable>; fails_when=<the wrong result it rejects>;
no_claim=<what green does not prove>.
"""

import uuid

import pytest

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


async def _drift_review(client, auth, tenant_id, runtime) -> tuple[str, str]:  # noqa: F811
    """The payment step (Next) stopped and outside the strategy: the actions URL and the
    review URL of its pending roadmap items checkpoint."""
    await approved_prd(client, auth)
    await seed_baseline(tenant_id)
    await _strategy(client, auth, tenant_id)
    run, _ = await roadmap_items_check(client, auth, runtime, SECOND)
    cp = next(c for c in run["checkpoints"] if c["status"] == "pending")
    base = f"/v1/runs/{run['id']}/checkpoints/{cp['id']}"
    return f"{base}/actions", f"{base}/review"


async def _counts(client, headers, review_url: str) -> tuple[dict, dict, dict]:
    """The payment step as the review shows it, the review's tally and the Inbox summary of
    the checkpoint (the run page and the Inbox count from these)."""
    rev = (await client.get(review_url, headers=headers)).json()
    cp_id = review_url.split("/")[-2]
    inbox = (await client.get("/v1/inbox", headers=headers)).json()
    [row] = [c for c in inbox["checkpoints"] if c["id"] == cp_id]
    [pay] = [i for i in rev["items"] if i["key"] == "payment-step"]
    return pay, rev["tally"], row["summary"]


def _waive(answers: list[str], reason: str = "Committed to the pilot customer") -> dict:
    return {"item_key": "payment-step", "kind": "waive", "answers": answers,
            "value": {"reason": reason}}  # fmt: skip


@pytest.mark.parametrize("answers", [[], ["outside_strategy"]])
async def test_an_approvers_waive_never_answers_stopped_in_the_strategy(
    client,
    owner,  # noqa: F811
    runtime,  # noqa: F811
    answers,
):
    """protects=a waive answers only the reasons it names, and none it does not name is an
    owner's (review #581, blocker 1); fails_when=an approver's waive with no codes or with
    Outside the strategy only makes the stopped item handled, or drops it from the Inbox or
    the review's counts; no_claim=the web (strategy-drift-items.spec.ts)."""
    tenant_id, auth = owner
    actions_url, review_url = await _drift_review(client, auth, tenant_id, runtime)
    approver = await as_user(tenant_id, "approver")
    before = await _counts(client, approver, review_url)
    assert before[0]["state"] == "needs_you"
    resp = await client.post(actions_url, json=_waive(answers), headers=approver)
    assert resp.status_code == 200, resp.text
    pay, tally, summary = await _counts(client, approver, review_url)
    assert pay["state"] == "needs_you"
    assert tally["need_you"] == before[1]["need_you"]
    assert tally["handled"] == before[1]["handled"]
    assert summary["need_you"] == before[2]["need_you"]
    listed = [c["item"] for c in before[2]["children"]]
    assert [c["item"] for c in summary["children"]] == listed


async def test_an_owners_waive_closes_stopped_and_keeps_the_approvers_waive(
    client,
    owner,  # noqa: F811
    runtime,  # noqa: F811
):
    """protects=an owner's waive of Stopped in the strategy answers it, and it neither
    replaces nor is replaced by an approver's waive of Outside the strategy on the same item
    (review #581, minor 3); fails_when=one waive replaces the other, so a reason reopens or
    the other author's reason is lost; no_claim=the stored finding after approval."""
    tenant_id, auth = owner
    actions_url, review_url = await _drift_review(client, auth, tenant_id, runtime)
    approver = await as_user(tenant_id, "approver")
    resp = await client.post(actions_url, json=_waive(["outside_strategy"]), headers=approver)
    assert resp.status_code == 200, resp.text
    resp = await client.post(
        actions_url,
        json=_waive(["stopped_but_planned"], "Signed before the strategy"),
        headers=auth,
    )
    assert resp.status_code == 200, resp.text
    pay, _, _ = await _counts(client, auth, review_url)
    waives = sorted(
        (a["answers"], a["value"]["reason"]) for a in pay["actions"] if a["kind"] == "waive"
    )
    assert waives == [
        (["outside_strategy"], "Committed to the pilot customer"),
        (["stopped_but_planned"], "Signed before the strategy"),
    ]
    drift = {"outside_strategy", "stopped_but_planned"}
    assert drift <= {r["code"] for r in pay["reasons"]}
    others = {r["code"] for r in pay["reasons"]} - drift
    assert pay["state"] == ("handled" if not others else "needs_you"), pay["reasons"]
    # The approver waives Outside again: the owner's waive of Stopped stays.
    resp = await client.post(
        actions_url, json=_waive(["outside_strategy"], "Pilot, again"), headers=approver
    )
    assert resp.status_code == 200, resp.text
    pay, _, _ = await _counts(client, auth, review_url)
    assert sorted(a["answers"] for a in pay["actions"] if a["kind"] == "waive") == [
        ["outside_strategy"],
        ["stopped_but_planned"],
    ]
