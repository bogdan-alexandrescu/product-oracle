"""Company settings: owner only, each known key validated."""

import pytest
from sqlalchemy import select

from oracle.models import AuditEvent
from oracle.tenancy import tenant_session
from oracle.tenant_settings_api import InvalidSetting, validate_confidence_weights
from tests.connection_helpers import make_person


@pytest.fixture
async def owner(tenant_id):
    return await make_person(tenant_id, "owner@example.com", "owner")


async def test_owner_only(client, tenant_id, owner):
    approver = await make_person(tenant_id, "approver@example.com", "approver")
    for method, url in [("GET", "/v1/settings"), ("GET", "/v1/settings/iap_default_role")]:
        assert (await client.request(method, url, headers=approver.headers)).status_code == 403
    put = await client.put(
        "/v1/settings/iap_default_role", json={"value": "viewer"}, headers=approver.headers
    )
    assert put.status_code == 403
    assert (await client.get("/v1/settings")).status_code == 401


async def test_defaults_and_unknown_keys(client, owner):
    listed = (await client.get("/v1/settings", headers=owner.headers)).json()
    assert {s["key"]: s["value"] for s in listed} == {
        "iap_default_role": "commenter",
        "confidence_weights": {},
        # v2-review: the company's default review policy (oracle.review.state).
        "review_policy": {
            "decider_id": None,
            "mandatory_reviewer_ids": [],
            "required_section_keys": [],
            "section_approval": "required_sections",
            "rereview_on_change": True,
        },
        # v2-review: only the latest version of a document is published.
        "publish_latest_only": True,
        "blocker_risk_acceptance_role": "owner",
        "blocker_risk_review_max_days": 90,
        "company_email_domains": [],
        "company_shared_drives": [],
        # H11: every responsibility at its default (written through /v1/autonomy).
        "autonomy": {},
    }
    assert all(s["is_default"] for s in listed)
    assert (await client.get("/v1/settings/nope", headers=owner.headers)).status_code == 404
    put = await client.put("/v1/settings/nope", json={"value": 1}, headers=owner.headers)
    assert put.status_code == 404


async def test_iap_default_role(client, tenant_id, owner):
    bad = await client.put(
        "/v1/settings/iap_default_role", json={"value": "admin"}, headers=owner.headers
    )
    assert bad.status_code == 422
    assert "viewer, commenter, approver, owner" in bad.json()["detail"]

    ok = await client.put(
        "/v1/settings/iap_default_role", json={"value": "viewer"}, headers=owner.headers
    )
    assert ok.status_code == 200
    assert ok.json()["value"] == "viewer" and ok.json()["is_default"] is False
    got = await client.get("/v1/settings/iap_default_role", headers=owner.headers)
    assert got.json()["value"] == "viewer"

    reset = await client.put(
        "/v1/settings/iap_default_role", json={"value": None}, headers=owner.headers
    )
    assert reset.json()["value"] == "commenter" and reset.json()["is_default"] is True
    async with tenant_session(tenant_id) as s:
        actions = (await s.scalars(select(AuditEvent.action))).all()
    assert "setting.update" in actions and "setting.reset" in actions


async def test_the_claude_plan_setting_is_gone(client, owner):
    # Oracle's model calls run on the Claude account pool, not a default connection.
    url = "/v1/settings/default_claude_connection_id"
    assert (await client.get(url, headers=owner.headers)).status_code == 404


async def test_confidence_weights_api(client, owner):
    url = "/v1/settings/confidence_weights"
    good = {"weights": {"source": 0.5}, "source": {"slack": 0.3, "github:issue": 0.8}, "low": 0.3}
    ok = await client.put(url, json={"value": good}, headers=owner.headers)
    assert ok.status_code == 200 and ok.json()["value"] == good
    bad = await client.put(url, json={"value": {"weights": {"vibes": 1}}}, headers=owner.headers)
    assert bad.status_code == 422


@pytest.mark.parametrize(
    ("value", "message"),
    [
        ([], "must be an object"),
        ({"unknown": 1}, "unknown key"),
        ({"weights": 1}, "must be an object"),
        ({"weights": {"source": -1}}, "at least 0"),
        ({"weights": {"source": 0, "freshness": 0, "mentions": 0, "goal_impact": 0}}, "above 0"),
        ({"source": {"dropbox": 0.5}}, "unknown kind"),
        ({"source": {"github:tweet": 0.5}}, "unknown kind"),
        ({"source": {"slack": 2}}, "at most 1"),
        ({"half_life_days": {"slack": 0}}, "more than 0"),
        ({"goal_impact": {"9": 1}}, "unknown key"),
        ({"tie_margin": "high"}, "must be a number"),
        ({"low": True}, "must be a number"),
        ({"freshness_floor": 1.5}, "at most 1"),
    ],
)
def test_confidence_weights_rejects(value, message):
    with pytest.raises(InvalidSetting, match=message):
        validate_confidence_weights(value)


def test_confidence_weights_accepts_defaults_shape():
    from oracle.confidence import DEFAULTS

    assert validate_confidence_weights(DEFAULTS) == DEFAULTS
    assert validate_confidence_weights({"half_life_days": {"slack": 14}}) == {
        "half_life_days": {"slack": 14}
    }


async def test_company_email_domains(client, owner):
    url = "/v1/settings/company_email_domains"
    ok = await client.put(
        url, json={"value": ["Example.COM", "@corp.example", "example.com"]}, headers=owner.headers
    )
    assert ok.status_code == 200, ok.text
    assert ok.json()["value"] == ["example.com", "corp.example"]
    for bad in (["not a domain"], "example.com", [1], ["example"], ["-x.com"]):
        resp = await client.put(url, json={"value": bad}, headers=owner.headers)
        assert resp.status_code == 422, bad


async def test_company_shared_drives(client, owner):
    url = "/v1/settings/company_shared_drives"
    ok = await client.put(
        url,
        json={"value": [{"id": "0AProduct000", "name": " Product "}, {"id": "0AProduct000"}]},
        headers=owner.headers,
    )
    assert ok.status_code == 200, ok.text
    assert ok.json()["value"] == [{"id": "0AProduct000", "name": "Product"}]
    for bad in ([{"id": "root"}], [{"id": "../x"}], [{"name": "x"}], ["0AProduct000"], {}):
        resp = await client.put(url, json={"value": bad}, headers=owner.headers)
        assert resp.status_code == 422, bad
