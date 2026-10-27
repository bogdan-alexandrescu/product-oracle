"""Simple S6 (#723): the priorities read (``GET /v1/simple/priorities``) and its two change
ops, ``estimate_feature`` (a non-versioned target, the feature's attrs) and ``confirm_item``
(a versioned one, into the roadmap's working draft). Against Postgres.

The world: one roadmap ``payments`` (a decider on its policy, Dee Cider) with items over
five features and two confirmed goals (growth weight 2, retention weight 1):

- ``ledger`` (effort 1, growth): items ``pay-1`` (now) and ``pay-7`` (later);
- ``sync`` (effort 8, growth): ``pay-2`` (next);
- ``exports`` (effort 1, retention, depends on sync): ``pay-3`` (now, milestone Beta);
- ``insights`` (effort 2, retention): no item;
- ``widgets`` (no effort, retention): ``pay-5``, a draft (now), so its row has no item;
- ``chatbot`` (effort 2, no goal): ``pay-4`` (later);
- ``pay-6``: no feature (later).

Oracle's order: ledger (1.0), sync (pulled up by exports), exports (0.5), insights (0.25),
widgets (missing effort), chatbot (no goal). People and the clock:
tests.test_simple_changes_api; the reason check never reaches a model (``no_llm``).
Each test's card is its docstring (protects / fails_when / no_claim).
"""

from typing import Any

import pytest
from sqlalchemy import select

from oracle.baseline.models import Edge, Entity
from oracle.review.models import DocumentReviewPolicy
from oracle.roadmap.models import RoadmapItem
from oracle.simple.models import SimpleChange, SimpleDraft
from oracle.tenancy import tenant_session
from tests.baseline_helpers import Ctx
from tests.coverage_helpers import run_headers
from tests.test_simple_changes_api import CHANGES, clock, make_people  # noqa: F401
from tests.test_simple_roadmap_api import Seed
from tests.test_simple_targets_api import no_llm  # noqa: F401

URL = "/v1/simple/priorities"
REASON = "Contoso's renewal hangs on it"


class World:
    def __init__(self, ctx: Ctx) -> None:
        self.ctx = ctx
        self.ids: dict[str, str] = {}

    async def build(self) -> "World":
        async with tenant_session(self.ctx.tenant_id) as s:
            seed = Seed(s)
            _, pv, rm, rv = await seed.roadmap("payments")
            track = await seed.track(pv, rm)
            growth = await seed.entity("goal", "growth", weight=2)
            retention = await seed.entity("goal", "retention", weight=1)
            f = {
                "ledger": await seed.entity("feature", "ledger", effort=1),
                "sync": await seed.entity("feature", "sync", effort=8),
                "exports": await seed.entity("feature", "exports", effort=1),
                "insights": await seed.entity("feature", "insights", effort=2),
                "widgets": await seed.entity("feature", "widgets"),
                "chatbot": await seed.entity("feature", "chatbot", effort=2),
            }
            for k in ("ledger", "sync"):
                await seed.supports(f[k], growth)
            for k in ("exports", "insights", "widgets"):
                await seed.supports(f[k], retention)
            await seed.add(Edge(src_id=f["exports"].id, dst_id=f["sync"].id, type="depends_on",
                                status="confirmed", origin="user"))  # fmt: skip
            items = {
                "pay-1": dict(feature_id=f["ledger"].id),
                "pay-2": dict(feature_id=f["sync"].id, horizon="next"),
                "pay-3": dict(feature_id=f["exports"].id, milestone={"name": "Beta"}),
                "pay-4": dict(feature_id=f["chatbot"].id, horizon="later"),
                "pay-5": dict(feature_id=f["widgets"].id, draft=True),
                "pay-6": dict(horizon="later"),
                "pay-7": dict(feature_id=f["ledger"].id, horizon="later"),
            }
            for i, (key, kw) in enumerate(items.items()):
                row = await seed.item(rv, pv, key, position=i, track_id=track.id, **kw)
                self.ids[key] = str(row.id)
            s.add(DocumentReviewPolicy(document_id=rm.id, decider_id=self.ctx.users["decider"].id))
            await s.commit()
            self.ids |= {k: str(e.id) for k, e in f.items()}
        return self

    async def read(self, client, who: str = "owner") -> dict:
        r = await client.get(URL, headers=self.ctx.as_(who))
        assert r.status_code == 200, r.text
        return r.json()

    async def attrs(self, feature: str) -> dict:
        async with tenant_session(self.ctx.tenant_id) as s:
            return dict((await s.get(Entity, self.ids[feature])).attrs or {})

    async def change(self, client, who: str, op: str, item: str, before, after, **kw) -> Any:
        body = {"op": op, "target": {"item_id": self.ids[item]}, "before": before,
                "after": after, **kw}  # fmt: skip
        return await client.post(CHANGES, json=body, headers=self.ctx.as_(who))


def rows_by_code(out: dict) -> dict[str, dict]:
    return {r["code"]: r for r in out["rows"]}


async def test_read_order_and_rows(client):
    """protects=the read lists every ranked feature in Oracle's order (rank 1 first) joined
    to the earliest-horizon visible item (pay-1 over pay-7), a feature without an item still a
    row (code = the feature's key, item_id null, can_reorder false); goal, milestone, horizon,
    goal value, effort, score, above_line and no_goal come from the ranking and the item;
    ``after`` names the dependency ranked above a higher-scoring row (exports after pay-2,
    which it needs); quarter and method are filled; fails_when=the order, the join or a field
    drifts from the ranking, or the dependency explanation is missing;
    no_claim=the web's 2x2 drawing."""
    ctx = await make_people()
    w = await World(ctx).build()
    out = await w.read(client)
    assert [r["code"] for r in out["rows"]] == ["pay-1", "pay-2", "pay-3", "insights", "widgets",
                                                 "pay-4"]  # fmt: skip
    assert [r["rank"] for r in out["rows"]] == [1, 2, 3, 4, 5, 6]
    assert out["method"] == "goal_weighted" and out["formula"]
    assert out["quarter"]["label"] == "Q4 2026"
    assert (out["quarter"]["start"], out["quarter"]["end"]) == ("2026-10-01", "2026-12-31")
    assert out["can_change"] is True
    rows = rows_by_code(out)
    one = rows["pay-1"]
    assert one["item_id"] == w.ids["pay-1"] and one["feature_id"] == w.ids["ledger"]
    assert one["goal"] == {"key": "growth", "title": "Growth"}
    assert (one["goal_value"], one["effort"], one["score"]) == (2, 1, 1)
    assert (one["horizon"], one["above_line"], one["no_goal"]) == ("now", True, False)
    assert (one["oracle_rank"], one["override"], one["before_override"]) == (1, None, None)
    assert (one["can_reorder"], one["applies"], one["value_estimated"]) == (True, True, False)
    assert one["after"] is None
    assert rows["pay-3"]["milestone"] == "Beta"
    assert rows["pay-3"]["depends_on"] == ["pay-2"]
    assert rows["pay-3"]["after"] == {"code": "pay-2", "title": "Pay 2"}
    assert rows["pay-2"]["above_line"] is False and rows["pay-2"]["after"] is None
    ins = rows["insights"]
    assert (ins["item_id"], ins["horizon"], ins["can_reorder"]) == (None, None, False)
    assert ins["goal"] == {"key": "retention", "title": "Retention"}
    assert rows["pay-4"]["no_goal"] is True and rows["pay-4"]["goal"] is None
    widgets = rows["widgets"]
    assert (widgets["effort"], widgets["score"]) == (None, None)
    # A draft item is not yet ranked: it sits under the drafts, never as its feature's row.
    assert (widgets["item_id"], widgets["horizon"], widgets["can_reorder"]) == (None, None, False)


async def test_buckets_and_drafts(client):
    """protects=the goal buckets sum this quarter's (horizon now) engineer-weeks per goal with
    their codes in rank order, a bucket per confirmed goal with a ranked row and "No goal"
    when a row has none, shares of the total, a draft item (pay-5) never counted; the drafts
    list the visible draft items with merge candidates of the same roadmap, same goal first,
    never drafts;
    fails_when=a bucket or a candidate is missing, mis-summed or mis-ordered;
    no_claim=the merge itself (a cut, web only)."""
    ctx = await make_people()
    w = await World(ctx).build()
    out = await w.read(client)
    buckets = {b["key"]: b for b in out["buckets"]}
    assert [b["key"] for b in out["buckets"]] == ["growth", "retention", "none"]
    assert (buckets["growth"]["weeks"], buckets["growth"]["codes"]) == (1, ["pay-1"])
    retention = buckets["retention"]
    assert (retention["weeks"], retention["codes"]) == (1, ["pay-3"])
    none = buckets["none"]
    assert (none["title"], none["no_goal"], none["weeks"], none["codes"]) == ("No goal", True, 0,
                                                                               [])  # fmt: skip
    assert out["weeks_total"] == 2
    assert buckets["growth"]["share"] == 0.5 and none["share"] == 0
    assert [d["code"] for d in out["drafts"]] == ["pay-5"]
    draft = out["drafts"][0]
    assert draft["goal"] == {"key": "retention", "title": "Retention"}
    assert draft["roadmap"]["slug"] == "payments" and draft["applies"] is True
    merge = [m["code"] for m in draft["merge_into"]]
    assert merge == ["pay-3", "pay-1", "pay-2", "pay-4", "pay-6", "pay-7"]


async def test_override_shows_oracle_rank_and_who(client):
    """protects=a pin made through override_priority moves the row, keeps Oracle's rank as
    oracle_rank (the ghost), names who and why (by_name, reason), and hands back
    before_override exactly as a next override_priority's ``before.override`` wants (it
    lands, no 409); fails_when=the ghost, the person or the reason is lost, or
    before_override is stale; no_claim=Oracle's pushback wording."""
    ctx = await make_people()
    w = await World(ctx).build()
    r = await w.change(client, "owner", "override_priority", "pay-4", {"override": None},
                       {"position": 1, "reason": REASON, "confirm": True})  # fmt: skip
    assert r.status_code == 201, r.text
    out = await w.read(client)
    assert out["rows"][0]["code"] == "pay-4"
    pinned = out["rows"][0]
    assert (pinned["rank"], pinned["oracle_rank"]) == (1, 6)
    assert pinned["override"]["by_name"] == "owner@example.com"
    assert pinned["override"]["reason"] == REASON and pinned["override"]["at"]
    assert pinned["before_override"] == {"kind": "pin", "position": 1,
                                         "above_feature_id": None, "reason": REASON}  # fmt: skip
    assert rows_by_code(out)["pay-1"]["oracle_rank"] == 1
    assert rows_by_code(out)["pay-1"]["rank"] == 2
    r = await w.change(client, "owner", "override_priority", "pay-4",
                       {"override": pinned["before_override"]},
                       {"position": 2, "reason": REASON, "confirm": True})  # fmt: skip
    assert r.status_code == 201, r.text


async def test_proposals_wait_for_the_decider(client):
    """protects=a commenter's open estimate_feature and override_priority proposals are listed
    with the item's code and title, who proposed, its after, waiting_for the decider's name,
    can_decide only for who decides, and flow null (no design bundle yet); fails_when=a
    proposal is missing, shows the wrong decider or lets the proposer decide;
    no_claim=S10's design bundles."""
    ctx = await make_people()
    w = await World(ctx).build()
    r = await w.change(client, "commenter", "estimate_feature", "pay-1",
                       {"goal_value": None, "effort": 1}, {"goal_value": 6})  # fmt: skip
    assert r.status_code == 201, r.text
    r = await w.change(client, "commenter", "override_priority", "pay-3", {"override": None},
                       {"position": 1, "reason": REASON})  # fmt: skip
    assert r.status_code == 201, r.text
    mine = (await w.read(client, "commenter"))["proposals"]
    assert sorted(p["op"] for p in mine) == ["estimate_feature", "override_priority"]
    est = next(p for p in mine if p["op"] == "estimate_feature")
    assert (est["code"], est["title"], est["item_id"]) == ("pay-1", "Pay 1", w.ids["pay-1"])
    assert est["by_name"] == "commenter@example.com"
    assert est["after"] == {"goal_value": 6.0}
    assert est["waiting_for"] == ["Dee Cider"]
    assert (est["can_decide"], est["flow"]) == (False, None)
    theirs = (await w.read(client, "decider"))["proposals"]
    assert all(p["can_decide"] for p in theirs) and len(theirs) == 2
    assert (await w.read(client, "viewer"))["proposals"] == []


async def test_draft_and_second_item_proposals(client):
    """protects=a commenter's Confirm (confirm_item) and Merge (S7's merge_item; train T's
    cut with a note is still listed) are listed among the proposals waiting for the decider,
    and every proposal carries its feature_id so one on a feature's second item (pay-7, ledger's later item) shows under the
    feature's row; fails_when=a draft's proposal is dropped or a proposal can't be placed;
    no_claim=a cut of a ranked item (the roadmap's)."""
    ctx = await make_people()
    w = await World(ctx).build()
    r = await w.change(client, "commenter", "confirm_item", "pay-5", {"draft": True}, {})
    assert r.status_code == 201, r.text
    r = await w.change(client, "commenter", "cut", "pay-5", {"cut": False}, {"cut": True},
                       reason="Merged into pay-3")  # fmt: skip
    assert r.status_code == 201, r.text
    r = await client.post(CHANGES, headers=ctx.as_("commenter"), json={
        "op": "merge_item", "target": {"item_id": w.ids["pay-5"], "into_id": w.ids["pay-3"]},
        "before": {}, "after": {}, "reason": "Merged into pay-3"})  # fmt: skip
    assert r.status_code == 201 and r.json()["change"]["status"] == "proposed", r.text
    r = await w.change(client, "commenter", "estimate_feature", "pay-7",
                       {"goal_value": None, "effort": 1}, {"goal_value": 6})  # fmt: skip
    assert r.status_code == 201, r.text
    out = await w.read(client, "commenter")
    by_op = {p["op"]: p for p in out["proposals"]}
    assert sorted(by_op) == ["confirm_item", "cut", "estimate_feature", "merge_item"]
    for op in ("confirm_item", "cut", "merge_item"):
        assert (by_op[op]["code"], by_op[op]["feature_id"]) == ("pay-5", w.ids["widgets"])
        assert by_op[op]["waiting_for"] == ["Dee Cider"]
    assert by_op["cut"]["reason"] == "Merged into pay-3"
    est = by_op["estimate_feature"]
    assert (est["code"], est["feature_id"]) == ("pay-7", w.ids["ledger"])
    assert rows_by_code(out)["pay-1"]["feature_id"] == w.ids["ledger"]


async def test_viewer_reads_and_runs_are_refused(client):
    """protects=a viewer reads the same rows but may change nothing (can_change, can_reorder
    and applies false); a run's token is refused (403) even for an owner;
    fails_when=a viewer is offered changes or a run reads Simple; no_claim=MCP scopes."""
    ctx = await make_people()
    w = await World(ctx).build()
    out = await w.read(client, "viewer")
    assert out["can_change"] is False
    assert len(out["rows"]) == 6
    assert not any(r["can_reorder"] or r["applies"] for r in out["rows"])
    commenter = await w.read(client, "commenter")
    assert commenter["can_change"] is True
    assert rows_by_code(commenter)["pay-1"]["applies"] is False
    r = await client.get(URL, headers=await run_headers(ctx, "owner"))
    assert r.status_code == 403, r.text


async def test_estimate_owner_applies_and_undo_restores(client):
    """protects=an owner's estimate_feature writes the feature's attrs (goal_value and effort,
    rounded to 1 decimal), the read shows it as a person's estimate, and its undo restores
    the attrs (an absent goal_value removed again); fails_when=the attrs keep the estimate
    after the undo, a null becomes a stored key, or the read misses value_estimated;
    no_claim=the Baseline screen's display of the attrs."""
    ctx = await make_people()
    w = await World(ctx).build()
    before, after = {"goal_value": None, "effort": 1}, {"goal_value": 4.04, "effort": 2.26}
    r = await w.change(client, "owner", "estimate_feature", "pay-1", before, after)
    assert r.status_code == 201, r.text
    change = r.json()["change"]
    assert change["status"] == "applied"
    assert change["before"] == {"goal_value": None, "effort": 1}
    assert change["after"] == {"goal_value": 4.0, "effort": 2.3}
    assert change["target"]["feature_id"] == w.ids["ledger"]
    attrs = await w.attrs("ledger")
    assert (attrs["goal_value"], attrs["effort"]) == (4.0, 2.3)
    row = rows_by_code(await w.read(client))["pay-1"]
    assert (row["goal_value"], row["effort"], row["value_estimated"]) == (4.0, 2.3, True)
    r = await client.post(f"{CHANGES}/{change['id']}/undo", headers=ctx.as_("owner"))
    assert r.status_code == 201, r.text
    attrs = await w.attrs("ledger")
    assert "goal_value" not in attrs and attrs["effort"] == 1
    row = rows_by_code(await w.read(client))["pay-1"]
    assert (row["goal_value"], row["value_estimated"]) == (2, False)


async def test_estimate_commenter_proposes_until_accepted(client):
    """protects=a commenter's estimate_feature is a proposal routed to the decider and writes
    nothing; the decider's accept writes the attrs; fails_when=the proposal writes, or the
    accept does not; no_claim=the Inbox screen."""
    ctx = await make_people()
    w = await World(ctx).build()
    r = await w.change(client, "commenter", "estimate_feature", "pay-2",
                       {"goal_value": None, "effort": 8}, {"effort": 5})  # fmt: skip
    assert r.status_code == 201, r.text
    change = r.json()["change"]
    assert change["status"] == "proposed"
    assert change["routed_to"] == [str(ctx.users["decider"].id)]
    assert (await w.attrs("sync"))["effort"] == 8
    r = await client.post(f"{CHANGES}/{change['id']}/accept", json={}, headers=ctx.as_("decider"))
    assert r.status_code == 200, r.text
    assert (await w.attrs("sync"))["effort"] == 5


async def test_estimate_stale_and_malformed(client):
    """protects=an estimate whose ``before`` no longer matches the attrs answers 409 with the
    current values and writes nothing; a missing ``before``, an empty or non-positive
    ``after`` and an item without a feature answer 422; fails_when=a stale or malformed
    estimate lands; no_claim=who changed the attrs outside Simple."""
    ctx = await make_people()
    w = await World(ctx).build()
    r = await w.change(client, "owner", "estimate_feature", "pay-1",
                       {"goal_value": 3, "effort": 1}, {"goal_value": 5})  # fmt: skip
    assert r.status_code == 409, r.text
    assert r.json()["detail"]["current"] == {"goal_value": None, "effort": 1}
    for before, after in (({"effort": 1}, {"goal_value": 5}),
                          ({"goal_value": None, "effort": 1}, {}),
                          ({"goal_value": None, "effort": 1}, {"goal_value": 0}),
                          ({"goal_value": None, "effort": 1}, {"effort": -1}),
                          ({"goal_value": None, "effort": 1}, {"effort": "big"})):  # fmt: skip
        r = await w.change(client, "owner", "estimate_feature", "pay-1", before, after)
        assert r.status_code == 422, (before, after, r.text)
    r = await w.change(client, "owner", "estimate_feature", "pay-6",
                       {"goal_value": None, "effort": None}, {"goal_value": 5})  # fmt: skip
    assert r.status_code == 422, r.text
    assert "goal_value" not in await w.attrs("ledger")
    async with tenant_session(ctx.tenant_id) as s:
        assert list(await s.scalars(select(SimpleChange))) == []


async def test_estimate_changes_the_rank(client):
    """protects=goal_weighted scores with a person's goal-value estimate: raising sync's
    estimate lifts it from rank 2 to rank 1 and its score uses the estimate;
    fails_when=the ranking ignores the estimate; no_claim=other methods."""
    ctx = await make_people()
    w = await World(ctx).build()
    assert rows_by_code(await w.read(client))["pay-2"]["rank"] == 2
    r = await w.change(client, "owner", "estimate_feature", "pay-2",
                       {"goal_value": None, "effort": 8}, {"goal_value": 20})  # fmt: skip
    assert r.status_code == 201, r.text
    out = await w.read(client)
    assert out["rows"][0]["code"] == "pay-2"
    assert out["rows"][0]["score"] == pytest.approx(20 * 0.5 / 8)


async def test_confirm_item_into_the_working_draft(client):
    """protects=an owner's confirm_item on a draft item writes draft false into the roadmap's
    working draft (the published row stays a draft until the draft is approved), and the
    read no longer lists it among the drafts for who sees the draft; a non-draft item
    answers 422; a commenter's confirm is a proposal that writes nothing;
    fails_when=the published row is written, a non-draft is confirmed or a proposal writes;
    no_claim=submitting the draft (tests/test_simple_drafts_api.py)."""
    ctx = await make_people()
    w = await World(ctx).build()
    r = await w.change(client, "owner", "confirm_item", "pay-1", {"draft": False}, {})
    assert r.status_code == 422, r.text
    r = await w.change(client, "commenter", "confirm_item", "pay-5", {"draft": True}, {})
    assert r.status_code == 201, r.text
    assert r.json()["change"]["status"] == "proposed"
    async with tenant_session(ctx.tenant_id) as s:
        assert list(await s.scalars(select(SimpleDraft))) == []
    r = await w.change(client, "owner", "confirm_item", "pay-5", {"draft": True}, {})
    assert r.status_code == 201, r.text
    change = r.json()["change"]
    assert (change["status"], change["after"]) == ("applied", {"draft": False})
    async with tenant_session(ctx.tenant_id) as s:
        row = await s.get(RoadmapItem, w.ids["pay-5"])
        assert row.draft is True
        d = await s.scalar(select(SimpleDraft))
        assert d.overlay[w.ids["pay-5"]]["draft"] is False
    assert (await w.read(client))["drafts"] == []
    assert [d["code"] for d in (await w.read(client, "viewer"))["drafts"]] == ["pay-5"]
