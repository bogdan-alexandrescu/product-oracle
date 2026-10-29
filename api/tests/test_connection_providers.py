"""Token validation and identity per provider, against httpx.MockTransport."""

import httpx
import pytest

from oracle.connections.providers import (
    PROVIDERS,
    CredentialRejected,
    ProviderUnavailable,
)
from oracle.sources.models import SOURCE_KINDS


def http(handler) -> httpx.AsyncClient:
    return httpx.AsyncClient(transport=httpx.MockTransport(handler))


def bearer(request: httpx.Request) -> str:
    return request.headers.get("Authorization", "")


def test_registry_covers_every_provider_and_valid_source_kinds():
    assert set(PROVIDERS) == {"github", "slack", "notion", "fireflies", "google"}
    for p in PROVIDERS.values():
        assert set(p.source_kinds) <= set(SOURCE_KINDS)
        assert p.token_help
    assert PROVIDERS["google"].source_kinds == ("google_docs",)
    # OAuth where the provider has it; Fireflies is token-only.
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
        assert identity.label == "pat in Example"
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
        if request.url.path == "/tokeninfo":
            return httpx.Response(200, json={"scope": "openid email"})
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


def test_claude_is_not_a_connection():
    # Oracle's own model calls run on the company's Claude account pool.
    assert "claude" not in PROVIDERS
