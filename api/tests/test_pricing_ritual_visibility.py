"""H9 Pricing input, security fixes for #541, part 3: a ritual pre-read drops the rows of
decisions its reader may not see (oracle.docs.visibility). A decided pricing decision
due for review is in a prepared Decisions due occurrence; its "D-n Price: ..." rows are
there for an owner and an approver and absent for a commenter, a viewer, their API
tokens and every run token, from the occurrence JSON, pre-read.md, the MCP tools on them
and the input of the occurrence's summary run, before and after the decision's reversal.
Against Postgres.

Each test's card: protects=<the observable>; fails_when=<the wrong result it rejects>;
no_claim=<what green does not prove>.
"""

from datetime import UTC, datetime
from types import SimpleNamespace

import pytest
from sqlalchemy import select

from oracle.decisions.models import Decision
from oracle.rituals import service as rituals
from oracle.rituals import summaries
from oracle.rituals.models import Ritual, RitualOccurrence
from oracle.runs.models import Run
from oracle.swarm import FakeRuntime, set_runtime
from oracle.tenancy import tenant_session
from tests.baseline_helpers import make_ctx
from tests.decision_helpers import clock, today  # noqa: F401
from tests.pricing_helpers import QUESTION, approved_memo
from tests.test_mcp import api_token, mcp_client, run_token, text_of

RATIONALE = "Teams ask for one price; a third of losses were on price."
CONTROL = "Ship the starter plan monthly"
ROLES = [("owner", True), ("approver", True), ("commenter", False), ("viewer", False)]


@pytest.fixture
async def ctx():
    return await make_ctx()


@pytest.fixture(autouse=True)
def runtime():
    """The local runtime: run tokens from any address."""
    set_runtime(FakeRuntime())
    yield
    set_runtime(None)


async def _prepared(client, ctx, *, reverse: bool = False) -> tuple[str, str, int]:
    """A pricing decision decided today with its review due today, a company decision
    due too (the control), and an owner's Prepare now of the Decisions due ritual:
    (the occurrence id, the pricing decision's id, its number). ``reverse``: then the
    owner reverses the pricing decision; the stored pre-read keeps its rows."""
    owner = ctx.as_("owner")
    slug = await approved_memo(client, ctx)
    d = (await client.post(f"/v1/pricing-memos/{slug}/decide", headers=owner)).json()
    resp = await client.post(
        f"/v1/decisions/{d['number']}/decide",
        json={
            "option_key": "flat-team",
            "rationale": RATIONALE,
            "reversibility": "reversible",
            "review_at": today().isoformat(),
            "expected_outcome": "More teams of 10 to 50 pick the Team plan.",
        },
        headers=owner,
    )
    assert resp.status_code == 200, resp.text
    async with tenant_session(ctx.tenant_id) as db:
        db.add(
            Decision(
                number=d["number"] + 100, title=CONTROL, status="decided",
                approver_id=ctx.users["owner"].id, driver="Ada Example", origin="manual",
                chosen_option="a", rationale="Simpler", decided_at=datetime.now(UTC),
                review_at=today(),
            )
        )  # fmt: skip
        await db.commit()
        await rituals.tick_due(db)
        ritual = await db.scalar(select(Ritual).where(Ritual.kind == "decision_review"))
    resp = await client.post(f"/v1/rituals/{ritual.id}/prepare", headers=owner)
    assert resp.status_code == 200, resp.text
    occ = resp.json()
    texts = [r["text"] for b in occ["pre_read"]["blocks"] for r in b["rows"]]
    assert f"D-{d['number']} Price: {QUESTION}" in texts, texts
    assert any(CONTROL in t for t in texts), texts
    if reverse:
        resp = await client.post(
            f"/v1/decisions/{d['number']}/reviews",
            json={"verdict": "reversed", "note": "Seat counts lied"},
            headers=owner,
        )
        assert resp.status_code == 200, resp.text
    return occ["id"], d["id"], d["number"]


def _leaks(body: str, decision_id: str, number: int) -> bool:
    """The pricing decision's title, id or link, or the memo's own approval decision."""
    return (
        QUESTION in body
        or decision_id in body
        or f"d={number})" in body
        or "Team plan pricing" in body
    )


def _blocks(occ: dict) -> dict[str, list]:
    return {b["key"]: b["rows"] for b in occ["pre_read"]["blocks"]}


@pytest.mark.parametrize("reverse", [False, True], ids=["decided", "reversed"])
@pytest.mark.parametrize(("who", "sees"), ROLES)
async def test_the_occurrence_and_pre_read_md_follow_the_decision(client, ctx, who, sees, reverse):
    """protects=GET /v1/ritual-occurrences/{id} and its pre-read.md hold the pricing
    decision's rows for an owner and an approver, and only the company decision's for a
    commenter and a viewer, before and after the reversal (the stored snapshot);
    fails_when=a commenter or viewer reads "D-n Price: ...", its id or its link;
    no_claim=the web (it renders this JSON)."""
    occ_id, decision_id, number = await _prepared(client, ctx, reverse=reverse)
    me = ctx.as_(who)
    one = await client.get(f"/v1/ritual-occurrences/{occ_id}", headers=me)
    md = await client.get(f"/v1/ritual-occurrences/{occ_id}/pre-read.md", headers=me)
    assert one.status_code == 200 and md.status_code == 200, one.text + md.text
    assert CONTROL in one.text and CONTROL in md.text
    assert _leaks(one.text, decision_id, number) is sees, who
    assert _leaks(md.text, decision_id, number) is sees, who
    if not sees:
        got = _blocks(one.json())
        assert [r["title"] for r in got["decisions_due"]] == [CONTROL]
        assert "Nothing this time." not in md.text


@pytest.mark.parametrize("reverse", [False, True], ids=["decided", "reversed"])
@pytest.mark.parametrize(("who", "sees"), ROLES)
async def test_over_mcp_an_api_token_follows_the_decision(client, ctx, who, sees, reverse):
    """protects=over MCP, a person's API token reads the pricing decision's rows in
    get_ritual_occurrence and get_ritual_occurrence_pre_read only for an owner or an
    approver; fails_when=a commenter's or viewer's token reads them; no_claim=other
    tools (the probe)."""
    occ_id, decision_id, number = await _prepared(client, ctx, reverse=reverse)
    async with mcp_client(await api_token(ctx.tenant_id, who)) as c:
        one = await c.call_tool("get_ritual_occurrence", {"occurrence_id": occ_id})
        md = await c.call_tool("get_ritual_occurrence_pre_read", {"occurrence_id": occ_id})
    for got in (one, md):
        assert not got.is_error, text_of(got)
        assert CONTROL in text_of(got)
        assert _leaks(text_of(got), decision_id, number) is sees, (who, text_of(got))


@pytest.mark.parametrize("reverse", [False, True], ids=["decided", "reversed"])
@pytest.mark.parametrize("who", ["owner", "approver", "commenter", "viewer"])
async def test_a_run_token_reads_no_pricing_row(client, ctx, who, reverse):
    """protects=a run token, whoever started the run, reads the pre-read without the
    pricing decision's rows (what a run writes from a pre-read, a summary, is shown to
    every member); fails_when=a run reads "D-n Price: ..." through either tool;
    no_claim=a run's other reads (test_pricing_baseline_visibility)."""
    occ_id, decision_id, number = await _prepared(client, ctx, reverse=reverse)
    raw = await run_token(ctx.tenant_id, ["read:baseline"], ctx.users[who].id)
    async with mcp_client(raw) as c:
        one = await c.call_tool("get_ritual_occurrence", {"occurrence_id": occ_id})
        md = await c.call_tool("get_ritual_occurrence_pre_read", {"occurrence_id": occ_id})
    for got in (one, md):
        assert not got.is_error, text_of(got)
        assert CONTROL in text_of(got)
        assert not _leaks(text_of(got), decision_id, number), text_of(got)


@pytest.mark.parametrize("reverse", [False, True], ids=["decided", "reversed"])
@pytest.mark.parametrize("who", ["owner", "approver"])
async def test_the_summary_run_s_input_has_no_pricing_row(client, ctx, who, reverse):
    """protects=the ritual_summary run an owner's or approver's Summarize with Oracle
    starts gets the pre-read copy in its prompt without the pricing decision's rows, the
    company decision's kept; fails_when=the prompt carries "D-n Price: ..."; no_claim=
    the summary's text (the run writes it from this input)."""
    occ_id, decision_id, number = await _prepared(client, ctx, reverse=reverse)
    resp = await client.post(f"/v1/ritual-occurrences/{occ_id}/summary", headers=ctx.as_(who))
    assert resp.status_code == 201, resp.text
    async with tenant_session(ctx.tenant_id) as db:
        run = await db.get(Run, resp.json()["id"])
        lines = await summaries.prompt_lines(db, run)
    prompt = "\n".join(lines)
    assert CONTROL in prompt
    assert not _leaks(prompt, decision_id, number), prompt


async def test_a_summary_written_from_the_full_pre_read_is_withheld(client, ctx):
    """protects=a summary a run wrote before this fix, from a pre-read that held a
    hidden row, is not shown to a commenter or a viewer (its text may name it), and still
    is to an owner; fails_when=a commenter reads it; no_claim=summaries written after the
    fix (their input has no hidden row)."""
    occ_id, _decision_id, _number = await _prepared(client, ctx)
    text = f"D-1 Price: {QUESTION} is due."
    async with tenant_session(ctx.tenant_id) as db:
        run = Run(flow="ritual_summary", created_by=ctx.users["owner"].id,
                  knobs={"ritual_occurrence_id": occ_id})  # fmt: skip
        db.add(run)
        await db.flush()
        occ = await db.get(RitualOccurrence, occ_id)
        occ.summary, occ.summary_state, occ.summary_run_id = text, "ready", run.id
        await db.commit()
    for who, sees in ROLES:
        got = (await client.get(f"/v1/ritual-occurrences/{occ_id}", headers=ctx.as_(who))).json()
        assert (got["summary"] == text) is sees, who
        assert (QUESTION in str(got)) is sees, who


async def test_the_prompt_of_an_unrelated_run_is_unchanged(client, ctx):
    """protects=the summary prompt of an occurrence with no hidden row is the stored
    markdown as before; fails_when=filtering changes a pre-read with nothing to drop;
    no_claim=other kinds."""
    occ_id, _decision_id, _number = await _prepared(client, ctx)
    async with tenant_session(ctx.tenant_id) as db:
        occ = await db.get(RitualOccurrence, occ_id)
        for b in occ.pre_read["blocks"]:
            b["rows"] = [r for r in b["rows"] if CONTROL in r["text"]]
        stored = rituals.blocks.markdown("Decisions due", occ.due_at, occ.pre_read["blocks"])
        occ.pre_read = {**occ.pre_read, "markdown": stored}
        await db.commit()
        lines = await summaries.prompt_lines(
            db, SimpleNamespace(knobs={"ritual_occurrence_id": occ_id}, flow="ritual_summary")
        )
    assert lines[-1] == stored
