"""#402: the first message of a new discussion gets Oracle's live reply under the composer's
rule (always while it is just the starter; else only when addressed).

Each test's card: protects=<the observable>; fails_when=<the wrong result>;
no_claim=<what green does not prove>. Synthetic placeholders only.
"""

from tests.test_discussion_replies import ASK, CHUNKS, fake, read_stream, row, say, with_key  # noqa: F401
from tests.test_discussions import company, section, start, uid


async def messages(client, ctx, d_id, who="commenter") -> list[dict]:
    resp = await client.get(f"/v1/discussions/{d_id}/messages", headers=ctx.as_(who))
    assert resp.status_code == 200, resp.text
    return resp.json()["items"]


# protects=a discussion started alone with a first message answers with Oracle's pending
# reply to it, which streams to the final text; fails_when=no reply is made (#402);
# no_claim=the browser's rendering (E2E).
async def test_a_first_message_alone_gets_the_reply(client, fake):  # noqa: F811
    ctx, doc = await company(client)
    await with_key(ctx)
    d = await start(client, ctx, subject=section(doc), message={"body": ASK})
    items = await messages(client, ctx, d["id"])
    first = [m for m in items if m["author_kind"] == "person"][0]
    reply = d["reply"]
    assert (reply["author_kind"], reply["status"], reply["body"]) == ("oracle", "pending", "")
    assert reply["reply_to"] == first["id"] and first["body"] == ASK
    assert [m["id"] for m in items if m["author_kind"] == "oracle"] == [reply["id"]]
    evs = await read_stream(client, ctx, d["id"], reply["id"])
    assert evs[-1][0] == "done" and evs[-1][1]["status"] == "complete"
    done = await row(ctx, reply["id"])
    assert done.status == "complete" and done.body == "".join(CHUNKS) and fake.calls == 1


# protects=no first message, no reply; fails_when=Oracle answers an empty discussion;
# no_claim=the UI.
async def test_no_first_message_no_reply(client):
    ctx, doc = await company(client)
    d = await start(client, ctx, subject=section(doc))
    assert d["reply"] is None
    assert await messages(client, ctx, d["id"]) == []


# protects=with someone else in it, the first message gets a reply only when addressed
# (Ask Oracle or @Oracle); fails_when=a team discussion gets an unasked reply, or an asked
# one none; no_claim=the UI's copy.
async def test_with_others_only_when_addressed(client):
    ctx, doc = await company(client)
    team = {"subject": section(doc), "visibility": "private"}
    team["participants"] = [uid(ctx, "approver")]
    quiet = await start(client, ctx, **team, message={"body": "What do we measure?"})
    assert quiet["reply"] is None
    assert all(m["author_kind"] == "person" for m in await messages(client, ctx, quiet["id"]))
    asked = await start(client, ctx, **team, message={"body": ASK, "mention_oracle": True})
    assert asked["reply"]["status"] == "pending"
    at = await start(client, ctx, **team, message={"body": f"@Oracle {ASK}"})
    assert at["reply"]["status"] == "pending"
    # An open discussion that mentions someone has two people in it too.
    mention = {"body": "Thoughts?", "mentions": [uid(ctx, "approver")]}
    opened = await start(client, ctx, subject=section(doc), message=mention)
    assert opened["reply"] is None


# protects=wait=true runs the first message's reply inline, like the composer's (MCP);
# fails_when=it comes back pending; no_claim=the 120 s cap.
async def test_wait_returns_the_finished_reply(client, fake):  # noqa: F811
    ctx, doc = await company(client)
    await with_key(ctx)
    resp = await client.post(
        "/v1/discussions",
        params={"wait": "true"},
        json={"subject_kind": "section", "subject": section(doc), "message": {"body": ASK}},
        headers=ctx.as_("commenter"),
    )
    assert resp.status_code == 201, resp.text
    reply = resp.json()["reply"]
    assert reply["status"] == "complete" and reply["body"] == "".join(CHUNKS)


# protects=past the reply limit the discussion and its first message are still started
# (201, no reply), so starting again makes no duplicate; fails_when=the start fails or
# a reply is made past the limit; no_claim=the limit's own maths (test_discussion_replies).
async def test_the_reply_limit_still_starts_the_discussion(client):
    ctx, doc = await company(client)
    d = await start(client, ctx, subject=section(doc))
    for i in range(20):
        assert (await say(client, ctx, d["id"], "commenter", f"Question {i}"))["reply"]
    late = await start(client, ctx, subject=section(doc), message={"body": "One more"})
    assert late["reply"] is None
    assert [m["body"] for m in await messages(client, ctx, late["id"])] == ["One more"]
