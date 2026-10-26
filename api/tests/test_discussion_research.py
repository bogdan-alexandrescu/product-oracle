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

from oracle.auth.deps import RUN_TOKEN_HEADER
from oracle.discussions import research
from oracle.discussions.models import DiscussionMessage
from oracle.docs.models import Document
from oracle.models import AuditEvent
from oracle.runs import flows
from oracle.runs.models import Run
from oracle.runtokens import RunToken, mint_run_token
from oracle.swarm import FakeRuntime, Outcome, set_runtime
from oracle.tenancy import tenant_session
from tests.test_discussions import company, get, post, section, start, uid
from tests.test_mcp import api_token, mcp_client, text_of

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
    # The open web too (BGD, #584 review): search_web and fetch_web_page.
    assert set(sdef.scopes) == {"read:baseline", "read:documents", "read:web"}
    assert {"search_web", "fetch_web_page"} <= set(sdef.tools)
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
        await _tick(client, ctx, 1)  # the tick submits it
        async with tenant_session(ctx.tenant_id) as s:
            tokens = list(await s.scalars(select(RunToken).where(RunToken.run_id == run.id)))
            started = list(await s.scalars(select(AuditEvent).where(
                AuditEvent.action == "discussion.research_start")))  # fmt: skip
        assert tokens and all(
            set(t.scopes) <= {"read:baseline", "read:documents", "read:web"} for t in tokens
        )
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


# --- #584 review: it reads as a member, may search the web, posts once ------------------

MEMO = "team-plan-pricing-research"
MEMO_TITLE = "Team plan pricing"
WEB_URL = "https://news.example/caps"


async def _memo(client, ctx) -> str:
    """An approvers-only pricing memo (H9: its kind's visibility); its id."""
    from tests.pricing_helpers import memo_md
    from tests.update_helpers import import_md

    resp = await import_md(client, ctx.as_("approver"), MEMO, memo_md(MEMO))
    assert resp.status_code == 201, resp.text
    async with tenant_session(ctx.tenant_id) as s:
        doc = await s.scalar(select(Document).where(Document.slug == MEMO))
    assert doc is not None and doc.visibility == "approvers"
    return str(doc.id)


def _names_memo(text: str, memo_id: str) -> bool:
    return MEMO_TITLE in text or MEMO in text or memo_id in text


async def _on_documents(client, ctx) -> tuple[dict, dict]:
    """The reviewer's scenario: an open discussion on PRDs (/documents) a commenter
    started, with their question."""
    d = await start(client, ctx, subject_kind="screen", subject={"path": "/documents"},
                    title="Which PRD covers caps?")  # fmt: skip
    asked = await post(client, ctx, d["id"], "commenter", ASK)
    return d, asked


async def _research(client, ctx, d, asked, who="approver") -> dict:
    resp = await client.post(_url(d["id"]), json={"message_id": asked["id"]},
                             headers=ctx.as_(who))  # fmt: skip
    assert resp.status_code == 201, resp.text
    return resp.json()


# protects=BLOCKER 1, the reviewer's scenario: an approver starts research in an open
# discussion on PRDs a commenter reads, with an approvers-only pricing memo in the company;
# the run's context and prompt hold only what a commenter may see, so an answer citing
# every number shows the commenter nothing of the memo: not in the thread, its citations,
# REST or MCP; fails_when=the memo's title, slug or id reaches the commenter anywhere;
# no_claim=paraphrase of the memo (nothing of it is read).
async def test_research_reads_as_a_member_in_the_reviewers_scenario(client):
    every = " ".join(f"[c:{n}]" for n in range(1, 30))
    set_runtime(FakeRuntime({"research": [Outcome(artifacts={research.FILE: f"Yes {every}."})]}))
    try:
        ctx, _doc = await company(client)
        memo_id = await _memo(client, ctx)
        d, asked = await _on_documents(client, ctx)
        line = await _research(client, ctx, d, asked)
        (run,) = await _runs(ctx.tenant_id)
        async with tenant_session(ctx.tenant_id) as s:
            row = await s.get(DiscussionMessage, uuid.UUID(line["id"]))
            prompt = "\n".join(await research.prompt_lines(s, run))
        assert row.citations, "the PRD is in the context"
        assert not _names_memo(str(row.citations), memo_id)
        assert not _names_memo(prompt, memo_id)
        await _tick(client, ctx)
        resp = await client.get(f"/v1/discussions/{d['id']}/messages",
                                headers=ctx.as_("commenter"))  # fmt: skip
        assert resp.status_code == 200, resp.text
        assert not _names_memo(resp.text, memo_id)
        (answer,) = [m for m in resp.json()["items"] if m["author_kind"] == "oracle"
                     and m["research"]]  # fmt: skip
        assert answer["citations"], "it cites the PRD"
        raw = await api_token(ctx.tenant_id, "commenter")
        async with mcp_client(raw) as c:
            got = await c.call_tool("list_discussion_messages", {"discussion_id": d["id"]})
        text = text_of(got)
        assert ASK in text and not _names_memo(text, memo_id)
    finally:
        set_runtime(None)


# protects=BLOCKER 1 at import: a citation whose entry names an approvers-only document
# (a line stored before the fix kept the approver's view) is dropped, its marker with it;
# fails_when=the answer cites the memo; no_claim=entries of other kinds.
async def test_the_importer_drops_a_citation_a_commenter_may_not_see(client):
    text = "Pricing is settled [c:1] [c:77]."
    set_runtime(FakeRuntime({"research": [Outcome(artifacts={research.FILE: text})]}))
    try:
        ctx, _doc = await company(client)
        memo_id = await _memo(client, ctx)
        d, asked = await _on_documents(client, ctx)
        line = await _research(client, ctx, d, asked)
        hidden = {"n": 77, "kind": "document", "ref": memo_id, "title": MEMO_TITLE,
                  "url": f"/documents/{MEMO}"}  # fmt: skip
        async with tenant_session(ctx.tenant_id) as s:
            row = await s.get(DiscussionMessage, uuid.UUID(line["id"]))
            row.citations = [*(row.citations or []), hidden]
            await s.commit()
        await _tick(client, ctx)
        rows = await _messages(client, ctx, d["id"], "approver")
        (answer,) = [m for m in rows if m["author_kind"] == "oracle" and m["research"]]
        assert 77 not in [c["n"] for c in answer["citations"]]
        assert "[c:77]" not in answer["body"] and not _names_memo(str(answer), memo_id)
    finally:
        set_runtime(None)


# protects=BLOCKER 1 at read time: an answer stored before the fix that names a hidden
# document is withheld from a commenter (an approver still reads it), and one that only
# cites it loses that citation for them; fails_when=the commenter reads the memo's title
# or link; no_claim=paraphrase.
async def test_an_answer_stored_before_the_fix_is_withheld_from_a_commenter(client):
    set_runtime(FakeRuntime())
    try:
        ctx, _doc = await company(client)
        memo_id = await _memo(client, ctx)
        d, asked = await _on_documents(client, ctx)
        line = await _research(client, ctx, d, asked)
        cite = {"n": 2, "kind": "document", "ref": memo_id, "title": MEMO_TITLE,
                "url": f"/documents/{MEMO}"}  # fmt: skip
        async with tenant_session(ctx.tenant_id) as s:
            for body in (f"The {MEMO_TITLE} memo settles it [c:2].", "It is settled [c:2]."):
                s.add(DiscussionMessage(
                    discussion_id=uuid.UUID(d["id"]), author_kind="oracle", body=body,
                    citations=[cite], reply_to=uuid.UUID(asked["id"]),
                    run_id=uuid.UUID(line["research"]["run_id"]), status="complete",
                ))  # fmt: skip
            await s.commit()
        resp = await client.get(f"/v1/discussions/{d['id']}/messages",
                                headers=ctx.as_("commenter"))  # fmt: skip
        assert resp.status_code == 200, resp.text
        assert not _names_memo(resp.text, memo_id)
        answers = [m for m in resp.json()["items"] if m["author_kind"] == "oracle"]
        assert len(answers) == 2 and all(m["citations"] == [] for m in answers)
        assert {m["body"] for m in answers} == {research.WITHHELD, "It is settled."}
        theirs = await _messages(client, ctx, d["id"], "approver")
        assert sum(MEMO_TITLE in str(m) for m in theirs) == 2
    finally:
        set_runtime(None)


# protects=the decided change: the run's token calls search_web and fetch_web_page, each
# search counts against the company's monthly allowance, and a spent allowance is refused
# in words; fails_when=the token gets 403, a search is not counted, or the refusal is a
# bare code; no_claim=the real search provider (faked).
async def test_the_research_token_searches_the_web_within_the_allowance(client):
    from oracle.baseline.public_links import get_link_fetcher
    from oracle.main import app
    from oracle.web import robots
    from oracle.web.models import WebSearch
    from oracle.web.search import get_search_provider
    from tests.test_web_tools import FakeProvider, Net

    set_runtime(FakeRuntime())
    try:
        ctx, doc = await company(client)
        d = await start(client, ctx, subject=section(doc))
        asked = await post(client, ctx, d["id"], "commenter", ASK)
        await _research(client, ctx, d, asked)
        (run,) = await _runs(ctx.tenant_id)
        resp = await client.put("/v1/settings/web_searches_per_month", json={"value": 1},
                                headers=ctx.as_("owner"))  # fmt: skip
        assert resp.status_code == 200, resp.text
        async with tenant_session(ctx.tenant_id) as s:
            scopes = sorted({x for seg in flows.FLOWS[research.FLOW].segments
                             for x in seg.scopes})  # fmt: skip
            raw = await mint_run_token(s, run.id, scopes, ttl_seconds=600)
            await s.commit()
        headers = {**ctx.as_("approver"), RUN_TOKEN_HEADER: raw}
        net, fake = Net(), FakeProvider()
        app.dependency_overrides[get_search_provider] = lambda: fake
        app.dependency_overrides[get_link_fetcher] = net.fetcher
        robots.clear_cache()
        try:
            found = await client.post("/v1/web/search", json={"query": "starter plan caps"},
                                      headers=headers)  # fmt: skip
            assert found.status_code == 200, found.text
            first = found.json()["results"][0]
            net.pages[first["url"]] = (
                "<html><head><title>Caps</title></head><body><main>"
                + "<p>Teams cap by seat on the starter plan.</p>" * 20
                + "</main></body></html>"
            )
            page = await client.post("/v1/web/fetch", json={"ref": first["ref"]},
                                     headers=headers)  # fmt: skip
            assert page.status_code == 200, page.text
            spent = await client.post("/v1/web/search", json={"query": "again"},
                                      headers=headers)  # fmt: skip
        finally:
            app.dependency_overrides.pop(get_search_provider, None)
            app.dependency_overrides.pop(get_link_fetcher, None)
            robots.clear_cache()
        async with tenant_session(ctx.tenant_id) as s:
            counted = list(await s.scalars(select(WebSearch).where(WebSearch.run_id == run.id)))
        assert len(counted) == 1
        assert spent.status_code == 429 and spent.json()["code"] == "web_cap_reached"
        assert spent.json()["detail"] == (
            "This month's web searches are used up (the company allows 1 a month). "
            "An owner can raise the allowance in Settings."
        )
    finally:
        set_runtime(None)


# protects=a web page the run read becomes a citation linking to it: the answer's [w-n]
# marker for a result of this run is a [c:n] citation of kind web with its URL; a ref the
# run never read is dropped; fails_when=the web page is not cited or links elsewhere;
# no_claim=the page's content.
async def test_a_cited_web_page_is_a_link(client):
    from oracle.web.models import WebResult

    text = "Others cap by seat [w-1], and the PRD agrees [c:1] [w-9]."
    set_runtime(FakeRuntime({"research": [Outcome(artifacts={research.FILE: text})]}))
    try:
        ctx, doc = await company(client)
        d = await start(client, ctx, subject=section(doc))
        asked = await post(client, ctx, d["id"], "commenter", ASK)
        await _research(client, ctx, d, asked)
        (run,) = await _runs(ctx.tenant_id)
        async with tenant_session(ctx.tenant_id) as s:
            s.add(WebResult(run_id=run.id, ref="w-1", kind="search_result", url=WEB_URL,
                            host="news.example", title="Caps at Example",
                            text="Caps."))  # fmt: skip
            await s.commit()
        await _tick(client, ctx)
        rows = await _messages(client, ctx, d["id"])
        (answer,) = [m for m in rows if m["author_kind"] == "oracle" and m["research"]]
        assert "[w-" not in answer["body"]
        web = [c for c in answer["citations"] if c["kind"] == "web"]
        assert [(c["url"], c["title"]) for c in web] == [(WEB_URL, "Caps at Example")]
        assert f"[c:{web[0]['n']}]" in answer["body"]
        assert len(answer["citations"]) == 2
    finally:
        set_runtime(None)


# protects=MAJOR 1: an import that runs again (the tick died after the importer's commit)
# posts the answer once; fails_when=the answer appears twice; no_claim=the run's step.
async def test_a_duplicate_import_posts_once(client):
    set_runtime(FakeRuntime({"research": [Outcome(artifacts={research.FILE: ANSWER})]}))
    try:
        ctx, doc = await company(client)
        d = await start(client, ctx, subject=section(doc))
        asked = await post(client, ctx, d["id"], "commenter", ASK)
        await _research(client, ctx, d, asked)
        await _tick(client, ctx)
        (run,) = await _runs(ctx.tenant_id)
        async with tenant_session(ctx.tenant_id) as s:
            again = await research.import_answer(s, run, {research.FILE: ANSWER}, None)  # type: ignore[arg-type]
        assert again == {}
        rows = await _messages(client, ctx, d["id"])
        assert len([m for m in rows if m["author_kind"] == "oracle" and m["research"]]) == 1
    finally:
        set_runtime(None)


# protects=MAJOR 2: a start the runs refuse (a budget, one build at a time) shows the
# failure in the thread, in words, and Research this may be asked again; fails_when=the
# line reads running forever or a second ask gets 409; no_claim=which refusal.
async def test_a_failed_start_shows_in_the_thread_and_may_be_retried(client, monkeypatch):
    from oracle.runs import service as runs_service

    class Refused(runs_service.RunError):
        status = 402

    async def refuse(*_a, **_k):
        raise Refused("This month's run budget is spent")

    set_runtime(FakeRuntime())
    try:
        ctx, doc = await company(client)
        d = await start(client, ctx, subject=section(doc))
        asked = await post(client, ctx, d["id"], "commenter", ASK)
        monkeypatch.setattr(runs_service, "start", refuse)
        resp = await client.post(_url(d["id"]), json={"message_id": asked["id"]},
                                 headers=ctx.as_("approver"))  # fmt: skip
        assert resp.status_code == 201, resp.text
        assert resp.json()["research"]["status"] == "failed"
        assert resp.json()["research"]["error"] == "This month's run budget is spent"
        rows = await _messages(client, ctx, d["id"], "approver")
        line = next(m for m in rows if m["id"] == resp.json()["id"])
        assert line["research"]["status"] == "failed"
        assert line["research"]["error"] == "This month's run budget is spent"
        monkeypatch.undo()
        again = await client.post(_url(d["id"]), json={"message_id": asked["id"]},
                                  headers=ctx.as_("approver"))  # fmt: skip
        assert again.status_code == 201, again.text
        assert again.json()["research"]["status"] == "running"
    finally:
        set_runtime(None)
