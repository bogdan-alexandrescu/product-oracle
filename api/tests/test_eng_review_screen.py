"""F4 Engineering review stop, lane A (review fix 1): the Engineering check's screen reads
the shared draft (D8, ``GET .../review``) to know who stages and who decides. With an
engineering lead named, the lead (any role from commenter) and owners stage, set the note
and decide; an approver who is not the lead only suggests.

Every test states its card: protects / fails_when / no_claim. Against Postgres; the
FakeRuntime stands in for SwarmCloud and its architect (no model is called). Synthetic
placeholders only.
"""

import pytest

from oracle.runs import flows
from oracle.swarm import FakeRuntime, Outcome, set_runtime
from tests.fixtures import seed_auth
from tests.review_v2_helpers import person
from tests.test_eng_review_stop import BRIEFS, _act, _at_check, _url
from tests.test_runs import get, pending


@pytest.fixture
def runtime():
    fake = FakeRuntime({"eng_review": [Outcome(artifacts={flows.BRIEFS_FILE: BRIEFS})]})
    set_runtime(fake)
    yield fake
    set_runtime(None)


@pytest.fixture
async def owner():
    return await seed_auth()


async def _review(client, headers, run) -> dict:
    resp = await client.get(_url(run, pending(run)) + "/review", headers=headers)
    assert resp.status_code == 200, resp.text
    return resp.json()


async def _lead(client, tenant_id, auth):
    lead = await person(tenant_id, "commenter", "lead")
    resp = await client.patch(
        f"/v1/members/{lead.user_id}", json={"engineering_lead": True}, headers=auth
    )
    assert resp.status_code == 200, resp.text
    return lead


async def test_the_review_says_the_lead_stages_and_decides_not_the_approver(client, owner, runtime):
    # protects=AC4/AC24 what the screen reads; fails_when=a commenter lead's review says it
    # cannot stage or decide, or an approver who is not the lead is told they can;
    # no_claim=the decide route itself (test_eng_review_stop).
    tenant_id, auth = owner
    run = await _at_check(client, auth)
    approver = await person(tenant_id, "approver")
    lead = await _lead(client, tenant_id, auth)
    mine = await _review(client, lead.headers, run)
    assert mine["can_stage"] and mine["can_decide"] and mine["can_suggest"]
    theirs = await _review(client, approver.headers, run)
    assert not theirs["can_stage"] and not theirs["can_decide"]
    assert theirs["can_suggest"]
    assert (await _review(client, auth, run))["can_decide"]


async def test_with_no_lead_the_approver_stages_and_decides(client, owner, runtime):
    # protects=AC4 fallback on the screen; fails_when=no lead named and the approver's
    # review says they cannot stage; no_claim=the audit (test_eng_review_stop).
    tenant_id, auth = owner
    run = await _at_check(client, auth)
    approver = await person(tenant_id, "approver")
    review = await _review(client, approver.headers, run)
    assert review["can_stage"] and review["can_decide"]
    commenter = await person(tenant_id, "commenter")
    assert not (await _review(client, commenter.headers, run))["can_stage"]


async def test_the_lead_stages_a_suggestion_sets_the_note_and_undoes(client, owner, runtime):
    # protects=AC6 "a commenter's choices are suggestions a lead or owner stages" and the
    # Send back note, for a lead below the approver role; fails_when=a commenter lead gets
    # 403 staging, writing the note or undoing someone else's suggestion, or an approver
    # who is not the lead stages one; no_claim=put_action (test_eng_review_stop).
    tenant_id, auth = owner
    run = await _at_check(client, auth)
    approver = await person(tenant_id, "approver")
    lead = await _lead(client, tenant_id, auth)
    body = {"item_key": "price-early", "kind": "edit", "field": "verdict",
            "value": {"verdict": "feasible", "note": None}}  # fmt: skip
    resp = await _act(client, approver.headers, run, body)
    assert resp.status_code in (200, 201), resp.text
    action = next(a for i in resp.json()["items"] for a in i["actions"])
    assert action["state"] == "suggested"
    stage = _url(run, pending(run)) + f"/actions/{action['id']}/stage"
    assert (await client.post(stage, headers=approver.headers)).status_code == 403
    resp = await client.post(stage, headers=lead.headers)
    assert resp.status_code in (200, 204), resp.text
    review = await _review(client, lead.headers, run)
    staged = next(a for i in review["items"] for a in i["actions"])
    assert staged["state"] == "staged"
    note = _url(run, pending(run)) + "/note"
    resp = await client.put(note, json={"note": "Check the tax service"}, headers=lead.headers)
    assert resp.status_code in (200, 204), resp.text
    resp = await client.put(note, json={"note": "Not mine"}, headers=approver.headers)
    assert resp.status_code == 403
    size = {"item_key": "price-early", "kind": "edit", "field": "size", "value": "l"}
    resp = await _act(client, approver.headers, run, size)
    suggestion = next(a for i in resp.json()["items"] for a in i["actions"] if a["field"] == "size")
    undo = _url(run, pending(run)) + f"/actions/{suggestion['id']}"
    resp = await client.delete(undo, headers=lead.headers)
    assert resp.status_code in (200, 204), resp.text


async def test_the_checkpoint_says_whether_it_waits_for_a_lead(client, owner, runtime):
    # protects=the screen's "Waits for" names only who can decide (review fix 2);
    # fails_when=a check with no lead named says it waits for a lead, or one with a lead
    # named does not; no_claim=who may decide (test_eng_review_stop).
    tenant_id, auth = owner
    run = await _at_check(client, auth)
    commenter = await person(tenant_id, "commenter")
    seen = await get(client, commenter.headers, run["id"])
    assert pending(seen)["lead_stop"] is False and not pending(seen)["can_decide"]
    await _lead(client, tenant_id, auth)
    seen = await get(client, commenter.headers, run["id"])
    assert pending(seen)["lead_stop"] is True
    done = next(c for c in seen["checkpoints"] if c["kind"] == "feature_set")
    assert done["lead_stop"] is False


# Train N item 2 (owner 2026-10-24): the review's can_suggest is the API's, by the rule the
# items and scope reviews use (a pending stop, commenter or above), so the screen stops
# standing in with can("start_run").
SUGGESTS = {"viewer": False, "commenter": True, "approver": True, "owner": True}


@pytest.mark.parametrize("lead_named", [False, True])
@pytest.mark.parametrize("role", list(SUGGESTS))
async def test_the_review_says_who_may_suggest_by_role(client, owner, runtime, role, lead_named):
    # protects=the engineering review's own can_suggest for each role, with and without an
    # engineering lead named; fails_when=a viewer is told they may suggest, or a commenter,
    # approver or owner is not; no_claim=who stages (the tests above) and the screen (web).
    tenant_id, auth = owner
    run = await _at_check(client, auth)
    if lead_named:
        await _lead(client, tenant_id, auth)
    headers = auth if role == "owner" else (await person(tenant_id, role)).headers
    review = await _review(client, headers, run)
    assert review["can_suggest"] is SUGGESTS[role], (role, lead_named)
    if SUGGESTS[role] and not review["can_stage"]:
        # What it says is what the API does: a suggestion, not a refusal.
        body = {"item_key": "price-early", "kind": "edit", "field": "size", "value": "l"}
        resp = await _act(client, headers, run, body)
        assert resp.status_code in (200, 201), resp.text
        action = next(a for i in resp.json()["items"] for a in i["actions"])
        assert action["state"] == "suggested"
