"""The Ground Truth check's two fixes that had no route (the owner's follow-up, Nov 5):
Give it a code (``POST /v1/baseline/entities/{id}/code``, undone by ``DELETE``) and Link to a
feature for a PRD's feature or slice (``POST /v1/baseline/prd-links``, undone by ``DELETE``).
Approvers and owners act at once; a commenter's fix is a proposal an approver accepts;
viewers make none. Against Postgres. Invented data only.

Test cards (protects / fails_when / no_claim):

- test_give_code_gives_the_next_number: protects=a Ground Truth feature with no code gets the
  company's highest F-number + 1 (PRD codes counted), stored as its key, so the check stops
  flagging it; Undo gives the old key back and the flag returns; fails_when=a taken number is
  given, the flag stays, or Undo leaves the code.
- test_a_slice_keeps_its_parents_number: protects=a feature whose parent feature is F-02
  reads F-02a, the next one F-02b; fails_when=a slice gets a new number.
- test_give_code_refusals: protects=a feature that has a code, a slice whose feature has none,
  a feature only proposed and a goal are refused; fails_when=any is renumbered.
- test_a_commenter_proposes_a_code: protects=a commenter's Give it a code is a proposal (the
  key unchanged, the flag kept) that an approver's accept applies; a viewer is refused;
  fails_when=a commenter renumbers at once, or the accept does nothing.
- test_link_a_prd_feature: protects=linking the PRD's F-09 to F-02 stops its flag, and its
  plan reads F-02; linking F-15 clears its flag and leaves its roadmap items (F-15a, F-15)
  unflagged, as items of that feature; Undo brings the flag back; fails_when=the link is lost,
  the PRD keeps its own code, or an item of the linked feature is still flagged.
- test_link_a_plan_code_read_one_way: protects=a plan feature coded f-21, which the check
  names F-21, is linked by F-21 and its flag goes; fails_when=the link says no such feature.
- test_link_refusals: protects=an unknown code, a feature only proposed, an existing link and
  a viewer are refused; fails_when=any is linked.
- test_a_commenter_proposes_a_link: protects=a commenter's link is a proposal an approver's
  accept applies; fails_when=it links at once or never.
- test_add_a_slices_feature_by_its_code: protects=Add to Ground Truth on a slice item's flag
  (F-16a) adds its feature with key F-16, so every slice of it (F-16a, F-16b) is in the Ground
  Truth by code at once, and the new feature has its code (no no_code); fails_when=a slice
  stays flagged, a second add is needed, or the new feature has no code. A feature with a name
  key linked to F-16a alone leaves F-16b flagged (why the key is the code).
- test_add_a_prd_feature_by_its_code: protects=Add to Ground Truth on the PRD's F-09 adds it
  with key F-09 (then the PRD's feature is linked to it): no prd_feature_missing, no no_code,
  and Give it a code is not needed; a code key is a feature's only, and once; fails_when=the
  key F-09 is refused, the new feature reads no code or the PRD's feature stays flagged.
- test_a_code_key_is_read_one_way_and_taken_once: protects=a code key is stored as the check
  reads it (F-9 and F-009 are F-09; F-9a is F-09a), and refused with "Another feature already
  has the code F-09." when any feature reads that code: by its key (F-9, F-009 after F-09; F-09
  after F-9), through a published roadmap item's PRD section (a slug feature on f-40 reads
  F-40), or as a code given and taken back (an alias Give it a code never gives again);
  fails_when=two features read one code, a code key reads F-40.2, or the refusal names a
  type:key.
- test_scoped_to_the_company: protects=another company cannot give our feature a code or link
  our PRD; fails_when=a route reaches across tenants.
"""

import uuid

import pytest
from sqlalchemy import select

from oracle import company_time
from oracle.baseline.models import Entity
from oracle.docs.models import DocumentVersion
from oracle.roadmap.models import RoadmapItem
from oracle.simple.models import SimplePrdPlan
from oracle.tenancy import tenant_session
from tests.baseline_helpers import entity, make_ctx
from tests.test_ground_truth_check import PLAN, _check, _of, world
from tests.test_simple_roadmap_api import NOW, Seed

LINKS = "/v1/baseline/prd-links"


@pytest.fixture(autouse=True)
def clock(monkeypatch):
    monkeypatch.setattr(company_time, "now", lambda: NOW)


def code_url(feature_id: str) -> str:
    return f"/v1/baseline/entities/{feature_id}/code"


async def _key(ctx, feature_id: str) -> str:
    async with tenant_session(ctx.tenant_id) as s:
        return (await s.get(Entity, uuid.UUID(feature_id))).key


async def _child(ctx, parent_id: str, key: str, title: str) -> str:
    async with tenant_session(ctx.tenant_id) as s:
        e = Entity(type="feature", key=key, title=title, status="confirmed", origin="user",
                   parent_id=uuid.UUID(parent_id))  # fmt: skip
        s.add(e)
        await s.commit()
        return str(e.id)


async def test_give_code_gives_the_next_number(client):
    w = await world()
    ctx, search = w["ctx"], w["features"]["smart-search"]
    assert [f["feature"]["id"] for f in _of(await _check(client, ctx), "no_code")] == [search]
    r = await client.post(code_url(search), headers=ctx.as_("approver"))
    assert r.status_code == 200, r.text
    out = r.json()
    # F-01..F-03 in the Ground Truth, F-09 and F-15 in the PRD: the next is F-16.
    assert out["status"] == "done" and out["code"] == "F-16" and out["proposal_id"] is None
    assert out["feature"] == {"id": search, "code": "F-16", "name": "Smart Search"}
    assert await _key(ctx, search) == "F-16"
    check = await _check(client, ctx)
    assert check["counts"]["no_code"] == 0 and _of(check, "no_code") == []
    # Undo: the old key back, the flag back.
    r = await client.delete(code_url(search), headers=ctx.as_("owner"))
    assert r.status_code == 200, r.text
    assert await _key(ctx, search) == "smart-search"
    assert _of(await _check(client, ctx), "no_code")[0]["feature"]["id"] == search
    # A second undo has nothing to undo.
    r = await client.delete(code_url(search), headers=ctx.as_("owner"))
    assert r.status_code == 409


async def test_a_slice_keeps_its_parents_number(client):
    w = await world()
    ctx, f2 = w["ctx"], w["features"]["F-02"]
    a = await _child(ctx, f2, "audit-export", "Audit export")
    b = await _child(ctx, f2, "audit-search", "Audit search")
    r = await client.post(code_url(a), headers=ctx.as_("owner"))
    assert r.status_code == 200, r.text
    assert r.json()["code"] == "F-02a"
    r = await client.post(code_url(b), headers=ctx.as_("owner"))
    assert r.json()["code"] == "F-02b"
    assert [f["feature"]["id"] for f in _of(await _check(client, ctx), "no_code")] == [
        w["features"]["smart-search"]
    ]


async def test_give_code_refusals(client):
    w = await world()
    ctx, feats = w["ctx"], w["features"]
    r = await client.post(code_url(feats["F-01"]), headers=ctx.as_("owner"))
    assert r.status_code == 409 and "already" in r.json()["detail"]
    orphan = await _child(ctx, feats["smart-search"], "search-filters", "Search filters")
    r = await client.post(code_url(orphan), headers=ctx.as_("owner"))
    assert r.status_code == 409 and "its feature" in r.json()["detail"]
    r = await client.post(code_url(feats["proposed"]), headers=ctx.as_("owner"))
    assert r.status_code == 409
    async with tenant_session(ctx.tenant_id) as s:
        goal = await s.scalar(select(Entity.id).where(Entity.type == "goal"))
    r = await client.post(code_url(str(goal)), headers=ctx.as_("owner"))
    assert r.status_code == 404
    r = await client.post(code_url(str(uuid.uuid4())), headers=ctx.as_("owner"))
    assert r.status_code == 404
    assert await _key(ctx, feats["F-01"]) == "F-01"
    assert await _key(ctx, orphan) == "search-filters"


async def test_a_commenter_proposes_a_code(client):
    w = await world()
    ctx, search = w["ctx"], w["features"]["smart-search"]
    r = await client.post(code_url(search), headers=ctx.as_("viewer"))
    assert r.status_code == 403
    r = await client.post(code_url(search), headers=ctx.as_("commenter"))
    assert r.status_code == 200, r.text
    out = r.json()
    assert out["status"] == "proposed" and out["proposal_id"] and out["code"] is None
    assert await _key(ctx, search) == "smart-search"
    assert len(_of(await _check(client, ctx), "no_code")) == 1
    # Asking again is the same proposal.
    again = await client.post(code_url(search), headers=ctx.as_("commenter"))
    assert again.json()["proposal_id"] == out["proposal_id"]
    r = await client.get("/v1/baseline/proposals?status=open", headers=ctx.as_("approver"))
    mine = next(p for p in r.json() if p["id"] == out["proposal_id"])
    assert mine["summary"] == "Give “Smart Search” a feature code"
    r = await client.post(
        f"/v1/baseline/proposals/{out['proposal_id']}/accept", headers=ctx.as_("approver")
    )
    assert r.status_code == 200, r.text
    assert await _key(ctx, search) == "F-16"
    assert _of(await _check(client, ctx), "no_code") == []


async def _plan_codes(client, ctx, prd: str) -> list[str]:
    r = await client.get(f"/v1/simple/prds/{prd}/plan", headers=ctx.as_("viewer"))
    assert r.status_code == 200, r.text
    return [s["code"] for s in r.json()["slices"]]


async def test_link_a_prd_feature(client):
    w = await world()
    ctx, prd, feats = w["ctx"], w["prd"][0], w["features"]
    assert await _plan_codes(client, ctx, prd) == ["F-01", "F-09", "F-15a", "F-15b"]
    body = {"prd_document_id": prd, "code": "F-09", "feature_id": feats["F-02"]}
    r = await client.post(LINKS, json=body, headers=ctx.as_("approver"))
    assert r.status_code == 200, r.text
    out = r.json()
    assert out["status"] == "done" and out["proposal_id"] is None
    assert out["feature"] == {"id": feats["F-02"], "code": "F-02", "name": "Audit log"}
    check = await _check(client, ctx)
    assert [f["feature"]["code"] for f in _of(check, "prd_feature_missing")] == ["F-15"]
    assert check["counts"]["prd_feature_missing"] == 1
    # The PRD reads the Ground Truth feature's code.
    assert await _plan_codes(client, ctx, prd) == ["F-01", "F-02", "F-15a", "F-15b"]
    # Its roadmap items too (a slice item F-15a, an item of F-15): flagged while F-15 is not
    # in the Ground Truth, unflagged once it is linked to one.
    prd_id, pv_id, rv_id = w["seed"]
    async with tenant_session(ctx.tenant_id) as s:
        seed = Seed(s)
        rv = await s.get(DocumentVersion, rv_id)
        pv = await s.get(DocumentVersion, pv_id)
        part = await seed.item(rv, pv, "usage-a", title="Usage export slice", position=5,
                               prd_section_key="f-15a")  # fmt: skip
        whole = await seed.item(rv, pv, "usage-x", title="Usage export start", position=6,
                                prd_section_key="f-15")  # fmt: skip
        await s.commit()
        of_f15 = {str(part.id), str(whole.id)}
    check = await _check(client, ctx)
    assert of_f15 <= {f["item"]["id"] for f in _of(check, "unlinked_item")}
    body15 = {"prd_document_id": prd, "code": "F-15", "feature_id": feats["F-03"]}
    r = await client.post(LINKS, json=body15, headers=ctx.as_("owner"))
    assert r.status_code == 200, r.text
    check = await _check(client, ctx)
    assert check["counts"]["prd_feature_missing"] == 0
    # They are F-03's now: in the Ground Truth, and flagged only as F-03 runs today.
    for kind in ("unlinked_item", "slice_parent_missing"):
        assert of_f15.isdisjoint(f["item"]["id"] for f in _of(check, kind))
    running = {f["item"]["id"]: f["feature"]["id"] for f in _of(check, "runs_today_on_roadmap")}
    assert all(running[i] == feats["F-03"] for i in of_f15)
    # The roadmap's own slice item of F-16 (in no PRD) is not F-15's.
    assert [f["item"]["id"] for f in _of(check, "slice_parent_missing")] == [w["items"]["report"]]
    assert await _plan_codes(client, ctx, prd) == ["F-01", "F-02", "F-03a", "F-03b"]
    # A newer reading of the same approved version keeps the links.
    async with tenant_session(ctx.tenant_id) as s:
        row = await s.scalar(select(SimplePrdPlan))
        assert row.data["links"] == {"F-09": feats["F-02"], "F-15": feats["F-03"]}
    # Undo.
    r = await client.request(
        "DELETE", LINKS, params={"prd_document_id": prd, "code": "F-09"},
        headers=ctx.as_("approver"),
    )  # fmt: skip
    assert r.status_code == 200, r.text
    assert [
        f["feature"]["code"] for f in _of(await _check(client, ctx), "prd_feature_missing")
    ] == ["F-09"]
    r = await client.request(
        "DELETE", LINKS, params={"prd_document_id": prd, "code": "F-09"},
        headers=ctx.as_("approver"),
    )  # fmt: skip
    assert r.status_code == 409


async def test_link_a_plan_code_read_one_way(client):
    plan = {**PLAN, "features": [*PLAN["features"], {"code": "f-21", "name": "Seat limits"}]}
    w = await world(plan)
    ctx, prd, feats = w["ctx"], w["prd"][0], w["features"]
    # The check names it F-21; linking F-21 finds the plan's f-21 and clears its flag.
    check = await _check(client, ctx)
    assert "F-21" in [f["feature"]["code"] for f in _of(check, "prd_feature_missing")]
    body = {"prd_document_id": prd, "code": "F-21", "feature_id": feats["F-02"]}
    r = await client.post(LINKS, json=body, headers=ctx.as_("approver"))
    assert r.status_code == 200, r.text
    check = await _check(client, ctx)
    assert "F-21" not in [f["feature"]["code"] for f in _of(check, "prd_feature_missing")]


async def test_link_refusals(client):
    w = await world()
    ctx, prd, feats = w["ctx"], w["prd"][0], w["features"]

    async def link(code: str, feature: str, who: str = "owner"):
        body = {"prd_document_id": prd, "code": code, "feature_id": feature}
        return await client.post(LINKS, json=body, headers=ctx.as_(who))

    assert (await link("F-09", feats["F-02"], "viewer")).status_code == 403
    assert (await link("F-77", feats["F-02"])).status_code == 404
    assert (await link("F-09", feats["proposed"])).status_code == 409
    assert (await link("F-09", str(uuid.uuid4()))).status_code == 404
    body = {"prd_document_id": str(uuid.uuid4()), "code": "F-09", "feature_id": feats["F-02"]}
    assert (await client.post(LINKS, json=body, headers=ctx.as_("owner"))).status_code == 404
    assert (await link("F-09", feats["F-02"])).status_code == 200
    r = await link("F-09", feats["F-01"])
    assert r.status_code == 409 and "already" in r.json()["detail"]
    assert len(_of(await _check(client, ctx), "prd_feature_missing")) == 1


async def test_a_commenter_proposes_a_link(client):
    w = await world()
    ctx, prd, feats = w["ctx"], w["prd"][0], w["features"]
    body = {"prd_document_id": prd, "code": "F-09", "feature_id": feats["F-02"]}
    r = await client.post(LINKS, json=body, headers=ctx.as_("commenter"))
    assert r.status_code == 200, r.text
    out = r.json()
    assert out["status"] == "proposed" and out["proposal_id"]
    assert len(_of(await _check(client, ctx), "prd_feature_missing")) == 2
    r = await client.get("/v1/baseline/proposals?status=open", headers=ctx.as_("approver"))
    mine = next(p for p in r.json() if p["id"] == out["proposal_id"])
    assert mine["summary"] == "Link the PRD’s F-09 Team invites to “Audit log”"
    r = await client.post(
        f"/v1/baseline/proposals/{out['proposal_id']}/accept", headers=ctx.as_("approver")
    )
    assert r.status_code == 200, r.text
    assert len(_of(await _check(client, ctx), "prd_feature_missing")) == 1


async def test_scoped_to_the_company(client):
    w = await world()
    ctx, prd, feats = w["ctx"], w["prd"][0], w["features"]
    other = await make_ctx("Other Example Co")
    r = await client.post(code_url(feats["smart-search"]), headers=other.as_("owner"))
    assert r.status_code == 404
    body = {"prd_document_id": prd, "code": "F-09", "feature_id": feats["F-02"]}
    r = await client.post(LINKS, json=body, headers=other.as_("owner"))
    assert r.status_code == 404
    assert await _key(ctx, feats["smart-search"]) == "smart-search"
    assert len(_of(await _check(client, ctx), "prd_feature_missing")) == 2


async def test_add_a_slices_feature_by_its_code(client):
    w = await world()
    ctx = w["ctx"]
    prd_id, pv_id, rv_id = w["seed"]
    async with tenant_session(ctx.tenant_id) as s:
        rv = await s.get(DocumentVersion, rv_id)
        pv = await s.get(DocumentVersion, pv_id)
        b = await Seed(s).item(rv, pv, "report-b", title="Usage chart", position=5,
                               prd_section_key="f-16b")  # fmt: skip
        await s.commit()
        slices = {w["items"]["report"], str(b.id)}
    check = await _check(client, ctx)
    flagged = {f["item"]["id"]: f for f in _of(check, "slice_parent_missing")}
    assert set(flagged) == slices
    # Both flags name the same feature to add, F-16.
    assert {x["target"] for f in flagged.values() for x in f["fixes"]
            if x["action"] == "add_to_ground_truth"} == {"F-16"}  # fmt: skip
    # A feature with a name key linked to F-16a alone: F-16b is still flagged.
    async with tenant_session(ctx.tenant_id) as s:
        other = Entity(type="feature", key="usage-report", title="Usage report",
                       status="confirmed", origin="user")  # fmt: skip
        s.add(other)
        await s.flush()
        item = await s.get(RoadmapItem, uuid.UUID(w["items"]["report"]))
        item.feature_id = other.id
        await s.commit()
    check = await _check(client, ctx)
    assert [f["item"]["id"] for f in _of(check, "slice_parent_missing")] == [str(b.id)]
    async with tenant_session(ctx.tenant_id) as s:
        item = await s.get(RoadmapItem, uuid.UUID(w["items"]["report"]))
        item.feature_id = None
        await s.delete(await s.get(Entity, other.id))
        await s.commit()
    # Add to Ground Truth: the feature keyed by its code, F-16. One add clears both slices.
    added = await entity(client, ctx, "approver", type="feature", key="F-16",
                         title="Usage report", origin="user")  # fmt: skip
    assert added["status"] == "confirmed"
    check = await _check(client, ctx)
    assert check["counts"]["slice_parent_missing"] == 0
    for kind in ("unlinked_item", "slice_parent_missing", "no_code"):
        flagged = _of(check, kind)
        assert slices.isdisjoint((f.get("item") or {}).get("id") for f in flagged)
        assert added["id"] not in {(f.get("feature") or {}).get("id") for f in flagged}


async def test_add_a_prd_feature_by_its_code(client):
    w = await world()
    ctx, prd = w["ctx"], w["prd"][0]
    check = await _check(client, ctx)
    assert "F-09" in {f["feature"]["code"] for f in _of(check, "prd_feature_missing")}
    no_code = check["counts"]["no_code"]
    added = await entity(client, ctx, "approver", type="feature", key="F-09",
                         title="Team invites", origin="user")  # fmt: skip
    body = {"prd_document_id": prd, "code": "F-09", "feature_id": added["id"]}
    r = await client.post(LINKS, json=body, headers=ctx.as_("approver"))
    assert r.status_code == 200, r.text
    check = await _check(client, ctx)
    assert [f["feature"]["code"] for f in _of(check, "prd_feature_missing")] == ["F-15"]
    assert check["counts"]["no_code"] == no_code
    assert added["id"] not in {f["feature"]["id"] for f in _of(check, "no_code")}
    # It reads F-09, on the check and in the PRD's plan.
    assert {"id": added["id"], "code": "F-09", "name": "Team invites"} in [
        f["feature"] for f in _of(check, "no_goal")
    ]
    assert await _plan_codes(client, ctx, prd) == ["F-01", "F-09", "F-15a", "F-15b"]
    # A code key is a feature's, and taken once.
    for body in ({"type": "goal", "key": "F-30", "title": "Grow more"},
                 {"type": "feature", "key": "F-09", "title": "Team invites 2"},
                 {"type": "feature", "key": "F-31X", "title": "Odd"}):  # fmt: skip
        r = await client.post("/v1/baseline/entities", json=body, headers=ctx.as_("owner"))
        assert r.status_code in (409, 422), (body, r.text)


async def _create(client, ctx, key: str, title: str = "Team invites"):
    body = {"type": "feature", "key": key, "title": title}
    return await client.post("/v1/baseline/entities", json=body, headers=ctx.as_("owner"))


async def test_a_code_key_is_read_one_way_and_taken_once(client):
    w = await world()
    ctx, search = w["ctx"], w["features"]["smart-search"]
    taken = "Another feature already has the code {}."
    # F-9 is stored as the check reads it, F-09; F-9a keeps its slice letter.
    r = await _create(client, ctx, "F-9")
    assert r.status_code == 201, r.text
    assert r.json()["entity"]["key"] == "F-09"
    r = await _create(client, ctx, "F-9a", "Team invites by link")
    assert r.status_code == 201, r.text
    assert r.json()["entity"]["key"] == "F-09a"
    for key in ("F-09", "F-9", "F-009"):
        r = await _create(client, ctx, key, "Team invites 2")
        assert r.status_code == 409, (key, r.text)
        assert r.json()["detail"] == taken.format("F-09")
    r = await _create(client, ctx, "F-009a", "Team invites 3")
    assert r.status_code == 409 and r.json()["detail"] == taken.format("F-09a")
    # A slug feature on a published item from the PRD's section f-40 reads F-40: taken.
    async with tenant_session(ctx.tenant_id) as s:
        item = await s.get(RoadmapItem, uuid.UUID(w["items"]["b"]))
        item.feature_id, item.prd_section_key = uuid.UUID(search), "f-40"
        await s.commit()
    for key in ("F-40", "F-040"):
        r = await _create(client, ctx, key, "Search 2")
        assert r.status_code == 409, (key, r.text)
        assert r.json()["detail"] == taken.format("F-40")
    # A code given and taken back stays its feature's alias: never another feature's.
    async with tenant_session(ctx.tenant_id) as s:
        item = await s.get(RoadmapItem, uuid.UUID(w["items"]["b"]))
        item.feature_id = item.prd_section_key = None
        await s.commit()
    r = await client.post(code_url(search), headers=ctx.as_("approver"))
    assert r.status_code == 200, r.text
    code = r.json()["code"]
    r = await client.delete(code_url(search), headers=ctx.as_("owner"))
    assert r.status_code == 200, r.text
    r = await _create(client, ctx, code, "Search 3")
    assert r.status_code == 409 and r.json()["detail"] == taken.format(code)
    # No two Ground Truth features read one code.
    codes = [f["feature"]["code"] for f in _of(await _check(client, ctx), "no_goal")]
    assert len(codes) == len(set(codes)) and "F-09" in codes and "F-09.2" not in codes
