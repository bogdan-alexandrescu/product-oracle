"""prd-order (the owner, Nov 5: "the PRDs should be in a different order"): one company PRD
order every page lists PRDs in. A PRD's stored position first (an owner's Move up / Move
down); then, without one, the goal order of the goal it mainly serves; then its title.
Owners move PRDs; approvers and below read the order. Against Postgres.

Each test's card: protects=<the observable>; fails_when=<the wrong result it rejects>;
no_claim=<what green does not prove>.
"""

import uuid

from sqlalchemy import select

from oracle.docs.models import Document
from oracle.docs.prd_order import sort_key
from oracle.models import AuditEvent
from oracle.tenancy import tenant_session
from tests.baseline_helpers import make_ctx
from tests.test_simple_roadmap_api import Seed


def _doc(title: str, position: int | None = None) -> Document:
    return Document(id=uuid.uuid4(), slug=title.lower(), title=title, kind="prd",
                    position=position)  # fmt: skip


def test_the_rule_in_one_place():
    """protects=sort_key; fails_when=title or date order wins over a position or the main
    goal; no_claim=the routes (below)."""
    a, b, c, d = _doc("Alpha"), _doc("Bravo", 2), _doc("Charlie"), _doc("Delta", 1)
    goal = {a.id: 1, c.id: 0}
    got = sorted([a, b, c, d], key=lambda x: sort_key(x, goal))
    assert [x.title for x in got] == ["Delta", "Bravo", "Charlie", "Alpha"]
    e = _doc("echo")
    assert sorted([e, _doc("Foxtrot")], key=lambda x: sort_key(x, {}))[0] is e


async def seed(ctx) -> dict[str, Document]:
    """Goals Scale (first) and Growth; PRDs Apple (serves Growth), Banana (serves Scale) and
    Cherry (serves none)."""
    async with tenant_session(ctx.tenant_id) as s:
        seed = Seed(s)
        scale = await seed.entity("goal", "scale", position=1)
        growth = await seed.entity("goal", "growth", position=2)
        rm = await seed.doc("company-roadmap", "roadmap")
        rv = await seed.version(rm)
        prds = {}
        for n, (slug, goals) in enumerate([("apple", [growth.id, growth.id]),
                                           ("banana", [scale.id]), ("cherry", [])]):  # fmt: skip
            prd = await seed.doc(slug)
            pv = await seed.version(prd)
            for i, g in enumerate(goals):
                await seed.item(rv, pv, f"{slug}-{i}", position=n * 10 + i, goal_ids=[g])
            prds[slug] = prd
        await s.commit()
        return prds


async def _order(client, ctx, role="viewer") -> list[str]:
    r = await client.get("/v1/documents", params={"kind": "prd"}, headers=ctx.as_(role))
    assert r.status_code == 200, r.text
    assert [d["order"] for d in r.json()] == list(range(1, len(r.json()) + 1))
    return [d["slug"] for d in r.json()]


async def test_default_order_follows_the_main_goal_then_title(client):
    """protects=GET /v1/documents?kind=prd without positions; fails_when=newest first or
    alphabetical; no_claim=moving (below)."""
    ctx = await make_ctx()
    await seed(ctx)
    assert await _order(client, ctx) == ["banana", "apple", "cherry"]


async def test_an_owner_moves_a_prd_and_everyone_reads_it(client):
    """protects=POST /v1/documents/{doc}/move; fails_when=an approver may move, the order is
    not stored, the move bumps "Updated", or a move past the end changes anything;
    no_claim=the web (e2e prd-order)."""
    ctx = await make_ctx()
    await seed(ctx)
    r = await client.get("/v1/documents", params={"kind": "prd"}, headers=ctx.as_("owner"))
    updated = {d["slug"]: d["updated_at"] for d in r.json()}
    r = await client.post("/v1/documents/cherry/move", json={"to": "up"},
                          headers=ctx.as_("approver"))  # fmt: skip
    assert r.status_code == 403
    r = await client.post("/v1/documents/cherry/move", json={"to": "up"},
                          headers=ctx.as_("owner"))  # fmt: skip
    assert r.status_code == 200, r.text
    assert [d["slug"] for d in r.json()] == ["banana", "cherry", "apple"]
    assert [d["position"] for d in r.json()] == [1, 2, 3]
    for role in ("approver", "commenter", "viewer"):
        assert await _order(client, ctx, role) == ["banana", "cherry", "apple"]
    r = await client.post("/v1/documents/banana/move", json={"to": "up"},
                          headers=ctx.as_("owner"))  # fmt: skip
    assert [d["slug"] for d in r.json()] == ["banana", "cherry", "apple"]
    r = await client.post("/v1/documents/banana/move", json={"to": "down"},
                          headers=ctx.as_("owner"))  # fmt: skip
    assert [d["slug"] for d in r.json()] == ["cherry", "banana", "apple"]
    assert {d["slug"]: d["updated_at"] for d in r.json()} == updated
    async with tenant_session(ctx.tenant_id) as s:
        moves = list(
            await s.scalars(select(AuditEvent).where(AuditEvent.action == "document.move"))
        )
        assert len(moves) == 2
    r = await client.post("/v1/documents/company-roadmap/move", json={"to": "up"},
                          headers=ctx.as_("owner"))  # fmt: skip
    assert r.status_code == 404
    r = await client.post("/v1/documents/apple/move", json={"to": "left"},
                          headers=ctx.as_("owner"))  # fmt: skip
    assert r.status_code == 422
