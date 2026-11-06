"""prd-order (the owner, Nov 5: "the PRDs should be in a different order"): one company PRD
order every page lists PRDs in. A PRD's stored position first (an owner's Move up / Move
down); then, without one, the goal order of the goal it mainly serves; then its title.
Owners move PRDs; approvers and below read the order. Against Postgres.

Each test's card: protects=<the observable>; fails_when=<the wrong result it rejects>;
no_claim=<what green does not prove>.
"""

import uuid

from sqlalchemy import select

from oracle.docs.models import Document, DocumentVersion
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


async def test_undo_puts_back_the_earlier_places(client):
    """protects=PUT /v1/documents/prd-order (the One-pagers' Undo after a move); fails_when=
    an approver may set the order, a PRD that had no place keeps the one the move gave it, or
    a roadmap's place is set; no_claim=the toast (e2e prd-order)."""
    ctx = await make_ctx()
    prds = await seed(ctx)
    r = await client.post("/v1/documents/cherry/move", json={"to": "up"},
                          headers=ctx.as_("owner"))  # fmt: skip
    assert [d["slug"] for d in r.json()] == ["banana", "cherry", "apple"]
    earlier = [{"document_id": str(d.id), "position": None} for d in prds.values()]
    r = await client.put("/v1/documents/prd-order", json={"positions": earlier},
                         headers=ctx.as_("approver"))  # fmt: skip
    assert r.status_code == 403
    r = await client.put("/v1/documents/prd-order", json={"positions": earlier},
                         headers=ctx.as_("owner"))  # fmt: skip
    assert r.status_code == 200, r.text
    assert [(d["slug"], d["position"]) for d in r.json()] == [
        ("banana", None), ("apple", None), ("cherry", None)
    ]  # fmt: skip
    assert await _order(client, ctx) == ["banana", "apple", "cherry"]
    async with tenant_session(ctx.tenant_id) as s:
        roadmap = await s.scalar(select(Document).where(Document.kind == "roadmap"))
    r = await client.put("/v1/documents/prd-order",
                         json={"positions": [{"document_id": str(roadmap.id), "position": 1}]},
                         headers=ctx.as_("owner"))  # fmt: skip
    assert r.status_code == 404


async def test_two_owners_moving_at_once_keep_one_order(client):
    """protects=a move locks the company's PRDs; fails_when=two moves at once write the same
    places (two PRDs share a position); no_claim=which move lands last."""
    import asyncio

    ctx = await make_ctx()
    await seed(ctx)
    a, b = await asyncio.gather(
        client.post("/v1/documents/cherry/move", json={"to": "up"}, headers=ctx.as_("owner")),
        client.post("/v1/documents/banana/move", json={"to": "down"}, headers=ctx.as_("owner")),
    )
    assert a.status_code == 200 and b.status_code == 200, (a.text, b.text)
    r = await client.get("/v1/documents", params={"kind": "prd"}, headers=ctx.as_("owner"))
    assert sorted(d["position"] for d in r.json()) == [1, 2, 3]


async def test_the_full_list_reads_no_order(client):
    """protects=GET /v1/documents without a kind computes no PRD order (it is not sorted by
    it) and a single document carries none; fails_when=``order`` is set there."""
    ctx = await make_ctx()
    await seed(ctx)
    r = await client.get("/v1/documents", headers=ctx.as_("owner"))
    assert {d["order"] for d in r.json()} == {None}
    r = await client.get("/v1/documents/apple", headers=ctx.as_("owner"))
    assert r.json()["order"] is None


async def test_roadmap_prd_lanes_follow_the_prd_order(client):
    """protects=Simple › Roadmap's Group by PRD lanes in the company PRD order, No PRD last;
    fails_when=lanes by title; no_claim=the web's lanes (they keep the API's order)."""
    ctx = await make_ctx()
    prds = await seed(ctx)
    async with tenant_session(ctx.tenant_id) as s:
        seed_ = Seed(s)
        rv = await s.scalar(select(DocumentVersion).join(Document).where(Document.kind == "roadmap"))
        await seed_.item(rv, None, "loose", position=99)
        await s.commit()
    r = await client.get("/v1/simple/roadmap", params={"group": "prd"}, headers=ctx.as_("owner"))
    assert r.status_code == 200, r.text
    assert [g["title"] for g in r.json()["groups"]] == ["Banana", "Apple", "No PRD"]
    r = await client.post("/v1/documents/apple/move", json={"to": "up"},
                          headers=ctx.as_("owner"))  # fmt: skip
    r = await client.get("/v1/simple/roadmap", params={"group": "prd"}, headers=ctx.as_("owner"))
    assert [g["title"] for g in r.json()["groups"]] == ["Apple", "Banana", "No PRD"]
    assert prds


async def test_decisions_filter_and_start_picker_follow_the_prd_order(client):
    """protects=Simple › Decisions' PRD filter and the Start-a-review PRD picker in the company
    PRD order; fails_when=either lists PRDs by title."""
    ctx = await make_ctx()
    await seed(ctx)
    r = await client.get("/v1/simple/decisions", headers=ctx.as_("owner"))
    assert r.status_code == 200, r.text
    assert [p["id"] for p in r.json()["prds"]] == ["banana", "apple", "cherry"]
    r = await client.get("/v1/simple/meetings/options", headers=ctx.as_("owner"))
    assert r.status_code == 200, r.text
    assert [p["document"]["slug"] for p in r.json()["prds"]] == ["banana", "apple", "cherry"]


class _Ctx:
    """The parts of a discussions Context the PRD readers write to."""

    def __init__(self) -> None:
        self.lines: list[str] = []
        self.size = 0

    def note(self, text: str) -> None:
        self.lines.append(text)

    def add(self, kind: str, ref: str, title: str, text: str, **extra) -> int:
        self.lines.append(f"{kind}: {title}")
        return 1


async def test_ask_oracle_reads_prds_in_the_prd_order():
    """protects=Ask Oracle's context (the plan's PRDs and the documents list) in the company
    PRD order; fails_when=either reads PRDs by title."""
    from oracle.discussions import context, plan

    ctx = await make_ctx()
    await seed(ctx)
    async with tenant_session(ctx.tenant_id) as s:
        got = _Ctx()
        await plan._prds(s, got, 0)
        assert [x for x in got.lines if x.startswith("PRD:")] == [
            "PRD: Banana (approved version 1)", "PRD: Apple (approved version 1)",
            "PRD: Cherry (approved version 1)",
        ]  # fmt: skip
        got = _Ctx()
        await context._documents(s, got)  # type: ignore[arg-type]
        assert got.lines == ["document: Banana", "document: Apple", "document: Cherry",
                             "document: Company Roadmap"]  # fmt: skip
