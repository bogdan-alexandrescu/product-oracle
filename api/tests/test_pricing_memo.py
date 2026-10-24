"""H9 Pricing input: the pricing memo kind, its template and import checks, the
pricing_memo run and its owner review, H11 pricing_input, the pricing owner, and Decide
(from an approved memo to one proposed decision). Against Postgres with the FakeRuntime.

Each test's card: protects=<the observable>; fails_when=<the wrong result it rejects>;
no_claim=<what green does not prove>.
"""

import time
from datetime import UTC, datetime

import pytest
from sqlalchemy import event, func, select

from oracle import autonomy
from oracle.db import get_engine
from oracle.decisions.models import Decision
from oracle.docs.parser import DraftError, parse_draft
from oracle.mcp.scopes import required_scope
from oracle.pricing import frontmatter
from oracle.quality.models import OutcomeRecord
from oracle.runs import flows
from oracle.runs.models import Checkpoint
from oracle.swarm import FakeRuntime, set_runtime
from oracle.templates import builtins
from oracle.templates.validation import check_template
from oracle.tenancy import tenant_session
from oracle.trash.regenerate import FLOWS as REGENERATE_FLOWS
from tests.baseline_helpers import make_ctx
from tests.blocker_helpers import make_entity
from tests.decision_helpers import clock, freeze, in_days  # noqa: F401
from tests.pricing_helpers import (
    FLAT,
    KEEP,
    OPTIONS,
    QUESTION,
    add_owner,
    approved_memo,
    drafted_by_run,
    memo_md,
    set_level,
    start_memo,
    started_memo,
)
from tests.update_helpers import import_md


@pytest.fixture
async def ctx():
    return await make_ctx()


@pytest.fixture
def runtime():
    fake = FakeRuntime()
    set_runtime(fake)
    yield fake
    set_runtime(None)


def _codes(version: dict) -> list[str]:
    return [w["code"] for w in version["warnings"]]


def _check(md: str, level: str | None = None):
    d = parse_draft(md)
    return frontmatter.check_import(d.front_matter, d.sections, level=level)


# --------------------------------------------------------------------------- template


def test_the_pricing_template_is_brief_first_and_ends_with_sources():
    """protects=the packaged pricing-options-memo: valid, kind pricing, one-page-brief,
    brief question, recommendation, options, the detail sections, Sources last, the kind's
    default; regenerate maps pricing to pricing_memo; fails_when=a section, the brief, the
    theme or the default differs; no_claim=the guidance prose."""
    t = builtins.BUILTIN_TEMPLATES_BY_KEY["pricing-options-memo"]
    assert t.kind == "pricing" and t.theme == "one-page-brief" and t.path.parent.name == "pricing"
    check = check_template(builtins.builtin_body(t))
    assert check.ok, check.problems
    assert check.marked_brief == ["question", "recommendation", "options"]
    keys = check.section_keys
    for key in ("willingness-to-pay", "win-loss", "usage-by-plan", "alternatives-pricing",
                "research-plan", "risks"):  # fmt: skip
        assert key in keys, key
    assert keys[-1].startswith("sources")
    assert builtins.DEFAULT_TEMPLATE_FOR_KIND["pricing"] == "pricing-options-memo"
    assert REGENERATE_FLOWS["pricing"] == "pricing_memo"


# --------------------------------------------------------------------------- unit: checks


def test_the_question_and_option_rules_refuse():
    """protects=no question, 1 option, 5 options, two recommended, a duplicate id and an
    option without its section are each refused, naming the option where there is one;
    fails_when=any imports or the message omits the option; no_claim=the HTTP path (the
    import test covers it)."""
    assert _check(memo_md("m")) == []

    def problems(md: str) -> list[str]:
        with pytest.raises(DraftError) as exc:
            _check(md)
        return [p.message for p in exc.value.problems]

    assert problems(memo_md("m", question=None))[0].startswith("Say the pricing question")
    assert "this one has 1" in problems(memo_md("m", options=OPTIONS[:1]))[0]
    five = tuple((f"o{i}", f"Option {i}", "reversible", False) for i in range(5))
    assert "this one has 5" in problems(memo_md("m", options=five))[0]
    both = tuple((o, t, r, True) for o, t, r, _ in OPTIONS)
    assert problems(memo_md("m", options=both))[0].startswith("Recommend one option at most")
    twice = (OPTIONS[0], OPTIONS[0])
    assert any("keep is listed twice" in m for m in problems(memo_md("m", options=twice)))
    missing = problems(memo_md("m", sections=("keep",)))
    assert missing == [
        "Option flat-team has no section: add ### <title> {#option-flat-team} under Options"
    ]


def test_the_warnings_uncited_price_research_plan_and_levels():
    """protects=a price in Options with no data point row warns uncited_figure naming it;
    an empty research plan warns no_research_plan; a run's draft at Recommend without a
    recommendation warns no_recommendation and one at Draft with one warns
    recommended_at_draft; a person's import gets neither level warning;
    fails_when=a cited price warns, an uncited one does not, or a level warning fires on the
    wrong level; no_claim=what counts as a price beyond $, EUR, GBP and percentages."""
    uncited = _check(memo_md("m", bodies={"flat-team": "Teams pay $450 a month, 15% more."}))
    assert [w.code for w in uncited] == ["uncited_figure"]
    assert "$450" in uncited[0].message and "15%" in uncited[0].message
    assert uncited[0].section_keys == ["option-flat-team"]
    assert [w.code for w in _check(memo_md("m", research_plan=""))] == ["no_research_plan"]
    none = tuple((o, t, r, False) for o, t, r, _ in OPTIONS)
    assert [w.code for w in _check(memo_md("m", options=none), "recommend")] == [
        "no_recommendation"
    ]
    assert _check(memo_md("m", options=none), None) == []
    assert [w.code for w in _check(memo_md("m"), "draft")] == ["recommended_at_draft"]
    assert _check(memo_md("m"), "recommend") == []


def test_a_long_run_of_digits_is_parsed_in_linear_time():
    """protects=50,000 digits with no unit in an option section are checked in well under
    100 ms, and the prices found are the ones found before; fails_when=the price pattern
    retries from every digit (seconds per import); no_claim=other sections (no prices read
    there)."""
    # A line holds at most 20,000 characters (oracle.docs.parser): five lines of 10,000.
    digits = "\n".join(["1" * 10_000] * 5)
    d = parse_draft(memo_md("m", bodies={"flat-team": f"{digits} then $450 a month, 15% more."}))
    start = time.perf_counter()
    uncited = frontmatter.check_import(d.front_matter, d.sections, level=None)
    elapsed = time.perf_counter() - start
    assert elapsed < 0.1, elapsed
    assert [w.code for w in uncited] == ["uncited_figure"]
    assert "$450" in uncited[0].message and "15%" in uncited[0].message
    found = [
        [m.group(0).strip() for m in frontmatter._PRICE.finditer(text)]
        for text in (
            KEEP,
            FLAT,
            "Up 15% to €1,200 or 20 USD, 3 percent, 12.5 euros, $2.5k, £30m, "
            "1,000 dollars; 7 apples, 45,000",
        )
    ]
    assert found == [
        ["$20"],
        ["$400"],
        ["15%", "€1,200", "20 USD", "3 percent", "12.5 euros", "$2.5k", "£30m", "1,000 dollars"],
    ]


# --------------------------------------------------------------------------- start


async def test_an_approver_starts_a_memo_for_approvers_and_a_commenter_cannot(client, ctx):
    """protects=POST /v1/drafts kind pricing by an approver creates the memo with
    visibility approvers, the template's sections, the question and a six-month evidence
    window; a commenter gets 403; fails_when=the memo is company-wide, a section or the
    question is missing, or a commenter starts one; no_claim=the UI's dialog."""
    resp = await start_memo(client, ctx, who="commenter")
    assert resp.status_code == 403
    resp = await start_memo(client, ctx)
    assert resp.status_code == 201, resp.text
    out = resp.json()
    assert out["kind"] == "pricing" and out["template"] == "pricing-options-memo"
    assert out["theme"] == "one-page-brief"
    approver = ctx.as_("approver")
    doc = (await client.get(f"/v1/documents/{out['slug']}", headers=approver)).json()
    assert doc["visibility"] == "approvers"
    v1 = (await client.get(f"/v1/documents/{out['slug']}/versions/1", headers=approver)).json()
    keys = [s["section_key"] for s in v1["sections"]]
    assert {"question", "recommendation", "options", "research-plan", "sources"} <= set(keys)
    assert [s["section_key"] for s in v1["sections"] if s["layer"] == "brief"][:3] == [
        "question",
        "recommendation",
        "options",
    ]
    assert v1["front_matter"]["question"] == QUESTION
    assert v1["front_matter"]["evidence_window"]["to"]


@pytest.mark.parametrize(
    ("now", "window"),
    [
        # 03:00 UTC on Sep 1 is still Aug 31 in America/Los_Angeles; six calendar months
        # back from Aug 31 is Feb 28 (182 days would be Mar 2).
        ("2026-09-01T03:00:00+00:00", {"from": "2026-02-28", "to": "2026-08-31"}),
        ("2026-10-23T18:00:00+00:00", {"from": "2026-04-23", "to": "2026-10-23"}),
    ],
)
async def test_the_default_evidence_window_is_six_calendar_months_to_the_company_day(
    client, ctx, monkeypatch, now, window
):
    """protects=a memo started without a period has the evidence window from the same day
    six calendar months back (the month's last day when it has fewer days) through today in
    the Company time zone; fails_when=the window is 182 days, or ends on the server's (UTC)
    day; no_claim=the dialog's prefilled window (web/e2e/pricing.spec.ts 10a)."""
    freeze(monkeypatch, datetime.fromisoformat(now).astimezone(UTC))
    slug = await started_memo(client, ctx)
    v1 = (await client.get(f"/v1/documents/{slug}/versions/1", headers=ctx.as_("approver"))).json()
    assert v1["front_matter"]["evidence_window"] == window


async def test_import_refuses_the_rules_over_http_and_takes_a_good_memo(client, ctx):
    """protects=a person's import of a memo with one option, or an option without its
    section, is a 422 naming it; a well-formed memo imports as version 2 with the uncited
    price and empty research plan warnings when they apply; fails_when=a bad memo imports
    or a good one is refused; no_claim=the run's import (the run test covers it)."""
    slug = await started_memo(client, ctx)
    approver = ctx.as_("approver")
    resp = await import_md(client, approver, slug, memo_md(slug, options=OPTIONS[:1]))
    assert resp.status_code == 422
    resp = await import_md(client, approver, slug, memo_md(slug, sections=("keep",)))
    assert resp.status_code == 422
    assert "flat-team" in resp.json()["errors"][0]["message"]
    resp = await import_md(
        client,
        approver,
        slug,
        memo_md(slug, bodies={"flat-team": "Teams pay $450 a month."}, research_plan=""),
    )
    assert resp.status_code == 201, resp.text
    assert resp.json()["number"] == 2
    assert set(_codes(resp.json())) >= {"uncited_figure", "no_research_plan"}


async def test_approving_a_memo_is_an_owners(client, ctx):
    """protects=an approver's approval of a pricing memo is 403 "Only an owner can approve a
    pricing memo", an owner's is 200; fails_when=an approver approves it or the owner is
    refused; no_claim=the review bar."""
    slug = await started_memo(client, ctx)
    resp = await import_md(client, ctx.as_("approver"), slug, memo_md(slug))
    assert resp.status_code == 201, resp.text
    resp = await client.post(
        f"/v1/documents/{slug}/versions/2/approve", headers=ctx.as_("approver")
    )
    assert resp.status_code == 403
    assert resp.json()["detail"] == "Only an owner can approve a pricing memo"
    resp = await client.post(f"/v1/documents/{slug}/versions/2/approve", headers=ctx.as_("owner"))
    assert resp.status_code == 200, resp.text


# --------------------------------------------------------------------------- the run


def test_flow_wiring_tools_and_read_scopes():
    """protects=pricing_memo as the spec writes it: researcher then writer, owner checkpoint
    pricing_review that imports the draft, a pricing document, not in the New run dialog
    but pointing to Company › Market › Pricing; tools only of landed picks (no H5 or H7
    tools); run tokens read deal-outcomes, pricing-memos (read:baseline) and interviews
    (read:sources); pricing_input is wired at Recommend with Recommend its ceiling;
    fails_when=a role, checkpoint, tool, scope or level differs; no_claim=the agents' output
    quality."""
    flow = flows.FLOWS["pricing_memo"]
    assert flow.requires_document and flow.target_kind is None
    assert flow.document_kinds == ("pricing",) and not flow.in_new_run_dialog
    assert flow.default_depth == "standard"
    assert flow.starts_from == (
        "Draft with Oracle · Company › Market › Pricing",
        "/company/market?tab=pricing",
    )
    (segment,) = flow.segments
    assert segment.roles == ("researcher", "writer")
    assert segment.checkpoint == "pricing_review" and segment.approver_role == "owner"
    assert segment.imports_draft and segment.outputs_for("pricing") == ("pricing.md",)
    assert {"list_deal_outcomes", "list_interviews", "get_interview", "get_baseline",
            "get_strategy_stack", "list_decisions", "list_outcomes", "push_draft",
            "get_autonomy"} <= set(segment.tools)  # fmt: skip
    assert not {"list_metrics", "get_metric", "list_competitors", "get_competitor"} & set(
        segment.tools
    )
    assert set(segment.tools) <= set(flows.MCP_TOOLS)
    assert required_scope("GET", "/v1/deal-outcomes") == "read:baseline"
    assert required_scope("GET", "/v1/pricing-memos") == "read:baseline"
    assert required_scope("GET", "/v1/interviews/{interview_id}") == "read:sources"
    r = autonomy.REGISTRY["pricing_input"]
    assert r.ceiling == "recommend" and r.default == "recommend" and r.wired
    assert "Pricing" in autonomy.STAYS_WITH_PEOPLE


async def test_the_run_estimates_10_and_stops_at_an_owners_pricing_review(client, ctx, runtime):
    """protects=an approver's pricing_memo run estimates $10.00 at standard depth; its
    prompt names only landed tools and the pricing owner rule; the fake draft imports as
    version 2 with a pricing_review checkpoint an approver cannot approve and an owner can;
    fails_when=the estimate, depth, kind or role differ, or the draft is not imported;
    no_claim=P3's spend control."""
    slug = await started_memo(client, ctx)
    run = await drafted_by_run(client, ctx, runtime, slug, memo_md(slug))
    assert run["knobs"]["depth"] == "standard"
    assert run["status"] == "awaiting_checkpoint", run
    est = run.get("estimate_usd") or run.get("estimate", {}).get("total_usd")
    assert float(est) == 10.0, run
    prompt = runtime.submitted[-1].steps[-1].prompt
    assert "pricing.md" in prompt and "list_deal_outcomes" in prompt
    assert "list_metrics" not in prompt and "list_competitors" not in prompt
    assert "Never present a price as decided" in prompt
    v2 = await client.get(f"/v1/documents/{slug}/versions/2", headers=ctx.as_("owner"))
    assert v2.status_code == 200, v2.text
    async with tenant_session(ctx.tenant_id) as s:
        cp = await s.scalar(select(Checkpoint).where(Checkpoint.status == "pending"))
    assert cp is not None and cp.kind == "pricing_review" and cp.approver_role == "owner"
    path = f"/v1/runs/{run['id']}/checkpoints/{cp.id}/decide"
    resp = await client.post(path, json={"decision": "approved"}, headers=ctx.as_("approver"))
    assert resp.status_code == 403
    resp = await client.post(path, json={"decision": "approved"}, headers=ctx.as_("owner"))
    assert resp.status_code == 200, resp.text


async def test_at_draft_the_recommendation_warns_and_decide_ignores_it(client, ctx, runtime):
    """protects=with pricing_input at Draft a run's memo recommending an option imports with
    the recommended_at_draft warning, and Decide's options carry no recommendation and its
    reversibility is irreversible; fails_when=the warning is missing or the flag reaches the
    decision; no_claim=the agents' prompt compliance."""
    await set_level(client, ctx, "draft")
    slug = await started_memo(client, ctx)
    await drafted_by_run(client, ctx, runtime, slug, memo_md(slug))
    v2 = (await client.get(f"/v1/documents/{slug}/versions/2", headers=ctx.as_("owner"))).json()
    assert "recommended_at_draft" in _codes(v2)
    resp = await client.post(f"/v1/documents/{slug}/versions/2/approve", headers=ctx.as_("owner"))
    assert resp.status_code == 200, resp.text
    resp = await client.post(f"/v1/pricing-memos/{slug}/decide", headers=ctx.as_("owner"))
    assert resp.status_code == 201, resp.text
    d = resp.json()
    assert not any(o["recommended"] for o in d["options"])
    assert d["reversibility"] == "irreversible"


async def test_at_observe_the_run_is_409(client, ctx, runtime):
    """protects=with pricing_input at Observe, POST /v1/runs flow pricing_memo is 409
    "Oracle writes no pricing memo at Observe"; fails_when=a run is created; no_claim=the
    win and loss records, which stay available."""
    await set_level(client, ctx, "observe")
    slug = await started_memo(client, ctx)
    resp = await client.post(
        "/v1/runs", json={"flow": "pricing_memo", "document": slug}, headers=ctx.as_("approver")
    )
    assert resp.status_code == 409
    assert "Oracle writes no pricing memo at Observe" in resp.text


async def test_the_run_needs_a_pricing_document(client, ctx, runtime):
    """protects=the flow drafts only a pricing memo; fails_when=it runs on an update;
    no_claim=other flows' document checks."""
    from tests.update_helpers import started

    update = await started(client, ctx)
    resp = await client.post(
        "/v1/runs", json={"flow": "pricing_memo", "document": update}, headers=ctx.as_("owner")
    )
    assert resp.status_code == 422 and "pricing" in resp.text


# --------------------------------------------------------------------------- pricing owner


async def test_the_pricing_owner_defaults_to_the_earliest_owner_and_is_an_owners_setting(
    client, ctx
):
    """protects=GET /v1/settings/pricing_owner is null by default (read as the earliest
    active owner); an owner sets another active owner; an approver's id is a 422 and an
    approver cannot read or write it; fails_when=a non-owner is accepted or a non-owner
    edits it; no_claim=the Settings › Company picker."""
    second = await add_owner(ctx)
    owner = ctx.as_("owner")
    resp = await client.get("/v1/settings/pricing_owner", headers=owner)
    assert resp.status_code == 200 and resp.json()["value"] is None
    resp = await client.put(
        "/v1/settings/pricing_owner",
        json={"value": str(ctx.users["approver"].id)},
        headers=owner,
    )
    assert resp.status_code == 422
    resp = await client.put(
        "/v1/settings/pricing_owner", json={"value": str(second.id)}, headers=ctx.as_("approver")
    )
    assert resp.status_code == 403
    resp = await client.put(
        "/v1/settings/pricing_owner", json={"value": str(second.id)}, headers=owner
    )
    assert resp.status_code == 200, resp.text
    assert resp.json()["value"] == str(second.id)


# --------------------------------------------------------------------------- Decide


async def test_decide_before_approval_is_409_and_by_another_owner_403(client, ctx):
    """protects=Decide on a memo whose latest version is not approved is 409; by an owner
    who is not the pricing owner it is 403 naming the pricing owner; by an approver also
    403; fails_when=a decision is created in either case; no_claim=the header's waiting
    line."""
    await add_owner(ctx)
    slug = await started_memo(client, ctx)
    resp = await import_md(client, ctx.as_("approver"), slug, memo_md(slug))
    assert resp.status_code == 201, resp.text
    resp = await client.post(f"/v1/pricing-memos/{slug}/decide", headers=ctx.as_("owner"))
    assert resp.status_code == 409
    resp = await client.post(f"/v1/documents/{slug}/versions/2/approve", headers=ctx.as_("owner"))
    assert resp.status_code == 200, resp.text
    for who in ("second", "approver"):
        resp = await client.post(f"/v1/pricing-memos/{slug}/decide", headers=ctx.as_(who))
        assert resp.status_code == 403, who
        assert resp.json()["detail"] == "Only Owner decides prices"
    async with tenant_session(ctx.tenant_id) as s:
        assert await s.scalar(select(func.count()).select_from(Decision)) == 1  # the approval


async def test_decide_proposes_one_decision_with_the_memos_options(client, ctx):
    """protects=the pricing owner's Decide creates one proposed decision: origin pricing,
    source pricing_memo_version, title "Price: <question>", the memo's options (key, label,
    first paragraph, recommended), the pricing owner as approver, the recommended option's
    reversibility, owners and approvers informed, the memo and version as subjects; a
    second Decide returns the same decision; the memo list shows it; fails_when=a field
    differs, a second decision is created, or the list omits it; no_claim=deciding it (the
    next test)."""
    slug = await approved_memo(client, ctx)
    owner = ctx.as_("owner")
    resp = await client.post(f"/v1/pricing-memos/{slug}/decide", headers=owner)
    assert resp.status_code == 201, resp.text
    d = resp.json()
    assert d["status"] == "proposed" and d["origin"] == "pricing"
    assert d["title"] == f"Price: {QUESTION}" and d["question"] == QUESTION
    assert [(o["key"], o["label"], o["recommended"]) for o in d["options"]] == [
        ("keep", "Keep per-seat pricing", False),
        ("flat-team", "Flat price per team", True),
    ]
    assert d["options"][1]["summary"].startswith("Teams of 10 to 50 pay $400")
    assert d["approver_id"] == str(ctx.users["owner"].id)
    assert d["reversibility"] == "irreversible"
    assert d["context"].startswith("Test a flat team price")
    assert {str(ctx.users["owner"].id), str(ctx.users["approver"].id)} <= set(d["informed_ids"])
    assert {s["kind"] for s in d["subjects"]} == {"document", "document_version"}
    again = await client.post(f"/v1/pricing-memos/{slug}/decide", headers=owner)
    assert again.status_code == 200 and again.json()["id"] == d["id"]
    async with tenant_session(ctx.tenant_id) as s:
        row = await s.scalar(select(Decision).where(Decision.origin == "pricing"))
        assert row.source_kind == "pricing_memo_version"
        assert await s.scalar(
            select(func.count()).select_from(Decision).where(Decision.origin == "pricing")
        ) == 1  # fmt: skip
    memos = (await client.get("/v1/pricing-memos", headers=ctx.as_("approver"))).json()
    (memo,) = memos
    assert memo["slug"] == slug and memo["state"] == "approved" and memo["question"] == QUESTION
    assert memo["decision"]["number"] == d["number"] and memo["decision"]["status"] == "proposed"


async def test_the_memo_list_names_the_pricing_owner_for_the_header(client, ctx):
    """protects=GET /v1/pricing-memos tells an approver who the pricing owner is (id and
    name), the earliest active owner by default and the setting's owner once an owner
    changes it, so the memo header shows Decide to that owner only and "Waiting for <name>
    to decide" to the others (the setting itself is an owner's read); fails_when=the
    pricing owner is missing, or the list keeps naming the earlier owner after the change;
    no_claim=the header itself (web/e2e/pricing.spec.ts)."""
    second = await add_owner(ctx)
    await started_memo(client, ctx)
    approver = ctx.as_("approver")
    (memo,) = (await client.get("/v1/pricing-memos", headers=approver)).json()
    assert memo["pricing_owner"] == {"id": str(ctx.users["owner"].id), "name": "Owner"}
    resp = await client.put(
        "/v1/settings/pricing_owner", json={"value": str(second.id)}, headers=ctx.as_("owner")
    )
    assert resp.status_code == 200, resp.text
    (memo,) = (await client.get("/v1/pricing-memos", headers=approver)).json()
    assert memo["pricing_owner"]["id"] == str(second.id)


async def test_the_memo_list_reads_the_latest_versions_in_one_query(client, ctx):
    """protects=GET /v1/pricing-memos reads every memo's latest version together: three memos
    take as many statements as one; fails_when=the list reads one version per memo;
    no_claim=the list's contents (the tests above)."""
    await started_memo(client, ctx)
    approver = ctx.as_("approver")
    statements: list[str] = []

    def count(conn, cursor, statement, *args):
        statements.append(statement)

    async def listed() -> int:
        statements.clear()
        engine = get_engine().sync_engine
        event.listen(engine, "before_cursor_execute", count)
        try:
            resp = await client.get("/v1/pricing-memos", headers=approver)
        finally:
            event.remove(engine, "before_cursor_execute", count)
        assert resp.status_code == 200, resp.text
        return len(statements)

    one = await listed()
    await started_memo(client, ctx)
    await started_memo(client, ctx)
    assert len((await client.get("/v1/pricing-memos", headers=approver)).json()) == 3
    assert await listed() == one


async def test_the_pricing_owner_decides_it_irreversibly_with_a_prediction(client, ctx):
    """protects=the pricing owner decides the proposal through the decision log with the
    irreversible option, a reason, an expected outcome and a prediction on a goal: it is
    decided, one H3 outcome record exists, and the memo list says decided with the chosen
    label; fails_when=the irreversible choice is refused for an owner, no outcome record is
    created, or the memo state stays approved; no_claim=H3's later assessment."""
    goal = await make_entity(ctx, "goal", "team-plan-revenue")
    slug = await approved_memo(client, ctx)
    owner = ctx.as_("owner")
    d = (await client.post(f"/v1/pricing-memos/{slug}/decide", headers=owner)).json()
    resp = await client.post(
        f"/v1/decisions/{d['number']}/decide",
        json={
            "option_key": "flat-team",
            "rationale": "Teams ask for one price; a third of losses were on price.",
            "reversibility": "irreversible",
            "expected_outcome": "More teams of 10 to 50 pick the Team plan.",
            "prediction": {
                "goal_id": str(goal),
                "metric": "Team plan conversions per month",
                "baseline": "20",
                "predicted": "30",
                "threshold": "25",
                "by": in_days(120),
            },
        },
        headers=owner,
    )
    assert resp.status_code == 200, resp.text
    assert resp.json()["status"] == "decided" and resp.json()["outcome_id"]
    async with tenant_session(ctx.tenant_id) as s:
        assert await s.scalar(select(func.count()).select_from(OutcomeRecord)) == 1
    (memo,) = (await client.get("/v1/pricing-memos", headers=owner)).json()
    assert memo["state"] == "decided"
    assert memo["decision"]["chosen_label"] == "Flat price per team"


async def test_a_later_memo_replaces_the_earlier_decision(client, ctx):
    """protects=Decide with replaces D-<n> links the new proposal with supersedes_id;
    fails_when=the link is dropped; no_claim=the superseded status (set when the new one is
    decided, H1's path)."""
    first = await approved_memo(client, ctx)
    owner = ctx.as_("owner")
    d1 = (await client.post(f"/v1/pricing-memos/{first}/decide", headers=owner)).json()
    second = await approved_memo(client, ctx)
    resp = await client.post(
        f"/v1/pricing-memos/{second}/decide", json={"replaces": d1["number"]}, headers=owner
    )
    assert resp.status_code == 201, resp.text
    async with tenant_session(ctx.tenant_id) as s:
        row = await s.scalar(select(Decision).where(Decision.number == resp.json()["number"]))
    assert str(row.supersedes_id) == d1["id"]
