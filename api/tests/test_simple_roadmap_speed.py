"""roadmap-speed (owner: "product oracle is loading so slowly"): the Simple roadmap read
(``GET /v1/simple/roadmap``) and the side menu's count (``/v1/simple/roadmap/waiting``) on a
company at least the size of a real one (tests/roadmap_scale_seed.py). Against Postgres.

Test cards (protects / fails_when / no_claim):

- test_reads_answer_the_same_on_a_company_sized_seed: protects=the speed work changes no
  byte of either read: each view's body (group goal, track and prd, one roadmap, a viewer's
  read, the waiting count) hashes to the digest the reads had before it (5c6d57bed);
  fails_when=any field, order or value moves; no_claim=a reader with a working draft.
- test_reads_take_few_statements: protects=the roadmap read takes at most 60 statements and
  the waiting count at most 24 on that company; fails_when=a loader comes back per row or a
  table is read twice; no_claim=other pages.
- test_reads_answer_within_budget (timing mark: CI runs it alone): protects=best of 3 after
  a warm-up: the roadmap under 300 ms, the waiting count under 110 ms; fails_when=the read
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
DIGESTS = {
    "goal": "1e37021e8b0542f7d314557c34e23401255db8407ae013fe67577d126bec891b",
    "track": "a93a51a4ef0a5f5c918f198e79007bb0b288f73ff14cda26fd99c13dc6aabbc5",
    "prd": "f56ca97c00059db531a4978da7ece2e387365fd405585445fb601dac1c4cba53",
    "one-roadmap": "2c728178828c7d74a525071458012f4437d398f7e1c5ed69ad7af020c623751d",
    "viewer": "ae631f6d6a89f26223af12a8838369dc43ec96a60be1a89e2f70919c2ffeeed8",
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
    assert roadmap <= 60, roadmap
    assert waiting <= 24, waiting


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
    assert best[ROADMAP] < 0.3, best
    assert best[WAITING] < 0.11, best
