"""H9 Pricing input, security fixes for #541, part 4: a run of a flow whose output every
member reads (oracle.runs.flows ``member_output``) reads every tool as a commenter would,
whoever started it, an owner or Oracle; its importers check refs as a commenter; and what
such a run wrote before the fix is withheld at read time from a reader who may not see
what it names. A decided-then-reversed pricing decision (a Decisions due occurrence
prepared for it) and an imported pricing memo are the hidden things. Against Postgres
with the FakeRuntime.

Each test's card: protects=<the observable>; fails_when=<the wrong result it rejects>;
no_claim=<what green does not prove>.
"""

import uuid
from datetime import UTC, datetime, timedelta

import pytest
import yaml
from sqlalchemy import select

from oracle import audit
from oracle.baseline.models import Entity, Proposal
from oracle.decisions.models import Decision
from oracle.docs.models import Document
from oracle.metrics.models import Metric, MetricVariance
from oracle.rituals import blocks as ritual_blocks
from oracle.rituals import summaries
from oracle.rituals.models import RitualOccurrence
from oracle.runs import flows
from oracle.runs import service as runs_service
from oracle.runs.models import Run
from oracle.runs.schemas import KnobsIn, RunCreate
from oracle.runtokens import mint_run_token
from oracle.swarm import FakeRuntime, set_runtime
from oracle.tenancy import tenant_session
from tests.baseline_helpers import make_ctx
from tests.decision_helpers import clock  # noqa: F401
from tests.pricing_helpers import QUESTION, memo_md
from tests.test_mcp import mcp_client, text_of
from tests.test_pricing_ritual_visibility import CONTROL, RATIONALE, _prepared
from tests.update_helpers import import_md

MEMBER_FLOWS = ("ritual_summary", "metrics_variance", "competitive_digest", "request_triage",
                "code_map")  # fmt: skip
IMPORTED = "team-plan-pricing-import"
WORD = "per-seat"  # in the pricing memos only
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


async def _world(client, ctx) -> dict:
    """The reversed pricing decision in a prepared Decisions due occurrence, and an
    imported pricing memo: the ids, numbers and texts no member may read."""
    occ_id, decision_id, number = await _prepared(client, ctx, reverse=True)
    resp = await import_md(client, ctx.as_("approver"), IMPORTED, memo_md(IMPORTED))
    assert resp.status_code == 201, resp.text
    async with tenant_session(ctx.tenant_id) as s:
        d = await s.get(Decision, uuid.UUID(decision_id))
        docs = list(await s.scalars(select(Document).where(Document.kind == "pricing")))
    assert d.status == "reversed" and d.entity_id is not None, d.status
    return {
        "occ_id": occ_id, "decision_id": decision_id, "number": number,
        "entity_id": str(d.entity_id), "docs": [(x.slug, str(x.id)) for x in docs],
    }  # fmt: skip


def _leaks(body: str, w: dict) -> bool:
    secrets = [QUESTION, RATIONALE, WORD, "Team plan pricing", w["decision_id"], w["entity_id"],
               f"D-{w['number']} ", f"d={w['number']}"]  # fmt: skip
    secrets += [x for pair in w["docs"] for x in pair]
    return any(s in body for s in secrets)


def _knobs(w: dict) -> dict:
    """A summary run's knobs since #541 part 3 (its prompt had the member view)."""
    return {"ritual_occurrence_id": w["occ_id"], summaries.VIEW: summaries.MEMBER}


async def _member_run(ctx, flow: str, occ_id: str, starter: str) -> str:
    """A run of ``flow`` for the occurrence, started by the owner or by Oracle (no
    principal: created for the ritual's owner, as Oracle's own starts are), and its
    token with the segment's scopes."""
    async with tenant_session(ctx.tenant_id) as s:
        owner = ctx.users["owner"]
        if starter == "oracle":
            body = RunCreate(flow=flow, knobs=KnobsIn(depth="quick"))  # type: ignore[arg-type]
            entry = {"ritual_occurrence_id": occ_id} if flows.FLOWS[flow].entry else None
            run_id = await runs_service.create_run(
                s, audit.ORACLE, body, entry_knobs=entry, commit=False, created_by=owner.id
            )
        else:
            run = Run(flow=flow, created_by=owner.id, knobs={"ritual_occurrence_id": occ_id})
            s.add(run)
            await s.flush()
            run_id = run.id
        scopes = sorted({x for seg in flows.FLOWS[flow].segments for x in seg.scopes})
        raw = await mint_run_token(s, run_id, scopes, ttl_seconds=600)
        await s.commit()
    return raw


async def _reads(raw: str, w: dict) -> list[tuple[str, str]]:
    """Every read of a decision, the baseline, the sources, a document and change events
    the run token is offered: (tool, text)."""
    calls = [
        ("list_decisions", {}), ("list_decisions", {"class": "judgement"}),
        ("list_decisions", {"status": "reversed"}),
        ("get_decision", {"decision": str(w["number"])}),
        ("get_decision", {"decision": w["decision_id"]}),
        ("get_baseline", {}), ("get_entity", {"entity_id": w["entity_id"]}),
        ("list_entity_revisions", {"entity_id": w["entity_id"]}),
        ("search", {"q": WORD}), ("search", {"q": "Team plan pricing"}),
        ("get_source_item", {"item_id": w["entity_id"]}),
        ("list_change_events", {}),
        ("get_ritual_occurrence_pre_read", {"occurrence_id": w["occ_id"]}),
        ("get_ritual_occurrence", {"occurrence_id": w["occ_id"]}),
    ]  # fmt: skip
    calls += [("get_document", {"doc": slug}) for slug, _id in w["docs"]]
    out = []
    async with mcp_client(raw) as c:
        offered = {t.name for t in (await c.list_tools()).tools}
        for name, args in calls:
            if name not in offered:
                continue
            got = await c.call_tool(name, args)
            text = text_of(got)
            for value in args.values():  # what the caller sent is not a leak
                text = text.replace(value, "")
            out.append((name, text))
    return out


@pytest.mark.parametrize("starter", ["owner", "oracle"])
@pytest.mark.parametrize("flow", MEMBER_FLOWS)
async def test_a_member_flow_run_reads_as_a_commenter(client, ctx, flow, starter):
    """protects=a run of a flow whose output every member reads, started by an owner or
    by Oracle, reads nothing of the hidden pricing decision or memo through
    list_decisions, get_decision, get_baseline, get_entity, search, get_source_item,
    list_change_events, the occurrence reads or get_document; fails_when=it reads them
    with its creator's role; no_claim=which tools a run is offered (oracle.mcp.scopes)."""
    w = await _world(client, ctx)
    raw = await _member_run(ctx, flow, w["occ_id"], starter)
    reads = await _reads(raw, w)
    offered = {n for n, _ in reads}
    assert "search" in offered, reads
    if "read:baseline" in {x for seg in flows.FLOWS[flow].segments for x in seg.scopes}:
        assert {"list_decisions", "get_decision", "get_baseline"} <= offered, offered
        assert any(CONTROL in t for n, t in reads if n == "list_decisions"), "control missing"
    for name, text in reads:
        assert not _leaks(text, w), (name, text[:400])


async def test_a_run_whose_output_only_approvers_read_still_reads_them(client, ctx):
    """protects=a pricing memo run (its output is an approvers-only memo) of an owner still
    reads the hidden decision and memo; fails_when=the member view applies to every run;
    no_claim=other approvers-only flows (update_draft has the same rule)."""
    w = await _world(client, ctx)
    assert not flows.FLOWS["pricing_memo"].member_output
    assert not flows.FLOWS["update_draft"].member_output
    raw = await _member_run(ctx, "pricing_memo", w["occ_id"], "owner")
    reads = dict(await _reads(raw, w))
    assert QUESTION in reads["get_baseline"], reads["get_baseline"][:400]
    assert QUESTION in reads["list_decisions"]


def test_the_member_flows():
    """protects=the flows whose output every member reads are marked, and only those;
    fails_when=a flow's output reaches every member without the mark; no_claim=flows a
    later lane adds (it must decide)."""
    marked = {k for k, f in flows.FLOWS.items() if f.member_output}
    assert marked == set(MEMBER_FLOWS)


# ------------------------------------------------------------------- the importers


async def _variance(ctx, occ_id: str) -> uuid.UUID:
    """An open variance listed in the occurrence's pre-read (a metrics review's)."""
    async with tenant_session(ctx.tenant_id) as s:
        m = Metric(title="Active teams", description="Teams active in the week",
                   kind="output", unit="teams", direction="up", source="manual",
                   owner_id=ctx.users["owner"].id)  # fmt: skip
        s.add(m)
        await s.flush()
        v = MetricVariance(metric_id=m.id, week_start=datetime(2026, 10, 19).date(),
                           value=140, previous=100, direction="better", status="open")  # fmt: skip
        s.add(v)
        await s.flush()
        occ = await s.get(RitualOccurrence, uuid.UUID(occ_id))
        occ.pre_read = {**occ.pre_read, "blocks": [*occ.pre_read["blocks"], {
            "key": "variances", "title": "Variances",
            "rows": [{"variance_id": str(v.id), "text": "Active teams +40"}]}]}  # fmt: skip
        await s.commit()
        return v.id


async def test_the_variance_importer_drops_refs_to_hidden_decisions(client, ctx):
    """protects=the metrics_variance importer of an owner's run keeps a ref to a decision a
    commenter may read and drops the hidden pricing decision's; fails_when=it checks refs
    as the run's creator; no_claim=the draft's own text (read-time rule below)."""
    w = await _world(client, ctx)
    vid = await _variance(ctx, w["occ_id"])
    async with tenant_session(ctx.tenant_id) as s:
        control = await s.scalar(select(Decision.id).where(Decision.title == CONTROL))
        run = Run(flow="metrics_variance", created_by=ctx.users["owner"].id,
                  knobs=_knobs(w))  # fmt: skip
        s.add(run)
        await s.flush()
        occ = await s.get(RitualOccurrence, uuid.UUID(w["occ_id"]))
        occ.summary_run_id = run.id
        await s.commit()
    doc = {"version": 1, "variances": [{
        "id": str(vid), "draft": "The starter plan shipped that week.", "confidence": "medium",
        "refs": [{"kind": "decision", "id": w["decision_id"]},
                 {"kind": "decision", "id": str(control)}]}]}  # fmt: skip
    files = {"summary.md": "Active teams jumped.", "variances.yaml": yaml.safe_dump(doc)}
    from oracle.metrics import explain

    async with tenant_session(ctx.tenant_id) as s:
        out = await explain.import_drafts(s, run, files, None)  # type: ignore[arg-type]
        row = await s.get(MetricVariance, vid)
    assert row.oracle_refs == [{"kind": "decision", "id": str(control)}], row.oracle_refs
    assert "1 ref dropped (not readable by the run)" in out["notes"], out


@pytest.mark.parametrize("why", ["ref", "text"])
async def test_a_variance_draft_naming_a_hidden_decision_is_withheld(client, ctx, why):
    """protects=a variance draft written before this fix that cites the hidden pricing
    decision (a ref) or names it (its text) is not shown to a commenter or a viewer on
    the variance cards, and still is to an owner and an approver; fails_when=a member
    reads it; no_claim=drafts naming nothing hidden (unchanged)."""
    w = await _world(client, ctx)
    vid = await _variance(ctx, w["occ_id"])
    draft = (f"D-{w['number']} {QUESTION} explains it." if why == "text"
             else "A pricing change explains it.")  # fmt: skip
    async with tenant_session(ctx.tenant_id) as s:
        row = await s.get(MetricVariance, vid)
        row.oracle_draft, row.oracle_confidence = draft, "medium"
        row.oracle_refs = [{"kind": "decision", "id": w["decision_id"]}] if why == "ref" else []
        await s.commit()
    for who, sees in ROLES:
        got = await client.get("/v1/metric-variances", headers=ctx.as_(who))
        assert got.status_code == 200, got.text
        (out,) = got.json()
        assert (out["oracle_draft"] == draft) is sees, who
        if not sees:
            assert not _leaks(got.text, w) and out["oracle_confidence"] is None, who


@pytest.mark.parametrize("flow", ["ritual_summary", "metrics_variance", "competitive_digest"])
async def test_a_summary_naming_a_hidden_decision_is_withheld(client, ctx, flow):
    """protects=an occurrence summary (a ritual summary, the variance run's summary.md, the
    competitive digest) that names the hidden pricing decision, written by a member-view
    run before this fix (it read list_decisions or get_baseline as the owner), is not
    shown to a commenter or a viewer, and still is to an owner; fails_when=a member reads
    it; no_claim=a summary naming nothing hidden (kept)."""
    w = await _world(client, ctx)
    text = f"Review D-{w['number']} first: {QUESTION}"
    async with tenant_session(ctx.tenant_id) as s:
        run = Run(flow=flow, created_by=ctx.users["owner"].id,
                  knobs=_knobs(w))  # fmt: skip
        s.add(run)
        await s.flush()
        occ = await s.get(RitualOccurrence, uuid.UUID(w["occ_id"]))
        occ.summary, occ.summary_state, occ.summary_run_id = text, "ready", run.id
        await s.commit()
    for who, sees in ROLES:
        got = await client.get(f"/v1/ritual-occurrences/{w['occ_id']}", headers=ctx.as_(who))
        assert got.status_code == 200, got.text
        assert (got.json()["summary"] == text) is sees, who
        if not sees:
            assert not _leaks(got.text, w), who


async def test_a_summary_is_withheld_once_a_document_it_names_turns_approvers_only(client, ctx):
    """protects=minor (a): a summary written from the member view that names an update
    while it was company-wide is withheld from a commenter once an owner makes the update
    approvers-only, and kept before; fails_when=the stored text still shows; no_claim=
    text that paraphrases the document without its title (not detectable)."""
    w = await _world(client, ctx)
    async with tenant_session(ctx.tenant_id) as s:
        doc = Document(slug="investor-update-october", title="Investor update October 2026",
                       kind="update", visibility="company")  # fmt: skip
        s.add(doc)
        run = Run(flow="ritual_summary", created_by=ctx.users["owner"].id,
                  knobs=_knobs(w))  # fmt: skip
        s.add(run)
        await s.flush()
        occ = await s.get(RitualOccurrence, uuid.UUID(w["occ_id"]))
        text = "The Investor update October 2026 is due; Ship the starter plan monthly."
        occ.summary, occ.summary_state, occ.summary_run_id = text, "ready", run.id
        await s.commit()
        doc_id = doc.id
    url = f"/v1/ritual-occurrences/{w['occ_id']}"
    assert (await client.get(url, headers=ctx.as_("commenter"))).json()["summary"] == text
    async with tenant_session(ctx.tenant_id) as s:
        (await s.get(Document, doc_id)).visibility = "approvers"
        await s.commit()
    assert (await client.get(url, headers=ctx.as_("commenter"))).json()["summary"] is None
    assert (await client.get(url, headers=ctx.as_("owner"))).json()["summary"] == text


async def test_proposals_accepted_counts_no_proposal_on_a_hidden_decision(client, ctx):
    """protects=minor (b): the pre-read's Proposals accepted count (built once, read by
    every member) leaves out a proposal on the hidden pricing decision's entity; fails_when=
    it counts it; no_claim=other figures."""
    w = await _world(client, ctx)
    now = datetime.now(UTC)
    async with tenant_session(ctx.tenant_id) as s:
        goal = Entity(type="goal", key="g-teams", title="More teams", origin="user", attrs={})
        s.add(goal)
        await s.flush()
        for entity_id in (uuid.UUID(w["entity_id"]), goal.id):
            s.add(Proposal(entity_id=entity_id, payload={"op": "update"}, status="accepted",
                           decided_at=now))  # fmt: skip
        await s.flush()
        accepted = await s.scalar(select(Proposal.id).where(Proposal.status == "accepted").limit(1))
        assert accepted is not None
        bctx = ritual_blocks.BlockCtx(ritual_owner_id=ctx.users["owner"].id,
                                      period_from=now - timedelta(days=7),
                                      period_to=now + timedelta(minutes=1), now=now)  # fmt: skip
        before = await _count(s, bctx, exclude_entity=uuid.UUID(w["entity_id"]))
        rows = await ritual_blocks.since_last(s, bctx)
    (row,) = [r for r in rows if r["label"] == "Proposals accepted"]
    assert row["count"] == before, (row, before)


async def _count(s, bctx, *, exclude_entity: uuid.UUID) -> int:
    rows = await s.scalars(
        select(Proposal).where(
            Proposal.status == "accepted",
            Proposal.decided_at.between(bctx.period_from, bctx.period_to),
        )
    )
    return sum(1 for p in rows if p.entity_id != exclude_entity)
