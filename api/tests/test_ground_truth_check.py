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
  milestone, or a slice reads no code.
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
                             "prd_feature_missing": 2, "no_code": 1, "no_goal": 1,
                             "runs_today_on_roadmap": 1}  # fmt: skip
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
        ids = {str(b.id): "F-15b", str(x.id): "F-15a", str(y.id): "F-15b"}
    out = await _check(client, w["ctx"])
    # F-15 is one flag, however many milestones or items it has.
    assert [f["feature"]["code"] for f in _of(out, "prd_feature_missing")] == ["F-09", "F-15"]
    assert [f["item"]["id"] for f in _of(out, "slice_parent_missing")] == [w["items"]["report"]]
    unlinked = {f["item"]["id"]: f["item"]["code"] for f in _of(out, "unlinked_item")}
    for i, code in ids.items():
        assert unlinked[i] == code


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
