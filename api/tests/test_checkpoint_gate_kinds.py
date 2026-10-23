"""D3 Approve blocked by problems, criterion 8a: the feature set's (C6) and the priority
order's (C8) blocking problems are read by the one approve gate (``BLOCKING_SOURCES``),
not by ``cannot_approve``, which keeps only its draft-not-imported meaning.

Test cards (protects / fails_when / no_claim):

- test_the_registry_holds_every_merged_kind: protects=one registry decides every kind;
  fails_when=feature_set or priority_order is gated outside it; no_claim=kinds whose
  spec has not merged.
- test_a_feature_set_problem_is_refused_through_the_gate: protects=a
  ``depends_on_excluded`` problem closes the gate (409 ``blocking_open``, ``left`` naming
  it), ``cannot_approve`` reads the gate's message; fails_when=the refusal comes from
  ``cannot_approve`` or names no reason; no_claim=the web.
- test_a_staged_waiver_opens_the_feature_set_gate: protects=a staged ``waive`` on the
  problem opens the gate and approve goes through; fails_when=the waiver is refused or
  the gate stays closed; no_claim=C7 Scope review's edits.
- test_an_unknown_feature_is_never_waived: protects=``unknown_feature`` is not waivable
  (422); fails_when=the waiver is staged; no_claim=the other unknown codes' wording.
- test_a_priority_order_problem_is_refused_through_the_gate: protects=the priority
  order's blocking problem closes the gate and is not waivable; fails_when=it is refused
  through ``cannot_approve`` or a waiver is accepted; no_claim=C9 moves.
"""

from oracle.runs import gate
from oracle.runs.models import Checkpoint
from oracle.runs.service import _cannot_approve
from tests.test_prd_scope import BLOCKING, BULK, CLEAN, at_feature_set
from tests.test_priority_run_order import BLOCKING as ORDER_BLOCKING
from tests.test_priority_run_order import at_priority
from tests.test_runs import (  # noqa: F401 - fixtures
    as_user,
    get,
    owner,
    pending,
    runtime,
    started,
    tick,
)

LEFT_1 = "1 blocking problem left: fix or waive them, or send back to the agents"
GHOST = CLEAN.replace(
    BULK,
    BULK + "  - key: ghost-feature\n    title: Ghost\n    goals: []\n    confidence: 0.8\n"
    "    requirements: []\n",
)


def test_the_registry_holds_every_merged_kind():
    assert {"roadmap_items", "feature_set", "priority_order"} <= set(gate.BLOCKING_SOURCES)
    problem = {"code": "depends_on_excluded", "blocking": True, "feature": "saved-addresses"}
    cp = Checkpoint(
        kind="feature_set",
        status="pending",
        payload={"feature_set_check": {"problems": [problem]}},
    )
    assert _cannot_approve(cp) is None
    shut = gate.approve_gate(cp, None, [])
    assert shut is not None and not shut.open
    assert [(x.item, x.code, x.waivable) for x in shut.left] == [
        ("saved-addresses", "depends_on_excluded", True)
    ]
    order = {"code": "before_prerequisite", "blocking": True, "feature": "saved-addresses"}
    cp = Checkpoint(
        kind="priority_order", status="pending", payload={"priority_check": {"problems": [order]}}
    )
    assert _cannot_approve(cp) is None
    shut = gate.approve_gate(cp, None, [])
    assert shut is not None and not shut.open and not shut.left[0].waivable


async def test_a_feature_set_problem_is_refused_through_the_gate(client, owner, runtime):  # noqa: F811
    _, auth = owner
    run = await at_feature_set(client, owner, runtime, BLOCKING)
    cp = pending(run)
    assert cp["cannot_approve"] == LEFT_1
    assert cp["gate"]["open"] is False
    assert [(x["item"], x["code"]) for x in cp["gate"]["left"]] == [
        ("saved-addresses", "depends_on_excluded")
    ]
    resp = await client.post(
        f"/v1/runs/{run['id']}/checkpoints/{cp['id']}/decide",
        json={"decision": "approved"},
        headers=auth,
    )
    assert resp.status_code == 409, resp.text
    detail = resp.json()["detail"]
    assert detail["code"] == "blocking_open" and detail["message"] == LEFT_1
    assert [(x["item"], x["code"]) for x in detail["left"]] == [
        ("saved-addresses", "depends_on_excluded")
    ]


async def test_a_staged_waiver_opens_the_feature_set_gate(client, owner, runtime):  # noqa: F811
    tenant_id, auth = owner
    run = await at_feature_set(client, owner, runtime, BLOCKING)
    cp = pending(run)
    base = f"/v1/runs/{run['id']}/checkpoints/{cp['id']}"
    waive = {
        "item_key": "saved-addresses",
        "kind": "waive",
        "answers": ["depends_on_excluded"],
        "value": {"reason": "Sharing ships in the same release"},
    }
    commenter = await as_user(tenant_id, "commenter")
    resp = await client.post(f"{base}/actions", json=waive, headers=commenter)
    assert resp.status_code == 403, resp.text
    resp = await client.post(f"{base}/actions", json=waive, headers=auth)
    assert resp.status_code in (200, 201, 204), resp.text
    run = await get(client, auth, run["id"])
    cp = pending(run)
    assert cp["gate"]["open"] is True and cp["cannot_approve"] is None
    resp = await client.post(f"{base}/decide", json={"decision": "approved"}, headers=auth)
    assert resp.status_code == 200, resp.text
    run = await get(client, auth, run["id"])
    assert next(c for c in run["checkpoints"] if c["id"] == cp["id"])["status"] == "approved"


async def test_an_unknown_feature_is_never_waived(client, owner, runtime):  # noqa: F811
    _, auth = owner
    run = await at_feature_set(client, owner, runtime, GHOST)
    cp = pending(run)
    codes = [p["code"] for p in cp["payload"]["feature_set_check"]["problems"]]
    assert "unknown_feature" in codes
    assert cp["gate"]["open"] is False
    resp = await client.post(
        f"/v1/runs/{run['id']}/checkpoints/{cp['id']}/actions",
        json={
            "item_key": "ghost-feature",
            "kind": "waive",
            "answers": ["unknown_feature"],
            "value": {"reason": "It exists somewhere"},
        },
        headers=auth,
    )
    assert resp.status_code == 422, resp.text


async def test_a_priority_order_problem_is_refused_through_the_gate(client, owner, runtime):  # noqa: F811
    _, auth = owner
    run = await at_priority(client, owner, runtime, ORDER_BLOCKING)
    cp = pending(run)
    assert cp["cannot_approve"] == LEFT_1
    assert [(x["item"], x["code"], x["waivable"]) for x in cp["gate"]["left"]] == [
        ("saved-addresses", "before_prerequisite", False)
    ]
    base = f"/v1/runs/{run['id']}/checkpoints/{cp['id']}"
    resp = await client.post(f"{base}/decide", json={"decision": "approved"}, headers=auth)
    assert resp.status_code == 409, resp.text
    assert resp.json()["detail"]["code"] == "blocking_open"
    resp = await client.post(
        f"{base}/actions",
        json={
            "item_key": "saved-addresses",
            "kind": "waive",
            "answers": ["before_prerequisite"],
            "value": {"reason": "Lookup is nearly done"},
        },
        headers=auth,
    )
    assert resp.status_code == 422, resp.text
