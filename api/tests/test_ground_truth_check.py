"""The Ground Truth check (docs/ground-truth.md, the owner's pick, Nov 5: "Flag it, don't
refuse"): ``GET /v1/baseline/check`` lists every place the roadmap or a PRD breaks the
Ground Truth, each with plain words and the fixes, and counts them per kind. Nothing is
refused on save. Against Postgres. Invented data only.

Test cards (protects / fails_when / no_claim):

- test_each_kind_is_flagged: protects=one flag of each kind in a world built for it (a
  roadmap item linked to no Ground Truth feature, or to a feature a run only proposed; the
  slices of a PRD feature not in the Ground Truth; a PRD's feature not in the Ground Truth;
  a feature with no F-code; a feature serving no goal; a feature running today still on
  the roadmap), the right fixes, counts per kind, and none on the item and feature that
  keep the rules; fails_when=a kind is missed, miscounted or a clean entry is flagged;
  no_claim=the web, which a later lane draws.
- test_only_confirmed_features_count: protects=the owner's answer (Nov 5): an item linked
  to a feature a run proposed is "Not in the Ground Truth" with the fixes Confirm it (the
  feature) and Link to a feature, never Add to Ground Truth; once an approver confirms the
  feature, the flag is gone; fails_when=a proposed feature counts, or its item offers no
  Confirm it.
- test_each_fix_has_its_words: protects=every fix carries the button's plain words (Add to
  Ground Truth, Link to a feature, Confirm it, Give it a code, Pick a goal, Take it off the
  roadmap); fails_when=a fix has no words or the wrong ones.
- test_a_feature_that_lists_the_item_links_it: protects=Add to Ground Truth makes the
  feature with the item's link in one change (attrs.roadmap_items: the item's key, which
  stays across versions), so the item is no longer flagged, for a published item too; a
  commenter's proposal carries the same link and clears the flag once an approver accepts
  it; fails_when=the flag stays after the add, or a proposal clears it before approval.
- test_a_prd_flag_carries_its_key_and_goal: protects=an unlinked item's ref carries its key
  and a PRD feature's flag the goal its PRD gives, so Add makes F-09 with its code and goal
  and raises no no_code or no_goal flag; fails_when=the added feature is flagged again.
- test_words_carry_no_ids: protects=each flag's words are one short plain sentence with no
  id or key; fails_when=a uuid, slug or code shows in the words.
- test_anyone_who_reads_the_roadmap_reads_it: protects=a viewer reads the check; no
  session is 401; fails_when=the read needs more than the roadmap's reader.
- test_scoped_to_the_company: protects=another company reads none of these flags;
  fails_when=the check reads across tenants.
- test_an_unlinked_item_still_saves: protects=adding a roadmap item linked to no feature
  is not refused (201) and, once published, it is flagged; fails_when=a save is refused
  for breaking the Ground Truth.
"""

import re
import uuid
from datetime import UTC, datetime

import pytest

from oracle import company_time
from oracle.baseline.models import Entity
from oracle.currentstate.models import FeatureState
from oracle.docs.models import DocumentVersion
from oracle.simple.models import SimpleDraft, SimplePrdPlan
from oracle.tenancy import tenant_session
from tests.baseline_helpers import make_ctx
from tests.test_simple_additions_api import World as AddWorld
from tests.test_simple_roadmap_api import NOW, Seed

CHECK = "/v1/baseline/check"
KINDS = (
    "unlinked_item",
    "slice_parent_missing",
    "prd_feature_missing",
    "no_code",
    "no_goal",
    "runs_today_on_roadmap",
)


@pytest.fixture(autouse=True)
def clock(monkeypatch):
    monkeypatch.setattr(company_time, "now", lambda: NOW)


async def world() -> dict:
    """The Payments roadmap and its PRD. The goal Grow. In the Ground Truth: F-01 Bulk
    import (serves Grow, on the roadmap: clean), F-02 Audit log (serves no goal),
    smart-search (serves Grow, no F-code), F-03 Night alerts (serves Grow, runs today, still
    on the roadmap). A run proposed Import history 2 (not confirmed). On the roadmap:
    import-a (F-01), import-b (no feature), import-c (F-03), import-d (the proposed one).
    The PRD's approved plan: F-01 (in), F-09 Team invites (not in), F-15 Usage export over
    two milestones (not in: slices F-15a and F-15b)."""
    ctx = await make_ctx()
    async with tenant_session(ctx.tenant_id) as s:
        seed = Seed(s)
        prd, pv, rm, rv = await seed.roadmap("payments")
        grow = await seed.entity("goal", "grow")
        f1 = await seed.entity("feature", "F-01")
        f1.title = "Bulk import"
        f2 = await seed.entity("feature", "F-02")
        f2.title = "Audit log"
        search = await seed.entity("feature", "smart-search")
        f3 = await seed.entity("feature", "F-03")
        f3.title = "Night alerts"
        proposed = await seed.add(Entity(type="feature", key="import-history",
                                         title="Import history 2", status="proposed",
                                         origin="agent"))  # fmt: skip
        for f in (f1, search, f3):
            await seed.supports(f, grow)
        s.add(FeatureState(feature_id=f3.id, status="current"))
        a = await seed.item(rv, pv, "import-a", title="Bulk import", feature_id=f1.id)
        b = await seed.item(rv, pv, "import-b", title="Import history", position=1)
        c = await seed.item(rv, pv, "import-c", title="Night alerts", position=2,
                            feature_id=f3.id)  # fmt: skip
        d = await seed.item(rv, pv, "import-d", title="Import history 2", position=3,
                            feature_id=proposed.id)  # fmt: skip
        s.add(SimplePrdPlan(document_id=prd.id, version_id=pv.id, status="ready", source="prd",
                            data={"milestones": [{"code": "M1", "name": "Start"},
                                                 {"code": "M2", "name": "Scale"}],
                                  "features": [
                                      {"code": "F-01", "name": "Bulk import",
                                       "milestones": ["M1"]},
                                      {"code": "F-09", "name": "Team invites",
                                       "milestones": ["M1"]},
                                      {"code": "F-15", "name": "Usage export",
                                       "milestones": ["M1", "M2"]}],
                                  "goals": ["Grow"]}))  # fmt: skip
        await s.commit()
        return {
            "ctx": ctx,
            "prd": (str(prd.id), prd.title),
            "roadmap": (str(rm.id), rm.title),
            "items": {k: str(v.id) for k, v in {"a": a, "b": b, "c": c, "d": d}.items()},
            "features": {
                k: str(v.id)
                for k, v in {
                    "F-01": f1,
                    "F-02": f2,
                    "smart-search": search,
                    "F-03": f3,
                    "proposed": proposed,
                }.items()
            },  # fmt: skip
        }


async def _check(client, ctx, who: str = "viewer") -> dict:
    r = await client.get(CHECK, headers=ctx.as_(who))
    assert r.status_code == 200, r.text
    return r.json()


def _of(out: dict, kind: str) -> list[dict]:
    return [f for f in out["flags"] if f["kind"] == kind]


def _fixes(flag: dict) -> list[tuple[str, str]]:
    return [(x["action"], x["target"]) for x in flag["fixes"]]


async def test_each_kind_is_flagged(client):
    w = await world()
    out = await _check(client, w["ctx"])
    items, feats = w["items"], w["features"]
    rm_id, rm_title = w["roadmap"]
    prd_id, prd_title = w["prd"]

    unlinked = {f["item"]["id"]: f for f in _of(out, "unlinked_item")}
    assert set(unlinked) == {items["b"], items["d"]}
    b = unlinked[items["b"]]
    assert b["item"]["name"] == "Import history" and b["feature"] is None
    assert b["where"]["roadmap"] == {"id": rm_id, "title": rm_title}
    assert _fixes(b) == [("add_to_ground_truth", items["b"]), ("link_to_feature", items["b"])]
    # Linked to a feature a run only proposed: not in the Ground Truth yet.
    assert unlinked[items["d"]]["feature"]["id"] == feats["proposed"]
    assert _fixes(unlinked[items["d"]]) == [("confirm_feature", feats["proposed"]),
                                            ("link_to_feature", items["d"])]  # fmt: skip

    slices = _of(out, "slice_parent_missing")
    assert sorted(f["item"]["code"] for f in slices) == ["F-15a", "F-15b"]
    for f in slices:
        assert f["item"]["name"] == "Usage export" and f["item"]["id"] is None
        assert f["where"]["prd"] == {"id": prd_id, "title": prd_title}
        assert f["where"]["roadmap"] == {"id": rm_id, "title": rm_title}
        assert [x["action"] for x in f["fixes"]] == ["add_to_ground_truth", "link_to_feature"]
        assert all(x["target"] == "F-15" for x in f["fixes"])

    missing = {f["feature"]["code"]: f for f in _of(out, "prd_feature_missing")}
    assert set(missing) == {"F-09", "F-15"}
    assert missing["F-09"]["feature"] == {"id": None, "code": "F-09", "name": "Team invites"}
    assert missing["F-09"]["where"]["prd"] == {"id": prd_id, "title": prd_title}
    assert _fixes(missing["F-09"]) == [("add_to_ground_truth", "F-09"),
                                       ("link_to_feature", "F-09")]  # fmt: skip

    no_code = _of(out, "no_code")
    assert [f["feature"]["id"] for f in no_code] == [feats["smart-search"]]
    assert no_code[0]["feature"]["code"] is None
    assert no_code[0]["feature"]["name"] == "Smart Search"
    assert _fixes(no_code[0]) == [("give_code", feats["smart-search"])]

    no_goal = _of(out, "no_goal")
    assert [f["feature"]["id"] for f in no_goal] == [feats["F-02"]]
    assert no_goal[0]["feature"] == {"id": feats["F-02"], "code": "F-02", "name": "Audit log"}
    assert _fixes(no_goal[0]) == [("pick_goal", feats["F-02"])]

    running = _of(out, "runs_today_on_roadmap")
    assert len(running) == 1
    r = running[0]
    assert r["feature"] == {"id": feats["F-03"], "code": "F-03", "name": "Night alerts"}
    assert r["item"]["id"] == items["c"] and r["where"]["roadmap"]["id"] == rm_id
    assert _fixes(r) == [("take_off_roadmap", items["c"])]

    # The item and feature that keep the rules are never flagged.
    for f in out["flags"]:
        assert (f.get("item") or {}).get("id") != items["a"]
        assert (f.get("feature") or {}).get("id") != feats["F-01"]
    assert out["counts"] == {"unlinked_item": 2, "slice_parent_missing": 2,
                             "prd_feature_missing": 2, "no_code": 1, "no_goal": 1,
                             "runs_today_on_roadmap": 1}  # fmt: skip
    assert out["total"] == 9 == len(out["flags"])


async def test_only_confirmed_features_count(client):
    w = await world()
    d, proposed = w["items"]["d"], w["features"]["proposed"]
    flag = next(f for f in _of(await _check(client, w["ctx"]), "unlinked_item")
                if f["item"]["id"] == d)  # fmt: skip
    assert flag["words"] == "This roadmap item is not a feature in the Ground Truth."
    assert flag["feature"] == {"id": proposed, "code": None, "name": "Import history 2"}
    assert [x["action"] for x in flag["fixes"]] == ["confirm_feature", "link_to_feature"]
    # An approver confirms it: the item now keeps the rules.
    async with tenant_session(w["ctx"].tenant_id) as s:
        (await s.get(Entity, uuid.UUID(proposed))).status = "confirmed"
        await s.commit()
    out = await _check(client, w["ctx"])
    assert [f["item"]["id"] for f in _of(out, "unlinked_item")] == [w["items"]["b"]]
    assert all((f.get("item") or {}).get("id") != d for f in out["flags"])


FIX_WORDS = {
    "add_to_ground_truth": "Add to Ground Truth",
    "link_to_feature": "Link to a feature",
    "confirm_feature": "Confirm it",
    "give_code": "Give it a code",
    "pick_goal": "Pick a goal",
    "take_off_roadmap": "Take it off the roadmap",
}


async def test_each_fix_has_its_words(client):
    w = await world()
    out = await _check(client, w["ctx"])
    seen = set()
    for f in out["flags"]:
        for x in f["fixes"]:
            assert x["words"] == FIX_WORDS[x["action"]], x
            seen.add(x["action"])
    assert seen == set(FIX_WORDS)


async def test_a_feature_that_lists_the_item_links_it(client):
    w = await world()
    b = w["items"]["b"]
    flagged = lambda out: [f["item"]["id"] for f in _of(out, "unlinked_item")]  # noqa: E731
    new = {"type": "feature", "key": "history", "title": "Import history",
           "attrs": {"roadmap_items": ["import-b"]}}  # fmt: skip
    # A commenter proposes it: still flagged until an approver accepts the proposal.
    r = await client.post("/v1/baseline/proposals", headers=w["ctx"].as_("commenter"),
                          json={"op": "create", "kind": "entity", "fields": new})  # fmt: skip
    assert r.status_code == 201, r.text
    assert b in flagged(await _check(client, w["ctx"]))
    r = await client.post(f"/v1/baseline/proposals/{r.json()['id']}/accept",
                          headers=w["ctx"].as_("approver"))  # fmt: skip
    assert r.status_code == 200, r.text
    assert b not in flagged(await _check(client, w["ctx"]))


async def test_an_approver_adds_a_published_item_at_once(client):
    w = await world()
    out = await _check(client, w["ctx"])
    b = next(f for f in _of(out, "unlinked_item") if f["item"]["id"] == w["items"]["b"])
    assert b["item"]["key"] == "import-b"
    r = await client.post("/v1/baseline/entities", headers=w["ctx"].as_("approver"),
                          json={"type": "feature", "key": "F-21", "title": "Import history",
                                "attrs": {"roadmap_items": [b["item"]["key"]]}})  # fmt: skip
    assert r.status_code == 201, r.text
    out = await _check(client, w["ctx"])
    assert [f["item"]["id"] for f in _of(out, "unlinked_item")] == [w["items"]["d"]]


async def test_a_prd_flag_carries_its_key_and_goal(client):
    w = await world()
    out = await _check(client, w["ctx"])
    f9 = next(f for f in _of(out, "prd_feature_missing") if f["feature"]["code"] == "F-09")
    grow = f9["goal"]
    assert grow is not None and grow["name"] == "Grow", f9
    h = w["ctx"].as_("approver")
    new = {"type": "feature", "key": "F-09", "title": "Team invites"}
    r = await client.post("/v1/baseline/entities", headers=h, json=new)
    assert r.status_code == 201, r.text
    fid = r.json()["entity"]["id"]
    r = await client.post("/v1/baseline/edges", headers=h,
                          json={"src_id": fid, "dst_id": grow["id"], "type": "supports",
                                "attrs": {"contribution": 2}})  # fmt: skip
    assert r.status_code == 201, r.text
    out = await _check(client, w["ctx"])
    assert all(f9["feature"]["code"] != (f.get("feature") or {}).get("code") for f in out["flags"])
    assert all((f.get("feature") or {}).get("id") != fid for f in out["flags"])


async def test_words_carry_no_ids(client):
    w = await world()
    out = await _check(client, w["ctx"])
    assert {f["kind"] for f in out["flags"]} == set(KINDS)
    ids = re.compile(r"[0-9a-f]{8}-|\b[A-Z]{1,3}-\d+|[a-z]+-[a-z]+|_")
    for f in out["flags"]:
        words = f["words"]
        assert words and words.endswith(".") and words.count(".") == 1, words
        assert len(words.split()) <= 16 and not ids.search(words), words


async def test_anyone_who_reads_the_roadmap_reads_it(client):
    w = await world()
    for who in ("viewer", "commenter", "approver", "owner"):
        assert (await _check(client, w["ctx"], who))["total"] == 9
    r = await client.get(CHECK)
    assert r.status_code == 401


async def test_scoped_to_the_company(client):
    w = await world()
    other = await make_ctx("Other Example Co")
    out = await _check(client, other)
    assert out["flags"] == [] and out["total"] == 0
    assert out["counts"] == dict.fromkeys(KINDS, 0)
    assert (await _check(client, w["ctx"]))["total"] == 9


async def test_an_unlinked_item_still_saves(client):
    w = await AddWorld().build()
    c = (await w.add(client, "owner", "Guided setup"))["change"]
    assert c["status"] == "applied"
    drafts = (await client.get("/v1/simple/drafts", headers=w.as_("decider"))).json()
    d = next(x for x in drafts if x["document"]["id"] == w.roadmap_id)
    r = await client.post(f"/v1/simple/drafts/{d['id']}/submit", headers=w.as_("decider"))
    assert r.status_code == 200, r.text
    # The decider approves the submitted version.
    async with tenant_session(w.ctx.tenant_id) as s:
        draft = await s.get(SimpleDraft, uuid.UUID(d["id"]))
        v = await s.get(DocumentVersion, draft.version_id)
        v.approved_at = datetime(2026, 11, 3, tzinfo=UTC)
        draft.status = "approved"
        await s.commit()
    out = await _check(client, w.ctx)
    names = [f["item"]["name"] for f in _of(out, "unlinked_item")]
    assert "Guided setup" in names
