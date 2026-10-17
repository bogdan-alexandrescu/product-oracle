from datetime import UTC, datetime

import pytest

from oracle.sources import base
from oracle.sources.base import (
    Connector,
    ConnectorConfigError,
    ConnectorRateLimited,
    CursorCheckpoint,
    ItemDelete,
    ItemUpsert,
    get_connector,
    register,
)


class FakeConnector:
    kind = "fake"

    async def validate(self, config, credential):
        if not config.get("channels"):
            raise ConnectorConfigError("allowlist at least one channel")

    async def sync(self, config, credential, cursor):
        start = (cursor or {}).get("n", 0)
        for n in range(start, start + 2):
            yield ItemUpsert(
                external_id=f"m{n}",
                kind="message",
                title=None,
                url=f"https://chat.example.com/m{n}",
                author="someone",
                content=f"message {n}",
                acl={"channel": "C1"},
                occurred_at=datetime(2026, 1, 1, tzinfo=UTC),
            )
        yield ItemDelete(external_id="old")
        yield CursorCheckpoint({"n": start + 2})


@pytest.fixture
def registry(monkeypatch):
    monkeypatch.setattr(base, "_registry", {})


async def test_protocol_register_and_sync(registry):
    connector = register(FakeConnector())
    assert isinstance(connector, Connector)
    assert get_connector("fake") is connector
    assert register(connector) is connector  # idempotent for the same object
    with pytest.raises(ValueError):
        register(FakeConnector())
    with pytest.raises(LookupError):
        get_connector("missing")

    with pytest.raises(ConnectorConfigError):
        await connector.validate({}, None)
    events = [e async for e in connector.sync({"channels": ["C1"]}, None, {"n": 3})]
    assert [type(e).__name__ for e in events] == [
        "ItemUpsert",
        "ItemUpsert",
        "ItemDelete",
        "CursorCheckpoint",
    ]
    assert events[-1].cursor == {"n": 5}


def test_item_kind_is_checked():
    with pytest.raises(ValueError):
        ItemUpsert(external_id="x", kind="dm", title=None, url=None, author=None, content="hi")


def test_rate_limit_carries_retry_after():
    assert ConnectorRateLimited(retry_after=30).retry_after == 30
