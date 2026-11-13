"""Confirm it keeps a proposed feature's own code, and its proposed goal links
(docs/ground-truth.md: a feature is keyed by its own code when no other feature has it;
"Flag it, don't refuse"). Against Postgres. Invented data only.

Test cards (protects / fails_when / no_claim):

- test_confirm_keys_by_its_own_code: protects=Confirm it on a proposed feature whose Code
  attribute is F-07 keys it F-07; fails_when=it takes the next free number (F-36).
- test_confirm_keys_by_its_items_code: protects=a proposed feature with no Code attribute,
  confirmed through its roadmap slice item f-07a, is keyed F-07 (the letter dropped);
  fails_when=it takes the next free number.
- test_a_taken_code_falls_back_and_is_flagged: protects=when another feature has F-07 the
  confirmed feature takes the next number and is flagged ``code_differs``; fails_when=the
  confirm is refused, or the clash goes unflagged.
- test_confirm_confirms_its_proposed_goal_links: protects=confirming a feature confirms the
  goal links a run proposed with it: no ``no_goal``; fails_when=a false Serves no goal.
- test_picking_an_already_proposed_goal_confirms_it: protects=Pick a goal on a goal whose
  link is only proposed confirms that link; fails_when="This link already exists".
- test_the_repair_rekeys_a_mis_keyed_feature: protects=a feature keyed F-36 at its confirm
  while its own code is F-07 is flagged; Use its code re-keys it F-07, confirms its
  proposed goal links, and F-36 is never given again; fails_when=no flag, no fix, or F-36
  reused.
"""

import re
import uuid

import pytest
from sqlalchemy import select

from oracle import company_time
from oracle.baseline.models import Edge, Entity, EntityRevision
from oracle.simple.models import SimplePrdPlan
from oracle.tenancy import tenant_session
from tests.baseline_helpers import make_ctx
from tests.test_simple_roadmap_api import NOW, Seed

CHECK = "/v1/baseline/check"
PLAN = {
    "milestones": [{"code": "M1", "name": "Start"}],
    "features": [{"code": "F-07", "name": "Usage sync", "milestones": ["M1"]}],
    "goals": ["Grow"],
}


@pytest.fixture(autouse=True)
def clock(monkeypatch):
    monkeypatch.setattr(company_time, "now", lambda: NOW)


async def world(*, code: str | None = "F-07", section: str | None = "f-07", taken: bool = False):
    """A roadmap whose item ``section`` is linked to Usage sync, a feature a run proposed
    (Code attribute ``code``) with its proposed link to the confirmed goal Grow. F-35
    Night alerts is in the Ground Truth; ``taken``: so is F-07 Bulk import."""
    ctx = await make_ctx()
    async with tenant_session(ctx.tenant_id) as s:
        seed = Seed(s)
        prd, pv, rm, rv = await seed.roadmap("payments")
        grow = await seed.entity("goal", "grow")
        grow.title = "Grow"
        f35 = await seed.entity("feature", "F-35")
        f35.title = "Night alerts"
        await seed.supports(f35, grow)
        if taken:
            f7 = await seed.entity("feature", "F-07")
            f7.title = "Bulk import"
            await seed.supports(f7, grow)
        proposed = await seed.add(Entity(type="feature", key="usage-sync", title="Usage sync",
                                         status="proposed", origin="agent",
                                         attrs={"code": code} if code else {}))  # fmt: skip
        await seed.add(Edge(src_id=proposed.id, dst_id=grow.id, type="supports",
                            status="proposed", origin="agent"))  # fmt: skip
        item = await seed.item(rv, pv, "sync-a", title="Usage sync", feature_id=proposed.id,
                               prd_section_key=section)  # fmt: skip
        s.add(SimplePrdPlan(document_id=prd.id, version_id=pv.id, status="ready", source="prd",
                            data=PLAN))  # fmt: skip
        await s.commit()
        return ctx, str(proposed.id), str(grow.id), str(item.id)


async def _check(client, ctx) -> dict:
    r = await client.get(CHECK, headers=ctx.as_("viewer"))
    assert r.status_code == 200, r.text
    return r.json()


def _of(out: dict, kind: str) -> list[dict]:
    return [f for f in out["flags"] if f["kind"] == kind]


async def _confirm(client, ctx, fid: str) -> dict:
    r = await client.post(f"/v1/baseline/entities/{fid}/confirm", headers=ctx.as_("approver"))
    assert r.status_code == 200, r.text
    return r.json()


async def test_confirm_keys_by_its_own_code(client):
    ctx, fid, _, _ = await world(section=None)
    assert (await _confirm(client, ctx, fid))["key"] == "F-07"
    out = await _check(client, ctx)
    assert not _of(out, "code_differs")
    assert not _of(out, "unlinked_item")


async def test_confirm_keys_by_its_items_code(client):
    ctx, fid, _, _ = await world(code=None, section="f-07a")
    assert (await _confirm(client, ctx, fid))["key"] == "F-07"


async def test_a_taken_code_falls_back_and_is_flagged(client):
    ctx, fid, _, _ = await world(taken=True)
    key = (await _confirm(client, ctx, fid))["key"]
    assert key not in ("F-07", "usage-sync") and key.startswith("F-")
    flags = _of(await _check(client, ctx), "code_differs")
    assert [f["feature"]["id"] for f in flags] == [fid]
    assert [(x["action"], x["target"]) for x in flags[0]["fixes"]] == [("use_code", fid)]


async def test_confirm_confirms_its_proposed_goal_links(client):
    ctx, fid, grow, _ = await world()
    await _confirm(client, ctx, fid)
    out = await _check(client, ctx)
    assert fid not in [f["feature"]["id"] for f in _of(out, "no_goal")]
    async with tenant_session(ctx.tenant_id) as s:
        edge = await s.scalar(select(Edge).where(Edge.src_id == uuid.UUID(fid)))
        assert edge.status == "confirmed" and str(edge.dst_id) == grow


async def test_picking_an_already_proposed_goal_confirms_it(client):
    ctx, fid, grow, _ = await world()
    async with tenant_session(ctx.tenant_id) as s:
        # Confirmed before this fix: the feature, not its link.
        (await s.get(Entity, uuid.UUID(fid))).status = "confirmed"
        await s.commit()
    assert fid in [f["feature"]["id"] for f in _of(await _check(client, ctx), "no_goal")]
    r = await client.post(
        "/v1/baseline/edges",
        headers=ctx.as_("approver"),
        json={
            "src_id": fid,
            "dst_id": grow,
            "type": "supports",
            "origin": "user",
            "attrs": {"contribution": 2},
        },
    )
    assert r.status_code in (200, 201), r.text
    assert r.json()["edge"]["status"] == "confirmed"
    assert fid not in [f["feature"]["id"] for f in _of(await _check(client, ctx), "no_goal")]


async def _mis_keyed(ctx, fid: str) -> None:
    """As confirmed before this fix: keyed F-36 at its confirm, its goal link still proposed."""
    async with tenant_session(ctx.tenant_id) as s:
        f = await s.get(Entity, uuid.UUID(fid))
        f.status, f.key = "confirmed", "F-36"
        s.add(EntityRevision(entity_id=f.id, actor="approver@example.com",
                             before={"key": "usage-sync", "status": "proposed"},
                             after={"key": "F-36", "status": "confirmed"}))  # fmt: skip
        await s.commit()


@pytest.mark.parametrize("code", ["F-07", None])
async def test_the_repair_rekeys_a_mis_keyed_feature(client, code):
    ctx, fid, _, _ = await world(code=code)
    await _mis_keyed(ctx, fid)
    out = await _check(client, ctx)
    flags = _of(out, "code_differs")
    assert [f["feature"] for f in flags] == [{"id": fid, "code": "F-36", "name": "Usage sync"}]
    words = flags[0]["words"]
    assert words.endswith(".") and not re.search(r"[0-9a-f]{8}-|\b[A-Z]{1,3}-\d+|_", words)
    assert [(x["action"], x["target"], x["words"]) for x in flags[0]["fixes"]] == [
        ("use_code", fid, "Use its code")
    ]
    r = await client.post(f"/v1/baseline/entities/{fid}/own-code", headers=ctx.as_("approver"))
    assert r.status_code == 200, r.text
    assert r.json()["code"] == "F-07" and r.json()["status"] == "done"
    out = await _check(client, ctx)
    assert not _of(out, "code_differs")
    assert fid not in [f["feature"]["id"] for f in _of(out, "no_goal")]
    # F-36 was given back: never given again.
    new = await client.post(
        "/v1/baseline/entities",
        headers=ctx.as_("approver"),
        json={"type": "feature", "key": "new-thing", "title": "New thing", "origin": "user"},
    )
    assert new.status_code == 201, new.text
    assert new.json()["entity"]["key"] == "F-37"
    clash = await client.post(
        "/v1/baseline/entities",
        headers=ctx.as_("approver"),
        json={"type": "feature", "key": "F-36", "title": "Other", "origin": "user"},
    )
    assert clash.status_code == 409


async def test_the_repair_is_for_approvers(client):
    ctx, fid, _, _ = await world()
    await _mis_keyed(ctx, fid)
    r = await client.post(f"/v1/baseline/entities/{fid}/own-code", headers=ctx.as_("viewer"))
    assert r.status_code == 403


# --- review fixes: a person's chosen contribution, slices, proposed goals, duplicates --------


async def _link(ctx, fid: str, grow: str) -> Edge:
    async with tenant_session(ctx.tenant_id) as s:
        return await s.scalar(
            select(Edge).where(Edge.src_id == uuid.UUID(fid), Edge.dst_id == uuid.UUID(grow))
        )


async def test_picking_a_proposed_link_keeps_the_chosen_contribution(client):
    ctx, fid, grow, _ = await world()
    r = await client.post(
        "/v1/baseline/edges",
        headers=ctx.as_("approver"),
        json={"src_id": fid, "dst_id": grow, "type": "supports", "origin": "user",
              "attrs": {"contribution": 3}},
    )  # fmt: skip
    assert r.status_code in (200, 201), r.text
    assert r.json()["edge"]["status"] == "confirmed"
    assert r.json()["edge"]["attrs"]["contribution"] == 3
    assert (await _link(ctx, fid, grow)).attrs["contribution"] == 3


@pytest.mark.parametrize(
    ("origin", "status"), [("agent", "proposed"), ("agent", None), ("user", "proposed")]
)
async def test_only_a_person_confirming_confirms_a_proposed_link(client, origin, status):
    ctx, fid, grow, _ = await world()
    body = {"src_id": fid, "dst_id": grow, "type": "supports", "origin": origin,
            "attrs": {"contribution": 3}}  # fmt: skip
    if status:
        body["status"] = status
    r = await client.post("/v1/baseline/edges", headers=ctx.as_("approver"), json=body)
    assert r.status_code == 409, r.text
    edge = await _link(ctx, fid, grow)
    assert edge.status == "proposed" and "contribution" not in (edge.attrs or {})


async def test_confirm_leaves_links_to_a_proposed_goal_proposed(client):
    ctx, fid, _, _ = await world()
    async with tenant_session(ctx.tenant_id) as s:
        idea = await s.scalar(select(Entity).where(Entity.key == "grow"))
        idea.status = "proposed"
        await s.commit()
        grow = str(idea.id)
    await _confirm(client, ctx, fid)
    assert (await _link(ctx, fid, grow)).status == "proposed"


async def test_use_its_code_leaves_a_slice_its_letter(client):
    """A slice F-35a of F-35 whose Code attribute reads F-07 is not flagged, nor re-keyed."""
    ctx, _, _, _ = await world(section=None)
    async with tenant_session(ctx.tenant_id) as s:
        f35 = await s.scalar(select(Entity).where(Entity.key == "F-35"))
        part = Entity(type="feature", key="F-35a", title="Night alerts by email",
                      status="confirmed", origin="agent", parent_id=f35.id,
                      attrs={"code": "F-07"})  # fmt: skip
        s.add(part)
        await s.flush()
        s.add(EntityRevision(entity_id=part.id, actor="approver@example.com",
                             before={"key": "night-email", "status": "proposed"},
                             after={"key": "F-35a", "status": "confirmed"}))  # fmt: skip
        await s.commit()
        sid = str(part.id)
    assert sid not in [f["feature"]["id"] for f in _of(await _check(client, ctx), "code_differs")]
    r = await client.post(f"/v1/baseline/entities/{sid}/own-code", headers=ctx.as_("approver"))
    assert r.status_code == 409, r.text
    async with tenant_session(ctx.tenant_id) as s:
        assert (await s.get(Entity, uuid.UUID(sid))).key == "F-35a"


async def test_a_duplicate_holding_the_code_offers_link_to_a_feature(client):
    """Its item's code F-07 is Bulk import's: Link to a feature on its item, not Use its code."""
    ctx, fid, _, item = await world(code=None, taken=True)
    await _confirm(client, ctx, fid)
    flags = _of(await _check(client, ctx), "code_differs")
    assert [f["feature"]["id"] for f in flags] == [fid]
    assert [(x["action"], x["target"]) for x in flags[0]["fixes"]] == [("link_to_feature", item)]
    assert flags[0]["item"]["id"] == item and flags[0]["item"]["name"] == "Usage sync"
