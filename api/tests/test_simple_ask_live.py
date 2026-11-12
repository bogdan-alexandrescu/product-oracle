"""Simple Ask live (#710 in Simple): a question in Simple's Ask Oracle panel (``POST
/v1/simple/chat/messages``, read by the ``chat_reader`` job) gets the same live reads as
Ask's discussion replies: in the person's own Ask chat, an asker with a live connection's
run gets Oracle's ``/mcp`` with a per-run ``olt_`` token and the live tools only; a shared
chat or a meeting's chat never does.

The run goes through the real worker and Claude Code transport with test_live_ask_replies'
fake ``claude`` binary; the source is the fake archive (invented meetings). Invented data
only.

Cards (protects / fails_when / no_claim):

- test_simple_ask_question_reads_live: protects=a Simple Ask panel question from a person
  with a live Fireflies connection runs the reader with one MCP server (Oracle's /mcp, an
  ``olt_`` token, ``--allowedTools mcp__oracle__live_*``) and the Live sources block; the
  tools read as the asker while it runs; the answer keeps its live read as the line's
  ``live_reads`` (the chip's words) and no raw ``[l:n]``; the token is revoked at the end;
  fails_when=the Simple reply answers from stored data with no live tools, the token
  outlives the reply, or the read is not on the line; no_claim=the real claude binary.
- test_shared_or_meeting_chat_gets_no_live_tools: protects=a meeting's chat line and an
  Ask chat someone else is in run the reader with no MCP server and mint no token;
  fails_when=a chat others read gets the asker's live reads; no_claim=the panel's line.
"""

import asyncio
import json
import uuid

import pytest
from sqlalchemy import select, text

from oracle import company_time
from oracle.discussions.models import DiscussionParticipant
from oracle.jobs import worker
from oracle.jobs.models import LlmJob
from oracle.tenancy import tenant_session
from tests.live_fakes import ARCHIVE_ENDPOINT
from tests.test_discussion_replies import with_key
from tests.test_live_ask_replies import (  # noqa: F401 -- the fixtures
    PLAN,
    after,
    claude,
    mcp_status,
    sources,
    token_rows,
)
from tests.test_live_fireflies import LABEL, _fireflies
from tests.test_mcp import mcp_client, text_of
from tests.test_simple_chat_api import (
    ASK,
    World,
    _meeting,
    make_people,
    meetings,  # noqa: F401 -- the fixture
)
from tests.test_simple_roadmap_api import NOW

QUESTION = "How many Fireflies meetings can you read right now?"


@pytest.fixture(autouse=True)
def clock(monkeypatch):
    monkeypatch.setattr(company_time, "now", lambda: NOW)


async def ask(client, ctx, who: str, line: str, meeting: uuid.UUID | None = None) -> dict:
    url = f"/v1/simple/meetings/{meeting}/chat/messages" if meeting else ASK
    body = {"text": line} if meeting else {"text": line, "only_understood": True, "new_chat": True,
                                            "general": True}  # fmt: skip
    r = await client.post(url, json=body, headers=ctx.as_(who))
    assert r.status_code == 200, r.text
    return r.json()


async def run_reader(ctx) -> asyncio.Future:
    """The queued chat_reader job, claimed and run by the worker in the background."""
    async with tenant_session(ctx.tenant_id) as s:
        queued = await s.scalar(
            select(LlmJob.id).where(LlmJob.kind == "chat_reader", LlmJob.status == "queued")
        )
    assert queued is not None, "the line was not sent to the reader"
    assert await worker.claim_next(ctx.tenant_id) == queued
    return asyncio.ensure_future(worker.run_job(ctx.tenant_id, queued))


def said(answer: str) -> str:
    return json.dumps({"actions": [], "clarify": None, "answer": answer})


async def test_simple_ask_question_reads_live(client, sources, claude):  # noqa: F811
    ctx = await make_people()
    await World(ctx).build()
    await with_key(ctx, PLAN)
    conn = await _fireflies(ctx.tenant_id, ctx.users["commenter"], ARCHIVE_ENDPOINT)
    out = await ask(client, ctx, "commenter", QUESTION)
    running = await run_reader(ctx)
    started = await claude.started()
    argv = started["argv"]
    assert after(argv, "--tools") == ""
    assert after(argv, "--allowedTools") == "mcp__oracle__live_*"
    config = json.loads(started["config"])
    assert list(config["mcpServers"]) == ["oracle"]
    raw = config["mcpServers"]["oracle"]["headers"]["Authorization"].removeprefix("Bearer ")
    assert raw.startswith("olt_")
    system = after(argv, "--system-prompt")
    assert "Live sources" in system and LABEL in system and str(conn) in system

    async with mcp_client(raw) as m:
        result = await m.call_tool(
            "live_fireflies_list_meetings", {"connection_id": str(conn), "limit": 1}
        )
    assert not result.is_error, text_of(result)
    assert '"total":4321' in text_of(result).replace(" ", "")
    claude.answer(said("You can read 4,321 Fireflies meetings [l:1]."))
    await asyncio.wait_for(running, 30)

    r = await client.get(f"/v1/simple/chat?chat={out['id']}", headers=ctx.as_("commenter"))
    assert r.status_code == 200, r.text
    line = r.json()["messages"][-1]
    assert line["author_kind"] == "oracle" and line["kind"] == "answer", line
    assert line["body"] == "You can read 4,321 Fireflies meetings."
    assert [(x["source"], x["call"]) for x in line["live_reads"]] == [(LABEL, "list_meetings")]
    assert all(x["read_at"] for x in line["live_reads"])

    [token] = await token_rows(ctx)
    assert token["revoked_at"] is not None
    assert await mcp_status(client, raw) == 401


@pytest.mark.parametrize("where", ["meeting", "shared"])
async def test_shared_or_meeting_chat_gets_no_live_tools(client, sources, claude, meetings, where):  # noqa: F811
    ctx = await make_people()
    await World(ctx).build()
    await with_key(ctx, PLAN)
    await _fireflies(ctx.tenant_id, ctx.users["owner"], ARCHIVE_ENDPOINT)
    if where == "meeting":
        mid = _meeting(ctx, meetings, "everyone")
        await ask(client, ctx, "owner", QUESTION, mid)
    else:
        out = await ask(client, ctx, "owner", QUESTION)
        async with tenant_session(ctx.tenant_id) as s:
            other = ctx.users["commenter"].id
            s.add(DiscussionParticipant(discussion_id=uuid.UUID(out["id"]), user_id=other,
                                        added_via="added"))  # fmt: skip
            await s.commit()
    running = await run_reader(ctx)
    argv = (await claude.started())["argv"]
    claude.answer(said("I can't read that here."))
    await asyncio.wait_for(running, 30)
    assert "--mcp-config" not in argv and "--allowedTools" not in argv
    assert "Live sources" not in after(argv, "--system-prompt")
    assert await token_rows(ctx) == []
    async with tenant_session(ctx.tenant_id) as s:
        assert (await s.execute(text("SELECT count(*) FROM live_reads"))).scalar() == 0
