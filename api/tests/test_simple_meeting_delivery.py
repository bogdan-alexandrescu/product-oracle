"""Meeting minutes' email and Slack delivery: each attendee's email and the Slack post carry
their own status, failures retry on the minute tick, and Retry requeues what failed.

Card (dod-delivery):
  protects: each attendee's email and the Slack post have their own status (queued, sent,
  retrying, failed); a partial email failure reads as such (never "sent"); a failure is
  tried again on the tick 5 then 10 minutes later (3 tries over about 15 minutes) and then
  reads failed; a sent email is never sent again; Retry (whoever ended the meeting or an
  owner; ``can.retry_delivery`` and the Decisions page's ``can_retry_delivery``) requeues
  only what failed; the log keeps the error's type only, never an address.
  fails_when: one failed attendee is lost in "sent", nothing retries, a retry comes before
  its backoff or after the third try, a sent email goes twice, Retry is open to another
  attendee or a viewer, or the log carries an address or the error's words.
  no_claim: Slack's API and the mailer's HTTP (their own tests); the words people read
  (web/e2e/simple-meeting-delivery.spec.ts).
"""

from __future__ import annotations

import logging
from datetime import timedelta

from oracle.simple import meetings
from oracle.simple.schemas import SimpleSlackState
from oracle.tenancy import tenant_session
from tests.test_simple_changes_api import clock as clock  # noqa: F401
from tests.test_simple_meetings_api import MEETINGS, end, get, start, world


class Boom(Exception):
    pass


class FlakyMailer:
    """Fails for the addresses in ``bad`` (the error's words name the address)."""

    def __init__(self, bad: set[str]) -> None:
        self.bad = bad
        self.sent: list = []
        self.tried: list[str] = []

    async def send(self, http, message) -> None:
        self.tried.append(message.to)
        if message.to in self.bad:
            raise Boom(f"mailbox {message.to} refused")
        self.sent.append(message)


class FakeSlack:
    def __init__(self, fails: int) -> None:
        self.fails = fails
        self.posts: list[str] = []

    async def __call__(self, db, text: str) -> None:
        self.posts.append(text)
        if len(self.posts) <= self.fails:
            raise Boom("token xoxb-secret invalid")


async def _sent(client, w, monkeypatch, *, bad: set[str], slack_fails: int):
    from oracle.members import mailer

    fake = FlakyMailer(bad)
    monkeypatch.setattr(mailer, "get_mailer", lambda: fake)
    slack = FakeSlack(slack_fails)
    monkeypatch.setattr(meetings, "_post_slack", slack)

    async def connected(db):
        return SimpleSlackState(connected=True, channel="#product")

    monkeypatch.setattr(meetings, "_slack_state", connected)
    m = await start(client, w)
    await end(client, w, m["id"])
    r = await client.post(f"{MEETINGS}/{m['id']}/send", json={"email": True, "slack": True},
                          headers=w.ctx.as_("decider"))  # fmt: skip
    assert r.status_code == 200, r.text
    d = r.json()["delivery"]
    # Before the first try every attendee's email and the post are queued.
    assert d["email_status"] == "queued" and d["slack_status"] == "queued"
    assert {e["status"] for e in d["emails"]} == {"queued"}
    return m, fake, slack


def _by_name(d: dict) -> dict[str, str]:
    return {e["person"]["name"]: e["status"] for e in d["emails"]}


async def _tick(w, clock_, minutes: float = 0) -> None:
    """The minute tick, ``minutes`` later."""
    clock_["now"] = clock_["now"] + timedelta(minutes=minutes)
    async with tenant_session(w.ctx.tenant_id) as s:
        await meetings.deliver_due(s)


async def test_partial_failure_retries_then_fails(client, monkeypatch, clock, caplog):  # noqa: F811
    w = await world()
    commenter = w.ctx.users["commenter"]
    caplog.set_level(logging.WARNING)
    m, fake, slack = await _sent(client, w, monkeypatch, bad={commenter.email}, slack_fails=1)
    await _tick(w, clock)
    d = (await get(client, w, m["id"]))["delivery"]
    # The first try: two of three went, the commenter's will be tried again; Slack too.
    assert d["email_status"] == "retrying" and d["email_sent"] == 2
    names = _by_name(d)
    assert names[commenter.name] == "retrying"
    assert sorted(names.values()) == ["retrying", "sent", "sent"]
    assert d["slack_status"] == "retrying" and len(slack.posts) == 1
    # Not before the backoff.
    await _tick(w, clock, 4)
    assert fake.tried.count(commenter.email) == 1 and len(slack.posts) == 1
    # Second try at 5 minutes: Slack goes through; the email fails again.
    await _tick(w, clock, 1)
    d = (await get(client, w, m["id"]))["delivery"]
    assert d["slack_status"] == "sent" and len(slack.posts) == 2
    assert d["email_status"] == "retrying" and fake.tried.count(commenter.email) == 2
    await _tick(w, clock, 9)
    assert fake.tried.count(commenter.email) == 2
    # Third and last try 10 minutes later: failed, the two sent stay sent (never again).
    await _tick(w, clock, 1)
    d = (await get(client, w, m["id"]))["delivery"]
    assert d["email_status"] == "failed" and d["email_sent"] == 2
    assert _by_name(d)[commenter.name] == "failed"
    assert fake.tried.count(commenter.email) == 3 and len(fake.sent) == 2
    await _tick(w, clock, 60)
    assert fake.tried.count(commenter.email) == 3 and len(slack.posts) == 2
    # The log keeps the error's type only.
    text = caplog.text
    assert "Boom" in text
    assert commenter.email not in text and "refused" not in text and "xoxb" not in text


async def test_slack_fails_three_times(client, monkeypatch, clock):  # noqa: F811
    w = await world()
    m, fake, slack = await _sent(client, w, monkeypatch, bad=set(), slack_fails=5)
    await _tick(w, clock)
    d = (await get(client, w, m["id"]))["delivery"]
    assert d["email_status"] == "sent" and d["email_sent"] == 3
    assert {e["status"] for e in d["emails"]} == {"sent"}
    await _tick(w, clock, 5)
    await _tick(w, clock, 10)
    d = (await get(client, w, m["id"]))["delivery"]
    assert d["slack_status"] == "failed" and len(slack.posts) == 3
    assert d["slack_channel"] == "#product"


async def test_retry_rights_and_requeue(client, monkeypatch, clock):  # noqa: F811
    w = await world()
    commenter = w.ctx.users["commenter"]
    m, fake, slack = await _sent(client, w, monkeypatch, bad={commenter.email}, slack_fails=9)
    for minutes in (0, 5, 10):
        await _tick(w, clock, minutes)
    out = await get(client, w, m["id"])
    assert out["delivery"]["email_status"] == "failed"
    assert out["delivery"]["slack_status"] == "failed"
    # Whoever ended the meeting (the decider here) or an owner may retry.
    assert out["can"]["retry_delivery"] is True
    assert (await get(client, w, m["id"], "owner"))["can"]["retry_delivery"] is True
    for who in ("approver", "commenter"):
        assert (await get(client, w, m["id"], who))["can"]["retry_delivery"] is False
    page = (await client.get("/v1/simple/decisions", headers=w.ctx.as_("decider"))).json()
    [g] = [g for g in page["meetings"] if g["meeting"]["id"] == m["id"]]
    assert g["delivery"]["email_status"] == "failed" and g["can_retry_delivery"] is True
    page = (await client.get("/v1/simple/decisions", headers=w.ctx.as_("approver"))).json()
    [g] = [g for g in page["meetings"] if g["meeting"]["id"] == m["id"]]
    assert g["can_retry_delivery"] is False
    url = f"{MEETINGS}/{m['id']}/delivery/retry"
    for who in ("approver", "commenter", "viewer"):
        r = await client.post(url, json={"what": "email"}, headers=w.ctx.as_(who))
        assert r.status_code == 403, (who, r.text)
    # Retry requeues the failed email only; the tick sends it.
    bad_before = fake.tried.count(commenter.email)
    fake.bad.clear()
    r = await client.post(url, json={"what": "email"}, headers=w.ctx.as_("owner"))
    assert r.status_code == 200, r.text
    d = r.json()["delivery"]
    assert _by_name(d)[commenter.name] == "queued" and d["email_status"] == "queued"
    assert sorted(_by_name(d).values()) == ["queued", "sent", "sent"]
    assert d["slack_status"] == "failed"
    await _tick(w, clock)
    d = (await get(client, w, m["id"]))["delivery"]
    assert d["email_status"] == "sent" and d["email_sent"] == 3
    assert fake.tried.count(commenter.email) == bad_before + 1 and len(fake.sent) == 3
    # Nothing failed is left to retry.
    r = await client.post(url, json={"what": "email"}, headers=w.ctx.as_("decider"))
    assert r.status_code == 409, r.text
    # Slack by whoever ended it.
    slack.fails = 0
    r = await client.post(url, json={"what": "slack"}, headers=w.ctx.as_("decider"))
    assert r.status_code == 200 and r.json()["delivery"]["slack_status"] == "queued"
    await _tick(w, clock)
    assert (await get(client, w, m["id"]))["delivery"]["slack_status"] == "sent"
