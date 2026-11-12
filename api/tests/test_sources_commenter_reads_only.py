"""A commenter sees their sources that need attention but changes none (owner 2026-11-10,
'No: commenters only see them'): editing, syncing, pausing, resuming or deleting a source
needs an approver or owner. Adding a source (and its uploads) stays open to a commenter."""

import pytest
from sqlalchemy import select, update

from oracle.auth.models import User
from oracle.seed import seed
from oracle.sources import base, service
from oracle.sources.models import Source
from oracle.tenancy import tenant_session, unscoped_session
from tests.sources_helpers import FakeConnector, make_connection


@pytest.fixture
def slack(monkeypatch):
    service.load_connectors()
    fake = FakeConnector(kind="slack")
    monkeypatch.setitem(base._registry, "slack", fake)
    return fake


async def _signed_in(client, role: str) -> User:
    r = await seed(password="correct horse")
    async with tenant_session(r.tenant_id) as s:
        await s.execute(update(User).values(role=role))
        await s.commit()
    login = await client.post(
        "/v1/auth/login", json={"email": "admin@example.com", "password": "correct horse"}
    )
    assert login.status_code == 200, login.text
    async with unscoped_session() as s:
        return await s.scalar(select(User).where(User.email == "admin@example.com"))


async def _needing_attention(user: User) -> Source:
    conn = await make_connection(user.tenant_id, user, "slack")
    async with tenant_session(user.tenant_id) as s:
        source = Source(
            owner_user_id=user.id,
            connection_id=conn,
            kind="slack",
            name="Product",
            config={"channels": ["C1"]},
            status="needs_attention",
            last_error="Over 100 channels: pick 100 or fewer to sync this source again",
        )
        s.add(source)
        await s.commit()
        return source


@pytest.mark.parametrize(("role", "may_change"), [("commenter", False), ("approver", True)])
async def test_only_an_approver_or_owner_changes_a_source(client, slack, role, may_change):
    user = await _signed_in(client, role)
    source = await _needing_attention(user)
    path = f"/v1/sources/{source.id}"

    listed = await client.get("/v1/sources")
    assert listed.status_code == 200
    assert [(s["name"], s["status"]) for s in listed.json()] == [("Product", "needs_attention")]
    assert (await client.get(path)).status_code == 200

    writes = [
        await client.patch(path, json={"name": "Renamed"}),
        await client.post(f"{path}/pause"),
        await client.post(f"{path}/resume"),
        await client.post(f"{path}/sync"),
    ]
    codes = [r.status_code for r in writes]
    if may_change:
        assert 403 not in codes, [r.text for r in writes]
        assert (await client.delete(path)).status_code == 204
        return
    assert codes == [403] * 4, [r.text for r in writes]
    assert all(r.json()["detail"] == "Requires the approver role" for r in writes)
    assert (await client.delete(path)).status_code == 403
    async with unscoped_session() as s:
        rows = (await s.scalars(select(Source))).all()
    assert [(x.name, x.status) for x in rows] == [("Product", "needs_attention")]


async def test_a_commenter_still_adds_a_source(client, slack):
    user = await _signed_in(client, "commenter")
    conn = await make_connection(user.tenant_id, user, "slack")
    made = await client.post(
        "/v1/sources",
        json={
            "kind": "slack",
            "name": "New",
            "connection_id": str(conn),
            "config": {"channels": ["C2"]},
        },
    )
    assert made.status_code == 201, made.text


async def test_capabilities_say_a_commenter_cannot_change_a_source():
    from oracle.capabilities import operation_roles
    from oracle.main import app

    roles = operation_roles(app)
    for op in ("update_source", "delete_source", "pause_source", "resume_source", "sync_source"):
        assert roles[op] == "approver", op
    assert roles["create_source"] == "commenter"
    assert roles["list_sources"] == "viewer"
