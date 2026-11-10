"""drafts-read-budget: writing a change into a roadmap's working draft
(``oracle.simple.drafts.write_items``, what every applied or undone change in Simple runs)
reads the same number of SQL statements however many items the change moves. Against
Postgres; invented example data only (an "Example Checkout" roadmap and its items).

Test cards (protects / fails_when / no_claim):

- test_write_items_reads_do_not_grow_with_items: protects=a change that moves 3 or 12
  items of one roadmap (a first write that opens the draft, a second into the open draft
  with a folded item's draft copy, and an undo) costs the same statements, and the
  folded item's copy still takes the change; fails_when=the draft, its session link or
  an item's draft copy is read once per item (a statement per item);
  no_claim=the REST route's own reads (flags, audit) or other roadmaps' drafts.
"""

import uuid
from datetime import date

from oracle.roadmap.models import RoadmapItem
from oracle.simple import changes, drafts
from oracle.simple.models import SimpleChange, SimpleDraft, SimpleSession
from oracle.tenancy import tenant_session
from tests.baseline_helpers import make_ctx
from tests.coverage_helpers import count_statements
from tests.test_simple_roadmap_api import NOW, Seed

AFTER = {"start_date": "2026-11-16", "end_date": "2026-12-21"}
BEFORE = {"start_date": "2026-11-10", "end_date": "2026-12-15"}


async def _budget(tenant_id: uuid.UUID, session_id: uuid.UUID, slug: str, n: int) -> list[int]:
    """Statements of a first write, a second write and an undo of a change moving ``n``
    items of a new roadmap ``slug``."""
    async with tenant_session(tenant_id) as s:
        seed = Seed(s)
        _, pv, rm, rv = await seed.roadmap(slug)
        items = [
            await seed.item(
                rv,
                pv,
                f"{slug}-{i}",
                position=i,
                start_date=date(2026, 11, 10),
                end_date=date(2026, 12, 15),
                date_source="typed",
            )  # fmt: skip
            for i in range(n)
        ]
        await s.commit()
        ids = [str(r.id) for r in items]
        session = await s.get(SimpleSession, session_id)
        c = SimpleChange(op="shift_dependents", target={"item_id": ids[0]})
        counts: list[int] = []

        with count_statements() as seen:
            written = await drafts.write_items(
                s, c, {k: AFTER for k in ids}, session, changes.KEYED, changes.write
            )
        counts.append(len(seen))
        await s.commit()
        (draft_id,) = written
        # A folded item: its draft copy (same roadmap, PRD and key, no version) in the draft.
        first = items[0]
        copy = RoadmapItem(roadmap_document_id=rm.id, roadmap_version_id=None,
                           simple_draft_id=draft_id, item_key=first.item_key,
                           prd_document_id=first.prd_document_id,
                           prd_version_id=first.prd_version_id, title=first.title,
                           horizon="now", position=0)  # fmt: skip
        s.add(copy)
        await s.commit()

        with count_statements() as seen:
            await drafts.write_items(
                s, c, {k: AFTER for k in ids}, session, changes.KEYED, changes.write
            )
        counts.append(len(seen))
        await s.commit()
        d = await s.get(SimpleDraft, draft_id)
        await s.refresh(d)
        assert set(d.overlay) == {*ids, str(copy.id)}
        assert d.overlay[str(copy.id)]["start_date"] == AFTER["start_date"]

        c.draft_ids = [draft_id]
        with count_statements() as seen:
            await drafts.write_items(
                s, c, {k: BEFORE for k in ids}, session, changes.KEYED, changes.write, undo=True
            )
        counts.append(len(seen))
        await s.commit()
        await s.refresh(d)
        assert all(d.overlay[k]["start_date"] == BEFORE["start_date"] for k in ids)
    return counts


async def test_write_items_reads_do_not_grow_with_items():
    ctx = await make_ctx("Example Co")
    async with tenant_session(ctx.tenant_id) as s:
        session = SimpleSession(kind="editing", started_by=ctx.users["owner"].id, started_at=NOW)
        s.add(session)
        await s.commit()
        session_id = session.id
    few = await _budget(ctx.tenant_id, session_id, "example-checkout", 3)
    many = await _budget(ctx.tenant_id, session_id, "example-billing", 12)
    assert many == few, (few, many)
