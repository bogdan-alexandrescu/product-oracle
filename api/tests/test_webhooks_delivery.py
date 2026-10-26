"""I1 lane 2: delivery (spec-I1 "Signing", "Where Oracle may send", "Delivery, retries and
backoff", "Delivery log", "Owners-and-approvers events never reach a member's webhook";
owner answers Q2, Q4 as changed on 2026-10-25, Q5 and Q6). The receiver is a fake
transport (``outbox.set_transport``); the clock is the ``now`` each tick is given.
Invented data only."""

import asyncio
import base64
import hashlib
import hmac
import json
import time
import uuid
from datetime import UTC, datetime, timedelta

import httpx
import pytest
from sqlalchemy import select, update

from oracle import readiness
from oracle.docs.models import Document
from oracle.review.models import Notification
from oracle.runs.models import Checkpoint, Run
from oracle.tenancy import tenant_session
from oracle.webhooks import outbox, retention, sign
from oracle.webhooks import service as webhooks
from oracle.webhooks.models import Webhook, WebhookDelivery, WebhookEvent
from tests.connection_helpers import make_person
from tests.test_mcp import api_token, mcp_client, run_token, text_of

URL = "https://hooks.example.test/oracle"
OTHER = "https://other.example.test/in"


@pytest.fixture(autouse=True)
def _only_test_checks():
    with readiness.isolated_checks():
        yield


class Receiver:
    """A fake receiver: answers by host from ``answers`` (a status, a Response, or a
    callable), and keeps every request it got."""

    def __init__(self) -> None:
        self.got: list[httpx.Request] = []
        self.answers: dict[str, object] = {}

    async def __call__(self, request: httpx.Request) -> httpx.Response:
        self.got.append(request)
        answer = self.answers.get(request.url.host, 200)
        if callable(answer):
            answer = answer(request)
            if asyncio.iscoroutine(answer):
                answer = await answer
        if isinstance(answer, httpx.Response):
            return answer
        return httpx.Response(int(answer), text="ok")

    def to(self, host: str) -> list[httpx.Request]:
        return [r for r in self.got if r.url.host == host]


@pytest.fixture
def receiver():
    r = Receiver()
    previous = outbox.set_transport(httpx.MockTransport(r))
    yield r
    outbox.set_transport(previous)


@pytest.fixture
async def owner(tenant_id):
    return await make_person(tenant_id, "owner@example.com", "owner")


@pytest.fixture
async def approver(tenant_id):
    return await make_person(tenant_id, "approver@example.com", "approver")


def bearer(raw: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {raw}"}


async def hook(client, headers, types=("run.started",), url=URL, **extra) -> dict:
    resp = await client.post(
        "/v1/webhooks",
        json={"name": "Team bot", "url": url, "event_types": list(types), **extra},
        headers=headers,
    )
    assert resp.status_code == 201, resp.text
    return resp.json()


async def subjects(tenant_id, visibility: str = "company") -> dict[str, str]:
    async with tenant_session(tenant_id) as s:
        doc = Document(
            slug=f"d-{uuid.uuid4().hex[:6]}",
            title="Checkout redesign",
            kind="prd",
            visibility=visibility,
        )
        s.add(doc)
        await s.flush()
        run = Run(flow="baseline_to_prd", document_id=doc.id, status="running")
        s.add(run)
        await s.flush()
        cp = Checkpoint(
            run_id=run.id, kind="prd_review", status="pending", approver_role="approver"
        )
        s.add(cp)
        await s.commit()
        return {"document_id": str(doc.id), "run_id": str(run.id), "checkpoint_id": str(cp.id)}


async def capture(tenant_id, event_type: str, actor=None, **subject) -> WebhookEvent | None:
    async with tenant_session(tenant_id) as s:
        row = await webhooks.capture(s, event_type, actor, **subject)
        await s.commit()
        return row


async def deliveries(tenant_id, webhook_id=None) -> list[WebhookDelivery]:
    async with tenant_session(tenant_id) as s:
        stmt = select(WebhookDelivery).order_by(WebhookDelivery.created_at)
        if webhook_id is not None:
            stmt = stmt.where(WebhookDelivery.webhook_id == uuid.UUID(str(webhook_id)))
        return list(await s.scalars(stmt))


async def a_hook(tenant_id, webhook_id) -> Webhook:
    async with tenant_session(tenant_id) as s:
        return await s.get(Webhook, uuid.UUID(str(webhook_id)))


def verify(secret: str, request: httpx.Request) -> bool:
    """The Standard Webhooks check a receiver makes, written out (no Oracle code)."""
    key = base64.b64decode(secret.removeprefix("whsec_"))
    msg_id = request.headers["webhook-id"]
    ts = request.headers["webhook-timestamp"]
    signed = f"{msg_id}.{ts}.".encode() + request.content
    want = base64.b64encode(hmac.new(key, signed, hashlib.sha256).digest()).decode()
    got = [p.split(",", 1)[1] for p in request.headers["webhook-signature"].split(" ")]
    return any(hmac.compare_digest(want, g) for g in got)


def later(**delta) -> datetime:
    return datetime.now(UTC) + timedelta(**delta)


# --- signing --------------------------------------------------------------------------------


def test_the_signature_is_standard_webhooks_hmac_sha256():
    """protects=spec Signing (Standard Webhooks, so receivers can use its libraries);
    fails_when=the key, the signed content or the header format differ."""
    secret = "whsec_" + base64.b64encode(b"k" * 32).decode()
    body = b'{"id":"evt_1"}'
    got = sign.sign(secret, "evt_1", 1_700_000_000, body)
    key = b"k" * 32
    mac = hmac.new(key, b"evt_1.1700000000." + body, hashlib.sha256).digest()
    assert got == "v1," + base64.b64encode(mac).decode()
    assert sign.sign(secret, "evt_1", 1_700_000_000, body + b" ") != got


async def test_a_test_event_reaches_the_receiver_signed_and_is_logged(
    client, tenant_id, owner, receiver
):
    """protects=AC2: Send test event reaches the receiver at once; the log shows 200 with
    the body sent; the signature verifies with the secret and fails on a changed body;
    fails_when=no call, a bad signature, or no log row."""
    made = await hook(client, owner.headers)
    secret, hid = made["secret"], made["webhook"]["id"]
    resp = await client.post(f"/v1/webhooks/{hid}/test", headers=owner.headers)
    assert resp.status_code == 200, resp.text
    out = resp.json()
    assert out["status"] == "succeeded" and out["http_status"] == 200
    assert out["event_type"] == "webhook.test"
    assert out["body"]["data"] == {"message": "Test from Product Oracle"}
    (req,) = receiver.got
    assert req.method == "POST" and str(req.url) == URL
    assert req.headers["webhook-id"] == out["event_id"] and out["event_id"].startswith("evt_")
    assert abs(int(req.headers["webhook-timestamp"]) - time.time()) < 60
    assert req.headers["user-agent"] == "ProductOracle-Webhooks/1"
    assert req.headers["content-type"] == "application/json"
    assert json.loads(req.content) == out["body"]
    assert verify(secret, req)
    changed = httpx.Request("POST", URL, headers=req.headers, content=req.content + b" ")
    assert not verify(secret, changed)
    log = await client.get(f"/v1/webhooks/{hid}/deliveries", headers=owner.headers)
    assert [d["status"] for d in log.json()["items"]] == ["succeeded"]
    assert "whsec_" not in log.text and "whsec_" not in resp.text


async def test_rotation_signs_with_both_secrets_for_24_hours_then_only_the_new(
    client, tenant_id, owner, receiver
):
    """protects=AC12: both signatures during the overlap, only the new one after it and
    at once with end_old_now; fails_when=the old secret stops early or never stops."""
    made = await hook(client, owner.headers)
    old, hid = made["secret"], made["webhook"]["id"]
    new = (
        await client.post(f"/v1/webhooks/{hid}/rotate-secret", json={}, headers=owner.headers)
    ).json()["secret"]
    await client.post(f"/v1/webhooks/{hid}/test", headers=owner.headers)
    req = receiver.got[-1]
    assert len(req.headers["webhook-signature"].split(" ")) == 2
    assert verify(old, req) and verify(new, req)
    row = await a_hook(tenant_id, hid)
    headers = sign.headers(row, "evt_x", b"{}", later(hours=25))
    assert len(headers["webhook-signature"].split(" ")) == 1
    newest = (
        await client.post(
            f"/v1/webhooks/{hid}/rotate-secret", json={"end_old_now": True}, headers=owner.headers
        )
    ).json()["secret"]
    await client.post(f"/v1/webhooks/{hid}/test", headers=owner.headers)
    req = receiver.got[-1]
    assert len(req.headers["webhook-signature"].split(" ")) == 1
    assert verify(newest, req) and not verify(new, req)


# --- fan-out and the owners-and-approvers rule ---------------------------------------------


async def test_events_reach_subscribed_webhooks_once_and_others_never(
    client, tenant_id, owner, receiver
):
    """protects=AC3: a run's started, checkpoint waiting, decided and succeeded events are
    each delivered once to the subscribed webhook and not at all to the other; payloads
    carry titles and links, never ids of people or text; fails_when=a duplicate, a miss
    or a delivery to the unsubscribed webhook."""
    types = ["run.started", "run.checkpoint_waiting", "run.checkpoint_decided", "run.succeeded"]
    wanted = (await hook(client, owner.headers, types))["webhook"]["id"]
    other = (await hook(client, owner.headers, ["draft.in_review"], url=OTHER))["webhook"]["id"]
    sub = await subjects(tenant_id)
    await capture(tenant_id, "run.started", owner.user, run_id=sub["run_id"])
    await capture(tenant_id, "run.checkpoint_waiting", None, **sub)
    await capture(tenant_id, "run.checkpoint_decided", owner.user, outcome="approved", **sub)
    await capture(tenant_id, "run.succeeded", None, run_id=sub["run_id"])
    got = await outbox.tick(tenant_id)
    assert got.sent == 4
    assert await outbox.tick(tenant_id) == outbox.WebhooksTick()
    sent = [json.loads(r.content) for r in receiver.to("hooks.example.test")]
    assert [b["type"] for b in sent] == types
    assert receiver.to("other.example.test") == []
    assert await deliveries(tenant_id, other) == []
    assert {d.status for d in await deliveries(tenant_id, wanted)} == {"succeeded"}
    started, waiting, decided, _ = sent
    assert started["data"]["run"]["title"] == "Checkout redesign"
    assert started["data"]["run"]["url"].endswith(f"/runs/{sub['run_id']}")
    assert started["data"]["actor"] == {"kind": "person", "name": "Owner"}
    assert started["company"]["id"] == str(tenant_id)
    assert waiting["data"]["checkpoint"]["kind"] == "prd_review"
    assert decided["data"]["checkpoint"]["outcome"] == "approved"
    assert str(owner.user.id) not in json.dumps(sent) and "@" not in json.dumps(sent)


async def test_approvers_only_events_reach_only_an_opted_in_owners_webhook(
    client, tenant_id, owner, approver, receiver
):
    """protects=AC7, Q2: an update document's events never reach an approver's webhook nor
    an owner's with the content off, in deliveries or the log; with it on they arrive;
    fails_when=a delivery, a withheld row or a log row reaches the others."""
    a = (await hook(client, approver.headers, ["draft.in_review"], url=OTHER))["webhook"]["id"]
    off = (await hook(client, owner.headers, ["draft.in_review"]))["webhook"]["id"]
    on = (
        await hook(
            client,
            owner.headers,
            ["draft.in_review"],
            url="https://on.example.test/in",
            include_approvers_content=True,
            reason="The board channel bot",
        )
    )["webhook"]["id"]
    sub = await subjects(tenant_id, "approvers")
    event = await capture(tenant_id, "draft.in_review", None, document_id=sub["document_id"])
    assert event.approvers_only is True
    await outbox.tick(tenant_id)
    assert [r.url.host for r in receiver.got] == ["on.example.test"]
    assert await deliveries(tenant_id, a) == [] and await deliveries(tenant_id, off) == []
    assert [d.status for d in await deliveries(tenant_id, on)] == ["succeeded"]
    log = await client.get(f"/v1/webhooks/{a}/deliveries", headers=approver.headers)
    assert log.json()["items"] == []


async def test_a_document_made_approvers_only_after_capture_is_withheld_at_send(
    client, tenant_id, owner, approver, receiver
):
    """protects=AC7 (checked twice): a document switched to approvers after the event was
    captured is not sent; the delivery is withheld, shown to owners only; fails_when=it
    is sent, or an approver sees the withheld row."""
    mine = (await hook(client, approver.headers, ["draft.in_review"]))["webhook"]["id"]
    sub = await subjects(tenant_id, "company")
    event = await capture(tenant_id, "draft.in_review", None, document_id=sub["document_id"])
    assert event.approvers_only is False
    async with tenant_session(tenant_id) as s:
        await s.execute(
            update(Document)
            .where(Document.id == uuid.UUID(sub["document_id"]))
            .values(visibility="approvers")
            .execution_options(oracle_all_documents=True)
        )
        await s.commit()
    got = await outbox.tick(tenant_id)
    assert got.withheld == 1 and receiver.got == []
    (row,) = await deliveries(tenant_id, mine)
    assert row.status == "withheld" and row.body is None
    seen = await client.get(f"/v1/webhooks/{mine}/deliveries", headers=approver.headers)
    assert seen.json()["items"] == []
    as_owner = await client.get(f"/v1/webhooks/{mine}/deliveries", headers=owner.headers)
    assert [d["status"] for d in as_owner.json()["items"]] == ["withheld"]


# --- retries, backoff, Retry-After, 410, 3xx ------------------------------------------------


def _near(at: datetime, want: datetime, slack: timedelta) -> bool:
    return abs(at - want) <= slack


async def test_a_500_is_retried_after_1_5_30_minutes_then_hourly_and_fails_after_24h(
    client, tenant_id, owner, receiver
):
    """protects=AC9 (backoff with ±10% jitter, give up after 24 hours); fails_when=a
    wrong wait, no retry, or a retry after 24 hours."""
    receiver.answers["hooks.example.test"] = 500
    await hook(client, owner.headers)
    sub = await subjects(tenant_id)
    await capture(tenant_id, "run.started", None, run_id=sub["run_id"])
    now = datetime.now(UTC)
    for minutes in (1, 5, 30, 60, 60):
        await outbox.tick(tenant_id, now=now)
        (row,) = await deliveries(tenant_id)
        assert row.status == "retrying" and row.http_status == 500
        assert _near(row.next_at, now + timedelta(minutes=minutes), timedelta(minutes=minutes) / 9)
        now = row.next_at
    assert len(receiver.got) == 5
    await outbox.tick(tenant_id, now=later(hours=25))
    (row,) = await deliveries(tenant_id)
    assert row.status == "failed" and row.next_at is None


async def test_retry_after_is_honoured_and_capped_at_an_hour(client, tenant_id, owner, receiver):
    """protects=AC9: a 429 with Retry-After: 120 waits about 120 s; a 503 asking for a day
    waits an hour; fails_when=Retry-After is ignored or uncapped."""
    receiver.answers["hooks.example.test"] = httpx.Response(429, headers={"Retry-After": "120"})
    receiver.answers["other.example.test"] = httpx.Response(503, headers={"Retry-After": "86400"})
    a = (await hook(client, owner.headers))["webhook"]["id"]
    b = (await hook(client, owner.headers, url=OTHER))["webhook"]["id"]
    sub = await subjects(tenant_id)
    await capture(tenant_id, "run.started", None, run_id=sub["run_id"])
    now = datetime.now(UTC)
    await outbox.tick(tenant_id, now=now)
    (ra,) = await deliveries(tenant_id, a)
    (rb,) = await deliveries(tenant_id, b)
    assert ra.status == "retrying" and _near(
        ra.next_at, now + timedelta(seconds=120), timedelta(seconds=2)
    )
    assert _near(rb.next_at, now + timedelta(hours=1), timedelta(seconds=2))


async def test_a_400_fails_at_once_a_410_pauses_and_a_redirect_is_not_followed(
    client, tenant_id, owner, receiver
):
    """protects=AC9: a 400 is failed at once with the response kept; a 410 pauses the
    webhook (gone); a 3xx is a failure and its Location is never called; fails_when=a
    retry, no pause, or a call to the redirect target."""
    receiver.answers["hooks.example.test"] = httpx.Response(400, text="bad shape")
    receiver.answers["other.example.test"] = 410
    receiver.answers["moved.example.test"] = httpx.Response(
        302, headers={"Location": "https://elsewhere.example.test/x"}
    )
    bad = (await hook(client, owner.headers))["webhook"]["id"]
    gone = (await hook(client, owner.headers, url=OTHER))["webhook"]["id"]
    moved = (await hook(client, owner.headers, url="https://moved.example.test/in"))["webhook"][
        "id"
    ]
    sub = await subjects(tenant_id)
    await capture(tenant_id, "run.started", None, run_id=sub["run_id"])
    await outbox.tick(tenant_id)
    (r_bad,) = await deliveries(tenant_id, bad)
    assert r_bad.status == "failed" and r_bad.http_status == 400
    assert r_bad.response_excerpt == "bad shape"
    (r_gone,) = await deliveries(tenant_id, gone)
    assert r_gone.status == "failed" and r_gone.http_status == 410
    g = await a_hook(tenant_id, gone)
    assert g.status == "paused" and g.paused_reason == "gone"
    (r_moved,) = await deliveries(tenant_id, moved)
    assert r_moved.status == "failed" and r_moved.error == "redirect"
    assert receiver.to("elsewhere.example.test") == []


async def test_the_response_is_read_up_to_2_kb(client, tenant_id, owner, receiver):
    """protects=spec (the response body is read up to 2 KB, the rest dropped);
    fails_when=the whole body is kept."""
    receiver.answers["hooks.example.test"] = httpx.Response(200, text="x" * 10_000)
    hid = (await hook(client, owner.headers))["webhook"]["id"]
    resp = await client.post(f"/v1/webhooks/{hid}/test", headers=owner.headers)
    assert len(resp.json()["response_excerpt"]) == 2048


async def test_a_private_address_is_refused_at_send_through_the_guarded_transport(
    client, tenant_id, owner
):
    """protects=AC10, Q5: webhooks connect only through guarded_transport, which refuses
    a loopback or private address on connect (not_public); fails_when=Oracle calls it."""
    previous = outbox.set_transport(None)
    try:
        hid = (await hook(client, owner.headers, url="https://127.0.0.1:9/in"))["webhook"]["id"]
        resp = await client.post(f"/v1/webhooks/{hid}/test", headers=owner.headers)
    finally:
        outbox.set_transport(previous)
    assert resp.status_code == 200
    assert resp.json()["status"] == "failed" and resp.json()["error"] == "not_public"


async def test_a_body_over_16_kb_is_never_sent(client, tenant_id, owner, receiver, monkeypatch):
    """protects=spec (payloads at most 16 KB); fails_when=a larger body is posted."""
    monkeypatch.setattr(outbox, "MAX_BODY_BYTES", 64)
    hid = (await hook(client, owner.headers))["webhook"]["id"]
    resp = await client.post(f"/v1/webhooks/{hid}/test", headers=owner.headers)
    assert resp.json()["status"] == "failed" and resp.json()["error"] == "too_large"
    assert receiver.got == []


# --- the failing pause ----------------------------------------------------------------------


async def test_72_hours_of_failures_pause_the_webhook_and_tell_creator_and_owners(
    client, tenant_id, owner, approver, receiver
):
    """protects=AC11: after 72 hours in which every delivery (at least 5) failed, the
    webhook pauses (failing) with an Inbox row for its creator and every owner; resuming
    sends what is within 24 hours and fails what is older; fails_when=no pause, an early
    pause, a missing Inbox row, or an old delivery sent."""
    receiver.answers["hooks.example.test"] = 500
    hid = (await hook(client, approver.headers))["webhook"]["id"]
    sub = await subjects(tenant_id)
    for _ in range(5):
        await capture(tenant_id, "run.started", None, run_id=sub["run_id"])
    start = datetime.now(UTC)
    await outbox.tick(tenant_id, now=start)
    await outbox.tick(tenant_id, now=start + timedelta(hours=71))
    assert (await a_hook(tenant_id, hid)).status == "active"
    # Older deliveries gave up after 24 hours; the newest kept failing for 72.
    async with tenant_session(tenant_id) as s:
        await s.execute(
            update(WebhookDelivery).values(
                created_at=WebhookDelivery.created_at - timedelta(hours=1)
            )
        )
        await s.commit()
    await capture(tenant_id, "run.started", None, run_id=sub["run_id"])
    got = await outbox.tick(tenant_id, now=start + timedelta(hours=72, minutes=5))
    paused = await a_hook(tenant_id, hid)
    assert paused.status == "paused" and paused.paused_reason == "failing" and got.paused == 1
    async with tenant_session(tenant_id) as s:
        rows = list(
            await s.scalars(select(Notification).where(Notification.kind == "webhook_paused"))
        )
    assert {r.user_id for r in rows} == {owner.user.id, approver.user.id}
    assert {r.title for r in rows} == {"Webhook Team bot paused: failing for 3 days"}
    listed = (await client.get(f"/v1/webhooks/{hid}", headers=approver.headers)).json()
    assert listed["failing_since"] is not None
    # Resume: the newest delivery is within 24 hours and is sent.
    receiver.answers["hooks.example.test"] = 200
    resumed = await client.patch(
        f"/v1/webhooks/{hid}", json={"status": "active"}, headers=approver.headers
    )
    assert resumed.status_code == 200
    await outbox.tick(tenant_id, now=datetime.now(UTC) + timedelta(hours=2))
    statuses = sorted(d.status for d in await deliveries(tenant_id, hid))
    assert statuses.count("succeeded") == 1 and statuses.count("failed") == 5


async def test_one_webhook_timing_out_does_not_hold_up_another(
    client, tenant_id, owner, receiver, monkeypatch
):
    """protects=AC15: a webhook timing out on every call doesn't delay another webhook's
    deliveries in the same tick; fails_when=the fast webhook waits behind the slow one."""
    monkeypatch.setattr(outbox, "TOTAL_SECONDS", 0.3)

    async def slow(request):
        await asyncio.sleep(5)
        return httpx.Response(200)

    receiver.answers["hooks.example.test"] = slow
    slow_id = (await hook(client, owner.headers))["webhook"]["id"]
    fast_id = (await hook(client, owner.headers, url=OTHER))["webhook"]["id"]
    sub = await subjects(tenant_id)
    for _ in range(3):
        await capture(tenant_id, "run.started", None, run_id=sub["run_id"])
    began = time.monotonic()
    await outbox.tick(tenant_id, budget_seconds=5)
    assert time.monotonic() - began < 3
    assert [d.status for d in await deliveries(tenant_id, fast_id)] == ["succeeded"] * 3
    slow_rows = await deliveries(tenant_id, slow_id)
    assert any(d.error == "timeout" and d.status == "retrying" for d in slow_rows)


# --- redeliver, the log, roles --------------------------------------------------------------


async def test_redeliver_sends_the_same_event_again_as_a_new_delivery(
    client, tenant_id, owner, receiver
):
    """protects=spec Redeliver: a new delivery with the same webhook-id and redelivery_of;
    fails_when=the id changes or the old row is overwritten."""
    receiver.answers["hooks.example.test"] = 500
    hid = (await hook(client, owner.headers))["webhook"]["id"]
    first = (await client.post(f"/v1/webhooks/{hid}/test", headers=owner.headers)).json()
    assert first["status"] in ("retrying", "failed")
    receiver.answers["hooks.example.test"] = 200
    resp = await client.post(
        f"/v1/webhooks/{hid}/deliveries/{first['id']}/redeliver", headers=owner.headers
    )
    assert resp.status_code == 200, resp.text
    again = resp.json()
    assert again["status"] == "succeeded" and again["redelivery_of"] == first["id"]
    assert again["event_id"] == first["event_id"] and again["id"] != first["id"]
    assert receiver.got[0].headers["webhook-id"] == receiver.got[1].headers["webhook-id"]
    log = (await client.get(f"/v1/webhooks/{hid}/deliveries", headers=owner.headers)).json()
    assert len(log["items"]) == 2


async def test_redelivering_an_approvers_only_event_reruns_the_check(
    client, tenant_id, owner, receiver
):
    """protects=spec Redeliver (re-runs the visibility check): after the owner turns the
    content off, redelivering an update's event is withheld; fails_when=it is sent."""
    hid = (
        await hook(
            client,
            owner.headers,
            ["draft.in_review"],
            include_approvers_content=True,
            reason="Board bot",
        )
    )["webhook"]["id"]
    sub = await subjects(tenant_id, "approvers")
    await capture(tenant_id, "draft.in_review", None, document_id=sub["document_id"])
    await outbox.tick(tenant_id)
    (row,) = await deliveries(tenant_id, hid)
    await client.patch(
        f"/v1/webhooks/{hid}",
        json={"include_approvers_content": False, "reason": "Not any more"},
        headers=owner.headers,
    )
    resp = await client.post(
        f"/v1/webhooks/{hid}/deliveries/{row.id}/redeliver", headers=owner.headers
    )
    assert resp.json()["status"] == "withheld" and len(receiver.got) == 1


async def test_test_and_redeliver_roles_across_every_credential(
    client, tenant_id, owner, approver, receiver, monkeypatch
):
    """protects=spec roles for the two new routes: viewer and commenter 404, an approver on
    another's webhook 404, an approver and an owner 200, a write API token 200, a
    read-only token 403, a run token 403, and MCP parity; fails_when=any other answer."""
    from oracle.auth.service import create_api_token

    mine = (await hook(client, approver.headers))["webhook"]["id"]
    owners = (await hook(client, owner.headers, url=OTHER))["webhook"]["id"]
    sent = (await client.post(f"/v1/webhooks/{mine}/test", headers=approver.headers)).json()
    paths = lambda h, d: [  # noqa: E731
        f"/v1/webhooks/{h}/test",
        f"/v1/webhooks/{h}/deliveries/{d}/redeliver",
    ]
    for role in ("viewer", "commenter"):
        person = await make_person(tenant_id, f"{role}@example.com", role)
        for path in paths(mine, sent["id"]):
            assert (await client.post(path, headers=person.headers)).status_code == 404
    other = (await client.post(f"/v1/webhooks/{owners}/test", headers=owner.headers)).json()
    for path in paths(owners, other["id"]):
        assert (await client.post(path, headers=approver.headers)).status_code == 404
        assert (await client.post(path, headers=owner.headers)).status_code == 200
    for path in paths(mine, sent["id"]):
        assert (await client.post(path, headers=approver.headers)).status_code == 200
    raw = await api_token(tenant_id, "owner")
    for path in paths(mine, sent["id"]):
        assert (await client.post(path, headers=bearer(raw))).status_code == 200
    async with tenant_session(tenant_id) as s:
        _, reader = await create_api_token(s, "reader", user_id=owner.user.id, scope="oracle:read")
        await s.commit()
    for path in paths(mine, sent["id"]):
        assert (await client.post(path, headers=bearer(reader))).status_code == 403
    token = await run_token(tenant_id, ["read:baseline"], owner.user.id)
    for path in paths(mine, sent["id"]):
        headers = {**owner.headers, "x-oracle-run-token": token}
        assert (await client.post(path, headers=headers)).status_code == 403
    async with mcp_client(raw) as c:
        names = {t.name for t in (await c.list_tools()).tools}
        assert {"test_webhook", "redeliver_webhook_delivery"} <= names
        got = await c.call_tool("test_webhook", {"webhook_id": mine})
        assert not got.is_error, text_of(got)
        assert "whsec_" not in text_of(got)


# --- retention ------------------------------------------------------------------------------


async def test_deliveries_and_events_older_than_30_days_are_deleted(
    client, tenant_id, owner, receiver
):
    """protects=AC16, Q6: the daily step deletes deliveries and events older than 30 days
    and keeps newer ones; fails_when=either survives or a newer one goes."""
    hid = (await hook(client, owner.headers))["webhook"]["id"]
    await client.post(f"/v1/webhooks/{hid}/test", headers=owner.headers)
    await client.post(f"/v1/webhooks/{hid}/test", headers=owner.headers)
    async with tenant_session(tenant_id) as s:
        old = (await s.scalars(select(WebhookEvent).order_by(WebhookEvent.occurred_at))).first()
        await s.execute(
            update(WebhookEvent)
            .where(WebhookEvent.id == old.id)
            .values(occurred_at=func_days_ago(31))
        )
        await s.execute(
            update(WebhookDelivery)
            .where(WebhookDelivery.event_id == old.id)
            .values(created_at=func_days_ago(31), last_at=func_days_ago(31))
        )
        await s.commit()
    async with tenant_session(tenant_id) as s:
        assert await retention.purge(s) >= 1
        await s.commit()
    async with tenant_session(tenant_id) as s:
        assert len(list(await s.scalars(select(WebhookEvent)))) == 1
    assert len(await deliveries(tenant_id, hid)) == 1


def func_days_ago(days: int) -> datetime:
    return datetime.now(UTC) - timedelta(days=days)


# --- the loopback switch --------------------------------------------------------------------


def test_the_loopback_switch_is_refused_in_a_real_deployment():
    """protects=spec AC17 note (ORACLE_WEBHOOKS_ALLOW_LOOPBACK_FOR_TESTS is refused in
    production); fails_when=a real deployment starts with it on."""
    from oracle.config import Settings

    assert Settings(webhooks_allow_loopback_for_tests=True).webhooks_allow_loopback_for_tests
    with pytest.raises(ValueError):
        Settings(webhooks_allow_loopback_for_tests=True, cookie_secure=True)
