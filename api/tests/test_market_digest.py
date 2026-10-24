# ruff: noqa: F811 - the fixtures are imported
"""H7 Competitive digest: the ritual kind and its blocks, mentions, the digest run's
estimate and scopes, and its importer's checks under H11 ``market`` (fake runtime; the
web tools' records are written as H7 lane 1's search_web would; made-up alternatives on
``.example`` hosts).

Each test's card: protects=<the observable>; fails_when=<the wrong result it rejects>;
no_claim=<what green does not prove>.
"""

from datetime import date, timedelta

from sqlalchemy import select

from oracle.market.models import (
    CompetitorChange,
    CompetitorWebFinding,
    PositioningSuggestion,
)
from oracle.models import AuditEvent
from oracle.requests.models import ProductRequest
from oracle.runs.models import Run, RunSegment
from oracle.runtokens import RunToken
from oracle.sources.models import Source, SourceItem
from oracle.swarm import FakeRuntime, Outcome, set_runtime
from oracle.tenancy import tenant_session
from tests.market_helpers import (  # noqa: F401
    add_competitor,
    digest_ritual,
    html,
    occurrence,
    ready_digest,
    record_results,
    watch_page,
    web,
)
from tests.ritual_helpers import START, at, ctx, only, tick  # noqa: F401

PRICING = "https://competitor-a.example/pricing"
REVIEW = "https://reviews.example/competitor-a"
SNIPPET = "Users say it took our team two weeks to set up the new workspace."


async def _setup(client, ctx, at, web, aliases=("CompA",)) -> tuple[str, str]:
    """Seeds the rituals, adds Competitor A (resuming the digest) and a pricing page
    that changes a week later; returns (competitor id, change id)."""
    await tick(ctx.tenant_id)
    web.page(PRICING, html("Starter $10", "Team $50"))
    cid = (await add_competitor(client, ctx, aliases=list(aliases))).json()["id"]
    assert (await watch_page(client, ctx, cid, PRICING)).status_code == 201
    at(START + timedelta(days=7))
    web.page(PRICING, html("Starter $12", "Team $50", "Teams of 5: $40", "Annual: 2 months free"))
    resp = await client.post(f"/v1/competitor-pages/{(await _page_id(client, ctx, cid))}/check",
                             headers=ctx.as_("approver"))  # fmt: skip
    assert resp.status_code == 200, resp.text
    changes = (await client.get("/v1/competitor-changes", headers=ctx.as_("viewer"))).json()
    return cid, changes[0]["id"]


async def _page_id(client, ctx, cid) -> str:
    got = (await client.get(f"/v1/competitors/{cid}", headers=ctx.as_("viewer"))).json()
    return got["page_list"][0]["id"]


async def _set_market(client, ctx, level: str) -> None:
    resp = await client.put("/v1/autonomy/market", json={"level": level, "reason": "test"},
                            headers=ctx.as_("owner"))  # fmt: skip
    assert resp.status_code == 200, resp.text


def _files(cid: str, change_id: str, **over) -> dict[str, str]:
    files = {
        "digest.md": "# Digest\n\nCompetitor A raised Starter to $12 ([change](/company/market?"
        f"change={change_id})); a review says setup is slow ([w-1]({REVIEW})).\n\n"
        "## Battlecard inputs\n\n- Where we win: setup in a day.\n",
        "changes.yaml": f"version: 1\nchanges:\n  - id: {change_id}\n    summary: Starter "
        "went from $10 to $12 and a team plan was added.\n    rating: notable\n",
        "web.yaml": f"""version: 1
findings:
  - competitor_id: {cid}
    kind: review
    title: "Review: setup takes too long"
    summary: A review site rates onboarding poorly.
    excerpt: "took our team two weeks to set up"
    ref: w-1
  - competitor_id: {cid}
    kind: news
    title: Made-up quote
    summary: Not in the result.
    excerpt: "set up in five minutes"
    ref: w-1
  - competitor_id: {cid}
    kind: news
    title: Invented ref
    summary: No such result.
    excerpt: "anything"
    ref: w-99
""",
        "positioning.yaml": f"""version: 1
suggestions:
  - field: unique_attributes
    action: add
    text: Setup in a day
    rationale: A review says Competitor A takes two weeks to set up.
    refs: [{{kind: web, id: w-1}}, {{kind: change, id: {change_id}}}]
  - field: not_a_field
    action: add
    text: Anything
    rationale: Invalid field.
    refs: []
""",
    }
    files.update(over)
    return files


async def _run_digest(client, ctx, at, files: dict[str, str], results=()) -> tuple[dict, str]:
    """A ready digest occurrence; Write the digest with Oracle; the fake run's files; the
    importer. Returns (occurrence id, run id)."""
    occ = await ready_digest(ctx, at)
    set_runtime(FakeRuntime({"digest": [Outcome(artifacts=files)]}))
    try:
        resp = await client.post(f"/v1/ritual-occurrences/{occ.id}/summary",
                                 headers=ctx.as_("approver"))  # fmt: skip
        assert resp.status_code == 201, resp.text
        run_id = resp.json()["id"]
        await record_results(ctx.tenant_id, run_id, *results)
        for _ in range(3):
            await client.post("/v1/internal/tick", headers=ctx.as_("owner"))
    finally:
        set_runtime(None)
    return occ.id, run_id


def _review_result() -> dict:
    return {"ref": "w-1", "query": "Competitor A review", "url": REVIEW,
            "host": "reviews.example", "title": "Competitor A review", "text": SNIPPET,
            "published_on": date(2026, 10, 18)}  # fmt: skip


async def test_seeded_paused_and_resumed_once(client, ctx, at, web):
    """protects=criterion 5: the first tick seeds competitive_digest paused; adding the
    first alternative resumes it once (ritual.resumed, actor oracle); after an owner
    pauses it, the next alternative does not resume it; fails_when=it is seeded active,
    not resumed, or resumed twice; no_claim=the Rituals screen."""
    await tick(ctx.tenant_id)
    ritual = await digest_ritual(ctx.tenant_id)
    assert ritual.status == "paused" and ritual.next_due_at is None
    assert (await add_competitor(client, ctx)).status_code == 201
    ritual = await digest_ritual(ctx.tenant_id)
    assert ritual.status == "active" and ritual.next_due_at is not None
    async with tenant_session(ctx.tenant_id) as db:
        (ev,) = await db.scalars(select(AuditEvent).where(AuditEvent.action == "ritual.resumed"))
        assert ev.actor == "oracle" and ev.entity_id == ritual.id
    resp = await client.post(f"/v1/rituals/{ritual.id}/pause", headers=ctx.as_("owner"))
    assert resp.status_code == 200
    assert (
        await add_competitor(client, ctx, name="Spreadsheets", kind="status_quo")
    ).status_code == 201
    assert (await digest_ritual(ctx.tenant_id)).status == "paused"


async def test_mentions_match_whole_words_of_names_and_aliases(client, ctx, at, web):
    """protects=criterion 4: a request created in the period whose body names "compa"
    (an alias, any case) is in competitor_mentions with its label; "Compact" is not; a
    request before the period is not; fails_when=substrings match, case matters, or the
    period is ignored; no_claim=person-owned source items (never scanned here)."""
    await _setup(client, ctx, at, web)
    async with tenant_session(ctx.tenant_id) as db:
        db.add_all([
            ProductRequest(title="Bulk export", body="The team says compa has it already.",
                           channel="sales", origin="person", created_at=START + timedelta(days=2)),
            ProductRequest(title="Compact view", body="Denser tables", channel="sales",
                           origin="person", created_at=START + timedelta(days=3)),
            ProductRequest(title="Old ask", body="CompA has it", channel="sales",
                           origin="person", created_at=START - timedelta(days=60)),
        ])  # fmt: skip
        await db.commit()
    occ = await ready_digest(ctx, at)
    blocks = {b["key"]: b for b in occ.pre_read["blocks"]}
    assert list(blocks) == ["competitor_changes", "competitor_web", "competitor_mentions",
                            "watch_problems"]  # fmt: skip
    rows = blocks["competitor_mentions"]["rows"]
    assert [r["text"].split(" · ")[0] for r in rows] == ["Bulk export"]
    assert rows[0]["label"] == "Asked for because an alternative has it?"
    (change,) = blocks["competitor_changes"]["rows"]
    assert change["href"].startswith("/company/market?alternative=")
    assert "Pricing" in change["text"] and "+3 −1" in change["text"]
    assert "Web search is not set up" in [r["text"] for r in blocks["watch_problems"]["rows"]]


async def test_the_digest_run_costs_7_and_holds_no_write_scope(client, ctx, at, web):
    """protects=criterion 7: Write the digest creates one competitive_digest run at
    $7.00 (researcher at standard, writer at quick); Company › Rituals' monthly estimate
    counts the digest at $7.00; the segment's token holds read:sources, read:baseline and
    read:web and no write scope; the writer's prompt says quick and lists no web tool;
    fails_when=another estimate, a second run, or a write scope; no_claim=SwarmCloud's
    real billing."""
    from oracle.runs import flows

    cid, change_id = await _setup(client, ctx, at, web)
    occ_id, run_id = await _run_digest(client, ctx, at, _files(cid, change_id))
    async with tenant_session(ctx.tenant_id) as db:
        run = await db.get(Run, run_id)
        assert run.flow == "competitive_digest" and float(run.estimate_usd) == 7.0
        assert len(list(await db.scalars(select(Run).where(Run.flow == "competitive_digest")))) == 1
        scopes = {s for t in await db.scalars(select(RunToken).where(RunToken.run_id == run.id))
                  for s in t.scopes}  # fmt: skip
    assert scopes == {"read:sources", "read:baseline", "read:web"}
    flow = flows.FLOWS["competitive_digest"]
    (seg,) = flow.segments
    pctx = flows.PromptContext(run_id="r-1", document=None, snapshot_as_of=None,
                               low_confidence=0.5)  # fmt: skip
    writer = flows.step_prompt(flow, seg, "writer", last=True, ctx=pctx)
    researcher = flows.step_prompt(flow, seg, "researcher", last=False, ctx=pctx)
    assert flows.DEPTH_GUIDANCE["quick"] in writer and "- search_web:" not in writer
    assert flows.DEPTH_GUIDANCE["standard"] in researcher and "- search_web:" in researcher
    await only(client, ctx, "competitive_digest")
    got = (await client.get("/v1/rituals/summaries", headers=ctx.as_("viewer"))).json()
    (row,) = got["estimate"]["rituals"]
    assert row["per_run_usd"] == 7.0 and got["estimate"]["usd_per_month"] == 7.0


async def test_the_import_checks_every_finding(client, ctx, at, web):
    """protects=criterion 8: the run's files set the summary, rate and summarise the
    listed change, create a finding only for the entry whose ref the run's tools returned
    and whose excerpt is in that result (the invented ref and the made-up excerpt are
    dropped and counted), take the URL and host from Oracle's record, create
    suggestions for valid fields only, and drop a ref to a source item the run could not
    read; fails_when=any unchecked entry lands or a drop is not counted; no_claim=the
    model's writing."""
    cid, change_id = await _setup(client, ctx, at, web)
    async with tenant_session(ctx.tenant_id) as db:
        src = Source(owner_user_id=ctx.users["viewer"].id, kind="upload", name="Private notes")
        db.add(src)
        await db.flush()
        item = SourceItem(source_id=src.id, external_id="n-1", kind="file", title="Notes")
        db.add(item)
        await db.commit()
        private_item = item.id
    files = _files(cid, change_id)
    # An entry naming its own URL is refused (invalid_field): the URL is Oracle's record.
    files["web.yaml"] += f"""  - competitor_id: {cid}
    kind: review
    title: Same review elsewhere
    summary: Points somewhere else.
    excerpt: "took our team two weeks to set up"
    url: https://elsewhere.example/
    ref: w-1
"""
    files["positioning.yaml"] += f"""  - field: trends
    action: add
    text: Teams want faster setup
    rationale: Private notes say so.
    refs: [{{kind: source_item, id: {private_item}}}]
"""
    occ_id, run_id = await _run_digest(client, ctx, at, files, results=[_review_result()])
    occ = await occurrence(ctx.tenant_id, occ_id)
    assert occ.summary_state == "ready" and "Battlecard inputs" in occ.summary
    async with tenant_session(ctx.tenant_id) as db:
        ch = await db.get(CompetitorChange, change_id)
        assert ch.rating == "notable" and ch.rated_by == "oracle"
        assert ch.summary.startswith("Starter went from $10 to $12")
        (f,) = await db.scalars(select(CompetitorWebFinding))
        assert f.url == REVIEW and f.host == "reviews.example" and f.status == "open"
        assert f.published_on == date(2026, 10, 18) and str(f.run_id) == run_id
        sugg = list(await db.scalars(select(PositioningSuggestion)))
        notes = await _import_notes(db, run_id)
    assert sorted(s.field for s in sugg) == ["trends", "unique_attributes"]
    trends = next(s for s in sugg if s.field == "trends")
    assert trends.refs == []
    web_ref = next(s for s in sugg if s.field == "unique_attributes").refs[0]
    assert web_ref == {"kind": "web", "id": str(f.id)}
    assert "1 web.yaml: entries dropped: invalid_field (url)" in notes
    assert "1 web findings dropped: excerpt not found in the result" in notes
    assert "1 web findings dropped: ref not returned by this run's web tools" in notes
    assert "1 positioning suggestions dropped: unknown field or action" in notes
    assert "1 refs dropped: a source item the run could not read" in notes
    web_block = next(b for b in occ.pre_read["blocks"] if b["key"] == "competitor_web")
    assert web_block["rows"][0]["text"].endswith("(Not vetted · reviews.example · Oct 18)")


async def _import_notes(db, run_id) -> list[str]:
    """The run's notes: the digest segment's import result."""
    (seg,) = await db.scalars(select(RunSegment).where(RunSegment.run_id == run_id))
    return seg.artifacts["import"]["notes"]


async def test_at_draft_findings_but_no_suggestions_at_observe_no_run(client, ctx, at, web):
    """protects=criterion 11: with market at Draft the importer creates findings and no
    positioning suggestions; at Observe the route is 409 "Oracle does not write the
    digest at Observe" and no run starts; fails_when=Draft makes suggestions or Observe
    starts a run; no_claim=the Settings screen."""
    cid, change_id = await _setup(client, ctx, at, web)
    await _set_market(client, ctx, "observe")
    occ = await ready_digest(ctx, at)
    resp = await client.post(f"/v1/ritual-occurrences/{occ.id}/summary",
                             headers=ctx.as_("approver"))  # fmt: skip
    assert resp.status_code == 409
    assert resp.json()["detail"] == "Oracle does not write the digest at Observe"
    async with tenant_session(ctx.tenant_id) as db:
        assert list(await db.scalars(select(Run).where(Run.flow == "competitive_digest"))) == []
    await _set_market(client, ctx, "draft")
    set_runtime(FakeRuntime({"digest": [Outcome(artifacts=_files(cid, change_id))]}))
    try:
        resp = await client.post(f"/v1/ritual-occurrences/{occ.id}/summary",
                                 headers=ctx.as_("approver"))  # fmt: skip
        assert resp.status_code == 201, resp.text
        await record_results(ctx.tenant_id, resp.json()["id"], _review_result())
        for _ in range(3):
            await client.post("/v1/internal/tick", headers=ctx.as_("owner"))
    finally:
        set_runtime(None)
    async with tenant_session(ctx.tenant_id) as db:
        assert len(list(await db.scalars(select(CompetitorWebFinding)))) == 1
        assert list(await db.scalars(select(PositioningSuggestion))) == []


async def test_accepting_a_suggestion_and_a_removed_item_stays_removed(client, ctx, at, web):
    """protects=criterion 12: accepting an add suggestion appends the item, audits
    positioning.changed with the suggestion and the person, and leaves it accepted;
    after a person removes that item, importing the same text again with no newer ref
    creates nothing; fails_when=the item is not added, no audit, or the removed item is
    suggested again; no_claim=the inline editor."""
    cid, change_id = await _setup(client, ctx, at, web)
    only_add = f"""version: 1
suggestions:
  - field: unique_attributes
    action: add
    text: Setup in a day
    rationale: The pricing change makes setup cost the difference.
    refs: [{{kind: change, id: {change_id}}}]
"""
    occ_id, _ = await _run_digest(
        client, ctx, at, _files(cid, change_id, **{"positioning.yaml": only_add})
    )
    got = (await client.get("/v1/positioning", headers=ctx.as_("viewer"))).json()
    (s,) = got["suggestions"]
    resp = await client.post(f"/v1/positioning-suggestions/{s['id']}/accept",
                             headers=ctx.as_("approver"))  # fmt: skip
    assert resp.status_code == 200, resp.text
    pos = resp.json()
    assert [i["text"] for i in pos["fields"]["unique_attributes"]] == ["Setup in a day"]
    assert pos["suggestions"] == []
    async with tenant_session(ctx.tenant_id) as db:
        sugg = await db.get(PositioningSuggestion, s["id"])
        assert sugg.status == "accepted" and sugg.decided_by == ctx.users["approver"].id
        (ev,) = await db.scalars(
            select(AuditEvent).where(AuditEvent.action == "positioning.changed")
        )
        assert ev.data["suggestion_id"] == s["id"]
    # A person removes it by hand.
    body = {"lock_version": pos["lock_version"], "fields": {}}
    resp = await client.put("/v1/positioning", json=body, headers=ctx.as_("approver"))
    assert resp.status_code == 200
    # Next month's digest suggests the same text on the same (older) evidence.
    at(START + timedelta(days=40))
    ritual = await digest_ritual(ctx.tenant_id)
    at(ritual.next_due_at)
    await tick(ctx.tenant_id)
    from tests.ritual_helpers import occurrences_of

    occs = await occurrences_of(ctx.tenant_id, ritual.id)
    nxt = occs[-1]
    assert nxt.id != occ_id and nxt.status == "ready"
    set_runtime(
        FakeRuntime(
            {
                "digest": [
                    Outcome(artifacts=_files(cid, change_id, **{"positioning.yaml": only_add}))
                ]
            }
        )
    )
    try:
        resp = await client.post(f"/v1/ritual-occurrences/{nxt.id}/summary",
                                 headers=ctx.as_("approver"))  # fmt: skip
        assert resp.status_code == 201, resp.text
        for _ in range(3):
            await client.post("/v1/internal/tick", headers=ctx.as_("owner"))
    finally:
        set_runtime(None)
    got = (await client.get("/v1/positioning", headers=ctx.as_("viewer"))).json()
    assert got["suggestions"] == [] and got["fields"]["unique_attributes"] == []


async def _digest_runs(tenant_id) -> int:
    async with tenant_session(tenant_id) as db:
        return len(list(await db.scalars(select(Run).where(Run.flow == "competitive_digest"))))


async def test_starts_on_its_own_at_act_within_the_cost_limit_once(client, ctx, at, web):
    """protects=the digest starts on its own when Run rituals is at Act within limits
    and $7.00 is within max_run_usd, once per occurrence, and not under a $5 limit (the
    default, Draft and On demand, starts none: the other tests count one run, their
    own); fails_when=it starts over the limit or twice; no_claim=the Every pre-read path
    (the same start, by mode)."""
    cid, change_id = await _setup(client, ctx, at, web)
    url = "/v1/autonomy/rituals"
    body = {"level": "act", "limits": {"max_run_usd": 5}, "reason": "Try the digest"}
    resp = await client.put(url, json=body, headers=ctx.as_("owner"))
    assert resp.status_code == 200, resp.text
    set_runtime(FakeRuntime({"digest": [Outcome(artifacts=_files(cid, change_id))]}))
    try:
        await ready_digest(ctx, at)
        assert await _digest_runs(ctx.tenant_id) == 0
        ritual = await digest_ritual(ctx.tenant_id)
        body = {"level": "act", "limits": {"max_run_usd": 10}, "reason": "Within $10"}
        assert (await client.put(url, json=body, headers=ctx.as_("owner"))).status_code == 200
        at(START + timedelta(days=40))
        ritual = await digest_ritual(ctx.tenant_id)
        at(ritual.next_due_at)
        await tick(ctx.tenant_id)
        assert await _digest_runs(ctx.tenant_id) == 1
        await tick(ctx.tenant_id)
        await client.post("/v1/internal/tick", headers=ctx.as_("owner"))
        assert await _digest_runs(ctx.tenant_id) == 1
    finally:
        set_runtime(None)


async def test_at_observe_the_occurrence_does_not_offer_the_digest(client, ctx, at, web):
    """protects=the occurrence says whether Oracle writes its summary: a digest's is not
    offered at H11 market Observe (the route answers 409 there) and is from Draft up;
    other kinds are always offered; fails_when=the page offers "Write the digest with
    Oracle" at Observe; no_claim=the button itself (web/e2e/market.spec.ts)."""
    await _setup(client, ctx, at, web)
    occ = await ready_digest(ctx, at)
    url = f"/v1/ritual-occurrences/{occ.id}"
    assert (await client.get(url, headers=ctx.as_("approver"))).json()["summary_offered"] is True
    await _set_market(client, ctx, "observe")
    got = (await client.get(url, headers=ctx.as_("approver"))).json()
    assert got["summary_offered"] is False
    await _set_market(client, ctx, "draft")
    assert (await client.get(url, headers=ctx.as_("approver"))).json()["summary_offered"] is True


def test_the_digest_segment_offers_exactly_the_spec_tools():
    """protects=the digest's researcher has the spec's tools, the two web tools among
    them, and the writer the same without the web tools (plus every segment's run
    discussions, G5); fails_when=a tool the spec does not list (get_checkpoint_review)
    is offered, or the writer gets web access; no_claim=the MCP server's own scope
    checks."""
    from oracle.runs import flows

    (seg,) = flows.FLOWS["competitive_digest"].segments
    writer = {
        "list_competitors", "get_competitor", "get_positioning", "get_strategy_stack",
        "get_baseline", "list_requests", "search", "get_source_item",
        "get_ritual_occurrence_pre_read",
    }  # fmt: skip
    assert set(seg.tools) == writer | {flows.RUN_DISCUSSIONS_TOOL}
    assert set(seg.role_tools.get("researcher", ())) == {"search_web", "fetch_web_page"}
    assert "writer" not in seg.role_tools
