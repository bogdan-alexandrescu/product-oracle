"""roadmap-codes-speed (train BM merge review): ``roadmap_codes.assign`` joins each goal
milestone by a lookup of its roadmap and code, not by a walk of every goal milestone per
milestone, and answers the same codes as before.

Test cards (protects / fails_when / no_claim):

- test_assign_reads_each_code_a_bounded_number_of_times: protects=a goal milestone's code is
  read a bounded number of times per milestone; fails_when=the joins walk every goal milestone
  again for each one (the plain and alike lists), so the reads grow with the square of their
  number; no_claim=the wall-clock time (test_simple_roadmap_speed).
- test_assign_answers_the_same_codes_on_the_company_seed: protects=the lookup changes no code:
  every milestone's roadmap_code over each roadmap view on the company seed
  (tests/roadmap_scale_seed.py) hashes to the digest the walk gave; fails_when=any milestone's
  code, or the order of the milestones it was given, moves; no_claim=other reads.
"""

import hashlib
import json
import time
import uuid
from datetime import date, timedelta

import pytest

from oracle import company_time
from oracle.simple import roadmap_codes
from oracle.simple.schemas import SimpleGoalMilestone
from tests.roadmap_scale_seed import NOW, seed_company

ROADMAP = "/v1/simple/roadmap"
VIEWS = {
    "goal": ("owner", {}),
    "track": ("owner", {"group": "track"}),
    "prd": ("owner", {"group": "prd"}),
    "one-roadmap": ("approver", {"roadmap": "company-roadmap"}),
    "viewer": ("viewer", {"group": "goal"}),
}
# Every assign call's codes over the views above, as the walk (61f5cea3b) answered them.
DIGEST = "d6c411246080226aadc9eecdad8bd4e436636abcfa799cdcd249e57a1e71bbf7"


def _goal_ms(n: int) -> list[SimpleGoalMilestone]:
    """`n` invented goal milestones on two roadmaps and four goals, codes M1..M5 by turns."""
    roadmaps = [uuid.UUID(int=1), uuid.UUID(int=2)]
    goals = [None, uuid.UUID(int=10), uuid.UUID(int=11), uuid.UUID(int=12)]
    return [
        SimpleGoalMilestone(
            id=uuid.UUID(int=1000 + k),
            roadmap_id=roadmaps[k % 2],
            code=f"M{k % 5 + 1}",
            name=f"Example step {k % 7}",
            date=date(2027, 1, 1) + timedelta(days=k),
            goal_id=goals[k % 4],
        )
        for k in range(n)
    ]


def test_assign_reads_each_code_a_bounded_number_of_times(monkeypatch):
    real = roadmap_codes._gm_code
    reads = 0

    def counted(gm):
        nonlocal reads
        reads += 1
        return real(gm)

    monkeypatch.setattr(roadmap_codes, "_gm_code", counted)
    n = 200
    ms = _goal_ms(n)
    goals = {g: r for r, g in enumerate(m.goal_id for m in ms if m.goal_id)}
    roadmap_codes.assign(ms, [], [], goals)
    assert all(m.roadmap_code for m in ms)
    assert reads <= 3 * n, reads


@pytest.fixture
def clock(monkeypatch):
    monkeypatch.setattr(company_time, "now", lambda: NOW)


async def test_assign_answers_the_same_codes_on_the_company_seed(client, clock, monkeypatch):
    ctx = await seed_company()
    real = roadmap_codes.assign
    seen: list = []
    spent: list[float] = []

    def recorded(goal_ms, track_ms, items, goal_rank):
        t0 = time.perf_counter()
        real(goal_ms, track_ms, items, goal_rank)
        spent.append(time.perf_counter() - t0)
        seen.append(
            [[str(m.id), m.roadmap_code] for m in goal_ms]
            + [[str(m.id), m.roadmap_code] for m in track_ms]
        )

    monkeypatch.setattr(roadmap_codes, "assign", recorded)
    for role, params in VIEWS.values():
        r = await client.get(ROADMAP, params=params, headers=ctx.as_(role))
        assert r.status_code == 200, r.text
    assert seen and any(len(s) for s in seen)
    ms = ", ".join(f"{t * 1000:.1f}" for t in spent)
    print(f"assign: {ms} ms over {len(seen[0])} milestones")
    got = hashlib.sha256(json.dumps(seen).encode()).hexdigest()
    print(got)
    assert got == DIGEST
