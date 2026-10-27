"""#723 S1: Simple mode's switch and the remembered mode.

GET /v1/me/capabilities says whether Simple is on (``simple_mode``, from
ORACLE_SIMPLE_MODE, off by default); GET/PATCH /v1/me/preferences keep each person's
``experience`` ('simple' or 'detailed', unset until they switch; a stored 'studio', the
mode's name before the owner's decision on #723, reads as 'detailed'); the capabilities name the
role's ``default_experience`` for when it is unset. Nothing here proves the web
draws the switch or lands by role (web/e2e/simple-mode.spec.ts).
"""

import pytest
from sqlalchemy import update

from oracle.config import get_settings
from oracle.preferences.models import UserPreference
from oracle.tenancy import tenant_session
from tests.test_members import token_with_role


async def test_simple_mode_is_off_unless_the_environment_turns_it_on(client, tenant_id):
    # protects=the switch stays hidden in a deployment that never set ORACLE_SIMPLE_MODE;
    # fails_when=the capability is missing or defaults on; no_claim=the web hiding it.
    headers = await token_with_role(tenant_id, "viewer")
    resp = await client.get("/v1/me/capabilities", headers=headers)
    assert resp.status_code == 200, resp.text
    assert resp.json()["simple_mode"] is False


@pytest.mark.parametrize("role", ["viewer", "commenter", "approver", "owner"])
async def test_simple_mode_on_answers_every_role(client, tenant_id, monkeypatch, role):
    # protects=ORACLE_SIMPLE_MODE turns Simple on for everyone; fails_when=the flag is read
    # per role or not at all; no_claim=which mode a role lands in (the web decides).
    monkeypatch.setattr(get_settings(), "simple_mode", True)
    headers = await token_with_role(tenant_id, role)
    resp = await client.get("/v1/me/capabilities", headers=headers)
    assert resp.status_code == 200, resp.text
    assert resp.json()["simple_mode"] is True


@pytest.mark.parametrize(
    ("role", "mode"),
    [
        ("viewer", "simple"),
        ("commenter", "simple"),
        ("approver", "detailed"),
        ("owner", "detailed"),
    ],
)
async def test_capabilities_name_the_roles_default_mode(client, tenant_id, role, mode):
    # protects=the landing without a saved mode (D13: viewers and commenters in Simple,
    # approvers and owners in Detailed) comes from the API, not role names in the web;
    # fails_when=the field is missing or a role gets the other mode; no_claim=the web landing.
    headers = await token_with_role(tenant_id, role)
    resp = await client.get("/v1/me/capabilities", headers=headers)
    assert resp.status_code == 200, resp.text
    assert resp.json()["default_experience"] == mode


def test_the_environment_variable_names_the_setting(monkeypatch):
    # protects=the rollback switch's name (ORACLE_SIMPLE_MODE=off); fails_when=the setting
    # is renamed; no_claim=deployment config.
    from oracle.config import Settings

    monkeypatch.setenv("ORACLE_SIMPLE_MODE", "on")
    assert Settings().simple_mode is True
    monkeypatch.setenv("ORACLE_SIMPLE_MODE", "off")
    assert Settings().simple_mode is False


async def test_experience_is_unset_until_chosen_then_remembered(client, tenant_id):
    # protects=the remembered mode (D13); fails_when=an unset preference reads as a mode
    # (the role default could never apply) or a choice is not kept; no_claim=the landing.
    headers = await token_with_role(tenant_id, "viewer")
    resp = await client.get("/v1/me/preferences", headers=headers)
    assert resp.status_code == 200, resp.text
    assert resp.json()["experience"] is None

    for mode in ("detailed", "simple"):
        resp = await client.patch("/v1/me/preferences", json={"experience": mode}, headers=headers)
        assert resp.status_code == 200, resp.text
        assert resp.json()["experience"] == mode
        assert (await client.get("/v1/me/preferences", headers=headers)).json()[
            "experience"
        ] == mode


async def test_experience_is_each_persons_own_and_checked(client, tenant_id):
    # protects=one person's switch never moves another; fails_when=the key is shared or
    # any string is stored; no_claim=other preference keys.
    viewer = await token_with_role(tenant_id, "viewer")
    owner = await token_with_role(tenant_id, "owner")
    resp = await client.patch("/v1/me/preferences", json={"experience": "simple"}, headers=owner)
    assert resp.status_code == 200, resp.text
    assert (await client.get("/v1/me/preferences", headers=viewer)).json()["experience"] is None

    resp = await client.patch("/v1/me/preferences", json={"experience": "fancy"}, headers=viewer)
    assert resp.status_code == 422
    # Another key's change keeps the chosen mode.
    resp = await client.patch("/v1/me/preferences", json={"document_view": "full"}, headers=owner)
    assert resp.json()["experience"] == "simple"


async def test_the_old_studio_name_is_refused_and_a_stored_one_reads_as_detailed(client, tenant_id):
    # protects=the owner's rename of Studio to Detailed (#723) strands no one: a stored
    # 'studio' reads as 'detailed'; fails_when=the API still takes 'studio' or a stored one
    # fails to read; no_claim=the web's words (web/e2e/simple-mode.spec.ts).
    headers = await token_with_role(tenant_id, "owner")
    resp = await client.patch("/v1/me/preferences", json={"experience": "studio"}, headers=headers)
    assert resp.status_code == 422

    resp = await client.patch("/v1/me/preferences", json={"experience": "simple"}, headers=headers)
    assert resp.status_code == 200, resp.text
    async with tenant_session(tenant_id) as s:
        await s.execute(
            update(UserPreference).where(UserPreference.key == "experience").values(value="studio")
        )
        await s.commit()
    resp = await client.get("/v1/me/preferences", headers=headers)
    assert resp.status_code == 200, resp.text
    assert resp.json()["experience"] == "detailed"
    # Another key's change keeps it, now under its new name.
    resp = await client.patch("/v1/me/preferences", json={"document_view": "full"}, headers=headers)
    assert resp.status_code == 200, resp.text
    assert resp.json()["experience"] == "detailed"
