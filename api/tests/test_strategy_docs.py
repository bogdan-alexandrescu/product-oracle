"""H4 Strategy and vision, lane 1: the vision and strategy document kinds, their built-in
templates, the strategy front matter checks on import, owner-only start and approval,
and the strategy_draft flow.

Each test's card: protects=<the observable>; fails_when=<the wrong result it rejects>;
no_claim=<what green does not prove>.
"""

import pytest
from sqlalchemy import func, select

from oracle.docs.models import Document, DocumentVersion
from oracle.models import AuditEvent
from oracle.mcp.scopes import required_scope
from oracle.runs import flows
from oracle.runs.models import Checkpoint
from oracle.swarm import FakeRuntime, set_runtime
from oracle.templates import builtins
from oracle.templates.models import Template
from oracle.templates.validation import check_template
from oracle.tenancy import tenant_session
from tests.baseline_helpers import make_ctx
from tests.conftest import seed_company
from tests.strategy_helpers import (
    STRATEGY,
    VISION,
    add_entity,
    approve,
    belief,
    choice,
    import_md,
    imported,
    strategy_md,
    vision_md,
)


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


# --------------------------------------------------------------------------- templates


@pytest.mark.parametrize(
    ("key", "kind", "brief", "sections"),
    [
        (
            "vision-narrative",
            "vision",
            ["headline", "future", "for-whom", "beliefs"],
            ["why-now", "not", "horizon"],
        ),
        (
            "product-strategy",
            "strategy",
            ["summary", "focus", "stop"],
            ["insights", "company", "tradeoffs", "horizon"],
        ),
    ],
)
def test_builtin_vision_and_strategy_templates_mark_their_brief_and_end_with_sources(
    key, kind, brief, sections
):
    """protects=the two packaged templates: valid, brief marked, fixed section ids, Sources
    last, editorial-memo theme; fails_when=a template lacks brief markers, a section id or
    the Sources section, or names another theme; no_claim=the prose guidance in the
    comments."""
    t = builtins.BUILTIN_TEMPLATES_BY_KEY[key]
    assert t.kind == kind and t.theme == "editorial-memo"
    assert t.path.parent.name == kind
    check = check_template(builtins.builtin_body(t))
    assert check.ok, check.problems
    assert check.marked_brief == brief
    assert set(brief + sections) <= set(check.section_keys)
    assert check.section_keys[-1].startswith("sources")
    assert "sources" in check.section_keys
    assert builtins.DEFAULT_TEMPLATE_FOR_KIND[kind] == key


def test_kind_names_and_flow_wiring():
    """protects=KIND_NAMES and the strategy_draft flow as the spec writes them;
    fails_when=a kind has no prompt name or the flow's roles, checkpoint or approver role
    differ; no_claim=the agents' output quality."""
    assert flows.KIND_NAMES["vision"] == "vision"
    assert flows.KIND_NAMES["strategy"] == "product strategy"
    flow = flows.FLOWS["strategy_draft"]
    assert flow.requires_document and flow.target_kind is None
    (segment,) = flow.segments
    assert segment.roles == ("researcher", "writer", "critic")
    assert segment.checkpoint == "strategy_review" and segment.approver_role == "owner"
    assert segment.imports_draft
    assert segment.outputs_for("strategy") == ("strategy.md",)
    assert "Never invent goals" in segment.task_for("strategy")
    assert "product strategy" in segment.task_for("strategy")
    assert flows.segment_estimate(segment, flows.resolve_knobs(flow, {})) == 13


def test_agents_flag_work_outside_the_strategy():
    """protects=get_strategy_stack is offered to the feature-set, PRD-draft and
    roadmap-items segments with the flag-it instruction, and run tokens with read:baseline
    read it; fails_when=a segment lacks the tool or the instruction, or the area needs
    another scope; no_claim=that agents follow it."""
    assert "get_strategy_stack" in flows.MCP_TOOLS
    for flow_key, name in (
        ("baseline_to_prd", "feature_set"),
        ("baseline_to_prd", "prd_draft"),
        ("prd_to_roadmap", "roadmap_items"),
    ):
        segment = flows.FLOWS[flow_key].segment(name)
        assert "get_strategy_stack" in segment.tools, name
        assert "never drop it silently" in segment.task, name
    assert required_scope("GET", "/v1/strategy/stack") == "read:baseline"
    assert required_scope("GET", "/v1/strategy/findings") == "read:baseline"
    assert required_scope("POST", "/v1/strategy/check") is None


async def test_company_seed_keeps_the_prd_and_roadmap_builtins_only(tenant_id):
    """protects=the vision and strategy templates are not in the company seed (the PRD and
    roadmap template lists stay as they are); fails_when=seeding adds them; no_claim=that
    they are seeded later (test_start_strategy_by_owner covers that)."""
    await seed_company(tenant_id)
    async with tenant_session(tenant_id) as s:
        keys = set(await s.scalars(select(Template.key)))
    assert "product-strategy" not in keys and "vision-narrative" not in keys
    assert len(keys) == 12


# --------------------------------------------------------------------------- start


async def test_start_strategy_by_owner_creates_version_1_from_the_builtin(client, ctx):
    """protects=POST /v1/drafts kind strategy by an owner: the document and version 1 from
    product-strategy, with the editorial-memo theme; fails_when=it is refused, makes a PRD
    or uses another template; no_claim=the run started after it."""
    resp = await client.post(
        "/v1/drafts",
        json={"kind": "strategy", "title": "Product strategy", "template": "product-strategy"},
        headers=ctx.as_("owner"),
    )
    assert resp.status_code == 201, resp.text
    out = resp.json()
    assert out["kind"] == "strategy" and out["version"] == 1
    assert out["template"] == "product-strategy" and out["theme"] == "editorial-memo"
    doc = (await client.get(f"/v1/documents/{out['slug']}", headers=ctx.as_("owner"))).json()
    assert doc["kind"] == "strategy"
    v1 = (
        await client.get(f"/v1/documents/{out['slug']}/versions/1", headers=ctx.as_("owner"))
    ).json()
    keys = [s["section_key"] for s in v1["sections"]]
    assert {"summary", "focus", "stop", "sources"} <= set(keys)
    brief = [s["section_key"] for s in v1["sections"] if s["layer"] == "brief"]
    assert {"summary", "focus", "stop"} <= set(brief)


@pytest.mark.parametrize(
    ("kind", "template", "message"),
    [
        ("strategy", "product-strategy", "Only an owner can start a product strategy"),
        ("vision", "vision-narrative", "Only an owner can start a vision"),
    ],
)
async def test_start_by_an_approver_is_refused(client, ctx, kind, template, message):
    """protects=starting a vision or strategy is an owner's; fails_when=an approver gets a
    document or a different refusal; no_claim=PRD and roadmap starts (unchanged)."""
    resp = await client.post(
        "/v1/drafts",
        json={"kind": kind, "title": "Ours", "template": template},
        headers=ctx.as_("approver"),
    )
    assert resp.status_code == 403
    assert resp.json()["detail"] == message
    async with tenant_session(ctx.tenant_id) as s:
        assert await s.scalar(select(func.count()).select_from(Document)) == 0


async def test_a_strategy_template_without_brief_markers_is_refused(client, ctx):
    """protects=O1g holds for the new kind; fails_when=a strategy template with no brief
    saves; no_claim=edits of the built-ins."""
    body = "---\ntitle: x\n---\n\n# Strategy {#title}\n\n## Focus {#focus}\n\nText.\n"
    resp = await client.post(
        "/v1/templates",
        json={"key": "our-strategy", "name": "Ours", "kind": "strategy", "body": body},
        headers=ctx.as_("owner"),
    )
    assert resp.status_code == 422
    assert "no_brief_sections" in resp.text


# --------------------------------------------------------------------------- import


async def test_a_choice_without_its_section_is_refused_naming_it(client, ctx):
    """protects=every front matter choice has its {#choice-<id>} section; fails_when=the
    draft imports or the refusal does not name the choice; no_claim=the section's text."""
    md = strategy_md(
        [choice("self-serve", goals=["activation"]), choice("x", goals=["activation"])],
        without_sections=("x",),
    )
    resp = await import_md(client, ctx.as_("owner"), STRATEGY, md)
    assert resp.status_code == 422
    problems = resp.json()["problems"]
    assert any(p["code"] == "choice_without_section" and "'x'" in p["message"] for p in problems)


async def test_six_focus_choices_import_with_too_many_focus(client, ctx):
    """protects=the 'twenty high priorities' warning; fails_when=six focus choices are
    refused or import silently; no_claim=a hard cap."""
    await add_entity(ctx.tenant_id, "goal", "activation")
    md = strategy_md([choice(f"c{i}", goals=["activation"]) for i in range(6)])
    v = await imported(client, ctx.as_("owner"), STRATEGY, md)
    assert "too_many_focus" in _codes(v)
    w = next(w for w in v["warnings"] if w["code"] == "too_many_focus")
    assert w["message"] == (
        "More than 5 focus choices. Twenty high priorities overwhelm a team."
    )


async def test_unknown_keys_and_a_focus_without_goals_are_warnings(client, ctx):
    """protects=unknown goal and feature keys warn, naming the key, and a goalless focus
    warns; fails_when=they refuse the draft or say nothing; no_claim=that the goal exists
    later."""
    await add_entity(ctx.tenant_id, "goal", "activation")
    md = strategy_md(
        [
            choice("self-serve", goals=["activation", "made-up-goal"]),
            choice("lonely"),
            choice("sso", "stop", features=["no-such-feature"]),
        ]
    )
    v = await imported(client, ctx.as_("owner"), STRATEGY, md)
    by_code = {w["code"]: w["message"] for w in v["warnings"]}
    assert "made-up-goal" in by_code["unknown_goal"]
    assert "no-such-feature" in by_code["unknown_feature"]
    assert "lonely" in by_code["focus_without_goal"]
    assert "too_many_focus" not in by_code


async def test_malformed_choices_and_beliefs_are_refused(client, ctx):
    """protects=choices and beliefs are validated on import; fails_when=a choice with an
    unknown stance, a duplicate id or a belief with no statement imports; no_claim=other
    front matter keys."""
    bad_stance = strategy_md([choice("a", "maybe")])
    resp = await import_md(client, ctx.as_("owner"), STRATEGY, bad_stance)
    assert resp.status_code == 422 and "invalid_choice" in resp.text
    dup = strategy_md([choice("a", goals=[]), choice("a", goals=[])])
    resp = await import_md(client, ctx.as_("owner"), STRATEGY, dup)
    assert resp.status_code == 422 and "invalid_choice" in resp.text
    md = vision_md([{"id": "b1"}])  # type: ignore[list-item]
    resp = await import_md(client, ctx.as_("owner"), VISION, md)
    assert resp.status_code == 422 and "invalid_belief" in resp.text


async def test_a_vision_imports_with_its_beliefs(client, ctx):
    """protects=a vision draft imports as kind vision; fails_when=it becomes a PRD or is
    refused; no_claim=the graph sync (test_strategy_sync)."""
    md = vision_md([belief("b1", "Teams plan weekly"), belief("b2", "Founders decide")])
    v = await imported(client, ctx.as_("owner"), VISION, md)
    assert v["number"] == 1
    async with tenant_session(ctx.tenant_id) as s:
        assert await s.scalar(select(Document.kind).where(Document.slug == VISION)) == "vision"


# --------------------------------------------------------------------------- approval


@pytest.mark.parametrize(
    ("slug", "markdown", "message"),
    [
        (STRATEGY, strategy_md([choice("self-serve", goals=[])]),
         "Only an owner can approve a product strategy"),
        (VISION, vision_md([belief("b1", "Teams plan weekly")]),
         "Only an owner can approve a vision"),
    ],
)  # fmt: skip
async def test_approval_is_an_owners(client, ctx, slug, markdown, message):
    """protects=owner-only approval of a vision or strategy, with section verdicts still
    open to approvers; fails_when=an approver's approval stamps the version, or the owner's
    is refused; no_claim=PRD and roadmap approval (unchanged)."""
    await imported(client, ctx.as_("owner"), slug, markdown)
    resp = await client.put(
        f"/v1/documents/{slug}/versions/1/sections/summary/review"
        if slug == STRATEGY
        else f"/v1/documents/{slug}/versions/1/sections/headline/review",
        json={"verdict": "approved"},
        headers=ctx.as_("approver"),
    )
    assert resp.status_code == 200, resp.text

    resp = await approve(client, ctx.as_("approver"), slug, 1)
    assert resp.status_code == 403
    assert resp.json()["detail"] == message
    async with tenant_session(ctx.tenant_id) as s:
        version = await s.scalar(select(DocumentVersion))
        assert version.approved_at is None
        assert await s.scalar(
            select(func.count()).select_from(AuditEvent).where(
                AuditEvent.action == "version.approve"
            )
        ) == 0  # fmt: skip

    resp = await approve(client, ctx.as_("owner"), slug, 1)
    assert resp.status_code == 200, resp.text
    assert resp.json()["document_status"] == "approved"


# --------------------------------------------------------------------------- the flow


async def _strategy_document(client, ctx) -> str:
    resp = await client.post(
        "/v1/drafts",
        json={"kind": "strategy", "title": "Product strategy", "template": "product-strategy"},
        headers=ctx.as_("owner"),
    )
    assert resp.status_code == 201, resp.text
    return resp.json()["slug"]


async def test_strategy_draft_run_estimates_13_and_stops_at_an_owners_review(
    client, ctx, runtime
):
    """protects=the strategy_draft run: $13.00 at standard depth, its checkpoint is
    strategy_review for owners, an approver's decision is refused; fails_when=the estimate,
    kind or role differ, or an approver decides; no_claim=the draft's content."""
    slug = await _strategy_document(client, ctx)
    owner = ctx.as_("owner")
    resp = await client.post(
        "/v1/runs",
        json={"flow": "strategy_draft", "document": slug, "knobs": {"depth": "standard"}},
        headers=owner,
    )
    assert resp.status_code == 201, resp.text
    run = resp.json()
    est = await client.post(f"/v1/runs/{run['id']}/estimate", headers=owner)
    assert est.status_code == 200, est.text
    assert est.json()["estimate_usd"] == 13.0
    resp = await client.post(f"/v1/runs/{run['id']}/start", headers=owner)
    assert resp.status_code == 200, resp.text
    prompt = runtime.submitted[0].steps[-1].prompt
    assert "strategy.md" in prompt and "product strategy" in prompt
    tick = await client.post("/v1/internal/tick", headers=ctx.as_("token"))
    assert tick.status_code == 200, tick.text

    async with tenant_session(ctx.tenant_id) as s:
        cp = await s.scalar(select(Checkpoint).where(Checkpoint.status == "pending"))
    assert cp is not None, "the run did not reach its review"
    assert cp.kind == "strategy_review" and cp.approver_role == "owner"
    resp = await client.post(
        f"/v1/runs/{run['id']}/checkpoints/{cp.id}/decide",
        json={"decision": "approved"},
        headers=ctx.as_("approver"),
    )
    assert resp.status_code == 403


async def test_strategy_draft_needs_a_vision_or_strategy_document(client, ctx, runtime):
    """protects=the flow only drafts a vision or strategy; fails_when=it runs on a PRD;
    no_claim=other flows' document checks."""
    prd = vision_md([belief("b1", "x")]).replace("kind: vision", "kind: prd")
    await imported(client, ctx.as_("owner"), "some-prd", prd.replace("document: vision",
                                                                      "document: some-prd"))
    resp = await client.post(
        "/v1/runs",
        json={"flow": "strategy_draft", "document": "some-prd"},
        headers=ctx.as_("owner"),
    )
    assert resp.status_code == 422
    assert "vision or a product strategy" in resp.text
