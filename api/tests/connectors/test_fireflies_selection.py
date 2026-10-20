"""Fireflies sources picked in the browse screen: all meetings, a date range, recurring
series and single meetings (S5, owner 2026-10-19)."""

import time
from datetime import UTC, datetime, timedelta
from email.utils import format_datetime

import httpx
import pytest

from oracle.sources.base import (
    ConnectorConfigError,
    ConnectorError,
    ConnectorRateLimited,
    CursorCheckpoint,
    ItemDelete,
    ItemUpsert,
)
from oracle.sources.connectors import fireflies
from oracle.sources.connectors.fireflies import (
    FirefliesConnector,
    Selection,
    _iso,
    fingerprint,
    selection,
    series_key,
    series_title,
)
from tests.fireflies_fake import (
    API_KEY,
    PLANNING_CAL,
    SAMPLE,
    STANDUP_CAL,
    FakeFireflies,
    meeting,
    rate_limited,
)

CREDENTIAL = {"api_key": API_KEY}
STANDUP = f"cal:{STANDUP_CAL}"
PLANNING = f"cal:{PLANNING_CAL}"


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
def test_series_title_drops_dated_suffixes(title, normal):
    assert series_title(title).lower() == normal


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


def _fastest(title: str) -> float:
    best = float("inf")
    for _ in range(3):
        started = time.perf_counter()
        series_title(title)
        best = min(best, time.perf_counter() - started)
    return best


def test_series_title_does_not_backtrack_exponentially_on_repeated_dates():
    """A regex repeating overlapping date alternatives backtracked exponentially: the
    first title took 36 s at 21 blocks and the second doubled with every date."""
    blocks = "a 1111-1-1" + "-1111-1-1" * 16 + "x"
    dates = "Sync" + " 2026-10-14" * 16 + " notes"
    assert _fastest(blocks) < 0.010
    assert _fastest(dates) < 0.010
    assert series_title(dates) == dates


def test_series_title_worst_case_is_bounded():
    """Every round strips a suffix of the capped title: the most rounds there can be."""
    for title in ("S" + " 1" * 99, "S" + " - 1" * 49, "S" + " (1)" * 49, "S" + " #1" * 66):
        assert len(title) <= fireflies.MAX_TITLE
        assert _fastest(title) < 0.010, title
        assert series_title(title) == "S"


def test_series_title_cuts_long_titles_and_strips_every_suffix():
    assert series_title("Standup" + " 1" * 8000) == "Standup"
    assert len(series_title("x" * 5000)) <= fireflies.MAX_TITLE
    assert series_title("Sprint planning - Oct 14 (2) #3") == "Sprint planning"
    # Nothing but a suffix: kept as it is.
    assert series_title("- 12") == "- 12"


def test_series_key_prefers_the_calendar_event_and_strips_the_instance_suffix():
    keys = {series_key(m) for m in SAMPLE if m["id"].startswith("S")}
    assert keys == {STANDUP}
    assert {series_key(m) for m in SAMPLE if m["id"].startswith("P")} == {PLANNING}
    # No calendar id: no series.
    other = meeting(
        "X", "AI agents sprint planning #3", "2026-10-01T10:00:00Z", organizer="lin@x.io"
    )
    assert series_key(other) is None


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


def _one_offs_beside_a_series() -> FakeFireflies:
    return FakeFireflies(
        [
            meeting("A1", "Standup #1", "2026-10-01T16:00:00Z", calendar_id="abc123def"),
            meeting(
                "A2", "Standup #2", "2026-10-08T16:00:00Z", calendar_id="abc123def_20261008T160000Z"
            ),
            # A one-off with the series' title and organizer, on no calendar.
            meeting("X1", "Standup", "2026-10-09T16:00:00Z"),
            # The same title on another calendar event: another series.
            meeting("Y1", "Standup #3", "2026-10-15T16:00:00Z", calendar_id="zzz-other"),
        ]
    )


async def test_a_picked_series_takes_its_calendar_series_only():
    """A series is the calendar series: a one-off with the same title and organizer is
    not in it (the picker shows it unpicked), and only picking it takes it."""
    fake = _one_offs_beside_a_series()
    conn = connector(fake)
    config = {"mode": "selected", "series": ["cal:abc123def"]}
    first = await collect(conn, config)
    assert upserted(first) == ["A1", "A2"]
    cursor = next(e for e in reversed(first) if isinstance(e, CursorCheckpoint)).cursor
    assert "aliases" not in cursor
    fake.meetings.append(meeting("X2", "Standup #4", "2026-10-22T16:00:00Z"))
    assert upserted(await collect(conn, config, cursor)) == []

    picked = {"mode": "selected", "series": ["cal:abc123def"], "meetings": ["X1"]}
    assert upserted(await collect(conn, picked)) == ["A1", "A2", "X1"]


async def test_the_pickers_series_count_is_what_a_sync_of_it_takes():
    fake = _one_offs_beside_a_series()
    conn = connector(fake)
    listed = await conn.browse_series(CREDENTIAL, date_from=None, date_to=None)
    counts = {s.key: s.meeting_count for s in listed.series}
    # Meetings without a calendar id are in no series.
    assert counts == {"cal:abc123def": 2, "cal:zzz-other": 1}
    for key, count in counts.items():
        events = await collect(conn, {"mode": "selected", "series": [key]})
        assert len(upserted(events)) == count, key
    page = await conn.browse_meetings(CREDENTIAL, search="", date_from=None, date_to=None, skip=0)
    assert {m.id: m.series_key for m in page.meetings}["X1"] is None


async def test_a_full_pass_drops_one_offs_an_older_rule_took_with_the_series():
    """Sources synced while a series also matched by title stored such one-offs: the
    full pass after this change deletes them."""
    events = await collect(
        connector(_one_offs_beside_a_series()),
        {"mode": "selected", "series": ["cal:abc123def"]},
        known=known("A1", "A2", "X1"),
    )
    assert deleted(events) == ["X1"]
    assert upserted(events) == []


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
        ({"mode": "all", "date_from": "soon"}, "YYYY-MM-DD"),
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
    # Incremental: only the three days before the newest meeting listed (P2, not
    # picked) are listed again.
    assert fake.list_variables()[0]["fromDate"] == "2026-10-11T14:00:00Z"


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
            # S3 is in the next sync's window (three days before "listed").
            "recent": {"S3": "2026-10-12T09:00:00Z"},
            # The newest meeting listed (P2, not picked).
            "listed": "2026-10-14T14:00:00Z",
            "selection": fingerprint(config),
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

    cursor = {
        "since": "2026-10-14T14:00:00Z",
        "recent": {"S3": "2026-10-12T09:00:00Z", "P2": "2026-10-14T14:00:00Z"},
    }
    events = await collect(connector(FakeFireflies(SAMPLE)), {"mode": "all"}, cursor, known=load)
    assert events == [] and calls == []


async def test_an_old_pick_does_not_make_every_sync_reread_the_history(monkeypatch):
    """The position advances on the newest meeting listed, not only on picked ones."""
    monkeypatch.setattr(fireflies, "PAGE_SIZE", 50)
    now = datetime.now(UTC).replace(microsecond=0) - timedelta(days=5)
    account = [
        meeting(f"M{i}", f"Meeting {i}", (now - timedelta(days=i)).isoformat()) for i in range(1000)
    ]
    fake = FakeFireflies(account)
    conn = connector(fake)
    config = {"mode": "selected", "meetings": ["M900"]}
    first = await collect(conn, config, None, known=known())
    assert upserted(first) == ["M900"]
    cursor = next(e for e in reversed(first) if isinstance(e, CursorCheckpoint)).cursor

    fake.requests.clear()
    second = await collect(conn, config, cursor, known=known("M900"))
    assert 1 <= len(fake.list_variables()) <= 2
    assert upserted(second) == [] and deleted(second) == []

    # A new meeting of the account, not picked: the position still moves on.
    fake.meetings.append(meeting("N1", "Lunch", (now + timedelta(days=2)).isoformat()))
    third = await collect(conn, config, cursor, known=known("M900"))
    moved = next(e for e in reversed(third) if isinstance(e, CursorCheckpoint)).cursor
    fake.requests.clear()
    await collect(conn, config, moved, known=known("M900"))
    assert fake.list_variables()[0]["fromDate"] == _iso(now - timedelta(days=1))


async def test_a_full_pass_that_matches_and_deletes_nothing_still_checkpoints():
    fake = FakeFireflies(SAMPLE)
    conn = connector(fake)
    config = {"mode": "selected", "meetings": ["gone"]}
    events = await collect(conn, config, None, known=known())
    assert upserted(events) == [] and deleted(events) == []
    assert isinstance(events[-1], CursorCheckpoint)
    # So the next sync is incremental: it reads only the last three days again.
    fake.requests.clear()
    await collect(conn, config, events[-1].cursor, known=known())
    assert fake.list_variables()[0]["fromDate"] == "2026-10-11T14:00:00Z"


async def test_narrowing_deletes_even_when_an_older_sync_saved_its_position_last():
    """A sync still running under the old selection when the source is narrowed saves
    its cursor after the reset: the next sync must still see the selection changed."""
    fake = FakeFireflies(SAMPLE)
    conn = connector(fake)
    wide = {"mode": "selected", "series": [STANDUP], "meetings": ["K1"]}
    first = await collect(conn, wide, None, known=known())
    stale = next(e for e in reversed(first) if isinstance(e, CursorCheckpoint)).cursor

    narrow = {"mode": "selected", "series": [STANDUP], "labels": {STANDUP: "Standup"}}
    events = await collect(conn, narrow, stale, known=known("S1", "S2", "S3", "K1"))
    assert deleted(events) == ["K1"]
    # Labels only name things for the web UI: they change no selection.
    cursor = next(e for e in reversed(events) if isinstance(e, CursorCheckpoint)).cursor
    relabelled = {**narrow, "labels": {STANDUP: "Daily standup"}}
    again = await collect(conn, relabelled, cursor, known=known("S1", "S2", "S3"))
    assert again == []


async def test_legacy_title_rule_still_filters():
    fake = FakeFireflies(SAMPLE)
    events = await collect(connector(fake), {"title_contains": ["planning"]})
    assert upserted(events) == ["P1", "P2"]


async def test_rate_limited_while_listing():
    with pytest.raises(ConnectorRateLimited) as raised:
        await collect(connector(FakeFireflies(SAMPLE, error=rate_limited(30))), {"mode": "all"})
    assert raised.value.retry_after == 30


# --- Safety -------------------------------------------------------------------------


@pytest.mark.parametrize(
    "response",
    [
        pytest.param(httpx.Response(200, text="<html>Bad gateway</html>"), id="not-json"),
        pytest.param(httpx.Response(200, json={"data": {"transcripts": None}}), id="null-list"),
        pytest.param(httpx.Response(200, json={"data": None}), id="null-data"),
        pytest.param(httpx.Response(200, json={}), id="empty-body"),
    ],
)
async def test_a_full_pass_on_a_broken_answer_fails_and_deletes_nothing(response):
    fake = FakeFireflies(SAMPLE, error=response)
    events: list = []
    with pytest.raises(ConnectorError):
        async for event in connector(fake).sync(
            {"mode": "all"}, CREDENTIAL, None, known=known("S1", "S2", "K1")
        ):
            events.append(event)
    assert deleted(events) == []


@pytest.mark.parametrize(
    "config",
    [
        {"mode": "all", "date_to": "9999-12-31"},
        {"mode": "all", "date_from": 5},
        {"mode": "all", "date_from": 1_760_000_000_000},
        {"mode": "all", "date_to": True},
        {"mode": "all", "date_from": 1.5},
        {"from_date": False},
        {"mode": "all", "labels": {f"m{i}": "Meeting" for i in range(1001)}},
    ],
)
def test_out_of_range_or_mistyped_values_are_config_errors(config):
    with pytest.raises(ConnectorConfigError):
        selection(config)


def test_a_thousand_labels_are_fine():
    labels = {f"m{i}": "Meeting" for i in range(1000)}
    assert selection({"mode": "selected", "meetings": ["m1"], "labels": labels}).meetings


async def test_retry_after_as_an_http_date():
    later = datetime.now(UTC) + timedelta(seconds=120)
    response = rate_limited()
    response.headers["Retry-After"] = format_datetime(later, usegmt=True)
    with pytest.raises(ConnectorRateLimited) as raised:
        await collect(connector(FakeFireflies(SAMPLE, error=response)), {"mode": "all"})
    assert raised.value.retry_after is not None and 100 < raised.value.retry_after <= 121
    # An unreadable one is ignored rather than failing the sync.
    response.headers["Retry-After"] = "soon"
    with pytest.raises(ConnectorRateLimited) as raised:
        await collect(connector(FakeFireflies(SAMPLE, error=response)), {"mode": "all"})
    assert raised.value.retry_after is None


@pytest.mark.parametrize("header", ["inf", "-inf", "nan", "Infinity", "1e400"])
async def test_a_retry_after_that_is_no_number_of_seconds_is_ignored(header):
    response = rate_limited()
    response.headers["Retry-After"] = header
    with pytest.raises(ConnectorRateLimited) as raised:
        await collect(connector(FakeFireflies(SAMPLE, error=response)), {"mode": "all"})
    assert raised.value.retry_after is None


async def test_a_very_long_retry_after_is_capped_at_a_day():
    response = rate_limited(10**12)
    with pytest.raises(ConnectorRateLimited) as raised:
        await collect(connector(FakeFireflies(SAMPLE, error=response)), {"mode": "all"})
    assert raised.value.retry_after == fireflies.MAX_RETRY_AFTER


@pytest.mark.parametrize(
    "errors",
    [
        ["Too many requests"],
        ["boom", None],
        [{"message": "boom", "extensions": "not an object"}],
        {"message": "boom"},
        "boom",
    ],
)
async def test_error_entries_that_are_not_objects_are_errors_not_crashes(errors):
    fake = FakeFireflies(SAMPLE, error=httpx.Response(200, json={"errors": errors}))
    with pytest.raises(ConnectorError):
        await collect(connector(fake), {"mode": "all"}, known=known("S1"))


@pytest.mark.parametrize("value", [10**20, -(10**20), "not a date", "9999-99-99"])
async def test_an_out_of_range_date_from_fireflies_reads_as_no_date(value):
    odd = {**meeting("Z1", "Odd", "2026-10-03T10:00:00Z"), "date": value}
    fake = FakeFireflies([*SAMPLE, odd])
    conn = connector(fake)
    page = await conn.browse_meetings(CREDENTIAL, search="", date_from=None, date_to=None, skip=0)
    assert {m.id: m.date for m in page.meetings}.get("Z1", "absent") in (None, "absent")
    await conn.browse_series(CREDENTIAL, date_from=None, date_to=None)
    assert "Z1" in upserted(await collect(conn, {"mode": "selected", "meetings": ["Z1"]}))


@pytest.mark.parametrize(
    "config",
    [
        {"mode": "all", "date_to": "2026-10-31T23:00:00Z"},
        {"mode": "all", "date_from": "2026-10-01T00:00:00"},
        {"mode": "all", "date_to": "20261031"},
        {"mode": "all", "date_to": "2026-10-31 "},
        {"mode": "all", "date_to": "2026-02-30"},
    ],
)
def test_picker_dates_are_plain_days(config):
    with pytest.raises(ConnectorConfigError, match="YYYY-MM-DD"):
        selection(config)


async def test_a_full_pass_skips_an_out_of_order_old_meeting_and_reads_on():
    """Fireflies is asked for meetings from date_from on: one older than that, listed out
    of order, is skipped, not taken as the end of the list (a full pass would otherwise
    delete everything listed after it)."""
    fake = FakeFireflies(
        [
            meeting("N1", "New", "2026-10-15T10:00:00Z"),
            meeting("OLD", "Old", "2026-09-01T10:00:00Z"),
            meeting("N2", "Newer", "2026-10-12T10:00:00Z"),
            meeting("N3", "Newest", "2026-10-11T10:00:00Z"),
        ],
        unsorted=True,
    )
    fake._list = lambda v: [dict(m) for m in fake.meetings][v["skip"] : v["skip"] + v["limit"]]
    config = {"mode": "all", "date_from": "2026-10-01"}
    events = await collect(connector(fake), config, known=known("N3"))
    assert deleted(events) == []
    assert upserted(events) == ["N2", "N1"]


async def test_a_transcript_fireflies_has_not_finished_is_asked_for_again():
    """The list shows a meeting whose transcript query answers null (still processing):
    the position stays before it, so the next sync fetches it."""
    fake = FakeFireflies(list(SAMPLE), processing={"S2": 1})
    conn = connector(fake)
    config = {"mode": "selected", "series": [STANDUP]}
    first = await collect(conn, config)
    assert upserted(first) == ["S1", "S3"]
    cursor = next(e for e in reversed(first) if isinstance(e, CursorCheckpoint)).cursor
    assert cursor["missing"] == {"S2": 1}
    assert cursor["since"] < "2026-10-05T09:00:00Z"

    second = await collect(conn, config, cursor)
    assert upserted(second) == ["S2"]
    cursor = next(e for e in reversed(second) if isinstance(e, CursorCheckpoint)).cursor
    assert "missing" not in cursor
    assert upserted(await collect(conn, config, cursor)) == []


async def test_a_transcript_that_never_comes_is_skipped_after_a_few_syncs():
    fake = FakeFireflies(list(SAMPLE), processing={"S2": 100})
    conn = connector(fake)
    config = {"mode": "selected", "series": [STANDUP]}
    cursor = None
    for _ in range(fireflies.MISSING_TRIES):
        events = await collect(conn, config, cursor)
        cursor = next(e for e in reversed(events) if isinstance(e, CursorCheckpoint)).cursor
    assert "missing" not in cursor
    # The position moved on to the newest meeting listed.
    assert cursor["listed"] == "2026-10-14T14:00:00Z"
    fake.requests.clear()
    await collect(conn, config, cursor)
    assert "S2" not in fake.detail_ids()


async def test_a_meeting_dated_in_the_future_does_not_move_the_position_past_now():
    later = datetime.now(UTC) + timedelta(days=400)
    fake = FakeFireflies([*SAMPLE, meeting("F1", "Future", _iso(later))])
    events = await collect(connector(fake), {"mode": "selected", "meetings": ["K1"]})
    cursor = next(e for e in reversed(events) if isinstance(e, CursorCheckpoint)).cursor
    assert cursor["listed"] <= _iso(datetime.now(UTC))
    # A cursor saved in the future (before this fix) is read as now.
    fake.requests.clear()
    await collect(connector(fake), {"mode": "all"}, {"since": _iso(later), "recent": {}})
    assert fake.list_variables()[0]["fromDate"] < _iso(datetime.now(UTC))


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
