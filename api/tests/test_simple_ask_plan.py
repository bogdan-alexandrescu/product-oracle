"""Oracle's Ask on Simple's pages reads the company's plan first (the owner's production
walk, 2026-10-27), and a source that fails is never shown raw. Against Postgres; the model
is test_discussion_replies' fake (never a live model). Invented data only.

Test cards (protects / fails_when / no_claim):

- test_the_plan_opens_the_prompt (one case per role): protects=a person of each role asking
  "what is M2 about and when does it run?" in an Ask chat on Simple's Home gets a model call
  whose data opens with the company's plan: the approved PRD's brief (its milestones section
  with M2's dates, outcomes and features; only the brief: a detail section such as an
  appendix is left out, so the block stays small), the roadmap's items
  with their dates and the open decisions, all before the page's own lines and the
  conversation, and the system prompt says the plan comes first and sources only after;
  fails_when=the plan is missing, comes after the conversation, or the plan-first line is
  absent; no_claim=the model's answer (a fake answers).
- test_a_hidden_prd_never_reaches_the_prompt (one case per role): protects=a PRD only
  approvers and owners read (visibility ``approvers``), its roadmap's items and its decision
  are never in a Simple Ask chat's prompt, whoever asks (the chat reads as a commenter would);
  fails_when=a viewer's or commenter's prompt holds the hidden PRD's text;
  no_claim=Studio's discussions (unchanged).
- test_a_viewer_gets_no_ask_reply: protects=a viewer cannot start Oracle's Ask (their
  Ask panel line goes to the plan reader only), so no model ever reads the plan for them;
  fails_when=a viewer's Ask chat is created and answered; no_claim=the plan reader's own
  answers (test_simple_chat_*).
- test_studio_pages_keep_their_context: protects=a panel chat on a Studio page (``/home``)
  gets no plan block and no plan-first line; fails_when=Detailed's Ask changes;
  no_claim=Simple's other subjects.
- test_a_failing_source_is_one_plain_line: protects=a reply on a Simple page whose live
  read failed and that repeats the failure raw ("The Fireflies search failed (HTTP 502)")
  is stored and shown with the one plain line "Meeting notes could not be searched just
  now." instead, with no HTTP code and no connector name, while a plan sentence beside it
  that names a tool ("The Slack pilot failed its adoption target") is kept as it is;
  fails_when=the stored reply keeps "HTTP 502" or "Fireflies", or the plan sentence is
  rewritten; no_claim=the live tools' own routes (test_live_*).
- test_plan_content_naming_a_tool_is_kept: protects=when no live read of the reply failed,
  a Simple reply naming Slack or Notion beside "failed" or "down" is the plan's own content
  and is never rewritten, and a Studio reply is never rewritten even after a failed read;
  fails_when=such a sentence becomes "Meeting notes could not be searched just now.";
  no_claim=the model's wording.
- test_live_tool_failure_reaches_the_model_plainly: protects=a live tool's 5xx answer (the
  source failed) becomes the plain line in the MCP result the model reads, while other
  tools' errors and Oracle's own read cap (429) keep their text, and only an Ask reply's
  live token (``live:sources``) gets the plain line: another MCP caller of the live routes
  keeps the HTTP answer; fails_when=the model reads "HTTP 502" or the connector's name, or
  an API token's caller loses the code; no_claim=Fireflies itself.
- test_plain_failures_units: protects=the scrub replaces a failure sentence once and keeps
  plain text untouched; fails_when=an ordinary sentence naming a product is changed;
  no_claim=every phrasing a model might use.
"""

import asyncio
import hashlib
import uuid
from datetime import date

import pytest
from sqlalchemy import select

from oracle.decisions.models import Decision
from oracle.discussions import plan
from oracle.discussions.models import DiscussionMessage
from oracle.docs.models import Section
from oracle.live import tokens as live_tokens
from oracle.live.models import LiveRead
from oracle.llm import gateway
from oracle.llm.transports import TransportResult
from oracle.mcp.auth import McpCaller
from oracle.mcp.tools import RestResponse, to_result
from oracle.tenancy import tenant_session
from tests.baseline_helpers import Ctx, make_ctx
from tests.test_discussion_replies import Fake, read_stream, row, say, with_key
from tests.test_simple_roadmap_api import Seed

QUESTION = "what is M2 about and when does it run?"
M2 = "M2 Shared ledgers: Mar 1 2027 to May 31 2027; outcome: teams close books together"
ROLES = ("commenter", "approver", "owner")


async def plan_world(ctx: Ctx) -> None:
    """An approved PRD with a brief (summary, milestones with M2, not doing) and a detail
    section, its roadmap with two items, an open decision; and an approvers-only PRD with
    its own roadmap and decision."""

    async def section(s, v, key, heading, text, ordinal, layer="detail"):
        s.add(Section(version_id=v.id, section_key=key, ordinal=ordinal, level=2,
                      heading=heading, body_md=text, body_text=text, layer=layer,
                      content_hash=hashlib.sha256(text.encode()).hexdigest()))  # fmt: skip

    async with tenant_session(ctx.tenant_id) as s:
        seed = Seed(s)
        prd, pv, rm, rv = await seed.roadmap("ledgers")
        await section(s, pv, "appendix", "Appendix", "Glossary of ledger terms.", 1)
        await section(s, pv, "summary", "Summary", "One ledger for every team.", 2)
        await section(s, pv, "milestones", "Milestones", M2, 3)
        await section(s, pv, "not-doing", "Not doing", "No mobile app in v1.", 4)
        track = await seed.track(pv, rm, owner_id=ctx.users["approver"].id)
        await seed.item(rv, pv, "shared-ledgers", title="Shared ledgers", track_id=track.id,
                        start_date=date(2027, 3, 1), end_date=date(2027, 5, 31),
                        date_source="typed", outcome="Teams close books together")  # fmt: skip
        await seed.item(rv, pv, "ledger-export", title="Ledger export", position=1,
                        track_id=track.id)  # fmt: skip
        hidden = await seed.doc("board-plan", visibility="approvers")
        hv = await seed.version(hidden)
        await section(s, hv, "summary", "Summary", "Secret acquisition of a rival.", 1)
        hrm = await seed.doc("board-roadmap", "roadmap", "approvers")
        hrv = await seed.version(hrm)
        htrack = await seed.track(hv, hrm, title="Board track")
        await seed.item(hrv, hv, "rival-merger", title="Rival merger", track_id=htrack.id)
        owner = ctx.users["owner"].id
        s.add(Decision(number=1, title="Pick the ledger export format", approver_id=owner,
                       driver="oracle", origin="manual",
                       subjects=[{"kind": "document", "id": str(prd.id)}]))  # fmt: skip
        s.add(Decision(number=2, title="Approve the rival merger", approver_id=owner,
                       driver="oracle", origin="manual",
                       subjects=[{"kind": "document", "id": str(hidden.id)}]))  # fmt: skip
        await s.commit()


async def ask_on(client, ctx: Ctx, who: str, path: str, fake, text: str = QUESTION):
    r = await client.post(
        "/v1/discussions",
        json={"subject_kind": "screen", "subject": {"path": path}, "origin": "panel",
              "visibility": "private"},
        headers=ctx.as_(who),
    )  # fmt: skip
    assert r.status_code == 201, r.text
    d = r.json()
    reply = (await say(client, ctx, d["id"], who, text))["reply"]
    await read_stream(client, ctx, d["id"], reply["id"], who=who)
    return d, reply, fake.requests[-1]


@pytest.fixture
def fake():
    model = Fake(pause=0)
    previous = gateway.set_transports(gateway.Transports(plan=model, api_key=model))
    yield model
    gateway.set_transports(previous)


@pytest.mark.parametrize("who", ROLES)
async def test_the_plan_opens_the_prompt(client, fake, who):
    ctx = await make_ctx()
    await with_key(ctx)
    await plan_world(ctx)
    _, _, request = await ask_on(client, ctx, who, "/simple", fake)
    data = request.messages[0]["content"]
    assert "The company's current plan" in data
    assert M2 in data
    assert "Roadmap item: Shared ledgers" in data and "2027-03-01 to 2027-05-31" in data
    assert "Roadmap item: Ledger export" in data and "estimated" in data
    assert "Open decision D-1: Pick the ledger export format" in data
    at = data.index
    # The brief only (the appendix is not part of it); the plan before the page and the
    # conversation.
    assert "Ledgers Prd: Summary" in data and "Ledgers Prd: Not doing" in data
    assert "Glossary of ledger terms" not in data
    assert at("The company's current plan") < at("The page:") < at(QUESTION)
    assert plan.PLAN_FIRST in request.system


@pytest.mark.parametrize("who", ROLES)
async def test_a_hidden_prd_never_reaches_the_prompt(client, fake, who):
    ctx = await make_ctx()
    await with_key(ctx)
    await plan_world(ctx)
    _, _, request = await ask_on(client, ctx, who, "/simple/roadmap", fake)
    data = request.messages[0]["content"]
    assert M2 in data
    for hidden in ("Secret acquisition", "Rival merger", "Approve the rival merger", "Board"):
        assert hidden not in data, (who, hidden)


async def test_a_viewer_gets_no_ask_reply(client, fake):
    ctx = await make_ctx()
    await plan_world(ctx)
    r = await client.post(
        "/v1/discussions",
        json={"subject_kind": "screen", "subject": {"path": "/simple"}, "origin": "panel",
              "visibility": "private"},
        headers=ctx.as_("viewer"),
    )  # fmt: skip
    assert r.status_code == 403, r.text
    assert fake.calls == 0


async def test_studio_pages_keep_their_context(client, fake):
    ctx = await make_ctx()
    await with_key(ctx)
    await plan_world(ctx)
    _, _, request = await ask_on(client, ctx, "commenter", "/home", fake)
    assert "The company's current plan" not in request.messages[0]["content"]
    assert plan.PLAN_FIRST not in request.system


PLAN_LINE = "The Slack pilot failed its adoption target in Q3, so M2 drops it."
TOOL_LINE = "The Notion import is down to one owner."


class RawFailure(Fake):
    """A model that repeats a source's raw error, as the production walk saw; with
    ``tenant_id`` set, its live read of the reply failed first (a live_reads row)."""

    def __init__(self, text: str, tenant_id=None):
        super().__init__(pause=0)
        self.text, self.tenant_id = text, tenant_id

    async def stream(self, token, request, on_text) -> TransportResult:
        self.calls += 1
        self.requests.append(request)
        if self.tenant_id is not None:
            async with tenant_session(self.tenant_id) as s:
                reply = await s.scalar(
                    select(DiscussionMessage)
                    .where(DiscussionMessage.author_kind == "oracle")
                    .order_by(DiscussionMessage.created_at.desc())
                    .limit(1)
                )
                s.add(LiveRead(user_id=uuid.uuid4(), message_id=reply.id,
                               tool="live_fireflies_search", source_label="Fireflies",
                               status="error"))  # fmt: skip
                await s.commit()
        await on_text(self.text)
        return TransportResult(text=self.text, model=request.model, usage={})


async def answered(client, model: RawFailure, path: str, failed: bool):
    previous = gateway.set_transports(gateway.Transports(plan=model, api_key=model))
    try:
        ctx = await make_ctx()
        await with_key(ctx)
        await plan_world(ctx)
        if failed:
            model.tenant_id = ctx.tenant_id
        _, reply, _ = await ask_on(client, ctx, "commenter", path, model)
        await asyncio.sleep(0)
        done = await row(ctx, reply["id"])
    finally:
        gateway.set_transports(previous)
    assert done.status == "complete"
    return done


async def test_a_failing_source_is_one_plain_line(client):
    raw = "I don't have anything on M2 to go on. The Fireflies search failed (HTTP 502)."
    done = await answered(client, RawFailure(f"{PLAN_LINE} {raw}"), "/simple", failed=True)
    assert "HTTP" not in done.body and "502" not in done.body and "Fireflies" not in done.body
    assert done.body.count(plan.SOURCE_DOWN) == 1
    assert done.body.startswith(PLAN_LINE)


async def test_plan_content_naming_a_tool_is_kept(client):
    text = f"{PLAN_LINE} {TOOL_LINE}"
    done = await answered(client, RawFailure(text), "/simple", failed=False)
    assert done.body == text
    raw = "The Fireflies search failed (HTTP 502)."
    done = await answered(client, RawFailure(raw), "/home", failed=True)
    assert done.body == raw


def test_live_tool_failure_reaches_the_model_plainly():
    from oracle.mcp.server import plain_for

    raw = b'{"detail":"Fireflies did not answer (HTTP 502). Synced data is still available."}'
    for code in (500, 502, 503):
        resp = RestResponse(code, "application/json", raw, "/v1/live/fireflies/search")
        out = to_result(resp, plain=True)
        text = out.content[0].text
        assert out.is_error and text == plan.SOURCE_DOWN, code
        # Another MCP caller of the live routes (an API token) keeps the HTTP answer.
        assert to_result(resp).content[0].text.startswith(f"HTTP {code}")
    live = McpCaller(tenant_id=uuid.uuid4(), kind="user", credentials={},
                     scopes=frozenset({live_tokens.SCOPE}))  # fmt: skip
    assert plain_for(live)
    assert not plain_for(McpCaller(tenant_id=uuid.uuid4(), kind="token", credentials={}))
    other = to_result(RestResponse(404, "application/json", b'{"detail":"x"}', "/v1/goals/1"))
    assert other.content[0].text.startswith("HTTP 404")
    # Oracle's own cap on live reads is an instruction to the model, kept as it is.
    cap = to_result(RestResponse(429, "application/json", b'{"detail":"cap"}', "/v1/live/sources"))
    assert cap.content[0].text.startswith("HTTP 429")


def test_plain_failures_units():
    assert plan.plain_failures("Slack launch notes are in the PRD.") == (
        "Slack launch notes are in the PRD."
    )
    out = plan.plain_failures("M2 runs in March. Notion search failed. Also (HTTP 500) here.")
    assert out == f"M2 runs in March. {plan.SOURCE_DOWN}"
    for kept in (PLAN_LINE, TOOL_LINE, "Slack is unavailable to the field team."):
        assert plan.plain_failures(kept) == kept
    assert plan.simple_page(type("D", (), {"subject_kind": "screen",
                                           "subject": {"path": "/simple/roadmap"}})())  # fmt: skip
    assert not plan.simple_page(type("D", (), {"subject_kind": "screen",
                                               "subject": {"path": "/simplex"}})())  # fmt: skip
