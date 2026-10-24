"""C1 Requests, lane 3 (triage): Oracle's request_triage run, its requests_triage.yaml
applier (suggestions only; found items kept only from the starter's own sources), the
requests Oracle found in a person's sources (private until filed; filing shares the
item in full), Classify now and the daily 07:00 Pacific run from the ticker.

Against Postgres with the FakeRuntime. Each test's card is one line: protects /
fails_when / no_claim. Synthetic placeholders only.
"""

import json
import threading
import uuid
from datetime import UTC, datetime, timedelta
from decimal import Decimal
from zoneinfo import ZoneInfo

import pytest
from sqlalchemy import select

from oracle import safe_yaml
from oracle.auth.models import User
from oracle.requests import triage
from oracle.requests.models import ProductRequest, RequestCandidate
from oracle.runs import flows
from oracle.runs.models import Checkpoint, Run
from oracle.runtokens import mint_run_token
from oracle.sources.models import SourceItem
from oracle.swarm import Outcome
from oracle.tenancy import tenant_session
from oracle.tenant_settings import TenantSetting
from tests.baseline_helpers import Ctx, entity, make_ctx, make_item
from tests.launch_helpers import ticker_pass
from tests.test_mcp import mcp_client, text_of
from tests.test_requests import add, audits, get, goal, suggest
from tests.test_roadmap import runtime, tick  # noqa: F401 - fixtures

PACIFIC = ZoneInfo("America/Los_Angeles")


@pytest.fixture
async def ctx() -> Ctx:
    return await make_ctx()


def triage_file(requests: list[dict] | None = None, found: list[dict] | None = None) -> str:
    """A requests_triage.yaml as the triage agent writes it (JSON is YAML too)."""
    return json.dumps({"version": 1, "requests": requests or [], "found": found or []})


async def triage_run(ctx: Ctx, who: str | None = "approver") -> Run:
    async with tenant_session(ctx.tenant_id) as s:
        run = Run(
            flow="request_triage",
            status="running",
            created_by=ctx.users[who].id if who else None,
        )
        s.add(run)
        await s.commit()
        await s.refresh(run)
        return run


async def apply(ctx: Ctx, run: Run, text: str) -> dict:
    async with tenant_session(ctx.tenant_id) as s:
        fresh = await s.get(Run, run.id)
        result = await triage.apply(s, fresh, text)
        await s.commit()
        return result


async def candidates(ctx: Ctx) -> list[RequestCandidate]:
    async with tenant_session(ctx.tenant_id) as s:
        return list(await s.scalars(select(RequestCandidate)))


async def finish(client, ctx: Ctx, run_id: str) -> dict:
    auth = ctx.as_("owner")
    for _ in range(4):
        await tick(client, auth)
        run = (await client.get(f"/v1/runs/{run_id}", headers=auth)).json()
        if run["status"] in ("succeeded", "failed"):
            return run
    raise AssertionError(run)


# --- the flow (unit) ---------------------------------------------------------------------


def test_the_flow():
    """protects=the request_triage flow: one analyst segment `triage` at quick depth
    ($1.50), READ scopes, requests_triage.yaml, its checkpoint off by default, its six
    tools (get_checkpoint_review as every segment), not in the New run dialog, started
    from /requests; fails_when=any drifts; no_claim=the agent's classification quality."""
    flow = flows.FLOWS["request_triage"]
    assert flow.title == "Request triage"
    (segment,) = flow.segments
    assert (segment.name, segment.title) == ("triage", "Request triage")
    assert segment.roles == ("analyst",)
    assert segment.scopes == ("read:sources", "read:baseline")
    assert segment.outputs == ("requests_triage.yaml",)
    assert segment.checkpoint == "request_triage"
    assert segment.tools == (
        "search", "get_source_item", "get_baseline", "list_requests", "list_request_themes",
        "get_checkpoint_review", "get_run_discussions",
    )  # fmt: skip
    assert all(t in flows.MCP_TOOLS for t in segment.tools)
    assert flow.default_checkpoints == {"request_triage": False}
    assert flow.default_depth == "quick"
    assert flow.in_new_run_dialog is False
    assert flow.starts_from == ("Request triage", "/requests")
    assert flow.writes_document is False and flow.target_kind is None
    knobs = flows.resolve_knobs(flow, {})
    assert knobs.depth == "quick" and knobs.checkpoints == {"request_triage": False}
    assert flows.segment_estimate(segment, knobs) == Decimal("1.50")
    # A person may still turn the stop on.
    on = flows.resolve_knobs(flow, {"checkpoints": {"request_triage": True}})
    assert on.checkpoints == {"request_triage": True}


def test_the_task_never_decides():
    """protects=the task text: classify New requests (theme, goals, duplicate, feature,
    confidence, rationale), new themes only when none fits, found items from the
    starter's sources, never decide; fails_when=the prompt omits a field or the rule;
    no_claim=the agent obeying it."""
    flow = flows.FLOWS["request_triage"]
    segment = flow.segments[0]
    ctx = flows.PromptContext(
        run_id="r1", document=None, snapshot_as_of=None, low_confidence=0.4, depth="quick",
        extra_lines=["Look through your own source items added since 2026-09-21."],
    )  # fmt: skip
    text = flows.step_prompt(flow, segment, "analyst", last=True, ctx=ctx)
    for words in (
        "state New", "theme", "goals", "duplicate_of", "feature", "confidence", "rationale",
        "found", "never decide", "requests_triage.yaml", "list_requests", "since 2026-09-21",
    ):  # fmt: skip
        assert words in text, words


def test_parse_triage_file():
    """protects=the file's reader (oracle.safe_yaml, at most 1 MB, version 1, lists);
    fails_when=a malformed or oversized file is read as empty; no_claim=what the applier
    keeps (test_triage_apply)."""
    data = triage.parse(triage_file([{"id": str(uuid.uuid4()), "confidence": 0.5}]))
    assert len(data["requests"]) == 1 and data["found"] == []
    assert triage.parse("version: 1\n") == {"requests": [], "found": []}
    for bad in (
        "requests: [unclosed",
        "version: 2\nrequests: []\n",
        "- just a list\n",
        "version: 1\nrequests: {a: 1}\n",
        "version: 1\nrequests: []\nx: '" + "a" * 1_000_001 + "'\n",
    ):
        with pytest.raises(triage.TriageFileError):
            triage.parse(bad)


async def test_the_file_is_parsed_on_the_parse_pool(client, ctx, monkeypatch):
    """protects=the event loop: the triage file is parsed on the parse pool
    (safe_yaml.run_parse_within), as other run imports are; fails_when=apply parses it on
    the loop; no_claim=the pool's own limits (test_safe_yaml)."""
    threads: list[str] = []
    calls: list[str] = []
    load, within = safe_yaml.load, safe_yaml.run_parse_within

    def spy_load(*a, **kw):
        threads.append(threading.current_thread().name)
        return load(*a, **kw)

    async def spy_within(fn, /, *a, name="the text", **kw):
        calls.append(name)
        return await within(fn, *a, name=name, **kw)

    monkeypatch.setattr(safe_yaml, "load", spy_load)
    monkeypatch.setattr(safe_yaml, "run_parse_within", spy_within)
    run = await triage_run(ctx)
    assert (await apply(ctx, run, triage_file()))["notes"] == []
    assert calls == ["requests_triage.yaml"]
    assert threads and all(t.startswith("safe-yaml") for t in threads)


def test_daily_moment():
    """protects=C1 "Triage runs": the day's moment is 07:00 America/Los_Angeles, daylight
    saving included; fails_when=it is UTC or a fixed offset; no_claim=the ticker."""
    summer = datetime(2026, 7, 1, 15, 0, tzinfo=UTC)  # 08:00 PDT
    assert triage.daily_moment(summer) == datetime(2026, 7, 1, 7, 0, tzinfo=PACIFIC)
    winter = datetime(2026, 12, 1, 14, 30, tzinfo=UTC)  # 06:30 PST: before today's moment
    assert triage.daily_moment(winter) is None
    assert triage.daily_moment(datetime(2026, 12, 1, 15, 0, tzinfo=UTC)) == datetime(
        2026, 12, 1, 7, 0, tzinfo=PACIFIC
    )


# --- the applier ---------------------------------------------------------------------------


async def test_triage_apply(client, ctx):
    """protects=Oracle never decides (criterion 10): one valid entry becomes a suggestion,
    an unknown request id and a found item from another person's source are dropped and
    counted; fails_when=the applier changes state or keeps foreign items; no_claim=the
    agent's classification quality (fake runtime)."""
    g = await goal(client, ctx)
    feature = await entity(client, ctx, type="feature", key="saved-addresses")
    theme = (
        await client.post(
            "/v1/request-themes", json={"title": "Faster check-out", "goal_ids": [g["id"]]},
            headers=ctx.as_("approver"),
        )
    ).json()  # fmt: skip
    a = await add(client, ctx, title="Keep my address")
    b = await add(client, ctx, title="Remember the address")
    theirs = await make_item(ctx, "commenter")
    run = await triage_run(ctx)
    text = triage_file(
        [
            {"id": a["id"], "theme": {"id": theme["id"]}, "goals": ["activation"],
             "duplicate_of": b["id"], "feature": "saved-addresses", "confidence": 0.72,
             "rationale": "Same need: retyping the address"},
            {"id": str(uuid.uuid4()), "goals": ["activation"], "confidence": 0.5},
        ],
        [{"source_item_id": str(theirs), "title": "Keep my address", "channel": "support"}],
    )  # fmt: skip
    result = await apply(ctx, run, text)
    assert result["suggestions"] == 1 and result["found"] == 0
    assert result["notes"] == [
        "1 entry dropped (unknown request)",
        "1 found item dropped (not your source)",
    ]
    assert await candidates(ctx) == []
    got = await get(client, ctx, a["id"])
    assert got["state"] == "new" and got["goal_ids"] == [] and got["theme"] is None
    s = got["suggestion"]
    assert s["theme_id"] == theme["id"] and s["theme_title"] == "Faster check-out"
    assert s["goal_ids"] == [g["id"]] and s["duplicate_of"] == b["id"]
    assert s["feature_id"] == feature["id"] and s["confidence"] == 0.72
    assert s["rationale"] == "Same need: retyping the address"
    assert s["run_id"] == str(run.id) and s["at"]
    other = await get(client, ctx, b["id"])
    assert other["suggestion"] is None and other["state"] == "new"


async def test_triage_apply_drops_what_it_cannot_use(client, ctx):
    """protects=the applier's drops: a non-New request, unknown goal and feature keys, an
    unknown theme id and duplicate, each counted; a new theme title is kept as a title;
    fails_when=a decided request gets a suggestion or an unknown key is stored;
    no_claim=the screen showing it."""
    g = await goal(client, ctx)
    decided = await add(client, ctx, title="Already decided", goal_ids=[g["id"]])
    resp = await client.post(
        f"/v1/requests/{decided['id']}/qualify", json={"lock_version": 1},
        headers=ctx.as_("approver"),
    )  # fmt: skip
    assert resp.status_code == 200, resp.text
    fresh = await add(client, ctx, title="Bulk edit prices")
    run = await triage_run(ctx)
    text = triage_file(
        [
            {"id": decided["id"], "goals": ["activation"]},
            {"id": fresh["id"], "theme": {"title": "Catalogue tools"},
             "goals": ["activation", "no-such-goal"], "feature": "no-such-feature",
             "duplicate_of": str(uuid.uuid4()), "confidence": 3, "rationale": "x" * 900},
        ]
    )  # fmt: skip
    result = await apply(ctx, run, text)
    assert result["suggestions"] == 1
    assert result["notes"] == [
        "1 entry dropped (not New)",
        "1 goal key dropped (not a confirmed goal)",
        "1 feature key dropped (not a baseline feature)",
        "1 duplicate dropped (unknown request)",
    ]
    s = (await get(client, ctx, fresh["id"]))["suggestion"]
    assert s["theme_id"] is None and s["theme_title"] == "Catalogue tools"
    assert s["goal_ids"] == [g["id"]] and s["feature_id"] is None and s["duplicate_of"] is None
    assert s["confidence"] == 1.0 and len(s["rationale"]) <= 300
    assert (await get(client, ctx, decided["id"]))["suggestion"] is None


async def test_found_items_from_the_starters_own_sources(client, ctx):
    """protects=behaviour rule 9's first half: a found item from the starter's own source
    becomes their candidate; an item they dismissed or filed is skipped; a run with no
    starter (the daily run) keeps none; fails_when=a candidate is made for an item the
    starter cannot read, twice for one item, or by the daily run; no_claim=filing
    (test_filing_shares_in_full)."""
    mine = await make_item(ctx, "approver", title="#support thread", content="Keep my address")
    second = await make_item(ctx, "approver", title="#sales notes")
    found = [
        {"source_item_id": str(mine), "title": "Keep my address between orders",
         "body": "Asked twice", "requester": "A customer", "channel": "support",
         "theme": {"title": "Faster check-out"}, "goals": ["activation"], "confidence": 0.6,
         "rationale": "A request, not a bug report"},
        {"source_item_id": str(second), "title": "Pick a delivery slot", "channel": "phone"},
    ]  # fmt: skip
    g = await goal(client, ctx)
    run = await triage_run(ctx)
    result = await apply(ctx, run, triage_file(found=found))
    assert result["found"] == 2 and result["notes"] == []
    rows = sorted(await candidates(ctx), key=lambda c: c.title)
    assert [c.title for c in rows] == ["Keep my address between orders", "Pick a delivery slot"]
    first = rows[0]
    assert first.owner_user_id == ctx.users["approver"].id and first.run_id == run.id
    assert first.requester_name == "A customer" and first.channel == "support"
    assert first.theme_title == "Faster check-out" and first.goal_ids == [uuid.UUID(g["id"])]
    assert first.status == "open"
    # An unknown channel reads as Other.
    assert rows[1].channel == "other"

    async with tenant_session(ctx.tenant_id) as s:
        row = await s.get(RequestCandidate, rows[1].id)
        row.status = "dismissed"
        await s.commit()
    again = await triage_run(ctx)
    result = await apply(ctx, again, triage_file(found=found))
    assert result["found"] == 1 and result["notes"] == [
        "1 found item skipped (already filed or dismissed)"
    ]
    assert len(await candidates(ctx)) == 2

    daily = await triage_run(ctx, who=None)
    result = await apply(ctx, daily, triage_file(found=found))
    assert result["found"] == 0
    assert result["notes"] == ["2 found items dropped (not your source)"]


async def test_unparsable_file_fails_the_run(client, ctx, runtime):  # noqa: F811
    """protects=a file that does not parse fails the segment with "requests_triage.yaml
    could not be read"; fails_when=the run succeeds or writes anything; no_claim=other
    flows' files."""
    r = await add(client, ctx)
    runtime.script["triage"] = [Outcome(artifacts={"requests_triage.yaml": "requests: [oops"})]
    resp = await client.post("/v1/requests/triage", json={}, headers=ctx.as_("approver"))
    assert resp.status_code == 201, resp.text
    run = await finish(client, ctx, resp.json()["id"])
    assert run["status"] == "failed"
    assert run["error"] == "requests_triage.yaml could not be read"
    assert (await get(client, ctx, r["id"]))["suggestion"] is None


# --- Classify now ------------------------------------------------------------------------


async def test_classify_now_end_to_end(client, ctx, runtime):  # noqa: F811
    """protects=Classify now (approver+) → a quick request_triage run → the file applied
    → suggestions on the request and a found item for the starter; the checkpoint is
    skipped and the run succeeds with no one deciding (criterion 11); the header's
    status; fails_when=a commenter starts one, the run waits for a person, or the
    suggestion is missing; no_claim=SwarmCloud's real agents."""
    await goal(client, ctx)
    r = await add(client, ctx)
    mine = await make_item(ctx, "approver", title="#support thread")
    assert (
        await client.post("/v1/requests/triage", json={}, headers=ctx.as_("commenter"))
    ).status_code == 403
    runtime.script["triage"] = [
        Outcome(
            artifacts={
                "requests_triage.yaml": triage_file(
                    [
                        {
                            "id": r["id"],
                            "goals": ["activation"],
                            "confidence": 0.8,
                            "rationale": "Checkout speed",
                        }
                    ],
                    [
                        {
                            "source_item_id": str(mine),
                            "title": "Reorder last week's basket",
                            "channel": "support",
                        }
                    ],
                )  # fmt: skip
            }
        )
    ]
    resp = await client.post("/v1/requests/triage", json={}, headers=ctx.as_("approver"))
    assert resp.status_code == 201, resp.text
    started = resp.json()
    assert started["flow"] == "request_triage" and started["estimate_usd"] == 1.5
    assert started["knobs"]["depth"] == "quick"
    assert started["knobs"]["checkpoints"] == {"request_triage": False}
    [event] = await audits(ctx, "request.triage_started")
    assert event.data["automatic"] is False and event.data["run_id"] == started["id"]

    status = (await client.get("/v1/requests/triage", headers=ctx.as_("viewer"))).json()
    assert status["run_id"] == started["id"] and status["active"] is True

    run = await finish(client, ctx, started["id"])
    assert run["status"] == "succeeded", run
    async with tenant_session(ctx.tenant_id) as s:
        [cp] = list(await s.scalars(select(Checkpoint).where(Checkpoint.run_id == run["id"])))
        assert cp.kind == "request_triage" and cp.status == "skipped"
        assert cp.payload["triage_import"]["suggestions"] == 1
    s = (await get(client, ctx, r["id"]))["suggestion"]
    assert s["goal_ids"] and s["run_id"] == run["id"]
    status = (await client.get("/v1/requests/triage", headers=ctx.as_("approver"))).json()
    assert status["active"] is False and status["status"] == "succeeded"
    assert status["suggestions"] == 1 and status["found"] == 1
    # The found count is the caller's own.
    other = (await client.get("/v1/requests/triage", headers=ctx.as_("viewer"))).json()
    assert other["found"] == 0 and other["suggestions"] == 1


async def test_a_triage_run_starts_only_from_requests(client, ctx):
    """protects=the flow's one door (POST /v1/requests/triage); fails_when=POST /v1/runs
    creates a request_triage run; no_claim=the New run dialog's list."""
    resp = await client.post("/v1/runs", json={"flow": "request_triage"}, headers=ctx.as_("owner"))
    assert resp.status_code == 422, resp.text
    assert "/v1/requests/triage" in resp.json()["detail"]


async def test_the_prompt_says_since_when(client, ctx, runtime):  # noqa: F811
    """protects=the task's `since`: the starter's last triage, else 30 days; the daily run
    is told it reads no one's sources; fails_when=the date is missing or another person's
    run counts; no_claim=the agent honouring it."""
    resp = await client.post("/v1/requests/triage", json={}, headers=ctx.as_("approver"))
    first = await finish(client, ctx, resp.json()["id"])
    prompt = runtime.submitted[-1].steps[0].prompt
    since = (datetime.now(UTC) - timedelta(days=30)).date().isoformat()
    assert f"since {since}" in prompt
    resp = await client.post("/v1/requests/triage", json={}, headers=ctx.as_("approver"))
    await finish(client, ctx, resp.json()["id"])
    prompt = runtime.submitted[-1].steps[0].prompt
    async with tenant_session(ctx.tenant_id) as s:
        created = (await s.get(Run, uuid.UUID(first["id"]))).created_at
    assert f"since {created.date().isoformat()}" in prompt


# --- found items: private until filed --------------------------------------------------


async def found_for(
    ctx: Ctx, who: str, content: str = "Keep my address between orders"
) -> RequestCandidate:
    item = await make_item(ctx, who, title="#support thread", content=content)
    run = await triage_run(ctx, who)
    await apply(
        ctx, run,
        triage_file(found=[{"source_item_id": str(item), "title": "Keep my address",
                            "body": "Asked twice", "channel": "support"}]),
    )  # fmt: skip
    async with tenant_session(ctx.tenant_id) as s:
        return await s.scalar(
            select(RequestCandidate).where(RequestCandidate.source_item_id == item)
        )


async def test_candidates_private(client, ctx):
    """protects=decision S6 Private findings sharing for found requests (criterion 9);
    fails_when=another member or a run token can read or file a candidate;
    no_claim=what filing shows others (covered by test_filing_shares_in_full)."""
    mine = await found_for(ctx, "approver")
    theirs = await found_for(ctx, "owner")
    listed = await client.get("/v1/request-candidates?status=open", headers=ctx.as_("approver"))
    assert listed.status_code == 200
    assert [c["id"] for c in listed.json()] == [str(mine.id)]
    c = listed.json()[0]
    assert c["source"]["title"] == "#support thread" and c["status"] == "open"
    assert (
        await client.get("/v1/request-candidates", headers=ctx.as_("viewer"))
    ).status_code == 403
    for verb in ("file", "dismiss"):
        resp = await client.post(
            f"/v1/request-candidates/{theirs.id}/{verb}", json={}, headers=ctx.as_("approver")
        )
        assert resp.status_code == 404, resp.text

    from oracle.swarm import FakeRuntime, set_runtime

    set_runtime(FakeRuntime())
    try:
        async with tenant_session(ctx.tenant_id) as s:
            run = await s.get(Run, mine.run_id)
            raw = await mint_run_token(s, run.id, ["read:sources", "read:baseline"], 600)
            await s.commit()
        async with mcp_client(raw) as m:
            names = {t.name for t in (await m.list_tools()).tools}
            assert "list_request_candidates" not in names
            refused = await m.call_tool("list_request_candidates", {})
            assert refused.is_error, text_of(refused)
    finally:
        set_runtime(None)


async def test_filing_shares_in_full(client, ctx):
    """protects=C1 "Found items" (criterion 19a: others see the text, the item's title,
    link and 400-character excerpt, nothing more); fails_when=a field is missing, the
    excerpt is longer, or more of the source becomes readable; no_claim=the source
    tool's own access to the link."""
    content = "Could I reorder what I bought last week in one click? " * 20
    cand = await found_for(ctx, "approver", content)
    resp = await client.post(
        f"/v1/request-candidates/{cand.id}/file",
        json={"title": "Reorder last week's basket", "requester_kind": "customer"},
        headers=ctx.as_("approver"),
    )
    assert resp.status_code == 201, resp.text
    filed = resp.json()
    assert filed["title"] == "Reorder last week's basket" and filed["body"] == "Asked twice"
    assert filed["channel"] == "support" and filed["requester_kind"] == "customer"
    src = filed["source"]
    assert src["item_id"] == str(cand.source_item_id)
    assert src["title"] == "#support thread" and src["kind"] == "slack"
    assert src["url"] == "https://chat.example.com/archives/C1/p1"
    assert 0 < len(src["excerpt"]) <= 400 and content.startswith(src["excerpt"][:-1])
    [event] = await audits(ctx, "request_candidate.filed")
    assert event.data["shared"] == "full"
    assert event.data["source_item_id"] == str(cand.source_item_id)
    assert event.data["request_id"] == filed["id"]

    seen = await get(client, ctx, filed["id"], who="viewer")
    assert seen["source"] == src
    item = await client.get(f"/v1/source-items/{cand.source_item_id}", headers=ctx.as_("viewer"))
    assert item.status_code == 404
    left = (
        await client.get("/v1/request-candidates?status=open", headers=ctx.as_("approver"))
    ).json()
    assert left == []
    again = await client.post(
        f"/v1/request-candidates/{cand.id}/file", json={}, headers=ctx.as_("approver")
    )
    assert again.status_code == 409

    async with tenant_session(ctx.tenant_id) as s:
        row = await s.get(SourceItem, cand.source_item_id)
        row.deleted_at = datetime.now(UTC)
        await s.commit()
    gone = (await get(client, ctx, filed["id"], who="viewer"))["source"]
    assert gone["removed"] is True and gone["excerpt"] == src["excerpt"]
    assert gone["title"] == "#support thread"


async def test_dismiss_and_defaults(client, ctx):
    """protects=Dismiss (audited, then neither listed nor fileable) and filing with no
    overrides (the found item's words, Unknown asker kind, its confirmed goals);
    fails_when=a dismissed item can be filed or a filing loses the found words;
    no_claim=the panel's layout."""
    g = await goal(client, ctx)
    cand = await found_for(ctx, "approver")
    resp = await client.post(
        f"/v1/request-candidates/{cand.id}/dismiss", headers=ctx.as_("approver")
    )
    assert resp.status_code == 200 and resp.json()["status"] == "dismissed"
    assert len(await audits(ctx, "request_candidate.dismissed")) == 1
    resp = await client.post(
        f"/v1/request-candidates/{cand.id}/file", json={}, headers=ctx.as_("approver")
    )
    assert resp.status_code == 409

    item = await make_item(ctx, "approver", title="#sales notes")
    run = await triage_run(ctx)
    await apply(
        ctx, run,
        triage_file(found=[{"source_item_id": str(item), "title": "Pick a delivery slot",
                            "requester": "A prospect", "channel": "sales",
                            "goals": ["activation"]}]),
    )  # fmt: skip
    [open_one] = (
        await client.get("/v1/request-candidates?status=open", headers=ctx.as_("approver"))
    ).json()
    filed = await client.post(
        f"/v1/request-candidates/{open_one['id']}/file", json={}, headers=ctx.as_("approver")
    )
    assert filed.status_code == 201, filed.text
    out = filed.json()
    assert out["title"] == "Pick a delivery slot" and out["requester_name"] == "A prospect"
    assert out["channel"] == "sales" and out["requester_kind"] == "unknown"
    assert out["goal_ids"] == [g["id"]] and out["state"] == "new"


# --- the daily run ---------------------------------------------------------------------


def frozen(monkeypatch, at: datetime) -> None:
    monkeypatch.setattr(triage, "_now", lambda: at)


async def triage_runs(ctx: Ctx) -> list[Run]:
    async with tenant_session(ctx.tenant_id) as s:
        return list(
            await s.scalars(
                select(Run).where(Run.flow == "request_triage").order_by(Run.created_at)
            )
        )


async def test_daily_triage(client, ctx, runtime, monkeypatch):  # noqa: F811
    """protects=C1 "Triage runs" (criterion 19b: one quick classify-only run a day at
    07:00 PT when a New request waits); fails_when=two runs start in a day, one starts
    with nothing to classify, or it reads anyone's sources; no_claim=SwarmCloud
    scheduling (the ticker is called directly with a frozen clock)."""
    day = datetime(2026, 10, 21, tzinfo=PACIFIC)
    await goal(client, ctx)
    r = await add(client, ctx)
    mine = await make_item(ctx, "approver")
    runtime.script["triage"] = [
        Outcome(
            artifacts={
                "requests_triage.yaml": triage_file(
                    [{"id": r["id"], "goals": ["activation"], "confidence": 0.7}],
                    [{"source_item_id": str(mine), "title": "Something", "channel": "slack"}],
                )
            }
        )
    ]
    frozen(monkeypatch, day.replace(hour=6, minute=59))
    await ticker_pass(ctx.tenant_id)
    assert await triage_runs(ctx) == []

    # Off by default: nothing runs at 07:00 until someone turns it on.
    frozen(monkeypatch, day.replace(hour=7, minute=1))
    await ticker_pass(ctx.tenant_id)
    assert await triage_runs(ctx) == []
    await switch(client, ctx, "owner", True)
    await ticker_pass(ctx.tenant_id)
    [run] = await triage_runs(ctx)
    # The owner turned it on: it runs as them.
    assert run.created_by == ctx.users["owner"].id and run.knobs["depth"] == "quick"
    assert run.knobs["triage_automatic"] is True
    assert run.estimate_usd == Decimal("1.50")
    [event] = await audits(ctx, "request.triage_started")
    assert event.data["automatic"] is True and event.actor == "oracle"
    assert event.data["as_user"] == str(ctx.users["owner"].id)
    # Its token reads the requests, the themes and the baseline, and no one's sources.
    mcp = runtime.submitted[-1].mcp
    assert "read:sources" not in mcp.scopes and "read:baseline" in mcp.scopes
    async with mcp_client(mcp.token) as m:
        listed = await m.call_tool("list_requests", {"state": "new"})
        assert not listed.is_error, text_of(listed)
        assert [x["id"] for x in listed.structured_content["items"]] == [r["id"]]
        themes = await m.call_tool("list_request_themes", {})
        assert not themes.is_error, text_of(themes)
        base = await m.call_tool("get_baseline", {})
        assert not base.is_error, text_of(base)
        assert "activation" in text_of(base)

    frozen(monkeypatch, day.replace(hour=9))
    await ticker_pass(ctx.tenant_id)
    await ticker_pass(ctx.tenant_id)
    assert len(await triage_runs(ctx)) == 1
    async with tenant_session(ctx.tenant_id) as s:
        done = await s.get(Run, run.id)
        assert done.status == "succeeded", done.error
    assert (await get(client, ctx, r["id"]))["suggestion"]["goal_ids"]
    assert await candidates(ctx) == []

    # The next day: every New request has a suggestion, so none starts.
    frozen(monkeypatch, (day + timedelta(days=1)).replace(hour=7, minute=30))
    await ticker_pass(ctx.tenant_id)
    assert len(await triage_runs(ctx)) == 1

    # A person's Classify now does not use up the day's automatic run.
    await add(client, ctx, title="Dark mode")
    later = await client.post("/v1/requests/triage", json={}, headers=ctx.as_("approver"))
    assert later.status_code == 201
    frozen(monkeypatch, (day + timedelta(days=2)).replace(hour=7, minute=5))
    await ticker_pass(ctx.tenant_id)
    runs = await triage_runs(ctx)
    assert [bool(x.knobs.get("triage_automatic")) for x in runs] == [True, False, True]


async def users_disabled(ctx: Ctx, *who: str) -> None:
    async with tenant_session(ctx.tenant_id) as s:
        for name in who:
            (await s.get(User, ctx.users[name].id)).disabled_at = datetime.now(UTC)
        await s.commit()


async def switch(client, ctx: Ctx, who: str, on: bool, **headers: str) -> dict:
    """``who`` turns "Daily triage at 07:00 PT" on or off on the Requests page."""
    resp = await client.put(
        "/v1/requests/triage/daily", json={"on": on}, headers={**ctx.as_(who), **headers}
    )
    assert resp.status_code == 200, resp.text
    return resp.json()


async def triage_status(client, ctx: Ctx, who: str = "viewer") -> dict:
    resp = await client.get("/v1/requests/triage", headers=ctx.as_(who))
    assert resp.status_code == 200, resp.text
    return resp.json()


async def turned_on_by(ctx: Ctx, who: str) -> None:
    """The daily triage, turned on by ``who`` (the setting it records), written directly:
    for an enabler whose role or account changed since."""
    async with tenant_session(ctx.tenant_id) as s:
        row = await s.scalar(select(TenantSetting).where(TenantSetting.key == triage.DAILY_SETTING))
        if row is None:
            row = TenantSetting(key=triage.DAILY_SETTING, value={"on": True})
            s.add(row)
        row.value, row.updated_by = {"on": True}, ctx.users[who].id
        await s.commit()


async def test_daily_triage_runs_as_its_enabler_else_an_owner(client, ctx, runtime, monkeypatch):  # noqa: F811
    """protects=the scheduled run acts as a real active member: the one who turned the
    daily triage on, else the longest-standing active owner; fails_when=it runs with no
    member (its token is refused), as a disabled enabler, or as a newer owner;
    no_claim=SwarmCloud scheduling."""
    day = datetime(2026, 10, 21, tzinfo=PACIFIC)
    await add(client, ctx)
    await turned_on_by(ctx, "approver")
    async with tenant_session(ctx.tenant_id) as s:
        newer = User(
            email="second-owner@example.com", password_hash="x", role="owner",
            created_at=datetime.now(UTC) + timedelta(days=1),
        )  # fmt: skip
        s.add(newer)
        await s.commit()
    frozen(monkeypatch, day.replace(hour=7, minute=5))
    await ticker_pass(ctx.tenant_id)
    [run] = await triage_runs(ctx)
    assert run.created_by == ctx.users["approver"].id

    # The enabler is disabled: the next day's run is the longest-standing owner's.
    await finish(client, ctx, str(run.id))
    await add(client, ctx, title="Dark mode")
    await users_disabled(ctx, "approver")
    frozen(monkeypatch, (day + timedelta(days=1)).replace(hour=7, minute=5))
    await ticker_pass(ctx.tenant_id)
    runs = await triage_runs(ctx)
    assert len(runs) == 2 and runs[-1].created_by == ctx.users["owner"].id


async def test_daily_triage_with_no_eligible_member_starts_none(client, ctx, runtime, monkeypatch):  # noqa: F811
    """protects=no run without a member to act as, and the reason shown where the triage
    status is; fails_when=a run starts with no creator, nothing says why, or each tick
    records it again; no_claim=the web status line (mock e2e)."""
    day = datetime(2026, 10, 21, tzinfo=PACIFIC)
    await add(client, ctx)
    # The enabler is a commenter now (below what the run needs) and the only owner is gone.
    await turned_on_by(ctx, "commenter")
    await users_disabled(ctx, "owner")
    frozen(monkeypatch, day.replace(hour=7, minute=5))
    await ticker_pass(ctx.tenant_id)
    await ticker_pass(ctx.tenant_id)
    assert await triage_runs(ctx) == []
    [event] = await audits(ctx, "request.triage_skipped")
    assert event.actor == "oracle" and event.data["day"] == "2026-10-21"
    status = (await client.get("/v1/requests/triage", headers=ctx.as_("viewer"))).json()
    assert status["run_id"] is None
    assert status["daily_skipped"] == triage.NO_MEMBER.format(day="2026-10-21")


async def test_daily_triage_is_off_by_default(client, ctx, runtime, monkeypatch):  # noqa: F811
    """protects=owner decision 2026-10-21 (daily triage has an on/off switch, off by
    default; nothing runs and nothing is spent while off); fails_when=a company that never
    turned it on (or turned it off) gets a run, a skip record, or a status that does not
    say it is off; no_claim=SwarmCloud scheduling."""
    day = datetime(2026, 10, 21, tzinfo=PACIFIC)
    await add(client, ctx)
    status = await triage_status(client, ctx)
    assert status["daily_on"] is False and status["daily_as"] is None
    frozen(monkeypatch, day.replace(hour=7, minute=5))
    await ticker_pass(ctx.tenant_id)
    assert await triage_runs(ctx) == []
    assert await audits(ctx, "request.triage_skipped") == []
    assert runtime.submitted == []

    # On, then off again before 07:00 the next day: still nothing.
    await switch(client, ctx, "approver", True)
    off = await switch(client, ctx, "owner", False)
    assert off["daily_on"] is False and off["daily_as"] is None
    frozen(monkeypatch, (day + timedelta(days=1)).replace(hour=7, minute=5))
    await ticker_pass(ctx.tenant_id)
    assert await triage_runs(ctx) == []
    async with tenant_session(ctx.tenant_id) as s:
        row = await s.scalar(select(TenantSetting).where(TenantSetting.key == triage.DAILY_SETTING))
        assert row.value == {"on": False} and row.updated_by == ctx.users["owner"].id
    # Off hides an earlier day's skip reason: the status says it is off instead.
    await turned_on_by(ctx, "commenter")
    await users_disabled(ctx, "owner")
    frozen(monkeypatch, (day + timedelta(days=2)).replace(hour=7, minute=5))
    await ticker_pass(ctx.tenant_id)
    assert (await triage_status(client, ctx))["daily_skipped"]
    await switch(client, ctx, "approver", False)
    status = await triage_status(client, ctx)
    assert status["daily_on"] is False and status["daily_skipped"] is None


async def test_the_switch_records_who_and_when(client, ctx, runtime, monkeypatch):  # noqa: F811
    """protects=the switch writes the setting request_triage_daily (who set it and when, as
    other settings) and the status says who the run acts as: the enabler, else (demoted)
    the longest-standing active owner, who then runs it; fails_when=the setting does not
    record its enabler, the status names the wrong member, or the demoted enabler still
    runs it; no_claim=the web switch (mock e2e)."""
    day = datetime(2026, 10, 21, tzinfo=PACIFIC)
    await add(client, ctx)
    on = await switch(client, ctx, "approver", True)
    assert on["daily_on"] is True and on["daily_as"] == "Approver"
    assert on["daily_changed_by"] == "Approver" and on["daily_changed_at"]
    viewer = await triage_status(client, ctx, "viewer")
    assert viewer["daily_on"] is True and viewer["daily_as"] == "Approver"
    async with tenant_session(ctx.tenant_id) as s:
        row = await s.scalar(select(TenantSetting).where(TenantSetting.key == triage.DAILY_SETTING))
        assert row.value == {"on": True} and row.updated_by == ctx.users["approver"].id
        assert row.updated_at is not None
    [event] = [
        e for e in await audits(ctx, "setting.update") if e.data["key"] == triage.DAILY_SETTING
    ]
    assert event.actor == f"user:{ctx.users['approver'].id}" and event.data["value"] == {"on": True}

    frozen(monkeypatch, day.replace(hour=7, minute=5))
    await ticker_pass(ctx.tenant_id)
    [run] = await triage_runs(ctx)
    assert run.created_by == ctx.users["approver"].id
    await finish(client, ctx, str(run.id))

    # The enabler is demoted to commenter: the status and the next run name the oldest owner.
    async with tenant_session(ctx.tenant_id) as s:
        (await s.get(User, ctx.users["approver"].id)).role = "commenter"
        await s.commit()
    assert (await triage_status(client, ctx))["daily_as"] == "Owner"
    await add(client, ctx, title="Dark mode")
    frozen(monkeypatch, (day + timedelta(days=1)).replace(hour=7, minute=5))
    await ticker_pass(ctx.tenant_id)
    runs = await triage_runs(ctx)
    assert len(runs) == 2 and runs[-1].created_by == ctx.users["owner"].id


async def test_who_may_turn_the_switch(client, ctx):
    """protects=the switch is approver+ (commenters and viewers read its state only), never
    a run's or a read-only credential's, and refuses another site's browser request;
    fails_when=any of them changes the setting; no_claim=the web's disabled switch (mock
    e2e)."""
    from tests.coverage_helpers import read_only_mcp, run_headers

    url = "/v1/requests/triage/daily"
    for who in ("commenter", "viewer"):
        resp = await client.put(url, json={"on": True}, headers=ctx.as_(who))
        assert resp.status_code == 403, (who, resp.text)
    run = await client.put(url, json={"on": True}, headers=await run_headers(ctx, "owner"))
    assert run.status_code == 403, run.text
    ro = await client.put(url, json={"on": True}, headers=await read_only_mcp(ctx, "owner"))
    assert ro.status_code == 403, ro.text
    for cross in ({"Origin": "https://evil.example.net"}, {"Sec-Fetch-Site": "cross-site"}):
        resp = await client.put(url, json={"on": True}, headers={**ctx.as_("owner"), **cross})
        assert resp.status_code == 403, resp.text
        assert "Cross-site" in resp.json()["detail"]
    assert (await triage_status(client, ctx))["daily_on"] is False
    async with tenant_session(ctx.tenant_id) as s:
        assert (
            await s.scalar(select(TenantSetting).where(TenantSetting.key == triage.DAILY_SETTING))
        ) is None
    # The app's own origin passes.
    on = await switch(client, ctx, "owner", True, Origin="http://localhost:3000")
    assert on["daily_on"] is True and on["daily_as"] == "Owner"


async def test_daily_triage_runs_at_07_00_in_the_company_time_zone(
    client,
    ctx,
    runtime,  # noqa: F811
    monkeypatch,
):
    """protects=#519 item 4 (decision 2026-10-22: every date uses the Company time zone):
    with the Company time zone set to Asia/Tokyo, the daily run waits for 07:00 Tokyo
    (06:59 Tokyo is 14:59 the day before in Pacific, past Pacific's 07:00) and is that
    Tokyo day's run; fails_when=triage hard-codes Pacific and starts at 06:59 Tokyo with
    Pacific's day; no_claim=the switch's label (the owner kept "07:00 PT" on 2026-10-24)."""
    tokyo = ZoneInfo("Asia/Tokyo")
    resp = await client.put(
        "/v1/settings/company_timezone", json={"value": "Asia/Tokyo"}, headers=ctx.as_("owner")
    )
    assert resp.status_code == 200, resp.text
    await add(client, ctx)
    await switch(client, ctx, "owner", True)
    day = datetime(2026, 10, 21, tzinfo=tokyo)
    frozen(monkeypatch, day.replace(hour=6, minute=59))
    await ticker_pass(ctx.tenant_id)
    assert await triage_runs(ctx) == []
    frozen(monkeypatch, day.replace(hour=7, minute=1))
    await ticker_pass(ctx.tenant_id)
    [run] = await triage_runs(ctx)
    assert run.knobs["triage_day"] == "2026-10-21"


async def test_daily_triage_counts_new_requests_without_a_suggestion(client, ctx):
    """protects=the daily run's condition (a New request with no suggestion), read as of
    the frozen clock; fails_when=a merged or suggested request alone triggers it;
    no_claim=the run itself."""
    at = datetime(2026, 10, 21, 7, 30, tzinfo=PACIFIC)
    r = await add(client, ctx)
    await suggest(ctx, r["id"], goal_ids=[])
    async with tenant_session(ctx.tenant_id) as s:
        assert await triage.daily_due(s, at) is False
        row = await s.get(ProductRequest, uuid.UUID(r["id"]))
        row.suggestion = {}
        await s.commit()
    async with tenant_session(ctx.tenant_id) as s:
        assert await triage.daily_due(s, at) is True
        assert await triage.daily_due(s, at.replace(hour=6)) is False
    other = await make_ctx("Other Co")
    async with tenant_session(other.tenant_id) as s:
        assert await triage.daily_due(s, at) is False
