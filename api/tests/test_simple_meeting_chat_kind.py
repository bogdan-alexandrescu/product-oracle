"""meet-chat-kind: a meeting's chat is answered by the Simple chat reader only, and one
stray Oracle line never takes the chat down. Against Postgres; the models are fakes.

Uses test_simple_chat_api's world and fake S8 meetings module, test_discussion_replies'
fake model.

Test cards (protects / fails_when / no_claim):

- test_a_change_request_in_a_meeting_gets_the_readers_reply: protects=a person's change
  request in a live meeting's chat ("Move <item> to start on <date>") is answered by the
  Simple reader (a card or a question) and never by the discussion reply job, even once
  its pending line is older than the reply sweep's grace; GET chat answers 200 throughout;
  fails_when=discussions.replies.run_pending claims the chat's pending line and writes a
  ``discussion_reply`` message there; no_claim=the reader's wording.
- test_a_stray_oracle_line_reads_as_an_answer: protects=an Oracle line whose prompt is not
  a chat kind (one an earlier build left in a meeting chat) reads as an answer with its
  body, and the chat answers 200; fails_when=GET chat answers 500 on an unknown kind;
  no_claim=how the stray line got there.
"""

import uuid
from datetime import timedelta

from sqlalchemy import select

from oracle.discussions import replies
from oracle.discussions.models import DiscussionMessage
from oracle.tenancy import tenant_session
from tests.test_discussion_replies import fake, with_key  # noqa: F401 -- the fixture
from tests.test_simple_chat_api import (
    World,
    make_people,
    meetings,  # noqa: F401 -- the fixture
)
from tests.test_simple_chat_reader import (  # noqa: F401 -- clock: the fixture
    _meeting,
    _url,
    act,
    actions,
    clock,
    post,
    read,
)


async def chat_of(client, ctx, who, mid) -> list[dict]:
    r = await client.get(_url(mid), headers=ctx.as_(who))
    assert r.status_code == 200, r.text
    return r.json()["messages"]


async def oracle_prompts(ctx) -> list[str | None]:
    async with tenant_session(ctx.tenant_id) as s:
        q = select(DiscussionMessage.prompt).where(DiscussionMessage.author_kind == "oracle")
        return list(await s.scalars(q))


async def test_a_change_request_in_a_meeting_gets_the_readers_reply(
    client,
    meetings,  # noqa: F811
    fake,  # noqa: F811
    monkeypatch,
):
    ctx = await make_people()
    w = await World(ctx).build()
    await with_key(ctx)
    mid = _meeting(ctx, meetings)
    # The reader is slow: its line is past the reply sweep's grace when the sweep runs.
    monkeypatch.setattr(replies, "PENDING_GRACE", timedelta(seconds=-60))
    for line in ("Move Bulk import to start on Dec 1, 2026.",
                 "let's have bulk import start on the first of December 2026"):  # fmt: skip
        await post(client, ctx, "owner", line, mid)
        await chat_of(client, ctx, "decider", mid)
        out = await replies.run_pending(ctx.tenant_id)
        assert out.ran == 0, line
        await chat_of(client, ctx, "decider", mid)
        await read(ctx, actions(act("move_dates", item=w.ids["Bulk import"],
                                    start_date="2026-12-01")))  # fmt: skip
        m = (await chat_of(client, ctx, "decider", mid))[-1]
        assert m["kind"] in ("cards", "question"), m
        assert m["kind"] == "question" or len(m["cards"]) == 1
    assert fake.calls == 0
    assert not [p for p in await oracle_prompts(ctx) if p and p.startswith("discussion_reply")]
    # Once per person line: each has one Oracle reply.
    msgs = await chat_of(client, ctx, "owner", mid)
    assert [m["author_kind"] for m in msgs] == ["person", "oracle"] * 2


async def test_a_stray_oracle_line_reads_as_an_answer(client, meetings):  # noqa: F811
    ctx = await make_people()
    await World(ctx).build()
    mid = _meeting(ctx, meetings)
    await post(client, ctx, "owner", "Move Bulk import to start on Dec 1, 2026.", mid)
    first = await chat_of(client, ctx, "owner", mid)
    async with tenant_session(ctx.tenant_id) as s:
        asked = await s.get(DiscussionMessage, uuid.UUID(first[0]["id"]))
        assert asked is not None
        # As a build before meet-chat-kind left it: a discussion reply in the chat.
        s.add(DiscussionMessage(discussion_id=asked.discussion_id, author_kind="oracle",
                                body="Here is what I found.", status="complete",
                                reply_to=asked.id, prompt="discussion_reply.v2"))  # fmt: skip
        await s.commit()
    msgs = await chat_of(client, ctx, "viewer", mid)
    [stray] = [m for m in msgs if m["body"] == "Here is what I found."]
    assert stray["kind"] == "answer" and stray["author_name"] == "Oracle"
    assert stray["retry"] is False and stray["cards"] == []
