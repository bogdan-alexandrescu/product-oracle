"""The role hierarchy viewer < commenter < approver < owner on real routes, for signed-in
users and role tokens, and documents invisible to another company (build prompt §1,
§12, §16.12; C2, F1)."""

import pytest

from oracle.auth.models import ROLES
from oracle.authz import has_role
from tests.conftest import make_tenant
from tests.legacy.helpers import DOC, fixture, import_md, mcp_session, role_token, user_cookie

VERSION1 = f"/v1/documents/{DOC}/versions/1"
COMMENT = {"section_key": "problem", "anchor": {"exact": "first week"}, "body": "Which week?"}


def test_the_four_roles_in_order():
    assert ROLES == ("viewer", "commenter", "approver", "owner")
    for i, role in enumerate(ROLES):
        for j, min_role in enumerate(ROLES):
            assert has_role(role, min_role) is (i >= j), (role, min_role)
    assert has_role("admin", "viewer") is False


# (what, minimum role) for one call per step of the hierarchy.
CALLS = [
    ("read document", "viewer"),
    ("export", "viewer"),
    ("comment", "commenter"),
    ("section verdict", "approver"),
    ("import version", "approver"),
    ("list members", "owner"),
]


async def _call(client, what: str, headers: dict[str, str]):
    if what == "read document":
        return await client.get(f"/v1/documents/{DOC}", headers=headers)
    if what == "export":
        return await client.get(f"{VERSION1}/export?format=md", headers=headers)
    if what == "comment":
        return await client.post(f"{VERSION1}/comments", json=COMMENT, headers=headers)
    if what == "section verdict":
        return await client.put(
            f"{VERSION1}/sections/summary/review", json={"verdict": "approved"}, headers=headers
        )
    if what == "import version":
        text = fixture("legacy_prd_v1.md").replace("five-step", "six-step")
        return await import_md(client, headers, text)
    if what == "list members":
        return await client.get("/v1/members", headers=headers)
    raise AssertionError(what)


@pytest.mark.parametrize("credential", ["session", "token"])
@pytest.mark.parametrize("role", ROLES)
async def test_each_role_reaches_exactly_its_level(client, tenant_id, role, credential):
    owner = {"Authorization": f"Bearer {await role_token(tenant_id, 'owner')}"}
    assert (await import_md(client, owner, fixture("legacy_prd_v1.md"))).status_code == 201
    if credential == "session":
        headers = await user_cookie(tenant_id, role)
    else:
        headers = {"Authorization": f"Bearer {await role_token(tenant_id, role)}"}
    for what, min_role in CALLS:
        resp = await _call(client, what, headers)
        if has_role(role, min_role):
            assert resp.status_code in (200, 201), (role, what, resp.text)
        else:
            assert resp.status_code == 403, (role, what, resp.status_code)
            assert resp.json()["detail"] == f"Requires the {min_role} role"


async def test_no_credential_is_401(client, tenant_id):
    for what, _ in CALLS:
        assert (await _call(client, what, {})).status_code == 401, what


async def test_another_company_cannot_see_or_touch_the_document(client, tenant_id):
    owner = {"Authorization": f"Bearer {await role_token(tenant_id, 'owner')}"}
    assert (await import_md(client, owner, fixture("legacy_prd_v1.md"))).status_code == 201
    other = await make_tenant("Other Co")
    raw = await role_token(other, "owner")
    them = {"Authorization": f"Bearer {raw}"}
    assert (await client.get("/v1/documents", headers=them)).json() == []
    for what in ("read document", "export", "comment", "section verdict"):
        resp = await _call(client, what, them)
        assert resp.status_code == 404, (what, resp.status_code)
    for url in (f"{VERSION1}/feedback-package", f"{VERSION1}/markdown", f"{VERSION1}/deck"):
        assert (await client.get(url, headers=them)).status_code == 404, url
    async with mcp_session(raw) as c:
        result = await c.call_tool("get_document", {"doc": DOC})
        assert result.is_error
    # Their own import under the same slug is a separate document; ours is unchanged.
    assert (await import_md(client, them, fixture("legacy_prd_v1.md"))).status_code == 201
    ours = (await client.get(f"/v1/documents/{DOC}", headers=owner)).json()
    assert [v["number"] for v in ours["versions"]] == [1]
