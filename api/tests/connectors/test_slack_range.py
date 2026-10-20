"""Slack date range (S5, owner 2026-10-19): ``{"since"?, "until"?}`` (YYYY-MM-DD, UTC).

Messages posted from ``since`` through the end of ``until`` are read. ``until`` clips
everything posted after it, thread replies included (owner, 2026-10-20): a thread started
inside the range holds only its replies inside the range. Once the range is behind the
newest message, later syncs only re-check the threads inside it, and never fetch past it.
"""

from datetime import UTC, datetime

import httpx
import pytest

from oracle.sources.base import ConnectorConfigError, CursorCheckpoint, ItemUpsert, Scope
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


async def test_replies_after_until_are_clipped_from_a_thread_started_inside_it():
    world = SlackWorld()
    parent_ts, reply_ts = with_thread(world)
    inside = ts("2025-10-05", 18)
    world.replies[parent_ts].insert(
        1, {"ts": inside, "user": "U0ADA", "text": "inside the range", "thread_ts": parent_ts}
    )
    config = {"channels": ["C0PRODUCT"], "until": "2025-10-05"}
    events = await collect(connector(world), config)
    thread = next(u for u in upserts(events) if u.kind == "thread")
    assert thread.external_id == f"C0PRODUCT:{parent_ts}"
    assert "inside the range" in thread.content
    assert "after the range" not in thread.content
    assert thread.source_updated_at.timestamp() == float(inside)
    # Slack is asked for nothing after the range either.
    (call,) = [p for m, p in world.calls if m == "conversations.replies"]
    assert float(call["latest"]) == END


async def test_later_syncs_never_fetch_past_until():
    world = SlackWorld()
    parent_ts, _ = with_thread(world)
    config = {"channels": ["C0PRODUCT"], "until": "2025-10-05"}
    first = await collect(connector(world), config)
    cursor = first[-1].cursor
    assert cursor["channels"]["C0PRODUCT"]["oldest"] == parent_ts

    # Later: a new message after the range, and a new reply in the thread inside it,
    # both after ``until``: neither is read.
    world.channels["C0PRODUCT"].append({"ts": ts("2025-10-20"), "user": "U0ADA", "text": "new"})
    late = ts("2025-10-21")
    world.channels["C0PRODUCT"][1]["latest_reply"] = late
    world.replies[parent_ts].append({"ts": late, "user": "U0ADA", "text": "later still"})
    world.calls.clear()
    world.ignore_bounds = True
    again = await collect(connector(world), config, cursor)

    (call,) = history_calls(world)
    assert float(call["latest"]) == END
    assert upserts(again) == []
    assert [m for m, _ in world.calls if m == "conversations.replies"] == []
    # The cursor stays inside the range.
    assert again[-1].cursor["channels"]["C0PRODUCT"]["oldest"] == parent_ts
    assert isinstance(again[-1], CursorCheckpoint)


async def test_a_reply_inside_the_range_still_updates_its_thread():
    world = SlackWorld()
    parent_ts, _ = with_thread(world)  # replied to on 2025-10-08 at 12:00
    config = {"channels": ["C0PRODUCT"], "until": "2025-10-08"}
    first = await collect(connector(world), config)
    later = ts("2025-10-08", 13)
    world.channels["C0PRODUCT"][1]["latest_reply"] = later
    world.replies[parent_ts].append(
        {"ts": later, "user": "U0ADA", "text": "late but inside", "thread_ts": parent_ts}
    )
    again = await collect(connector(world), config, first[-1].cursor)
    (thread,) = upserts(again)
    assert "late but inside" in thread.content


def test_scope_follows_the_range():
    config = {"channels": ["C0PRODUCT"], "since": "2025-10-02", "until": "2025-10-05"}
    assert SlackConnector().scope(config) == Scope(
        groups=frozenset({"C0PRODUCT"}),
        occurred_from=datetime(2025, 10, 2, tzinfo=UTC),
        occurred_before=datetime(2025, 10, 6, tzinfo=UTC),
    )
