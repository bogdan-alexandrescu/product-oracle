"""G2 §4 Research this, from inside a discussion: an approver who can write in it starts a
``discussion_research`` run on a person's message (one researcher at quick depth, the
cost shown first), and the run's answer comes back into the thread as Oracle's message,
citing what it read from the discussion's own context (S6, as a reply reads it).

Each test's card: protects=<the observable>; fails_when=<the wrong result>;
no_claim=<what green does not prove>. Synthetic placeholders only; the runtime is the fake
one (no model is called).
"""

import uuid
from types import SimpleNamespace

from sqlalchemy import select

from oracle.discussions import research
from oracle.discussions.models import DiscussionMessage
from oracle.models import AuditEvent
from oracle.runs import flows
from oracle.runs.models import Run
from oracle.runtokens import RunToken
from oracle.swarm import FakeRuntime, Outcome, set_runtime
from oracle.tenancy import tenant_session
from tests.test_discussions import company, get, post, section, start, uid

ASK = "Do teams on the starter plan ask for caps?"
ANSWER = "Yes: the problem section says so [c:1], and nothing else bears on it [c:99]."


def _url(d_id: str) -> str:
    return f"/v1/discussions/{d_id}/research"


async def _messages(client, ctx, d_id, who="commenter") -> list[dict]:
    resp = await client.get(f"/v1/discussions/{d_id}/messages", headers=ctx.as_(who))
    assert resp.status_code == 200, resp.text
    return resp.json()["items"]


async def _runs(tenant_id) -> list[Run]:
    async with tenant_session(tenant_id) as s:
        return list(await s.scalars(select(Run).where(Run.flow == research.FLOW)))


async def _tick(client, ctx, times: int = 3) -> None:
    for _ in range(times):
        await client.post("/v1/internal/tick", headers=ctx.as_("owner"))


# protects=the flow's shape: one researcher at quick depth ($2.00 from the cost table),
# reading the baseline and documents only (no one's own sources, AUD-9; no write scope),
# its output read by every member, never in the New run dialog; fails_when=it reads
# sources, writes anything, or its cost is not the one shown; no_claim=the agent's answer.
def test_the_research_flow():
    flow = flows.FLOWS[research.FLOW]
    (sdef,) = flow.segments
    assert sdef.roles == ("researcher",) and flow.default_depth == "quick"
    assert set(sdef.scopes) == {"read:baseline", "read:documents"}
    assert flow.member_output and not flow.in_new_run_dialog and not flow.writes_document
    assert sdef.outputs == (research.FILE,) and sdef.importer == research.FLOW
    for tool in sdef.tools:
        assert tool in flows.MCP_TOOLS
    assert "search" not in sdef.tools and "get_source_item" not in sdef.tools
    assert research.estimate_usd() == 2


# protects=who may start it and what they see first: an approver or owner who can write
# sees can_research and the run's cost; a commenter and a viewer do not, and are refused;
# fails_when=a commenter starts a run, or the cost is missing before it starts;
# no_claim=the button (the web spec).
async def test_who_may_research_and_the_cost_shown_first(client):
    set_runtime(FakeRuntime())
    try:
        ctx, doc = await company(client)
        d = await start(client, ctx, subject=section(doc))
        asked = await post(client, ctx, d["id"], "commenter", ASK)
        for who, can in (("owner", True), ("approver", True), ("commenter", False),
                         ("viewer", False)):  # fmt: skip
            me = (await get(client, ctx, d["id"], who))["me"]
            assert me["can_research"] is can, who
            assert me["research_usd"] == (2.0 if can else None), who
        for who in ("commenter", "viewer"):
            resp = await client.post(_url(d["id"]), json={"message_id": asked["id"]},
                                     headers=ctx.as_(who))  # fmt: skip
            assert resp.status_code == 403, resp.text
        assert await _runs(ctx.tenant_id) == []
    finally:
        set_runtime(None)


# protects=Research this starts one run on the message, says so in the thread (a line
# naming who asked, linked to the run) and refuses a second while it runs; the run's
# token holds the flow's read scopes only; fails_when=no run starts, two start, or the
# token can read sources; no_claim=the runtime's behaviour.
async def test_research_starts_one_run_and_says_so(client):
    set_runtime(FakeRuntime())
    try:
        ctx, doc = await company(client)
        d = await start(client, ctx, subject=section(doc))
        asked = await post(client, ctx, d["id"], "commenter", ASK)
        resp = await client.post(_url(d["id"]), json={"message_id": asked["id"]},
                                 headers=ctx.as_("approver"))  # fmt: skip
        assert resp.status_code == 201, resp.text
        line = resp.json()
        assert line["author_kind"] == "system" and line["reply_to"] == asked["id"]
        assert line["body"] == research.started_line("Approver")
        (run,) = await _runs(ctx.tenant_id)
        assert line["research"] == {"run_id": str(run.id), "status": "running"}
        assert float(run.estimate_usd) == 2.0
        assert run.created_by == ctx.users["approver"].id
        assert run.status == "running", run.status
        again = await client.post(_url(d["id"]), json={"message_id": asked["id"]},
                                  headers=ctx.as_("approver"))  # fmt: skip
        assert again.status_code == 409, again.text
        assert again.json()["detail"] == research.ALREADY
        async with tenant_session(ctx.tenant_id) as s:
            tokens = list(await s.scalars(select(RunToken).where(RunToken.run_id == run.id)))
            started = list(await s.scalars(select(AuditEvent).where(
                AuditEvent.action == "discussion.research_start")))  # fmt: skip
        assert tokens and all(set(t.scopes) <= {"read:baseline", "read:documents"} for t in tokens)
        assert len(started) == 1 and ASK not in str(started[0].data)
    finally:
        set_runtime(None)


# protects=only a person's message in this discussion, in an open discussion, is
# researched; fails_when=Oracle's or a system line, another thread's message, or a closed
# discussion starts a run; no_claim=private discussions (readable() covers them).
async def test_what_can_be_researched(client):
    set_runtime(FakeRuntime())
    try:
        ctx, doc = await company(client)
        d = await start(client, ctx, subject=section(doc))
        other = await start(client, ctx, subject=section(doc), title="Another thread")
        theirs = await post(client, ctx, other["id"], "commenter", "Elsewhere")
        resp = await client.post(_url(d["id"]), json={"message_id": theirs["id"]},
                                 headers=ctx.as_("approver"))  # fmt: skip
        assert resp.status_code == 404, resp.text
        asked = await post(client, ctx, d["id"], "commenter", ASK)
        async with tenant_session(ctx.tenant_id) as s:
            oracle = await s.scalar(select(DiscussionMessage).where(
                DiscussionMessage.discussion_id == uuid.UUID(d["id"]),
                DiscussionMessage.author_kind == "oracle"))  # fmt: skip
        if oracle is not None:
            resp = await client.post(_url(d["id"]), json={"message_id": str(oracle.id)},
                                     headers=ctx.as_("approver"))  # fmt: skip
            assert resp.status_code == 422, resp.text
        closed = await client.patch(
            f"/v1/discussions/{d['id']}",
            json={"status": "closed", "lock_version": (await get(client, ctx, d["id"],
                                                                 "approver"))["lock_version"]},
            headers=ctx.as_("approver"),
        )  # fmt: skip
        assert closed.status_code == 200, closed.text
        assert (await get(client, ctx, d["id"], "approver"))["me"]["can_research"] is False
        resp = await client.post(_url(d["id"]), json={"message_id": asked["id"]},
                                 headers=ctx.as_("approver"))  # fmt: skip
        assert resp.status_code == 409, resp.text
        assert await _runs(ctx.tenant_id) == []
    finally:
        set_runtime(None)


# protects=the answer posts back into the discussion as Oracle's, replying to the
# question, with the run named, each [c:n] it used as a citation from the discussion's
# context and a marker that points at nothing removed; the line then reads done;
# fails_when=the answer is a person's, cites nothing, keeps a dangling marker, or the line
# still says running; no_claim=the answer's quality (fake runtime).
async def test_the_answer_comes_back_as_oracles_with_its_sources(client):
    set_runtime(FakeRuntime({"research": [Outcome(artifacts={research.FILE: ANSWER})]}))
    try:
        ctx, doc = await company(client)
        d = await start(client, ctx, subject=section(doc))
        asked = await post(client, ctx, d["id"], "commenter", ASK)
        resp = await client.post(_url(d["id"]), json={"message_id": asked["id"]},
                                 headers=ctx.as_("owner"))  # fmt: skip
        assert resp.status_code == 201, resp.text
        line_id = resp.json()["id"]
        await _tick(client, ctx)
        (run,) = await _runs(ctx.tenant_id)
        assert run.status == "succeeded", run.status
        rows = await _messages(client, ctx, d["id"], "viewer")
        line = next(m for m in rows if m["id"] == line_id)
        assert line["research"] == {"run_id": str(run.id), "status": "done"}
        (answer,) = [m for m in rows if m["research"] and m["author_kind"] == "oracle"]
        assert answer["reply_to"] == asked["id"] and answer["status"] == "complete"
        assert answer["body"] == ANSWER.replace(" [c:99]", "")
        assert [c["n"] for c in answer["citations"]] == [1]
        assert answer["citations"][0]["kind"] in ("section", "entity", "evidence")
        assert answer["research"]["run_id"] == str(run.id)
    finally:
        set_runtime(None)


# protects=a run that ends without an answer marks the line failed with plain copy, and
# Research this may be asked again; fails_when=the line says running forever or a second
# ask is refused; no_claim=why the run failed.
async def test_a_run_without_an_answer_fails_plainly(client):
    set_runtime(FakeRuntime({"research": [Outcome(artifacts={research.FILE: "  "})]}))
    try:
        ctx, doc = await company(client)
        d = await start(client, ctx, subject=section(doc))
        asked = await post(client, ctx, d["id"], "commenter", ASK)
        resp = await client.post(_url(d["id"]), json={"message_id": asked["id"]},
                                 headers=ctx.as_("approver"))  # fmt: skip
        assert resp.status_code == 201, resp.text
        await _tick(client, ctx)
        rows = await _messages(client, ctx, d["id"])
        line = next(m for m in rows if m["id"] == resp.json()["id"])
        assert line["research"]["status"] == "failed"
        assert not [m for m in rows if m["author_kind"] == "oracle" and m["research"]]
        again = await client.post(_url(d["id"]), json={"message_id": asked["id"]},
                                  headers=ctx.as_("approver"))  # fmt: skip
        assert again.status_code == 201, again.text
    finally:
        set_runtime(None)


# protects=the run's prompt carries the question and the discussion's context wrapped as
# data, numbered for [c:n]; fails_when=the question or the data notice is missing;
# no_claim=what the agent does with it.
async def test_the_prompt_carries_the_question_as_data(client):
    set_runtime(FakeRuntime())
    try:
        ctx, doc = await company(client)
        d = await start(client, ctx, subject=section(doc))
        asked = await post(client, ctx, d["id"], "commenter", ASK)
        resp = await client.post(_url(d["id"]), json={"message_id": asked["id"]},
                                 headers=ctx.as_("approver"))  # fmt: skip
        assert resp.status_code == 201, resp.text
        (run,) = await _runs(ctx.tenant_id)
        async with tenant_session(ctx.tenant_id) as s:
            lines = await research.prompt_lines(s, SimpleNamespace(flow=research.FLOW,
                                                                   knobs=run.knobs))  # fmt: skip
        text = "\n".join(lines)
        assert ASK in text and "not instructions to you" in text and "[c:1]" in text
        assert uid(ctx, "commenter") not in text
    finally:
        set_runtime(None)
