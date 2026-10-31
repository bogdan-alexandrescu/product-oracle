"""meet-chat-own-key: a meeting's chat has its own discussion, apart from Oracle's Ask panel
on the same page. Against Postgres; the models are fakes.

Uses test_simple_chat_api's world and fake S8 meetings module, test_discussion_replies'
fake model.

Test cards (protects / fails_when / no_claim):

- test_an_ask_before_the_chat_opens_keeps_its_own_thread: protects=an Ask question on the
  meeting's page asked before anyone writes in the meeting's chat stays in its Ask
  discussion (with Oracle's reply), and the meeting chat's first line starts the chat's own
  thread; GET chat answers 200 throughout; the minutes' record reads the chat's lines only;
  fails_when=the meeting chat adopts the Ask discussion (same subject key), so the Ask
  question and its reply show in the chat and the chat's line in the Ask panel;
  no_claim=the reply's words.
- test_an_ask_after_the_chat_opens_keeps_its_own_thread: protects=the same with the chat
  opened first; fails_when=the Ask line lands in the chat or the chat's in the Ask
  discussion; no_claim=the reader's wording.
"""

import types
import uuid
from datetime import timedelta

from oracle.discussions import replies
from oracle.simple import minutes
from oracle.tenancy import tenant_session
from tests.test_discussion_replies import fake, with_key  # noqa: F401 -- the fixture
from tests.test_simple_chat_api import (
    World,
    make_people,
    meetings,  # noqa: F401 -- the fixture
)
from tests.test_simple_chat_reader import _meeting, _url, post

ASK = "what is late?"
CHAT = "Move Bulk import to start on Dec 1, 2026."


async def chat_of(client, ctx, who, mid) -> list[dict]:
    r = await client.get(_url(mid), headers=ctx.as_(who))
    assert r.status_code == 200, r.text
    return r.json()["messages"]


async def ask(client, ctx, who, mid) -> str:
    """Oracle's Ask panel on the meeting's page: a discussion on the page's screen."""
    r = await client.post(
        "/v1/discussions",
        json={"subject_kind": "screen", "subject": {"path": f"/simple/meetings/{mid}"},
              "origin": "panel", "visibility": "private"},
        headers=ctx.as_(who),
    )  # fmt: skip
    assert r.status_code == 201, r.text
    d = r.json()["id"]
    r = await client.post(f"/v1/discussions/{d}/messages", headers=ctx.as_(who),
                          json={"body": ASK, "mention_oracle": False})  # fmt: skip
    assert r.status_code == 201, r.text
    return d


async def ask_lines(client, ctx, who, d) -> list[dict]:
    r = await client.get(f"/v1/discussions/{d}/messages", headers=ctx.as_(who))
    assert r.status_code == 200, r.text
    return r.json()["items"]


async def record_chat(ctx, mid) -> list[str]:
    async with tenant_session(ctx.tenant_id) as s:
        out = await minutes.record(s, types.SimpleNamespace(id=mid), [], [])
    return [line.text for line in out.chat]


async def check_apart(client, ctx, mid, d) -> None:
    chat = await chat_of(client, ctx, "owner", mid)
    assert [m["body"] for m in chat if m["author_kind"] == "person"] == [CHAT]
    assert ASK not in [m["body"] for m in chat]
    assert all(m["kind"] != "answer" or m["body"] != "Here is what I found." for m in chat)
    # Another attendee sees the same chat, and the Ask question is not in it.
    assert [m["id"] for m in await chat_of(client, ctx, "decider", mid)] == [m["id"] for m in chat]
    asked = await ask_lines(client, ctx, "owner", d)
    bodies = [m["body"] for m in asked]
    assert ASK in bodies and CHAT not in bodies
    assert await record_chat(ctx, mid) == [CHAT]


async def test_an_ask_before_the_chat_opens_keeps_its_own_thread(
    client,
    meetings,  # noqa: F811
    fake,  # noqa: F811
    monkeypatch,
):
    ctx = await make_people()
    await World(ctx).build()
    await with_key(ctx)
    mid = _meeting(ctx, meetings)
    monkeypatch.setattr(replies, "PENDING_GRACE", timedelta(seconds=-60))
    assert await chat_of(client, ctx, "owner", mid) == []
    d = await ask(client, ctx, "owner", mid)
    out = await replies.run_pending(ctx.tenant_id)
    assert (out.ran, out.completed) == (1, 1)
    # The chat has not opened: the Ask discussion is not it.
    assert await chat_of(client, ctx, "owner", mid) == []
    await post(client, ctx, "owner", CHAT, mid)
    await check_apart(client, ctx, mid, d)
    r = await client.get(_url(mid), headers=ctx.as_("owner"))
    assert uuid.UUID(r.json()["id"]) != uuid.UUID(d)


async def test_an_ask_after_the_chat_opens_keeps_its_own_thread(
    client,
    meetings,  # noqa: F811
    fake,  # noqa: F811
    monkeypatch,
):
    ctx = await make_people()
    await World(ctx).build()
    await with_key(ctx)
    mid = _meeting(ctx, meetings)
    monkeypatch.setattr(replies, "PENDING_GRACE", timedelta(seconds=-60))
    await post(client, ctx, "owner", CHAT, mid)
    d = await ask(client, ctx, "owner", mid)
    out = await replies.run_pending(ctx.tenant_id)
    assert (out.ran, out.completed) == (1, 1)
    await check_apart(client, ctx, mid, d)
    r = await client.get(_url(mid), headers=ctx.as_("owner"))
    assert uuid.UUID(r.json()["id"]) != uuid.UUID(d)
