"""simple-speed: what every ORM SELECT pays before its own work: the company scope
(oracle.tenancy) and the Trash filter (oracle.trash.filter). Against Postgres.

Test cards (protects / fails_when / no_claim):

- test_a_select_carries_three_scope_options: protects=an owner's SELECT carries the
  company's two scope options and one Trash option, not one per trashable class (about
  sixty, each coerced and read into the statement's cache key on every query);
  fails_when=the options are added one by one again; no_claim=a commenter's or viewer's
  document visibility options (oracle.docs.visibility, added as before).
- test_one_trash_option_reads_as_one_per_class: protects=for every trashable class, a join
  through an alias and a relationship load, the SQL sent with the one Trash option is
  exactly the SQL sent with one option per class; fails_when=a class's clause is dropped,
  reordered or changed; no_claim=which classes are trashable (tests/test_trash.py).
- test_trashed_rows_stay_out_through_the_one_option: protects=a document in Trash and its
  versions are absent from a plain read, a join and a get, and present with
  INCLUDE_TRASHED; fails_when=the one option leaves a path unfiltered; no_claim=every
  model (tests/test_trash.py walks them).
- test_scope_options_are_built_once_per_company: protects=two statements of one company
  share the same scope options and another company gets its own; fails_when=they are built
  on every statement again, or shared between companies; no_claim=other processes.
- test_companies_read_their_own_rows_in_turn: protects=two companies reading in turn
  (A, B, A, with the kept options and the shared statement cache) each get their own
  members only, and an UPDATE touches only its company's rows; fails_when=a kept option
  carries another company's id; no_claim=unscoped sessions.
"""

import hashlib

from sqlalchemy import event, select, update
from sqlalchemy.orm import aliased

from oracle import tenancy
from oracle.auth.models import User
from oracle.db import get_engine
from oracle.docs.models import Document, DocumentVersion
from oracle.roadmap.models import ProductTrack, RoadmapItem
from oracle.tenancy import TenantSession, tenant_session
from oracle.trash import filter as trash_filter
from tests.baseline_helpers import make_ctx


class Sql:
    def __init__(self) -> None:
        self.seen: list[str] = []

    def __call__(self, conn, cursor, statement, *args) -> None:
        if "SAVEPOINT" not in statement:
            self.seen.append(statement)

    def __enter__(self) -> "Sql":
        event.listen(get_engine().sync_engine, "before_cursor_execute", self)
        return self

    def __exit__(self, *exc) -> None:
        event.remove(get_engine().sync_engine, "before_cursor_execute", self)


class Options:
    """The options each ORM statement carries once every scope hook has run."""

    def __init__(self) -> None:
        self.seen: list[tuple] = []

    def __call__(self, state) -> None:
        self.seen.append(tuple(state.statement._with_options))

    def __enter__(self) -> "Options":
        event.listen(TenantSession, "do_orm_execute", self)
        return self

    def __exit__(self, *exc) -> None:
        event.remove(TenantSession, "do_orm_execute", self)


async def _document(ctx, slug: str) -> Document:
    async with tenant_session(ctx.tenant_id) as s:
        doc = Document(slug=slug, title=f"Example {slug}", kind="prd", status="approved")
        s.add(doc)
        await s.flush()
        body = f"# {slug}\n"
        s.add(
            DocumentVersion(
                document_id=doc.id,
                number=1,
                markdown=body,
                content_hash=hashlib.sha256(body.encode()).hexdigest(),
            )
        )
        await s.commit()
        return doc


async def test_a_select_carries_three_scope_options():
    """A SELECT carries the company's scope and one Trash option, not sixty."""
    ctx = await make_ctx()
    with Options() as options:
        async with tenant_session(ctx.tenant_id) as s:
            assert len(list(await s.scalars(select(User)))) == 4
    assert [len(o) for o in options.seen] == [3], options.seen


async def _reads(ctx) -> list[str]:
    """The SQL of a read of every trashable class, a join through an alias and a
    relationship load."""
    other = aliased(Document)
    with Sql() as sql:
        async with tenant_session(ctx.tenant_id) as s:
            for entity in trash_filter.criteria():
                await s.execute(select(entity).limit(1))
            await s.execute(
                select(RoadmapItem, other)
                .join(other, other.id == RoadmapItem.prd_document_id)
                .limit(1)
            )
            # ProductTrack.prd_links loads with a SELECT of its own (selectin).
            await s.scalars(select(ProductTrack))
            await s.get(Document, ctx.tenant_id)
    return sql.seen


async def test_one_trash_option_reads_as_one_per_class(monkeypatch):
    """The one Trash option sends the same SQL as one option per trashable class."""
    ctx = await make_ctx()
    async with tenant_session(ctx.tenant_id) as s:
        s.add(ProductTrack(title="Example track"))
        await s.commit()
    assert isinstance(trash_filter._options()[0], trash_filter.LiveRows)
    as_one = await _reads(ctx)
    monkeypatch.setattr(trash_filter, "_OPTIONS", trash_filter.each_option())
    one_by_one = await _reads(ctx)
    assert len(as_one) >= len(trash_filter.criteria()) + 3
    assert as_one == one_by_one


async def test_trashed_rows_stay_out_through_the_one_option():
    """A document in Trash is absent from reads, joins and gets, as before."""
    from datetime import UTC, datetime

    ctx = await make_ctx()
    kept = await _document(ctx, "kept-prd")
    gone = await _document(ctx, "gone-prd")
    async with tenant_session(ctx.tenant_id) as s:
        row = await s.get(Document, gone.id)
        row.deleted_at = datetime.now(UTC)
        await s.commit()
    async with tenant_session(ctx.tenant_id) as s:
        assert [d.slug for d in await s.scalars(select(Document))] == ["kept-prd"]
        assert await s.get(Document, gone.id) is None
        versions = await s.scalars(select(DocumentVersion))
        assert [v.document_id for v in versions] == [kept.id]
        joined = await s.execute(
            select(DocumentVersion.number, Document.slug).join(
                Document, Document.id == DocumentVersion.document_id
            )
        )
        assert [tuple(r) for r in joined] == [(1, "kept-prd")]
        everything = await s.scalars(
            select(Document).execution_options(**{trash_filter.INCLUDE_TRASHED: True})
        )
        assert sorted(d.slug for d in everything) == ["gone-prd", "kept-prd"]


async def test_scope_options_are_built_once_per_company():
    """A company's scope options are built once, and never shared with another."""
    a, b = await make_ctx("Example A"), await make_ctx("Example B")
    with Options() as options:
        for ctx in (a, a, b):
            async with tenant_session(ctx.tenant_id) as s:
                await s.scalars(select(User))
    first, second, other = (o[:2] for o in options.seen)
    assert all(x is y for x, y in zip(first, second, strict=True))
    assert not any(x is y for x, y in zip(first, other, strict=True))
    assert tenancy._tenant_options(a.tenant_id) == first


async def test_companies_read_their_own_rows_in_turn():
    """Two companies reading in turn each get only their own rows."""
    a, b = await make_ctx("Example A"), await make_ctx("Example B")
    async with tenant_session(b.tenant_id) as s:
        s.add(User(email="extra@example.com", password_hash="x", role="viewer"))
        await s.commit()
    for ctx, count in ((a, 4), (b, 5), (a, 4), (b, 5)):
        async with tenant_session(ctx.tenant_id) as s:
            users = list(await s.scalars(select(User)))
            assert len(users) == count
            assert {u.tenant_id for u in users} == {ctx.tenant_id}
    async with tenant_session(a.tenant_id) as s:
        await s.execute(update(User).values(name="Renamed"))
        await s.commit()
    async with tenant_session(b.tenant_id) as s:
        assert {u.name for u in await s.scalars(select(User))} == {None}
    async with tenant_session(a.tenant_id) as s:
        assert {u.name for u in await s.scalars(select(User))} == {"Renamed"}
