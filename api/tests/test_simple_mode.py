"""#723 S1: Simple mode's switch and the remembered mode.

GET /v1/me/capabilities says whether Simple is on (``simple_mode``, from
ORACLE_SIMPLE_MODE, off by default); GET/PATCH /v1/me/preferences keep each person's
``experience`` ('simple' or 'studio', unset until they switch). Nothing here proves the web
draws the switch or lands by role (web/e2e/simple-mode.spec.ts).
"""

import pytest

from oracle.config import get_settings
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

    for mode in ("studio", "simple"):
        resp = await client.patch(
            "/v1/me/preferences", json={"experience": mode}, headers=headers
        )
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
    resp = await client.patch(
        "/v1/me/preferences", json={"experience": "simple"}, headers=owner
    )
    assert resp.status_code == 200, resp.text
    assert (await client.get("/v1/me/preferences", headers=viewer)).json()["experience"] is None

    resp = await client.patch("/v1/me/preferences", json={"experience": "fancy"}, headers=viewer)
    assert resp.status_code == 422
    # Another key's change keeps the chosen mode.
    resp = await client.patch(
        "/v1/me/preferences", json={"document_view": "full"}, headers=owner
    )
    assert resp.json()["experience"] == "simple"
