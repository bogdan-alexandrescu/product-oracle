"""The roadmap a goal's suggestions are filed under, and whose decider decides them
(oracle.simple.additions._job_document), is the same on every read. With no company roadmap
and the goal's items on several roadmaps it is the first-created of them, never whichever
roadmap the read happened to list first: items on different roadmaps share positions, so
their order in the read is the database's to pick. Against Postgres, with invented example
data only (tests/waiting_seed.py).

Test cards (protects / fails_when / no_claim):

- test_a_goals_roadmap_does_not_follow_the_reads_order: protects=on a company whose 5
  roadmaps all hold items of all 4 goals, each goal's roadmap is the first-created one
  holding its items, whether the read lists its entries in the order loaded or reversed;
  fails_when=the roadmap is the first entry the read happens to list (the approver's waiting
  list then dropped every goal suggestion on some reads, tests/test_simple_waiting_speed.py);
  no_claim=a company roadmap (it wins outright, tests/test_one_roadmap_many_prds_api.py).
"""

from datetime import UTC, datetime

import pytest
from sqlalchemy import select, update

from oracle import company_time
from oracle.baseline.models import Entity
from oracle.docs.models import Document
from oracle.simple import additions, service
from oracle.tenancy import tenant_session
from tests.baseline_helpers import make_ctx
from tests.test_simple_roadmap_api import NOW
from tests.waiting_seed import big_company


@pytest.fixture(autouse=True)
def clock(monkeypatch):
    monkeypatch.setattr(company_time, "now", lambda: NOW)


async def test_a_goals_roadmap_does_not_follow_the_reads_order():
    """A goal's suggestions go to its first-created roadmap, whatever order the read lists."""
    ctx = await make_ctx()
    await big_company(ctx)
    async with tenant_session(ctx.tenant_id) as s:
        # Roadmap 4 (the one no approver decides) is the oldest; the seed made the rest at once.
        await s.execute(
            update(Document)
            .where(Document.slug == "roadmap-4")
            .values(created_at=datetime(2026, 1, 5, tzinfo=UTC))
        )
        await s.commit()
        goals = list(
            await s.scalars(
                select(Entity).where(Entity.type == "goal", Entity.status == "confirmed")
            )
        )
        assert len(goals) == 4
        read_ = await service.load(s)
        on = {g.id: {e.roadmap.slug for e in read_.entries if e.goal and e.goal.id == g.id}
              for g in goals}  # fmt: skip
        assert all(len(slugs) == 5 for slugs in on.values()), on
        loaded = [(await additions._job_document(s, g, read_, None)).slug for g in goals]
        read_.entries.reverse()
        reversed_ = [(await additions._job_document(s, g, read_, None)).slug for g in goals]
    assert loaded == reversed_ == ["roadmap-4"] * 4, (loaded, reversed_)
