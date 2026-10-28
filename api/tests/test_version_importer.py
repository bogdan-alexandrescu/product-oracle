"""#256: a version says who imported it by name (a member's display name, "Oracle" for
a run, an API token's name), never by the raw id."""

import uuid

from oracle.auth.deps import Principal
from oracle.auth.service import create_api_token, create_user, make_session_cookie
from oracle.config import get_settings
from oracle.docs import service as docs_service
from oracle.tenancy import tenant_session
from tests.fixtures import draft, import_draft, seed_auth

DOC = "/v1/documents/checkout-redesign"


async def _member(tenant_id: uuid.UUID) -> tuple[uuid.UUID, dict[str, str]]:
    async with tenant_session(tenant_id) as s:
        user = await create_user(s, "dana.reyes@example.com", "test-password-123")
        await s.commit()
        cookie = make_session_cookie(user)
        return user.id, {"Cookie": f"{get_settings().session_cookie_name}={cookie}"}


async def _service_token(tenant_id: uuid.UUID, name: str) -> tuple[uuid.UUID, dict[str, str]]:
    async with tenant_session(tenant_id) as s:
        token, raw = await create_api_token(s, name)
        await s.commit()
        return token.id, {"Authorization": f"Bearer {raw}"}


def _retitled(markdown: str, label: str) -> str:
    return markdown.replace("Checkout redesign PRD", f"Checkout redesign PRD ({label})", 1)


async def _three_versions(client):
    """v1 by a member, v2 by a service token, v3 by a run."""
    tenant_id, auth = await seed_auth()
    member_id, member = await _member(tenant_id)
    token_id, bot = await _service_token(tenant_id, "release-bot")
    v1 = draft("prd_v1.md")
    for headers, text in ((member, v1), (bot, _retitled(v1, "v2"))):
        resp = await import_draft(client, headers, text)
        assert resp.status_code == 201, resp.text
    async with tenant_session(tenant_id) as s:
        principal = Principal(tenant_id=tenant_id, kind="user", role="owner", user_id=member_id)
        await docs_service.import_draft(
            s,
            "checkout-redesign",
            _retitled(v1, "run draft"),
            principal,
            cause="run_draft",
            origin="run",
            run_id=uuid.uuid4(),
        )
    return auth, member_id, token_id


async def test_document_versions_name_their_importer(client):
    auth, member_id, token_id = await _three_versions(client)
    resp = await client.get(DOC, headers=auth)
    assert resp.status_code == 200, resp.text
    got = [(v["number"], v["imported_by_name"], v["imported_by"]) for v in resp.json()["versions"]]
    assert got == [
        (1, "Dana Reyes", str(member_id)),
        (2, "API token release-bot", str(token_id)),
        (3, "Oracle", str(member_id)),
    ]


async def test_version_list_and_read_name_their_importer(client):
    auth, _, _ = await _three_versions(client)
    listed = (await client.get(f"{DOC}/versions", headers=auth)).json()
    assert [v["imported_by_name"] for v in listed] == [
        "Dana Reyes",
        "API token release-bot",
        "Oracle",
    ]
    for n, name in ((1, "Dana Reyes"), (2, "API token release-bot"), (3, "Oracle")):
        resp = await client.get(f"{DOC}/versions/{n}", headers=auth)
        assert resp.status_code == 200, resp.text
        assert resp.json()["imported_by_name"] == name
