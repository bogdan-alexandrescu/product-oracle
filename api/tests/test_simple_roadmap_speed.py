"""roadmap-speed (owner: "product oracle is loading so slowly"): the Simple roadmap read
(``GET /v1/simple/roadmap``) and the side menu's count (``/v1/simple/roadmap/waiting``) on a
company at least the size of a real one (tests/roadmap_scale_seed.py). Against Postgres.

Test cards (protects / fails_when / no_claim):

- test_reads_answer_the_same_on_a_company_sized_seed: protects=the speed work changes no
  byte of either read: each view's body (group goal, track and prd, one roadmap, a viewer's
  read, the waiting count) hashes to the digest the reads had before it (5c6d57bed);
  fails_when=any field, order or value moves; no_claim=a reader with a working draft.
- test_reads_take_few_statements: protects=the roadmap read takes at most 59 statements (the
  first read on a fresh seed) and the waiting count at most 24 on that company;
  fails_when=a loader comes back per row or a table is read twice; no_claim=other pages.
- test_read_ranks_through_a_light_load: protects=the read's rank loads columns only: no
  evidence text, citation or source item is read, and no feature or goal is loaded twice as
  a whole row; fails_when=the rank reads the Priorities page's full load; no_claim=its time.
- test_a_viewers_roadmap_read_writes_nothing: protects=a viewer's roadmap read (after a first)
  issues no UPDATE, INSERT or DELETE; fails_when=the rank or any loader writes while reading;
  no_claim=other reads.
- test_reads_answer_within_budget (timing mark: CI runs it alone): protects=best of 3 after
  a warm-up: the roadmap under 360 ms, the waiting count under 110 ms; fails_when=the read
  slows past the budget; no_claim=production's network and load.
"""

import hashlib
import json
import os
import time
from pathlib import Path

import pytest
from sqlalchemy import event

from oracle import company_time
from oracle.db import get_engine
from tests.roadmap_scale_seed import NOW, seed_company

ROADMAP = "/v1/simple/roadmap"
WAITING = "/v1/simple/roadmap/waiting"
VIEWS = {
    "goal": (ROADMAP, "owner", {}),
    "track": (ROADMAP, "owner", {"group": "track"}),
    "prd": (ROADMAP, "owner", {"group": "prd"}),
    "one-roadmap": (ROADMAP, "approver", {"roadmap": "company-roadmap"}),
    "viewer": (ROADMAP, "viewer", {"group": "goal"}),
    "waiting": (WAITING, "owner", {}),
    "waiting-viewer": (WAITING, "viewer", {"roadmap": "company-roadmap"}),
}
# Each view's body on the seed as 5c6d57bed answered it (the company's id masked).
# roadmap-dates: picked_quarter, and undated items estimated by their suggestions.
# timeline-order: the five roadmap views gain position (an integer) and before_override (null on
# this seed) on each of the seed's 400 items and nothing else (JSON diff against main 64225004).
# gt-proposed: each roadmap item's confirm_feature_id (null on this seed), after code_from; the
# five roadmap views differ from c92397816's by that field alone, the two counts not at all.
# unique-codes: the five roadmap views gain feature_name on each item (null on this seed) and
# nothing else (diffed against fa899682c); the two counts are unchanged.
# task-push: the five roadmap views gain tracker_ref, tracker_url and tracker_error on each task
# (null on this seed) and nothing else (JSON diff against 4ecbc5620); the two counts are unchanged.
DIGESTS = {
    "goal": "6660b2e4fc100d2d1e41ffcbb7c66d54e7f746f06085d8f4242329db9136e83f",
    "track": "c1906cc00bdab30bd11b0073f747339a8c958b5f78434a95e82b9af1fc9da3b1",
    "prd": "c9029989d2650352840bc50b5f0a5ca9c0fed7bef2115d7167b197b4a01b2ad8",
    "one-roadmap": "d2c37d49c5fce2deeac46f279ec21ed5c895825915e5845c102f779c4a9b8c31",
    "viewer": "f0fa99c44b40add65a3058cae4893f4a89cfa8865895e0e55c94981d684aef7a",
    "waiting": "6ec46197015480da730ce7e5d0b228599ec45f31eb3ddac72fe02b136eef19b6",
    "waiting-viewer": "8e3c599ef74b60ae7cc28c7bbcbee560464dfc074a18d9e9ac36e11f81feded5",
}


@pytest.fixture(autouse=True)
def clock(monkeypatch):
    monkeypatch.setattr(company_time, "now", lambda: NOW)


def _digest(body: bytes, tenant_id) -> str:
    return hashlib.sha256(body.replace(str(tenant_id).encode(), b"TENANT")).hexdigest()


async def test_reads_answer_the_same_on_a_company_sized_seed(client):
    """On a large seeded company, every roadmap read still answers byte for byte alike."""
    ctx = await seed_company()
    got = {}
    for name, (url, role, params) in VIEWS.items():
        r = await client.get(url, params=params, headers=ctx.as_(role))
        assert r.status_code == 200, r.text
        got[name] = _digest(r.content, ctx.tenant_id)
        if got[name] != DIGESTS.get(name):
            out = Path(os.environ.get("TMPDIR", ".")) / "roadmap-speed"
            out.mkdir(parents=True, exist_ok=True)
            (out / f"{name}.json").write_text(json.dumps(r.json(), indent=1, sort_keys=False))
    print(json.dumps(got, indent=1))
    assert got == DIGESTS


async def _statements(client, url: str, headers: dict, **params) -> int:
    statements: list[str] = []

    def count(conn, cursor, statement, *args):
        statements.append(statement)

    engine = get_engine().sync_engine
    event.listen(engine, "before_cursor_execute", count)
    try:
        r = await client.get(url, params=params, headers=headers)
    finally:
        event.remove(engine, "before_cursor_execute", count)
    assert r.status_code == 200, r.text
    return len([st for st in statements if "SAVEPOINT" not in st])


async def test_reads_take_few_statements(client):
    """Roadmap and waiting reads stay within a fixed budget of database statements."""
    ctx = await seed_company()
    owner = ctx.as_("owner")
    roadmap = await _statements(client, ROADMAP, owner)
    waiting = await _statements(client, WAITING, owner)
    print(f"statements: roadmap {roadmap}, waiting {waiting}")
    assert roadmap <= 59, roadmap
    assert waiting <= 24, waiting


async def test_read_ranks_through_a_light_load(client):
    """The roadmap read's rank reads no evidence text and no source items."""
    ctx = await seed_company()
    statements: list[str] = []

    def seen(conn, cursor, statement, *args):
        statements.append(" ".join(statement.split()))

    engine = get_engine().sync_engine
    event.listen(engine, "before_cursor_execute", seen)
    try:
        r = await client.get(ROADMAP, headers=ctx.as_("viewer"))
    finally:
        event.remove(engine, "before_cursor_execute", seen)
    assert r.status_code == 200, r.text
    assert not [st for st in statements if "evidence.url" in st or "FROM source_items" in st]


async def test_a_viewers_roadmap_read_writes_nothing(client):
    """A viewer's roadmap read, rank included, issues no UPDATE, INSERT or DELETE."""
    ctx = await seed_company()
    statements: list[str] = []

    def seen(conn, cursor, statement, *args):
        statements.append(" ".join(statement.split()))

    # A first read may seed what later reads find (goal milestones); the next writes nothing.
    await client.get(ROADMAP, headers=ctx.as_("owner"))
    engine = get_engine().sync_engine
    event.listen(engine, "before_cursor_execute", seen)
    try:
        r = await client.get(ROADMAP, headers=ctx.as_("viewer"))
    finally:
        event.remove(engine, "before_cursor_execute", seen)
    assert r.status_code == 200, r.text
    assert statements
    writes = [
        st for st in statements if st.split(" ", 1)[0].upper() in ("UPDATE", "INSERT", "DELETE")
    ]
    assert not writes, writes


@pytest.mark.timing
async def test_reads_answer_within_budget(client):
    """Roadmap and waiting reads stay fast even on a large seeded company."""
    ctx = await seed_company()
    owner = ctx.as_("owner")
    best = {}
    for url in (ROADMAP, WAITING):
        await client.get(url, headers=owner)
        times = []
        for _ in range(3):
            t0 = time.perf_counter()
            r = await client.get(url, headers=owner)
            times.append(time.perf_counter() - t0)
            assert r.status_code == 200, r.text
        best[url] = min(times)
        print(f"{url}: {', '.join(f'{t * 1000:.0f}' for t in times)} ms")
    # 360 ms: the light rank costs about 50 ms (best of 3: 245 ms without it, 295 with it);
    # the old 300 ms was 1.22 times the old time, and 1.22 times 295 is 360.
    assert best[ROADMAP] < 0.36, best
    assert best[WAITING] < 0.11, best
