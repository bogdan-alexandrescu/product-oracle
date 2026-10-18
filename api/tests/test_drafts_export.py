"""New-draft picker, starting a draft from a template, and exports with themes."""

import io
import os

import pytest
from pypdf import PdfReader

from oracle.baseline.models import Entity
from oracle.export.pdf import page_count, pdf_available
from oracle.templates.schemas import PrdAnswers, RoadmapAnswers
from oracle.templates.service import recommend_prd, recommend_roadmap
from oracle.tenancy import tenant_session
from tests.test_priorities import _token

requires_pdf = pytest.mark.skipif(
    not os.environ.get("ORACLE_REQUIRE_PDF") and not pdf_available(),
    reason="WeasyPrint system libraries (Pango) not installed; see api/Dockerfile",
)


# --- picker rules -------------------------------------------------------------------


@pytest.mark.parametrize(
    ("answers", "key"),
    [
        ({}, "oracle-default"),
        ({"decision": "start_or_not"}, "one-pager"),
        ({"decision": "start_or_not", "model_driven": True}, "one-pager"),
        ({"decision": "technical_design"}, "prd-rfc"),
        ({"decision": "choose_between"}, "narrative-memo"),
        ({"decision": "bet_fixed_time"}, "shape-up-pitch"),
        ({"decision": "bet_fixed_time", "size": "new_product"}, "pr-faq"),
        ({"decision": "commit_build", "size": "new_product"}, "pr-faq"),
        ({"decision": "commit_build", "model_driven": True}, "ai-feature"),
        ({"decision": "commit_build", "readers": "leadership"}, "narrative-memo"),
        ({"size": "small_change", "readers": "founder"}, "one-pager"),
        ({"decision": "commit_build", "readers": "engineers_or_agents"}, "oracle-default"),
        (
            {"decision": "commit_build", "size": "new_feature", "readers": "product_eng"},
            "oracle-default",
        ),
    ],
)
def test_prd_recommendations(answers, key):
    got, reason = recommend_prd(PrdAnswers(**answers))
    assert got == key
    assert reason and "\n" not in reason


@pytest.mark.parametrize(
    ("answers", "key", "variant"),
    [
        ({}, "now-next-later", "team"),
        ({"audience": "board"}, "outcome-roadmap", "board"),
        ({"audience": "engineering"}, "release-plan", "engineering"),
        ({"audience": "public"}, "now-next-later", "public"),
        ({"audience": "team", "external_dates": True}, "quarterly-timeline", "team"),
        ({"horizon": "one_cycle"}, "cycle-bets", "team"),
        ({"planning_style": "cycles", "audience": "board"}, "cycle-bets", "board"),
        ({"horizon": "one_two_quarters", "teams": 3}, "quarterly-timeline", "team"),
        ({"horizon": "up_to_two_years", "teams": 1}, "now-next-later", "team"),
    ],
)
def test_roadmap_recommendations(answers, key, variant):
    got, reason, options, _ = recommend_roadmap(RoadmapAnswers(**answers), confirmed_goals=3)
    assert got == key and options["variant"] == variant and reason


def test_roadmap_warnings():
    _, _, _, warnings = recommend_roadmap(RoadmapAnswers(audience="board"), confirmed_goals=1)
    assert any("thin" in w for w in warnings)
    _, _, options, warnings = recommend_roadmap(
        RoadmapAnswers(
            show_capacity=True,
            tracker_connected=False,
            public_version=True,
            horizon="one_cycle",
            teams=2,
        ),
        confirmed_goals=3,
    )
    assert options["show_capacity"] is False and options["group_by"] == "team"
    assert any("no dates" in w for w in warnings)
    assert any("public version renders as Now / Next / Later" in w for w in warnings)


async def test_recommend_api_uses_baseline_goals_and_company_default(client, tenant_id):
    viewer = await _token(tenant_id, "viewer")
    owner = await _token(tenant_id)
    resp = await client.post(
        "/v1/drafts/recommend",
        json={"kind": "roadmap", "roadmap": {"audience": "board"}},
        headers=viewer,
    )
    rec = resp.json()
    assert rec["template"]["key"] == "outcome-roadmap"
    assert rec["theme"]["key"] == "roadmap-board"
    assert rec["confirmed_goals"] == 0 and rec["warnings"]
    assert len(rec["templates"]) == 5 and [t["key"] for t in rec["themes"]] == ["roadmap-board"]

    async with tenant_session(tenant_id) as s:
        for k in ("a", "b"):
            s.add(Entity(type="goal", key=k, title=k, status="confirmed", origin="user"))
        await s.commit()
    rec = (
        await client.post(
            "/v1/drafts/recommend",
            json={"kind": "roadmap", "roadmap": {"audience": "board"}},
            headers=viewer,
        )
    ).json()
    assert rec["confirmed_goals"] == 2 and rec["warnings"] == []

    # Company default: owners only; used when no question is answered.
    default = {"prd": {"template": "one-pager", "theme": "editorial-memo"}}
    assert (
        await client.put("/v1/drafts/defaults", json=default, headers=viewer)
    ).status_code == 403
    assert (await client.put("/v1/drafts/defaults", json=default, headers=owner)).status_code == 200
    rec = (await client.post("/v1/drafts/recommend", json={"kind": "prd"}, headers=viewer)).json()
    assert rec["template"]["key"] == "one-pager" and rec["theme"]["key"] == "editorial-memo"
    assert rec["company_default"] == {"template": "one-pager", "theme": "editorial-memo"}
    rec = (
        await client.post(
            "/v1/drafts/recommend",
            json={"kind": "prd", "prd": {"decision": "technical_design"}},
            headers=viewer,
        )
    ).json()
    assert rec["template"]["key"] == "prd-rfc" and rec["theme"]["key"] == "technical-spec"
    bad = {"roadmap": {"template": "one-pager"}}
    assert (await client.put("/v1/drafts/defaults", json=bad, headers=owner)).status_code == 422

    # An archived recommendation falls back and says so.
    await client.delete("/v1/templates/prd-rfc", headers=owner)
    rec = (
        await client.post(
            "/v1/drafts/recommend",
            json={"kind": "prd", "prd": {"decision": "technical_design"}},
            headers=viewer,
        )
    ).json()
    assert rec["template"]["key"] == "one-pager"
    assert any("archived" in w for w in rec["warnings"])


# --- start a draft ------------------------------------------------------------------


async def test_start_draft_creates_document_from_skeleton(client, tenant_id):
    h = await _token(tenant_id, "approver")
    viewer = await _token(tenant_id, "viewer")
    body = {"kind": "prd", "title": "Saved carts", "template": "pr-faq"}
    assert (await client.post("/v1/drafts", json=body, headers=viewer)).status_code == 403
    resp = await client.post("/v1/drafts", json=body, headers=h)
    assert resp.status_code == 201, resp.text
    out = resp.json()
    assert out["slug"] == "saved-carts" and out["template_version"] == 1
    assert out["theme"] == "press-release" and out["version"] == 1

    doc = (await client.get("/v1/documents/saved-carts", headers=h)).json()
    assert doc["template"] == "pr-faq" and doc["template_version"] == "1"
    md = (await client.get("/v1/documents/saved-carts/versions/1/markdown", headers=h)).text
    assert md.startswith('---\ndocument: saved-carts\ntitle: "Saved carts"\nkind: prd\n')
    assert "theme: press-release" in md and "suggest_when" not in md
    assert "# Saved carts {#title}" in md and "## Press release {#press-release}" in md
    async with tenant_session(tenant_id) as s:
        from sqlalchemy import select

        from oracle.docs.models import Document

        row = await s.scalar(select(Document).where(Document.slug == "saved-carts"))
        assert (row.kind, row.theme) == ("prd", "press-release")

    # Same title again: a free slug; explicit theme and version; roadmap kind.
    again = (await client.post("/v1/drafts", json=body, headers=h)).json()
    assert again["slug"] == "saved-carts-2"
    rm = await client.post(
        "/v1/drafts",
        json={
            "kind": "roadmap",
            "title": "Q1 roadmap",
            "template": "cycle-bets",
            "theme": "clean-document",
            "slug": "q1",
        },
        headers=h,
    )
    assert rm.status_code == 201 and rm.json()["theme"] == "clean-document"
    taken = await client.post(
        "/v1/drafts",
        json={"kind": "roadmap", "title": "x", "template": "cycle-bets", "slug": "q1"},
        headers=h,
    )
    assert taken.status_code == 409
    mismatch = await client.post(
        "/v1/drafts", json={"kind": "roadmap", "title": "x", "template": "pr-faq"}, headers=h
    )
    assert mismatch.status_code == 422
    v1 = await client.post(
        "/v1/drafts",
        json={"kind": "prd", "title": "Old", "template": "oracle-default", "template_version": 1},
        headers=h,
    )
    assert v1.status_code == 201 and v1.json()["template_version"] == 1
    assert v1.json()["theme"] is None  # v1 predates themes


async def test_archived_template_keeps_its_documents_resolving(client, tenant_id):
    h = await _token(tenant_id)
    out = (
        await client.post(
            "/v1/drafts",
            json={"kind": "prd", "title": "Alerts", "template": "one-pager"},
            headers=h,
        )
    ).json()
    assert (await client.delete("/v1/templates/one-pager", headers=h)).status_code == 200
    assert (await client.delete("/v1/themes/one-page-brief", headers=h)).status_code == 200
    doc = (await client.get(f"/v1/documents/{out['slug']}", headers=h)).json()
    tv = await client.get(
        f"/v1/templates/{doc['template']}/versions/{doc['template_version']}", headers=h
    )
    assert tv.status_code == 200 and "{#goal-trace}" in tv.json()["body"]
    html = (await client.get(f"/v1/documents/{out['slug']}/versions/1/export", headers=h)).text
    assert 'name="oracle-theme" content="one-page-brief"' in html
    # No new drafts from an archived template.
    resp = await client.post(
        "/v1/drafts", json={"kind": "prd", "title": "x", "template": "one-pager"}, headers=h
    )
    assert resp.status_code == 422


# --- themed export ------------------------------------------------------------------

DRAFT = """---
document: checkout
title: Checkout PRD
template: oracle-default
template_version: "2"
citations:
  - id: c1
    source: slack
    ref: https://example.slack.com/archives/C1/p1
    title: Drop-off thread
  - id: c2
    source: notion
    ref: https://notion.so/example/funnel
    title: Funnel review
---

# Checkout PRD {#title}

## 1. Summary {#summary}
<!-- guidance that never reaches an export -->
Buyers abandon at shipping [c:c1].

## 4. Requirements {#requirements}

| Id | Requirement | Eval |
|----|-------------|------|
| R1 | Show the total early | Pass |
| R2 | Keep the cart | Fail |

## Sources and data points {#sources}

### Sources {#sources-list}
- c1: Drop-off thread [c:c1]
- c2: Funnel review [c:c2]

### Data points {#sources-data}
- 41% drop-off at shipping (September) [c:c2]
"""


async def _import(client, h, doc="checkout", markdown=DRAFT) -> None:
    resp = await client.post(
        f"/v1/documents/{doc}/versions",
        content=markdown.encode(),
        headers={**h, "Content-Type": "text/markdown"},
    )
    assert resp.status_code == 201, resp.text


async def test_export_uses_template_theme_and_o1c_appendix(client, tenant_id):
    h = await _token(tenant_id)
    await client.get("/v1/templates", headers=h)  # seeds oracle-default v2 and themes
    await _import(client, h)
    resp = await client.get("/v1/documents/checkout/versions/1/export", headers=h)
    html = resp.text
    assert resp.status_code == 200
    assert 'name="oracle-theme" content="clean-document"' in html
    assert '<nav class="toc" aria-label="Contents">' in html
    assert "As of " in html and "Version 1" in html and "Not approved" in html
    assert "Goal-traced PRD v2" in html
    assert "guidance that never reaches" not in html
    main = html.split('<main class="prd">')[1].split("</main>")[0]
    assert "[c:" not in main and 'class="src-refs"' not in main and "<sup" not in main
    assert "Buyers abandon at shipping." in main
    assert '<span class="req-id">R1</span>' in main
    assert '<td class="cell-pass">Pass</td>' in main and '<td class="cell-fail">Fail</td>' in main
    appendix = html.split('<section id="sources" class="sources-appendix"')[1]
    assert '<a href="#src-1">1</a>' in appendix and '<a href="#src-2">2</a>' in appendix
    assert 'id="sources-data"' in appendix
    assert 'href="#summary">1. Summary</a>' in appendix  # citations grouped by section
    assert 'id="src-1"' in appendix and "Drop-off thread" in appendix
    assert "--color-text: #1f2933;" in html and "size: A4 portrait" in html


async def test_document_theme_wins_and_unthemed_documents_get_the_builtin_default(
    client, tenant_id
):
    h = await _token(tenant_id)
    await _import(
        client,
        h,
        "plain",
        DRAFT.replace("document: checkout", "document: plain")
        .replace("template: oracle-default\n", "")
        .replace('template_version: "2"\n', ""),
    )
    html = (await client.get("/v1/documents/plain/versions/1/export", headers=h)).text
    # No theme, no template suggestion, no company default: the built-in default theme
    # for the kind, with the Sources and data points appendix (not the legacy stylesheet).
    assert 'content="clean-document"' in html and 'class="sources-appendix"' in html
    assert 'class="footnotes"' not in html

    out = (
        await client.post(
            "/v1/drafts",
            json={
                "kind": "roadmap",
                "title": "Roadmap",
                "template": "now-next-later",
                "theme": "editorial-memo",
            },
            headers=h,
        )
    ).json()
    html = (await client.get(f"/v1/documents/{out['slug']}/versions/1/export", headers=h)).text
    assert 'content="editorial-memo"' in html and "appendix-break" in html
    assert 'data-section-key="layout"' not in html  # roadmap layout block is for the renderer

    # Company default applies when neither the document nor its template names one.
    await client.put(
        "/v1/drafts/defaults",
        json={"prd": {"template": "oracle-default", "theme": "technical-spec"}},
        headers=h,
    )
    html = (await client.get("/v1/documents/plain/versions/1/export", headers=h)).text
    assert 'content="technical-spec"' in html and "numbered" in html


async def test_roadmap_board_layout(client, tenant_id):
    h = await _token(tenant_id)
    out = (
        await client.post(
            "/v1/drafts",
            json={"kind": "roadmap", "title": "Board", "template": "now-next-later"},
            headers=h,
        )
    ).json()
    md = (await client.get(f"/v1/documents/{out['slug']}/versions/1/markdown", headers=h)).text
    md = md.replace(
        "### {{item_title}} {#now-item}",
        "### Theme refresh {#now-item}\n\nNew colours; serves no confirmed goal.",
        1,
    )
    await _import(client, h, out["slug"], md)
    html = (await client.get(f"/v1/documents/{out['slug']}/versions/2/export", headers=h)).text
    assert "size: A4 landscape" in html and 'class="legend"' in html
    assert '<div class="section-group" data-group="now">' in html
    assert "flag-no-goal" in html and "Serves no confirmed goal" in html


@requires_pdf
async def test_themed_pdfs_render(client, tenant_id):
    h = await _token(tenant_id)
    for template in ("oracle-default", "pr-faq", "narrative-memo", "prd-rfc", "one-pager"):
        out = (
            await client.post(
                "/v1/drafts",
                json={"kind": "prd", "title": template, "template": template},
                headers=h,
            )
        ).json()
        resp = await client.get(
            f"/v1/documents/{out['slug']}/versions/1/export", params={"format": "pdf"}, headers=h
        )
        assert resp.status_code == 200 and resp.content.startswith(b"%PDF")
        text = "".join(p.extract_text() for p in PdfReader(io.BytesIO(resp.content)).pages)
        assert "Sources and data points" in text
    out = (
        await client.post(
            "/v1/drafts",
            json={"kind": "roadmap", "title": "Board", "template": "quarterly-timeline"},
            headers=h,
        )
    ).json()
    resp = await client.get(
        f"/v1/documents/{out['slug']}/versions/1/export", params={"format": "pdf"}, headers=h
    )
    page = PdfReader(io.BytesIO(resp.content)).pages[0]
    assert page.mediabox.width > page.mediabox.height  # landscape


@requires_pdf
async def test_one_page_theme_checks_the_fit(client, tenant_id):
    h = await _token(tenant_id)
    out = (
        await client.post(
            "/v1/drafts", json={"kind": "prd", "title": "Brief", "template": "one-pager"}, headers=h
        )
    ).json()
    md = (await client.get(f"/v1/documents/{out['slug']}/versions/1/markdown", headers=h)).text
    long = md.replace(
        "## Problem {#problem}", "## Problem {#problem}\n\n" + "A long paragraph of text. " * 900, 1
    )
    await _import(client, h, out["slug"], long)
    html = (await client.get(f"/v1/documents/{out['slug']}/versions/2/export", headers=h)).text
    assert page_count(html) > 1
    pdf = (
        await client.get(
            f"/v1/documents/{out['slug']}/versions/2/export", params={"format": "pdf"}, headers=h
        )
    ).content
    first = PdfReader(io.BytesIO(pdf)).pages[0].extract_text()
    assert "meant to fit one page" in first
    short = (
        await client.get(
            f"/v1/documents/{out['slug']}/versions/1/export", params={"format": "pdf"}, headers=h
        )
    ).content
    assert "meant to fit one page" not in PdfReader(io.BytesIO(short)).pages[0].extract_text()


@requires_pdf
def test_pdf_loads_nothing_external(tmp_path):
    import http.server
    import threading

    from oracle.export.pdf import html_to_pdf

    hits: list[str] = []

    class Handler(http.server.BaseHTTPRequestHandler):
        def do_GET(self):  # noqa: N802
            hits.append(self.path)
            self.send_response(404)
            self.end_headers()

        def log_message(self, *args):
            pass

    server = http.server.HTTPServer(("127.0.0.1", 0), Handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    secret = tmp_path / "secret.css"
    secret.write_text("p { color: red }")
    try:
        port = server.server_address[1]
        html = (
            f"<html><head><link rel='stylesheet' href='file://{secret}'></head><body>"
            f"<img src='http://127.0.0.1:{port}/x.png'>"
            f"<p style=\"background:url('http://127.0.0.1:{port}/bg.png')\">x</p></body></html>"
        )
        assert html_to_pdf(html).startswith(b"%PDF")
    finally:
        server.shutdown()
    assert hits == []
