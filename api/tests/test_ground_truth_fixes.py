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
  plan reads F-02; linking F-15 clears its slices' flags; Undo brings the flag back;
  fails_when=the link is lost or the PRD keeps its own code.
- test_link_refusals: protects=an unknown code, a feature only proposed, an existing link and
  a viewer are refused; fails_when=any is linked.
- test_a_commenter_proposes_a_link: protects=a commenter's link is a proposal an approver's
  accept applies; fails_when=it links at once or never.
- test_scoped_to_the_company: protects=another company cannot give our feature a code or link
  our PRD; fails_when=a route reaches across tenants.
"""

import uuid

import pytest
from sqlalchemy import select

from oracle import company_time
from oracle.baseline.models import Entity
from oracle.simple.models import SimplePrdPlan
from oracle.tenancy import tenant_session
from tests.baseline_helpers import make_ctx
from tests.test_ground_truth_check import _check, _of, world
from tests.test_simple_roadmap_api import NOW

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
    # Its slices too: linking F-15 clears both slice flags.
    body15 = {"prd_document_id": prd, "code": "F-15", "feature_id": feats["F-03"]}
    r = await client.post(LINKS, json=body15, headers=ctx.as_("owner"))
    assert r.status_code == 200, r.text
    check = await _check(client, ctx)
    assert check["counts"]["slice_parent_missing"] == 0
    assert check["counts"]["prd_feature_missing"] == 0
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
