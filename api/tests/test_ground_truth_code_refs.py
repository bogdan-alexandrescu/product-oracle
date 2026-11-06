"""Give it a code, round 1 (the owner's decision, Nov 5): the code is stored as the feature's
key, and the same change keeps everything that names the feature by its old key pointing at
it; Undo puts them back. Two approvers giving codes at once never get a server error. The
next code counts the codes of every PRD, its plan read or not. Against Postgres. Invented
data only.

Test cards (protects / fails_when / no_claim):

- test_an_older_export_maps_the_old_key_to_the_feature: protects=re-importing a Ground Truth
  export taken before the code was given updates the feature (its edges too) and adds no
  second one; fails_when=the import adds a feature under the old key or refuses an edge.
- test_tech_briefs_follow_the_code: protects=a tech brief's feature_key is rewritten to the
  code in the same change and back on Undo; fails_when=the brief keeps naming the old key.
- test_a_citation_of_the_old_key_is_still_valid: protects=a draft citing "baseline feature
  <old key>" is not refused as invalid_citation once the code is given; fails_when=it is.
- test_a_launch_finds_the_feature_by_its_old_key: protects=a roadmap item named by the old
  key with no feature id still reads its feature (launch tiers); fails_when=it reads none.
- test_undo_is_refused_when_the_old_key_is_taken: protects=Undo says why and changes
  nothing when another feature took the old key since; fails_when=it rewrites anything.
- test_two_approvers_at_once: protects=two codes given at the same moment (both reading
  F-16) end as F-16 and F-17, no 500; also an approver's accept of a commenter's code;
  fails_when=the second write's unique key error reaches the caller.
- test_an_unread_prds_codes_are_counted: protects=a PRD whose plan was never read still
  counts its feature codes; fails_when=its F-30 is given again.
- no_claim: the web; the check's flags (tests/test_ground_truth_fixes.py).
"""

import asyncio
import hashlib
import uuid
from datetime import UTC, datetime

import pytest
import yaml
from sqlalchemy import select

from oracle import company_time
from oracle.baseline import fixes
from oracle.baseline.models import Entity
from oracle.docs import service as docs_service
from oracle.docs.models import Document, DocumentVersion
from oracle.docs.parser import CitationIn
from oracle.launches import tiers
from oracle.roadmap.models import RoadmapItem
from oracle.tenancy import tenant_session
from oracle.v2.models import ArtifactRequest
from tests.test_ground_truth_check import world
from tests.test_ground_truth_fixes import _key, code_url
from tests.test_simple_roadmap_api import NOW

YAML = "/v1/baseline/yaml"


@pytest.fixture(autouse=True)
def clock(monkeypatch):
    monkeypatch.setattr(company_time, "now", lambda: NOW)


async def _top(ctx, key: str, title: str) -> str:
    async with tenant_session(ctx.tenant_id) as s:
        e = Entity(type="feature", key=key, title=title, status="confirmed", origin="user")
        s.add(e)
        await s.commit()
        return str(e.id)


async def _features(ctx, key: str) -> list[uuid.UUID]:
    async with tenant_session(ctx.tenant_id) as s:
        return list(
            await s.scalars(select(Entity.id).where(Entity.type == "feature", Entity.key == key))
        )


async def _export(client, ctx) -> str:
    """The Ground Truth's YAML, each supports edge with a contribution (the seed has none)."""
    data = yaml.safe_load((await client.get(YAML, headers=ctx.as_("viewer"))).text)
    for e in data["edges"]:
        if e["type"] == "supports":
            e["attrs"] = {**(e.get("attrs") or {}), "contribution": 2}
    return yaml.safe_dump(data)


async def test_an_older_export_maps_the_old_key_to_the_feature(client):
    w = await world()
    ctx, search = w["ctx"], w["features"]["smart-search"]
    old = await _export(client, ctx)
    assert "key: smart-search" in old
    r = await client.post(code_url(search), headers=ctx.as_("approver"))
    assert r.json()["code"] == "F-16"
    r = await client.post(
        YAML, content=old.encode(), headers={**ctx.as_("owner"), "content-type": "application/yaml"}
    )
    assert r.status_code == 200, r.text
    assert r.json()["created"] == 0
    assert await _features(ctx, "smart-search") == []
    assert await _key(ctx, search) == "F-16"
    # Its edge (supports grow) still reads the feature.
    data = yaml.safe_load((await client.get(YAML, headers=ctx.as_("viewer"))).text)
    assert {"src": "feature:F-16", "dst": "goal:grow"} in [
        {"src": e["src"], "dst": e["dst"]} for e in data["edges"]
    ]
    # Undo, then an export taken while it was F-16 still maps to it.
    newer = await _export(client, ctx)
    assert (await client.delete(code_url(search), headers=ctx.as_("owner"))).status_code == 200
    r = await client.post(
        YAML,
        content=newer.encode(),
        headers={**ctx.as_("owner"), "content-type": "application/yaml"},
    )
    assert r.status_code == 200, r.text
    assert r.json()["created"] == 0 and await _features(ctx, "F-16") == []
    assert await _key(ctx, search) == "smart-search"


async def _brief(ctx, prd_id: str, key: str) -> uuid.UUID:
    async with tenant_session(ctx.tenant_id) as s:
        req = ArtifactRequest(kind="tech_brief", title="Brief",
                              source_document_id=uuid.UUID(prd_id),
                              params={"feature_key": key, "segment_seq": 1})  # fmt: skip
        s.add(req)
        await s.commit()
        return req.id


async def _brief_key(ctx, req_id: uuid.UUID) -> str:
    async with tenant_session(ctx.tenant_id) as s:
        return (await s.get(ArtifactRequest, req_id)).params["feature_key"]


async def test_tech_briefs_follow_the_code(client):
    w = await world()
    ctx, search = w["ctx"], w["features"]["smart-search"]
    mine = await _brief(ctx, w["prd"][0], "smart-search")
    other = await _brief(ctx, w["prd"][0], "F-01")
    assert (await client.post(code_url(search), headers=ctx.as_("owner"))).status_code == 200
    assert await _brief_key(ctx, mine) == "F-16"
    assert await _brief_key(ctx, other) == "F-01"
    assert (await client.delete(code_url(search), headers=ctx.as_("owner"))).status_code == 200
    assert await _brief_key(ctx, mine) == "smart-search"
    assert await _brief_key(ctx, other) == "F-01"


async def _refused(ctx, ref: str) -> list[str]:
    async with tenant_session(ctx.tenant_id) as s:
        return [
            p.code
            for p in await docs_service._oracle_ref_problems(
                s, [CitationIn(id="c1", source="oracle", ref=ref)]
            )
        ]


async def test_a_citation_of_the_old_key_is_still_valid(client):
    w = await world()
    ctx, search = w["ctx"], w["features"]["smart-search"]
    ref = "baseline feature smart-search (search), locked"
    assert await _refused(ctx, ref) == []
    assert (await client.post(code_url(search), headers=ctx.as_("owner"))).status_code == 200
    assert await _refused(ctx, ref) == []
    assert await _refused(ctx, "baseline feature F-16") == []
    assert await _refused(ctx, "baseline feature made-up") == ["invalid_citation"]
    assert (await client.delete(code_url(search), headers=ctx.as_("owner"))).status_code == 200
    assert await _refused(ctx, ref) == []


async def test_a_launch_finds_the_feature_by_its_old_key(client):
    w = await world()
    ctx, search = w["ctx"], w["features"]["smart-search"]
    item = RoadmapItem(item_key="smart-search", title="Smart Search")
    assert (await client.post(code_url(search), headers=ctx.as_("owner"))).status_code == 200
    async with tenant_session(ctx.tenant_id) as s:
        found = await tiers._feature(s, item)
        assert found is not None and str(found.id) == search
    assert (await client.delete(code_url(search), headers=ctx.as_("owner"))).status_code == 200
    async with tenant_session(ctx.tenant_id) as s:
        found = await tiers._feature(s, RoadmapItem(item_key="F-16", title="Smart Search"))
        assert found is not None and str(found.id) == search


async def test_undo_is_refused_when_the_old_key_is_taken(client):
    w = await world()
    ctx, search = w["ctx"], w["features"]["smart-search"]
    brief = await _brief(ctx, w["prd"][0], "smart-search")
    assert (await client.post(code_url(search), headers=ctx.as_("owner"))).status_code == 200
    await _top(ctx, "smart-search", "Smart Search 2")
    r = await client.delete(code_url(search), headers=ctx.as_("owner"))
    assert r.status_code == 409
    assert r.json()["detail"] == "Its old key is taken by another feature."
    assert await _key(ctx, search) == "F-16"
    assert await _brief_key(ctx, brief) == "F-16"


def _held(monkeypatch, block_at: dict[str, int]) -> None:
    """next_code returns, then waits until every feature in ``block_at`` reached its call
    number there: both writers have read the same next code before either writes it."""
    real = fixes.next_code
    calls: dict[str, int] = {}
    arrived: set[str] = set()
    both = asyncio.Event()

    async def held(db, feature):
        code = await real(db, feature)
        fid = str(feature.id)
        calls[fid] = calls.get(fid, 0) + 1
        if block_at.get(fid) == calls[fid]:
            arrived.add(fid)
            if arrived == set(block_at):
                both.set()
            await asyncio.wait_for(both.wait(), 20)
        return code

    monkeypatch.setattr(fixes, "next_code", held)


async def test_two_approvers_at_once(client, monkeypatch):
    w = await world()
    ctx, search = w["ctx"], w["features"]["smart-search"]
    chat = await _top(ctx, "team-chat", "Team chat")
    # The route reads the next code first (its refusals), then gives it: hold the second.
    _held(monkeypatch, {search: 2, chat: 2})
    a, b = await asyncio.gather(
        client.post(code_url(search), headers=ctx.as_("owner")),
        client.post(code_url(chat), headers=ctx.as_("approver")),
    )
    assert (a.status_code, b.status_code) == (200, 200), (a.text, b.text)
    assert sorted([a.json()["code"], b.json()["code"]]) == ["F-16", "F-17"]
    assert sorted([await _key(ctx, search), await _key(ctx, chat)]) == ["F-16", "F-17"]


async def test_an_accept_at_the_same_moment(client, monkeypatch):
    w = await world()
    ctx, search = w["ctx"], w["features"]["smart-search"]
    chat = await _top(ctx, "team-chat", "Team chat")
    r = await client.post(code_url(search), headers=ctx.as_("commenter"))
    proposal = r.json()["proposal_id"]
    # The accept gives the code at its first read; the other route at its second.
    _held(monkeypatch, {search: 1, chat: 2})
    a, b = await asyncio.gather(
        client.post(f"/v1/baseline/proposals/{proposal}/accept", headers=ctx.as_("approver")),
        client.post(code_url(chat), headers=ctx.as_("owner")),
    )
    assert (a.status_code, b.status_code) == (200, 200), (a.text, b.text)
    assert sorted([await _key(ctx, search), await _key(ctx, chat)]) == ["F-16", "F-17"]


async def test_a_taken_code_twice_is_a_conflict(client, monkeypatch):
    w = await world()
    ctx, search = w["ctx"], w["features"]["smart-search"]
    real = fixes.next_code
    calls = {"n": 0}

    async def stale(db, feature):
        await real(db, feature)
        calls["n"] += 1
        return "F-01"  # always a code another feature has

    monkeypatch.setattr(fixes, "next_code", stale)
    r = await client.post(code_url(search), headers=ctx.as_("owner"))
    assert r.status_code == 409 and r.json()["detail"] == "That code is taken; try again."
    assert await _key(ctx, search) == "smart-search"


async def test_an_unread_prds_codes_are_counted(client):
    w = await world()
    ctx, search = w["ctx"], w["features"]["smart-search"]
    body = (
        "# Team spaces\n\n| Milestone | Name | Start | End |\n|---|---|---|---|\n"
        "| M1 | Start | Nov 2 | Nov 30 |\n\n| Feature | Name | Milestone | Effort (weeks) |\n"
        "|---|---|---|---|\n| F-30 | Team spaces | M1 | 2 |\n"
    )
    async with tenant_session(ctx.tenant_id) as s:
        doc = Document(slug="team-spaces-prd", title="Team spaces", kind="prd",
                       status="approved", visibility="company")  # fmt: skip
        s.add(doc)
        await s.flush()
        s.add(DocumentVersion(document_id=doc.id, number=1, markdown=body,
                              content_hash=hashlib.sha256(body.encode()).hexdigest(),
                              approved_at=datetime(2026, 10, 1, tzinfo=UTC)))  # fmt: skip
        await s.commit()
    r = await client.post(code_url(search), headers=ctx.as_("owner"))
    assert r.status_code == 200, r.text
    assert r.json()["code"] == "F-31"
