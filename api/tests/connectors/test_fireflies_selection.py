"""Fireflies sources picked in the browse screen: all meetings, a date range, recurring
series and single meetings (S5, owner 2026-10-19)."""

import time

import httpx
import pytest

from oracle.sources.base import (
    ConnectorConfigError,
    ConnectorRateLimited,
    CursorCheckpoint,
    ItemDelete,
    ItemUpsert,
)
from oracle.sources.connectors import fireflies
from oracle.sources.connectors.fireflies import (
    FirefliesConnector,
    Selection,
    normalise_title,
    selection,
    series_key,
    series_title,
)
from tests.fireflies_fake import API_KEY, SAMPLE, STANDUP_CAL, FakeFireflies, meeting, rate_limited

CREDENTIAL = {"api_key": API_KEY}
STANDUP = f"cal:{STANDUP_CAL}"
PLANNING = "title:ai agents sprint planning|lin@x.io"


def connector(fake: FakeFireflies) -> FirefliesConnector:
    return FirefliesConnector(httpx.AsyncClient(transport=httpx.MockTransport(fake)))


@pytest.fixture(autouse=True)
def small_pages(monkeypatch):
    monkeypatch.setattr(fireflies, "PAGE_SIZE", 3)


def known(*ids: str):
    async def load() -> set[str]:
        return set(ids)

    return load


async def collect(conn, config, cursor=None, **kw):
    return [e async for e in conn.sync(config, CREDENTIAL, cursor, **kw)]


def upserted(events) -> list[str]:
    return [e.external_id for e in events if isinstance(e, ItemUpsert)]


def deleted(events) -> list[str]:
    return [e.external_id for e in events if isinstance(e, ItemDelete)]


# --- Series keys and titles ---------------------------------------------------------


@pytest.mark.parametrize(
    ("title", "normal"),
    [
        ("AI Agents daily standup", "ai agents daily standup"),
        ("  AI   agents  daily standup ", "ai agents daily standup"),
        ("AI agents sprint planning - Oct 14", "ai agents sprint planning"),
        ("AI agents sprint planning #12", "ai agents sprint planning"),
        ("Weekly sync (10/14)", "weekly sync"),
        ("Weekly sync 2026-10-14", "weekly sync"),
        ("Weekly sync | 14 October 2026", "weekly sync"),
        ("Weekly sync: Tue, Oct 14th, 2026", "weekly sync"),
        ("Retro 12", "retro"),
        ("Product review v2", "product review v2"),
        ("Web3 roadmap", "web3 roadmap"),
        ("Q3 planning", "q3 planning"),
        ("#12", "#12"),
    ],
)
def test_normalise_title(title, normal):
    assert normalise_title(title) == normal


def test_series_title_keeps_case_and_drops_the_dated_suffix():
    assert series_title("AI agents sprint planning - Oct 14") == "AI agents sprint planning"
    assert series_title("  AI Agents  daily standup ") == "AI Agents daily standup"


@pytest.mark.parametrize(
    "title",
    [
        "Standup" + " 1" * 8000,
        "Standup" + " - 1" * 4000,
        "1 " * 8000 + "x",
        "Standup " + "(10/14) " * 2000,
    ],
)
def test_series_title_is_linear_on_a_16_kb_title(title):
    """A long title must not block the event loop (it used to take 22 s at 16 KB)."""
    assert len(title) >= 16_000
    best = float("inf")
    for _ in range(3):
        started = time.perf_counter()
        series_title(title)
        best = min(best, time.perf_counter() - started)
    assert best < 0.010


def test_series_title_cuts_long_titles_and_strips_every_suffix_at_once():
    assert series_title("Standup" + " 1" * 8000) == "Standup"
    assert len(series_title("x" * 5000)) <= fireflies.MAX_TITLE
    assert series_title("Sprint planning - Oct 14 (2) #3") == "Sprint planning"
    # Nothing but a suffix: kept as it is.
    assert series_title("- 12") == "- 12"


def test_series_key_prefers_the_calendar_event_and_strips_the_instance_suffix():
    keys = {series_key(m) for m in SAMPLE if m["id"].startswith("S")}
    assert keys == {STANDUP}
    assert {series_key(m) for m in SAMPLE if m["id"].startswith("P")} == {PLANNING}
    # Same title, another organizer: another series.
    other = meeting("X", "AI agents sprint planning #3", "2026-10-01T10:00:00Z", organizer="z@x.io")
    assert series_key(other) == "title:ai agents sprint planning|z@x.io"


@pytest.mark.parametrize(
    "calendar_id",
    [
        "abc123def",
        "abc123def_20261022T160000Z",
        "abc123def_R20261021T160000",
        "abc123def_R20261021T160000_20261022T160000Z",
        "abc123def_R20261021T160000_20261022T160000Z@google.com",
        "abc123def@google.com",
    ],
)
def test_a_split_google_series_keeps_its_key(calendar_id):
    """Google's 'this and following' split gives the rest of the series the id
    <id>_R<start>; its instances add _<start>Z."""
    entry = meeting("X", "Standup", "2026-10-22T16:00:00Z", calendar_id=calendar_id)
    assert series_key(entry) == "cal:abc123def"


async def test_a_split_series_keeps_taking_new_meetings():
    fake = FakeFireflies(
        [meeting("A1", "Standup", "2026-10-01T16:00:00Z", calendar_id="abc123def")]
    )
    conn = connector(fake)
    config = {"mode": "selected", "series": ["cal:abc123def"]}
    first = await collect(conn, config)
    cursor = next(e for e in reversed(first) if isinstance(e, CursorCheckpoint)).cursor
    fake.meetings.append(
        meeting(
            "A2",
            "Standup",
            "2026-10-22T16:00:00Z",
            calendar_id="abc123def_R20261021T160000_20261022T160000Z",
        )
    )
    second = await collect(conn, config, cursor)
    assert upserted(second) == ["A2"]


async def test_a_picked_series_also_matches_by_title_and_organizer():
    """When the calendar id changes in a way the key cannot follow (a series moved to
    another calendar, a provider with other ids), the series still matches by its
    normalised title and organizer."""
    fake = FakeFireflies(
        [
            meeting("A1", "Standup #1", "2026-10-01T16:00:00Z", calendar_id="abc123def"),
            meeting("A2", "Standup #2", "2026-10-08T16:00:00Z", calendar_id="zzz-moved"),
            meeting("A3", "Standup #3", "2026-10-15T16:00:00Z"),
            # Same title, another organizer: another series.
            meeting("B1", "Standup", "2026-10-09T16:00:00Z", organizer="z@x.io"),
        ]
    )
    conn = connector(fake)
    config = {"mode": "selected", "series": ["cal:abc123def"]}
    first = await collect(conn, config)
    assert upserted(first) == ["A1", "A2", "A3"]
    cursor = next(e for e in reversed(first) if isinstance(e, CursorCheckpoint)).cursor
    # Remembered, so a later sync that no longer lists A1 still knows the title.
    fake.meetings.append(
        meeting("A4", "Standup #4", "2026-10-22T16:00:00Z", calendar_id="other-cal-id")
    )
    second = await collect(conn, config, cursor)
    assert upserted(second) == ["A4"]


# --- Config -------------------------------------------------------------------------


def test_legacy_configs_map_to_a_title_rule():
    assert selection({}) == Selection(mode="all")
    legacy = selection({"from_date": "2026-10-01", "title_contains": ["Product"]})
    assert legacy.mode == "all"
    assert legacy.date_from is not None and legacy.date_from.isoformat().startswith("2026-10-01")
    assert legacy.titles == ("product",)
    assert legacy.legacy
    # The old web form saved title filters under "meetings", which the connector ignored.
    assert selection({"meetings": ["Weekly product review"]}).titles == ("weekly product review",)
    assert selection({"meetings": ["Weekly product review"]}).meetings == frozenset()


def test_new_config():
    sel = selection(
        {
            "mode": "selected",
            "date_from": "2026-09-01",
            "date_to": "2026-10-31",
            "series": [STANDUP],
            "meetings": ["K1"],
        }
    )
    assert sel.mode == "selected" and not sel.legacy
    assert sel.series == frozenset({STANDUP}) and sel.meetings == frozenset({"K1"})
    assert sel.date_to_end is not None and sel.date_to_end.isoformat().startswith("2026-11-01")


@pytest.mark.parametrize(
    ("config", "match"),
    [
        ({"mode": "some"}, "mode"),
        ({"mode": "all", "date_from": "soon"}, "ISO date"),
        ({"mode": "all", "date_from": "2026-10-02", "date_to": "2026-10-01"}, "after"),
        ({"mode": "selected"}, "at least one"),
        ({"mode": "selected", "series": "x"}, "series"),
        ({"mode": "selected", "meetings": [1]}, "meetings"),
    ],
)
async def test_config_errors(config, match):
    with pytest.raises(ConnectorConfigError, match=match):
        selection(config)
    with pytest.raises(ConnectorConfigError, match=match):
        await connector(FakeFireflies(SAMPLE)).validate(config, CREDENTIAL)


# --- Sync ---------------------------------------------------------------------------


async def test_all_meetings():
    fake = FakeFireflies(SAMPLE)
    events = await collect(connector(fake), {"mode": "all"})
    assert upserted(events) == ["O1", "S1", "P1", "K1", "S2", "S3", "P2"]


async def test_all_in_a_date_range_queries_only_that_range():
    fake = FakeFireflies(SAMPLE)
    config = {"mode": "all", "date_from": "2026-10-01", "date_to": "2026-10-12"}
    events = await collect(connector(fake), config)
    assert upserted(events) == ["K1", "S2", "S3"]
    for v in fake.list_variables():
        assert v["fromDate"] == "2026-10-01T00:00:00Z"
        assert v["toDate"] == "2026-10-12T23:59:59.999Z"
    # Three in range at a page size of 3: one full page, then an empty one.
    assert len(fake.list_variables()) == 2


async def test_selected_series_and_meetings():
    fake = FakeFireflies(SAMPLE)
    config = {"mode": "selected", "series": [STANDUP, PLANNING], "meetings": ["K1"]}
    events = await collect(connector(fake), config)
    assert upserted(events) == ["S1", "P1", "K1", "S2", "S3", "P2"]
    assert sorted(fake.detail_ids()) == ["K1", "P1", "P2", "S1", "S2", "S3"]


async def test_date_range_applies_to_what_is_picked():
    fake = FakeFireflies(SAMPLE)
    config = {
        "mode": "selected",
        "date_from": "2026-10-01",
        "series": [STANDUP],
        "meetings": ["O1"],
    }
    events = await collect(connector(fake), config)
    assert upserted(events) == ["S2", "S3"]


async def test_a_new_meeting_of_a_series_is_picked_up_on_the_next_sync():
    fake = FakeFireflies(list(SAMPLE))
    conn = connector(fake)
    config = {"mode": "selected", "series": [STANDUP]}
    first = await collect(conn, config)
    cursor = next(e for e in reversed(first) if isinstance(e, CursorCheckpoint)).cursor

    fake.meetings.append(
        meeting(
            "S4",
            "AI Agents daily standup",
            "2026-10-19T09:00:00Z",
            calendar_id=f"{STANDUP_CAL}_20261019T090000Z",
        )
    )
    fake.meetings.append(meeting("N1", "Lunch and learn", "2026-10-19T12:00:00Z"))
    fake.requests.clear()
    second = await collect(conn, config, cursor)
    assert upserted(second) == ["S4"]
    assert fake.detail_ids() == ["S4"]
    # Incremental: only the overlap window is listed again.
    assert fake.list_variables()[0]["fromDate"] == "2026-10-11T09:00:00Z"


async def test_a_full_pass_deletes_what_is_no_longer_picked_and_skips_what_is_stored():
    fake = FakeFireflies(SAMPLE)
    config = {"mode": "selected", "series": [STANDUP]}
    # Stored from the previous selection: the standups, the planning and the interview.
    events = await collect(connector(fake), config, None, known=known("S1", "S2", "P1", "K1"))
    assert deleted(events) == ["K1", "P1"]
    # Stored standups are not fetched again; the one not stored yet is.
    assert fake.detail_ids() == ["S3"]
    assert upserted(events) == ["S3"]
    assert events[-1] == CursorCheckpoint(
        {
            "since": "2026-10-12T09:00:00Z",
            "recent": {"S3": "2026-10-12T09:00:00Z"},
            # The series' title key, should its calendar id change.
            "aliases": ["title:ai agents daily standup|ada@example.com"],
        }
    )


async def test_a_full_pass_with_nothing_to_fetch_still_commits_its_deletes():
    fake = FakeFireflies(SAMPLE)
    config = {"mode": "all", "date_from": "2026-10-10"}
    events = await collect(connector(fake), config, None, known=known("S3", "P2", "K1"))
    assert deleted(events) == ["K1"]
    assert fake.detail_ids() == []
    assert isinstance(events[-1], CursorCheckpoint)
    assert events[-1].cursor["since"] == "2026-10-14T14:00:00Z"


async def test_an_incremental_sync_deletes_nothing_and_does_not_read_stored_ids():
    calls = []

    async def load() -> set[str]:
        calls.append(1)
        return {"K1"}

    cursor = {"since": "2026-10-14T14:00:00Z", "recent": {"P2": "2026-10-14T14:00:00Z"}}
    events = await collect(connector(FakeFireflies(SAMPLE)), {"mode": "all"}, cursor, known=load)
    assert events == [] and calls == []


async def test_legacy_title_rule_still_filters():
    fake = FakeFireflies(SAMPLE)
    events = await collect(connector(fake), {"title_contains": ["planning"]})
    assert upserted(events) == ["P1", "P2"]


async def test_rate_limited_while_listing():
    with pytest.raises(ConnectorRateLimited) as raised:
        await collect(connector(FakeFireflies(SAMPLE, error=rate_limited(30))), {"mode": "all"})
    assert raised.value.retry_after == 30


# --- Browse -------------------------------------------------------------------------


async def test_browse_meetings_pages_with_search_and_range():
    fake = FakeFireflies(SAMPLE)
    conn = connector(fake)
    page = await conn.browse_meetings(CREDENTIAL, search="", date_from=None, date_to=None, skip=0)
    assert [m.id for m in page.meetings] == ["P2", "S3", "S2"]
    assert page.next_skip == 3
    first = page.meetings[0]
    assert first.series_key == PLANNING
    assert first.series_title == "AI agents sprint planning"
    assert first.organizer == "lin@x.io"
    assert first.duration == 30.0

    found = await conn.browse_meetings(
        CREDENTIAL, search="acme", date_from=None, date_to=None, skip=0
    )
    assert [m.id for m in found.meetings] == ["K1"]
    assert found.meetings[0].attendee_count == 3
    assert found.next_skip is None
    assert fake.list_variables()[-1]["keyword"] == "acme"


async def test_browse_series_groups_with_counts_and_last_date():
    fake = FakeFireflies(SAMPLE)
    result = await connector(fake).browse_series(CREDENTIAL, date_from=None, date_to=None)
    by_key = {s.key: s for s in result.series}
    assert by_key[STANDUP].meeting_count == 3
    assert by_key[STANDUP].title == "AI agents daily standup"
    assert by_key[STANDUP].last_date.isoformat().startswith("2026-10-12")
    assert by_key[PLANNING].meeting_count == 2
    # Newest first.
    assert result.series[0].key == PLANNING
    assert result.truncated is False
