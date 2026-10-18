"""Token validation and identity per provider, against httpx.MockTransport."""

import httpx
import pytest

from oracle.connections.providers import (
    API_KEY_PREFIX,
    PLAN_TOKEN_PREFIX,
    PROVIDERS,
    CredentialRejected,
    ProviderUnavailable,
    claude_token_kind,
)
from oracle.llm import gateway
from oracle.llm.transports import LlmAuthError, LlmUnavailable, TransportResult
from oracle.sources.models import SOURCE_KINDS


def http(handler) -> httpx.AsyncClient:
    return httpx.AsyncClient(transport=httpx.MockTransport(handler))


def bearer(request: httpx.Request) -> str:
    return request.headers.get("Authorization", "")


def test_registry_covers_every_provider_and_valid_source_kinds():
    assert set(PROVIDERS) == {"github", "slack", "notion", "fireflies", "google", "claude"}
    for p in PROVIDERS.values():
        assert set(p.source_kinds) <= set(SOURCE_KINDS)
        assert p.token_help
    assert PROVIDERS["google"].source_kinds == ("google_docs",)
    assert PROVIDERS["claude"].source_kinds == ()
    # OAuth where the provider has it; Fireflies and Claude are token-only.
    assert {k for k, p in PROVIDERS.items() if p.oauth} == {"github", "slack", "notion", "google"}
    assert all("im:history" not in s for s in PROVIDERS["slack"].oauth.scopes)


async def test_github():
    def handler(request):
        assert request.url == "https://api.github.com/user"
        if bearer(request) != "Bearer good":
            return httpx.Response(401, json={"message": "Bad credentials"})
        return httpx.Response(
            200,
            json={"id": 42, "login": "example-user"},
            headers={"X-OAuth-Scopes": "repo, read:user"},
        )

    async with http(handler) as c:
        identity = await PROVIDERS["github"].identify(c, "good")
        assert (identity.account_id, identity.label) == ("42", "example-user")
        assert identity.scopes == ["repo", "read:user"]
        with pytest.raises(CredentialRejected):
            await PROVIDERS["github"].identify(c, "bad")


async def test_slack_auth_test():
    def handler(request):
        assert request.method == "POST" and request.url.path == "/api/auth.test"
        if bearer(request) == "Bearer good":
            body = {"ok": True, "team_id": "T1", "user_id": "U1", "team": "Example", "user": "pat"}
            return httpx.Response(200, json=body, headers={"x-oauth-scopes": "channels:read"})
        if bearer(request) == "Bearer revoked":
            return httpx.Response(200, json={"ok": False, "error": "token_revoked"})
        return httpx.Response(200, json={"ok": False, "error": "ratelimited"})

    async with http(handler) as c:
        identity = await PROVIDERS["slack"].identify(c, "good")
        assert identity.account_id == "T1:U1"
        assert identity.label == "pat @ Example"
        assert identity.scopes == ["channels:read"]
        with pytest.raises(CredentialRejected):
            await PROVIDERS["slack"].identify(c, "revoked")
        with pytest.raises(ProviderUnavailable):
            await PROVIDERS["slack"].identify(c, "other")


async def test_notion_users_me():
    def handler(request):
        assert request.url == "https://api.notion.com/v1/users/me"
        assert request.headers["Notion-Version"]
        if bearer(request) != "Bearer good":
            return httpx.Response(401, json={"code": "unauthorized"})
        bot = {"workspace_name": "Example"}
        body = {"id": "bot-1", "name": "Oracle", "type": "bot", "bot": bot}
        return httpx.Response(200, json=body)

    async with http(handler) as c:
        identity = await PROVIDERS["notion"].identify(c, "good")
        assert (identity.account_id, identity.label) == ("bot-1", "Example")
        with pytest.raises(CredentialRejected):
            await PROVIDERS["notion"].identify(c, "bad")


async def test_fireflies_graphql_user():
    def handler(request):
        assert request.url == "https://api.fireflies.ai/graphql"
        assert b"user" in request.content
        if bearer(request) == "Bearer good":
            user = {"user_id": "ff-1", "email": "pat@example.com", "name": "Pat"}
            return httpx.Response(200, json={"data": {"user": user}})
        error = {"message": "Invalid API key", "extensions": {"code": "invalid_api_key"}}
        return httpx.Response(200, json={"data": None, "errors": [error]})

    async with http(handler) as c:
        identity = await PROVIDERS["fireflies"].identify(c, "good")
        assert (identity.account_id, identity.label) == ("ff-1", "pat@example.com")
        with pytest.raises(CredentialRejected):
            await PROVIDERS["fireflies"].identify(c, "bad")


async def test_google_userinfo():
    def handler(request):
        assert request.url.path == "/v1/userinfo"
        if bearer(request) != "Bearer good":
            return httpx.Response(401)
        return httpx.Response(200, json={"sub": "g-1", "email": "pat@example.com"})

    async with http(handler) as c:
        identity = await PROVIDERS["google"].identify(c, "good")
        assert (identity.account_id, identity.label) == ("g-1", "pat@example.com")
        with pytest.raises(CredentialRejected):
            await PROVIDERS["google"].identify(c, "bad")


async def test_provider_down_is_unavailable_not_rejected():
    def handler(request):
        raise httpx.ConnectError("down")

    async with http(handler) as c:
        with pytest.raises(ProviderUnavailable):
            await PROVIDERS["github"].identify(c, "tok")

    async with http(lambda r: httpx.Response(503)) as c:
        with pytest.raises(ProviderUnavailable):
            await PROVIDERS["google"].identify(c, "tok")


def test_claude_token_kinds():
    assert claude_token_kind(PLAN_TOKEN_PREFIX + "01-abc") == "plan"
    assert claude_token_kind(API_KEY_PREFIX + "03-abc") == "api_key"
    with pytest.raises(CredentialRejected):
        claude_token_kind("not-a-claude-token")


async def test_claude_api_key_checked_with_models_endpoint():
    def handler(request):
        assert request.url.path == "/v1/models"
        assert request.headers["anthropic-version"]
        if request.headers.get("x-api-key") == API_KEY_PREFIX + "03-good-1234":
            return httpx.Response(200, json={"data": []})
        return httpx.Response(401, json={"type": "error"})

    async with http(handler) as c:
        identity = await PROVIDERS["claude"].identify(c, API_KEY_PREFIX + "03-good-1234")
        assert identity.account_id == "api_key"
        assert identity.label == "Anthropic API key …1234"
        assert identity.extra["kind"] == "api_key"
        with pytest.raises(CredentialRejected):
            await PROVIDERS["claude"].identify(c, API_KEY_PREFIX + "03-bad")


class FakePlan:
    def __init__(self, outcome=None):
        self.outcome = outcome
        self.calls: list[tuple[str, object]] = []

    async def complete(self, token, request):
        self.calls.append((token, request))
        if self.outcome:
            raise self.outcome
        return TransportResult(text="OK", model=request.model)


async def test_claude_plan_token_checked_through_claude_code():
    fake = FakePlan()
    previous = gateway.set_transports(gateway.Transports(plan=fake, api_key=FakePlan()))
    try:
        async with http(lambda r: pytest.fail("a plan token never goes to an HTTP API")) as c:
            identity = await PROVIDERS["claude"].identify(c, PLAN_TOKEN_PREFIX + "01-good-9876")
        assert identity.account_id == "plan"
        assert identity.label == "Claude plan (setup-token …9876)"
        assert fake.calls[0][0] == PLAN_TOKEN_PREFIX + "01-good-9876"

        fake.outcome = LlmAuthError("401 OAuth access token is invalid")
        async with http(lambda r: httpx.Response(500)) as c:
            with pytest.raises(CredentialRejected):
                await PROVIDERS["claude"].identify(c, PLAN_TOKEN_PREFIX + "01-bad")
        fake.outcome = LlmUnavailable("Claude Code is not installed")
        async with http(lambda r: httpx.Response(500)) as c:
            with pytest.raises(ProviderUnavailable):
                await PROVIDERS["claude"].identify(c, PLAN_TOKEN_PREFIX + "01-x")
    finally:
        gateway.set_transports(previous)
