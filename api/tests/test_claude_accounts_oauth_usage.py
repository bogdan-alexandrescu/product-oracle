"""Sign-in, token exchange and usage polling against httpx.MockTransport, mirroring
SwarmCloud's test_account_signin.py, test_usage_endpoint.py and test_usage_poller.py."""

import json
from datetime import UTC, datetime, timedelta
from urllib.parse import parse_qs, parse_qsl, urlsplit

import httpx
import pytest

from oracle.claude_accounts import usage
from oracle.claude_accounts.accounts import Account, WindowReading
from oracle.claude_accounts.oauth import (
    CLAUDE_CODE_CLIENT_ID,
    CLIENT_USER_AGENT,
    OAUTH_REDIRECT_URI,
    OAUTH_SCOPES,
    TOKEN_ENDPOINT,
    CredentialError,
    HttpTokenEndpoint,
    ReauthRequired,
    build_authorize_url,
    challenge_for,
    credential_from_token_response,
    new_state,
    new_verifier,
    parse_credential,
    split_pasted_code,
)

NOW = datetime(2026, 10, 18, 12, 0, tzinfo=UTC)


def test_the_authorize_url_is_claude_codes_in_its_order():
    state, verifier = new_state(), new_verifier()
    assert len(state) >= 43  # 32 random bytes
    url = build_authorize_url(state=state, code_challenge=challenge_for(verifier))
    parts = urlsplit(url)
    assert (
        f"{parts.scheme}://{parts.netloc}{parts.path}" == "https://claude.com/cai/oauth/authorize"
    )
    params = parse_qsl(parts.query)
    assert [k for k, _ in params] == [
        "code", "client_id", "response_type", "redirect_uri", "scope", "code_challenge",
        "code_challenge_method", "state",
    ]  # fmt: skip
    q = dict(params)
    assert q["client_id"] == CLAUDE_CODE_CLIENT_ID
    assert q["redirect_uri"] == OAUTH_REDIRECT_URI
    assert q["scope"] == " ".join(OAUTH_SCOPES)
    assert q["code_challenge_method"] == "S256"
    assert q["state"] == state
    with pytest.raises(CredentialError, match="32 random bytes"):
        build_authorize_url(state="x" * 22, code_challenge="c")


def test_the_pasted_code_may_carry_its_state():
    assert split_pasted_code("  abc#def ") == ("abc", "def")
    assert split_pasted_code("abc") == ("abc", None)
    assert split_pasted_code("abc#") == ("abc", None)


def test_claude_codes_saved_login_is_read_verbatim_and_must_be_a_pair():
    ms = int((NOW + timedelta(hours=5)).timestamp() * 1000)
    wrapped = json.dumps(
        {"claudeAiOauth": {"accessToken": "a", "refreshToken": "r", "expiresAt": ms}}
    )
    cred = parse_credential(wrapped, now=NOW)
    assert (cred.access_token, cred.refresh_token) == ("a", "r")
    assert cred.expires_at == NOW + timedelta(hours=5)
    snake = parse_credential(
        json.dumps({"access_token": "a", "refresh_token": "r", "expires_in": 60}), now=NOW
    )
    assert snake.expires_at == NOW + timedelta(seconds=60)
    with pytest.raises(CredentialError, match="no refresh token"):
        parse_credential(json.dumps({"accessToken": "a"}))
    with pytest.raises(CredentialError, match="not JSON"):
        parse_credential("-".join(("not", "json", "at", "all")))
    # No expiry at all is treated as due now.
    assert parse_credential(json.dumps({"refreshToken": "r"}), now=NOW).expires_at == NOW


async def test_redeeming_a_code_is_json_with_the_state_and_claude_codes_headers():
    seen: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        return httpx.Response(
            200, json={"access_token": "a", "refresh_token": "r", "expires_in": 60}
        )

    endpoint = HttpTokenEndpoint(transport=httpx.MockTransport(handler))
    out = await endpoint.redeem(
        code="c0de", verifier="v", redirect_uri=OAUTH_REDIRECT_URI, state="s"
    )
    assert out["refresh_token"] == "r"
    request = seen[0]
    assert str(request.url) == TOKEN_ENDPOINT
    assert request.headers["content-type"] == "application/json"
    assert request.headers["accept"] == "application/json"
    assert request.headers["user-agent"] == CLIENT_USER_AGENT
    assert json.loads(request.content) == {
        "grant_type": "authorization_code",
        "code": "c0de",
        "client_id": CLAUDE_CODE_CLIENT_ID,
        "redirect_uri": OAUTH_REDIRECT_URI,
        "code_verifier": "v",
        "state": "s",
    }

    refused = HttpTokenEndpoint(transport=httpx.MockTransport(lambda r: httpx.Response(400)))
    with pytest.raises(CredentialError, match="single-use"):
        await refused.redeem(code="c", verifier="v", redirect_uri=OAUTH_REDIRECT_URI)


async def test_a_refresh_is_form_encoded_and_invalid_grant_is_terminal():
    seen: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        token = parse_qs(request.content.decode())["refresh_token"][0]
        if token == "dead":
            return httpx.Response(400, json={"error": "invalid_grant"})
        if token == "flaky":
            return httpx.Response(503)
        return httpx.Response(200, json={"access_token": "a2", "refresh_token": "r2"})

    endpoint = HttpTokenEndpoint(transport=httpx.MockTransport(handler))
    assert (await endpoint.exchange("r1"))["access_token"] == "a2"
    request = seen[0]
    assert request.headers["content-type"] == "application/x-www-form-urlencoded"
    assert request.headers["user-agent"] == CLIENT_USER_AGENT
    assert parse_qs(request.content.decode()) == {
        "grant_type": ["refresh_token"],
        "refresh_token": ["r1"],
        "client_id": [CLAUDE_CODE_CLIENT_ID],
    }
    with pytest.raises(ReauthRequired):
        await endpoint.exchange("dead")
    with pytest.raises(CredentialError) as info:
        await endpoint.exchange("flaky")
    assert not isinstance(info.value, ReauthRequired)


def test_a_redeemed_code_without_a_refresh_token_saves_nothing():
    with pytest.raises(CredentialError, match="Nothing was saved"):
        credential_from_token_response({"access_token": "a"})
    cred = credential_from_token_response(
        {"access_token": "a", "refresh_token": "r", "expires_in": 100}, now=NOW
    )
    assert cred.expires_at == NOW + timedelta(seconds=100)


# --- usage ------------------------------------------------------------------------

REAL_SHAPE = {
    "five_hour": {"utilization": 34.0, "resets_at": "2026-10-18T15:00:00+00:00"},
    "seven_day": {"utilization": 129.0, "resets_at": "2026-10-21T09:00:00+00:00"},
    "seven_day_opus": None,
    "nimbus_quill": {"utilization": 3, "resets_at": "2026-10-19T00:00:00+00:00"},
    "broken": {"utilization": True, "resets_at": "2026-10-19T00:00:00+00:00"},
    "no_reset": {"utilization": 5},
}


def test_usage_is_converted_from_percent_and_clamped_and_unknown_windows_kept():
    windows = usage.parse(REAL_SHAPE)
    assert set(windows) == {"five_hour", "seven_day", "nimbus_quill"}
    assert windows["five_hour"].utilization == pytest.approx(0.34)
    assert windows["seven_day"].utilization == 1.0
    assert windows["five_hour"].resets_at == datetime(2026, 10, 18, 15, tzinfo=UTC)


async def test_the_usage_call_presents_the_cli_and_a_429_is_a_rate_limit():
    seen: list[httpx.Request] = []

    def ok(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        return httpx.Response(200, json=REAL_SHAPE)

    windows = await usage.fetch("tok", transport=httpx.MockTransport(ok))
    assert "five_hour" in windows
    headers = seen[0].headers
    assert str(seen[0].url) == usage.ENDPOINT
    assert headers["authorization"] == "Bearer tok"
    assert headers["anthropic-beta"] == usage.BETA_HEADER
    assert headers["user-agent"] == usage.USER_AGENT

    limited = httpx.MockTransport(lambda r: httpx.Response(429, headers={"retry-after": "299"}))
    with pytest.raises(usage.RateLimited) as info:
        await usage.fetch("tok", transport=limited)
    assert info.value.retry_after_seconds == 299
    empty = httpx.MockTransport(lambda r: httpx.Response(200, json={"seven_day_opus": None}))
    with pytest.raises(usage.UsageUnavailable, match="shape"):
        await usage.fetch("tok", transport=empty)
    with pytest.raises(usage.UsageUnavailable):
        await usage.fetch("")


def _acct(label: str, observed: datetime | None) -> Account:
    windows = {"five_hour": WindowReading(0.1, NOW + timedelta(hours=1))} if observed else {}
    return Account(account_id=label, label=label, windows=windows, observed_at=observed)


class Poll:
    def __init__(self, answers: dict[str, object]):
        self.answers = answers
        self.fetched: list[str] = []
        self.recorded: list[str] = []

    async def read_token(self, account: Account) -> str:
        if self.answers.get(account.account_id) == "unreadable":
            raise KeyError(account.account_id)
        return account.account_id

    async def fetch(self, token: str):
        self.fetched.append(token)
        answer = self.answers.get(token)
        if isinstance(answer, Exception):
            raise answer
        return {"five_hour": WindowReading(0.5, NOW + timedelta(hours=1))}

    async def record(self, account: Account, windows) -> None:
        self.recorded.append(account.account_id)

    async def round(self, accounts, **kw):
        return await usage.poll_round(
            accounts, read_token=self.read_token, record=self.record, fetch_windows=self.fetch, **kw
        )


async def test_the_never_read_account_and_then_the_oldest_are_polled_first():
    p = Poll({})
    accounts = [
        _acct("fresh", NOW),
        _acct("old", NOW - timedelta(hours=2)),
        _acct("never", None),
        _acct("older", NOW - timedelta(hours=3)),
    ]
    await p.round(accounts, max_polls=3)
    assert p.fetched == ["never", "older", "old"]


async def test_the_budget_is_a_hard_cap_and_a_rate_limit_ends_the_round():
    p = Poll({"b": usage.RateLimited(299)})
    accounts = [_acct(x, NOW - timedelta(hours=10 - i)) for i, x in enumerate("abcde")]
    out = await p.round(accounts, max_polls=5)
    assert p.fetched == ["a", "b"]
    assert [(o.account_id, o.reason) for o in out] == [("a", "ok"), ("b", "rate_limited")]
    assert p.recorded == ["a"]
    assert usage.DEFAULT_MAX_POLLS_PER_SWEEP == 3


async def test_a_failed_poll_records_nothing_and_an_unreadable_token_is_skipped():
    p = Poll({"a": usage.UsageUnavailable("HTTP 500"), "b": "unreadable"})
    out = await p.round([_acct("a", None), _acct("b", NOW), _acct("c", NOW)], max_polls=3)
    assert [o.reason for o in out] == ["unavailable", "token_unreadable", "ok"]
    assert p.recorded == ["c"]
    assert await p.round([], max_polls=3) == []
    assert await p.round([_acct("a", None)], max_polls=0) == []
