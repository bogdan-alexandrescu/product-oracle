"""The account pool's routes: role checks, both ways in, the listing, holders and history,
removal and the fallback credential, mirroring SwarmCloud's test_account_api.py,
test_account_signin.py, test_account_listing_is_honest.py and test_account_hold_log.py."""

from datetime import UTC, datetime, timedelta
from urllib.parse import parse_qs, urlsplit

import pytest
from sqlalchemy import select

from oracle.auth.service import create_api_token
from oracle.claude_accounts import store, sweep
from oracle.claude_accounts.fallback import API_KEY_PREFIX, PLAN_TOKEN_PREFIX
from oracle.claude_accounts.models import ClaudeAccountHold, ClaudeAccountSignin
from oracle.models import AuditEvent
from oracle.tenancy import tenant_session
from tests.claude_account_helpers import FakeEndpoint, add_account, edit_row, now, pair, window
from tests.connection_helpers import make_person

BASE = "/v1/claude-accounts"


@pytest.fixture
async def owner(tenant_id):
    return await make_person(tenant_id, "owner@example.com", "owner")


@pytest.fixture
def endpoint():
    fake = FakeEndpoint()
    previous = sweep.set_token_endpoint(fake)
    yield fake
    sweep.set_token_endpoint(previous)


async def test_every_member_reads_and_only_an_owner_changes(client, tenant_id, owner):
    a = await add_account(tenant_id, "work")
    for role in ("viewer", "commenter", "approver"):
        person = await make_person(tenant_id, f"{role}@example.com", role)
        assert (await client.get(BASE, headers=person.headers)).status_code == 200
        holders = await client.get(f"{BASE}/{a.account_id}/holders", headers=person.headers)
        assert holders.status_code == 200
        for method, url, body in [
            ("POST", BASE, {"label": "x", "credential": pair()}),
            ("POST", f"{BASE}/authorize", {"label": "x"}),
            ("POST", f"{BASE}/exchange", {"state": "s" * 43, "code": "code"}),
            ("PUT", f"{BASE}/{a.account_id}/state", {"state": "PAUSED", "reason": "x"}),
            ("POST", f"{BASE}/{a.account_id}/refresh", None),
            ("DELETE", f"{BASE}/{a.account_id}", None),
            ("PUT", f"{BASE}/fallback", {"token": PLAN_TOKEN_PREFIX + "01-xxxxxxxx"}),
            ("DELETE", f"{BASE}/fallback", None),
            ("POST", f"{BASE}/sweep", None),
        ]:
            resp = await client.request(method, url, json=body, headers=person.headers)
            assert resp.status_code == 403, (role, method, url)
    assert (await client.get(BASE)).status_code == 401


async def test_the_paste_route_needs_a_refresh_token_and_returns_no_key_material(
    client, tenant_id, owner
):
    no_refresh = await client.post(
        BASE, json={"label": "work", "credential": '{"accessToken": "a-only"}'},
        headers=owner.headers,
    )  # fmt: skip
    assert no_refresh.status_code == 422
    assert "refresh token" in no_refresh.json()["detail"]
    bad_label = await client.post(
        BASE, json={"label": "Work Account", "credential": pair()}, headers=owner.headers
    )
    assert bad_label.status_code == 422

    resp = await client.post(
        BASE, json={"label": "work", "credential": pair("acc-pasted", "ref-pasted")},
        headers=owner.headers,
    )  # fmt: skip
    assert resp.status_code == 201
    body = resp.json()
    assert body["account"]["label"] == "work" and body["account"]["state"] == "AVAILABLE"
    assert "acc-pasted" not in resp.text and "ref-pasted" not in resp.text
    listed = await client.get(BASE, headers=owner.headers)
    assert "acc-pasted" not in listed.text and "ref-pasted" not in listed.text
    account_id = body["account"]["account_id"]
    assert await store.DbSecretStore(tenant_id).access(account_id) == "acc-pasted"
    async with tenant_session(tenant_id) as s:
        assert "claude_account.add" in (await s.scalars(select(AuditEvent.action))).all()


async def test_the_browser_sign_in_end_to_end(client, tenant_id, owner, endpoint):
    started = await client.post(
        f"{BASE}/authorize", json={"label": "personal"}, headers=owner.headers
    )
    assert started.status_code == 200
    s = started.json()
    assert s["expires_in_seconds"] == 900
    query = parse_qs(urlsplit(s["authorize_url"]).query)
    assert query["state"] == [s["state"]]
    async with tenant_session(tenant_id) as db:
        pending = await db.scalar(select(ClaudeAccountSignin))
    assert pending.label == "personal"
    # The verifier never leaves the server: only its challenge is in the URL.
    assert pending.verifier not in s["authorize_url"]

    # Pasted as the callback page shows it: code#state.
    resp = await client.post(
        f"{BASE}/exchange", json={"state": s["state"], "code": f"c0de#{s['state']}"},
        headers=owner.headers,
    )  # fmt: skip
    assert resp.status_code == 201, resp.text
    assert resp.json()["account"]["label"] == "personal"
    assert endpoint.redeemed == [
        {
            "code": "c0de",
            "verifier": pending.verifier,
            "redirect_uri": "https://platform.claude.com/oauth/code/callback",
            "state": s["state"],
        }
    ]
    again = await client.post(
        f"{BASE}/exchange", json={"state": s["state"], "code": "c0de"}, headers=owner.headers
    )
    assert again.status_code == 422 and "single-use" in again.json()["detail"]


async def test_only_whoever_started_a_sign_in_can_finish_it(client, tenant_id, owner, endpoint):
    other = await make_person(tenant_id, "other-owner@example.com", "owner")
    s = (await client.post(f"{BASE}/authorize", json={"label": "x"}, headers=owner.headers)).json()
    refused = await client.post(
        f"{BASE}/exchange", json={"state": s["state"], "code": "c0de"}, headers=other.headers
    )
    assert refused.status_code == 403
    # Nothing was redeemed and the sign-in still works for its owner.
    assert endpoint.redeemed == []
    ok = await client.post(
        f"{BASE}/exchange", json={"state": s["state"], "code": "c0de"}, headers=owner.headers
    )
    assert ok.status_code == 201


async def test_a_wrong_state_a_bad_code_and_a_slow_sign_in(client, tenant_id, owner, endpoint):
    s = (await client.post(f"{BASE}/authorize", json={"label": "x"}, headers=owner.headers)).json()
    mismatch = await client.post(
        f"{BASE}/exchange", json={"state": s["state"], "code": "c0de#other-state"},
        headers=owner.headers,
    )  # fmt: skip
    assert mismatch.status_code == 422 and "different sign-in" in mismatch.json()["detail"]
    bad = await client.post(
        f"{BASE}/exchange", json={"state": s["state"], "code": "bad-code"}, headers=owner.headers
    )
    assert bad.status_code == 422
    # A failed redemption keeps the pending sign-in, so the person can paste again.
    async with tenant_session(tenant_id) as db:
        row = await db.scalar(select(ClaudeAccountSignin))
        row.created_at = datetime.now(UTC) - timedelta(minutes=16)
        await db.commit()
    slow = await client.post(
        f"{BASE}/exchange", json={"state": s["state"], "code": "c0de"}, headers=owner.headers
    )
    assert slow.status_code == 422 and "too long" in slow.json()["detail"]


async def test_the_listing_is_honest_about_staleness_and_absence(client, tenant_id, owner):
    await add_account(tenant_id, "never")
    await add_account(tenant_id, "live", windows={"five_hour": window(0.4)})
    await add_account(
        tenant_id, "old", windows={"seven_day": window(0.2)}, observed_at=now() - timedelta(hours=2)
    )
    page = (await client.get(BASE, headers=owner.headers)).json()
    by = {a["label"]: a for a in page["accounts"]}
    assert by["never"]["observed_at"] is None and by["never"]["stale"] is True
    assert by["never"]["windows"] == {} and by["never"]["last_assigned_at"] is None
    assert by["live"]["stale"] is False
    assert by["live"]["windows"]["five_hour"] | {"resets_at": None} == {
        "utilization": 0.4,
        "resets_at": None,
        "reset": False,
    }
    assert by["old"]["stale"] is True
    assert page["unreadable_document_count"] == 0 and page["fallback"] is None


async def test_state_changes_drain_and_audit(client, tenant_id, owner):
    a = await add_account(tenant_id, "work")
    await store.acquire_hold(tenant_id, a.account_id, now=now(), task_id="reporting")
    url = f"{BASE}/{a.account_id}/state"
    bad = await client.put(url, json={"state": "SLEEPING"}, headers=owner.headers)
    assert bad.status_code == 422 and "AVAILABLE" in bad.json()["detail"]
    resp = await client.put(
        url, json={"state": "draining", "reason": "retire"}, headers=owner.headers
    )
    assert resp.status_code == 200
    assert resp.json()["moving"] == 1
    assert resp.json()["account"]["state"] == "DRAINING"
    assert resp.json()["account"]["reason"] == "retire"
    holders = (await client.get(f"{BASE}/{a.account_id}/holders", headers=owner.headers)).json()
    assert holders["total"] == 1 and holders["holders"][0]["move"] == "drain"
    assert holders["holders"][0]["task_id"] == "reporting"
    assert "assignment_id" not in str(holders)
    unknown = await client.put(
        f"{BASE}/not-an-id/state", json={"state": "PAUSED"}, headers=owner.headers
    )
    assert unknown.status_code == 404


async def test_an_expired_hold_is_not_served_as_a_holder_even_before_the_sweep(
    client, tenant_id, owner
):
    a = await add_account(tenant_id, "work")
    await store.acquire_hold(tenant_id, a.account_id, now=now() - timedelta(hours=4))
    holders = (await client.get(f"{BASE}/{a.account_id}/holders", headers=owner.headers)).json()
    assert holders["total"] == 0


async def test_history_pages_without_losing_spans_that_share_an_instant(client, tenant_id, owner):
    a = await add_account(tenant_id, "work")
    t = now() - timedelta(hours=1)
    ids = []
    for i in range(5):
        at = t if i < 3 else t + timedelta(minutes=i)
        hold_id, _ = await store.acquire_hold(tenant_id, a.account_id, now=at, task_id="reporting")
        ids.append(hold_id)
    await store.release_hold(tenant_id, a.account_id, assignment_id=ids[4], now=now())
    url = f"{BASE}/{a.account_id}/history"
    seen: list[str | None] = []
    cursor = None
    while True:
        params = {"limit": "2", **({"cursor": cursor} if cursor else {})}
        page = (await client.get(url, params=params, headers=owner.headers)).json()
        seen += [s["since"] for s in page["spans"]]
        cursor = page["next_cursor"]
        if not cursor:
            break
    assert len(seen) == 5
    assert seen == sorted(seen, reverse=True)
    first = (await client.get(url, headers=owner.headers)).json()
    assert first["spans"][0]["end"] == "released"
    assert "from" in first and first["spans"][1]["end"] is None


@pytest.mark.parametrize(
    "params",
    [
        {"cursor": "nonsense"},
        {"cursor": "2026-10-18T00:00:00+00:00|99999"},
        {"cursor": "2026-10-18T00:00:00+00:00|٣"},
        {"from": "0001-01-01T00:00:00+01:00"},
        {"to": "9999-12-31T23:59:59-01:00"},
        {"from": "2026-10-18T00:00:00"},
    ],
)
async def test_a_malformed_window_or_cursor_is_a_422_never_a_500(client, tenant_id, owner, params):
    a = await add_account(tenant_id, "work")
    resp = await client.get(f"{BASE}/{a.account_id}/history", params=params, headers=owner.headers)
    assert resp.status_code == 422


async def test_a_window_longer_than_the_retention_is_a_422(client, tenant_id, owner):
    a = await add_account(tenant_id, "work")
    params = {
        "from": (now() - timedelta(days=91)).isoformat(),
        "to": now().isoformat(),
    }
    resp = await client.get(f"{BASE}/{a.account_id}/history", params=params, headers=owner.headers)
    assert resp.status_code == 422


async def test_removing_an_account_closes_its_holds_and_deletes_its_credential(
    client, tenant_id, owner
):
    a = await add_account(tenant_id, "work")
    await store.acquire_hold(tenant_id, a.account_id, now=now())
    resp = await client.delete(f"{BASE}/{a.account_id}", headers=owner.headers)
    assert resp.status_code == 200
    assert resp.json() == {
        "removed": a.account_id,
        "label": "work",
        "closed_holds": 1,
        "credential": "deleted",
    }
    async with tenant_session(tenant_id) as s:
        record = await s.scalar(select(ClaudeAccountHold))
    assert record.end == "account_removed"
    assert (await client.get(BASE, headers=owner.headers)).json()["accounts"] == []
    assert (await client.delete(f"{BASE}/{a.account_id}", headers=owner.headers)).status_code == 404


async def test_another_companys_account_is_not_found(client, tenant_id, owner):
    from tests.conftest import make_tenant

    other = await make_tenant("Other Co")
    theirs = await add_account(other, "theirs")
    for method, url in [
        ("GET", f"{BASE}/{theirs.account_id}/holders"),
        ("DELETE", f"{BASE}/{theirs.account_id}"),
    ]:
        assert (await client.request(method, url, headers=owner.headers)).status_code == 404
    assert (await client.get(BASE, headers=owner.headers)).json()["accounts"] == []


async def test_the_fallback_credential_is_write_only(client, tenant_id, owner):
    url = f"{BASE}/fallback"
    refused = await client.put(url, json={"token": "not-a-claude-token"}, headers=owner.headers)
    assert refused.status_code == 422 and "Not a Claude credential" in refused.json()["detail"]
    token = PLAN_TOKEN_PREFIX + "01-example-abcd"
    ok = await client.put(url, json={"token": token}, headers=owner.headers)
    assert ok.status_code == 200
    assert ok.json()["kind"] == "plan" and ok.json()["label"] == "Claude setup-token …abcd"
    page = await client.get(BASE, headers=owner.headers)
    assert page.json()["fallback"]["kind"] == "plan" and token not in page.text
    key = API_KEY_PREFIX + "03-key-wxyz"
    assert (await client.put(url, json={"token": key}, headers=owner.headers)).json()[
        "kind"
    ] == "api_key"
    assert (await client.delete(url, headers=owner.headers)).status_code == 204
    assert (await client.get(BASE, headers=owner.headers)).json()["fallback"] is None


async def test_an_api_token_with_the_owner_role_can_manage_the_pool(client, tenant_id):
    async with tenant_session(tenant_id) as s:
        _, raw = await create_api_token(s, "cli")  # tokens default to owner
        await s.commit()
    headers = {"Authorization": f"Bearer {raw}"}
    resp = await client.post(BASE, json={"label": "cli", "credential": pair()}, headers=headers)
    assert resp.status_code == 201


async def test_tick_sweeps_the_pool(client, tenant_id, owner, endpoint):
    from oracle.claude_accounts.usage import UsageUnavailable

    async def fetch(token):
        raise UsageUnavailable("offline")

    previous = sweep.set_usage_fetch(fetch)
    try:
        a = await add_account(tenant_id, "work", expires_in=timedelta(hours=1))
        await edit_row(tenant_id, a.account_id)
        await store.acquire_hold(tenant_id, a.account_id, now=now() - timedelta(hours=5))
        out = (await client.post("/v1/internal/tick", headers=owner.headers)).json()
    finally:
        sweep.set_usage_fetch(previous)
    assert out["claude_accounts"]["reclaimed"] == 1
    assert out["claude_accounts"]["refreshed"] == 1
    assert out["claude_accounts"]["lease"] == "ran"


async def test_the_sweep_forgets_sign_ins_nobody_finished(client, tenant_id, owner):
    await client.post(f"{BASE}/authorize", json={"label": "x"}, headers=owner.headers)
    async with tenant_session(tenant_id) as db:
        row = await db.scalar(select(ClaudeAccountSignin))
        row.created_at = datetime.now(UTC) - timedelta(minutes=16)
        await db.commit()
    await sweep.prune_all_holds(tenant_id, now())
    async with tenant_session(tenant_id) as db:
        assert await db.scalar(select(ClaudeAccountSignin)) is None


# --- the state the pool decides by (#403) -------------------------------------------


async def test_an_account_over_its_weekly_limit_reads_spent_as_the_pool_decides(
    client, tenant_id, owner
):
    from oracle.claude_accounts.accounts import choose, eligibility

    spent = await add_account(
        tenant_id,
        "weekly",
        windows={
            "five_hour": window(0.09),
            "seven_day": window(0.95, timedelta(days=2, hours=13)),
        },
    )
    page = (await client.get(BASE, headers=owner.headers)).json()
    served = page["accounts"][0]
    at = now()
    assert served["state"] == "AVAILABLE"
    assert served["takes_calls"] is (choose([spent], at) is not None) is False
    reason, until = eligibility([spent], at)
    assert served["spent_by"] == "seven_day"
    assert datetime.fromisoformat(served["spent_until"]) == until
    assert page["pool"] == {
        "takes_calls": False,
        "reason": reason.value,
        "until": served["spent_until"],
    }
    assert reason.value == "no_account_available"
    assert page["time_zone"] == "America/Los_Angeles"


async def test_an_account_with_room_takes_calls_and_the_pool_with_it(client, tenant_id, owner):
    await add_account(tenant_id, "roomy", windows={"five_hour": window(0.3)})
    await add_account(tenant_id, "five-hour", windows={"five_hour": window(0.9)})
    page = (await client.get(BASE, headers=owner.headers)).json()
    by = {a["label"]: a for a in page["accounts"]}
    assert by["roomy"]["takes_calls"] is True and by["roomy"]["spent_until"] is None
    assert by["roomy"]["spent_by"] is None
    assert by["five-hour"]["takes_calls"] is False and by["five-hour"]["spent_by"] == "five_hour"
    assert page["pool"] == {"takes_calls": True, "reason": None, "until": None}


async def test_a_paused_account_is_not_spent_and_a_paused_pool_takes_no_calls(
    client, tenant_id, owner
):
    from oracle.claude_accounts.accounts import AccountState

    await add_account(tenant_id, "resting", state=AccountState.PAUSED)
    page = (await client.get(BASE, headers=owner.headers)).json()
    served = page["accounts"][0]
    assert served["takes_calls"] is False and served["spent_until"] is None
    assert page["pool"] == {"takes_calls": False, "reason": "pool_paused", "until": None}


async def test_with_no_account_the_pool_takes_calls_only_through_a_fallback(
    client, tenant_id, owner
):
    empty = (await client.get(BASE, headers=owner.headers)).json()
    assert empty["pool"] == {
        "takes_calls": False,
        "reason": "no_accounts_registered",
        "until": None,
    }
    put = await client.put(
        f"{BASE}/fallback", json={"token": PLAN_TOKEN_PREFIX + "01-xxxxxxxx"}, headers=owner.headers
    )
    assert put.status_code == 200
    covered = (await client.get(BASE, headers=owner.headers)).json()
    assert covered["pool"] == {"takes_calls": True, "reason": None, "until": None}


async def test_the_page_gives_the_company_time_zone(client, tenant_id, owner):
    put = await client.put(
        "/v1/settings/alignment_report",
        json={"value": {"timezone": "Europe/Berlin"}},
        headers=owner.headers,
    )
    assert put.status_code == 200, put.text
    viewer = await make_person(tenant_id, "viewer@example.com", "viewer")
    page = (await client.get(BASE, headers=viewer.headers)).json()
    assert page["time_zone"] == "Europe/Berlin"
