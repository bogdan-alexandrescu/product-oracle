"""Live Ask lane 2 (#710): Ask's reply run gets the live tools only in a private chat.

The reply runs through the real Claude Code transport with a fake ``claude`` binary (as
tests/test_discussion_replies.py's Stop test does): it writes what it was started with
(argv, environment, the MCP config file it was pointed at) and waits for the test to
tell it what to answer, so the test can call the live tools with the reply's token while
the reply streams, as Claude Code would. The source is lane 1's fake archive (invented
meetings); its key is ``LIVE_KEY``.

Card (file): protects=spec #710 section 2 (the live decision, the MCP server on the
transport, the prompt blocks, revoke at the end), section 4's API side (``[l:n]``
citations) and amendment C6; fails_when=a shared chat's run gets MCP, a private one does
not, the Fireflies key reaches Claude Code, a token outlives its reply, or a live
citation is lost or invented; no_claim=the real claude binary's MCP client and the web
chip (lane 3).
"""

import asyncio
import json
import logging
import os
import stat
import uuid

import pytest
from sqlalchemy import text

from oracle.claude_accounts.fallback import PLAN_TOKEN_PREFIX
from oracle.discussions import replies
from oracle.jobs import prompting
from oracle.llm import gateway
from oracle.llm.transports import ClaudeCodeTransport
from oracle.swarm.settings import get_runtime_settings
from oracle.tenancy import tenant_session
from tests.live_fakes import ARCHIVE_ENDPOINT, LIVE_KEY, FakeSources
from tests.test_discussion_replies import ASK, Fake, read_stream, row, say, with_key
from tests.test_discussions import company, private_with_approver, section, start
from tests.test_live_fireflies import LABEL, _fireflies
from tests.test_mcp import mcp_client, text_of

PLAN = PLAN_TOKEN_PREFIX + "01-spare"
OFF_HERE = "Live reads are off: others can read this discussion."
NO_CONNECTION = "You have no Fireflies connection. Connect one in Settings > Connections."

FAKE_CLAUDE = """#!/usr/bin/env python3
import json, os, sys, time
prompt = sys.stdin.read()
argv = sys.argv[1:]
config = None
if "--mcp-config" in argv:
    config = open(argv[argv.index("--mcp-config") + 1]).read()
dump = {"argv": argv, "env": dict(os.environ), "config": config, "prompt": prompt}
open(__DUMP__ + ".part", "w").write(json.dumps(dump))
os.rename(__DUMP__ + ".part", __DUMP__)
go = __GO__
for _ in range(1200):
    if os.path.exists(go):
        break
    time.sleep(0.05)
answer = open(go).read() if os.path.exists(go) else "No go."
if answer == "FAIL":
    print(json.dumps({"type": "result", "is_error": True, "result": "boom",
                      "subtype": "error_during_execution"}), flush=True)
    sys.exit(0)
print(json.dumps({"type": "stream_event", "event": {"type": "content_block_delta",
      "delta": {"type": "text_delta", "text": answer}}}), flush=True)
print(json.dumps({"type": "result", "result": answer, "usage": {},
                  "modelUsage": {"claude-test": {}}}), flush=True)
"""


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


class Claude:
    def __init__(self, tmp_path):
        self.script = tmp_path / "claude"
        self.dump = tmp_path / "dump.json"
        self.go = tmp_path / "go"
        self.script.write_text(
            FAKE_CLAUDE.replace("__DUMP__", repr(str(self.dump))).replace(
                "__GO__", repr(str(self.go))
            )
        )
        self.script.chmod(self.script.stat().st_mode | stat.S_IEXEC)

    async def started(self) -> dict:
        for _ in range(400):
            if self.dump.exists():
                return json.loads(self.dump.read_text())
            await asyncio.sleep(0.05)
        raise AssertionError("the fake claude never started")

    def answer(self, text_: str) -> None:
        self.go.write_text(text_)


@pytest.fixture
def claude(tmp_path):
    fake = Claude(tmp_path)
    previous = gateway.set_transports(
        gateway.Transports(plan=ClaudeCodeTransport(claude_bin=str(fake.script), timeout=90))
    )
    yield fake
    gateway.set_transports(previous)


def after(argv: list[str], flag: str) -> str:
    return argv[argv.index(flag) + 1]


async def token_rows(ctx) -> list[dict]:
    async with tenant_session(ctx.tenant_id) as s:
        rows = (await s.execute(text("SELECT * FROM live_tokens"))).mappings()
        return [dict(r) for r in rows]


async def mcp_status(client, raw: str) -> int:
    resp = await client.post(
        "/mcp",
        json={"jsonrpc": "2.0", "id": 1, "method": "tools/list"},
        headers={"Authorization": f"Bearer {raw}", "Accept": "application/json"},
    )
    return resp.status_code


async def private_chat(client, ctx, doc) -> dict:
    return await start(client, ctx, subject=section(doc), visibility="private")


# protects=section 2 and 4 end to end: in a private chat whose asker has a live connection
# the run gets one MCP server (Oracle's /mcp with an olt_ token) in a config file inside
# its temporary HOME, --allowedTools mcp__oracle__live_* and built-in tools still off; the
# prompt gains the Live sources block; the tools read as the asker while the reply
# streams; [l:n] markers become live citations from live_reads and an unmatched one is
# dropped; the token is revoked when the reply ends; the Fireflies key is in no argv,
# environment, config file, tool result, live_reads row or log; fails_when=any of these
# drifts; no_claim=the real claude binary's MCP client.
async def test_private_chat_run_gets_the_live_tools(client, sources, claude, caplog):
    caplog.set_level(logging.DEBUG)
    ctx, doc = await company(client)
    await with_key(ctx, PLAN)
    conn = await _fireflies(ctx.tenant_id, ctx.users["commenter"], ARCHIVE_ENDPOINT)
    d = await private_chat(client, ctx, doc)
    reply = (await say(client, ctx, d["id"], "commenter", "How many meetings can you read?"))[
        "reply"
    ]
    reading = asyncio.ensure_future(read_stream(client, ctx, d["id"], reply["id"]))
    started = await claude.started()
    argv = started["argv"]
    assert after(argv, "--tools") == ""
    assert "--strict-mcp-config" in argv
    assert after(argv, "--allowedTools") == "mcp__oracle__live_*"
    config_path = after(argv, "--mcp-config")
    assert config_path.startswith(started["env"]["HOME"] + os.sep)
    config = json.loads(started["config"])
    assert list(config["mcpServers"]) == ["oracle"]
    server = config["mcpServers"]["oracle"]
    assert server["url"] == get_runtime_settings().public_url.rstrip("/") + "/mcp"
    raw = server["headers"]["Authorization"].removeprefix("Bearer ")
    assert raw.startswith("olt_")
    system = after(argv, "--system-prompt")
    assert "Live sources" in system and LABEL in system and str(conn) in system
    assert "[l:n]" in system
    assert OFF_HERE not in system and NO_CONNECTION not in system

    results = []
    async with mcp_client(raw) as m:
        for tool, args in (
            ("live_fireflies_list_meetings", {"connection_id": str(conn), "limit": 1}),
            ("live_fireflies_get_meeting", {"connection_id": str(conn), "meeting_id": "m-301"}),
        ):
            result = await m.call_tool(tool, args)
            assert not result.is_error, text_of(result)
            results.append(text_of(result))
    assert '"total":4321' in results[0].replace(" ", "")
    assert '"ref":"l:2"' in results[1].replace(" ", "")
    claude.answer("You can read 4,321 meetings [l:1]. m-301 is Roadmap review [l:2] [l:9].")
    events = await asyncio.wait_for(reading, 30)
    assert events[-1][0] == "done"

    done = await row(ctx, reply["id"])
    assert done.status == "complete"
    assert done.body == "You can read 4,321 meetings [l:1]. m-301 is Roadmap review [l:2] ."
    live = [c for c in done.citations if c.get("kind") == "live"]
    assert [(c["ref"], c["source"], c["call"], c["item_id"]) for c in live] == [
        ("l:1", LABEL, "list_meetings", None),
        ("l:2", LABEL, "get_meeting", "m-301"),
    ]
    assert all(c["read_at"] for c in live)
    listed = await client.get(f"/v1/discussions/{d['id']}/messages", headers=ctx.as_("commenter"))
    assert listed.status_code == 200, listed.text
    assert "list_meetings" in listed.text

    # The token is revoked: MCP no longer knows it.
    [token] = await token_rows(ctx)
    assert token["revoked_at"] is not None and token["message_id"] == uuid.UUID(reply["id"])
    assert await mcp_status(client, raw) == 401
    assert not os.path.exists(config_path), "the temporary HOME outlived the run"

    async with tenant_session(ctx.tenant_id) as s:
        reads = [dict(r) for r in (await s.execute(text("SELECT * FROM live_reads"))).mappings()]
    for where, seen in {
        "argv": json.dumps(argv),
        "environment": json.dumps(started["env"]),
        "MCP config": started["config"],
        "prompt": started["prompt"],
        "tool results": "".join(results),
        "live_reads": str(reads),
        "logs": caplog.text,
    }.items():
        assert LIVE_KEY not in seen, f"the Fireflies key is in the {where}"


# protects=section 2.4 and AC4: in a chat with two people the run gets no MCP server
# (asserted on argv) and no token is minted; the prompt says live reads are off because
# others can read it; fails_when=a shared chat's run can read the asker's sources;
# no_claim=the panel's line (lane 3).
async def test_shared_chat_run_gets_no_mcp(client, sources, claude):
    ctx, doc = await company(client)
    await with_key(ctx, PLAN)
    await _fireflies(ctx.tenant_id, ctx.users["commenter"], ARCHIVE_ENDPOINT)
    d = await private_with_approver(client, ctx, doc)
    reply = (await say(client, ctx, d["id"], "commenter", ASK, mention_oracle=True))["reply"]
    reading = asyncio.ensure_future(read_stream(client, ctx, d["id"], reply["id"]))
    argv = (await claude.started())["argv"]
    claude.answer("Live reads are off here.")
    await asyncio.wait_for(reading, 30)
    assert "--mcp-config" not in argv and "--allowedTools" not in argv
    assert after(argv, "--tools") == ""
    system = after(argv, "--system-prompt")
    assert OFF_HERE in system and "Live sources" not in system
    assert await token_rows(ctx) == []


# protects=the rollback switch: ORACLE_LIVE_READS=off gives a private chat's run no MCP
# server and no token; fails_when=the switch leaves live reads on in replies; no_claim=-.
async def test_switch_off_gives_no_mcp(client, sources, claude, monkeypatch):
    from oracle.config import get_settings

    monkeypatch.setattr(get_settings(), "live_reads", "off")
    ctx, doc = await company(client)
    await with_key(ctx, PLAN)
    await _fireflies(ctx.tenant_id, ctx.users["commenter"], ARCHIVE_ENDPOINT)
    d = await private_chat(client, ctx, doc)
    reply = (await say(client, ctx, d["id"], "commenter", ASK))["reply"]
    reading = asyncio.ensure_future(read_stream(client, ctx, d["id"], reply["id"]))
    argv = (await claude.started())["argv"]
    claude.answer("Fine.")
    await asyncio.wait_for(reading, 30)
    assert "--mcp-config" not in argv
    assert "Live sources" not in after(argv, "--system-prompt")
    assert await token_rows(ctx) == []


# protects=section 2.5: the token is revoked when the reply ends failed or cancelled too;
# fails_when=a failed or stopped reply leaves a token that still reads; no_claim=-.
@pytest.mark.parametrize("ending", ["failed", "cancelled"])
async def test_token_revoked_when_the_reply_fails_or_stops(client, sources, claude, ending):
    ctx, doc = await company(client)
    await with_key(ctx, PLAN)
    await _fireflies(ctx.tenant_id, ctx.users["commenter"], ARCHIVE_ENDPOINT)
    d = await private_chat(client, ctx, doc)
    reply = (await say(client, ctx, d["id"], "commenter", ASK))["reply"]
    reading = asyncio.ensure_future(read_stream(client, ctx, d["id"], reply["id"]))
    config = json.loads((await claude.started())["config"])
    raw = config["mcpServers"]["oracle"]["headers"]["Authorization"].removeprefix("Bearer ")
    assert await mcp_status(client, raw) == 200
    if ending == "failed":
        claude.answer("FAIL")
    else:
        stop = await client.post(
            f"/v1/discussions/{d['id']}/messages/{reply['id']}/cancel",
            headers=ctx.as_("commenter"),
        )
        assert stop.status_code == 200, stop.text
    await asyncio.wait_for(reading, 30)
    assert (await row(ctx, reply["id"])).status == ending
    [token] = await token_rows(ctx)
    assert token["revoked_at"] is not None
    assert await mcp_status(client, raw) == 401


# protects=section 2.2: with an API key (the Messages API transport) the reply is not
# live: the request carries no MCP server and no Live sources block; fails_when=the
# Messages API gets the live tools; no_claim=-.
async def test_messages_api_never_gets_mcp(client, sources):
    model = Fake()
    previous = gateway.set_transports(
        gateway.Transports(plan=ClaudeCodeTransport(claude_bin="/nonexistent"), api_key=model)
    )
    try:
        ctx, doc = await company(client)
        await with_key(ctx)
        await _fireflies(ctx.tenant_id, ctx.users["commenter"], ARCHIVE_ENDPOINT)
        d = await private_chat(client, ctx, doc)
        await say(client, ctx, d["id"], "commenter", ASK, params={"wait": "true"})
    finally:
        gateway.set_transports(previous)
    [request] = model.requests
    assert getattr(request, "mcp", None) is None
    assert "Live sources" not in request.system


# protects=section 2.1 (#718 review): when the gateway runs the reply on the Messages API
# (an API key), no live token is minted at all, not only no MCP server sent; fails_when=a
# token is minted for a run that cannot use it; no_claim=-.
async def test_messages_api_mints_no_token(client, sources):
    model = Fake()
    previous = gateway.set_transports(
        gateway.Transports(plan=ClaudeCodeTransport(claude_bin="/nonexistent"), api_key=model)
    )
    try:
        ctx, doc = await company(client)
        await with_key(ctx)
        await _fireflies(ctx.tenant_id, ctx.users["commenter"], ARCHIVE_ENDPOINT)
        d = await private_chat(client, ctx, doc)
        await say(client, ctx, d["id"], "commenter", ASK, params={"wait": "true"})
    finally:
        gateway.set_transports(previous)
    assert len(model.requests) == 1
    assert await token_rows(ctx) == []


class McpFake(Fake):
    """Oracle's model on a transport that takes an MCP server, as Claude Code does."""

    takes_mcp = True


# protects=amendment C6 (#718 review, CI run 40368520080): the no-connection line goes only
# where a live read could happen: a chat private to the asker, on the Claude Code
# transport, with the switch on; an open chat, a chat with others and the Messages API get
# the prompt unchanged; fails_when=the line reaches a chat others can read or a transport
# that has no live tools; no_claim=the line's words (test_no_connection_adds_one_line).
async def test_no_connection_line_only_where_live_could_read(client):
    ctx, doc = await company(client)
    await with_key(ctx, PLAN)
    base = prompting.current(replies.JOB)[1]
    on_mcp, on_api = McpFake(), Fake()
    previous = gateway.set_transports(gateway.Transports(plan=on_mcp, api_key=on_api))
    try:
        opened = await start(client, ctx, subject=section(doc), visibility="open")
        await say(client, ctx, opened["id"], "commenter", ASK, params={"wait": "true"})
    finally:
        gateway.set_transports(previous)
    [request] = on_mcp.requests
    assert request.system == base
    await with_key(ctx)
    previous = gateway.set_transports(
        gateway.Transports(plan=ClaudeCodeTransport(claude_bin="/nonexistent"), api_key=on_api)
    )
    try:
        d = await private_chat(client, ctx, doc)
        await say(client, ctx, d["id"], "commenter", ASK, params={"wait": "true"})
    finally:
        gateway.set_transports(previous)
    [request] = on_api.requests
    assert request.system == base


# protects=amendment C6 and AC12: an asker with no live connection, in a private chat on a
# transport that takes MCP (as Claude Code), gets exactly one more prompt line, telling the
# model the no-connection sentence, and no token; fails_when=the
# line is missing, worded otherwise, or anything else in the prompt changes;
# no_claim=-.
async def test_no_connection_adds_one_line(client):
    model = McpFake()
    previous = gateway.set_transports(gateway.Transports(plan=model, api_key=Fake()))
    try:
        ctx, doc = await company(client)
        await with_key(ctx, PLAN)
        d = await private_chat(client, ctx, doc)
        await say(client, ctx, d["id"], "commenter", ASK, params={"wait": "true"})
    finally:
        gateway.set_transports(previous)
    [request] = model.requests
    base = prompting.current(replies.JOB)[1]
    assert request.system.startswith(base)
    extra = request.system[len(base) :].strip()
    assert NO_CONNECTION in extra and "\n" not in extra
    assert await token_rows(ctx) == []


# protects=section 4: citations_of maps [l:n] through the reply's live reads to
# {kind: live, source, call, read_at, item_id} and drops an [l:n] that matches no read,
# next to [c:n] as before; fails_when=a live marker is kept without a read or loses its
# read; no_claim=the stream (the end-to-end test above).
async def test_live_citations_mapping():
    from oracle.discussions import context

    ctx = context.Context()
    ctx.add("entity", "g1", "Goal: Activation", "Raise activation")
    live = {
        1: {
            "kind": "live", "ref": "l:1", "source": LABEL, "call": "list_meetings",
            "read_at": "2026-10-26T14:42:00+00:00", "item_id": None,
        },
    }  # fmt: skip
    body, cites = replies.citations_of("Count [l:1], goal [c:1], none [l:4] [c:7].", ctx, live)
    assert body == "Count [l:1], goal [c:1], none  ."
    assert [c.get("kind") for c in cites] == ["entity", "live"]
    assert cites[1] == live[1]
