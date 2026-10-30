"""H8 Board and investor drafts: the update document kind, its two built-in templates,
the import checks (metrics first, period, cited figures, Asks left to the owner),
owner-only start and approval, the update_draft flow, and the board update's 2-slide
deck. Against Postgres with the FakeRuntime.

Each test's card: protects=<the observable>; fails_when=<the wrong result it rejects>;
no_claim=<what green does not prove>.
"""

from datetime import UTC, datetime

import pytest
from sqlalchemy import func, select

from oracle.decisions.models import Decision
from oracle.docs.models import Document
from oracle.docs.parser import parse_draft
from oracle.mcp.scopes import required_scope
from oracle.runs import flows
from oracle.runs.models import Checkpoint
from oracle.swarm import FakeRuntime, set_runtime
from oracle.templates import builtins
from oracle.templates.validation import check_template
from oracle.tenancy import tenant_session
from oracle.updates import frontmatter
from tests.baseline_helpers import make_ctx
from tests.decision_helpers import freeze
from tests.update_helpers import (
    BOARD_ASKS,
    INVESTOR_ASKS,
    board_md,
    drafted_by_run,
    import_md,
    investor_md,
    start_update,
    started,
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


def _brief(version: dict) -> list[str]:
    return [s["section_key"] for s in version["sections"] if s["layer"] == "brief"]


# --------------------------------------------------------------------------- templates


@pytest.mark.parametrize(
    ("key", "theme", "brief", "detail"),
    [
        ("investor-update", "one-page-brief",
         ["metrics", "asks", "highlights", "lowlights", "product"], []),
        ("board-product", "roadmap-board",
         ["headline", "goals", "timeline", "shipped", "lowlights", "asks"],
         ["outcomes", "risks", "decisions"]),
    ],
)  # fmt: skip
def test_builtin_update_templates_mark_their_brief_and_end_with_sources(key, theme, brief, detail):
    """protects=the two packaged update templates: valid, kind update, fixed section ids in
    order, brief marked, Sources last, their themes, investor-update the kind's default;
    fails_when=a template lacks brief markers, a section, Sources, or names another theme;
    no_claim=the guidance prose in the comments."""
    t = builtins.BUILTIN_TEMPLATES_BY_KEY[key]
    assert t.kind == "update" and t.theme == theme and t.path.parent.name == "update"
    check = check_template(builtins.builtin_body(t))
    assert check.ok, check.problems
    assert check.marked_brief == brief
    keys = check.section_keys
    assert [k for k in keys if k in brief] == brief
    assert set(detail) <= set(keys)
    assert "sources" in keys and keys[-1].startswith("sources")
    assert builtins.DEFAULT_TEMPLATE_FOR_KIND["update"] == "investor-update"
    assert flows.KIND_NAMES["update"] == "update"


def test_builtin_update_template_names_match_their_titles():
    """protects=qa-company-38: each update template is called what its updates are titled
    ("Board update", "Investor update"), as Company › Updates names it; fails_when=the board
    template is called something else ("Board product section"); no_claim=the web's labels."""
    names = {
        k: builtins.BUILTIN_TEMPLATES_BY_KEY[k].name for k in ("board-product", "investor-update")
    }
    assert names == {"board-product": "Board update", "investor-update": "Investor update"}


# --------------------------------------------------------------------------- unit: checks


def test_section_order_and_period_checks():
    """protects=the import check refuses an investor update whose first brief section is not
    Metrics, a board update whose Goals follow its Timeline, and a draft without a period;
    fails_when=any imports or the refusal does not say "Metrics come first"; no_claim=the
    HTTP path (test_import_refuses_... covers it)."""
    from oracle.docs.parser import DraftError

    def run(md: str, template: str, brief: list[str]):
        d = parse_draft(md)
        return frontmatter.check_import(
            d.front_matter, d.sections, brief, template=template, template_body=None,
            from_run=False,
        )  # fmt: skip

    ok = investor_md("u")
    assert run(ok, "investor-update", ["metrics", "asks", "highlights"]) == []
    with pytest.raises(DraftError) as exc:
        run(investor_md("u", highlights_first=True), "investor-update", ["highlights", "metrics"])
    assert exc.value.problems[0].message.startswith("Metrics come first")
    with pytest.raises(DraftError) as exc:
        run(board_md("b", timeline_first=True), "board-product", ["headline", "timeline"])
    assert exc.value.problems[0].message.startswith("Metrics come first")
    with pytest.raises(DraftError) as exc:
        run(investor_md("u", period=None), "investor-update", ["metrics"])
    assert [p.code for p in exc.value.problems] == ["missing_period"]
    with pytest.raises(DraftError) as exc:
        run(
            investor_md("u", period="period: {from: 2026-11-01, to: 2026-10-01}"),
            "investor-update",
            ["metrics"],
        )
    assert [p.code for p in exc.value.problems] == ["invalid_period"]


def test_uncited_figures_and_the_asks_warning():
    """protects=a figure in Metrics with no data point row warns uncited_figure naming it;
    a run's Asks text other than the placeholder warns asks_written_by_oracle naming the
    section, a person's does not; fails_when=a cited figure warns, an uncited one does not,
    or the asks warning fires on the placeholder; no_claim=what counts as a number beyond
    plain digits."""

    def warnings(md: str, from_run: bool):
        d = parse_draft(md)
        return frontmatter.check_import(
            d.front_matter, d.sections, ["metrics"], template="investor-update",
            template_body=None, from_run=from_run,
        )  # fmt: skip

    assert warnings(investor_md("u"), from_run=True) == []
    uncited = warnings(investor_md("u", data_points="- 412 (c1)"), from_run=False)
    assert [w.code for w in uncited] == ["uncited_figure"]
    assert "38, 600" in uncited[0].message and uncited[0].section_keys == ["metrics"]
    asks = warnings(investor_md("u", asks="Intros to two design partners."), from_run=True)
    assert [(w.code, w.section_keys) for w in asks] == [("asks_written_by_oracle", ["asks"])]
    assert warnings(investor_md("u", asks="Intros to two design partners."), from_run=False) == []
    assert frontmatter.placeholder_of(None, "investor-update") == INVESTOR_ASKS
    assert (
        frontmatter.placeholder_of(
            builtins.builtin_body(builtins.BUILTIN_TEMPLATES_BY_KEY["board-product"]), None
        )
        == BOARD_ASKS
    )


# --------------------------------------------------------------------------- start


async def test_start_by_an_owner_opens_metrics_then_asks_and_by_an_approver_is_403(client, ctx):
    """protects=POST /v1/drafts kind update by an owner creates a draft whose first brief
    section is metrics and second asks, kept for owners and approvers, with a period; an
    approver gets 403; fails_when=the order differs, the document is company-wide, the
    period is missing, or an approver starts one; no_claim=the run started after it."""
    resp = await start_update(client, ctx, who="approver")
    assert resp.status_code == 403
    assert resp.json()["detail"] == "Only an owner can start an update"
    async with tenant_session(ctx.tenant_id) as s:
        assert await s.scalar(select(func.count()).select_from(Document)) == 0

    resp = await start_update(client, ctx)
    assert resp.status_code == 201, resp.text
    out = resp.json()
    assert out["kind"] == "update" and out["template"] == "investor-update"
    assert out["theme"] == "one-page-brief"
    v1 = (
        await client.get(f"/v1/documents/{out['slug']}/versions/1", headers=ctx.as_("owner"))
    ).json()
    assert _brief(v1)[:2] == ["metrics", "asks"]
    assert v1["front_matter"]["period"]["to"]
    doc = (await client.get(f"/v1/documents/{out['slug']}", headers=ctx.as_("owner"))).json()
    assert doc["visibility"] == "approvers" and doc["period"] is not None


async def test_the_period_follows_the_last_approved_update_of_the_template(client, ctx):
    """protects=the period defaults to the day after the last approved update of the same
    template, and previous names it; a given period is kept; fails_when=the default ignores
    the approved update or another template's; no_claim=the UI's own prefill."""
    first = await started(
        client, ctx, period={"from": "2026-09-01", "to": "2026-09-30"}, slug="investor-sep"
    )
    v1 = (await client.get(f"/v1/documents/{first}/versions/1", headers=ctx.as_("owner"))).json()
    assert v1["front_matter"]["period"] == {"from": "2026-09-01", "to": "2026-09-30"}
    resp = await client.post(f"/v1/documents/{first}/versions/1/approve", headers=ctx.as_("owner"))
    assert resp.status_code == 200, resp.text
    # A board update's own history is not the investor update's.
    board = await started(client, ctx, "board-product")
    board_v1 = (
        await client.get(f"/v1/documents/{board}/versions/1", headers=ctx.as_("owner"))
    ).json()
    assert "previous" not in board_v1["front_matter"]

    second = await started(client, ctx, slug="investor-oct")
    v1 = (await client.get(f"/v1/documents/{second}/versions/1", headers=ctx.as_("owner"))).json()
    assert v1["front_matter"]["period"]["from"] == "2026-10-01"
    assert v1["front_matter"]["previous"] == {"document": "investor-sep", "version": 1}


async def test_the_default_period_ends_on_the_company_day(client, ctx, monkeypatch):
    """protects=an update started without a period, with none before it, runs from the first
    of the Company day's month through that day: at 03:00 UTC on Sep 1 it is Aug 31 in
    America/Los_Angeles; fails_when=the period is the server's (UTC) September;
    no_claim=a period after an earlier update (the test above)."""
    freeze(monkeypatch, datetime(2026, 9, 1, 3, 0, tzinfo=UTC))
    slug = await started(client, ctx)
    v1 = (await client.get(f"/v1/documents/{slug}/versions/1", headers=ctx.as_("owner"))).json()
    assert v1["front_matter"]["period"] == {"from": "2026-08-01", "to": "2026-08-31"}


# --------------------------------------------------------------------------- import


async def test_import_refuses_metrics_out_of_order_and_a_missing_period(client, ctx):
    """protects=a person's import of an investor update with Highlights before Metrics is a
    422 "Metrics come first", one without period a 422; a well-formed one imports;
    fails_when=either imports; no_claim=board order over HTTP (the unit test covers it)."""
    slug = await started(client, ctx)
    owner = ctx.as_("owner")
    resp = await import_md(client, owner, slug, investor_md(slug, highlights_first=True))
    assert resp.status_code == 422
    assert any(p["message"].startswith("Metrics come first") for p in resp.json()["errors"])
    resp = await import_md(client, owner, slug, investor_md(slug, period=None))
    assert resp.status_code == 422
    assert [p["code"] for p in resp.json()["errors"]] == ["missing_period"]
    resp = await import_md(client, owner, slug, investor_md(slug))
    assert resp.status_code == 201, resp.text
    assert _brief(resp.json())[:2] == ["metrics", "asks"]


async def test_a_run_draft_with_its_own_asks_carries_the_warning(client, ctx, runtime):
    """protects=an update_draft run whose Asks text differs from the placeholder imports with
    the version warning asks_written_by_oracle naming asks; fails_when=it imports silently
    or is refused; no_claim=the agents' prompt compliance."""
    slug = await started(client, ctx)
    run = await drafted_by_run(
        client, ctx, runtime, slug, investor_md(slug, asks="Intros to two design partners.")
    )
    assert run["status"] == "awaiting_checkpoint", run
    v2 = (await client.get(f"/v1/documents/{slug}/versions/2", headers=ctx.as_("owner"))).json()
    (w,) = [w for w in v2["warnings"] if w["code"] == "asks_written_by_oracle"]
    assert w["section_keys"] == ["asks"]


# --------------------------------------------------------------------------- approval


async def test_approval_is_an_owners_and_is_captured_as_a_decision(client, ctx):
    """protects=an approver's approval of an update is 403 "Only an owner can approve an
    update", an owner's is 200 and captures one decision; fails_when=an approver stamps it,
    the owner is refused, or no decision is recorded; no_claim=the decision's wording."""
    slug = await started(client, ctx)
    resp = await import_md(client, ctx.as_("owner"), slug, investor_md(slug))
    assert resp.status_code == 201, resp.text
    resp = await client.post(
        f"/v1/documents/{slug}/versions/2/approve", headers=ctx.as_("approver")
    )
    assert resp.status_code == 403
    assert resp.json()["detail"] == "Only an owner can approve an update"
    resp = await client.post(f"/v1/documents/{slug}/versions/2/approve", headers=ctx.as_("owner"))
    assert resp.status_code == 200, resp.text
    async with tenant_session(ctx.tenant_id) as s:
        decisions = list(await s.scalars(select(Decision)))
    assert len(decisions) == 1 and "Investor update" in decisions[0].title


# --------------------------------------------------------------------------- the flow


def test_flow_wiring_and_read_scopes():
    """protects=update_draft as the spec writes it (owner checkpoint update_review, analyst +
    writer, the tools) and run tokens with read:baseline reading tracks, milestones and
    roadmaps; fails_when=a role, checkpoint, tool or scope differs; no_claim=the agents'
    output quality."""
    flow = flows.FLOWS["update_draft"]
    assert flow.requires_document and flow.target_kind is None
    assert flow.document_kinds == ("update",) and not flow.in_new_run_dialog
    (segment,) = flow.segments
    assert segment.roles == ("analyst", "writer")
    assert segment.checkpoint == "update_review" and segment.approver_role == "owner"
    assert segment.imports_draft and segment.outputs_for("update") == ("update.md",)
    assert {"list_tracks", "list_track_milestones", "list_outcomes", "list_decisions",
            "list_launches", "push_draft"} <= set(segment.tools)  # fmt: skip
    assert set(segment.tools) <= set(flows.MCP_TOOLS)
    assert "Leave Asks as the template placeholder" in segment.task
    for path in ("/v1/tracks", "/v1/tracks/{track_id}/milestones", "/v1/roadmaps/{doc}/items"):
        assert required_scope("GET", path) == "read:baseline", path


async def test_update_draft_estimates_and_stops_at_an_owners_update_review(client, ctx, runtime):
    """protects=the update_draft run estimates $4.50 at quick depth (an investor update's
    default) and $9.00 at standard (a board update's default), and its checkpoint is
    update_review for owners, which an approver cannot decide nor an approver create;
    fails_when=the estimate, defaults, kind or role differ; no_claim=P3's spend control."""
    owner = ctx.as_("owner")
    investor = await started(client, ctx)
    board = await started(client, ctx, "board-product")
    resp = await client.post(
        "/v1/runs", json={"flow": "update_draft", "document": investor}, headers=ctx.as_("approver")
    )
    assert resp.status_code == 403

    for slug, depth, usd in ((investor, "quick", 4.5), (board, "standard", 9.0)):
        resp = await client.post(
            "/v1/runs", json={"flow": "update_draft", "document": slug}, headers=owner
        )
        assert resp.status_code == 201, resp.text
        run = resp.json()
        assert run["knobs"]["depth"] == depth
        est = await client.post(f"/v1/runs/{run['id']}/estimate", headers=owner)
        assert est.status_code == 200 and est.json()["total_usd"] == usd, est.text
    resp = await client.post(
        "/v1/runs",
        json={"flow": "update_draft", "document": investor, "knobs": {"depth": "standard"}},
        headers=owner,
    )
    est = await client.post(f"/v1/runs/{resp.json()['id']}/estimate", headers=owner)
    assert est.json()["total_usd"] == 9.0

    run = await drafted_by_run(client, ctx, runtime, investor, investor_md(investor))
    async with tenant_session(ctx.tenant_id) as s:
        cp = await s.scalar(select(Checkpoint).where(Checkpoint.status == "pending"))
    assert cp is not None and cp.kind == "update_review" and cp.approver_role == "owner"
    prompt = runtime.submitted[-1].steps[-1].prompt
    assert "update.md" in prompt and "Metrics first" in prompt
    resp = await client.post(
        f"/v1/runs/{run['id']}/checkpoints/{cp.id}/decide",
        json={"decision": "approved"},
        headers=ctx.as_("approver"),
    )
    assert resp.status_code == 403


async def test_update_draft_needs_an_update_document(client, ctx, runtime):
    """protects=the flow only drafts an update; fails_when=it runs on a PRD; no_claim=other
    flows' document checks."""
    from tests.fixtures import draft

    await import_md(client, ctx.as_("owner"), "checkout-redesign", draft("prd_v1.md"))
    resp = await client.post(
        "/v1/runs",
        json={"flow": "update_draft", "document": "checkout-redesign"},
        headers=ctx.as_("owner"),
    )
    assert resp.status_code == 422 and "update" in resp.text


# --------------------------------------------------------------------------- export


async def test_an_approved_board_update_deck_has_two_slides_goals_on_the_first(client, ctx):
    """protects=the deck of an approved board update is 2 section slides from the brief
    layer (its slide groups), the goals table on slide 1, the timeline on slide 2; the
    PPTX exports; fails_when=one slide per brief section, or the goals elsewhere;
    no_claim=the slides' visual fit."""
    slug = await started(client, ctx, "board-product")
    owner = ctx.as_("owner")
    resp = await import_md(client, owner, slug, board_md(slug))
    assert resp.status_code == 201, resp.text
    resp = await client.post(f"/v1/documents/{slug}/versions/2/approve", headers=owner)
    assert resp.status_code == 200, resp.text
    deck = (await client.get(f"/v1/documents/{slug}/versions/2/deck", headers=owner)).json()
    sections = [s for s in deck["slides"] if s["kind"] == "section"]
    assert len(sections) == 2
    assert sections[0]["section_key"] == "headline" and "<table" in sections[0]["html"]
    assert "Weekly active teams" in sections[0]["html"]
    assert sections[1]["section_key"] == "timeline" and "Bulk import" in sections[1]["html"]
    resp = await client.get(
        f"/v1/documents/{slug}/versions/2/export",
        params={"format": "pptx", "layer": "deck"},
        headers=owner,
    )
    assert resp.status_code == 200, resp.text


# --------------------------------------------------------------------------- isolation


async def test_another_companys_update_is_404_everywhere(client, ctx):
    """protects=an update's routes answer 404 for another company's owner (the visibility
    PATCH included); fails_when=any returns it or changes it; no_claim=the tenancy layer's
    own tests."""
    slug = await started(client, ctx)
    other = await make_ctx("Other Co")
    them = other.as_("owner")
    for path in (f"/v1/documents/{slug}", f"/v1/documents/{slug}/versions/1",
                 f"/v1/documents/{slug}/versions/1/markdown",
                 f"/v1/documents/{slug}/versions/1/export",
                 f"/v1/documents/{slug}/versions/1/deck"):  # fmt: skip
        assert (await client.get(path, headers=them)).status_code == 404, path
    resp = await client.patch(
        f"/v1/documents/{slug}/visibility",
        json={"visibility": "company", "reason": "x"},
        headers=them,
    )
    assert resp.status_code == 404
    assert (await client.get("/v1/documents?kind=update", headers=them)).json() == []
    resp = await client.post(f"/v1/documents/{slug}/versions/1/approve", headers=them)
    assert resp.status_code == 404


async def test_runs_and_inbox_name_the_update_by_its_own_title(client, ctx, runtime):
    """protects=qa-company-17: a new update's update_draft run carries the document's own
    title ("Investor update · October 2026") in the runs list and on its Inbox checkpoint,
    so Home and the Inbox name it as the update's page does; fails_when=document_title is
    missing or differs (the web then shows the slug in words, "Investor update october
    2026"); no_claim=the web's wording around it."""
    slug = await started(client, ctx)
    run = await drafted_by_run(client, ctx, runtime, slug, investor_md(slug))
    owner = ctx.as_("owner")
    runs = (await client.get("/v1/runs", headers=owner)).json()
    row = next(r for r in runs if r["id"] == run["id"])
    assert row["document_slug"] == slug
    assert row["document_title"] == "Investor update · October 2026"
    inbox = (await client.get("/v1/inbox", headers=owner)).json()
    cps = [c for c in inbox["checkpoints"] if c["run_id"] == run["id"]]
    assert cps and all(c["document_title"] == "Investor update · October 2026" for c in cps)
