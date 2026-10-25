# ruff: noqa: F811 - fixtures are imported
"""Slack pings (C1 feedback channels, G8 §4 "draft-ready pings… can use this outbox later"):
a draft ready for review, a review or decision requested of a person, and a member's own
notifications they opt into, through G8's Slack outbox.

Slack is faked (``tests.test_slack_bridge.FakeSlack``, plus ``users.lookupByEmail``); the
real Slack API is never called.

Each test's card: protects=<the observable>; fails_when=<the wrong result>;
no_claim=<what green does not prove>. Synthetic placeholders only.
"""

import uuid

import httpx
import pytest
from sqlalchemy import select, update

from oracle.docs.models import Document
from oracle.integrations import slack_api
from oracle.slack import outbox, pings
from oracle.slack.models import SlackOutbox
from oracle.tenancy import tenant_session
from tests.fixtures import draft, import_draft
from tests.test_discussions import company, uid
from tests.test_slack_bridge import FakeSlack, install
from tests.test_slack_bridge import slack as bridge_slack  # noqa: F401

DEFAULTS = {
    "draft_ready": False,
    "review_requested": True,
    "comments": False,
    "feedback_wanted": False,
    "published": False,
}
# Slack users of the example company, by e-mail (users.lookupByEmail).
SLACK_USERS = {"commenter@example.com": "U0COMMENTER", "approver@example.com": "U0APPROVER"}
NOTIFY_CHANNEL = {"id": "C0NOTIFY", "name": "product-pings"}


class PingSlack(FakeSlack):
    def __init__(self) -> None:
        super().__init__()
        self.people = dict(SLACK_USERS)

    def handler(self, request: httpx.Request) -> httpx.Response:
        if request.url.path.endswith("/users.lookupByEmail"):
            super().handler(request)  # records the call
            email = self.calls[-1][1].get("email", "")
            if email in self.people:
                return httpx.Response(200, json={"ok": True, "user": {"id": self.people[email]}})
            return httpx.Response(200, json={"ok": False, "error": "users_not_found"})
        return super().handler(request)


@pytest.fixture
def slack(bridge_slack):  # noqa: F811
    fake = PingSlack()
    previous = slack_api.set_transport(httpx.MockTransport(fake.handler))
    yield fake
    slack_api.set_transport(previous)


async def pings_of(ctx) -> list[SlackOutbox]:
    async with tenant_session(ctx.tenant_id) as s:
        return list(
            await s.scalars(
                select(SlackOutbox).where(SlackOutbox.op == "ping").order_by(SlackOutbox.created_at)
            )
        )


async def assign(client, ctx, doc: str, key: str = "problem", reviewers=()) -> None:
    states = await client.get(
        f"/v1/documents/{doc}/versions/1/section-states", headers=ctx.as_("owner")
    )
    assert states.status_code == 200, states.text
    lock = {s["section_key"]: s for s in states.json()["sections"]}[key].get("lock_version")
    resp = await client.put(
        f"/v1/documents/{doc}/sections/{key}/assignment",
        json={"owner_id": None, "reviewer_ids": list(reviewers), "lock_version": lock},
        headers=ctx.as_("approver"),
    )
    assert resp.status_code == 200, resp.text


async def choose(client, ctx, who: str, **chosen: bool) -> dict:
    resp = await client.patch(
        "/v1/me/preferences", json={"slack_pings": chosen}, headers=ctx.as_(who)
    )
    assert resp.status_code == 200, resp.text
    return resp.json()["slack_pings"]


def posts(slack) -> list[dict]:
    return slack.of("chat.postMessage")


# protects=the defaults and the choice (My account): every ping is off but review
# requested, a member changes only their own; fails_when=another default, an unknown
# ping accepted, or one member's choice changes another's; no_claim=the web page.
async def test_each_member_chooses_their_pings(client):
    ctx, _ = await company(client)
    got = await client.get("/v1/me/preferences", headers=ctx.as_("commenter"))
    assert got.json()["slack_pings"] == DEFAULTS
    assert await choose(client, ctx, "commenter", draft_ready=True, review_requested=False) == {
        **DEFAULTS, "draft_ready": True, "review_requested": False,
    }  # fmt: skip
    # A later change keeps the earlier one.
    assert (await choose(client, ctx, "commenter", comments=True))["draft_ready"] is True
    other = await client.get("/v1/me/preferences", headers=ctx.as_("approver"))
    assert other.json()["slack_pings"] == DEFAULTS
    bad = await client.patch(
        "/v1/me/preferences", json={"slack_pings": {"everything": True}},
        headers=ctx.as_("commenter"),
    )  # fmt: skip
    assert bad.status_code == 422
    # A viewer keeps their own choices too.
    assert (await choose(client, ctx, "viewer", published=True))["published"] is True


# protects=review requested reaches the person as a DM (default on), through the outbox
# on the tick; fails_when=nothing is queued, it posts before the tick, or to a channel
# when the person's Slack user is known; no_claim=Slack's DM delivery.
async def test_a_review_request_is_a_dm_to_that_person(client, slack):
    ctx, doc = await company(client)
    await install(client, ctx)
    await assign(client, ctx, doc, reviewers=[uid(ctx, "commenter")])
    (item,) = await pings_of(ctx)
    assert item.recipient_id == ctx.users["commenter"].id
    assert item.payload["event"] == "review_requested"
    assert not posts(slack)
    tick = await outbox.tick(ctx.tenant_id)
    assert tick.sent == 1
    (post,) = posts(slack)
    assert post["channel"] == "U0COMMENTER"
    assert "You were asked to review problem in" in post["text"]
    assert f"https://oracle.example.com/documents/{doc}" in post["text"]
    (item,) = await pings_of(ctx)
    assert item.status == "sent"


# protects=a member who turned a ping off gets none, and nothing goes without Slack
# connected; fails_when=a ping is queued anyway; no_claim=the in-app notification (kept).
async def test_no_ping_when_turned_off_or_not_connected(client, slack):
    ctx, doc = await company(client)
    await assign(client, ctx, doc, reviewers=[uid(ctx, "commenter")])
    assert await pings_of(ctx) == []  # Slack is not connected
    await install(client, ctx)
    await choose(client, ctx, "approver", review_requested=False)
    await assign(client, ctx, doc, key="users", reviewers=[uid(ctx, "approver")])
    assert await pings_of(ctx) == []


# protects=draft ready goes to the document's reviewers who opted in, never to the person
# who imported it; fails_when=a reviewer who did not opt in is pinged, or a non-reviewer;
# no_claim=which sections changed.
async def test_a_new_draft_pings_the_reviewers_who_opted_in(client, slack):
    ctx, doc = await company(client)
    await install(client, ctx)
    await choose(client, ctx, "commenter", draft_ready=True, review_requested=False)
    await choose(client, ctx, "viewer", draft_ready=True)
    await assign(client, ctx, doc, reviewers=[uid(ctx, "commenter"), uid(ctx, "approver")])
    before = {p.id for p in await pings_of(ctx)}
    resp = await import_draft(client, ctx.as_("token"), draft("prd_v2.md"))
    assert resp.status_code == 201, resp.text
    new = [p for p in await pings_of(ctx) if p.id not in before]
    assert [(p.recipient_id, p.payload["event"]) for p in new] == [
        (ctx.users["commenter"].id, "draft_ready")
    ]
    await outbox.tick(ctx.tenant_id)
    dm = [p for p in posts(slack) if p["channel"] == "U0COMMENTER"]
    assert any("Draft 2 of" in p["text"] and "is ready for your review" in p["text"] for p in dm)


# protects=a person Oracle cannot find in Slack is named in the Notifications channel,
# and an approvers-only document's title never goes there; fails_when=the title is posted
# to the channel, or the ping is lost silently; no_claim=who reads the channel.
async def test_the_channel_fallback_keeps_approvers_only_titles_out(client, slack):
    ctx, doc = await company(client)
    await install(client, ctx)
    resp = await client.put(
        "/v1/settings/alignment_report",
        json={"value": {"slack_channel": NOTIFY_CHANNEL}},
        headers=ctx.as_("owner"),
    )
    assert resp.status_code == 200, resp.text
    async with tenant_session(ctx.tenant_id) as s:
        title = await s.scalar(select(Document.title).where(Document.id == uuid.UUID(doc)))
        await s.execute(
            update(Document)
            .where(Document.id == uuid.UUID(doc))
            .values(visibility="approvers")
            .execution_options(oracle_all_documents=True)
        )
        await s.commit()
    slack.people.pop("approver@example.com")
    await assign(client, ctx, doc, reviewers=[uid(ctx, "approver")])
    await outbox.tick(ctx.tenant_id)
    (post,) = posts(slack)
    assert post["channel"] == "C0NOTIFY"
    assert "Approver" in post["text"]
    assert title not in post["text"]
    assert "Open in Oracle" in post["text"]


# protects=without the person in Slack and without a channel, the ping is dropped with
# its reason; fails_when=it retries forever or posts somewhere; no_claim=the Inbox row.
async def test_unknown_person_without_a_channel_is_dropped(client, slack):
    ctx, doc = await company(client)
    await install(client, ctx)
    slack.people.clear()
    await assign(client, ctx, doc, reviewers=[uid(ctx, "commenter")])
    await outbox.tick(ctx.tenant_id)
    assert posts(slack) == []
    (item,) = await pings_of(ctx)
    assert (item.status, item.error) == ("dropped", "users_not_found")


# protects=a decision requested of a person pings them (review requested); fails_when=no
# ping, or the proposer is pinged; no_claim=the decision page.
async def test_a_decision_requested_pings_its_approver(client, slack):
    ctx, _ = await company(client)
    await install(client, ctx)
    resp = await client.post(
        "/v1/decisions",
        json={"title": "Caps per plan tier", "approver_id": uid(ctx, "approver")},
        headers=ctx.as_("commenter"),
    )
    assert resp.status_code == 201, resp.text
    (item,) = await pings_of(ctx)
    assert item.recipient_id == ctx.users["approver"].id
    await outbox.tick(ctx.tenant_id)
    (post,) = posts(slack)
    assert post["channel"] == "U0APPROVER"
    assert "Your decision is requested: Caps per plan tier" in post["text"]


# protects=a member's own notifications go only when opted in; fails_when=a comment pings
# by default; no_claim=every notification kind.
async def test_comment_pings_are_opt_in(client, slack):
    ctx, doc = await company(client)
    await install(client, ctx)
    await assign(client, ctx, doc, reviewers=[uid(ctx, "approver")])
    before = len(await pings_of(ctx))

    async def comment(body: str) -> None:
        resp = await client.post(
            f"/v1/documents/{doc}/versions/1/comments",
            json={"section_key": "problem", "anchor": {"exact": "Too many shoppers"}, "body": body},
            headers=ctx.as_("commenter"),
        )
        assert resp.status_code == 201, resp.text

    await comment("Is this one sprint?")
    assert len(await pings_of(ctx)) == before
    await choose(client, ctx, "approver", comments=True)
    await comment("Or two?")
    events = [p.payload["event"] for p in await pings_of(ctx)][before:]
    assert events == ["comments"]


def test_the_event_list():
    assert pings.DEFAULTS == DEFAULTS
