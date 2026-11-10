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
        rv = await s.scalar(
            select(DocumentVersion).join(Document).where(Document.kind == "roadmap")
        )
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


async def test_a_prd_made_after_a_reorder_lands_at_the_end(client):
    """protects=a new PRD (no stored place) after every PRD an owner placed; fails_when=it
    takes its title's or goal's place among them."""
    ctx = await make_ctx()
    await seed(ctx)
    r = await client.post("/v1/documents/cherry/move", json={"to": "up"},
                          headers=ctx.as_("owner"))  # fmt: skip
    assert r.status_code == 200, r.text
    async with tenant_session(ctx.tenant_id) as s:
        await Seed(s).doc("aardvark")
        await s.commit()
    assert await _order(client, ctx) == ["banana", "cherry", "apple", "aardvark"]


async def test_key_date_prds_follow_the_prd_order():
    """protects=Key dates' PRDs under each roadmap (key_date_prds) in the company PRD order;
    fails_when=by title."""
    from types import SimpleNamespace

    from oracle.simple.key_dates import key_date_prds

    ctx = await make_ctx()
    prds = await seed(ctx)
    async with tenant_session(ctx.tenant_id) as s:
        docs = {d.id: d for d in await s.scalars(select(Document))}
        rm = next(d for d in docs.values() if d.kind == "roadmap")
        named = ("apple", "cherry", "banana")
        entries = [SimpleNamespace(roadmap=rm, prd=docs[prds[k].id]) for k in named]
        got = await key_date_prds(s, None, docs, entries)
        assert [d.slug for d in got[rm.id]] == ["banana", "apple", "cherry"]


async def test_key_date_prds_read_the_order_once_for_all_roadmaps():
    """protects=key_date_prds computing the company PRD order once (not per roadmap, each run
    re-reading the goals and items: the default Roadmap read slowed ~40%); fails_when=the
    statements it runs grow with the number of roadmaps; no_claim=wall time."""
    from types import SimpleNamespace

    from sqlalchemy import event

    from oracle.db import get_engine
    from oracle.simple.key_dates import key_date_prds

    ctx = await make_ctx()
    prds = await seed(ctx)
    async with tenant_session(ctx.tenant_id) as s:
        extra = [await Seed(s).doc(f"roadmap-{n}", "roadmap") for n in range(3)]
        await s.commit()
        docs = {d.id: d for d in await s.scalars(select(Document))}
        rms = [d for d in docs.values() if d.kind == "roadmap"]
        assert len(rms) == 1 + len(extra)
        statements: list[str] = []

        def count(conn, cursor, statement, *args):
            statements.append(statement)

        async def reads(roadmaps) -> int:
            entries = [SimpleNamespace(roadmap=r, prd=docs[prds[k].id]) for r in roadmaps
                       for k in ("apple", "cherry", "banana")]  # fmt: skip
            statements.clear()
            # Each run reads the goals itself (they are read once per session until it writes).
            s.sync_session.info.pop("simple_goals", None)
            engine = get_engine().sync_engine
            event.listen(engine, "before_cursor_execute", count)
            try:
                got = await key_date_prds(s, None, docs, entries)
            finally:
                event.remove(engine, "before_cursor_execute", count)
            slugs = [[d.slug for d in got[r.id]] for r in roadmaps]
            assert slugs == [["banana", "apple", "cherry"]] * len(roadmaps)
            return len(statements)

        one = await reads(rms[:1])
        assert await reads(rms) == one


async def test_the_drafts_from_prds_follow_the_prd_order():
    """protects=a roadmap draft's from_prds (prd_roadmap.sources_out) in the company PRD
    order; fails_when=by title."""
    from types import SimpleNamespace

    from oracle.simple import prd_roadmap

    ctx = await make_ctx()
    prds = await seed(ctx)
    async with tenant_session(ctx.tenant_id) as s:
        rm = await s.scalar(select(Document).where(Document.kind == "roadmap"))
        named = ("apple", "cherry", "banana")
        sources = {str(prds[k].id): {"version": 1, "items": []} for k in named}
        d = SimpleNamespace(id=uuid.uuid4(), document_id=rm.id, overlay={prd_roadmap.KEY: sources})
        got = await prd_roadmap.sources_out(s, d)  # type: ignore[arg-type]
        assert [p.prd.slug for p in got] == ["banana", "apple", "cherry"]


async def test_inbox_staged_rows_follow_the_prd_order():
    """protects=the Inbox's staged-changes rows (inbox.staged_rows) in the company PRD order;
    fails_when=by title."""
    from oracle.review.inbox import staged_rows
    from oracle.staging.models import NextDraftChange

    ctx = await make_ctx()
    prds = await seed(ctx)
    async with tenant_session(ctx.tenant_id) as s:
        for k in ("apple", "cherry", "banana"):
            s.add(NextDraftChange(document_id=prds[k].id, section_key="gone",
                                  raised_on_version=1, instruction="Say who it is for.",
                                  staged_by=uuid.uuid4()))  # fmt: skip
        await s.commit()
        assert [r.slug for r in await staged_rows(s)] == ["banana", "apple", "cherry"]


async def test_one_roadmap_read_ranks_the_prds_once(client):
    """protects=GET /v1/simple/roadmap computing the company PRD order once per request (it
    is one pass over the goals and the roadmap items, and the Key dates and the Goal
    milestones both need it); fails_when=a second part of the read ranks them again;
    no_claim=wall time."""
    from sqlalchemy import event

    from oracle.db import get_engine

    ctx = await make_ctx()
    await seed(ctx)
    ranking: list[str] = []

    def count(conn, cursor, statement, *args):
        # main_goals' read of the items: only the PRD order selects these three columns.
        if "roadmap_items.prd_document_id, roadmap_items.goal_ids, roadmap_items.feature_id" in (
            statement
        ):
            ranking.append(statement)

    engine = get_engine().sync_engine
    event.listen(engine, "before_cursor_execute", count)
    try:
        r = await client.get("/v1/simple/roadmap", headers=ctx.as_("owner"))
    finally:
        event.remove(engine, "before_cursor_execute", count)
    assert r.status_code == 200, r.text
    assert len(ranking) == 1, f"the PRD order was ranked {len(ranking)} times in one read"
