"""oracle.baseline.from_run._members read for several runs at once (the Inbox's shared read,
oracle.runs.batch) answers as each run read alone, on the seed's cross-run case
(tests/inbox_seed.py:cross_runs): run A creates a goal, a feature and the edge between them;
run B revises A's goal and A's edge and creates a feature of its own; run C proposes changes
to A's feature and B's, and withdrew one to A's goal. The Inbox shows none of the parts
below (it shows counts and reasons), so they are read here directly.

Against Postgres, with invented example data only.

Test cards (protects / fails_when / no_claim):

- test_members_read_together_answer_as_each_alone: protects=for each of A, B and C, the
  batched read's entities, how each came in, proposals and edge counts equal that run read
  alone, and are what the seed wrote: C's withdrawn proposal leaves A's goal out of C's
  rows, B's revision of A's edge counts as changed under A's goal (read through
  ``Edge.id.in_``), and A's edge is never new for B; fails_when=withdrawn proposals are
  read, a revised edge of another run is not read, or another run's edge counts as new
  (each checked by mutating _members); no_claim=the Inbox's rows (test_inbox_read_budget).
"""

import uuid

from sqlalchemy import select

from oracle.baseline import from_run
from oracle.baseline.models import Entity, Proposal
from oracle.tenancy import tenant_session
from tests.baseline_helpers import make_ctx
from tests.inbox_seed import cross_runs


def _plain(m: from_run.Members) -> dict:
    """``m`` by entity title: how it came in, its proposals' statuses, its edge counts."""
    return {
        e.title: (
            m.change[i],
            [p.status for p in m.proposals.get(i, [])],
            (m.edges[i].new, m.edges[i].changed) if i in m.edges else None,
        )
        for i, e in m.entities.items()
    }


async def test_members_read_together_answer_as_each_alone():
    ctx = await make_ctx()
    await cross_runs(ctx)
    async with tenant_session(ctx.tenant_id) as s:
        run_of: dict[str, uuid.UUID] = {
            title: run_id
            for title, run_id in (await s.execute(select(Entity.title, Entity.run_id))).all()
        }
        a, b = run_of["Cross-run goal"], run_of["Cross-run feature B"]
        (c,) = {p.run_id for p in await s.scalars(select(Proposal)) if p.run_id not in (a, b)}
        together = await from_run._members(s, [a, b, c])
        alone = {r: (await from_run._members(s, [r]))[r] for r in (a, b, c)}

    for r in (a, b, c):
        assert _plain(together[r]) == _plain(alone[r]), r
    assert _plain(together[a]) == {
        "Cross-run goal": ("new", [], None),
        "Cross-run feature A": ("new", [], (1, 0)),
    }
    assert _plain(together[b]) == {
        "Cross-run goal": ("changed", [], (0, 1)),
        "Cross-run feature B": ("new", [], None),
    }
    # The withdrawn proposal to A's goal is not one of C's rows.
    assert _plain(together[c]) == {
        "Cross-run feature A": ("proposal", ["open"], None),
        "Cross-run feature B": ("proposal", ["open"], None),
    }
