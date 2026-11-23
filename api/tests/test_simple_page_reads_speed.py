"""simple-speed: how many SQL statements the reads of a page load make, on a company the
size of the owner's own today (tests/simple_speed_seed.py: 60 roadmap items on 5 tracks and
4 PRDs, 19 roadmap versions, 16 goals, 220 decisions, 65 launches). Against Postgres.

Test cards (protects / fails_when / no_claim):

- test_the_track_list_reads_shared_things_once: protects=GET /v1/tracks reads what every
  track of one roadmap reads alike (the company's day, the roadmap's version and items, the
  tracks sharing it, the documents) once for the list: at most TRACKS_CEILING statements
  for 5 tracks (before: 118, of them 20 reads of the same setting and 18 of the same
  documents); fails_when=each track reads them again; no_claim=each track's own item
  context (still read per track).
- test_the_track_list_says_what_each_track_says: protects=each row of the list equals that
  track's own overview (GET /v1/tracks/{id}), field for field, read on its own with nothing
  shared; fails_when=a shared read changes a row; no_claim=the overview's own rules.
- test_page_reads_stay_within_their_statements: protects=the reads a Simple page makes stay
  at or under the statement counts measured on this seed (a guard: they already read in a
  fixed number of statements); fails_when=one starts reading per row; no_claim=the Inbox
  counts, the waiting lists and goal suggestions (another lane's rules, their own tests).
"""

import pytest
from sqlalchemy import event

from oracle import company_time
from oracle.db import get_engine
from tests.simple_speed_seed import NOW, seed_company

# Measured on the seed: 62 (before: 118).
TRACKS_CEILING = 70
# Measured on the seed (sign-in included), with a little room.
CEILINGS = {
    "/v1/simple/roadmap?group=goal": 58,
    "/v1/simple/tracks": 48,
    "/v1/simple/removed": 44,
    "/v1/simple/changes": 52,
    "/v1/plan": 44,
    "/v1/inbox": 100,
    "/v1/feature-states": 12,
    "/v1/simple/meetings": 14,
    "/v1/simple/drafts": 19,
    "/v1/track-alerts": 8,
    "/v1/me": 6,
}


@pytest.fixture(autouse=True)
def clock(monkeypatch):
    monkeypatch.setattr(company_time, "now", lambda: NOW)


class Statements:
    def __init__(self) -> None:
        self.seen: list[str] = []

    def __call__(self, conn, cursor, statement, *args) -> None:
        if "SAVEPOINT" not in statement:
            self.seen.append(statement)

    def __enter__(self) -> "Statements":
        event.listen(get_engine().sync_engine, "before_cursor_execute", self)
        return self

    def __exit__(self, *exc) -> None:
        event.remove(get_engine().sync_engine, "before_cursor_execute", self)


async def _count(client, url: str, headers) -> int:
    assert (await client.get(url, headers=headers)).status_code == 200
    with Statements() as st:
        r = await client.get(url, headers=headers)
    assert r.status_code == 200, (url, r.text)
    return len(st.seen)


async def test_the_track_list_reads_shared_things_once(client):
    """The track list reads what its tracks share once, not once per track."""
    ctx = await seed_company()
    count = await _count(client, "/v1/tracks", ctx.as_("owner"))
    print("tracks:", count)
    assert count <= TRACKS_CEILING, count


async def test_the_track_list_says_what_each_track_says(client):
    """Each row of the track list equals that track's own overview."""
    ctx = await seed_company()
    headers = ctx.as_("owner")
    listed = (await client.get("/v1/tracks", headers=headers)).json()
    assert len(listed) == 5
    for row in listed:
        own = (await client.get(f"/v1/tracks/{row['id']}", headers=headers)).json()
        assert row == {k: own[k] for k in row}, row["title"]


async def test_page_reads_stay_within_their_statements(client):
    """The reads of a Simple page stay within the statements measured for each."""
    ctx = await seed_company()
    headers = ctx.as_("owner")
    counts = {url: await _count(client, url, headers) for url in CEILINGS}
    print(counts)
    over = {url: n for url, n in counts.items() if n > CEILINGS[url]}
    assert not over, (over, counts)
