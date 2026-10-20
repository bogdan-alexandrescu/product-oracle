"""Slack date range (S5, owner 2026-10-19): ``{"since"?, "until"?}`` (YYYY-MM-DD, UTC).

Messages posted from ``since`` through the end of ``until`` are read; replies posted
after ``until`` in a thread started inside the range are kept. Once the range is behind
the newest message, later syncs only re-check the threads inside it.
"""

from datetime import UTC, datetime

import httpx
import pytest

from oracle.sources.base import ConnectorConfigError, CursorCheckpoint, ItemUpsert, StoredItem
from oracle.sources.connectors.slack import SlackConnector
from tests.slack_world import SlackWorld, ts

CREDENTIAL = {"token": "xoxp-test-token"}
# The day after ``until`` 2025-10-05, where the range ends (exclusive).
END = datetime(2025, 10, 6, tzinfo=UTC).timestamp()


def connector(world: SlackWorld) -> SlackConnector:
    return SlackConnector(httpx.AsyncClient(transport=httpx.MockTransport(world)))


async def collect(conn, config, cursor=None):
    return [e async for e in conn.sync(config, CREDENTIAL, cursor)]


def upserts(events) -> list[ItemUpsert]:
    return [e for e in events if isinstance(e, ItemUpsert)]


def history_calls(world: SlackWorld) -> list[dict[str, str]]:
    return [p for m, p in world.calls if m == "conversations.history"]


def with_thread(world: SlackWorld) -> tuple[str, str]:
    """Make the 2025-10-05 message a thread whose reply came on 2025-10-08."""
    parent = world.channels["C0PRODUCT"][1]
    reply_ts = ts("2025-10-08")
    parent.update(reply_count=1, latest_reply=reply_ts, thread_ts=parent["ts"])
    world.replies[parent["ts"]] = [
        parent,
        {"ts": reply_ts, "user": "U0ADA", "text": "after the range", "thread_ts": parent["ts"]},
    ]
    return parent["ts"], reply_ts


@pytest.mark.parametrize(
    ("config", "match"),
    [
        ({"until": "2025-10-01", "since": "2025-10-02"}, "until must be on or after since"),
        ({"until": "05/10/2025"}, "until must be a date"),
        ({"until": 20251005}, "until must be a date"),
    ],
)
async def test_validate_refuses_a_bad_until(config, match):
    world = SlackWorld()
    with pytest.raises(ConnectorConfigError, match=match):
        await connector(world).validate({"channels": ["C0PRODUCT"], **config}, CREDENTIAL)
    assert world.calls == []


async def test_validate_accepts_a_range_of_one_day():
    config = {"channels": ["C0PRODUCT"], "since": "2025-10-05", "until": "2025-10-05"}
    await connector(SlackWorld()).validate(config, CREDENTIAL)


async def test_first_sync_reads_up_to_the_end_of_until():
    world = SlackWorld()
    world.ignore_bounds = True  # the connector's own filter must hold too
    config = {"channels": ["C0PRODUCT"], "since": "2025-10-02", "until": "2025-10-05"}
    events = await collect(connector(world), config)
    (call,) = history_calls(world)
    assert float(call["latest"]) == END
    assert float(call["oldest"]) == datetime(2025, 10, 2, tzinfo=UTC).timestamp()
    assert [u.external_id for u in upserts(events)] == [f"C0PRODUCT:{ts('2025-10-05')}"]
    assert events[-1].cursor["channels"]["C0PRODUCT"]["oldest"] == ts("2025-10-05")


async def test_until_alone_keeps_everything_before_it():
    world = SlackWorld()
    events = await collect(connector(world), {"channels": ["C0PRODUCT"], "until": "2025-10-05"})
    (call,) = history_calls(world)
    assert "oldest" not in call and float(call["latest"]) == END
    assert [u.occurred_at.day for u in upserts(events)] == [1, 5]


async def test_replies_after_until_in_a_thread_started_inside_it_are_kept():
    world = SlackWorld()
    parent_ts, reply_ts = with_thread(world)
    config = {"channels": ["C0PRODUCT"], "until": "2025-10-05"}
    events = await collect(connector(world), config)
    thread = next(u for u in upserts(events) if u.kind == "thread")
    assert thread.external_id == f"C0PRODUCT:{parent_ts}"
    assert "after the range" in thread.content
    assert thread.source_updated_at.timestamp() == float(reply_ts)


async def test_later_syncs_only_recheck_threads_in_the_range():
    world = SlackWorld()
    parent_ts, _ = with_thread(world)
    config = {"channels": ["C0PRODUCT"], "until": "2025-10-05"}
    first = await collect(connector(world), config)
    cursor = first[-1].cursor
    assert cursor["channels"]["C0PRODUCT"]["oldest"] == parent_ts

    # Later: a new message after the range, and a new reply in the thread inside it.
    world.channels["C0PRODUCT"].append({"ts": ts("2025-10-20"), "user": "U0ADA", "text": "new"})
    late = ts("2025-10-21")
    world.channels["C0PRODUCT"][1]["latest_reply"] = late
    world.replies[parent_ts].append({"ts": late, "user": "U0ADA", "text": "later still"})
    world.calls.clear()
    world.ignore_bounds = True
    again = await collect(connector(world), config, cursor)

    (call,) = history_calls(world)
    assert float(call["latest"]) == END
    assert [u.external_id for u in upserts(again)] == [f"C0PRODUCT:{parent_ts}"]
    assert "later still" in upserts(again)[0].content
    # The cursor stays inside the range.
    assert again[-1].cursor["channels"]["C0PRODUCT"]["oldest"] == parent_ts

    # Nothing new: the thread is re-checked, nothing is fetched or written.
    world.calls.clear()
    third = await collect(connector(world), config, again[-1].cursor)
    assert upserts(third) == []
    assert [m for m, _ in world.calls if m == "conversations.replies"] == []
    assert isinstance(third[-1], CursorCheckpoint)


def test_in_scope_follows_the_range():
    conn = SlackConnector()
    config = {"channels": ["C0PRODUCT"], "since": "2025-10-02", "until": "2025-10-05"}

    def item(day: str, hour: int = 12) -> StoredItem:
        stamp = ts(day, hour)
        return StoredItem(
            external_id=f"C0PRODUCT:{stamp}",
            kind="message",
            occurred_at=datetime.fromtimestamp(float(stamp), UTC),
        )

    assert not conn.in_scope(config, item("2025-10-01"))
    assert conn.in_scope(config, item("2025-10-02", 0))
    assert conn.in_scope(config, item("2025-10-05", 23))
    assert not conn.in_scope(config, item("2025-10-06", 0))
