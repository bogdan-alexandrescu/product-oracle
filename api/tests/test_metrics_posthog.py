"""H5 Metrics review, lane 1: the PostHog connection (Settings › Analytics), the 12-week
backfill, Pull now, Test and definition versions, against a fake PostHog transport.

no_claim (every test here): the real PostHog API's shape is not exercised; the first
live connection is checked through the UI after deploy."""

import pytest
from oracle.metrics import posthog
from oracle.metrics.models import MetricValue
from sqlalchemy import select

from oracle import crypto
from oracle.integrations.models import CompanyIntegration
from oracle.tenancy import tenant_session
from tests import metrics_helpers
from tests.baseline_helpers import make_ctx
from tests.metrics_helpers import (
    KEY,
    LAST_WEEK,
    QUERY,
    connect,
    create,
    weeks_back,
)

A = "/v1/company-integrations/analytics"


# Fixtures (assigned, so ruff does not read the test arguments as redefinitions).
clock = metrics_helpers.clock
fake_posthog = metrics_helpers.fake_posthog


@pytest.fixture
async def ctx():
    return await make_ctx()


# protects=criterion 3: an owner's PUT tests the key with one query, stores it encrypted
# and returns AnalyticsOut with no key field; GET returns the same, never the key;
# fails_when=the key is stored in clear, echoed, or no test query is made; no_claim=the
# real PostHog endpoint.
async def test_connect_stores_the_key_encrypted(client, ctx, fake_posthog):
    resp = await connect(client, ctx)
    assert resp.status_code == 200, resp.text
    out = resp.json()
    assert KEY not in resp.text
    assert "api_key" not in out
    assert (out["provider"], out["host"], out["project_id"], out["status"]) == (
        "posthog", "eu", "12345", "active",
    )  # fmt: skip
    assert out["connected_by_name"] == "Owner"
    assert len(fake_posthog.requests) == 1
    sent = fake_posthog.requests[0]
    assert str(sent.url) == "https://eu.posthog.com/api/projects/12345/query/"
    assert sent.headers["authorization"] == f"Bearer {KEY}"
    async with tenant_session(ctx.tenant_id) as s:
        row = await s.scalar(select(CompanyIntegration).where(
            CompanyIntegration.provider == "posthog"))  # fmt: skip
        assert (row.purpose, row.config) == ("metrics", {"host": "eu", "project_id": "12345"})
        assert KEY.encode() not in row.ciphertext
        assert crypto.decrypt(row.ciphertext).decode() == KEY
    got = await client.get(A, headers=ctx.as_("owner"))
    assert got.status_code == 200 and KEY not in got.text
    assert got.json()["status"] == "active"


# protects=criterion 3: a refused key is 422 with the provider's message and the key
# removed; an approver is 403 on every analytics route; fails_when=the key leaks in the
# error, a refused key is stored, or an approver connects; no_claim=audit rows.
async def test_refused_key_and_roles(client, ctx, fake_posthog):
    fake_posthog.refuse_key = "Invalid personal API key"
    resp = await connect(client, ctx)
    assert resp.status_code == 422
    assert "Invalid personal API key" in resp.text
    assert KEY not in resp.text
    async with tenant_session(ctx.tenant_id) as s:
        assert await s.scalar(select(CompanyIntegration)) is None
    body = {"provider": "posthog", "host": "eu", "project_id": "1", "api_key": KEY}
    assert (await client.put(A, json=body, headers=ctx.as_("approver"))).status_code == 403
    assert (await client.get(A, headers=ctx.as_("approver"))).status_code == 403
    assert (await client.delete(A, headers=ctx.as_("approver"))).status_code == 403


# protects=criterion 3: an own host resolving to 10.0.0.5 is 422 and no request leaves;
# an http host is 422; fails_when=a private address is queried; no_claim=DNS rebinding
# between the check and the connect (guarded_transport checks each connect).
async def test_an_own_host_must_be_public_https(client, ctx, fake_posthog, monkeypatch):
    async def private(host, port):
        return ["10.0.0.5"]

    monkeypatch.setattr(posthog, "resolve", private)
    resp = await connect(client, ctx, host="https://analytics.example.com")
    assert resp.status_code == 422, resp.text
    assert fake_posthog.requests == []
    resp = await connect(client, ctx, host="http://analytics.example.com")
    assert resp.status_code == 422
    assert fake_posthog.requests == []

    async def public(host, port):
        return ["93.184.216.34"]

    monkeypatch.setattr(posthog, "resolve", public)
    resp = await connect(client, ctx, host="https://analytics.example.com")
    assert resp.status_code == 200, resp.text
    assert str(fake_posthog.requests[0].url).startswith("https://analytics.example.com/api/")


# protects=criterion 4: a PostHog metric created by an approver backfills the last 12
# complete weeks (12 metric_values at version 1, one query per week with its bounds);
# editing the query bumps definition_version, Pull now replaces last week's value at
# version 2, and get_metric lists the definition change; fails_when=the backfill stores
# another count, a value keeps the old version, or the change is not listed;
# no_claim=chart rendering.
async def test_backfill_and_definition_versions(client, ctx, clock, fake_posthog):
    assert (await connect(client, ctx)).status_code == 200
    weeks = weeks_back(12)
    fake_posthog.values = {w: 300 + 10 * i for i, w in enumerate(weeks)}
    resp = await create(client, ctx, source="posthog", query=QUERY)
    assert resp.status_code == 201, resp.text
    metric = resp.json()
    assert metric["definition_version"] == 1
    assert metric["last_week"] == {"week_start": LAST_WEEK.isoformat(), "value": 410}
    async with tenant_session(ctx.tenant_id) as s:
        rows = list(await s.scalars(select(MetricValue).order_by(MetricValue.week_start)))
    assert [r.week_start for r in rows] == weeks
    assert {r.definition_version for r in rows} == {1}
    assert {r.source for r in rows} == {"posthog"}
    assert all("{period_start}" not in q for q in fake_posthog.queries()[1:])

    url = f"/v1/metrics/{metric['id']}"
    resp = await client.patch(url, json={"query": QUERY + " AND event = 'login'",
                                         "lock_version": metric["lock_version"]},
                              headers=ctx.as_("approver"))  # fmt: skip
    assert resp.status_code == 200, resp.text
    assert resp.json()["definition_version"] == 2
    fake_posthog.values[LAST_WEEK] = 999
    assert (await client.post(f"{url}/pull", headers=ctx.as_("commenter"))).status_code == 403
    resp = await client.post(f"{url}/pull", headers=ctx.as_("approver"))
    assert resp.status_code == 200, resp.text
    assert resp.json()["last_week"]["value"] == 999
    got = (await client.get(url, headers=ctx.as_("viewer"))).json()
    last = got["values"][-1]
    assert (last["week_start"], last["value"], last["definition_version"]) == (
        LAST_WEEK.isoformat(), 999, 2,
    )  # fmt: skip
    assert [d["version"] for d in got["definitions"]] == [1, 2]
    assert got["definitions"][1]["query"].endswith("event = 'login'")
    # A title edit is no definition change.
    edit = {"title": "Active teams", "lock_version": got["lock_version"]}
    resp = await client.patch(url, json=edit, headers=ctx.as_("approver"))
    assert resp.status_code == 200, resp.text
    assert resp.json()["definition_version"] == 2


# protects=Pull now's 502 carries the provider's message (no key) and stores nothing;
# Test shows the last 4 weeks' values and stores nothing; fails_when=a failed pull
# replaces the value or Test writes rows; no_claim=the ticker's retries.
async def test_pull_failure_and_test_query(client, ctx, clock, fake_posthog):
    assert (await connect(client, ctx)).status_code == 200
    metric = (await create(client, ctx, source="posthog", query=QUERY)).json()
    fake_posthog.status = 500
    resp = await client.post(f"/v1/metrics/{metric['id']}/pull", headers=ctx.as_("approver"))
    assert resp.status_code == 502
    assert "Query failed upstream" in resp.text and KEY not in resp.text
    fake_posthog.status = 200
    fake_posthog.values = {w: 7 for w in weeks_back(4)}
    before = len(fake_posthog.requests)
    resp = await client.post("/v1/metrics/test", json={"query": QUERY},
                             headers=ctx.as_("approver"))  # fmt: skip
    assert resp.status_code == 200, resp.text
    got = resp.json()
    assert [v["week_start"] for v in got["values"]] == [w.isoformat() for w in weeks_back(4)]
    assert {v["value"] for v in got["values"]} == {7}
    assert got["error"] is None
    assert len(fake_posthog.requests) == before + 4
    async with tenant_session(ctx.tenant_id) as s:
        assert len(list(await s.scalars(select(MetricValue)))) == 12
    resp = await client.post("/v1/metrics/test", json={"query": QUERY},
                             headers=ctx.as_("commenter"))  # fmt: skip
    assert resp.status_code == 403


# protects=Disconnect deletes the key and pauses PostHog metrics ("Analytics
# disconnected"); a PostHog metric cannot be created without a connection;
# fails_when=the key survives or metrics keep pulling; no_claim=the confirmation's count.
async def test_disconnect_pauses_posthog_metrics(client, ctx, clock, fake_posthog):
    resp = await create(client, ctx, source="posthog", query=QUERY)
    assert resp.status_code == 409
    assert (await connect(client, ctx)).status_code == 200
    metric = (await create(client, ctx, source="posthog", query=QUERY)).json()
    manual = (await create(client, ctx, title="Seats sold")).json()
    assert (await client.get(A, headers=ctx.as_("owner"))).json()["metrics"] == 1
    assert (await client.delete(A, headers=ctx.as_("owner"))).status_code == 204
    async with tenant_session(ctx.tenant_id) as s:
        assert await s.scalar(select(CompanyIntegration)) is None
    got = (await client.get(f"/v1/metrics/{metric['id']}", headers=ctx.as_("viewer"))).json()
    assert (got["status"], got["last_error"]) == ("paused", "Analytics disconnected")
    got = (await client.get(f"/v1/metrics/{manual['id']}", headers=ctx.as_("viewer"))).json()
    assert got["status"] == "active"
    assert (await client.get(A, headers=ctx.as_("owner"))).json()["status"] == "disconnected"
    assert (await connect(client, ctx)).status_code == 200
    got = (await client.get(f"/v1/metrics/{metric['id']}", headers=ctx.as_("viewer"))).json()
    assert (got["status"], got["last_error"]) == ("active", None)
