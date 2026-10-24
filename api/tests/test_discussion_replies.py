"""G2 Live replies through the routes: when Oracle replies, the stream (claim and tail),
Stop, Retry, the tick fallback, the context's S6 rules, the private-findings notice, the
limits and MCP.

Each test's card: protects=<the observable>; fails_when=<the wrong result>;
no_claim=<what green does not prove>. Synthetic placeholders only.
"""

import asyncio
import json
import stat
import uuid
from datetime import UTC, datetime, timedelta

import pytest
from sqlalchemy import event, update

from oracle.claude_accounts import fallback
from oracle.claude_accounts.fallback import API_KEY_PREFIX, PLAN_TOKEN_PREFIX
from oracle.db import get_engine
from oracle.discussions import context, replies
from oracle.discussions.models import DiscussionMessage
from oracle.llm import gateway
from oracle.llm.transports import ClaudeCodeTransport, LlmRequest, TransportResult
from oracle.sources import search as search_service
from oracle.tenancy import tenant_session
from oracle.v2.models import KnowledgeGap, ProductIntake
from tests.test_discussions import company, get, section, start, uid
from tests.test_mcp import mcp_client, text_of, user_token
from tests.test_run_ticker import PATH as TICK
from tests.test_run_ticker import bearer, id_token, ticker_on  # noqa: F401

CHUNKS = ["Yes, if caps ", "read the plan ", "thresholds only ", "[c:1] ", "and nothing else."]
ASK = "Can caps ship without detection?"


class Fake:
    """Oracle's model, streaming five chunks ``pause`` apart; counts the calls."""

    def __init__(self, pause: float = 0.05):
        self.pause = pause
        self.calls = 0
        self.requests: list[LlmRequest] = []

    async def complete(self, token, request) -> TransportResult:
        raise AssertionError("replies stream")

    async def stream(self, token, request, on_text) -> TransportResult:
        self.calls += 1
        self.requests.append(request)
        for chunk in CHUNKS:
            await asyncio.sleep(self.pause)
            await on_text(chunk)
        return TransportResult(
            text="".join(CHUNKS),
            model=request.model,
            usage={"input_tokens": 100, "output_tokens": 20, "total_cost_usd": 0.0123},
        )


@pytest.fixture
def fake():
    model = Fake()
    previous = gateway.set_transports(gateway.Transports(plan=model, api_key=model))
    yield model
    gateway.set_transports(previous)


async def with_key(ctx, token: str = API_KEY_PREFIX + "03-key") -> None:
    async with tenant_session(ctx.tenant_id) as s:
        await fallback.store(s, token, None)
        await s.commit()


async def say(client, ctx, d_id, who, body, expect=201, params=None, **extra) -> dict:
    resp = await client.post(
        f"/v1/discussions/{d_id}/messages",
        json={"body": body, **extra},
        headers=ctx.as_(who),
        params=params or {},
    )
    assert resp.status_code == expect, resp.text
    return resp.json()


def events_of(text: str) -> list[tuple[str, object]]:
    out = []
    for block in text.split("\n\n"):
        lines = block.splitlines()
        if not lines or lines[0].startswith(":"):
            continue
        name = lines[0].removeprefix("event: ")
        out.append((name, json.loads(lines[1].removeprefix("data: "))))
    return out


async def read_stream(client, ctx, d_id, reply_id, who="commenter"):
    resp = await client.get(
        f"/v1/discussions/{d_id}/messages/{reply_id}/stream", headers=ctx.as_(who)
    )
    assert resp.status_code == 200, resp.text
    assert resp.headers["content-type"].startswith("text/event-stream")
    assert resp.headers["cache-control"] == "no-cache, no-transform"
    assert resp.headers["x-accel-buffering"] == "no"
    return events_of(resp.text)


async def row(ctx, reply_id) -> DiscussionMessage:
    async with tenant_session(ctx.tenant_id) as s:
        found = await s.get(DiscussionMessage, uuid.UUID(reply_id))
        assert found is not None
        return found


# protects=reply rule and marker mapping (units); fails_when=@Oracle is missed, an e-mail
# address counts, or a marker pointing at nothing survives; no_claim=the routes.
def test_addressing_and_citation_markers():
    assert replies.addressed("@Oracle what now?", False)
    assert replies.addressed("hi", True)
    assert not replies.addressed("mail ops@oracle.test", False)
    ctx = context.Context()
    ctx.add("entity", "g1", "Goal: Activation", "Raise activation", confidence=0.3)
    body, cites = replies.citations_of("It holds [c:1], not [c:7].", ctx)
    assert body == "It holds [c:1], not ."
    assert cites[0]["n"] == 1 and cites[0]["low_confidence"] is True
    assert replies.pushback_of("Pushback: it breaks the goal [c:1]. But ok.") == {
        "reason": "it breaks the goal .",
        "sources": [1],
    }
    assert replies.pushback_of("Fine.") is None


# protects=criterion 4: Oracle replies to the only person; once a second person wrote, only
# when addressed; fails_when=a team thread gets unasked replies, or a solo one none;
# no_claim=the composer's copy (E2E).
async def test_oracle_replies_alone_and_when_addressed(client):
    ctx, doc = await company(client)
    d = await start(client, ctx, subject=section(doc))
    solo = await say(client, ctx, d["id"], "commenter", ASK)
    assert solo["message"]["body"] == ASK
    reply = solo["reply"]
    assert (reply["author_kind"], reply["status"], reply["body"]) == ("oracle", "pending", "")
    assert reply["reply_to"] == solo["message"]["id"]
    second = await say(client, ctx, d["id"], "approver", "I think it can.")
    assert second["reply"] is None
    asked = await say(client, ctx, d["id"], "approver", "What do you think?", mention_oracle=True)
    assert asked["reply"]["status"] == "pending"
    at = await say(client, ctx, d["id"], "commenter", "@Oracle and you?")
    assert at["reply"] is not None


# protects=criterion 5: the stream's deltas add up to the final body, then done; a second
# reader gets the same text; one model call; fails_when=text is lost, repeated or the model
# is called twice; no_claim=the browser's rendering.
async def test_the_stream_and_a_second_reader_share_one_call(client, fake):
    ctx, doc = await company(client)
    await with_key(ctx)
    d = await start(client, ctx, subject=section(doc))
    reply = (await say(client, ctx, d["id"], "commenter", ASK))["reply"]
    first, second = await asyncio.gather(
        read_stream(client, ctx, d["id"], reply["id"]),
        read_stream(client, ctx, d["id"], reply["id"], who="viewer"),
    )
    assert fake.calls == 1
    done = await row(ctx, reply["id"])
    assert done.status == "complete" and done.body == "".join(CHUNKS)
    assert done.citations and done.citations[0]["n"] == 1
    for evs in (first, second):
        text = "".join(e[1]["text"] for e in evs if e[0] == "delta")
        assert text == done.body
        assert evs[-1][0] == "done" and evs[-1][1]["status"] == "complete"
    assert sum(1 for e in first if e[0] == "delta") >= 2
    assert done.input_tokens == 100 and done.prompt == "discussion_reply.v2"
    # Owners read the accounting; nobody else does (P3d).
    msgs = await client.get(f"/v1/discussions/{d['id']}/messages", headers=ctx.as_("owner"))
    oracle = [m for m in msgs.json()["items"] if m["author_kind"] == "oracle"][0]
    assert oracle["usage"]["output_tokens"] == 20
    msgs = await client.get(f"/v1/discussions/{d['id']}/messages", headers=ctx.as_("approver"))
    assert [m for m in msgs.json()["items"] if m["author_kind"] == "oracle"][0]["usage"] is None


# protects=criterion 6 (card: tick fallback): a reply nobody streams is completed by the
# signed tick once 10 s old, and counted; fails_when=it is never answered or answered
# twice; no_claim=Cloud Scheduler's timing.
async def test_the_tick_completes_a_reply_nobody_streamed(client, fake, ticker_on):  # noqa: F811
    ctx, doc = await company(client)
    await with_key(ctx)
    d = await start(client, ctx, subject=section(doc))
    reply = (await say(client, ctx, d["id"], "commenter", ASK))["reply"]
    resp = await client.post(TICK, headers=bearer(id_token()))
    assert resp.status_code == 200, resp.text
    assert (await row(ctx, reply["id"])).status == "pending"  # not 10 s old yet
    async with tenant_session(ctx.tenant_id) as s:
        await s.execute(
            update(DiscussionMessage)
            .where(DiscussionMessage.id == uuid.UUID(reply["id"]))
            .values(created_at=datetime.now(UTC) - timedelta(seconds=11))
        )
        await s.commit()
    resp = await client.post(TICK, headers=bearer(id_token()))
    assert resp.status_code == 200, resp.text
    assert resp.json()["discussion_replies"]["completed"] == 1
    assert (await row(ctx, reply["id"])).status == "complete" and fake.calls == 1
    again = await client.post(TICK, headers=bearer(id_token()))
    assert again.json()["discussion_replies"]["ran"] == 0 and fake.calls == 1


# protects=a lease that ran out fails the reply as interrupted with its partial text;
# fails_when=it stays streaming forever; no_claim=a real instance dying.
async def test_a_lapsed_lease_is_interrupted(client):
    ctx, doc = await company(client)
    d = await start(client, ctx, subject=section(doc))
    reply = (await say(client, ctx, d["id"], "commenter", ASK))["reply"]
    async with tenant_session(ctx.tenant_id) as s:
        await s.execute(
            update(DiscussionMessage)
            .where(DiscussionMessage.id == uuid.UUID(reply["id"]))
            .values(
                status="streaming", body="Half an ans",
                stream_lease_until=datetime.now(UTC) - timedelta(seconds=1),
            )
        )  # fmt: skip
        await s.commit()
    out = await replies.run_pending(ctx.tenant_id)
    assert out.interrupted == 1
    gone = await row(ctx, reply["id"])
    assert (gone.status, gone.error_reason, gone.body) == ("failed", "interrupted", "Half an ans")


SLOW_CLAUDE = """#!/usr/bin/env python3
import json, os, sys, time
sys.stdin.read()
open(__PID__, "w").write(str(os.getpid()))
print(json.dumps({"type": "stream_event", "event": {"type": "content_block_delta",
      "delta": {"type": "text_delta", "text": "Partial answer"}}}), flush=True)
time.sleep(60)
"""


# protects=criterion 7: Stop during the stream ends the reply cancelled within a second,
# with its partial text, and Claude Code's process is gone; Retry makes it pending again;
# fails_when=it keeps running, loses the text, or the process lingers; no_claim=the real
# claude binary.
async def test_stop_cancels_the_call_and_retry_asks_again(client, tmp_path):
    from tests.test_llm_gateway import _running

    script, pidfile = tmp_path / "claude", tmp_path / "pid"
    script.write_text(SLOW_CLAUDE.replace("__PID__", repr(str(pidfile))))
    script.chmod(script.stat().st_mode | stat.S_IEXEC)
    plan = ClaudeCodeTransport(claude_bin=str(script), timeout=90)
    previous = gateway.set_transports(gateway.Transports(plan=plan))
    try:
        ctx, doc = await company(client)
        await with_key(ctx, PLAN_TOKEN_PREFIX + "01-spare")
        d = await start(client, ctx, subject=section(doc))
        reply = (await say(client, ctx, d["id"], "commenter", ASK))["reply"]
        reading = asyncio.ensure_future(read_stream(client, ctx, d["id"], reply["id"]))
        for _ in range(200):
            if (await row(ctx, reply["id"])).body:
                break
            await asyncio.sleep(0.05)
        pid = int(pidfile.read_text())
        refused = await client.post(
            f"/v1/discussions/{d['id']}/messages/{reply['id']}/cancel", headers=ctx.as_("owner")
        )
        assert refused.status_code == 200  # an approver or above may stop it too
        asked_at = asyncio.get_running_loop().time()
        evs = await asyncio.wait_for(reading, 10)
        assert asyncio.get_running_loop().time() - asked_at < 1.5
        stopped = await row(ctx, reply["id"])
        assert (stopped.status, stopped.body) == ("cancelled", "Partial answer")
        assert evs[-1][0] == "done" and evs[-1][1]["status"] == "cancelled"
        assert not _running(pid)
        viewer = await client.post(
            f"/v1/discussions/{d['id']}/messages/{reply['id']}/retry", headers=ctx.as_("viewer")
        )
        assert viewer.status_code == 403
        again = await client.post(
            f"/v1/discussions/{d['id']}/messages/{reply['id']}/retry",
            headers=ctx.as_("commenter"),
        )
        assert again.status_code == 200, again.text
        assert (again.json()["status"], again.json()["body"]) == ("pending", "")
    finally:
        gateway.set_transports(previous)


async def intake_by(ctx, who: str, levels: dict[str, str]) -> ProductIntake:
    """An intake by ``who`` with one model finding per level, each with its own line."""
    async with tenant_session(ctx.tenant_id) as s:
        findings = {}
        for level, line in levels.items():
            findings[str(uuid.uuid4())] = {
                "kind": "item", "origin": "model", "category": "pain_evidence",
                "source_item_ids": [], "summary": f"Fixed line for {level}",
                "draft": line, "published": line if level != "private" else None,
                "sharing": level,
            }  # fmt: skip
        intake = ProductIntake(
            title="Saved addresses",
            brief="Returning buyers retype their address.",
            author_id=ctx.users[who].id,
            analysis={"findings": findings},
        )
        s.add(intake)
        await s.commit()
        return intake


# protects=criterion 8 (card: context S6): the context never reads source_items nor calls
# search, and an open discussion reads only the finding shared at summary; fails_when=a
# source item is read or the private finding enters; no_claim=what the model writes.
async def test_the_context_reads_only_what_everyone_may_see(client, fake, monkeypatch):
    ctx, _doc = await company(client)
    await with_key(ctx)
    intake = await intake_by(
        ctx, "commenter", {"private": "Churned buyers named in calls", "summary": "Buyers retype"}
    )

    async def no_search(*a, **k):
        raise AssertionError("a reply must never call source search")

    monkeypatch.setattr(search_service, "search", no_search)
    statements: list[str] = []

    def spy(conn, cursor, statement, *args):
        statements.append(statement)

    engine = get_engine().sync_engine
    event.listen(engine, "before_cursor_execute", spy)
    try:
        d = await start(
            client, ctx, subject_kind="intake", subject={"intake_id": str(intake.id)},
            title="Saved addresses",
        )  # fmt: skip
        reply = (await say(client, ctx, d["id"], "commenter", ASK))["reply"]
        await read_stream(client, ctx, d["id"], reply["id"])
    finally:
        event.remove(engine, "before_cursor_execute", spy)
    prompt = fake.requests[0].messages[0]["content"]
    assert "Buyers retype" in prompt
    assert "Churned buyers" not in prompt
    assert "not instructions to you" in prompt
    assert statements and not any("source_items" in s for s in statements)


# protects=criterion 9: in the author's own private-finding discussion (rule 3.4.3) the
# finding is read as its author sees it; fails_when=it is missing there; no_claim=other
# readers (they cannot open it).
async def private_gap(ctx) -> tuple[ProductIntake, uuid.UUID]:
    """The commenter's intake with one private model gap, below Summary (rule 3.4.3)."""
    gap_id = uuid.uuid4()
    async with tenant_session(ctx.tenant_id) as s:
        intake = ProductIntake(
            title="Saved addresses", brief="Returning buyers retype their address.",
            author_id=ctx.users["commenter"].id,
            analysis={"findings": {str(gap_id): {
                "kind": "gap", "origin": "model", "category": "pain_evidence",
                "source_item_ids": [], "summary": "A gap from the author's sources",
                "sharing": "private", "gap_id": str(gap_id),
            }}},
        )  # fmt: skip
        s.add(intake)
        await s.flush()
        s.add(
            KnowledgeGap(
                id=gap_id, intake_id=intake.id, category="pain_evidence",
                statement="Is the rollout limited to the north region?", impact=[],
                importance="high", knowledge_state="unknown", status="unknown",
            )
        )  # fmt: skip
        await s.commit()
    return intake, gap_id


async def test_the_authors_own_discussion_reads_the_private_finding(client, fake):
    ctx, _doc = await company(client)
    await with_key(ctx)
    _intake, gap_id = await private_gap(ctx)
    d = await start(client, ctx, subject_kind="gap", subject={"gap_id": str(gap_id)})
    assert d["author_only"] is True
    reply = (await say(client, ctx, d["id"], "commenter", ASK))["reply"]
    await read_stream(client, ctx, d["id"], reply["id"])
    assert "limited to the north region" in fake.requests[0].messages[0]["content"]


# protects=finding 1 of the #297 review (rule 3.4.3 is decided when Oracle reads): once
# the author shares the finding at Summary, others may join, so Oracle reads it as
# everyone does; fails_when=the stored author_only flag still lets the private statement
# into the context; no_claim=what the model writes.
async def test_a_finding_shared_at_summary_is_read_as_everyone_sees_it(client, fake):
    ctx, _doc = await company(client)
    await with_key(ctx)
    intake, gap_id = await private_gap(ctx)
    d = await start(client, ctx, subject_kind="gap", subject={"gap_id": str(gap_id)})
    assert d["author_only"] is True
    shared = await client.patch(
        f"/v1/intakes/{intake.id}/findings/{gap_id}",
        json={"sharing": "summary"},
        headers=ctx.as_("commenter"),
    )
    assert shared.status_code == 200, shared.text
    reply = (await say(client, ctx, d["id"], "commenter", ASK))["reply"]
    await read_stream(client, ctx, d["id"], reply["id"])
    prompt = fake.requests[0].messages[0]["content"]
    assert "Gap (pain_evidence)" in prompt
    assert "north region" not in prompt


# protects=criterion 10: the private-findings notice goes to the intake's author only, and
# the key is absent for anyone else; fails_when=another reader learns the count;
# no_claim=the notice's wording (E2E).
async def test_private_findings_notice_is_the_authors_only(client):
    ctx, _doc = await company(client)
    intake = await intake_by(ctx, "commenter", {"private": "Hidden", "summary": "Shown"})
    d = await start(
        client, ctx, subject_kind="intake", subject={"intake_id": str(intake.id)},
        title="Saved addresses",
    )  # fmt: skip
    mine = await get(client, ctx, d["id"], "commenter")
    assert mine["me"]["private_findings"] == {"count": 1, "intake_id": str(intake.id)}
    for who in ("approver", "owner", "viewer"):
        assert "private_findings" not in (await get(client, ctx, d["id"], who))["me"]


# protects=criterion 11: the 21st reply asked by one person within 10 minutes is 429 with
# its copy, and the message is still stored; fails_when=the limit is missing or the
# message is lost; no_claim=the per-discussion daily limit (same code path).
async def test_the_reply_limit(client):
    ctx, doc = await company(client)
    d = await start(client, ctx, subject=section(doc))
    for i in range(20):
        assert (await say(client, ctx, d["id"], "commenter", f"Question {i}"))["reply"]
    body = await say(client, ctx, d["id"], "commenter", "One more", expect=429)
    assert body["detail"] == (
        "Oracle has answered a lot here in a short time. Try again in 10 minutes."
    )
    resp = await client.get(
        f"/v1/discussions/{d['id']}/messages", params={"limit": 200}, headers=ctx.as_("commenter")
    )
    assert resp.json()["items"][-1]["body"] == "One more"


# protects=a failed reply reads the gateway's message to approvers and owners and the plain
# copy to others, with Retry; fails_when=a commenter sees account details; no_claim=the UI.
async def test_no_account_fails_the_reply_with_the_right_copy(client):
    ctx, doc = await company(client)
    d = await start(client, ctx, subject=section(doc))
    reply = (await say(client, ctx, d["id"], "commenter", ASK))["reply"]
    evs = await read_stream(client, ctx, d["id"], reply["id"])
    assert evs[-1][0] == "error"
    assert evs[-1][1] == {
        "reason": "no_account",
        "message": "Oracle can't reply right now.",
        "retry": True,
    }
    resp = await client.get(f"/v1/discussions/{d['id']}/messages", headers=ctx.as_("approver"))
    failed = [m for m in resp.json()["items"] if m["author_kind"] == "oracle"][0]
    assert failed["error"].startswith("No Claude account")
    assert failed["error_reason"] == "no_account"


# protects=criterion 12: MCP lists create_discussion_message and not the stream, and
# wait=true answers with the finished reply; fails_when=the raw stream is a tool or wait
# returns a pending reply; no_claim=other MCP clients.
async def test_mcp_waits_for_the_reply_instead_of_streaming(client, fake):
    ctx, doc = await company(client)
    await with_key(ctx)
    d = await start(client, ctx, subject=section(doc))
    token = await user_token(ctx.tenant_id, ctx.users["commenter"])
    async with mcp_client(token) as c:
        names = {t.name for t in (await c.list_tools()).tools}
        assert {"create_discussion_message", "cancel_discussion_reply"} <= names
        assert "retry_discussion_reply" in names and "stream_discussion_reply" not in names
        out = await c.call_tool(
            "create_discussion_message",
            {"discussion_id": d["id"], "wait": True, "body": {"body": ASK}},
        )
    assert not out.is_error, text_of(out)
    posted = json.loads(text_of(out))
    assert posted["reply"]["status"] == "complete"
    assert posted["reply"]["body"] == "".join(CHUNKS)
    assert fake.calls == 1
    from oracle.mcp.tools import _exclusion

    assert _exclusion("stream_discussion_reply", "/v1/x", [], None) == (
        "a live stream; call create_discussion_message with wait=true"
    )


# protects=a person removed while a reply streams stops reading it (forbidden);
# fails_when=a removed person keeps reading a private discussion; no_claim=the UI.
async def test_a_removed_participant_stops_reading(client, fake):
    fake.pause = 0.4
    ctx, doc = await company(client)
    await with_key(ctx)
    d = await start(
        client, ctx, subject=section(doc), visibility="private",
        participants=[uid(ctx, "approver")],
    )  # fmt: skip
    reply = (await say(client, ctx, d["id"], "commenter", ASK, mention_oracle=True))["reply"]
    reading = asyncio.ensure_future(read_stream(client, ctx, d["id"], reply["id"], "approver"))
    await asyncio.sleep(0.3)
    resp = await client.delete(
        f"/v1/discussions/{d['id']}/participants/{uid(ctx, 'approver')}",
        headers=ctx.as_("commenter"),
    )
    assert resp.status_code == 204, resp.text
    evs = await asyncio.wait_for(reading, 10)
    assert evs[-1] == ("error", {"reason": "forbidden", "message": "", "retry": False})
    for _ in range(100):
        if (await row(ctx, reply["id"])).status == "complete":
            break
        await asyncio.sleep(0.1)
    assert (await row(ctx, reply["id"])).status == "complete"


async def stop(client, ctx, d_id, reply_id, who="commenter", expect=200, **headers):
    resp = await client.post(
        f"/v1/discussions/{d_id}/messages/{reply_id}/cancel", headers={**ctx.as_(who), **headers}
    )
    assert resp.status_code == expect, resp.text
    return resp


async def again(client, ctx, d_id, reply_id, who="commenter", expect=200, **headers):
    resp = await client.post(
        f"/v1/discussions/{d_id}/messages/{reply_id}/retry", headers={**ctx.as_(who), **headers}
    )
    assert resp.status_code == expect, resp.text
    return resp


# protects=finding 2 of the #297 review: Retry asks Oracle again, so it is held to the
# reply limit, and each retry counts as an answer; fails_when=a 21st answer within 10
# minutes runs through Retry; no_claim=the per-discussion daily limit (same code path).
async def test_retry_is_held_to_the_reply_limit(client):
    ctx, doc = await company(client)
    d = await start(client, ctx, subject=section(doc))
    asked = [await say(client, ctx, d["id"], "commenter", f"Question {i}") for i in range(20)]
    last = asked[-1]["reply"]["id"]
    await stop(client, ctx, d["id"], last)
    refused = await again(client, ctx, d["id"], last, expect=429)
    assert refused.json()["detail"] == (
        "Oracle has answered a lot here in a short time. Try again in 10 minutes."
    )
    assert (await row(ctx, last)).status == "cancelled"
    # One reply retried over and over is held to the same limit.
    d2 = await start(client, ctx, subject=section(doc, key="users"))
    first = (await say(client, ctx, d2["id"], "approver", ASK, mention_oracle=True))["reply"]["id"]
    for _ in range(19):
        await stop(client, ctx, d2["id"], first, "approver")
        await again(client, ctx, d2["id"], first, "approver")
    await stop(client, ctx, d2["id"], first, "approver")
    await again(client, ctx, d2["id"], first, "approver", expect=429)


# protects=finding 3 of the #297 review: Stop and Retry are body-less POSTs a browser
# sends cross-site without a preflight, so they refuse a cross-site request signed in by
# the session cookie; fails_when=another site stops or re-runs a reply; no_claim=bearer
# tokens (never sent by a browser on its own).
async def test_stop_and_retry_refuse_a_cross_site_request(client):
    ctx, doc = await company(client)
    d = await start(client, ctx, subject=section(doc))
    reply = (await say(client, ctx, d["id"], "commenter", ASK))["reply"]["id"]
    for cross in ({"Origin": "https://evil.example.net"}, {"Sec-Fetch-Site": "cross-site"}):
        resp = await stop(client, ctx, d["id"], reply, expect=403, **cross)
        assert "Cross-site" in resp.json()["detail"]
    assert (await row(ctx, reply)).status == "pending"
    await stop(client, ctx, d["id"], reply, Origin="http://localhost:3000")
    for cross in ({"Origin": "https://evil.example.net"}, {"Sec-Fetch-Site": "cross-site"}):
        resp = await again(client, ctx, d["id"], reply, expect=403, **cross)
        assert "Cross-site" in resp.json()["detail"]
    assert (await row(ctx, reply)).status == "cancelled"
