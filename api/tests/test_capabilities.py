"""#370: what a role may do, read once by the web app (GET /v1/me/capabilities).

The answer is derived from the routes' own require_role dependencies, so it matches the
members route matrix (tests/test_members.py) for every role, and a route added without a
role fails here."""

import pytest
from fastapi.routing import APIRoute

from oracle.auth.deps import get_principal
from oracle.auth.models import ROLES
from oracle.authz import require_role, require_role_now
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


# A role check in a handler (or what it calls) that can refuse: a 403 raised in a function
# that checks a role itself (has_role, the lead helpers) or through what it calls (a helper
# such as is_decider or may_edit_task), or a call to a function that does.
_ROLE_CHECKS = ("has_role(", "may_decide(", "may_verify_dates(", "lead_refusal(")
_REFUSALS = ("HTTP_403_FORBIDDEN", "Forbidden(", "ForbiddenError(", "(403", "403,")
_ROUTE_ROLE = (require_role, require_role_now)
# Found by the search but not a refusal of the caller's role above the route's.
NOT_PER_ITEM = {
    # The starter adds the people they pick; only a viewer is refused, as the route does.
    "create_discussion",
    # G7 Share as discussion starts one the same way; the panel chat is its starter's alone.
    "share_discussion",
    # B6 Goals interview starts one the same way, and a version is acted on by whoever
    # writes in its discussion; only a run's token and a viewer are refused, as the routes do.
    "start_goal_interview",
    "start_goal_interviews",
    "propose_goal_measure",
    "dismiss_goal_measure",
    # The 403 refuses a run's token; the role check picks whom the daily run acts as.
    "set_request_triage_daily",
    # F3: the route's own date rights (min_role and lead_role), re-read at write time.
    "create_schedule_basis",
    "reject_schedule_basis",
    "verify_schedule_basis",
    "withdraw_schedule_basis",
}


def _handler_role_checks() -> set[str]:
    """Every operation whose handler, or a function it calls in oracle, refuses on role."""
    import ast
    import inspect
    import textwrap
    import types

    sources: dict = {}

    def source(fn) -> str | None:
        if fn not in sources:
            sources[fn] = None
            if (getattr(fn, "__module__", "") or "").startswith("oracle"):
                try:
                    sources[fn] = textwrap.dedent(inspect.getsource(fn))
                except (OSError, TypeError):
                    pass
        return sources[fn]

    def callees(fn) -> list:
        """The oracle functions ``fn`` calls by name or as ``module.name``."""
        src = source(fn)
        if src is None:
            return []
        names = getattr(fn, "__globals__", {})
        out = []
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
            # A route's own role dependency (``Depends(require_role(...))`` in a helper such
            # as plan's _person) is the route's role, counted by operation_roles already.
            if isinstance(obj, types.FunctionType) and obj not in _ROUTE_ROLE:
                out.append(inspect.unwrap(obj))
        return out

    def walk(fn, test, memo, depth=0) -> bool:
        """``test`` holds for ``fn`` or for a function it calls (to depth 6)."""
        fn = inspect.unwrap(fn)
        if fn in memo:
            return memo[fn]
        memo[fn] = False
        src = source(fn)
        if src is None:
            return False
        found = test(fn, src) or (
            depth < 6 and any(walk(c, test, memo, depth + 1) for c in callees(fn))
        )
        memo[fn] = found
        return found

    checked: dict = {}

    def checks_role(fn, src) -> bool:
        return any(p in src for p in _ROLE_CHECKS)

    def refuses_here(fn, src) -> bool:
        # The check may sit in a helper the function calls (``if not await is_decider(...):
        # raise ForbiddenError(...)``), so the role is looked for through its calls too.
        return any(p in src for p in _REFUSALS) and walk(fn, checks_role, checked)

    refused: dict = {}
    out = set()
    for _, r in _routes():
        calls = list(_calls(r.dependant))
        if get_principal not in calls:
            continue
        own = [c for c in calls if c is not get_principal and not getattr(c, "min_role", None)]
        if any(walk(c, refuses_here, refused) for c in own):
            out.add(r.name)
    return out


def test_every_check_made_in_a_handler_is_marked_per_item():
    """A handler that can still refuse a role the route lets in is in PER_ITEM, so the web
    app's can() asks the item too. Add such a check without listing it and this fails."""
    import oracle.capabilities as caps

    per_item = getattr(caps, "PER_ITEM", {})
    missing = _handler_role_checks() - set(per_item) - NOT_PER_ITEM
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


# #370 fixes 6: checks split across functions (a helper checks the role, the caller raises)
# or raised as a service's ForbiddenError.
SPLIT_CHECKS = {
    "start_draft": "owner",
    "update_launch_task": "approver",
    "update_blocker": "owner",
    "set_blocker_status": "owner",
    "accept_blocker_risk": "owner",
}


def test_split_and_service_checks_are_found():
    """The search finds a 403 whose role check sits in a helper (is_decider, may_edit_task)
    or that a service raises as ForbiddenError, and not a route's own require_role."""
    found = _handler_role_checks()
    assert set(SPLIT_CHECKS) <= found, sorted(set(SPLIT_CHECKS) - found)
    assert not {"get_plan", "get_plan_item_history"} & found


def test_per_item_says_what_the_api_enforces():
    """A vision, strategy or update is an owner's to start or approve; a task its owner's or
    an approver's to edit; a gating blocker the company's acceptance role's (owner at most).
    The route's own role is no per-item rule (the Plan reads)."""
    import oracle.capabilities as caps

    for op, role in SPLIT_CHECKS.items():
        assert caps.PER_ITEM.get(op, "missing") == role, op
    assert caps.PER_ITEM.get("approve_version", "missing") == "owner"
    assert "get_plan" not in caps.PER_ITEM
    assert "get_plan_item_history" not in caps.PER_ITEM


async def test_an_approver_is_told_the_owner_starts_strategy_drafts(client):
    """The capabilities an approver reads say start_draft is the owner's below it, which
    is what POST /v1/drafts answers them for a vision (403)."""
    from tests.fixtures import seed_auth
    from tests.review_v2_helpers import person

    tenant_id, _ = await seed_auth()
    approver = await person(tenant_id, "approver")
    body = await _caps(client, approver.headers)
    assert body["operations"]["start_draft"] is True
    assert body["per_item"]["start_draft"] == "owner"
    resp = await client.post(
        "/v1/drafts",
        json={"kind": "vision", "title": "Vision", "template": "vision-narrative"},
        headers=approver.headers,
    )
    assert resp.status_code == 403, resp.text


def test_per_item_keys_are_in_alphabetical_order():
    """protects=PER_ITEM reads as a sorted list (#504 review); fails_when=a key is added out
    of order; no_claim=the roles it names (the tests above)."""
    import oracle.capabilities as caps

    assert list(caps.PER_ITEM) == sorted(caps.PER_ITEM)


@pytest.mark.parametrize("role", ROLES)
async def test_company_source_coverage_is_the_owners_alone(client, members_world, role):  # noqa: F811
    """protects=Company coverage is owners' only (owner 2026-10-24, Train N item 1): the
    capabilities a non-owner reads say no, as GET /v1/sources/coverage/company answers them
    (403); fails_when=the per-item role is missing, so can() lets an approver, commenter or
    viewer in; no_claim=the Sources page's use of it (web lane)."""
    from oracle.authz import has_role

    headers = await token_with_role(members_world.tenant_id, role)
    body = await _caps(client, headers)
    op = "get_company_source_coverage"
    assert body["per_item"].get(op, "missing") == "owner"
    allowed = body["operations"][op] and has_role(role, body["per_item"][op])
    assert allowed is (role == "owner"), role
    resp = await client.get("/v1/sources/coverage/company", headers=headers)
    assert resp.status_code == (200 if role == "owner" else 403), resp.text
