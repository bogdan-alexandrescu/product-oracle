from typing import Annotated

import httpx
import pytest
from fastapi import Depends, FastAPI
from sqlalchemy import delete, select, update

from oracle.auth.deps import Principal
from oracle.auth.models import ROLES, ApiToken, User
from oracle.auth.service import create_api_token
from oracle.authz import has_role, require_role
from oracle.main import app
from oracle.seed import seed
from oracle.tenancy import tenant_session


@pytest.mark.parametrize(
    ("role", "min_role", "allowed"),
    [
        ("viewer", "viewer", True),
        ("viewer", "commenter", False),
        ("commenter", "commenter", True),
        ("commenter", "approver", False),
        ("approver", "commenter", True),
        ("approver", "owner", False),
        ("owner", "approver", True),
        ("owner", "owner", True),
        ("admin", "viewer", False),
    ],
)
def test_role_order(role, min_role, allowed):
    assert has_role(role, min_role) is allowed


def test_roles_are_ordered_lowest_first():
    assert ROLES == ("viewer", "commenter", "approver", "owner")


def test_unknown_min_role_is_a_programming_error():
    with pytest.raises(ValueError):
        require_role("admin")  # type: ignore[arg-type]


@pytest.fixture
async def guarded():
    """The real auth stack in front of one route per minimum role."""
    test_app = FastAPI()
    for min_role in ROLES:

        def endpoint(
            principal: Annotated[Principal, Depends(require_role(min_role))],
        ) -> dict:
            return {"role": principal.role}

        test_app.get(f"/{min_role}")(endpoint)
    transport = httpx.ASGITransport(app=test_app)
    async with httpx.AsyncClient(transport=transport, base_url="http://test") as c:
        yield c


async def _as_token_with_role(role: str) -> tuple[str, object]:
    """A token without a user (the seeded one acts as the admin), with ``role``."""
    r = await seed()
    async with tenant_session(r.tenant_id) as s:
        token, raw = await create_api_token(s, "bot")
        token.role = role
        await s.commit()
    return raw, r.tenant_id


@pytest.mark.parametrize("role", ROLES)
async def test_require_role_with_api_tokens(guarded, role):
    token, _ = await _as_token_with_role(role)
    headers = {"Authorization": f"Bearer {token}"}
    for rank, min_role in enumerate(ROLES):
        resp = await guarded.get(f"/{min_role}", headers=headers)
        if rank <= ROLES.index(role):
            assert resp.status_code == 200, (role, min_role)
            assert resp.json() == {"role": role}
        else:
            assert resp.status_code == 403, (role, min_role)
            assert resp.json()["detail"] == f"Requires the {min_role} role"


async def test_require_role_with_a_user_session(guarded, client):
    r = await seed(password="correct horse")
    async with tenant_session(r.tenant_id) as s:
        await s.execute(update(User).values(role="commenter"))
        await s.commit()
    await client.post(
        "/v1/auth/login", json={"email": "admin@example.com", "password": "correct horse"}
    )
    guarded.cookies.update(client.cookies)
    assert (await guarded.get("/commenter")).status_code == 200
    assert (await guarded.get("/approver")).status_code == 403


async def test_require_role_needs_authentication(guarded):
    assert (await guarded.get("/viewer")).status_code == 401


async def test_me_reports_the_user_role(client):
    r = await seed(password="correct horse")
    login = await client.post(
        "/v1/auth/login", json={"email": "admin@example.com", "password": "correct horse"}
    )
    assert login.json()["role"] == "owner"
    assert (await client.get("/v1/me")).json()["role"] == "owner"

    async with tenant_session(r.tenant_id) as s:
        await s.execute(update(User).values(role="approver"))
        await s.commit()
    assert (await client.get("/v1/me")).json()["role"] == "approver"


async def test_me_reports_the_token_role(client):
    r = await seed()
    async with tenant_session(r.tenant_id) as s:
        _, raw = await create_api_token(s, "bot")
        await s.commit()
    headers = {"Authorization": f"Bearer {raw}"}
    me = (await client.get("/v1/me", headers=headers)).json()
    assert (me["kind"], me["role"]) == ("token", "owner")  # default for API tokens

    async with tenant_session(r.tenant_id) as s:
        await s.execute(update(ApiToken).where(ApiToken.user_id.is_(None)).values(role="viewer"))
        await s.commit()
    assert (await client.get("/v1/me", headers=headers)).json()["role"] == "viewer"


async def test_a_token_for_a_user_acts_as_that_user(client):
    # The seeded token acts as the admin: the user's role (not the token's), the user's id.
    r = await seed(token_name="cli")
    headers = {"Authorization": f"Bearer {r.token}"}
    me = (await client.get("/v1/me", headers=headers)).json()
    assert (me["kind"], me["role"], me["email"]) == ("user", "owner", "admin@example.com")
    assert me["token_name"] == "cli" and me["user_id"]

    async with tenant_session(r.tenant_id) as s:
        await s.execute(update(ApiToken).values(role="viewer"))  # ignored for a user token
        await s.execute(update(User).values(role="commenter"))
        await s.commit()
    assert (await client.get("/v1/me", headers=headers)).json()["role"] == "commenter"

    # Per-user endpoints work with it (sources are the user's own).
    assert (await client.get("/v1/sources", headers=headers)).status_code == 200

    async with tenant_session(r.tenant_id) as s:
        await s.execute(delete(User))  # the user's tokens go with them
        await s.commit()
        assert (await s.scalars(select(ApiToken))).all() == []
    assert (await client.get("/v1/me", headers=headers)).status_code == 401


def test_v1_routers_are_mounted():
    # Every v1 lane has landed; their own tests cover the routes.
    paths = app.openapi()["paths"]
    for prefix in ("/v1/members", "/v1/sources", "/v1/baseline", "/v1/priorities", "/v1/runs"):
        assert any(p.startswith(prefix) for p in paths), prefix
