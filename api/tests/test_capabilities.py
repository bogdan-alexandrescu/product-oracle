"""#370: what a role may do, read once by the web app (GET /v1/me/capabilities).

The answer is derived from the routes' own require_role dependencies, so it matches the
members route matrix (tests/test_members.py) for every role, and a route added without a
role fails here."""

import pytest
from fastapi.routing import APIRoute

from oracle.auth.deps import get_principal
from oracle.auth.models import ROLES
from oracle.capabilities import DECIDED_PER_ITEM, EVERY_MEMBER, operation_roles
from oracle.main import app
from tests.test_members import MATRIX, World, _template, token_with_role, world  # noqa: F401


def _calls(dependant):
    yield dependant.call
    for sub in dependant.dependencies:
        yield from _calls(sub)


def _routes(routes=None, prefix=""):
    """Every APIRoute in the app, with its full path (routers nest in FastAPI 0.143)."""
    for r in app.router.routes if routes is None else routes:
        if isinstance(r, APIRoute):
            yield prefix + r.path, r
        elif hasattr(r, "original_router"):
            yield from _routes(r.original_router.routes, prefix + (r.include_context.prefix or ""))


def _operation_ids() -> dict[tuple[str, str], str]:
    return {
        (method.upper(), path): op["operationId"]
        for path, ops in app.openapi()["paths"].items()
        for method, op in ops.items()
    }


def test_every_signed_in_route_has_a_role():
    """A route that resolves the caller names its role (require_role), or is listed as open
    to every member or decided per item. Add a route without one and this fails."""
    unguarded = {
        r.name
        for _, r in _routes()
        if get_principal in set(_calls(r.dependant))
        and not any(getattr(c, "min_role", None) for c in _calls(r.dependant))
    }
    assert unguarded == EVERY_MEMBER | DECIDED_PER_ITEM
    assert not EVERY_MEMBER & DECIDED_PER_ITEM


def test_operation_roles_cover_every_signed_in_route():
    roles = operation_roles(app)
    signed_in = {r.name for _, r in _routes() if get_principal in set(_calls(r.dependant))}
    assert set(roles) == signed_in
    assert set(roles.values()) <= set(ROLES)
    assert roles["list_members"] == "owner"
    assert roles["create_template"] == "approver"
    assert roles["list_sources"] == "viewer"
    # A router-level viewer check under a route's approver check: the higher one counts.
    assert roles["create_source"] == "commenter"


def test_openapi_carries_each_operations_role():
    """The mock (web/lib/api/mock) reads x-min-role, so it needs no list of its own."""
    roles = operation_roles(app)
    stamped = {
        op["operationId"]: op.get("x-min-role")
        for ops in app.openapi()["paths"].values()
        for op in ops.values()
        if op["operationId"] in roles
    }
    assert stamped == roles


@pytest.mark.parametrize("role", ROLES)
async def test_capabilities_match_the_route_matrix(client, world, role):
    resp = await client.get(
        "/v1/me/capabilities", headers=await token_with_role(world.tenant_id, role)
    )
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["role"] == role and body["engineering_lead"] is False
    ops = _operation_ids()
    for method, path, min_role, _ in MATRIX:
        op = ops[(method, _template(path))]
        allowed = ROLES.index(role) >= ROLES.index(min_role)
        assert body["operations"][op] is allowed, (role, method, path)
    assert set(body["operations"]) == set(operation_roles(app))


async def test_capabilities_carry_the_engineering_lead_flag(client, world):
    from oracle.auth.models import User
    from oracle.tenancy import tenant_session

    async with tenant_session(world.tenant_id) as s:
        user = await s.get(User, world.member_id)
        user.engineering_lead = True
        await s.commit()
    from oracle.auth.service import create_api_token

    async with tenant_session(world.tenant_id) as s:
        _, raw = await create_api_token(s, "lead-bot", user_id=world.member_id)
        await s.commit()
    resp = await client.get("/v1/me/capabilities", headers={"Authorization": f"Bearer {raw}"})
    assert resp.status_code == 200, resp.text
    assert resp.json()["engineering_lead"] is True
    assert resp.json()["role"] == "approver"


async def test_capabilities_need_a_sign_in(client):
    assert (await client.get("/v1/me/capabilities")).status_code == 401
