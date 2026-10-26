"""Live Ask lane 2 (#710): olt_ live tokens, the MCP `live` scope, the per-call re-check,
the 8 reads of a reply, the add-a-person refusal and the race between joining and
reading (amendment C3).

The source is lane 1's fake archive (tests/live_fakes.py, invented meetings). A reply is
put in ``streaming`` by hand where a test needs one running without a model.

Card (file): protects=spec #710 sections 2 and 3 (live tokens, the MCP scope, the
re-check, the 409) and amendments C1 and C3; fails_when=an olt_ token reads after its
reply, after 10 minutes or after someone joined, lists or calls anything but live_*
tools, a reply reads more than 8 times, or a person is added to a chat holding live
reads; no_claim=the reply run's argv and prompt (tests/test_live_ask_replies.py) and
the web (lane 3).
"""

import asyncio
import uuid
from datetime import UTC, datetime, timedelta

import pytest
from sqlalchemy import select, text, update

from oracle.discussions import replies
from oracle.discussions.models import Discussion, DiscussionMessage, DiscussionParticipant
from oracle.live import tokens
from oracle.mcp import scopes
from oracle.tenancy import tenant_session
from tests.live_fakes import ARCHIVE_ENDPOINT, LIVE_KEY, FakeSources
from tests.test_discussion_replies import Fake
from tests.test_discussions import company, patch, section, start, uid
from tests.test_live_fireflies import LABEL, _fireflies
from tests.test_mcp import mcp_client, text_of

JOINED = "Live reads stopped: someone else joined this discussion."
CAP = "This answer has used its 8 live reads; ask a narrower question"
IN_CHAT = (
    "This chat holds what Oracle read from your sources. Use Share as discussion to share "
    "an edited summary instead."
)
LIVE_TOOLS = {
    "live_sources",
    "live_fireflies_list_meetings",
    "live_fireflies_search",
    "live_fireflies_get_meeting",
    "live_fireflies_get_lines",
}


@pytest.fixture
def sources():
    from oracle.live import router as live_router
    from tests.connection_helpers import clear_provider_http, use_provider_http

    fake = FakeSources()
    use_provider_http(fake)
    live_router.reset_cache()
    yield fake
    clear_provider_http()
    live_router.reset_cache()


@pytest.fixture
def model():
    from oracle.llm import gateway

    fake = Fake()
    previous = gateway.set_transports(gateway.Transports(plan=fake, api_key=fake))
    yield fake
    gateway.set_transports(previous)


async def asked(client, ctx, who="commenter", **body) -> tuple[dict, uuid.UUID]:
    """A private discussion ``who`` started alone with a question; Oracle's reply to it,
    put in ``streaming`` as if its run had claimed it."""
    body.setdefault("visibility", "private")
    d = await start(
        client, ctx, who, subject=section(ctx.doc), message={"body": "How many meetings?"}, **body
    )
    async with tenant_session(ctx.tenant_id) as s:
        reply_id = await s.scalar(
            select(DiscussionMessage.id).where(
                DiscussionMessage.discussion_id == uuid.UUID(d["id"]),
                DiscussionMessage.author_kind == "oracle",
            )
        )
        await s.execute(
            update(DiscussionMessage)
            .where(DiscussionMessage.id == reply_id)
            .values(status="streaming")
        )
        await s.commit()
    assert reply_id is not None
    return d, reply_id


async def mint(ctx, who: str, reply_id: uuid.UUID) -> str:
    async with tenant_session(ctx.tenant_id) as s:
        raw = await tokens.mint(s, ctx.users[who].id, reply_id)
        await s.commit()
    return raw


async def setup(client, sources_fake=None):
    ctx, doc = await company(client)
    ctx.doc = doc
    conn = await _fireflies(ctx.tenant_id, ctx.users["commenter"], ARCHIVE_ENDPOINT)
    return ctx, conn


async def call(token: str, tool: str, args: dict):
    async with mcp_client(token) as c:
        return await c.call_tool(tool, args)


async def reads(ctx) -> list[dict]:
    async with tenant_session(ctx.tenant_id) as s:
        rows = (await s.execute(text("SELECT * FROM live_reads ORDER BY read_at, id"))).mappings()
        return [dict(r) for r in rows]


# protects=section 3: the `live` area needs live:sources, which no other scope grants and
# which grants nothing else; fails_when=a run token without live:sources may call a live
# route, or an olt_ caller may call a non-live one; no_claim=the routes themselves.
def test_live_area_needs_live_sources():
    for path in ("/v1/live/sources", "/v1/live/fireflies/{connection_id}/meetings"):
        assert scopes.required_scope("GET", path) == "live:sources"
        assert not scopes.allowed(frozenset({"read:sources", "read:baseline"}), "GET", path)
        assert scopes.allowed(frozenset({tokens.SCOPE}), "GET", path)
    assert tokens.SCOPE == "live:sources"
    assert not scopes.allowed(frozenset({tokens.SCOPE}), "GET", "/v1/documents")
    assert not scopes.allowed(frozenset({tokens.SCOPE}), "GET", "/v1/source-items/{item_id}")


# protects=section 3: an olt_ token is stored as its sha256 only, lives 10 minutes, and
# tools/list for it shows only the live_* tools, while a call reads as the asker;
# fails_when=the raw token is stored, the TTL drifts, or any other tool is listed;
# no_claim=-.
async def test_token_is_hashed_and_lists_only_live_tools(client, sources, model):
    ctx, conn = await setup(client)
    _d, reply_id = await asked(client, ctx)
    before = datetime.now(UTC)
    raw = await mint(ctx, "commenter", reply_id)
    assert raw.startswith("olt_")
    async with tenant_session(ctx.tenant_id) as s:
        row = (await s.execute(text("SELECT * FROM live_tokens"))).mappings().one()
    assert row["token_hash"] != raw and raw not in str(dict(row))
    assert row["message_id"] == reply_id and row["user_id"] == ctx.users["commenter"].id
    ttl = row["expires_at"] - before
    assert timedelta(minutes=9, seconds=55) < ttl <= timedelta(minutes=10, seconds=5)
    async with mcp_client(raw) as c:
        names = {t.name for t in (await c.list_tools()).tools}
        assert names == LIVE_TOOLS
        listed = await c.call_tool("live_sources", {})
        refused = await c.call_tool("search", {"q": "meetings"})
    assert not listed.is_error, text_of(listed)
    assert str(conn) in text_of(listed)
    assert refused.is_error


# protects=section 2's per-call re-check: the token is refused once its reply ended
# (MCP answers 401) and a call while someone else is in the discussion answers 403 with
# the sentence, making no source call; fails_when=a read happens after the reply or
# after a join; no_claim=how a join is refused (test_join_is_refused...).
async def test_token_refused_after_the_reply_and_after_a_join(client, sources, model):
    ctx, conn = await setup(client)
    d, reply_id = await asked(client, ctx)
    raw = await mint(ctx, "commenter", reply_id)
    # Someone in the discussion besides the asker (put in by hand: the routes refuse it).
    async with tenant_session(ctx.tenant_id) as s:
        s.add(
            DiscussionParticipant(
                discussion_id=uuid.UUID(d["id"]), user_id=ctx.users["approver"].id
            )
        )
        await s.commit()
    joined = await call(raw, "live_fireflies_list_meetings", {"connection_id": str(conn)})
    assert joined.is_error and "HTTP 403" in text_of(joined)
    assert JOINED in text_of(joined)
    assert sources.archive.calls == []
    async with tenant_session(ctx.tenant_id) as s:
        await s.execute(
            text("DELETE FROM discussion_participants WHERE user_id = :u"),
            {"u": ctx.users["approver"].id},
        )
        await s.execute(
            update(DiscussionMessage)
            .where(DiscussionMessage.id == reply_id)
            .values(status="complete")
        )
        await s.commit()
    ended = await call(raw, "live_fireflies_list_meetings", {"connection_id": str(conn)})
    assert ended.is_error
    assert sources.archive.calls == []
    # Revoked when the reply ends (replies revoke it): MCP no longer knows the token.
    async with tenant_session(ctx.tenant_id) as s:
        await tokens.revoke(s, reply_id)
        await s.commit()
    resp = await client.post(
        "/mcp",
        json={"jsonrpc": "2.0", "id": 1, "method": "tools/list"},
        headers={"Authorization": f"Bearer {raw}", "Accept": "application/json"},
    )
    assert resp.status_code == 401


# protects=section 3: a token is refused 10 minutes after it was minted, even with its
# reply still streaming; fails_when=an expired token still reads; no_claim=-.
async def test_token_refused_after_ten_minutes(client, sources, model):
    ctx, conn = await setup(client)
    _d, reply_id = await asked(client, ctx)
    raw = await mint(ctx, "commenter", reply_id)
    async with tenant_session(ctx.tenant_id) as s:
        await s.execute(text("UPDATE live_tokens SET expires_at = now() - interval '1 second'"))
        await s.commit()
    resp = await client.post(
        "/mcp",
        json={"jsonrpc": "2.0", "id": 1, "method": "tools/list"},
        headers={"Authorization": f"Bearer {raw}", "Accept": "application/json"},
    )
    assert resp.status_code == 401
    # The REST route re-checks the token too (the header the MCP call carries).
    cookie = ctx.as_("commenter")
    rest = await client.get(
        f"/v1/live/fireflies/{conn}/meetings", headers={**cookie, tokens.HEADER: raw}
    )
    assert rest.status_code == 403, rest.text
    assert sources.archive.calls == []


# protects=amendment C1 and section 1's cap: every olt_ call counts toward the reply's 8
# (cached and failed ones too); refs go to successful calls only, in call order; the 9th
# answers 429 with the spec's sentence and reaches no source; fails_when=a cached or failed
# call is free, a failed call gets a ref, or a 9th read happens; no_claim=-.
async def test_eight_live_reads_per_reply(client, sources, model):
    ctx, conn = await setup(client)
    _d, reply_id = await asked(client, ctx)
    raw = await mint(ctx, "commenter", reply_id)
    c = str(conn)
    plan = [
        ("live_fireflies_list_meetings", {"connection_id": c, "limit": 1}, "l:1"),
        ("live_fireflies_list_meetings", {"connection_id": c, "limit": 1}, "l:2"),  # cached
        ("live_fireflies_get_meeting", {"connection_id": c, "meeting_id": "m-301"}, "l:3"),
        ("live_fireflies_get_meeting", {"connection_id": c, "meeting_id": "nope"}, None),
        ("live_fireflies_search", {"connection_id": c, "q": "weekly"}, "l:4"),
        ("live_fireflies_get_lines", {"connection_id": c, "meeting_id": "m-301"}, "l:5"),
        ("live_fireflies_list_meetings", {"connection_id": c, "limit": 2}, "l:6"),
        ("live_fireflies_list_meetings", {"connection_id": c, "limit": 3}, "l:7"),
    ]
    async with mcp_client(raw) as m:
        for tool, args, ref in plan:
            result = await m.call_tool(tool, args)
            if ref is None:
                assert result.is_error and "HTTP 404" in text_of(result)
            else:
                assert not result.is_error, text_of(result)
                assert result.structured_content["cite"]["ref"] == ref
        source_calls = len(sources.archive.calls)
        ninth = await m.call_tool("live_fireflies_list_meetings", {"connection_id": c})
    assert ninth.is_error and "HTTP 429" in text_of(ninth)
    assert CAP in text_of(ninth)
    assert len(sources.archive.calls) == source_calls
    rows = await reads(ctx)
    assert [r["message_id"] for r in rows] == [reply_id] * 8
    assert [r["ref_n"] for r in rows] == [1, 2, 3, None, 4, 5, 6, 7]
    assert [r["status"] for r in rows] == [
        "ok", "cached", "ok", "error", "ok", "ok", "ok", "ok",
    ]  # fmt: skip
    assert all(r["source_label"] == LABEL for r in rows)
    assert LIVE_KEY not in str(rows)


# protects=section 2 "adding a person to a chat that already holds live-read replies":
# adding someone, mentioning someone new and making the discussion open each answer 409
# live_reads_in_chat with the sentence, while a live read exists or while a live token is
# unrevoked; without either the same add works; Share as discussion stays as it is;
# fails_when=a person is let into a chat holding what Oracle read from the asker's
# sources, or an ordinary chat refuses them; no_claim=the web's wording (lane 3).
async def test_join_is_refused_in_a_chat_holding_live_reads(client, sources, model):
    ctx, conn = await setup(client)
    d, reply_id = await asked(client, ctx)
    raw = await mint(ctx, "commenter", reply_id)
    path = f"/v1/discussions/{d['id']}"
    approver = uid(ctx, "approver")

    async def refused_everywhere():
        add = await client.post(
            f"{path}/participants", json={"user_ids": [approver]}, headers=ctx.as_("commenter")
        )
        mention = await client.post(
            f"{path}/messages",
            json={"body": "Have a look", "mentions": [approver]},
            headers=ctx.as_("commenter"),
        )
        for resp in (add, mention):
            assert resp.status_code == 409, resp.text
            assert resp.json()["detail"] == {"code": "live_reads_in_chat", "message": IN_CHAT}
        opened = await patch(
            client, ctx, d["id"], "commenter", expect=409, visibility="open",
            exposes={"messages": 2, "people": 1},
        )  # fmt: skip
        assert opened["detail"] == {"code": "live_reads_in_chat", "message": IN_CHAT}

    # An unrevoked token, no read yet.
    await refused_everywhere()
    read = await call(raw, "live_fireflies_list_meetings", {"connection_id": str(conn)})
    assert not read.is_error, text_of(read)
    async with tenant_session(ctx.tenant_id) as s:
        await tokens.revoke(s, reply_id)
        await s.commit()
    # Revoked, but a live read is in the chat.
    await refused_everywhere()
    async with tenant_session(ctx.tenant_id) as s:
        people = await s.scalars(
            select(DiscussionParticipant.user_id).where(
                DiscussionParticipant.discussion_id == uuid.UUID(d["id"]),
                DiscussionParticipant.left_at.is_(None),
            )
        )
        assert set(people) == {ctx.users["commenter"].id}

    # A chat whose token was revoked without any read lets people in.
    other, other_reply = await asked(client, ctx)
    await mint(ctx, "commenter", other_reply)
    async with tenant_session(ctx.tenant_id) as s:
        await tokens.revoke(s, other_reply)
        await s.commit()
    ok = await client.post(
        f"/v1/discussions/{other['id']}/participants",
        json={"user_ids": [approver]},
        headers=ctx.as_("commenter"),
    )
    assert ok.status_code == 200, ok.text

    # Share as discussion (a panel chat holding live reads) is unchanged.
    panel, panel_reply = await asked(client, ctx, origin="panel")
    panel_raw = await mint(ctx, "commenter", panel_reply)
    read = await call(panel_raw, "live_fireflies_list_meetings", {"connection_id": str(conn)})
    assert not read.is_error, text_of(read)
    shared = await client.post(
        f"/v1/discussions/{panel['id']}/share",
        json={"first_message": "An edited summary."},
        headers=ctx.as_("commenter"),
    )
    assert shared.status_code == 201, shared.text


async def _join(client, ctx, d_id: str) -> int:
    resp = await client.post(
        f"/v1/discussions/{d_id}/participants",
        json={"user_ids": [uid(ctx, "approver")]},
        headers=ctx.as_("commenter"),
    )
    assert resp.status_code in (200, 409), resp.text
    return resp.status_code


async def _go_live(ctx, reply_id: uuid.UUID) -> str | None:
    """The reply's live decision and its token, as replies._produce takes them."""
    async with tenant_session(ctx.tenant_id) as s:
        reply = await s.get(DiscussionMessage, reply_id)
        d = await s.get(Discussion, reply.discussion_id)
        plan = await replies.live_plan(s, d, reply)
        await s.commit()
    return plan.token


# protects=amendment C3: a join and a reply going live (and reading) run concurrently, and
# in every round either the join is refused or no read happens after it; and with the
# discussion row locked by a join in flight, going live waits for it and then sees the
# second person; fails_when=both a join and a later live read succeed, or going live does
# not wait for the lock; no_claim=the lock timings of production Postgres.
async def test_join_and_live_read_race(client, sources, model):
    ctx, conn = await setup(client)
    for _ in range(6):
        d, reply_id = await asked(client, ctx)
        joined, token = await asyncio.gather(_join(client, ctx, d["id"]), _go_live(ctx, reply_id))
        read_ok = False
        if token is not None:
            result = await call(token, "live_fireflies_list_meetings", {"connection_id": str(conn)})
            read_ok = not result.is_error
            if not read_ok:
                assert JOINED in text_of(result)
        assert not (joined == 200 and read_ok), "a join and a live read both succeeded"
        assert joined == 409 or token is None or not read_ok

    # Deterministic interleaving: a join holds the row; going live waits, then sees it.
    d, reply_id = await asked(client, ctx)
    async with tenant_session(ctx.tenant_id) as s:
        await s.scalar(
            select(Discussion).where(Discussion.id == uuid.UUID(d["id"])).with_for_update()
        )
        going = asyncio.ensure_future(_go_live(ctx, reply_id))
        await asyncio.sleep(0.5)
        assert not going.done(), "going live did not wait for the join's lock"
        s.add(
            DiscussionParticipant(
                discussion_id=uuid.UUID(d["id"]), user_id=ctx.users["approver"].id
            )
        )
        await s.commit()
    assert await asyncio.wait_for(going, 10) is None

    # And the reverse: a live call holds the row (FOR SHARE) while it records its read;
    # the join waits and is then refused.
    d, reply_id = await asked(client, ctx)
    raw = await mint(ctx, "commenter", reply_id)
    async with tenant_session(ctx.tenant_id) as s:
        await s.scalar(
            select(Discussion).where(Discussion.id == uuid.UUID(d["id"])).with_for_update(read=True)
        )
        joining = asyncio.ensure_future(_join(client, ctx, d["id"]))
        await asyncio.sleep(0.5)
        assert not joining.done(), "the join did not wait for the live call's lock"
        await s.commit()
    assert await asyncio.wait_for(joining, 10) == 409
    assert raw
