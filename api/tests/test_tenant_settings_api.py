"""Company settings: owner only, each known key validated."""

from datetime import date

import pytest
from sqlalchemy import select

from oracle.models import AuditEvent
from oracle.tenancy import tenant_session
from oracle.tenant_settings_api import (
    DEFAULTS,
    InvalidSetting,
    horizon_windows,
    validate_confidence_weights,
)
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
        # H1: hard-to-reverse decisions are an owner's call by default.
        "decision_irreversible_role": "owner",
        "company_email_domains": [],
        "company_shared_drives": [],
        # A1: the B2 Goals framework horizons, until an owner confirms or changes them.
        "planning_horizons": {
            "short_quarters": 1,
            "medium_quarters": 2,
            "long_from_months": 12,
            "long_to_months": 24,
        },
        # F6: the weekly alignment report, Monday 08:00 Pacific, no Slack channel yet.
        "alignment_report": {
            "enabled": True,
            "weekday": "mon",
            "time": "08:00",
            "timezone": "America/Los_Angeles",
            "slack_channel": None,
        },
        # H11: every responsibility at its default (written through /v1/autonomy).
        "autonomy": {},
        # #336: the company's day ("today") is UTC's until an owner sets the zone.
        "company_timezone": "UTC",
    }
    assert all(s["is_default"] for s in listed)
    assert (await client.get("/v1/settings/nope", headers=owner.headers)).status_code == 404
    put = await client.put("/v1/settings/nope", json={"value": 1}, headers=owner.headers)
    assert put.status_code == 404


@pytest.mark.parametrize("bad", ["Mars/Olympus", "", " UTC", 7, None])
async def test_company_timezone_is_an_iana_zone(client, owner, bad):
    put = await client.put(
        "/v1/settings/company_timezone",
        json={"value": "America/Los_Angeles"},
        headers=owner.headers,
    )
    assert put.status_code == 200 and put.json()["value"] == "America/Los_Angeles"
    resp = await client.put(
        "/v1/settings/company_timezone", json={"value": bad}, headers=owner.headers
    )
    if bad is None:  # a reset
        assert resp.status_code == 200 and resp.json()["value"] == "UTC"
    else:
        assert resp.status_code == 422 and "time zone" in resp.json()["detail"]


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


# --- A1: planning_horizons ------------------------------------------------------------

HORIZONS = {"short_quarters": 1, "medium_quarters": 2, "long_from_months": 12, "long_to_months": 24}
SHAPE = (
    "planning_horizons needs short_quarters, medium_quarters, long_from_months and "
    "long_to_months as whole numbers"
)


async def test_planning_horizons_confirm_and_reset(client, tenant_id, owner):
    # protects=Confirm stores the defaults as a row, Reset removes it (owner only);
    # fails_when=confirming leaves is_default true or a non-owner may store it;
    # no_claim=UI copy.
    approver = await make_person(tenant_id, "approver@example.com", "approver")
    url = "/v1/settings/planning_horizons"
    assert (
        await client.put(url, json={"value": HORIZONS}, headers=approver.headers)
    ).status_code == 403
    got = (await client.get(url, headers=owner.headers)).json()
    assert got["value"] == HORIZONS and got["is_default"] is True
    put = await client.put(url, json={"value": HORIZONS}, headers=owner.headers)
    assert put.status_code == 200, put.text
    assert put.json()["value"] == HORIZONS and put.json()["is_default"] is False
    reset = await client.put(url, json={"value": None}, headers=owner.headers)
    assert reset.json()["is_default"] is True and reset.json()["value"] == HORIZONS


@pytest.mark.parametrize(
    "change, message",
    [
        ({"short_quarters": 3}, "short_quarters must be 1 or 2"),
        ({"medium_quarters": 0}, "medium_quarters must be between 1 and 4"),
        (
            {"long_from_months": 6},
            "long_from_months must start after Next ends (at least 9 months) and be at most 36",
        ),
        ({"long_to_months": 12}, "long_to_months must be after long_from_months and at most 60"),
        ({"extra": 1}, SHAPE),
        ({"short_quarters": True}, SHAPE),
    ],
)
async def test_planning_horizons_validation(client, owner, change, message):
    # protects=only a typed, coherent horizon set is stored; fails_when=a bad value is
    # stored or the message does not say what to fix; no_claim=UI copy.
    url = "/v1/settings/planning_horizons"
    resp = await client.put(url, json={"value": {**HORIZONS, **change}}, headers=owner.headers)
    assert resp.status_code == 422, resp.text
    assert resp.json()["detail"] == message
    assert (await client.get(url, headers=owner.headers)).json()["is_default"] is True


def test_horizon_windows_with_the_defaults():
    # protects=one way to turn horizons into dates for later picks; fails_when=a window
    # starts or ends on the wrong day; no_claim=agents use them.
    windows = horizon_windows(DEFAULTS["planning_horizons"], date(2026, 10, 20))
    assert windows == {
        "short": (date(2026, 10, 1), date(2026, 12, 31)),
        "medium": (date(2027, 1, 1), date(2027, 6, 30)),
        "long": (date(2027, 10, 20), date(2028, 10, 20)),
    }
