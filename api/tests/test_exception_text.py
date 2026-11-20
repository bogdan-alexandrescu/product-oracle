"""An httpx timeout's ``str()`` is empty: a reason built from it names its type instead."""

import httpx
import pytest

from oracle.cli.oracle_cli import CliError, _send
from oracle.connections.providers import ProviderUnavailable, _get
from oracle.errors import exception_text
from oracle.llm.transports import LlmRequest, LlmUnavailable, MessagesApiTransport


def _timeout(request: httpx.Request) -> httpx.Response:
    raise httpx.ReadTimeout("", request=request)


def test_exception_text_keeps_a_message():
    """A reason built from an error keeps the error's own message when it has one."""
    assert exception_text(ValueError("the name is taken")) == "the name is taken"


def test_exception_text_names_the_type_of_a_blank_message():
    """An error with a blank message is instead named by its error type."""
    assert exception_text(httpx.ReadTimeout("")) == "ReadTimeout"
    assert exception_text(TimeoutError()) == "TimeoutError"
    assert exception_text(RuntimeError("   ")) == "RuntimeError"


async def test_claude_api_timeout_reason_names_the_timeout():
    """A timed-out LLM API call reports a reason naming the timeout, not blank."""
    http = httpx.AsyncClient(transport=httpx.MockTransport(_timeout))
    request = LlmRequest(system="s", messages=[], max_tokens=1, model="m")
    with pytest.raises(LlmUnavailable) as raised:
        await MessagesApiTransport(http=http).complete("key", request)
    assert str(raised.value).endswith(": ReadTimeout")


async def test_provider_timeout_reason_names_the_timeout():
    """A timed-out provider call reports a reason naming the host and the timeout."""
    async with httpx.AsyncClient(transport=httpx.MockTransport(_timeout)) as http:
        with pytest.raises(ProviderUnavailable) as raised:
            await _get(http, "GET", "https://api.example.com/x")
    assert str(raised.value) == "cannot reach api.example.com: ReadTimeout"


def test_cli_timeout_reason_names_the_timeout():
    """A timed-out CLI call reports a reason naming the timeout, not an empty message."""
    client = httpx.Client(
        base_url="https://oracle.example.com", transport=httpx.MockTransport(_timeout)
    )
    with pytest.raises(CliError) as raised:
        _send(client, "GET", "/x")
    assert str(raised.value).endswith(": ReadTimeout")
