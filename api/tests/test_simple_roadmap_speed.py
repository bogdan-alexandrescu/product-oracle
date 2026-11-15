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
    "goal": "136f9ccc767d8b6d39c27d0cf8371a1023c22d74d3d478aaeebde5fc39ff5e36",
    "track": "bde1b2c9c2798ebb0de9522244ff6e3eeb9a11279ce305ab06966d1c028572ba",
    "prd": "70fc04600fcea64c8bf26f4d37553d1188d0219c304a2b91bdda4b7eca562d4e",
    "one-roadmap": "4009b0dfdc9f97b4e2c4bcf220956457ea805a18fe784a6bc6935f8b9cf9d300",
    "viewer": "3273811b08e5b03af523e244a97637eeea0be14f155ede37e7a96e3d819865c3",
    "waiting": "5f6ba384f78e86590d629e1f984326f672fbd5ab653f69a0edab9beda48db1b6",
    "waiting-viewer": "8e3c599ef74b60ae7cc28c7bbcbee560464dfc074a18d9e9ac36e11f81feded5",
}


@pytest.fixture(autouse=True)
def clock(monkeypatch):
    monkeypatch.setattr(company_time, "now", lambda: NOW)


def _digest(body: bytes, tenant_id) -> str:
    return hashlib.sha256(body.replace(str(tenant_id).encode(), b"TENANT")).hexdigest()


async def test_reads_answer_the_same_on_a_company_sized_seed(client):
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
    ctx = await seed_company()
    owner = ctx.as_("owner")
    roadmap = await _statements(client, ROADMAP, owner)
    waiting = await _statements(client, WAITING, owner)
    print(f"statements: roadmap {roadmap}, waiting {waiting}")
    assert roadmap <= 60, roadmap
    assert waiting <= 24, waiting


@pytest.mark.timing
async def test_reads_answer_within_budget(client):
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
