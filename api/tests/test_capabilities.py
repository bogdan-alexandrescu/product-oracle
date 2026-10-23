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
from tests.test_members import MATRIX, _template, token_with_role
from tests.test_members import world as members_world  # noqa: F401  (the fixture)

# The matrix changes someone else's comment (approver); a commenter changes their own.
OWN_ITEM = {("PATCH", "/v1/comments/{comment_id}"): "commenter"}


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
async def test_capabilities_match_the_route_matrix(client, members_world, role):  # noqa: F811
    resp = await client.get(
        "/v1/me/capabilities", headers=await token_with_role(members_world.tenant_id, role)
    )
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["role"] == role and body["engineering_lead"] is False
    ops = _operation_ids()
    for method, path, min_role, _ in MATRIX:
        op = ops[(method, _template(path))]
        min_role = OWN_ITEM.get((method, path), min_role)
        allowed = ROLES.index(role) >= ROLES.index(min_role)
        assert body["operations"][op] is allowed, (role, method, path)
    assert set(body["operations"]) == set(operation_roles(app))


async def test_capabilities_carry_the_engineering_lead_flag(client, members_world):  # noqa: F811
    from oracle.auth.models import User
    from oracle.tenancy import tenant_session

    async with tenant_session(members_world.tenant_id) as s:
        user = await s.get(User, members_world.member_id)
        user.engineering_lead = True
        await s.commit()
    from oracle.auth.service import create_api_token

    async with tenant_session(members_world.tenant_id) as s:
        _, raw = await create_api_token(s, "lead-bot", user_id=members_world.member_id)
        await s.commit()
    resp = await client.get("/v1/me/capabilities", headers={"Authorization": f"Bearer {raw}"})
    assert resp.status_code == 200, resp.text
    assert resp.json()["engineering_lead"] is True
    assert resp.json()["role"] == "approver"


async def test_capabilities_need_a_sign_in(client):
    assert (await client.get("/v1/me/capabilities")).status_code == 401


# --- #370 fixes 4: the engineering lead flag, and checks made inside handlers ---------------


async def _caps(client, headers) -> dict:
    resp = await client.get("/v1/me/capabilities", headers=headers)
    assert resp.status_code == 200, resp.text
    return resp.json()


async def test_the_engineering_lead_flag_gates_date_checks_as_the_api_does(client):
    """A commenter verifies dates only while they carry the flag: the capability and the
    API answer the same, before and after the flag."""
    from tests.fixtures import draft, import_draft, seed_auth
    from tests.review_v2_helpers import person

    tenant_id, auth = await seed_auth()
    assert (await import_draft(client, auth, draft("prd_v1.md"))).status_code == 201
    lead = await person(tenant_id, "commenter", "lead")
    body = {
        "kind": "estimate",
        "reference": "ENG-1",
        "supports_date": "2026-11-30",
        "prd": "checkout-redesign",
    }

    async def agree(headers, allowed: bool):
        caps = (await _caps(client, headers))["operations"]
        assert caps["create_schedule_basis"] is allowed
        assert caps["withdraw_schedule_basis"] is allowed
        resp = await client.post("/v1/schedule-bases", json=body, headers=headers)
        assert (resp.status_code == 201) is allowed, resp.text
        assert (resp.status_code == 403) is not allowed, resp.text

    await agree(lead.headers, False)
    flag = await client.patch(
        f"/v1/members/{lead.user_id}", json={"engineering_lead": True}, headers=auth
    )
    assert flag.status_code == 200, flag.text
    await agree(lead.headers, True)
    await agree((await person(tenant_id, "commenter")).headers, False)
    await agree((await person(tenant_id, "approver")).headers, True)


async def test_the_engineering_lead_flag_gates_engineering_stops(client):
    """Once a lead is named, the engineering stops go to the leads and owners (A3)."""
    from tests.fixtures import seed_auth
    from tests.review_v2_helpers import person

    tenant_id, auth = await seed_auth()
    lead = await person(tenant_id, "commenter", "lead")
    approver = await person(tenant_id, "approver")
    viewer = await person(tenant_id, "viewer")
    # No lead named yet: an approver decides them, a commenter does not.
    assert (await _caps(client, approver.headers))["decide_engineering_stops"] is True
    assert (await _caps(client, lead.headers))["decide_engineering_stops"] is False
    flag = await client.patch(
        f"/v1/members/{lead.user_id}", json={"engineering_lead": True}, headers=auth
    )
    assert flag.status_code == 200, flag.text
    assert (await _caps(client, lead.headers))["decide_engineering_stops"] is True
    assert (await _caps(client, approver.headers))["decide_engineering_stops"] is False
    assert (await _caps(client, viewer.headers))["decide_engineering_stops"] is False
    assert (await _caps(client, auth))["decide_engineering_stops"] is True


# A role check in a handler (or what it calls) that can refuse: has_role or the lead helpers
# next to a 403 in the same function.
_ROLE_CHECKS = ("has_role(", "may_decide(", "may_verify_dates(", "lead_refusal(")
_REFUSALS = ("HTTP_403_FORBIDDEN", "Forbidden(", "(403", "403,")


def _handler_role_checks() -> set[str]:
    """Every operation whose handler, or a function it calls in oracle, refuses on role."""
    import ast
    import inspect
    import textwrap
    import types

    memo: dict = {}

    def refuses(fn, depth=0) -> bool:
        fn = inspect.unwrap(fn)
        if fn in memo:
            return memo[fn]
        memo[fn] = False
        if not (getattr(fn, "__module__", "") or "").startswith("oracle"):
            return False
        try:
            src = textwrap.dedent(inspect.getsource(fn))
        except (OSError, TypeError):
            return False
        found = any(p in src for p in _ROLE_CHECKS) and any(p in src for p in _REFUSALS)
        if not found and depth < 6:
            names = getattr(fn, "__globals__", {})
            for node in ast.walk(ast.parse(src)):
                if not isinstance(node, ast.Call):
                    continue
                f, obj = node.func, None
                if isinstance(f, ast.Name):
                    obj = names.get(f.id)
                elif isinstance(f, ast.Attribute) and isinstance(f.value, ast.Name):
                    mod = names.get(f.value.id)
                    if isinstance(mod, types.ModuleType):
                        obj = getattr(mod, f.attr, None)
                if isinstance(obj, types.FunctionType) and refuses(obj, depth + 1):
                    found = True
                    break
        memo[fn] = found
        return found

    out = set()
    for _, r in _routes():
        calls = list(_calls(r.dependant))
        if get_principal not in calls:
            continue
        own = [c for c in calls if c is not get_principal and not getattr(c, "min_role", None)]
        if any(refuses(c) for c in own):
            out.add(r.name)
    return out


def test_every_check_made_in_a_handler_is_marked_per_item():
    """A handler that can still refuse a role the route lets in is in PER_ITEM, so the web
    app's can() asks the item too. Add such a check without listing it and this fails."""
    import oracle.capabilities as caps

    per_item = getattr(caps, "PER_ITEM", {})
    missing = _handler_role_checks() - set(per_item)
    assert not missing, f"handler role checks not in PER_ITEM: {sorted(missing)}"
    assert DECIDED_PER_ITEM <= set(per_item)
    assert set(per_item.values()) <= set(ROLES) | {None}


@pytest.mark.parametrize("role", ROLES)
async def test_capabilities_mark_the_per_item_operations(client, members_world, role):  # noqa: F811
    """The answer says which operations the item decides, and with which role the handler
    never refuses, so can() and the API agree (a question's asker or the intake's author
    changes it; an approver changes any)."""
    import oracle.capabilities as caps

    body = await _caps(client, await token_with_role(members_world.tenant_id, role))
    assert body.get("per_item") == getattr(caps, "PER_ITEM", None)
    assert body["per_item"]["update_question"] == "approver"
