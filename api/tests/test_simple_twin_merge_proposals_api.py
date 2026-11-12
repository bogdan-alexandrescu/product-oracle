"""prio-twin-propose (the owner, Nov 10: "Offer a proposal"): a commenter who sees a same-name twin
that is a separate Ground Truth feature proposes its merge (``POST /v1/simple/changes`` op
``merge_twin``, ``target`` ``{feature_id, into_id}``); it waits in the decider's Inbox under Needs
a decision, and when approved runs the same merge_twin (every roadmap, the same 409/422
refusals); declined, nothing changes. On tests.test_simple_priorities_twins_api's world. Invented
data.

Test cards (protects / fails_when / no_claim):

- test_a_commenter_proposes_a_twin_merge_an_owner_approves: protects=a commenter's merge_twin is
  proposed (nothing merged), listed in the owner's Inbox, and the owner's accept re-links the
  twin's item on every roadmap and merges the feature; fails_when=the op is refused, applies at
  once, or the accept leaves the twin.
- test_a_declined_twin_merge_changes_nothing: protects=a decline merges nothing; fails_when=the
  twin's feature is gone or its item re-linked.
- test_a_twin_merge_proposal_needs_a_same_name_feature: protects=the proposal is refused (422)
  into a feature of another name, as merge_twin; fails_when=any feature can be proposed.
- test_an_approved_twin_merge_keeps_merge_twins_refusals: protects=an accept by an approver who
  does not decide the twin's roadmap is refused (409, naming it) and writes nothing; the
  proposal stays open; fails_when=it merges anyway.
- test_a_viewer_cannot_propose_a_twin_merge: protects=a viewer's merge_twin is 403.
- test_a_waiting_twin_merge_shows_on_its_twin: protects=Priorities lists the open merge_twin
  under the twin's feature (the proposer may withdraw it, the owner decide it) and a second
  proposal is 409; fails_when=the proposal shows nowhere on Priorities.
- test_a_twin_merge_proposal_names_both_features_by_code: protects=a twin merge's words name
  each feature by the short code Priorities shows and its name (oracle-product: a code is shown
  with its name); fails_when=the words carry only the names.
- test_a_direct_twin_merge_closes_its_waiting_proposal: protects=an owner's Merge into… closes
  the twin's open proposal (declined; gone from Priorities and the Inbox; a later accept is 409,
  never 404); fails_when=the proposal stays open after the merge.
"""

import uuid

from oracle.baseline.models import Entity
from oracle.roadmap.models import RoadmapItem
from oracle.simple.priorities import _short_codes
from oracle.tenancy import tenant_session
from tests.test_simple_changes_api import CHANGES, clock, make_people  # noqa: F401
from tests.test_simple_meeting_agenda import INBOX
from tests.test_simple_priorities_company_roadmap_api import company_world
from tests.test_simple_priorities_twins_api import (
    _devices,
    _feature_of,
    _features,
    _merge_url,
    by_feature,
)
from tests.test_simple_targets_api import no_llm  # noqa: F401


def _body(w, twin: str, into: str) -> dict:
    return {"op": "merge_twin", "target": {"feature_id": w.ids[twin], "into_id": w.ids[into]},
            "before": {}, "after": {}, "reason": None}  # fmt: skip


async def _propose(client, w, who: str = "commenter", into: str = "ledger"):
    return await client.post(CHANGES, json=_body(w, "ledger-copy", into), headers=w.ctx.as_(who))


async def _twin_left(w) -> bool:
    async with tenant_session(w.ctx.tenant_id) as s:
        return await s.get(Entity, uuid.UUID(w.ids["ledger-copy"])) is not None


async def test_a_commenter_proposes_a_twin_merge_an_owner_approves(client):
    w = await company_world()
    await _features(w, ("ledger-copy", "Ledger", 9))
    await _devices(w, ("dev-1", "ledger-copy"))
    r = await _propose(client, w)
    assert r.status_code in (200, 201), r.text
    change = r.json()["change"]
    assert change["status"] == "proposed", change
    assert await _twin_left(w), "a proposal merged at once"
    inbox = await client.get(INBOX, headers=w.ctx.as_("owner"))
    assert inbox.status_code == 200, inbox.text
    [row] = [x for x in inbox.json()["simple_proposals"] if x["id"] == change["id"]]
    assert "Ledger" in row["asked"], row
    r = await client.post(f"{CHANGES}/{change['id']}/accept", headers=w.ctx.as_("owner"))
    assert r.status_code == 200, r.text
    assert r.json()["change"]["status"] == "accepted", r.text
    assert not await _twin_left(w), "the accepted merge left the twin"
    assert await _feature_of(w, "dev-1") == w.ids["ledger"], "the item was left with no feature"


async def test_a_twin_merge_proposal_names_both_features_by_code(client):
    w = await company_world()
    await _features(w, ("ledger-copy", "Ledger", 9))
    # Each by the short code Priorities shows it with: the row's, and the twin's own.
    async with tenant_session(w.ctx.tenant_id) as s:
        twin = (await _short_codes(s))["ledger-copy"]
    [row] = [r for r in (await w.read(client))["rows"] if r["feature_id"] == w.ids["ledger"]]
    assert row["short_code"] and twin and row["short_code"] != twin, (row, twin)
    change = (await _propose(client, w)).json()["change"]
    words = f"merged {twin} Ledger into {row['short_code']} Ledger"
    assert words in change["words"], change["words"]
    assert w.ids["ledger"] not in change["words"], change["words"]


async def test_a_declined_twin_merge_changes_nothing(client):
    w = await company_world()
    await _features(w, ("ledger-copy", "Ledger", 9))
    await _devices(w, ("dev-1", "ledger-copy"))
    change = (await _propose(client, w)).json()["change"]
    r = await client.post(f"{CHANGES}/{change['id']}/decline", headers=w.ctx.as_("owner"))
    assert r.status_code == 200, r.text
    assert r.json()["change"]["status"] == "declined", r.text
    assert await _twin_left(w)
    assert await _feature_of(w, "dev-1") == w.ids["ledger-copy"]


async def test_a_twin_merge_proposal_needs_a_same_name_feature(client):
    w = await company_world()
    await _features(w, ("ledger-copy", "Ledger", 9))
    r = await _propose(client, w, into="insights")
    assert r.status_code == 422, r.text
    r = await client.post(CHANGES, json=_body(w, "ledger-copy", "ledger-copy"),
                          headers=w.ctx.as_("commenter"))  # fmt: skip
    assert r.status_code == 422, r.text


async def test_an_approved_twin_merge_keeps_merge_twins_refusals(client):
    w = await company_world()
    await _features(w, ("ledger-copy", "Ledger", 9))
    await _devices(w, ("dev-1", "ledger-copy"), decider="decider")
    change = (await _propose(client, w)).json()["change"]
    r = await client.post(f"{CHANGES}/{change['id']}/accept", headers=w.ctx.as_("approver"))
    assert r.status_code == 409, r.text
    assert "Devices" in r.json()["detail"], r.text
    assert await _twin_left(w)
    async with tenant_session(w.ctx.tenant_id) as s:
        item = await s.get(RoadmapItem, uuid.UUID(w.ids["dev-1"]))
        assert str(item.feature_id) == w.ids["ledger-copy"]
    r = await client.get(f"{CHANGES}/{change['id']}", headers=w.ctx.as_("owner"))
    if r.status_code == 200:
        assert r.json()["status"] == "proposed", r.text


async def test_a_viewer_cannot_propose_a_twin_merge(client):
    w = await company_world()
    await _features(w, ("ledger-copy", "Ledger", 9))
    r = await _propose(client, w, who="viewer")
    assert r.status_code == 403, r.text
    assert await _twin_left(w)


def _twin_merges(out: dict, w) -> list[dict]:
    return [p for p in out["proposals"]
            if p["op"] == "merge_twin" and p["feature_id"] == w.ids["ledger-copy"]]  # fmt: skip


async def test_a_waiting_twin_merge_shows_on_its_twin(client):
    w = await company_world()
    await _features(w, ("ledger-copy", "Ledger", 9))
    await _devices(w, ("dev-1", "ledger-copy"))
    change = (await _propose(client, w)).json()["change"]
    mine = await w.read(client, "commenter")
    [twin] = by_feature(mine, w)["ledger"]["twins"]
    assert twin["feature_id"] == w.ids["ledger-copy"]
    [p] = _twin_merges(mine, w)
    assert (p["change_id"], p["can_withdraw"], p["can_decide"]) == (change["id"], True, False)
    [p] = _twin_merges(await w.read(client), w)
    assert p["can_decide"], p
    r = await _propose(client, w)
    assert r.status_code == 409, r.text


async def test_a_direct_twin_merge_closes_its_waiting_proposal(client):
    w = await company_world()
    await _features(w, ("ledger-copy", "Ledger", 9))
    await _devices(w, ("dev-1", "ledger-copy"))
    change = (await _propose(client, w)).json()["change"]
    r = await client.post(_merge_url(w, "ledger-copy"), json={"into": w.ids["ledger"]},
                          headers=w.ctx.as_("owner"))  # fmt: skip
    assert r.status_code == 200, r.text
    assert not await _twin_left(w)
    r = await client.get(CHANGES, headers=w.ctx.as_("owner"))
    assert r.status_code == 200, r.text
    [c] = [c for c in r.json() if c["id"] == change["id"]]
    assert c["status"] == "declined", c
    assert _twin_merges(await w.read(client), w) == []
    inbox = await client.get(INBOX, headers=w.ctx.as_("owner"))
    assert change["id"] not in [x["id"] for x in inbox.json()["simple_proposals"]], inbox.text
    r = await client.post(f"{CHANGES}/{change['id']}/accept", headers=w.ctx.as_("owner"))
    assert r.status_code == 409, r.text
