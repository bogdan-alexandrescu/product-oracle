"""Oracle's Ask on Simple's pages reads the company's plan first (the owner's production
walk, 2026-10-27), and a source that fails is never shown raw. Against Postgres; the model
is test_discussion_replies' fake (never a live model). Invented data only.

Test cards (protects / fails_when / no_claim):

- test_the_plan_opens_the_prompt (one case per role): protects=a person of each role asking
  "what is M2 about and when does it run?" in an Ask chat on Simple's Home gets a model call
  whose data opens with the company's plan: the approved PRD's brief (its milestones section
  with M2's dates, outcomes and features, before its other sections), the roadmap's items
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
- test_a_failing_source_is_one_plain_line: protects=a reply on a Simple page that repeats a
  source's raw failure ("Fireflies search failed (HTTP 502)") is stored and shown with the
  one plain line "Meeting notes could not be searched just now." instead, with no HTTP code
  and no connector name; fails_when=the stored reply keeps "HTTP 502" or "Fireflies";
  no_claim=the live tools' own routes (test_live_*).
- test_live_tool_failure_reaches_the_model_plainly: protects=a live tool's 5xx (or 429)
  answer becomes the plain line in the MCP result the model reads, while other tools'
  errors keep their text; fails_when=the model reads "HTTP 502" or the connector's name;
  no_claim=Fireflies itself.
- test_plain_failures_units: protects=the scrub replaces a failure sentence once and keeps
  plain text untouched; fails_when=an ordinary sentence naming a product is changed;
  no_claim=every phrasing a model might use.
"""

import asyncio
import hashlib
from datetime import date

import pytest

from oracle.decisions.models import Decision
from oracle.discussions import plan
from oracle.docs.models import Section
from oracle.llm import gateway
from oracle.llm.transports import TransportResult
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
    # The brief before the rest of the PRD; the plan before the page and the conversation.
    assert at("Ledgers Prd: Milestones") < at("Ledgers Prd: Appendix")
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


class RawFailure(Fake):
    """A model that repeats a source's raw error, as the production walk saw."""

    async def stream(self, token, request, on_text) -> TransportResult:
        self.calls += 1
        self.requests.append(request)
        text = "I don't have anything on M2 to go on. The Fireflies search failed (HTTP 502)."
        await on_text(text)
        return TransportResult(text=text, model=request.model, usage={})


async def test_a_failing_source_is_one_plain_line(client):
    model = RawFailure(pause=0)
    previous = gateway.set_transports(gateway.Transports(plan=model, api_key=model))
    try:
        ctx = await make_ctx()
        await with_key(ctx)
        await plan_world(ctx)
        _, reply, _ = await ask_on(client, ctx, "commenter", "/simple", model)
        await asyncio.sleep(0)
        done = await row(ctx, reply["id"])
    finally:
        gateway.set_transports(previous)
    assert done.status == "complete"
    assert "HTTP" not in done.body and "502" not in done.body and "Fireflies" not in done.body
    assert done.body.count(plan.SOURCE_DOWN) == 1


def test_live_tool_failure_reaches_the_model_plainly():
    raw = b'{"detail":"Fireflies did not answer (HTTP 502). Synced data is still available."}'
    for code in (502, 503, 429):
        out = to_result(RestResponse(code, "application/json", raw, "/v1/live/fireflies/search"))
        text = out.content[0].text
        assert out.is_error and text == plan.SOURCE_DOWN, code
    other = to_result(RestResponse(404, "application/json", b'{"detail":"x"}', "/v1/goals/1"))
    assert other.content[0].text.startswith("HTTP 404")


def test_plain_failures_units():
    assert plan.plain_failures("Slack launch notes are in the PRD.") == (
        "Slack launch notes are in the PRD."
    )
    out = plan.plain_failures("M2 runs in March. Notion search failed. Also (HTTP 500) here.")
    assert out == f"M2 runs in March. {plan.SOURCE_DOWN}"
    assert plan.simple_page(type("D", (), {"subject_kind": "screen",
                                           "subject": {"path": "/simple/roadmap"}})())  # fmt: skip
    assert not plan.simple_page(type("D", (), {"subject_kind": "screen",
                                               "subject": {"path": "/simplex"}})())  # fmt: skip
