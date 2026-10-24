"""H5 Metrics review, lane 2: the weekly metrics review ritual (seeded paused, taking over
the goals check-in on the first weekly value), its ``metrics_table`` and ``variances``
blocks, Oracle's ``metrics_variance`` explanation run (its importer, the two automatic
starts and the estimate), the metric Inbox rows and the ``update_draft`` tools.
Made-up names only; the runtime is the fake one (no model is called).

Each test's card: protects=<the observable>; fails_when=<the wrong result it rejects>;
no_claim=<what green does not prove>.
"""

import uuid
from datetime import UTC, date, datetime, timedelta

import pytest
import yaml
from sqlalchemy import func, select

from oracle.metrics import pull
from oracle.metrics.models import Metric, MetricVariance
from oracle.models import AuditEvent
from oracle.rituals import clock as ritual_clock
from oracle.runs import flows
from oracle.runs.models import Run, RunSegment
from oracle.sources.models import Source, SourceItem
from oracle.swarm import FakeRuntime, Outcome, set_runtime
from oracle.tenancy import tenant_session
from oracle.ticker import router as ticker
from tests import metrics_helpers
from tests.baseline_helpers import make_ctx
from tests.metrics_helpers import KEY, QUERY, connect, create, weeks_back
from tests.ritual_helpers import occurrences_of, rituals_of, tick

M = "/v1/metrics"
V = "/v1/metric-variances"
# Monday 26 October 2026, 12:00 UTC (05:00 in Los Angeles): the last complete week is the
# week of 19 October, and the weekly review falls due at 09:00 Los Angeles today.
T0 = datetime(2026, 10, 26, 12, 0, tzinfo=UTC)
WEEK = date(2026, 10, 19)

fake_posthog = metrics_helpers.fake_posthog


@pytest.fixture
async def ctx():
    return await make_ctx()


@pytest.fixture
def when(monkeypatch):
    """One clock for the metrics and the rituals: ``when(moment)``; starts at T0."""
    state = {"now": T0}
    monkeypatch.setattr(pull, "now", lambda: state["now"])
    monkeypatch.setattr(ritual_clock, "now", lambda: state["now"])

    def set_(moment: datetime) -> datetime:
        state["now"] = moment
        return moment

    return set_


async def _put(client, ctx, metric, week, value, who="approver"):
    resp = await client.put(f"{M}/{metric['id']}/values/{week.isoformat()}",
                            json={"value": value}, headers=ctx.as_(who))  # fmt: skip
    assert resp.status_code == 200, resp.text
    return resp


async def _jumping(client, ctx, **over) -> dict:
    """A manual metric with 12 changes of +-5 on 100 (under the 10% rule while the
    history is short), then +40 in the week of 19 October: one open variance, Better for
    an up metric."""
    metric = (await create(client, ctx, **over)).json()
    values = [100 + (5 if i % 2 else 0) for i in range(13)] + [140]
    for week, value in zip(weeks_back(14, WEEK), values, strict=True):
        await _put(client, ctx, metric, week, value)
    return metric


async def _flat(client, ctx, **over) -> dict:
    """A manual metric with a steady series: no variance."""
    metric = (await create(client, ctx, **over)).json()
    for week in weeks_back(3, WEEK):
        await _put(client, ctx, metric, week, 50)
    return metric


async def _review_ready(client, ctx) -> dict:
    """Seeds the rituals, adds an output with a variance and an input driving it (the
    first value activates the review), then ticks the review ready. Returns the
    occurrence."""
    await tick(ctx.tenant_id)
    output = await _jumping(client, ctx)
    await _flat(client, ctx, title="Invites sent", kind="input", unit="invites",
                drives_metric_id=output["id"])  # fmt: skip
    await tick(ctx.tenant_id)
    review = (await rituals_of(ctx.tenant_id))["metrics_review"]
    (occ,) = await occurrences_of(ctx.tenant_id, review.id)
    assert occ.status == "ready", occ.error
    resp = await client.get(f"/v1/ritual-occurrences/{occ.id}", headers=ctx.as_("owner"))
    assert resp.status_code == 200, resp.text
    return resp.json()


def _block(occ: dict, key: str) -> dict:
    return next(b for b in occ["pre_read"]["blocks"] if b["key"] == key)


async def _audits(tenant_id, action: str) -> int:
    async with tenant_session(tenant_id) as s:
        return int(
            await s.scalar(
                select(func.count()).select_from(AuditEvent).where(AuditEvent.action == action)
            )
        )


async def _runs(tenant_id, flow: str = "metrics_variance") -> list[Run]:
    async with tenant_session(tenant_id) as s:
        return list(await s.scalars(select(Run).where(Run.flow == flow)))


async def _inbox(client, ctx, who: str) -> dict:
    resp = await client.get("/v1/inbox", headers=ctx.as_(who))
    assert resp.status_code == 200, resp.text
    return resp.json()


# protects=criterion 8 (seeding): the first tick seeds the Weekly metrics review paused,
# with no next date, so a company without metrics has no empty review; fails_when=it is
# missing, active, or has a next date; no_claim=the Company › Rituals row.
async def test_the_first_tick_seeds_the_review_paused(client, ctx, when):
    await tick(ctx.tenant_id)
    review = (await rituals_of(ctx.tenant_id))["metrics_review"]
    assert review.title == "Weekly metrics review"
    assert (review.status, review.next_due_at, review.builtin) == ("paused", None, True)
    assert review.duration_min == 45 and review.prep_hours == 6


# protects=criterion 8 (activation): the first stored weekly value resumes the review with
# the goals check-in's schedule, owner and attendees and pauses the check-in, once (audit
# ritual.replaced); the check-in's row says what replaced it; an owner who resumes the
# check-in keeps it, and a second metric changes nothing; fails_when=the review keeps its
# own defaults, the check-in stays active, or a later value activates again;
# no_claim=the Rituals page's words (lane 3).
async def test_the_first_value_takes_over_the_goals_checkin_once(client, ctx, when):
    await tick(ctx.tenant_id)
    checkin = (await rituals_of(ctx.tenant_id))["goals_checkin"]
    approver, commenter = ctx.users["approver"].id, ctx.users["commenter"].id
    resp = await client.patch(f"/v1/rituals/{checkin.id}", json={
        "lock_version": checkin.lock_version, "owner_id": str(approver),
        "attendee_ids": [str(approver), str(commenter)],
        "schedule": {"freq": "weekly", "weekday": 1, "time": "10:30"},
    }, headers=ctx.as_("owner"))  # fmt: skip
    assert resp.status_code == 200, resp.text
    checkin = (await rituals_of(ctx.tenant_id))["goals_checkin"]
    assert (await rituals_of(ctx.tenant_id))["metrics_review"].status == "paused"

    await _flat(client, ctx)
    got = await rituals_of(ctx.tenant_id)
    review, checkin_now = got["metrics_review"], got["goals_checkin"]
    assert review.status == "active" and review.next_due_at is not None
    assert review.schedule == checkin.schedule
    assert review.owner_id == approver
    assert list(review.attendee_ids) == [approver, commenter]
    assert (checkin_now.status, checkin_now.next_due_at) == ("paused", None)
    assert await _audits(ctx.tenant_id, "ritual.replaced") == 1
    listed = {
        r["kind"]: r for r in (await client.get("/v1/rituals", headers=ctx.as_("viewer"))).json()
    }
    assert listed["goals_checkin"]["replaced_by"] == "Weekly metrics review"
    assert listed["metrics_review"]["replaced_by"] is None

    resp = await client.post(f"/v1/rituals/{checkin.id}/resume", headers=ctx.as_("owner"))
    assert resp.status_code == 200, resp.text
    await _flat(client, ctx, title="Weekly signups", unit="signups")
    got = await rituals_of(ctx.tenant_id)
    assert got["goals_checkin"].status == "active"
    assert got["metrics_review"].status == "active"
    assert await _audits(ctx.tenant_id, "ritual.replaced") == 1


# protects=criterion 8 (the pre-read): the review's metrics_table lists the output before
# the input driving it, with last week's value, the change against the week before and
# the 6-week average, the 12-week series and the variance flag, each row linking
# /company/metrics?metric=<id>; the variances block lists criterion 1's variance with its
# owner and explanation state; fails_when=inputs come first, the jump is not flagged, or a
# variance is missing; no_claim=the possible causes' order (lane 1's
# test_causes_put_the_goals_launch_first) and the renderers (lane 3).
async def test_the_pre_read_has_the_table_and_the_variances(client, ctx, when):
    occ = await _review_ready(client, ctx)
    keys = [b["key"] for b in occ["pre_read"]["blocks"]]
    assert keys[:2] == ["metrics_table", "variances"]
    assert _block(occ, "metrics_table")["title"] == "Metrics"
    rows = _block(occ, "metrics_table")["rows"]
    assert [r["title"] for r in rows] == ["Weekly active teams", "Invites sent"]
    out, inp = rows
    assert (out["kind"], inp["kind"]) == ("output", "input")
    assert inp["drives_metric_id"] == out["metric_id"]
    assert out["week_start"] == WEEK.isoformat()
    assert (out["value"], out["change"], out["variance"]) == (140, 40, "better")
    # The six weeks before: 105, 100, 105, 100, 105, 100 -> 102.5.
    assert out["vs_6w_avg"] == 37.5
    assert out["vs_last_year"] is None
    assert len(out["spark"]) == 12 and out["spark"][-1] == 140
    assert out["href"] == f"/company/metrics?metric={out['metric_id']}"
    assert out["state"] == "ok" and inp["variance"] is None
    (var,) = _block(occ, "variances")["rows"]
    assert var["metric_title"] == "Weekly active teams" and var["direction"] == "better"
    assert var["status"] == "open" and var["owner_name"] == "Commenter"
    assert var["band"] == {"low": 90, "high": 110}
    assert var["href"] == f"/company/metrics?metric={out['metric_id']}"
    async with tenant_session(ctx.tenant_id) as s:
        row = await s.get(MetricVariance, uuid.UUID(var["variance_id"]))
        assert str(row.occurrence_id) == occ["id"]
    assert (
        "Weekly active teams"
        in (
            await client.get(
                f"/v1/ritual-occurrences/{occ['id']}/pre-read.md", headers=ctx.as_("viewer")
            )
        ).text
    )


# protects=the review also lists metrics with no value this week and those whose pull
# failed; fails_when=a metric without this week's value is left out or shows a number;
# no_claim=PostHog failures (test_pull_failed_inbox_row covers the error state).
async def test_the_table_lists_a_metric_with_no_value_this_week(client, ctx, when):
    await tick(ctx.tenant_id)
    await _jumping(client, ctx)
    late = (await create(client, ctx, title="Churned teams", unit="teams",
                         direction="down")).json()  # fmt: skip
    await _put(client, ctx, late, WEEK - timedelta(weeks=1), 3)
    await tick(ctx.tenant_id)
    review = (await rituals_of(ctx.tenant_id))["metrics_review"]
    (row,) = await occurrences_of(ctx.tenant_id, review.id)
    occ = (await client.get(f"/v1/ritual-occurrences/{row.id}", headers=ctx.as_("owner"))).json()
    rows = {r["title"]: r for r in _block(occ, "metrics_table")["rows"]}
    assert rows["Churned teams"]["state"] == "no_value"
    assert rows["Churned teams"]["value"] is None
    assert "No value this week" in rows["Churned teams"]["text"]


# protects=criterion 9: Explain with Oracle on a metrics review creates one
# metrics_variance run estimated at $1.50 (one analyst step at quick depth); its
# variances.yaml sets the matching variance's draft and confidence, its summary.md is the
# occurrence's summary, and a ref to a source item the run could not read is dropped and
# counted in the import's notes; fails_when=a ritual_summary run starts, the estimate is
# $3.00, the draft is not stored, or an unreadable ref is kept; no_claim=the draft's
# quality (fake runtime).
async def test_explain_with_oracle_starts_one_variance_run(client, ctx, when):
    occ = await _review_ready(client, ctx)
    (var,) = _block(occ, "variances")["rows"]
    # The run's creator (the approver who clicks) reads their own source's items.
    async with tenant_session(ctx.tenant_id) as s:
        mine = Source(kind="upload", name="Notes", owner_user_id=ctx.users["approver"].id)
        s.add(mine)
        await s.flush()
        item = SourceItem(source_id=mine.id, kind="file", external_id="n-1",
                          title="Release notes")  # fmt: skip
        s.add(item)
        await s.commit()
        item_id = item.id
    stranger = uuid.uuid4()
    draft = "The team-invite launch on Oct 14 matches the jump in active teams."
    doc = {"version": 1, "variances": [
        {"id": var["variance_id"], "draft": draft, "confidence": "medium",
         "refs": [{"kind": "source_item", "id": str(item_id)},
                  {"kind": "source_item", "id": str(stranger)}]},
        {"id": str(uuid.uuid4()), "draft": "Not ours", "confidence": "high", "refs": []},
    ]}  # fmt: skip
    files = {"summary.md": "Active teams jumped by 40.", "variances.yaml": yaml.safe_dump(doc)}
    set_runtime(FakeRuntime({"explain": [Outcome(artifacts=files)]}))
    try:
        url = f"/v1/ritual-occurrences/{occ['id']}/summary"
        assert (await client.post(url, headers=ctx.as_("commenter"))).status_code == 403
        resp = await client.post(url, headers=ctx.as_("approver"))
        assert resp.status_code == 201, resp.text
        assert resp.json()["flow"] == "metrics_variance"
        (run,) = await _runs(ctx.tenant_id)
        assert float(run.estimate_usd) == 1.5
        assert await _runs(ctx.tenant_id, "ritual_summary") == []
        assert (await client.post(url, headers=ctx.as_("approver"))).status_code == 409
        for _ in range(3):
            await client.post("/v1/internal/tick", headers=ctx.as_("owner"))
        got = (await client.get(f"/v1/ritual-occurrences/{occ['id']}",
                                headers=ctx.as_("owner"))).json()  # fmt: skip
        assert got["summary_state"] == "ready" and got["summary"] == "Active teams jumped by 40."
        (out,) = (await client.get(V, headers=ctx.as_("viewer"))).json()
        assert (out["oracle_draft"], out["oracle_confidence"]) == (draft, "medium")
        async with tenant_session(ctx.tenant_id) as s:
            row = await s.get(MetricVariance, uuid.UUID(var["variance_id"]))
            assert row.oracle_refs == [{"kind": "source_item", "id": str(item_id)}]
            assert row.oracle_run_id == run.id
            seg = await s.scalar(select(RunSegment).where(RunSegment.run_id == run.id))
            notes = seg.artifacts["import"]["notes"]
        assert "1 ref dropped (not readable by the run)" in notes
        assert "1 variance dropped (not in this review)" in notes
    finally:
        set_runtime(None)


# protects=criterion 9 (no open variance): Explain with Oracle on a review whose variances
# are all answered is 409 and starts nothing; fails_when=a run starts with nothing to
# explain; no_claim=the button's absence (lane 3).
async def test_no_open_variance_is_409(client, ctx, when):
    occ = await _review_ready(client, ctx)
    (var,) = _block(occ, "variances")["rows"]
    resp = await client.post(f"{V}/{var['variance_id']}/noise", json={"reason": "Holiday"},
                             headers=ctx.as_("approver"))  # fmt: skip
    assert resp.status_code == 200, resp.text
    url = f"/v1/ritual-occurrences/{occ['id']}/summary"
    resp = await client.post(url, headers=ctx.as_("approver"))
    assert resp.status_code == 409
    assert await _runs(ctx.tenant_id) == []


# protects=criterion 10 (always): with summaries on Every pre-read, the tick that makes a
# metrics review ready starts exactly one metrics_variance run (and no ritual_summary run
# for it); fails_when=none starts, two start, or the generic summary starts instead;
# no_claim=the run's content.
async def test_always_starts_one_variance_run(client, ctx, when):
    set_runtime(FakeRuntime())
    try:
        resp = await client.put("/v1/rituals/summaries", json={"mode": "always"},
                                headers=ctx.as_("owner"))  # fmt: skip
        assert resp.status_code == 200, resp.text
        occ = await _review_ready(client, ctx)
        await tick(ctx.tenant_id)
        runs = await _runs(ctx.tenant_id)
        assert len(runs) == 1
        assert runs[0].knobs["ritual_occurrence_id"] == occ["id"]
        async with tenant_session(ctx.tenant_id) as s:
            summary_runs = list(await s.scalars(select(Run).where(Run.flow == "ritual_summary")))
        assert all(r.knobs.get("ritual_occurrence_id") != occ["id"] for r in summary_runs)
    finally:
        set_runtime(None)


async def _act(client, ctx, max_run_usd: float) -> None:
    resp = await client.put(
        "/v1/autonomy/rituals",
        json={"level": "act", "limits": {"max_run_usd": max_run_usd}, "reason": "Try it"},
        headers=ctx.as_("owner"),
    )
    assert resp.status_code == 200, resp.text


# protects=criterion 10 (Act within limits): with summaries on demand and rituals at Act
# with max_run_usd 10, the review's ready tick starts one metrics_variance run and an
# Oracle action row reaches the ritual's owner; fails_when=no run starts, two start, or
# the owner is not told; no_claim=the Inbox screen.
async def test_act_within_limits_starts_one_run_and_tells_the_owner(client, ctx, when):
    set_runtime(FakeRuntime())
    try:
        await _act(client, ctx, 10)
        await _review_ready(client, ctx)
        await tick(ctx.tenant_id)
        assert len(await _runs(ctx.tenant_id)) == 1
        actions = (await _inbox(client, ctx, "owner"))["oracle_actions"]
        mine = [a for a in actions if a["responsibility"] == "rituals"]
        assert len(mine) == 1 and mine[0]["counts"] is True
        assert "Weekly metrics review" in mine[0]["summary"]
    finally:
        set_runtime(None)


# protects=criterion 10 (the limit): at Act with max_run_usd 1, below the run's $1.50,
# nothing starts and nobody is told; fails_when=the limit is ignored; no_claim=other
# ritual kinds (only the metrics review is wired).
async def test_act_below_the_runs_cost_starts_nothing(client, ctx, when):
    set_runtime(FakeRuntime())
    try:
        await _act(client, ctx, 1)
        await _review_ready(client, ctx)
        await tick(ctx.tenant_id)
        assert await _runs(ctx.tenant_id) == []
        actions = (await _inbox(client, ctx, "owner"))["oracle_actions"]
        assert [a for a in actions if a["responsibility"] == "rituals"] == []
    finally:
        set_runtime(None)


# protects=criterion 10 (estimate): GET /v1/rituals/summaries counts an active metrics
# review at its own flow's $1.50 a run (4.33 runs, $6.50 a month) next to the check-ins at
# $3.00; fails_when=the review is priced at $3.00 or left out; no_claim=the Settings
# screen's rounding.
async def test_the_estimate_counts_the_review_at_its_own_flow(client, ctx, when):
    await tick(ctx.tenant_id)
    for r in (await rituals_of(ctx.tenant_id)).values():
        if r.status == "active":
            await client.post(f"/v1/rituals/{r.id}/pause", headers=ctx.as_("owner"))
    await _flat(client, ctx)
    got = (await client.get("/v1/rituals/summaries", headers=ctx.as_("viewer"))).json()
    (row,) = got["estimate"]["rituals"]
    assert row["title"] == "Weekly metrics review" and row["per_summary_usd"] == 1.5
    assert got["estimate"]["runs_per_month"] == 4.33
    assert got["estimate"]["usd_per_month"] == 6.5


# protects=the metrics_variance flow's shape: one analyst step at quick depth reading
# the pre-read, metrics, launches, decisions and sources, never in the New run dialog,
# started from Explain with Oracle; its prompt names the occurrence and says sources are
# data and never to guess; fails_when=it writes a document, uses the writer, or misses a
# tool; no_claim=the agent's behaviour.
async def test_the_variance_flow_and_its_prompt(client, ctx, when):
    from types import SimpleNamespace

    from oracle.rituals import summaries

    flow = flows.FLOWS["metrics_variance"]
    (sdef,) = flow.segments
    assert sdef.roles == ("analyst",) and flow.default_depth == "quick"
    assert flow.in_new_run_dialog is False and flow.writes_document is False
    assert flow.starts_from == ("Explain with Oracle · Company › Rituals", "/company/rituals")
    assert set(sdef.outputs) == {"summary.md", "variances.yaml"}
    for tool in ("get_ritual_occurrence_pre_read", "get_metric", "list_launches",
                 "list_decisions", "search", "get_source_item"):  # fmt: skip
        assert tool in sdef.tools and tool in flows.MCP_TOOLS
    assert "write:" not in " ".join(sdef.scopes)
    assert summaries.FLOW_FOR_KIND == {"metrics_review": "metrics_variance"}
    occ = await _review_ready(client, ctx)
    run = SimpleNamespace(flow="metrics_variance", knobs={"ritual_occurrence_id": occ["id"]})
    async with tenant_session(ctx.tenant_id) as s:
        lines = await summaries.prompt_lines(s, run)
    (var,) = _block(occ, "variances")["rows"]
    assert any(var["variance_id"] in line for line in lines)
    pctx = flows.PromptContext(run_id="r-1", document=None, snapshot_as_of=None,
                               low_confidence=0.5, extra_lines=lines)  # fmt: skip
    prompt = flows.step_prompt(flow, sdef, "analyst", last=True, ctx=pctx)
    assert "Not explained by what Oracle can read" in prompt
    assert "80 words" in prompt and "never" in prompt.lower()


# protects=the update_draft flow reads the weekly metrics: list_metrics and get_metric
# are its tools and its task puts the weekly metrics first, outputs before inputs;
# fails_when=either tool is missing or the task does not name list_metrics;
# no_claim=the update's content.
def test_update_draft_reads_the_weekly_metrics():
    (sdef,) = flows.FLOWS["update_draft"].segments
    assert {"list_metrics", "get_metric"} <= set(sdef.tools)
    assert "and the weekly metrics (list_metrics), outputs before inputs" in sdef.task
    assert "list_metrics" in flows.MCP_TOOLS and "get_metric" in flows.MCP_TOOLS


# protects=the Explain a variance row: the metric's owner (a commenter) has one counted
# row naming the metric and the week, linking the review; the badge (total and needs_me)
# drops by 1 once they explain; another member has none; fails_when=no row, an uncounted
# row, a row for someone else, or a row left after explaining; no_claim=the Inbox screen.
async def test_explain_a_variance_inbox_row(client, ctx, when):
    occ = await _review_ready(client, ctx)
    before = await _inbox(client, ctx, "commenter")
    (row,) = before["metrics"]
    assert (row["reason"], row["metric_title"], row["counts"]) == (
        "explain", "Weekly active teams", True)  # fmt: skip
    assert row["week_start"] == WEEK.isoformat() and row["occurrence_id"] == occ["id"]
    assert (await _inbox(client, ctx, "viewer"))["metrics"] == []
    text = "The team-invite launch doubled invites that week."
    resp = await client.post(f"{V}/{row['variance_id']}/explain", json={"explanation": text},
                             headers=ctx.as_("commenter"))  # fmt: skip
    assert resp.status_code == 200, resp.text
    after = await _inbox(client, ctx, "commenter")
    assert after["metrics"] == []
    assert after["total"] == before["total"] - 1
    assert after["needs_me"] == before["needs_me"] - 1


# protects=criterion 11 (Find out): after Don't know yet the Explain row ends; once the
# find-out-by day passes in the Company time zone the owner has a counted Find out row
# with its due day; explaining ends it; fails_when=the row shows before the day, is not
# counted, or stays after explaining; no_claim=the words on screen.
async def test_find_out_row_after_the_day(client, ctx, when):
    await tick(ctx.tenant_id)
    await _jumping(client, ctx)
    (var,) = (await client.get(V, headers=ctx.as_("viewer"))).json()
    day = date(2026, 10, 30)
    resp = await client.post(f"{V}/{var['id']}/unknown", json={"find_out_by": day.isoformat()},
                             headers=ctx.as_("commenter"))  # fmt: skip
    assert resp.status_code == 200, resp.text
    assert (await _inbox(client, ctx, "commenter"))["metrics"] == []
    # 30 October 08:00 in Los Angeles: the day has come.
    when(datetime(2026, 10, 30, 15, 0, tzinfo=UTC))
    (row,) = (await _inbox(client, ctx, "commenter"))["metrics"]
    assert (row["reason"], row["due_on"], row["counts"]) == ("find_out", day.isoformat(), True)
    text = "Two large teams joined from one referral."
    resp = await client.post(f"{V}/{var['id']}/explain", json={"explanation": text},
                             headers=ctx.as_("commenter"))  # fmt: skip
    assert resp.status_code == 200
    assert (await _inbox(client, ctx, "commenter"))["metrics"] == []


# protects=criterion 5 (the Inbox row): after 24 hours of failed pulls owners have a
# counted "Metric not read for a day" row (pull_failed) and approvers none; a pull that
# succeeds ends it; fails_when=no row, an uncounted one, or one left after a good pull;
# no_claim=the PostHog API's real shape (fake transport).
async def test_pull_failed_inbox_row(client, ctx, when, fake_posthog):
    assert (await connect(client, ctx)).status_code == 200
    metric = (await create(client, ctx, source="posthog", query=QUERY)).json()
    fake_posthog.failing = {"12345"}
    start = when(T0 + timedelta(days=7))

    async def _tick():
        out = ticker.TickerOut()
        await ticker._tick_company(ctx.tenant_id, out, ticker._Failures(out))

    await _tick()
    assert [m for m in (await _inbox(client, ctx, "owner"))["metrics"]
            if m["reason"] == "pull_failed"] == []  # fmt: skip
    when(start + timedelta(hours=24, minutes=5))
    await _tick()
    async with tenant_session(ctx.tenant_id) as s:
        assert (await s.get(Metric, uuid.UUID(metric["id"]))).status == "error"
    rows = [m for m in (await _inbox(client, ctx, "owner"))["metrics"]
            if m["reason"] == "pull_failed"]  # fmt: skip
    assert len(rows) == 1 and rows[0]["counts"] is True
    assert rows[0]["metric_id"] == metric["id"] and rows[0]["variance_id"] is None
    approver_rows = (await _inbox(client, ctx, "approver"))["metrics"]
    assert all(m["reason"] != "pull_failed" for m in approver_rows)
    fake_posthog.failing = set()
    when(start + timedelta(hours=25, minutes=10))
    await _tick()
    assert all(m["reason"] != "pull_failed"
               for m in (await _inbox(client, ctx, "owner"))["metrics"])  # fmt: skip
    assert KEY not in str(rows)
