"""H4 Strategy and vision, lane 2: the deterministic drift check, stored findings and
their waivers, the strategy stack, the Inbox row, the daily ticker check and the change
handler.

Each test's card: protects=<the observable>; fails_when=<the wrong result it rejects>;
no_claim=<what green does not prove>.
"""

from datetime import UTC, datetime, timedelta

import pytest
from sqlalchemy import func, select, update

from oracle.docs.models import DocumentVersion
from oracle.models import AuditEvent
from oracle.strategy import drift
from oracle.strategy.models import StrategyFinding
from oracle.tenancy import tenant_session
from tests.baseline_helpers import make_ctx
from tests.day_helpers import company_today
from tests.strategy_helpers import (
    STRATEGY,
    VISION,
    add_entity,
    approved,
    belief,
    check,
    choice,
    findings,
    imported,
    roadmap_with_items,
    strategy_md,
    supports,
    vision_md,
)


@pytest.fixture
async def ctx():
    return await make_ctx()


async def _strategy(client, ctx, choices, n: int = 1, **kw) -> None:
    await imported(client, ctx.as_("owner"), STRATEGY, strategy_md(choices, **kw))
    await approved(client, ctx.as_("owner"), STRATEGY, n)


async def _world(client, ctx) -> dict:
    """Goals a (under focus choice one) and c (under none); features f (serves a, under
    the stop choice) and h (serves c); an active track whose approved roadmap has f in Now
    and h in Later."""
    t = ctx.tenant_id
    ids = {
        "a": await add_entity(t, "goal", "a"),
        "c": await add_entity(t, "goal", "c"),
        "f": await add_entity(t, "feature", "f"),
        "h": await add_entity(t, "feature", "h"),
    }
    await supports(t, ids["f"], ids["a"])
    await supports(t, ids["h"], ids["c"])
    await _strategy(
        client, ctx, [choice("one", goals=["a"]), choice("sso", "stop", features=["f"])]
    )
    await roadmap_with_items(
        client, ctx, [("item-f", "now", ids["f"]), ("item-h", "later", ids["h"])]
    )
    await approved(client, ctx.as_("owner"), "example-roadmap", 1)
    return ids


def _by_kind(rows: list[dict]) -> dict[str, list[dict]]:
    out: dict[str, list[dict]] = {}
    for r in rows:
        out.setdefault(r["kind"], []).append(r)
    return out


# --------------------------------------------------------------------------- rules


async def test_drift_rules_open_the_right_findings(client, ctx):
    """protects=acceptance 6: goal_without_strategy for c only, stopped_but_planned (high)
    for the Now item under the stop choice, outside_strategy for the item serving only c;
    fails_when=a is flagged, the severity is not high, or an item is missed;
    no_claim=E1 per-draft roadmaps (not on main)."""
    ids = await _world(client, ctx)
    await check(client, ctx)
    rows = _by_kind(await findings(client, ctx))
    assert [(r["subject_kind"], r["subject_id"]) for r in rows["goal_without_strategy"]] == [
        ("entity", str(ids["c"]))
    ]
    (stopped,) = rows["stopped_but_planned"]
    assert stopped["severity"] == "high" and stopped["subject_kind"] == "roadmap_item"
    assert stopped["subject_ref"] == "item-f"
    (outside,) = rows["outside_strategy"]
    assert outside["subject_ref"] == "item-h" and outside["severity"] == "warning"
    assert "no_strategy" not in rows and "focus_without_goal" not in rows


async def test_focus_without_goal_and_review_due(client, ctx):
    """protects=a focus choice no goal derives from is flagged, and a strategy or vision
    past its review_on is due; fails_when=either is missed; no_claim=the H2 review
    ritual."""
    await add_entity(ctx.tenant_id, "goal", "a")
    past = (company_today() - timedelta(days=1)).isoformat()
    await _strategy(client, ctx, [choice("one", goals=["a"]), choice("lonely")], review_on=past)
    await imported(client, ctx.as_("owner"), VISION, vision_md([belief("b1", "x")], review_on=past))
    await approved(client, ctx.as_("owner"), VISION, 1)
    await check(client, ctx)
    rows = _by_kind(await findings(client, ctx))
    (lonely,) = rows["focus_without_goal"]
    assert lonely["subject_ref"] == f"strategy_choice:{STRATEGY}-lonely"
    assert len(rows["strategy_review_due"]) == 1 and len(rows["vision_review_due"]) == 1


async def test_no_strategy_is_info_and_never_in_the_inbox(client, ctx):
    """protects=no approved strategy opens one info no_strategy finding and no other
    rule fires; the Inbox has no strategy row for it; fails_when=goals are flagged against
    a strategy that does not exist, or the Inbox counts it; no_claim=the Plan banner (F1)."""
    await add_entity(ctx.tenant_id, "goal", "a")
    await check(client, ctx)
    rows = await findings(client, ctx)
    assert [(r["kind"], r["severity"]) for r in rows] == [("no_strategy", "info")]
    inbox = (await client.get("/v1/inbox", headers=ctx.as_("owner"))).json()
    assert inbox["strategy"] is None


async def test_recompute_opens_no_duplicates_and_resolves_what_is_fixed(client, ctx):
    """protects=re-running opens nothing new; fixing the cause resolves the finding;
    fails_when=a second row for the same subject, or the fixed finding stays open;
    no_claim=concurrent checks."""
    ids = await _world(client, ctx)
    first = await check(client, ctx)
    assert first["opened"] == 0  # the approvals already ran the check
    async with tenant_session(ctx.tenant_id) as s:
        count = await s.scalar(select(func.count()).select_from(StrategyFinding))
    again = await check(client, ctx)
    assert again == {"opened": 0, "resolved": 0}
    async with tenant_session(ctx.tenant_id) as s:
        assert await s.scalar(select(func.count()).select_from(StrategyFinding)) == count

    # c now derives from a focus choice: the strategy's next approved version says so.
    await _strategy(client, ctx, [choice("one", goals=["a", "c"]),
                                  choice("sso", "stop", features=["f"])], n=2)  # fmt: skip
    resolved = await findings(client, ctx, status="resolved", kind="goal_without_strategy")
    assert [r["subject_id"] for r in resolved] == [str(ids["c"])]
    assert resolved[0]["resolved_at"] is not None
    assert await findings(client, ctx, kind="goal_without_strategy") == []


# --------------------------------------------------------------------------- waive


async def test_waive_needs_a_reason_is_audited_and_survives_the_next_check(client, ctx):
    """protects=acceptance 7: a waiver with a reason sets waived and is audited, the next
    check keeps it waived, and one without a reason is a 422; fails_when=the check reopens
    it, nothing is audited, or an empty reason passes; no_claim=the H1 decision capture
    (H1 is not on main)."""
    await _world(client, ctx)
    (goal,) = await findings(client, ctx, kind="goal_without_strategy")
    url = f"/v1/strategy/findings/{goal['id']}/waive"
    for body in ({}, {"reason": ""}, {"reason": "   "}):
        assert (await client.post(url, json=body, headers=ctx.as_("owner"))).status_code == 422
    resp = await client.post(
        url, json={"reason": "A bet outside the plan"}, headers=ctx.as_("owner")
    )
    assert resp.status_code == 200, resp.text
    out = resp.json()
    assert out["status"] == "waived" and out["waive_reason"] == "A bet outside the plan"
    assert out["waived_by"] == str(ctx.users["owner"].id)
    async with tenant_session(ctx.tenant_id) as s:
        audit = await s.scalar(
            select(AuditEvent).where(AuditEvent.action == "strategy_finding.waived")
        )
    assert audit is not None and audit.data["reason"] == "A bet outside the plan"
    await check(client, ctx)
    assert [r["id"] for r in await findings(client, ctx, status="waived")] == [goal["id"]]
    assert await findings(client, ctx, kind="goal_without_strategy") == []


async def test_who_may_waive(client, ctx):
    """protects=owners waive any finding; approvers only outside_strategy; fails_when=an
    approver waives a goal finding or cannot waive an item outside the strategy;
    no_claim=commenters and viewers beyond the 403."""
    await _world(client, ctx)
    rows = _by_kind(await findings(client, ctx))
    body = {"reason": "Known"}
    goal = rows["goal_without_strategy"][0]["id"]
    outside = rows["outside_strategy"][0]["id"]
    resp = await client.post(f"/v1/strategy/findings/{goal}/waive", json=body,
                             headers=ctx.as_("approver"))  # fmt: skip
    assert resp.status_code == 403
    resp = await client.post(f"/v1/strategy/findings/{outside}/waive", json=body,
                             headers=ctx.as_("approver"))  # fmt: skip
    assert resp.status_code == 200, resp.text
    resp = await client.post(f"/v1/strategy/findings/{goal}/waive", json=body,
                             headers=ctx.as_("viewer"))  # fmt: skip
    assert resp.status_code == 403


async def test_a_waived_finding_reopens_when_its_subject_changes(client, ctx):
    """protects=a waiver lasts until its subject changes again; fails_when=an edited goal
    keeps its old waiver; no_claim=which edits count beyond the goal's own fields."""
    ids = await _world(client, ctx)
    (goal,) = await findings(client, ctx, kind="goal_without_strategy")
    await client.post(f"/v1/strategy/findings/{goal['id']}/waive", json={"reason": "Later"},
                      headers=ctx.as_("owner"))  # fmt: skip
    resp = await client.patch(
        f"/v1/baseline/entities/{ids['c']}", json={"title": "Goal c, sharper"},
        headers=ctx.as_("owner"),
    )  # fmt: skip
    assert resp.status_code == 200, resp.text
    await check(client, ctx)
    (row,) = await findings(client, ctx, kind="goal_without_strategy")
    assert row["id"] == goal["id"] and row["status"] == "open"


# --------------------------------------------------------------------------- stack


async def test_the_stack(client, ctx):
    """protects=acceptance 9: the vision with its beliefs, the choices with their goals,
    item counts and open findings, and the unaligned goals and items; fails_when=a layer is
    missing or a count is wrong; no_claim=goal distance to go (B5)."""
    ids = await _world(client, ctx)
    md = vision_md([belief("b1", "Teams plan weekly", "supported"), belief("b2", "x"),
                    belief("b3", "y", "strained")], headline="Plan like a large team.")  # fmt: skip
    await imported(client, ctx.as_("owner"), VISION, md)
    await approved(client, ctx.as_("owner"), VISION, 1)
    resp = await client.get("/v1/strategy/stack", headers=ctx.as_("viewer"))
    assert resp.status_code == 200, resp.text
    stack = resp.json()
    vision = stack["vision"]
    assert vision["document"]["slug"] == VISION and vision["document"]["version"] == 1
    assert vision["headline"] == "Plan like a large team."
    assert [(b["id"], b["status"], b["evidence"]) for b in vision["beliefs"]] == [
        ("b1", "supported", 0), ("b2", "untested", 0), ("b3", "strained", 0)
    ]  # fmt: skip
    strategy = stack["strategy"]
    assert strategy["document"]["slug"] == STRATEGY and strategy["review_on"] == "2027-11-01"
    by_id = {c["id"]: c for c in strategy["choices"]}
    assert by_id["one"]["stance"] == "focus" and by_id["one"]["items"] == 1
    assert [g["key"] for g in by_id["one"]["goals"]] == ["a"]
    assert by_id["sso"]["stance"] == "stop"
    assert by_id["sso"]["items"] == 1 and by_id["sso"]["open_findings"] == 1
    assert [f["key"] for f in by_id["sso"]["features"]] == ["f"]
    assert [g["id"] for g in stack["unaligned"]["goals"]] == [str(ids["c"])]
    assert [i["title"] for i in stack["unaligned"]["items"]] == ["Item H"]
    assert stack["unaligned"]["items"][0]["draft"] is False
    assert stack["counts"] == {"open": 3, "high": 1, "waived": 0}


async def test_the_stack_is_empty_before_any_strategy(client, ctx):
    """protects=a company with nothing approved reads an empty stack, not an error;
    fails_when=it 404s or invents layers; no_claim=drafts in progress."""
    stack = (await client.get("/v1/strategy/stack", headers=ctx.as_("viewer"))).json()
    assert stack["vision"] is None and stack["strategy"] is None
    assert stack["unaligned"] == {"goals": [], "items": []}


async def test_a_run_token_with_read_baseline_reads_the_stack(ctx):
    """protects=agents read the stack over MCP with read:baseline (get_strategy_stack);
    fails_when=read:baseline is refused or read:documents alone is let in; no_claim=what
    agents do with it."""
    from oracle.swarm import FakeRuntime, set_runtime
    from tests.test_mcp import mcp_client, run_token, text_of

    set_runtime(FakeRuntime())
    try:
        owner = ctx.users["owner"].id
        async with mcp_client(await run_token(ctx.tenant_id, ["read:baseline"], owner)) as c:
            names = {t.name for t in (await c.list_tools()).tools}
            assert "get_strategy_stack" in names
            ok = await c.call_tool("get_strategy_stack", {})
            assert not ok.is_error and '"unaligned"' in text_of(ok)
        async with mcp_client(await run_token(ctx.tenant_id, ["read:documents"], owner)) as c:
            refused = await c.call_tool("get_strategy_stack", {})
            assert refused.is_error and "needs the read:baseline scope" in text_of(refused)
    finally:
        set_runtime(None)


# --------------------------------------------------------------------------- inbox


async def test_the_inbox_row_counts_open_findings_for_owners(client, ctx):
    """protects=InboxOut.strategy for owners: new findings, high and the href, counted once
    in total; a waiver drops the count by one; approvers have no row; fails_when=an
    approver sees it, the count ignores waivers or total counts each finding;
    no_claim=the UI copy (web/e2e/strategy.spec.ts)."""
    await _world(client, ctx)
    inbox = (await client.get("/v1/inbox", headers=ctx.as_("owner"))).json()
    row = inbox["strategy"]
    assert {k: row[k] for k in ("new_findings", "high", "href")} == {
        "new_findings": 3, "high": 1, "href": "/company/strategy"
    }  # fmt: skip
    assert row["since"] is not None
    approver = (await client.get("/v1/inbox", headers=ctx.as_("approver"))).json()
    assert approver["strategy"] is None
    (goal,) = await findings(client, ctx, kind="goal_without_strategy")
    await client.post(f"/v1/strategy/findings/{goal['id']}/waive", json={"reason": "Later"},
                      headers=ctx.as_("owner"))  # fmt: skip
    after = (await client.get("/v1/inbox", headers=ctx.as_("owner"))).json()
    assert after["strategy"]["new_findings"] == 2
    assert inbox["total"] - after["total"] == 0  # counted once, while any is open


# --------------------------------------------------------------------------- triggers


async def test_the_daily_check_runs_once_a_day(ctx):
    """protects=the ticker's call runs the check when the last one is a day old and not
    before; fails_when=it runs every tick or never; no_claim=the scheduler's auth."""
    async with tenant_session(ctx.tenant_id) as s:
        assert await drift.check_due(s) is True
        await s.commit()
    async with tenant_session(ctx.tenant_id) as s:
        assert await drift.check_due(s) is False
        await s.execute(
            update(drift.StrategyCheck).values(
                created_at=datetime.now(UTC) - timedelta(days=1, minutes=1)
            )
        )
        assert await drift.check_due(s) is True


async def test_the_scheduler_tick_runs_the_daily_check(ctx):
    """protects=the run ticker calls the daily check per company; fails_when=a tick leaves
    no check; no_claim=ordering against the other ticker work."""
    from oracle.swarm import FakeRuntime, set_runtime
    from oracle.ticker.router import TickerOut, _Failures, _tick_company

    set_runtime(FakeRuntime())
    try:
        out = TickerOut()
        await _tick_company(ctx.tenant_id, out, _Failures(out))
    finally:
        set_runtime(None)
    async with tenant_session(ctx.tenant_id) as s:
        causes = list(await s.scalars(select(drift.StrategyCheck.cause)))
    assert causes == ["daily"]


async def test_a_goal_change_runs_the_check(client, ctx):
    """protects=the change handler: confirming a new goal flags it without a manual check;
    fails_when=the finding waits for the daily run; no_claim=changes to other entity
    types."""
    await add_entity(ctx.tenant_id, "goal", "a")
    await _strategy(client, ctx, [choice("one", goals=["a"])])
    new = await add_entity(ctx.tenant_id, "goal", "z", status="proposed")
    resp = await client.post(f"/v1/baseline/entities/{new}/confirm", json={},
                             headers=ctx.as_("owner"))  # fmt: skip
    assert resp.status_code == 200, resp.text
    rows = await findings(client, ctx, kind="goal_without_strategy")
    assert [r["subject_id"] for r in rows] == [str(new)]


# --------------------------------------------------------------------------- isolation


async def test_another_companys_ids_are_not_found(client, ctx):
    """protects=acceptance 10: findings and stacks stay inside their company; fails_when=a
    route reads or waives another company's finding; no_claim=row-level security itself
    (tenancy tests)."""
    await _world(client, ctx)
    (goal,) = await findings(client, ctx, kind="goal_without_strategy")
    other = await make_ctx("Other Co")
    resp = await client.post(f"/v1/strategy/findings/{goal['id']}/waive", json={"reason": "x"},
                             headers=other.as_("owner"))  # fmt: skip
    assert resp.status_code == 404
    assert await findings(client, other) == []
    stack = (await client.get("/v1/strategy/stack", headers=other.as_("owner"))).json()
    assert stack["strategy"] is None
    resp = await client.get(f"/v1/documents/{STRATEGY}", headers=other.as_("owner"))
    assert resp.status_code == 404
    async with tenant_session(ctx.tenant_id) as s:
        assert await s.scalar(select(func.count()).select_from(DocumentVersion)) >= 2
