"""#606 re-review: Oracle's reply stream withholds as the message list does, and a
private discussion's research run is only for the discussion's readers.

- BLOCKER 1: ``GET /v1/discussions/{d}/messages/{id}/stream`` of an Oracle message that
  names something hidden from the reader (an approvers-only memo) sends no text of it and
  no citation of it, as the list withholds it: a stored research answer and a stored live
  reply, for a commenter, a viewer and their API tokens.
- MAJOR 1 (DECIDED, BGD 2026-10-25, "Gate run to discussion readers"): the research run of
  a private discussion is visible only to people who can read that discussion, on every
  runs route (the list, the run, its decisions, scope, discussions and files) and the MCP
  tools over them; its readers still see it.
- Minors: a live reply in a discussion a commenter may be in reads as a member (its
  prompt names nothing hidden); a failed start shows a commenter no runs' detail.

Each test's card: protects=<the observable>; fails_when=<the wrong result>;
no_claim=<what green does not prove>. Synthetic placeholders only; the runtime and the
model are fakes.
"""

import uuid

from oracle.discussions import research
from oracle.discussions.models import DiscussionMessage
from oracle.swarm import FakeRuntime, Outcome, set_runtime
from oracle.tenancy import tenant_session
from tests.test_discussion_replies import fake, read_stream, with_key  # noqa: F401
from tests.test_discussion_research import (
    ASK,
    MEMO,
    MEMO_TITLE,
    _memo,
    _messages,
    _names_memo,
    _on_documents,
    _research,
    _tick,
)
from tests.test_discussions import company, post, section, start
from tests.test_mcp import api_token, mcp_client, text_of

SECRET = "The answer only the discussion's readers may read."


def _bearer(raw: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {raw}"}


async def _stored(ctx, d, asked, run_id, memo_id) -> tuple[str, str]:
    """A research answer and a live reply stored before the fix, each naming the memo
    and citing it; their ids."""
    cite = {"n": 1, "kind": "document", "ref": memo_id, "title": MEMO_TITLE,
            "url": f"/documents/{MEMO}"}  # fmt: skip
    ids = []
    async with tenant_session(ctx.tenant_id) as s:
        for run in (run_id, None):
            m = DiscussionMessage(
                discussion_id=uuid.UUID(d["id"]), author_kind="oracle",
                body=f"The {MEMO_TITLE} memo settles it [c:1].", citations=[cite],
                reply_to=uuid.UUID(asked["id"]), run_id=run, status="complete",
            )  # fmt: skip
            s.add(m)
            await s.flush()
            ids.append(str(m.id))
        await s.commit()
    return ids[0], ids[1]


# protects=BLOCKER 1: a commenter's and a viewer's stream (by session and by API token) of
# a stored research answer and a stored live reply that name an approvers-only memo sends
# no text of it and no citation of it, ending with the withheld message the list shows; an
# approver's stream still reads it; fails_when=a delta or a citations event names the memo;
# no_claim=paraphrase (Hidden.names matches titles, slugs and ids).
async def test_the_stream_withholds_what_the_list_withholds(client):
    set_runtime(FakeRuntime())
    try:
        ctx, _doc = await company(client)
        memo_id = await _memo(client, ctx)
        d, asked = await _on_documents(client, ctx)
        line = await _research(client, ctx, d, asked)
        answer, live = await _stored(ctx, d, asked, uuid.UUID(line["research"]["run_id"]), memo_id)
        tokens = {who: await api_token(ctx.tenant_id, who) for who in ("commenter", "viewer")}
        for message_id in (answer, live):
            for who in ("commenter", "viewer"):
                for headers in (ctx.as_(who), _bearer(tokens[who])):
                    url = f"/v1/discussions/{d['id']}/messages/{message_id}/stream"
                    resp = await client.get(url, headers=headers)
                    assert resp.status_code == 200, resp.text
                    assert not _names_memo(resp.text, memo_id), (who, resp.text)
                    assert research.WITHHELD in resp.text, (who, resp.text)
            evs = await read_stream(client, ctx, d["id"], message_id, who="approver")
            assert MEMO_TITLE in "".join(str(e[1]) for e in evs if e[0] == "delta")
    finally:
        set_runtime(None)


# protects=BLOCKER 1 for citations alone: an answer whose text is clean but which cites
# the memo streams to a commenter without that citation; fails_when=the citations event
# names the memo; no_claim=the browser's rendering.
async def test_the_stream_drops_a_hidden_citation(client):
    set_runtime(FakeRuntime())
    try:
        ctx, _doc = await company(client)
        memo_id = await _memo(client, ctx)
        d, asked = await _on_documents(client, ctx)
        line = await _research(client, ctx, d, asked)
        cite = {"n": 2, "kind": "document", "ref": memo_id, "title": MEMO_TITLE,
                "url": f"/documents/{MEMO}"}  # fmt: skip
        async with tenant_session(ctx.tenant_id) as s:
            m = DiscussionMessage(
                discussion_id=uuid.UUID(d["id"]), author_kind="oracle",
                body="It is settled [c:2].", citations=[cite], reply_to=uuid.UUID(asked["id"]),
                run_id=uuid.UUID(line["research"]["run_id"]), status="complete",
            )  # fmt: skip
            s.add(m)
            await s.commit()
            message_id = str(m.id)
        evs = await read_stream(client, ctx, d["id"], message_id)
        assert not _names_memo(str(evs), memo_id), evs
        assert evs[-1][0] == "done" and evs[-1][1]["body"] == "It is settled."
    finally:
        set_runtime(None)


async def _private_research(client, ctx, doc) -> tuple[dict, str]:
    """A private discussion the approver started alone, researched and answered: the
    discussion and the run's id."""
    set_runtime(FakeRuntime({"research": [Outcome(artifacts={research.FILE: SECRET})]}))
    d = await start(client, ctx, who="approver", subject=section(doc), visibility="private")
    asked = await post(client, ctx, d["id"], "approver", ASK)
    line = await _research(client, ctx, d, asked)
    await _tick(client, ctx)
    rows = await _messages(client, ctx, d["id"], "approver")
    assert any(m["author_kind"] == "oracle" and SECRET in m["body"] for m in rows)
    return d, line["research"]["run_id"]


def _routes(d: dict, run_id: str) -> list[str]:
    return [
        f"/v1/runs/{run_id}",
        f"/v1/runs/{run_id}/decisions",
        f"/v1/runs/{run_id}/scope",
        f"/v1/runs/{run_id}/discussions",
        f"/v1/runs/{run_id}/segments/1/artifacts/{research.FILE}",
    ]


# protects=MAJOR 1 (decided): a private discussion's research run is invisible to a
# commenter and a viewer who are not in it, by session and API token, on the runs list
# and every run route (404, as if absent), and through MCP; the approver who is in it
# reads the run and its answer; fails_when=a non-reader sees the run's row or gets the
# answer's text; no_claim=the web's runs page (it reads these routes).
async def test_a_private_research_run_is_only_for_the_discussions_readers(client):
    try:
        ctx, doc = await company(client)
        d, run_id = await _private_research(client, ctx, doc)
        for path in _routes(d, run_id)[:2] + _routes(d, run_id)[4:]:
            resp = await client.get(path, headers=ctx.as_("approver"))
            assert resp.status_code == 200, (path, resp.text)
        art = await client.get(_routes(d, run_id)[4], headers=ctx.as_("approver"))
        assert SECRET in art.text
        mine = await client.get("/v1/runs", headers=ctx.as_("approver"))
        assert run_id in [r["id"] for r in mine.json()]
        for who in ("commenter", "viewer"):
            raw = await api_token(ctx.tenant_id, who)
            for headers in (ctx.as_(who), _bearer(raw)):
                listed = await client.get("/v1/runs", headers=headers)
                assert listed.status_code == 200, listed.text
                assert run_id not in listed.text, who
                for path in _routes(d, run_id):
                    resp = await client.get(path, headers=headers)
                    assert resp.status_code == 404, (who, path, resp.text)
                    assert SECRET not in resp.text
            async with mcp_client(raw) as c:
                calls = [
                    ("list_runs", {}),
                    ("get_run", {"run_id": run_id}),
                    ("list_run_decisions", {"run_id": run_id}),
                    ("get_run_artifact", {"run_id": run_id, "seq": 1, "name": research.FILE}),
                ]
                for tool, args in calls:
                    text = text_of(await c.call_tool(tool, args))
                    assert SECRET not in text and run_id not in text.replace(
                        f"run {run_id} not found", ""
                    ), (who, tool, text)
    finally:
        set_runtime(None)


# protects=the decided rule for an open discussion: its research run stays visible to
# every member who reads the discussion; fails_when=the gate hides runs of discussions the
# reader may read; no_claim=private discussions (above).
async def test_an_open_discussions_research_run_stays_visible(client):
    set_runtime(FakeRuntime({"research": [Outcome(artifacts={research.FILE: SECRET})]}))
    try:
        ctx, doc = await company(client)
        d = await start(client, ctx, subject=section(doc))
        asked = await post(client, ctx, d["id"], "commenter", ASK)
        line = await _research(client, ctx, d, asked)
        run_id = line["research"]["run_id"]
        for who in ("commenter", "viewer"):
            resp = await client.get(f"/v1/runs/{run_id}", headers=ctx.as_(who))
            assert resp.status_code == 200, (who, resp.text)
            listed = await client.get("/v1/runs", headers=ctx.as_(who))
            assert run_id in [r["id"] for r in listed.json()]
    finally:
        set_runtime(None)


# protects=minor (replies.py member view): a live reply in a discussion a commenter may be
# in is written from what a commenter may see, so its prompt names no approvers-only memo,
# even when an approver asks; fails_when=the memo reaches the model's prompt;
# no_claim=paraphrase.
async def test_a_live_reply_reads_as_a_member(client, fake):  # noqa: F811
    ctx, _doc = await company(client)
    await with_key(ctx)
    memo_id = await _memo(client, ctx)
    d = await start(client, ctx, who="approver", subject_kind="screen",
                    subject={"path": "/documents"}, title="Which PRD covers caps?")  # fmt: skip
    resp = await client.post(f"/v1/discussions/{d['id']}/messages",
                             json={"body": "@Oracle which documents do we have?"},
                             headers=ctx.as_("approver"))  # fmt: skip
    assert resp.status_code == 201, resp.text
    reply = resp.json()["reply"]
    await read_stream(client, ctx, d["id"], reply["id"], who="approver")
    assert fake.requests, "the reply ran"
    assert not _names_memo(str(fake.requests[0]), memo_id)


# protects=minor (failed start): a start the runs refuse shows a commenter a plain
# sentence, not the runs' detail (which can name another run); the approver who asked
# still reads why; fails_when=the commenter reads the refusal's text; no_claim=which
# refusal.
async def test_a_failed_start_shows_a_commenter_no_detail(client, monkeypatch):
    from oracle.runs import service as runs_service

    detail = f"A baseline build is already under way (run {uuid.uuid4()})"

    async def refuse(*_a, **_k):
        raise runs_service.RunError(detail)

    set_runtime(FakeRuntime())
    try:
        ctx, doc = await company(client)
        d = await start(client, ctx, subject=section(doc))
        asked = await post(client, ctx, d["id"], "commenter", ASK)
        monkeypatch.setattr(runs_service, "start", refuse)
        line = await _research(client, ctx, d, asked)
        assert line["research"]["error"] == detail
        for who in ("commenter", "viewer"):
            rows = await _messages(client, ctx, d["id"], who)
            (theirs,) = [m for m in rows if m["id"] == line["id"]]
            assert theirs["research"]["status"] == "failed"
            assert theirs["research"]["error"] == research.START_FAILED, who
            assert "baseline build" not in str(rows)
    finally:
        set_runtime(None)
