"""Security review, round 5 (S6, B4 and AUD-9; owner decisions of 2026-10-19).

Two owner decisions revise round 4:

(a) while any finding from an intake is below "shared in full", runs cannot read ANY
    item that intake's analysis read, cited or not; sharing the findings in full makes
    them readable again;
(b) a baseline proposal from an answer to a finding shared at "counts" carries only the
    category's question, no answer text and no model-set severity; the answer text and
    severity appear from "summary" up.

Synthetic placeholders only.
"""

import json
import re
import uuid
from datetime import UTC, datetime, timedelta

import pytest
from sqlalchemy import select, text

from oracle import readiness
from oracle.auth.deps import Principal
from oracle.baseline.models import Evidence, Proposal
from oracle.intake import categories as cats
from oracle.intake import checks as intake_checks
from oracle.intake import evidence as ev
from oracle.intake import sharing
from oracle.intake.models import IntakeProposal
from oracle.jobs import worker
from oracle.llm import gateway
from oracle.models import AuditEvent
from oracle.sources.models import SourceItem
from oracle.tenancy import tenant_session
from oracle.v2.models import KnowledgeGap, ProductIntake, StakeholderQuestion
from tests.baseline_helpers import NOW, entity, make_item
from tests.claude_account_helpers import add_account, window
from tests.intake_helpers import company, create_intake, gaps_by_category
from tests.test_intake import _document
from tests.test_intake_jobs import FakeClaude
from tests.test_intake_sharing import (
    CODENAME,
    EXCERPT_A,
    EXCERPT_B,
    EXCERPT_OLD,
    MODEL_GAP,
    TITLE_A,
    _model,
    add_author,
    findings,
    read_summary,
    share_all,
)
from tests.test_intake_sharing_writes import as_run

OTHERS = ["viewer", "commenter", "approver", "owner"]
# Matches the run's queries, outranks the shared items, and is never shared.
HIDDEN = "Zebra zebra zebra crossing: zebra zebra zebra buyers zebra notes."


@pytest.fixture
def fake():
    holder = {}

    def install(answer):
        claude = FakeClaude(answer)
        holder["previous"] = gateway.set_transports(gateway.Transports(plan=claude, api_key=claude))
        return claude

    yield install
    if "previous" in holder:
        gateway.set_transports(holder["previous"])


async def share(client, ctx, intake_id: str, fid: str, level: str, who: str = "author"):
    resp = await client.patch(
        f"/v1/intakes/{intake_id}/findings/{fid}", json={"sharing": level}, headers=ctx.as_(who)
    )
    assert resp.status_code == 200, resp.text
    return resp.json()


async def source_of(ctx, item_id: uuid.UUID) -> str:
    async with tenant_session(ctx.tenant_id) as s:
        return str((await s.get(SourceItem, item_id)).source_id)


async def world(client, fake, *, hidden: bool, model=_model, role: str = "commenter", **body):
    """The author's intake over three private items (a conflict between a and b, a stale
    item), the model's analysis, and (``hidden``) two more items that match the run's
    queries: one in a chosen source the analysis did not find relevant, one in a source
    the intake did not choose."""
    ctx = await company()
    await add_account(ctx.tenant_id, "personal", windows={"five_hour": window(0.2)})
    await add_author(ctx, role)
    items = {
        "a": await make_item(ctx, "author", content=EXCERPT_A, title=TITLE_A),
        "b": await make_item(ctx, "author", content=EXCERPT_B, title="#finance numbers"),
        "old": await make_item(
            ctx, "author", content=EXCERPT_OLD, title="#old thread",
            updated=NOW - timedelta(days=3 * 365),
        ),
    }  # fmt: skip
    chosen = [await source_of(ctx, i) for i in items.values()]
    if hidden:
        items["h1"] = await make_item(ctx, "author", content=HIDDEN, title="#zebra one")
        chosen.append(await source_of(ctx, items["h1"]))
        items["h2"] = await make_item(ctx, "author", content=HIDDEN, title="#zebra two")
    fake(model)
    out = await create_intake(
        client, ctx, who="author", ai_extraction=True, source_ids=chosen, **body
    )
    tick = await worker.run_pending(ctx.tenant_id)
    assert tick.succeeded == 1, tick.errors
    return ctx, out["intake"]["id"], items


async def link(client, ctx, intake_id: str, doc: str) -> None:
    intake = await client.get(f"/v1/intakes/{intake_id}", headers=ctx.as_("approver"))
    resp = await client.patch(
        f"/v1/intakes/{intake_id}",
        json={"document": doc, "lock_version": intake.json()["lock_version"]},
        headers=ctx.as_("approver"),
    )
    assert resp.status_code == 200, resp.text


async def finding_of(client, ctx, intake_id: str, kind: str, origin: str | None = None) -> dict:
    rows = [
        r
        for r in await findings(client, ctx, intake_id)
        if r["kind"] == kind and (origin is None or r["origin"] == origin)
    ]
    return rows[0]


# --- BLOCKER: the intake evidence search filters before it ranks and limits ---------------


async def test_a_runs_intake_search_reads_the_same_whether_hidden_items_match(client, fake):
    """A run's intake evidence search ranks and limits over the items it may be shown
    only: with any limit and any query, hidden items that match change nothing."""
    responses = {}
    for hidden in (False, True):
        ctx, intake_id, _ = await world(client, fake, hidden=hidden)
        # Every finding in full (round 6: a finding below full withholds the intake's
        # items from runs, so nothing would be searched at all).
        await share_all(client, ctx, intake_id, "full")
        out = []
        for q in ("buyers", "zebra or buyers", "buyers or zebra or address", "zebra"):
            for limit in (1, 2, 3, 5):
                resp = await client.get(
                    f"/v1/intakes/{intake_id}/evidence",
                    params={"q": q, "limit": limit},
                    headers=as_run(ctx),
                )
                assert resp.status_code == 200, resp.text
                hits = resp.json()["hits"]
                # Equal ranks break on random ids, so a tie may pick either shared item:
                # compare what ranks where, and every hit once the limit takes them all.
                shown = sorted((h["title"], h["snippet"], h["visible"]) for h in hits)
                out.append((q, limit, [h["relevance"] for h in hits],
                            shown if limit >= 3 else len(shown)))  # fmt: skip
        responses[hidden] = out
    assert responses[True] == responses[False]
    # And the shared items are found at every limit.
    assert all(ranks for q, _, ranks, _ in responses[True] if q != "zebra")


# --- MAJOR 1 (owner decision a): everything the analysis read is withheld ------------------


def _cites_nothing(payload):
    """A model analysis that read the sources and cites none of them."""
    return {
        "items": [{"field": "users", "text": "Returning buyers.", "evidence_refs": []}],
        "gaps": [{"category": "blockers", "importance": "critical",
                  "statement": f"The {CODENAME} quota blocks pre-fill.", "evidence_refs": []}],
        "category": "feature",
    }  # fmt: skip


async def run_reads(client, ctx, intake_id: str, items: dict) -> dict[str, int | str]:
    h = as_run(ctx)
    out: dict[str, int | str] = {}
    for name, item in items.items():
        out[name] = (await client.get(f"/v1/source-items/{item}", headers=h)).status_code
    resp = await client.get("/v1/search", params={"q": "buyers"}, headers=h)
    out["search"] = resp.text
    return out


async def test_a_finding_that_cites_nothing_withholds_everything_its_intake_read(client, fake):
    ctx, intake_id, items = await world(client, fake, hidden=False, model=_cites_nothing)
    rows = await findings(client, ctx, intake_id)
    model = [r for r in rows if r["origin"] == "model"]
    assert model and all(r["sharing"] == "private" for r in model)
    # Every finding the rules made is shared in full; the model's cite nothing.
    changes = [{"finding_id": r["id"], "sharing": "full"} for r in rows if r["origin"] != "model"]
    resp = await client.post(
        f"/v1/intakes/{intake_id}/findings/sharing", json={"changes": changes},
        headers=ctx.as_("author"),
    )  # fmt: skip
    assert resp.status_code == 200, resp.text
    reads = await run_reads(client, ctx, intake_id, items)
    for name in ("a", "b", "old"):
        assert reads[name] == 404, (name, reads[name])
        assert str(items[name]) not in reads["search"]
    # Shared in full, all of them: readable again.
    for r in model:
        await share(client, ctx, intake_id, r["id"], "full")
    reads = await run_reads(client, ctx, intake_id, items)
    assert reads["a"] == 200 and str(items["a"]) in reads["search"]


async def test_an_intake_without_the_record_withholds_what_it_read(client, fake):
    """An intake analysed before the record was kept: everything its stored analysis
    names is withheld (fail closed), whatever the levels say."""
    ctx, intake_id, items = await world(client, fake, hidden=False, model=_cites_nothing)
    for r in await findings(client, ctx, intake_id):
        await share(client, ctx, intake_id, r["id"], "full")
    async with tenant_session(ctx.tenant_id) as s:
        intake = await s.get(ProductIntake, uuid.UUID(intake_id))
        intake.analysis = {k: v for k, v in intake.analysis.items() if k != "read_item_ids"}
        await s.flush()
        await ev.record_reads(s, intake)
        await s.commit()
    async with tenant_session(ctx.tenant_id) as s:
        intake = await s.get(ProductIntake, uuid.UUID(intake_id))
        relevant = set(intake.analysis["relevant_item_ids"])
    assert relevant
    reads = await run_reads(client, ctx, intake_id, items)
    for name, item in items.items():
        if str(item) in relevant:
            assert reads[name] == 404, name


# --- MAJOR 2: no route copies or quotes a withheld item for a run -------------------------


async def test_a_run_cannot_attach_a_withheld_item_as_baseline_evidence(client, fake):
    ctx, intake_id, items = await world(client, fake, hidden=False, role="approver")
    risk = await entity(client, ctx, type="risk", key="address-risk", title="Address risk")
    h = as_run(ctx)
    for name in ("a", "b", "old"):
        resp = await client.post(
            f"/v1/baseline/entities/{risk['id']}/evidence",
            json={"source_item_id": str(items[name])}, headers=h,
        )  # fmt: skip
        assert resp.status_code == 404, (name, resp.text)
    async with tenant_session(ctx.tenant_id) as s:
        assert (await s.scalars(select(Evidence))).all() == []
    # The author's own session may cite it; a run then reads the evidence (copied at
    # the author's choice) but not the item behind it.
    resp = await client.post(
        f"/v1/baseline/entities/{risk['id']}/evidence",
        json={"source_item_id": str(items["a"])}, headers=ctx.as_("author"),
    )  # fmt: skip
    assert resp.status_code == 201, resp.text
    resp = await client.get("/v1/baseline/evidence", params={"entity_id": risk["id"]}, headers=h)
    assert resp.status_code == 200
    [shown] = resp.json()
    assert shown["source_item"] is None and shown["source_item_private"]
    yaml_out = await client.get("/v1/baseline/yaml", headers=h)
    assert str(items["a"]) not in yaml_out.text


async def test_a_run_cannot_cite_a_withheld_item_in_an_answer(client, fake):
    ctx, intake_id, items = await world(client, fake, hidden=False)
    async with tenant_session(ctx.tenant_id) as s:
        q = await s.scalar(
            select(StakeholderQuestion).where(
                StakeholderQuestion.intake_id == uuid.UUID(intake_id),
                StakeholderQuestion.category == "pain_evidence",
            )
        )
    resp = await client.post(
        f"/v1/questions/{q.id}/answers",
        json={"kind": "answer", "body": "Yes.", "evidence_ids": [str(items["a"])]},
        headers=as_run(ctx),
    )
    assert resp.status_code == 422, resp.text
    resp = await client.post(
        f"/v1/questions/{q.id}/answers",
        json={"kind": "answer", "body": "Yes.", "evidence_ids": [str(items["a"])]},
        headers=ctx.as_("author"),
    )
    assert resp.status_code == 201, resp.text


# --- MAJOR 3 (owner decision b): counts proposes the question only ------------------------

ANSWER = "Only the EU region; the partner caps pre-fill at 1000 calls a day."


def _blocker_gap(payload):
    answer = _model(payload)
    answer["items"] = []
    answer["gaps"] = [{"category": "blockers", "importance": "critical",
                       "statement": MODEL_GAP, "evidence_refs": []}]  # fmt: skip
    return answer


async def _baseline_proposals(ctx) -> list[Proposal]:
    async with tenant_session(ctx.tenant_id) as s:
        return list((await s.scalars(select(Proposal).order_by(Proposal.created_at))).all())


async def test_counts_proposes_only_the_categorys_question(client, fake):
    ctx, intake_id, _ = await world(client, fake, hidden=False, model=_blocker_gap)
    async with tenant_session(ctx.tenant_id) as s:
        gap = await s.scalar(select(KnowledgeGap).where(KnowledgeGap.statement == MODEL_GAP))
        q = await s.scalar(select(StakeholderQuestion).where(StakeholderQuestion.gap_id == gap.id))
    resp = await client.post(
        f"/v1/questions/{q.id}/answers", json={"kind": "answer", "body": ANSWER},
        headers=ctx.as_("author"),
    )  # fmt: skip
    assert resp.status_code == 201, resp.text
    assert await _baseline_proposals(ctx) == []
    prompt = cats.BY_KEY["blockers"].prompt

    await share(client, ctx, intake_id, str(gap.id), "counts")
    [proposal] = await _baseline_proposals(ctx)
    fields = proposal.payload["fields"]
    dumped = json.dumps(proposal.payload)
    # \b: random ids in the payload (e.g. "blockers-a5110000") may contain the digits.
    assert ANSWER not in dumped and not re.search(r"\b1000\b", dumped)
    assert CODENAME not in dumped
    assert fields["title"] == prompt and fields["body"] == prompt
    assert set(fields["attrs"]) <= {"gap_id", "category"}
    assert "severity" not in dumped and "critical" not in dumped
    assert intake_id not in dumped
    listed = await client.get("/v1/baseline/proposals", headers=ctx.as_("viewer"))
    assert ANSWER not in listed.text

    # Summary: the same proposal now carries the answer and the public severity.
    await share(client, ctx, intake_id, str(gap.id), "summary")
    [same] = await _baseline_proposals(ctx)
    assert same.id == proposal.id
    assert ANSWER in json.dumps(same.payload)
    async with tenant_session(ctx.tenant_id) as s:
        from oracle.intake.answers import importance_of

        intake = await s.get(ProductIntake, uuid.UUID(intake_id))
        expected = importance_of(intake, await s.get(KnowledgeGap, gap.id))
    assert same.payload["fields"]["attrs"]["proposed_blocker"]["severity"] == expected

    # Back to counts: stripped again.
    await share(client, ctx, intake_id, str(gap.id), "counts")
    [again] = await _baseline_proposals(ctx)
    assert again.id == proposal.id and ANSWER not in json.dumps(again.payload)
    assert "severity" not in json.dumps(again.payload)
    # Private (round 6, owner 2026-10-19): the open proposal is withdrawn, still stripped.
    await share(client, ctx, intake_id, str(gap.id), "private")
    [again] = await _baseline_proposals(ctx)
    assert again.id == proposal.id and again.status == "withdrawn"
    assert ANSWER not in json.dumps(again.payload) and "severity" not in json.dumps(again.payload)


async def test_answering_a_finding_at_counts_proposes_only_the_question(client, fake):
    ctx, intake_id, _ = await world(client, fake, hidden=False, model=_blocker_gap)
    doc = await _document(client, ctx)
    async with tenant_session(ctx.tenant_id) as s:
        gap = await s.scalar(select(KnowledgeGap).where(KnowledgeGap.statement == MODEL_GAP))
        q = await s.scalar(select(StakeholderQuestion).where(StakeholderQuestion.gap_id == gap.id))
    await link(client, ctx, intake_id, doc)
    await share(client, ctx, intake_id, str(gap.id), "counts")
    resp = await client.post(
        f"/v1/questions/{q.id}/answers", json={"kind": "answer", "body": ANSWER},
        headers=ctx.as_("author"),
    )  # fmt: skip
    assert resp.status_code == 201, resp.text
    [proposal] = await _baseline_proposals(ctx)
    assert ANSWER not in json.dumps(proposal.payload)
    # No PRD patch carries the answer while others may not read it.
    async with tenant_session(ctx.tenant_id) as s:
        patches = (await s.scalars(select(IntakeProposal))).all()
    assert all(ANSWER not in json.dumps(p.detail) for p in patches if p.kind == "prd_patch")


# --- minors ----------------------------------------------------------------------------------


def _principal(ctx, who: str) -> Principal:
    user = ctx.users[who]
    return Principal(tenant_id=ctx.tenant_id, kind="user", role=user.role, user_id=user.id)


async def test_a_publish_gate_never_carries_the_viewers_private_gaps(client, fake):
    ctx = await company()
    await add_account(ctx.tenant_id, "personal", windows={"five_hour": window(0.2)})
    await add_author(ctx, "approver")
    await make_item(ctx, "author", content=EXCERPT_A, title=TITLE_A)
    doc = await _document(client, ctx)
    fake(_cites_nothing)
    out = await create_intake(client, ctx, who="author", ai_extraction=True, document=doc)
    assert (await worker.run_pending(ctx.tenant_id)).succeeded == 1
    document_id = uuid.UUID(out["intake"]["document_id"])
    author = _principal(ctx, "author")
    async with tenant_session(ctx.tenant_id) as s:
        publish = await readiness.evaluate(
            readiness.ReadinessContext(s, document_id, purpose="publish", viewer=author),
            keys=[intake_checks.CRITICAL_BLOCKERS],
        )
        advisory = await readiness.evaluate(
            readiness.ReadinessContext(s, document_id, viewer=author),
            keys=[intake_checks.CRITICAL_BLOCKERS],
        )
    assert CODENAME not in publish.model_dump_json()
    assert "only you" not in publish.model_dump_json().lower()
    assert CODENAME in advisory.model_dump_json()


async def _open_finding_intake(client, fake) -> tuple:
    """An intake whose model read no source: its findings are open (not restricted)."""
    ctx = await company()
    await add_account(ctx.tenant_id, "personal", windows={"five_hour": window(0.2)})
    await add_author(ctx)
    fake(_cites_nothing)
    out = await create_intake(client, ctx, who="author", ai_extraction=True)
    assert (await worker.run_pending(ctx.tenant_id)).succeeded == 1
    intake_id = out["intake"]["id"]
    async with tenant_session(ctx.tenant_id) as s:
        intake = await s.get(ProductIntake, uuid.UUID(intake_id))
        [fid] = [f for f, e in intake.analysis["findings"].items() if e.get("kind") == "gap"
                 and e.get("origin") == "model"]  # fmt: skip
        assert intake.analysis["findings"][fid].get("restricted") is False
    return ctx, intake_id, fid


async def test_an_unrestricted_finding_takes_no_summary_or_level(client, fake):
    ctx, intake_id, fid = await _open_finding_intake(client, fake)
    resp = await client.put(
        f"/v1/intakes/{intake_id}/findings/{fid}/summary", json={}, headers=ctx.as_("author")
    )
    assert resp.status_code == 409, resp.text
    resp = await client.patch(
        f"/v1/intakes/{intake_id}/findings/{fid}", json={"sharing": "full"},
        headers=ctx.as_("author"),
    )  # fmt: skip
    assert resp.status_code == 409, resp.text


async def test_run_withheld_reads_one_precomputed_set(client, fake, monkeypatch):
    ctx, intake_id, items = await world(client, fake, hidden=False)

    def boom(*a, **k):
        raise AssertionError("run_withheld must not load and parse intakes")

    monkeypatch.setattr(sharing, "registry", boom)
    async with tenant_session(ctx.tenant_id) as s:
        run = Principal(
            tenant_id=ctx.tenant_id, kind="user", role="commenter",
            user_id=ctx.users["author"].id, run_id=uuid.uuid4(),
        )  # fmt: skip
        withheld = await ev.run_withheld(s, run)
    assert {items["a"], items["b"], items["old"]} <= withheld


async def test_a_runs_source_counts_match_what_it_may_list(client, fake):
    ctx, intake_id, items = await world(client, fake, hidden=False)
    h = as_run(ctx)
    sources = (await client.get("/v1/sources", headers=h)).json()
    for source in sources:
        listed = await client.get(f"/v1/sources/{source['id']}/items", headers=h)
        assert source["item_count"] == len(listed.json()), source["name"]
    one = await client.get(f"/v1/sources/{sources[0]['id']}", headers=h)
    listed = await client.get(f"/v1/sources/{sources[0]['id']}/items", headers=h)
    assert one.json()["item_count"] == len(listed.json())
    # The author's own session counts everything.
    mine = (await client.get("/v1/sources", headers=ctx.as_("author"))).json()
    assert sum(s["item_count"] for s in mine) == 3


async def test_a_private_findings_summary_audit_names_only_its_id(client, fake):
    ctx, intake_id, _ = await world(client, fake, hidden=False)
    gap = await finding_of(client, ctx, intake_id, "gap", "model")
    resp = await client.put(
        f"/v1/intakes/{intake_id}/findings/{gap['id']}/summary", json={"text": "Rollout plan"},
        headers=ctx.as_("author"),
    )  # fmt: skip
    assert resp.status_code == 200, resp.text
    async with tenant_session(ctx.tenant_id) as s:
        [event] = (
            await s.scalars(
                select(AuditEvent).where(AuditEvent.action == "intake.finding_summary_set")
            )
        ).all()
    assert event.data == {"finding_id": gap["id"]}


async def test_legacy_importance_rows_are_indexed_and_normalized(client, fake):
    ctx, intake_id, _ = await world(client, fake, hidden=False)
    async with tenant_session(ctx.tenant_id) as s:
        names = (
            await s.scalars(
                text("SELECT indexname FROM pg_indexes WHERE tablename = 'knowledge_gaps'")
            )
        ).all()
        assert "ix_knowledge_gaps_legacy_importance" in names
        for g in (
            await s.scalars(
                select(KnowledgeGap).where(
                    KnowledgeGap.intake_id == uuid.UUID(intake_id),
                    KnowledgeGap.rule_key.is_not(None),
                )
            )
        ).all():
            g.importance_basis = None
        await s.commit()
    resp = await client.post(f"/v1/intakes/{intake_id}/analyze", headers=ctx.as_("author"))
    assert resp.status_code == 200, resp.text
    async with tenant_session(ctx.tenant_id) as s:
        legacy = (
            await s.scalars(
                select(KnowledgeGap).where(
                    KnowledgeGap.rule_key.is_not(None), KnowledgeGap.importance_basis.is_(None)
                )
            )
        ).all()
    assert legacy == []


# --- also checked: stale rows, research proposals, PRD patches, B4 -------------------------


async def test_a_stale_finding_at_summary_shows_its_line_not_its_row(client, fake):
    ctx, intake_id, items = await world(client, fake, hidden=False)
    stale = await finding_of(client, ctx, intake_id, "stale")
    await share(client, ctx, intake_id, stale["id"], "summary")
    for who in OTHERS:
        out = await read_summary(client, ctx, intake_id, who)
        [row] = out["stale"]
        assert "freshness" not in row["reason"], who
        assert row["evidence"]["visible"] is False
        assert row["reason"] == stale["summary"], who


async def test_research_and_patches_of_a_finding_shared_as_counts_stay_hidden(client, fake):
    ctx, intake_id, _ = await world(client, fake, hidden=False, model=_blocker_gap)
    async with tenant_session(ctx.tenant_id) as s:
        gap = await s.scalar(select(KnowledgeGap).where(KnowledgeGap.statement == MODEL_GAP))
    resp = await client.post(f"/v1/gaps/{gap.id}/research", headers=ctx.as_("author"))
    assert resp.status_code == 201, resp.text
    proposal = resp.json()
    assert MODEL_GAP not in resp.text
    await share(client, ctx, intake_id, str(gap.id), "counts")
    for who in OTHERS:
        resp = await client.get(f"/v1/intakes/{intake_id}/proposals", headers=ctx.as_(who))
        assert proposal["id"] not in resp.text, who
        resp = await client.post(
            f"/v1/intake-proposals/{proposal['id']}/accept", headers=ctx.as_(who)
        )
        assert resp.status_code in (403, 404), who
    resp = await client.get(f"/v1/intakes/{intake_id}/proposals", headers=as_run(ctx))
    assert proposal["id"] not in resp.text


async def test_a_prd_patch_is_not_accepted_while_others_may_not_read_it(client, fake):
    ctx, intake_id, _ = await world(client, fake, hidden=False, model=_blocker_gap, role="owner")
    doc = await _document(client, ctx)
    await link(client, ctx, intake_id, doc)
    async with tenant_session(ctx.tenant_id) as s:
        gap = await s.scalar(select(KnowledgeGap).where(KnowledgeGap.statement == MODEL_GAP))
        q = await s.scalar(select(StakeholderQuestion).where(StakeholderQuestion.gap_id == gap.id))
    await share(client, ctx, intake_id, str(gap.id), "summary")
    resp = await client.post(
        f"/v1/questions/{q.id}/answers", json={"kind": "answer", "body": ANSWER},
        headers=ctx.as_("author"),
    )  # fmt: skip
    assert resp.status_code == 201, resp.text
    [patch] = [p for p in resp.json()["proposals"] if p["kind"] == "prd_patch"]
    await share(client, ctx, intake_id, str(gap.id), "counts")
    resp = await client.post(
        f"/v1/intake-proposals/{patch['id']}/accept", headers=ctx.as_("author")
    )
    assert resp.status_code == 409, resp.text
    inbox = await client.get("/v1/inbox", headers=ctx.as_("approver"))
    assert ANSWER not in inbox.text


async def _critical_blocker_gap(client, ctx, intake_id: str) -> dict:
    gap = gaps_by_category(await read_summary(client, ctx, intake_id, "viewer"))["blockers"]
    if gap["importance"] != "critical":
        resp = await client.patch(
            f"/v1/gaps/{gap['id']}",
            json={"importance": "critical", "lock_version": gap["lock_version"]},
            headers=ctx.as_("owner"),
        )
        assert resp.status_code == 200, resp.text
        gap = resp.json()
    return gap


async def test_b4_only_an_owner_accepts_a_blockers_risk_for_at_most_90_days(client):
    ctx = await company()
    out = await create_intake(client, ctx, who="approver")
    intake_id = out["intake"]["id"]
    gap = await _critical_blocker_gap(client, ctx, intake_id)
    url = f"/v1/gaps/{gap['id']}/decisions"
    resp = await client.post(
        url, json={"decision": "accept_risk", "rationale": "Partner said yes."},
        headers=ctx.as_("approver"),
    )  # fmt: skip
    assert resp.status_code == 403
    assert resp.json()["detail"] == "Only an owner can accept this risk"
    late = (datetime.now(UTC) + timedelta(days=120)).isoformat()
    resp = await client.post(
        url, json={"decision": "accept_risk", "rationale": "Partner said yes.", "review_at": late},
        headers=ctx.as_("owner"),
    )  # fmt: skip
    assert resp.status_code == 422, resp.text
    resp = await client.post(
        url, json={"decision": "accept_risk", "rationale": "Partner said yes."},
        headers=ctx.as_("owner"),
    )  # fmt: skip
    assert resp.status_code == 201, resp.text
    review_at = datetime.fromisoformat(resp.json()["decision"]["review_at"])
    assert review_at <= datetime.now(UTC) + timedelta(days=90, minutes=1)


async def test_b4_a_critical_gaps_risk_is_reviewed_within_the_company_setting(client):
    """protects=INT-3/B4: a critical gap's accepted risk is reviewed within the company's
    ``blocker_risk_review_max_days``, as a blocker's is; fails_when=the gap reads a fixed
    90 days; no_claim=who may accept it (the test above)."""
    ctx = await company()
    resp = await client.put(
        "/v1/settings/blocker_risk_review_max_days", json={"value": 30}, headers=ctx.as_("owner")
    )
    assert resp.status_code == 200, resp.text
    out = await create_intake(client, ctx, who="approver")
    gap = await _critical_blocker_gap(client, ctx, out["intake"]["id"])
    url = f"/v1/gaps/{gap['id']}/decisions"
    later = (datetime.now(UTC) + timedelta(days=45)).isoformat()
    resp = await client.post(
        url, json={"decision": "accept_risk", "rationale": "Partner said yes.", "review_at": later},
        headers=ctx.as_("owner"),
    )  # fmt: skip
    assert resp.status_code == 422, resp.text
    assert resp.json()["detail"] == "Accepting a critical gap is reviewed within 30 days"
    resp = await client.post(
        url, json={"decision": "accept_risk", "rationale": "Partner said yes."},
        headers=ctx.as_("owner"),
    )  # fmt: skip
    assert resp.status_code == 201, resp.text
    review_at = datetime.fromisoformat(resp.json()["decision"]["review_at"])
    assert review_at <= datetime.now(UTC) + timedelta(days=30, minutes=1)
    assert review_at >= datetime.now(UTC) + timedelta(days=29)


@pytest.fixture(autouse=True)
def _intake_read_on_the_job(monkeypatch):
    """INT2: these cases drive the built-in intake_analysis job, now the SwarmCloud read's
    fallback and the rollback (ORACLE_INTAKE_READ_RUNTIME=job): run them on that path."""
    from oracle.config import get_settings

    monkeypatch.setattr(get_settings(), "intake_read_runtime", "job")
