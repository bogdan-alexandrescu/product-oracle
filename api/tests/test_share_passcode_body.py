"""#1574: the share passcode form's body. A body that does not parse is an empty passcode
(the wrong-passcode answer) with a log line saying why; anything else is not swallowed."""

import json

import pytest
from starlette.requests import Request

from oracle.shares import public


def _request(body: bytes, kind: str, fail: Exception | None = None) -> Request:
    sent = False

    async def receive():
        nonlocal sent
        if fail is not None:
            raise fail
        if sent:
            return {"type": "http.disconnect"}
        sent = True
        return {"type": "http.request", "body": body, "more_body": False}

    scope = {
        "type": "http",
        "method": "POST",
        "path": "/s/x",
        "headers": [(b"content-type", kind.encode())],
        "query_string": b"",
    }
    return Request(scope, receive)


async def test_a_body_that_parses_gives_its_passcode():
    body = json.dumps({"passcode": "blue-otter-42"}).encode()
    assert await public._passcode_of(_request(body, "application/json")) == "blue-otter-42"


async def test_a_body_that_does_not_parse_is_empty_and_logged(caplog):
    with caplog.at_level("INFO", logger="oracle.shares.public"):
        got = await public._passcode_of(_request(b"{not json", "application/json"))
    assert got == ""
    assert any("passcode" in r.getMessage() for r in caplog.records)


async def test_an_unexpected_failure_is_not_swallowed():
    with pytest.raises(RuntimeError):
        await public._passcode_of(
            _request(b"", "application/json", fail=RuntimeError("receive broke"))
        )
