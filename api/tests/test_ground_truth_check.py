"""The Ground Truth check (docs/ground-truth.md, the owner's pick, Nov 5: "Flag it, don't
refuse"): ``GET /v1/baseline/check`` lists every place the roadmap or a PRD breaks the
Ground Truth, each with plain words and the fixes, and counts them per kind. Nothing is
refused on save. Against Postgres. Invented data only.

Test cards (protects / fails_when / no_claim):

- test_unlinked_item / test_slice_parent_missing / test_prd_feature_missing / test_no_code /
  test_no_goal / test_runs_today_on_roadmap: protects=one test per kind, in a world built
  for it: its flags, their item or feature, where and fixes, and none on the item and
  feature that keep the rules; fails_when=the kind is missed, miscounted or a clean entry
  is flagged; no_claim=the web, which a later lane draws.
- test_counts_per_kind: protects=the counts per kind and the total match the flags;
  fails_when=a count is off.
- test_a_slice_item_of_a_missing_prd_feature: protects=a roadmap slice item (F-15a, or an
  item of a PRD feature over two milestones) whose feature the PRD flags already is one
  unlinked item with its slice code, never also a slice flag; the PRD feature is one flag
  however many milestones it spans; fails_when=one missing feature shows as a flag per
  milestone, or a slice reads no code, or two slices read the same code.
- test_an_item_matched_by_code_is_in_the_ground_truth / test_a_proposed_code_still_flags_its_items:
  protects=a roadmap item linked to no feature whose own code (F-02) or whose slice's
  feature (F-15, for an F-15 item and an F-15a slice) is a confirmed Ground Truth feature is
  in it, by code: no flag; a proposed F-15 still leaves them flagged; fails_when=an item
  matched by code reads "not a feature in the Ground Truth" and Add to Ground Truth would
  add the slice as a second feature.
- test_an_item_of_a_running_feature_by_code_is_flagged: protects=an item linked to no
  feature whose own code (f-03) or slice's feature (F-03 of f-3a) is a confirmed feature
  that runs today is flagged runs_today_on_roadmap with that feature, and nothing else;
  fails_when=an item matched by code to a running feature stays on the roadmap unflagged.
- test_plan_and_item_codes_read_one_way: protects=f-1, 1 and F-001 all read F-01; a
  negative or malformed number (-3, "-3", "3.5") is no code, flagged as such; fails_when=a
  code reads F-1 in one place and F-01 in another, or a feature reads "F--3".
- test_a_slice_given_a_code_is_in_the_ground_truth: protects=a slice feature given a code
  (F-16a, its key) counts by that code: the roadmap's F-16a item is in it, and the feature
  has a code; fails_when=the slice's code is not read, so its item stays flagged.
- test_prd_plan_codes_read_as_codes: protects=a PRD plan code is read as an F-code (f-01
  matches the confirmed F-01; the number 15 reads F-15); fails_when=a plan feature coded f-01
  is flagged though F-01 is confirmed, or a flag shows a bare number.
- test_prd_features_match_by_code_only: protects=a PRD's F-20 Bulk import is flagged though
  the confirmed F-01 has the same name, with the hint "Same name as F-01 Bulk import." and
  the feature to link to; a PRD feature with no code is flagged, not skipped;
  fails_when=a PRD feature matches by name, or one with no code is left out.
- test_only_confirmed_goals_and_links_count: protects=a feature whose only goal or only
  link to a goal a run proposed serves no goal; fails_when=a proposed goal or link counts.
- test_trashed_entries_are_left_out: protects=a feature in Trash is never flagged, and an
  item linked to one reads as linked to none; fails_when=Trash shows in the check.
- test_only_confirmed_features_count: protects=the owner's answer (Nov 5): an item linked
  to a feature a run proposed is "Not in the Ground Truth" with the fixes Confirm it (the
  feature) and Link to a feature, never Add to Ground Truth; once an approver confirms the
  feature, the flag is gone; fails_when=a proposed feature counts, or its item offers no
  Confirm it.
- test_each_fix_has_its_words: protects=every fix carries the button's plain words (Add to
  Ground Truth, Link to a feature, Confirm it, Give it a code, Pick a goal, Take it off the
  roadmap); fails_when=a fix has no words or the wrong ones.
- test_an_add_links_a_published_item_through_its_draft: protects=Add to Ground Truth is one
  call that makes the feature, its goal and the item's link (feature_id, a set_feature
  change in the roadmap's working draft, so a published item's link rides the next
  version), and the flag clears at once; fails_when=the item stays flagged, its published
  row is written, or the goal is a second call.
- test_link_to_a_feature_is_a_change_in_the_draft: protects=set_feature links an item to a
  feature through the draft; a non-feature is 422; fails_when=the link needs the API's
  attrs, or any id is taken.
- test_a_commenters_add_is_one_proposal_with_its_link_and_goal: protects=a commenter's Add
  is one proposal (sent twice, the same one) carrying the item's link and the goal; once
  accepted the flag clears and the feature serves the goal; fails_when=a second proposal is
  made, or the accepted feature is flagged Serves no goal.
- test_a_prd_flag_carries_its_goal: protects=a PRD feature's flag carries the goal its PRD
  gives, and a commenter's Add with it, once approved, raises no flag; fails_when=the added
  F-09 serves no goal.
- test_an_item_on_a_proposed_feature_is_confirmed: protects=a roadmap item linked to a
  feature a run only proposed offers Confirm it (that feature) and Link to a feature, not
  Add to Ground Truth; fails_when=it offers to add a feature that already exists.
- test_entity_create_keeps_codes_and_links_to_features: protects=only a feature's key may be
  an F-code and only a feature carries serves or roadmap_item_id, said in words; fails_when=a
  goal is made with a code key, a goal or a link.
- test_a_proposal_carries_the_link_and_goal_of_a_feature_only: protects=submit_proposal refuses
  serves on a goal and a malformed item id, and stores the item's id as an id, so the same ask is
  one proposal; fails_when=a goal proposal carries a link or the same ask makes two.
- test_an_add_while_the_roadmaps_draft_waits_says_why: protects=Add to Ground Truth on an item
  whose roadmap has a draft waiting for approval is a 409 that says so, and makes nothing;
  fails_when=a 500, a bare "No such roadmap item", or a feature left without its link.
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
from sqlalchemy import select

from oracle import company_time
from oracle.baseline.models import Edge, Entity
from oracle.currentstate.models import FeatureState
from oracle.docs.models import DocumentVersion
from oracle.roadmap.models import RoadmapItem
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
    "code_differs",
    "no_goal",
    "runs_today_on_roadmap",
)


@pytest.fixture(autouse=True)
def clock(monkeypatch):
    monkeypatch.setattr(company_time, "now", lambda: NOW)


PLAN = {
    "milestones": [{"code": "M1", "name": "Start"}, {"code": "M2", "name": "Scale"}],
    "features": [
        {"code": "F-01", "name": "Bulk import", "milestones": ["M1"]},
        {"code": "F-09", "name": "Team invites", "milestones": ["M1"]},
        {"code": "F-15", "name": "Usage export", "milestones": ["M1", "M2"]},
    ],
    "goals": ["Grow"],
}


async def world(plan: dict | None = None) -> dict:
    """The Payments roadmap and its PRD. The goal Grow. In the Ground Truth: F-01 Bulk
    import (serves Grow, on the roadmap: clean), F-02 Audit log (serves no goal),
    smart-search (serves Grow, no F-code), F-03 Night alerts (serves Grow, runs today, still
    on the roadmap). A run proposed Import history 2 (not confirmed). On the roadmap:
    import-a (F-01), import-b (no feature), import-c (F-03), import-d (the proposed one),
    report-a (the slice F-16a Usage report, of an F-16 in no PRD plan and not in the Ground
    Truth). The PRD's approved plan (``PLAN``): F-01 (in), F-09 Team invites (not in), F-15
    Usage export over two milestones (not in: one flag, no slices)."""
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
        r = await seed.item(rv, pv, "report-a", title="Usage report", position=4,
                            prd_section_key="f-16a")  # fmt: skip
        s.add(SimplePrdPlan(document_id=prd.id, version_id=pv.id, status="ready", source="prd",
                            data=plan or PLAN))  # fmt: skip
        await s.commit()
        return {
            "ctx": ctx,
            "seed": (prd.id, pv.id, rv.id),
            "prd": (str(prd.id), prd.title),
            "roadmap": (str(rm.id), rm.title),
            "items": {
                k: str(v.id) for k, v in {"a": a, "b": b, "c": c, "d": d, "report": r}.items()
            },  # fmt: skip
            "features": {
                k: str(v.id)
                for k, v in {
                    "F-01": f1,
                    "F-02": f2,
                    "smart-search": search,
                    "F-03": f3,
                    "proposed": proposed,
                    "grow": grow,
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


def _clean(out: dict, w: dict) -> None:
    """The item and feature that keep the rules are never flagged."""
    for f in out["flags"]:
        assert (f.get("item") or {}).get("id") != w["items"]["a"]
        assert (f.get("feature") or {}).get("id") != w["features"]["F-01"]


async def test_unlinked_item(client):
    w = await world()
    out = await _check(client, w["ctx"])
    items, feats = w["items"], w["features"]
    rm_id, rm_title = w["roadmap"]
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
    _clean(out, w)


async def test_slice_parent_missing(client):
    w = await world()
    out = await _check(client, w["ctx"])
    prd_id, prd_title = w["prd"]
    rm_id = w["roadmap"][0]
    # The roadmap's slice item, not the PRD's F-15 (flagged once as prd_feature_missing).
    slices = _of(out, "slice_parent_missing")
    assert [f["item"] for f in slices] == [
        {"id": w["items"]["report"], "code": "F-16a", "name": "Usage report"}
    ]
    f = slices[0]
    assert f["where"]["prd"] == {"id": prd_id, "title": prd_title}
    assert f["where"]["roadmap"]["id"] == rm_id
    assert _fixes(f) == [("add_to_ground_truth", "F-16"),
                         ("link_to_feature", w["items"]["report"])]  # fmt: skip
    # One flag for the item: not also unlinked_item.
    assert all(x["item"]["id"] != w["items"]["report"] for x in _of(out, "unlinked_item"))
    _clean(out, w)


async def test_prd_feature_missing(client):
    w = await world()
    out = await _check(client, w["ctx"])
    prd_id, prd_title = w["prd"]
    missing = {f["feature"]["code"]: f for f in _of(out, "prd_feature_missing")}
    assert set(missing) == {"F-09", "F-15"}
    assert missing["F-09"]["feature"] == {"id": None, "code": "F-09", "name": "Team invites"}
    assert missing["F-09"]["where"]["prd"] == {"id": prd_id, "title": prd_title}
    assert missing["F-09"]["where"]["roadmap"]["id"] == w["roadmap"][0]
    assert missing["F-09"]["hint"] is None and missing["F-09"]["like"] is None
    assert _fixes(missing["F-09"]) == [("add_to_ground_truth", "F-09"),
                                       ("link_to_feature", "F-09")]  # fmt: skip
    _clean(out, w)


async def test_no_code(client):
    w = await world()
    out = await _check(client, w["ctx"])
    no_code = _of(out, "no_code")
    assert [f["feature"]["id"] for f in no_code] == [w["features"]["smart-search"]]
    assert no_code[0]["feature"]["code"] is None
    assert no_code[0]["feature"]["name"] == "Smart Search"
    assert _fixes(no_code[0]) == [("give_code", w["features"]["smart-search"])]
    _clean(out, w)


async def test_no_goal(client):
    w = await world()
    out = await _check(client, w["ctx"])
    feats = w["features"]
    no_goal = _of(out, "no_goal")
    assert [f["feature"]["id"] for f in no_goal] == [feats["F-02"]]
    assert no_goal[0]["feature"] == {"id": feats["F-02"], "code": "F-02", "name": "Audit log"}
    assert _fixes(no_goal[0]) == [("pick_goal", feats["F-02"])]
    _clean(out, w)


async def test_runs_today_on_roadmap(client):
    w = await world()
    out = await _check(client, w["ctx"])
    feats = w["features"]
    running = _of(out, "runs_today_on_roadmap")
    assert len(running) == 1
    r = running[0]
    assert r["feature"] == {"id": feats["F-03"], "code": "F-03", "name": "Night alerts"}
    assert r["item"]["id"] == w["items"]["c"] and r["where"]["roadmap"]["id"] == w["roadmap"][0]
    assert _fixes(r) == [("take_off_roadmap", w["items"]["c"])]
    _clean(out, w)


async def test_counts_per_kind(client):
    w = await world()
    out = await _check(client, w["ctx"])
    assert out["counts"] == {"unlinked_item": 2, "slice_parent_missing": 1,
                             "prd_feature_missing": 2, "no_code": 1, "code_differs": 0,
                             "no_goal": 1, "runs_today_on_roadmap": 1}  # fmt: skip
    assert out["total"] == 8 == len(out["flags"])


async def test_a_slice_item_of_a_missing_prd_feature(client):
    w = await world()
    prd_id, pv_id, rv_id = w["seed"]
    async with tenant_session(w["ctx"].tenant_id) as s:
        seed = Seed(s)
        rv = await s.get(DocumentVersion, rv_id)
        pv = await s.get(DocumentVersion, pv_id)
        # F-15b by its section code; two items of F-15 (over two milestones) by its own.
        b = await seed.item(rv, pv, "usage-b", title="Usage export, part two", position=5,
                            prd_section_key="f-15b")  # fmt: skip
        x = await seed.item(rv, pv, "usage-x", title="Usage export start", position=6,
                            prd_section_key="f-15")  # fmt: skip
        y = await seed.item(rv, pv, "usage-y", title="Usage export scale", position=7,
                            prd_section_key="f-15")  # fmt: skip
        await s.commit()
        # The second item of F-15 takes the next free letter: F-15b is the explicit one's.
        ids = {str(b.id): "F-15b", str(x.id): "F-15a", str(y.id): "F-15c"}
    out = await _check(client, w["ctx"])
    # F-15 is one flag, however many milestones or items it has.
    assert [f["feature"]["code"] for f in _of(out, "prd_feature_missing")] == ["F-09", "F-15"]
    assert [f["item"]["id"] for f in _of(out, "slice_parent_missing")] == [w["items"]["report"]]
    unlinked = {f["item"]["id"]: f["item"]["code"] for f in _of(out, "unlinked_item")}
    for i, code in ids.items():
        assert unlinked[i] == code


async def _add_usage_export(w: dict, status: str = "confirmed") -> dict:
    """F-15 Usage export (``status``) and, linked to no feature, the items F-02 Audit log
    (its own code), F-15 Usage export start (a PRD item of F-15) and F-15a Usage export
    slice (a slice item)."""
    prd_id, pv_id, rv_id = w["seed"]
    async with tenant_session(w["ctx"].tenant_id) as s:
        seed = Seed(s)
        rv = await s.get(DocumentVersion, rv_id)
        pv = await s.get(DocumentVersion, pv_id)
        f15 = await seed.entity("feature", "F-15")
        f15.title, f15.status = "Usage export", status
        own = await seed.item(rv, pv, "audit", title="Audit log", position=5,
                              prd_section_key="f-02")  # fmt: skip
        whole = await seed.item(rv, pv, "usage-x", title="Usage export start", position=6,
                                prd_section_key="f-15")  # fmt: skip
        part = await seed.item(rv, pv, "usage-a", title="Usage export slice", position=7,
                               prd_section_key="f-15a")  # fmt: skip
        await s.commit()
        return {"F-02": str(own.id), "F-15": str(whole.id), "F-15a": str(part.id)}


async def test_an_item_matched_by_code_is_in_the_ground_truth(client):
    w = await world()
    ids = await _add_usage_export(w)
    out = await _check(client, w["ctx"])
    flagged = {(f.get("item") or {}).get("id") for f in out["flags"]}
    assert flagged.isdisjoint(ids.values())
    assert [f["feature"]["code"] for f in _of(out, "prd_feature_missing")] == ["F-09"]
    assert [f["item"]["id"] for f in _of(out, "unlinked_item")] == [w["items"]["b"],
                                                                    w["items"]["d"]]  # fmt: skip


async def test_a_proposed_code_still_flags_its_items(client):
    w = await world()
    ids = await _add_usage_export(w, status="proposed")
    out = await _check(client, w["ctx"])
    # F-15 is not in the Ground Truth: the PRD's F-15 is flagged, its items too.
    assert [f["feature"]["code"] for f in _of(out, "prd_feature_missing")] == ["F-09", "F-15"]
    unlinked = {f["item"]["id"]: f["item"]["code"] for f in _of(out, "unlinked_item")}
    assert unlinked[ids["F-15"]] == "F-15b" and unlinked[ids["F-15a"]] == "F-15a"
    # F-02 is confirmed: its item is in the Ground Truth by code.
    assert ids["F-02"] not in unlinked


async def test_a_slice_given_a_code_is_in_the_ground_truth(client):
    w = await world()
    async with tenant_session(w["ctx"].tenant_id) as s:
        seed = Seed(s)
        # A slice feature given a code (Give it a code: F-16a, stored as its key).
        part = await seed.entity("feature", "F-16a")
        part.title, part.status = "Usage report", "confirmed"
        await s.commit()
        part_id = str(part.id)
    out = await _check(client, w["ctx"])
    # The roadmap's F-16a item is that feature, by code; the feature reads F-16a, no no_code.
    flagged = {(f.get("item") or {}).get("id") for f in out["flags"]}
    assert w["items"]["report"] not in flagged
    assert all((f.get("feature") or {}).get("id") != part_id for f in _of(out, "no_code"))


async def test_prd_plan_codes_read_as_codes(client):
    plan = {**PLAN, "features": [{"code": "f-01", "name": "Bulk import", "milestones": ["M1"]},
                                 {"code": 15, "name": "Usage export"}]}  # fmt: skip
    w = await world(plan)
    out = await _check(client, w["ctx"])
    missing = _of(out, "prd_feature_missing")
    # f-01 is the confirmed F-01; the number 15 reads F-15, never a bare 15.
    assert [f["feature"] for f in missing] == [{"id": None, "code": "F-15", "name": "Usage export"}]
    assert _fixes(missing[0]) == [("add_to_ground_truth", "F-15"), ("link_to_feature", "F-15")]


async def test_an_item_of_a_running_feature_by_code_is_flagged(client):
    w = await world()
    prd_id, pv_id, rv_id = w["seed"]
    async with tenant_session(w["ctx"].tenant_id) as s:
        seed = Seed(s)
        rv = await s.get(DocumentVersion, rv_id)
        pv = await s.get(DocumentVersion, pv_id)
        own = await seed.item(rv, pv, "alerts-x", title="Night alerts again", position=5,
                              prd_section_key="f-03")  # fmt: skip
        part = await seed.item(rv, pv, "alerts-a", title="Night alerts slice", position=6,
                               prd_section_key="f-3a")  # fmt: skip
        await s.commit()
    out = await _check(client, w["ctx"])
    feats = w["features"]
    running = {f["item"]["id"]: f for f in _of(out, "runs_today_on_roadmap")}
    # Linked to no feature, but F-03 by code (its own, or its slice's feature): F-03 runs today.
    assert set(running) == {w["items"]["c"], str(own.id), str(part.id)}
    for i, code in ((own, "F-03"), (part, "F-03a")):
        r = running[str(i.id)]
        assert r["item"]["code"] == code
        assert r["feature"] == {"id": feats["F-03"], "code": "F-03", "name": "Night alerts"}
        assert _fixes(r) == [("take_off_roadmap", str(i.id))]
    flagged = {
        (f.get("item") or {}).get("id")
        for f in out["flags"]
        if f["kind"] != "runs_today_on_roadmap"
    }
    assert flagged.isdisjoint({str(own.id), str(part.id)})


async def test_plan_and_item_codes_read_one_way(client):
    plan = {**PLAN, "features": [{"code": "f-1", "name": "Bulk import", "milestones": ["M1"]},
                                 {"code": 1, "name": "Bulk import"},
                                 {"code": " F-001 ", "name": "Bulk import"},
                                 {"code": -3, "name": "Minus three"},
                                 {"code": "-3", "name": "Dash three"},
                                 {"code": "3.5", "name": "Half three"}]}  # fmt: skip
    w = await world(plan)
    out = await _check(client, w["ctx"])
    # f-1, 1 and F-001 are all F-01; a negative or malformed number is no code, never "F--3".
    missing = [f["feature"] for f in _of(out, "prd_feature_missing")]
    assert missing == [
        {"id": None, "code": None, "name": n} for n in ("Minus three", "Dash three", "Half three")
    ]
    for f in _of(out, "prd_feature_missing"):
        assert _fixes(f)[0] == ("add_to_ground_truth", f["feature"]["name"])


async def test_prd_features_match_by_code_only(client):
    plan = {**PLAN, "features": [*PLAN["features"],
                                 {"code": "F-20", "name": "Bulk import", "milestones": ["M2"]},
                                 {"name": "Dark mode", "milestones": ["M2"]}]}  # fmt: skip
    w = await world(plan)
    out = await _check(client, w["ctx"])
    missing = _of(out, "prd_feature_missing")
    assert [f["feature"]["name"] for f in missing] == [
        "Team invites",
        "Usage export",
        "Bulk import",
        "Dark mode",
    ]
    same = missing[2]
    assert same["feature"] == {"id": None, "code": "F-20", "name": "Bulk import"}
    assert same["hint"] == "Same name as F-01 Bulk import."
    assert same["like"] == {"id": w["features"]["F-01"], "code": "F-01", "name": "Bulk import"}
    assert _fixes(same) == [("add_to_ground_truth", "F-20"), ("link_to_feature", "F-20")]
    # No code: flagged by its name, never skipped.
    dark = missing[3]
    assert dark["feature"] == {"id": None, "code": None, "name": "Dark mode"}
    assert _fixes(dark) == [("add_to_ground_truth", "Dark mode"),
                            ("link_to_feature", "Dark mode")]  # fmt: skip


async def test_only_confirmed_goals_and_links_count(client):
    w = await world()
    feats = w["features"]
    async with tenant_session(w["ctx"].tenant_id) as s:
        # F-01's only link to Grow is a run's proposal.
        edge = await s.scalar(select(Edge).where(Edge.src_id == uuid.UUID(feats["F-01"])))
        edge.status = "proposed"
        await s.commit()
    out = await _check(client, w["ctx"])
    assert [f["feature"]["id"] for f in _of(out, "no_goal")] == [feats["F-01"], feats["F-02"]]
    async with tenant_session(w["ctx"].tenant_id) as s:
        # Grow itself a run's proposal: no feature serves a confirmed goal.
        (await s.get(Entity, uuid.UUID(feats["grow"]))).status = "proposed"
        await s.commit()
    out = await _check(client, w["ctx"])
    assert {f["feature"]["id"] for f in _of(out, "no_goal")} == {
        feats["F-01"],
        feats["F-02"],
        feats["smart-search"],
        feats["F-03"],
    }


async def test_trashed_entries_are_left_out(client):
    w = await world()
    feats = w["features"]
    async with tenant_session(w["ctx"].tenant_id) as s:
        for k in ("F-02", "smart-search", "proposed"):
            (await s.get(Entity, uuid.UUID(feats[k]))).deleted_at = NOW
        await s.commit()
    out = await _check(client, w["ctx"])
    gone = {feats["F-02"], feats["smart-search"], feats["proposed"]}
    assert all((f.get("feature") or {}).get("id") not in gone for f in out["flags"])
    assert _of(out, "no_code") == [] and _of(out, "no_goal") == []
    # The item linked to the trashed feature reads as linked to none.
    d = next(f for f in _of(out, "unlinked_item") if f["item"]["id"] == w["items"]["d"])
    assert d["feature"] is None
    assert _fixes(d) == [("add_to_ground_truth", w["items"]["d"]),
                         ("link_to_feature", w["items"]["d"])]  # fmt: skip


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


async def _linked_in_draft(w: dict, item: str) -> tuple:
    """The item's published feature_id and the one its roadmap's working draft gives it."""
    async with tenant_session(w["ctx"].tenant_id) as s:
        row = await s.get(RoadmapItem, uuid.UUID(item))
        d = await s.scalar(
            select(SimpleDraft).where(
                SimpleDraft.document_id == row.roadmap_document_id,
                SimpleDraft.status.in_(("working", "submitted")),
            )
        )
        overlay = ((d.overlay or {}) if d else {}).get(item) or {}
        return row.feature_id, overlay.get("feature_id")


async def _serves(w: dict, feature_id: str) -> list[str]:
    async with tenant_session(w["ctx"].tenant_id) as s:
        q = select(Edge.dst_id).where(Edge.src_id == uuid.UUID(feature_id), Edge.type == "supports")
        return [str(x) for x in await s.scalars(q)]


async def test_an_add_links_a_published_item_through_its_draft(client):
    w = await world()
    b = w["items"]["b"]
    flagged = lambda out: [f["item"]["id"] for f in _of(out, "unlinked_item")]  # noqa: E731
    assert b in flagged(await _check(client, w["ctx"]))
    r = await client.post("/v1/baseline/entities", headers=w["ctx"].as_("owner"),
                          json={"type": "feature", "key": "F-21", "title": "Import history",
                                "serves": w["features"]["grow"], "roadmap_item_id": b})  # fmt: skip
    assert r.status_code == 201, r.text
    fid = r.json()["entity"]["id"]
    # One call: the feature, its goal and the item's link, in the roadmap's working draft.
    assert await _serves(w, fid) == [w["features"]["grow"]]
    assert await _linked_in_draft(w, b) == (None, fid)
    out = await _check(client, w["ctx"])
    assert b not in flagged(out)
    assert all((f.get("feature") or {}).get("id") != fid for f in out["flags"])


async def test_link_to_a_feature_is_a_change_in_the_draft(client):
    w = await world()
    b, f2 = w["items"]["b"], w["features"]["F-02"]
    body = {"op": "set_feature", "target": {"item_id": b}, "before": {"feature_id": None},
            "after": {"feature_id": f2}}  # fmt: skip
    r = await client.post("/v1/simple/changes", headers=w["ctx"].as_("owner"), json=body)
    assert r.status_code in (200, 201), r.text
    assert r.json()["change"]["status"] == "applied"
    assert await _linked_in_draft(w, b) == (None, f2)
    out = await _check(client, w["ctx"])
    assert b not in [f["item"]["id"] for f in _of(out, "unlinked_item")]
    # A feature listing the item's key no longer links it: only feature_id does.
    bad = {**body, "after": {"feature_id": w["items"]["a"]}}
    r = await client.post("/v1/simple/changes", headers=w["ctx"].as_("owner"),
                          json={**bad, "target": {"item_id": w["items"]["d"]},
                                "before": {"feature_id": w["features"]["proposed"]}})  # fmt: skip
    assert r.status_code == 422, r.text


async def test_a_commenters_add_is_one_proposal_with_its_link_and_goal(client):
    w = await world()
    b = w["items"]["b"]
    flagged = lambda out: [f["item"]["id"] for f in _of(out, "unlinked_item")]  # noqa: E731
    fields = {"type": "feature", "key": "F-21", "title": "Import history",
              "serves": w["features"]["grow"], "roadmap_item_id": b}  # fmt: skip
    body = {"op": "create", "kind": "entity", "fields": fields}
    h = w["ctx"].as_("commenter")
    one = await client.post("/v1/baseline/proposals", headers=h, json=body)
    two = await client.post("/v1/baseline/proposals", headers=h, json=body)
    assert one.status_code == two.status_code == 201, one.text
    assert one.json()["id"] == two.json()["id"]
    assert b in flagged(await _check(client, w["ctx"]))
    r = await client.post(f"/v1/baseline/proposals/{one.json()['id']}/accept",
                          headers=w["ctx"].as_("owner"))  # fmt: skip
    assert r.status_code == 200, r.text
    out = await _check(client, w["ctx"])
    assert b not in flagged(out)
    async with tenant_session(w["ctx"].tenant_id) as s:
        fid = str(await s.scalar(select(Entity.id).where(Entity.key == "F-21")))
    assert await _serves(w, fid) == [w["features"]["grow"]]
    assert all((f.get("feature") or {}).get("id") != fid for f in out["flags"])


async def test_a_prd_flag_carries_its_goal(client):
    w = await world()
    out = await _check(client, w["ctx"])
    f9 = next(f for f in _of(out, "prd_feature_missing") if f["feature"]["code"] == "F-09")
    grow = f9["goal"]
    assert grow is not None and grow["name"] == "Grow", f9
    # A commenter's Add for a PRD's feature carries its goal; approving it writes both.
    fields = {"type": "feature", "key": "F-09", "title": "Team invites", "serves": grow["id"]}
    r = await client.post("/v1/baseline/proposals", headers=w["ctx"].as_("commenter"),
                          json={"op": "create", "kind": "entity", "fields": fields})  # fmt: skip
    assert r.status_code == 201, r.text
    r = await client.post(f"/v1/baseline/proposals/{r.json()['id']}/accept",
                          headers=w["ctx"].as_("approver"))  # fmt: skip
    assert r.status_code == 200, r.text
    out = await _check(client, w["ctx"])
    assert all("F-09" != (f.get("feature") or {}).get("code") for f in out["flags"]), out


async def test_words_carry_no_ids(client):
    w = await world()
    out = await _check(client, w["ctx"])
    # code_differs: tests/test_ground_truth_confirm_code.py.
    assert {f["kind"] for f in out["flags"]} == set(KINDS) - {"code_differs"}
    ids = re.compile(r"[0-9a-f]{8}-|\b[A-Z]{1,3}-\d+|[a-z]+-[a-z]+|_")
    for f in out["flags"]:
        words = f["words"]
        assert words and words.endswith(".") and words.count(".") == 1, words
        assert len(words.split()) <= 16 and not ids.search(words), words


async def test_anyone_who_reads_the_roadmap_reads_it(client):
    w = await world()
    for who in ("viewer", "commenter", "approver", "owner"):
        assert (await _check(client, w["ctx"], who))["total"] == 8
    r = await client.get(CHECK)
    assert r.status_code == 401


async def test_scoped_to_the_company(client):
    w = await world()
    other = await make_ctx("Other Example Co")
    out = await _check(client, other)
    assert out["flags"] == [] and out["total"] == 0
    assert out["counts"] == dict.fromkeys(KINDS, 0)
    assert (await _check(client, w["ctx"]))["total"] == 8


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


async def test_entity_create_keeps_codes_and_links_to_features(client):
    w = await world()
    h = w["ctx"].as_("owner")
    goal = {"type": "goal", "key": "F-30", "title": "Keep teams"}
    r = await client.post("/v1/baseline/entities", headers=h, json=goal)
    assert r.status_code == 422 and "Only a feature's key can be a feature code." in r.text, r.text
    bad = {
        "type": "goal",
        "key": "keep-teams",
        "title": "Keep teams",
        "serves": w["features"]["grow"],
    }
    r = await client.post("/v1/baseline/entities", headers=h, json=bad)
    assert r.status_code == 422, r.text
    assert "Only a feature serves a goal or is a roadmap item." in r.text, r.text
    r = await client.post("/v1/baseline/entities", headers=h,
                          json={"type": "goal", "key": "keep-teams", "title": "Keep teams",
                                "roadmap_item_id": w["items"]["b"]})  # fmt: skip
    assert r.status_code == 422, r.text
    async with tenant_session(w["ctx"].tenant_id) as s:
        assert (
            await s.scalar(select(Entity.id).where(Entity.key.in_(("F-30", "keep-teams")))) is None
        )


async def test_a_proposal_carries_the_link_and_goal_of_a_feature_only(client):
    w = await world()
    h = w["ctx"].as_("commenter")
    goal = {
        "type": "goal",
        "key": "keep-teams",
        "title": "Keep teams",
        "serves": w["features"]["grow"],
    }
    r = await client.post("/v1/baseline/proposals", headers=h,
                          json={"op": "create", "kind": "entity", "fields": goal})  # fmt: skip
    assert r.status_code == 422, r.text
    assert "Only a feature serves a goal or is a roadmap item." in r.text, r.text
    bad = {"type": "feature", "key": "F-21", "title": "Import history", "roadmap_item_id": "nope"}
    r = await client.post("/v1/baseline/proposals", headers=h,
                          json={"op": "create", "kind": "entity", "fields": bad})  # fmt: skip
    assert r.status_code == 422, r.text
    # The item's id is stored as an id: the same ask in another spelling is the same proposal.
    b = w["items"]["b"]
    fields = {"type": "feature", "key": "F-21", "title": "Import history", "roadmap_item_id": b}
    one = await client.post("/v1/baseline/proposals", headers=h,
                            json={"op": "create", "kind": "entity", "fields": fields})  # fmt: skip
    two = await client.post("/v1/baseline/proposals", headers=h,
                            json={"op": "create", "kind": "entity",
                                  "fields": {**fields, "roadmap_item_id": b.upper()}})  # fmt: skip
    assert one.status_code == two.status_code == 201, two.text
    assert one.json()["id"] == two.json()["id"]
    assert one.json()["payload"]["fields"]["roadmap_item_id"] == b


async def test_an_add_while_the_roadmaps_draft_waits_says_why(client):
    w = await world()
    h = w["ctx"].as_("owner")
    # A change to another item opens the roadmap's draft; it is sent for approval.
    f2 = w["features"]["F-02"]
    body = {"op": "set_feature", "target": {"item_id": w["items"]["b"]},
            "before": {"feature_id": None}, "after": {"feature_id": f2}}  # fmt: skip
    r = await client.post("/v1/simple/changes", headers=h, json=body)
    assert r.status_code in (200, 201), r.text
    drafts = (await client.get("/v1/simple/drafts", headers=h)).json()
    d = next(x for x in drafts if x["status"] == "working")
    r = await client.post(f"/v1/simple/drafts/{d['id']}/submit", headers=h)
    assert r.status_code == 200, r.text
    r = await client.post("/v1/baseline/entities", headers=h,
                          json={"type": "feature", "key": "F-21", "title": "Import history 2",
                                "roadmap_item_id": w["items"]["d"]})  # fmt: skip
    assert r.status_code == 409, r.text
    detail = r.json()["detail"]
    assert "waiting for approval" in detail and "Import history 2" in detail, detail
    assert "No such roadmap item" not in detail
    # Nothing is half made: no feature without its link.
    async with tenant_session(w["ctx"].tenant_id) as s:
        assert await s.scalar(select(Entity.id).where(Entity.key == "F-21")) is None
