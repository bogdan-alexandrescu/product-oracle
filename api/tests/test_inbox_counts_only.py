"""inbox-counts: GET /v1/inbox/counts is a count-only read. It counts the rows the Inbox's
total counts without building the rows shown only (a Simple proposal's item, author and
meeting, the decisions on my proposals, the settled feedback), and reads the roadmap once:
the light read that routes each proposal, never the drafts pass (oracle.simple.changes
inbox_rows). Its numbers stay exactly the Inbox's.

Before: the owner's counts on the seed (tests/inbox_seed.py) took 112 statements, the
roadmap read twice (once plain, once with my drafts). After: 79.

Against Postgres, with invented example data only.

Test cards (protects / fails_when / no_claim):

- test_counts_match_the_inbox: protects=the counts equal those derived from GET /v1/inbox
  (its total, and the part the Simple Roadmap tab counts too) for the owner, a viewer and a
  person with a draft of their own; fails_when=any number differs.
- test_counts_read_little: protects=the owner's counts on the seed stay at or under
  MAX_STATEMENTS; fails_when=the counts build rows they do not count or read the roadmap
  again.
"""

from sqlalchemy import select

from oracle.roadmap.models import RoadmapItem
from oracle.simple.models import SimpleDraft
from oracle.tenancy import tenant_session
from tests.baseline_helpers import make_ctx
from tests.inbox_seed import seed_company
from tests.test_inbox_reads import _roadmap_part, statements

# The owner's counts on the seed, the sign-in's statements included (before inbox-counts: 112).
MAX_STATEMENTS = 79


async def _draft_of_mine(ctx) -> None:
    """The approver's working draft renames one of its roadmap's items."""
    approver = ctx.users["approver"].id
    async with tenant_session(ctx.tenant_id) as s:
        draft = await s.scalar(
            select(SimpleDraft).where(
                SimpleDraft.created_by == approver, SimpleDraft.status == "working"
            )
        )
        item = await s.scalar(
            select(RoadmapItem).where(RoadmapItem.roadmap_document_id == draft.document_id)
        )
        draft.overlay = {str(item.id): {"title": "Example renamed item"}}
        await s.commit()


async def test_counts_match_the_inbox(client):
    ctx = await make_ctx()
    await seed_company(ctx)
    await _draft_of_mine(ctx)
    for who in ("owner", "viewer", "approver"):
        _, inbox = await statements(client, "GET", "/v1/inbox", ctx.as_(who))
        _, counts = await statements(client, "GET", "/v1/inbox/counts", ctx.as_(who))
        assert counts == {"total": inbox["total"], "roadmap": _roadmap_part(inbox)}, who
        if who != "viewer":
            # The proposals and drafts wait on them: the numbers are not empty.
            assert 0 < counts["roadmap"] <= counts["total"], (who, counts)


async def test_counts_read_little(client):
    ctx = await make_ctx()
    await seed_company(ctx)
    await statements(client, "GET", "/v1/inbox/counts", ctx.as_("owner"))
    count, _ = await statements(client, "GET", "/v1/inbox/counts", ctx.as_("owner"))
    print(f"owner counts: {count} statements")
    assert count <= MAX_STATEMENTS, count
