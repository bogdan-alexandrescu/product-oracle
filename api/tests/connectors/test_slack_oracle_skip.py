"""G8 Slack bridge: a person's Slack source never ingests Oracle's own posts.

protects=criterion 10 (card: echo and laundering): syncing a channel that holds a mirrored
thread skips the messages whose ``user`` (or ``bot_profile.user_id``) is Oracle's app user;
fails_when=Oracle's posts become source evidence; no_claim=other apps' bots.
"""

import httpx
import pytest

from oracle.sources.base import ORACLE_SLACK_USERS, ItemUpsert
from oracle.sources.connectors.slack import SlackConnector
from tests.slack_world import SlackWorld, ts

CREDENTIAL = {"token": "xoxp-test-token"}
BOT = "U0ORACLEBOT"


# Connectors do no database work.
@pytest.fixture(scope="session")
def migrated_db():
    return None


def world_with_a_mirror() -> SlackWorld:
    world = SlackWorld()
    root, reply = ts("2025-10-06"), ts("2025-10-06", 13)
    person, oracle_reply = ts("2025-10-07"), ts("2025-10-07", 14)
    world.channels["C0PRODUCT"] += [
        {"ts": root, "user": BOT, "bot_id": "B0ORACLE", "text": "*Caps* Open in Oracle",
         "thread_ts": root, "reply_count": 1, "latest_reply": reply},
        {"ts": person, "user": "U0ADA", "text": "a person's thread", "thread_ts": person,
         "reply_count": 1, "latest_reply": oracle_reply},
    ]  # fmt: skip
    world.replies[root] = [
        {"ts": root, "user": BOT, "bot_id": "B0ORACLE", "text": "*Caps* Open in Oracle"},
        {"ts": reply, "user": BOT, "bot_id": "B0ORACLE", "text": "*Oracle*: one sprint"},
    ]
    world.replies[person] = [
        {"ts": person, "user": "U0ADA", "text": "a person's thread"},
        {"ts": oracle_reply, "user": "U0OTHER", "bot_id": "B0ORACLE",
         "bot_profile": {"user_id": BOT}, "text": "*Oracle*: posted by the app"},
    ]  # fmt: skip
    return world


async def test_oracles_own_posts_are_never_ingested():
    world = world_with_a_mirror()
    conn = SlackConnector(httpx.AsyncClient(transport=httpx.MockTransport(world)))
    config = {"channels": ["C0PRODUCT"], ORACLE_SLACK_USERS: [BOT]}
    items = [e async for e in conn.sync(config, CREDENTIAL, None) if isinstance(e, ItemUpsert)]
    text = "\n".join(i.content for i in items)
    assert "Open in Oracle" not in text and "*Oracle*" not in text
    assert "a person's thread" in text and "kick-off" in text
    # Without the app user (no install), the same channel reads as before.
    plain = {"channels": ["C0PRODUCT"]}
    items = [e async for e in conn.sync(plain, CREDENTIAL, None) if isinstance(e, ItemUpsert)]
    assert any("Open in Oracle" in i.content for i in items)
