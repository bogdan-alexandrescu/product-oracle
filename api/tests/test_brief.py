"""O1f: brief and full layers, Present mode's deck, and the Brief / Full / Deck exports."""

import io
import os
import re

import pytest
from pptx import Presentation
from pypdf import PdfReader
from sqlalchemy import select

from oracle.docs import layers
from oracle.docs.models import DocumentVersion
from oracle.export.pdf import pdf_available
from oracle.templates.builtins import BUILTIN_TEMPLATES, builtin_body, ensure_builtins
from oracle.templates.models import Template, TemplateVersion
from oracle.templates.validation import check_template
from oracle.tenancy import tenant_session
from tests.conftest import seed_company
from tests.test_priorities import _token

requires_pdf = pytest.mark.skipif(
    not os.environ.get("ORACLE_REQUIRE_PDF") and not pdf_available(),
    reason="WeasyPrint system libraries (Pango) not installed; see api/Dockerfile",
)

BRIEF_KEYS = [
    "summary",
    "goal-trace",
    "problem",
    "brief-items",
    "brief-roadmap",
    "non-goals",
    "top-risks",
    "decisions",
]

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

## Summary {#summary}
We will cut checkout to one page for returning buyers.

```notes
Open with the drop-off number.
```

## Goal trace {#goal-trace}
- Activation: more first orders this quarter.

## Problem {#problem}
Returning buyers abandon at the shipping step.

## Features by milestone {#brief-items}
| Milestone | Feature | Goal | Outcome |
|---|---|---|---|
| [Beta](#milestone-beta) | [Saved addresses](#feature-saved-addresses) | Activation | Less typing |
|  | [One-page checkout](#feature-one-page) | Activation | One step to pay |

## Roadmap {#brief-roadmap}
- [Beta](#milestone-beta): returning buyers pay in one step.

## Non-goals {#non-goals}
- Redesigning guest checkout.

## Top risks {#top-risks}
- Payment provider limits: test with the provider first. See [Risks](#risks).

## Decisions needed {#decisions}
- Approve the beta scope: owner the founder, needed by 2026-11-01.

# Full version {#full}

## Feature detail {#feature-detail}

### Saved addresses {#feature-saved-addresses}
Buyers pick a saved address instead of typing it.

### One-page checkout {#feature-one-page}
Shipping, payment and review on one page.

## Milestones {#milestones}

### Beta {#milestone-beta}
Returning buyers in two regions; exit when drop-off falls.

## Risks and open questions {#risks}
- Payment provider limits, likelihood medium.

## Sources and data points {#sources}

### Sources {#sources-list}
- c1 slack Drop-off thread [c:c1]
- c2 notion Funnel review [c:c2]
"""

DETAIL_ONLY = """---
title: Notes
---

# Notes {#title}

## Background {#background}
Text.

## Sources and data points {#sources}
"""


async def _import(client, h, md: str, doc: str = "checkout"):
    return await client.post(
        f"/v1/documents/{doc}/versions",
        content=md.encode(),
        headers={**h, "Content-Type": "text/markdown"},
    )


@pytest.fixture
async def doc(client, tenant_id):
    h = await _token(tenant_id, "approver")
    await seed_company(tenant_id)
    resp = await _import(client, h, DRAFT)
    assert resp.status_code == 201, resp.text
    return h


def _sections(version: dict) -> dict[str, dict]:
    return {s["section_key"]: s for s in version["sections"]}


# --- template markers and validation -----------------------------------------------


def test_every_builtin_marks_a_brief_with_the_o1f_shape():
    for t in BUILTIN_TEMPLATES:
        check = check_template(builtin_body(t))
        assert check.ok and not check.warnings, (t.key, check.problems, check.warnings)
        brief = check.brief_sections
        assert brief == check.marked_brief, t.key
        keys = check.section_keys
        # Brief first, then the "Full version" heading, then detail, sources last.
        assert keys.index("full") > max(keys.index(k) for k in brief), t.key
        assert brief[0] in ("summary", "decision"), t.key
        assert brief[1] in ("goal-trace", "goals"), t.key
        assert brief[2] in ("problem", "problems"), t.key
        assert brief[3:5] == ["brief-items", "brief-roadmap"], t.key
        assert brief[5] in ("non-goals", "not-doing", "no-gos"), t.key
        assert brief[6:] == ["top-risks", "decisions"], t.key
        # The items table links every item and milestone to a detail section.
        body = builtin_body(t)
        items = body.split("{#brief-items}")[1].split("\n## ")[0]
        assert re.search(r"^\|.*\]\(#", items, re.M), t.key
        for target in layers.linked_sections(body):
            assert target in keys, (t.key, target)
            assert target not in brief or target == "risks", (t.key, target)


@pytest.mark.parametrize(
    ("body", "problems", "brief"),
    [
        (
            "---\nbrief: [summary]\n---\n# T {#title}\n\n## Summary {#summary}\n\n"
            "## Detail {#detail}\n\n## Sources and data points {#sources}\n",
            set(),
            ["summary"],
        ),
        (
            "# T {#title}\n\n## Summary {#summary}\n\n# Full version {#full}\n\n"
            "## Detail {#detail}\n\n## Sources and data points {#sources}\n",
            set(),
            ["summary"],
        ),
        (
            "# T {#title}\n\n## Summary {#summary}\n\n## Sources and data points {#sources}\n",
            {"no_brief_sections"},
            [],
        ),
        (
            "---\nbrief: [nope, sources, full]\n---\n# T {#title}\n\n# Full version {#full}\n\n"
            "## Sources and data points {#sources}\n",
            {
                "unknown_brief_section",
                "sources_section_brief",
                "full_section_brief",
                "no_brief_sections",
            },
            [],
        ),
        (
            "---\nbrief: summary\n---\n# T {#title}\n\n## Summary {#summary}\n\n"
            "## Sources and data points {#sources}\n",
            {"invalid_brief", "no_brief_sections"},
            [],
        ),
    ],
)
def test_template_brief_validation(body, problems, brief):
    check = check_template(body)
    # O1g: a template without brief sections is refused, not warned about.
    assert {p.code for p in check.problems} == problems
    assert check.warnings == []
    assert check.brief_sections == brief


async def test_seeding_adds_the_brief_version_to_unedited_builtins_only(tenant_id):
    async with tenant_session(tenant_id) as s:
        assert await ensure_builtins(s)
        await s.commit()
        assert not await ensure_builtins(s)
        # Simulate a company seeded before O1f: each built-in's only version has an old
        # body; one-pager was then edited by a user.
        for key, by_user in (("pr-faq", False), ("one-pager", True)):
            t = await s.scalar(select(Template).where(Template.key == key))
            v = await s.scalar(select(TemplateVersion).where(TemplateVersion.template_id == t.id))
            v.body = v.body.replace("brief: [", "old_brief: [")
            if by_user:
                v.created_by = t.id
        await s.commit()
        assert await ensure_builtins(s)
        await s.commit()
        versions = {}
        for key in ("pr-faq", "one-pager"):
            t = await s.scalar(select(Template).where(Template.key == key))
            versions[key] = list(
                await s.scalars(
                    select(TemplateVersion.version).where(TemplateVersion.template_id == t.id)
                )
            )
        assert sorted(versions["pr-faq"]) == [1, 2]
        assert versions["one-pager"] == [1]


async def _versions(s, key):
    t = await s.scalar(select(Template).where(Template.key == key))
    return list(
        await s.scalars(
            select(TemplateVersion)
            .where(TemplateVersion.template_id == t.id)
            .order_by(TemplateVersion.version)
        )
    )


async def _make_pre_o1f(s, key):
    """Drop the packaged skeleton from every version, as in a company seeded before O1f."""
    for v in await _versions(s, key):
        v.body = v.body.replace("brief: [", "old_brief: [")
    await s.commit()


@pytest.mark.parametrize("change", ["edited", "archived"])
async def test_seeding_leaves_an_edited_or_archived_default_template_alone(
    client, tenant_id, change
):
    h = await _token(tenant_id)
    await seed_company(tenant_id)
    if change == "edited":
        versions = (await client.get("/v1/templates/oracle-default", headers=h)).json()["versions"]
        body = versions[-1]["body"]
        edited = body.replace("## ", "## Our ", 1)
        resp = await client.patch("/v1/templates/oracle-default", json={"body": edited}, headers=h)
        assert resp.status_code == 200, resp.text
    else:
        assert (await client.delete("/v1/templates/oracle-default", headers=h)).status_code == 200
    async with tenant_session(tenant_id) as s:
        before = [v.version for v in await _versions(s, "oracle-default")]
        await _make_pre_o1f(s, "oracle-default")
        assert await ensure_builtins(s) is False
        await s.commit()
        assert [v.version for v in await _versions(s, "oracle-default")] == before


async def test_first_edit_of_a_stale_builtin_keeps_the_edit(client, tenant_id):
    h = await _token(tenant_id)
    await seed_company(tenant_id)
    async with tenant_session(tenant_id) as s:
        await _make_pre_o1f(s, "pr-faq")
        old_body = (await _versions(s, "pr-faq"))[-1].body
    edited = old_body.replace("## ", "## Our ", 1)
    resp = await client.patch("/v1/templates/pr-faq", json={"body": edited}, headers=h)
    assert resp.status_code == 200, resp.text
    async with tenant_session(tenant_id) as s:
        versions = await _versions(s, "pr-faq")
    # v2 is the seeded brief skeleton, v3 the user's edit on top of it.
    assert [(v.version, v.created_by is None) for v in versions] == [
        (1, True),
        (2, True),
        (3, False),
    ]
    assert versions[-1].body == edited


# --- a version records its brief ------------------------------------------------------


async def test_import_records_brief_sections_from_the_template(client, doc):
    v = (await client.get("/v1/documents/checkout/versions/1", headers=doc)).json()
    # DRAFT has no front matter brief: oracle-default v2's markers apply.
    assert v["brief_source"] == "template"
    sections = _sections(v)
    assert [k for k, s in sections.items() if s["layer"] == "brief"] == BRIEF_KEYS
    for key in ("title", "full", "feature-detail", "milestone-beta", "risks", "sources"):
        assert sections[key]["layer"] == "detail"
    # Presenter notes come only from a notes block (O1g): the template's guidance for
    # the problem section is not used; detail has none.
    assert sections["summary"]["notes"] == "Open with the drop-off number."
    assert sections["problem"]["notes"] is None
    assert sections["feature-detail"]["notes"] is None


async def test_started_draft_carries_the_brief_in_its_front_matter(client, tenant_id):
    h = await _token(tenant_id, "approver")
    out = (
        await client.post(
            "/v1/drafts",
            json={"kind": "roadmap", "title": "Next year", "template": "now-next-later"},
            headers=h,
        )
    ).json()
    md = (await client.get(f"/v1/documents/{out['slug']}/versions/1/markdown", headers=h)).text
    assert 'brief: ["summary", "goals", "problems", "brief-items"' in md
    v = (await client.get(f"/v1/documents/{out['slug']}/versions/1", headers=h)).json()
    assert v["brief_source"] == "draft"
    assert [s["section_key"] for s in v["sections"] if s["layer"] == "brief"][:3] == [
        "summary",
        "goals",
        "problems",
    ]


async def test_draft_without_markers_uses_the_full_version_heading(client, tenant_id):
    h = await _token(tenant_id, "approver")
    md = (
        "---\ntitle: Imported\n---\n\n# Imported {#title}\n\n## Summary {#summary}\nShort.\n\n"
        "## Asks {#asks}\nOne.\n\n# Full version {#full}\n\n## Detail {#detail}\nLong.\n"
    )
    assert (await _import(client, h, md, "imported")).status_code == 201
    v = (await client.get("/v1/documents/imported/versions/1", headers=h)).json()
    assert v["brief_source"] == "full_heading"
    assert {k: s["layer"] for k, s in _sections(v).items()} == {
        "title": "detail",
        "summary": "brief",
        "asks": "brief",
        "full": "detail",
        "detail": "detail",
    }


async def test_draft_front_matter_brief_wins_and_is_checked(client, tenant_id):
    h = await _token(tenant_id, "approver")
    await seed_company(tenant_id)
    own = DRAFT.replace('template_version: "2"\n', 'template_version: "2"\nbrief: [problem]\n')
    assert (await _import(client, h, own)).status_code == 201
    v = (await client.get("/v1/documents/checkout/versions/1", headers=h)).json()
    assert v["brief_source"] == "draft"
    assert [s["section_key"] for s in v["sections"] if s["layer"] == "brief"] == ["problem"]
    bad = DRAFT.replace('template_version: "2"\n', 'template_version: "2"\nbrief: [nope]\n')
    resp = await _import(client, h, bad, "bad")
    assert resp.status_code == 422
    assert [e["code"] for e in resp.json()["errors"]] == ["unknown_brief_section"]


async def test_version_without_a_brief_opens_full_and_has_no_brief_exports(client, tenant_id):
    h = await _token(tenant_id, "approver")
    assert (await _import(client, h, DETAIL_ONLY, "notes")).status_code == 201
    v = (await client.get("/v1/documents/notes/versions/1", headers=h)).json()
    assert v["brief_source"] == "none" and all(s["layer"] == "detail" for s in v["sections"])
    base = "/v1/documents/notes/versions/1"
    for q in ("layer=brief&format=html", "layer=deck&format=pptx"):
        resp = await client.get(f"{base}/export?{q}", headers=h)
        assert resp.status_code == 422 and "no brief" in resp.json()["detail"]
    assert (await client.get(f"{base}/deck", headers=h)).status_code == 422
    assert (await client.get(f"{base}/export?format=html", headers=h)).status_code == 200


# --- review in both layers ------------------------------------------------------------


async def test_comments_verdicts_and_diffs_name_the_layer(client, tenant_id, doc):
    commenter = await _token(tenant_id, "commenter")
    base = "/v1/documents/checkout/versions/1"
    anchor = {"exact": "Returning buyers", "prefix": "", "suffix": ""}
    c = await client.post(
        f"{base}/comments",
        json={"section_key": "problem", "anchor": anchor, "body": "Which buyers?"},
        headers=commenter,
    )
    assert c.status_code == 201 and c.json()["layer"] == "brief"
    d = await client.post(
        f"{base}/comments",
        json={
            "section_key": "milestone-beta",
            "anchor": {"exact": "two regions", "prefix": "", "suffix": ""},
            "body": "Which ones?",
        },
        headers=commenter,
    )
    assert d.json()["layer"] == "detail"
    reply = await client.post(
        f"/v1/comments/{c.json()['id']}/replies", json={"body": "Repeat"}, headers=commenter
    )
    assert reply.json()["layer"] == "brief"
    listed = (await client.get(f"{base}/comments", headers=commenter)).json()
    assert {x["section_key"]: x["layer"] for x in listed} == {
        "problem": "brief",
        "milestone-beta": "detail",
    }
    verdict = await client.put(
        f"{base}/sections/summary/review", json={"verdict": "approved"}, headers=doc
    )
    assert verdict.status_code == 200 and verdict.json()["layer"] == "brief"

    v2 = DRAFT.replace(
        "## Goal trace {#goal-trace}",
        "## Why it matters {#why}\nIt does.\n\n## Goal trace {#goal-trace}",
    ).replace('template_version: "2"\n', 'template_version: "2"\nbrief: [summary, why, problem]\n')
    assert (await _import(client, doc, v2)).status_code == 201
    diff = (await client.get("/v1/documents/checkout/diff?from=1&to=2", headers=doc)).json()
    rows = {r["section_key"]: r for r in diff["sections"]}
    assert (rows["why"]["status"], rows["why"]["to_layer"]) == ("added", "brief")
    assert (rows["goal-trace"]["from_layer"], rows["goal-trace"]["to_layer"]) == (
        "brief",
        "detail",
    )


# --- exports --------------------------------------------------------------------------


def _headings(html: str) -> list[str]:
    return re.findall(r'<section id="([^"]+)" class="prd-section', html)


async def test_brief_html_has_the_brief_and_the_sources_appendix(client, doc):
    base = "/v1/documents/checkout/versions/1/export"
    resp = await client.get(f"{base}?layer=brief&format=html", headers=doc)
    assert resp.status_code == 200
    assert 'filename="checkout-v1-brief.html"' in resp.headers["content-disposition"]
    html = resp.text
    assert _headings(html) == BRIEF_KEYS
    assert 'class="banner-layer">Brief' in html and "Version 1" in html
    assert 'id="sources" class="sources-appendix"' in html and "Drop-off thread" in html
    # Detail is left out; links to it keep their text without the link.
    assert "Buyers pick a saved address" not in html
    assert 'data-section-ref="feature-saved-addresses">Saved addresses</span>' in html
    # Presenter notes and guidance never reach an export.
    assert "Open with the drop-off number" not in html and "<!--" not in html

    full = (await client.get(f"{base}?format=html", headers=doc)).text
    assert _headings(full)[:2] == ["title", "summary"] and "feature-saved-addresses" in _headings(
        full
    )
    assert 'href="#feature-saved-addresses"' in full and 'class="banner-layer"' not in full
    full_explicit = await client.get(f"{base}?layer=full&format=md", headers=doc)
    assert full_explicit.status_code == 200 and "{#feature-detail}" in full_explicit.text


@pytest.mark.parametrize(
    "query", ["layer=brief&format=md", "layer=full&format=pptx", "layer=deck&format=md"]
)
async def test_formats_not_offered_for_a_layer_are_rejected(client, doc, query):
    resp = await client.get(f"/v1/documents/checkout/versions/1/export?{query}", headers=doc)
    assert resp.status_code == 422


async def test_deck_json_for_present_mode(client, tenant_id, doc):
    viewer = await _token(tenant_id, "viewer")
    resp = await client.get("/v1/documents/checkout/versions/1/deck", headers=viewer)
    assert resp.status_code == 200, resp.text
    deck = resp.json()
    slides = deck["slides"]
    assert [s["kind"] for s in slides] == ["title"] + ["section"] * 8 + ["sources"]
    assert [s["section_key"] for s in slides[1:-1]] == BRIEF_KEYS
    assert deck["theme"] == "clean-document" and deck["theme_class"] == "theme-clean-document"
    # The slide variant of the built-in theme comes with the shared slide CSS.
    assert ".theme-clean-document .slide-title" in deck["css"] and ".deck .slide {" in deck["css"]
    assert "Version 1" in deck["banner"] and deck["banner"] in slides[0]["html"]
    summary = slides[1]
    assert summary["notes"] == "Open with the drop-off number."
    assert "Open with" not in summary["html"]
    items = slides[4]
    assert items["heading"] == "Features by milestone"
    expandable = {e["section_key"]: e for e in items["expand"]}
    assert set(expandable) == {"milestone-beta", "feature-saved-addresses", "feature-one-page"}
    assert "Buyers pick a saved address" in expandable["feature-saved-addresses"]["html"]
    assert 'data-expand="feature-saved-addresses"' in items["html"]
    # Feature detail with sub-sections: the parent expands with its children.
    assert (
        slides[-1]["heading"] == "Sources and data points" and "Funnel review" in slides[-1]["html"]
    )


async def test_deck_slide_variant_follows_the_document_theme(client, tenant_id):
    h = await _token(tenant_id, "approver")
    out = (
        await client.post(
            "/v1/drafts",
            json={"kind": "roadmap", "title": "Plan", "template": "release-plan"},
            headers=h,
        )
    ).json()
    deck = (await client.get(f"/v1/documents/{out['slug']}/versions/1/deck", headers=h)).json()
    assert deck["theme"] == "roadmap-board" and ".theme-roadmap-board .slide" in deck["css"]
    assert len(deck["slides"]) == 1 + 8  # title + the brief sections, no sources yet


async def test_pptx_opens_with_one_slide_per_brief_section(client, tenant_id, doc):
    viewer = await _token(tenant_id, "viewer")
    resp = await client.get(
        "/v1/documents/checkout/versions/1/export?layer=deck&format=pptx", headers=viewer
    )
    assert resp.status_code == 200
    assert resp.headers["content-type"].startswith(
        "application/vnd.openxmlformats-officedocument.presentationml.presentation"
    )
    assert 'filename="checkout-v1-deck.pptx"' in resp.headers["content-disposition"]
    prs = Presentation(io.BytesIO(resp.content))
    slides = list(prs.slides)
    texts = [[sh.text_frame.text for sh in s.shapes if sh.has_text_frame] for s in slides]
    # Title slide, one slide per brief section, then the sources slide.
    assert len(slides) == 1 + len(BRIEF_KEYS) + 1
    titles = [t[0] for t in texts[1:-1]]
    assert titles == [
        "Summary",
        "Goal trace",
        "Problem",
        "Features by milestone",
        "Roadmap",
        "Non-goals",
        "Top risks",
        "Decisions needed",
    ]
    assert "Checkout PRD" in texts[0] and any("Version 1" in t for t in texts[0])
    # Every slide carries the version banner; the items table is a native table.
    assert all(any("Checkout PRD · Version 1" in t for t in ts) for ts in texts)
    tables = [sh for sh in slides[4].shapes if sh.has_table]
    assert tables and tables[0].table.cell(1, 1).text == "Saved addresses"
    assert slides[1].notes_slide.notes_text_frame.text == "Open with the drop-off number."
    assert "Drop-off thread" in " ".join(texts[-1])


@requires_pdf
async def test_brief_and_deck_pdfs(client, tenant_id, doc):
    viewer = await _token(tenant_id, "viewer")
    base = "/v1/documents/checkout/versions/1/export"
    brief = await client.get(f"{base}?layer=brief&format=pdf", headers=viewer)
    assert brief.status_code == 200 and brief.content.startswith(b"%PDF")
    text = " ".join(p.extract_text() for p in PdfReader(io.BytesIO(brief.content)).pages)
    assert "Features by milestone" in text and "Brief" in text and "Drop-off thread" in text
    assert "Buyers pick a saved address" not in text

    deck = await client.get(f"{base}?layer=deck&format=pdf", headers=viewer)
    assert deck.status_code == 200
    reader = PdfReader(io.BytesIO(deck.content))
    # One 16:9 page per slide: title + 8 brief sections + sources.
    assert len(reader.pages) == 10
    box = reader.pages[0].mediabox
    assert abs(float(box.width) / float(box.height) - 16 / 9) < 0.01
    page_texts = [p.extract_text() for p in reader.pages]
    assert "Checkout PRD" in page_texts[0] and "Version 1" in page_texts[0]
    assert "Features by milestone" in page_texts[4] and "Expand" not in page_texts[4]
    assert all("Checkout PRD · Version 1" in t for t in page_texts)


# --- roles ----------------------------------------------------------------------------


async def test_roles_for_layers_present_and_preferences(client, tenant_id, doc):
    base = "/v1/documents/checkout/versions/1"
    for path in (
        f"{base}/deck",
        f"{base}/export?layer=brief&format=html",
        f"{base}/export?layer=deck&format=pptx",
        "/v1/me/preferences",
    ):
        assert (await client.get(path)).status_code == 401
    assert (await client.patch("/v1/me/preferences", json={})).status_code == 401
    viewer = await _token(tenant_id, "viewer")
    assert (await client.get(f"{base}/deck", headers=viewer)).status_code == 200
    # Viewers read and present; importing (and so changing the brief) needs an approver.
    assert (await _import(client, viewer, DRAFT)).status_code == 403
    commenter = await _token(tenant_id, "commenter")
    assert (
        await client.put(
            f"{base}/sections/summary/review", json={"verdict": "approved"}, headers=commenter
        )
    ).status_code == 403


async def test_document_view_is_remembered_per_user(client, tenant_id):
    viewer = await _token(tenant_id, "viewer")
    other = await _token(tenant_id, "owner")
    assert (await client.get("/v1/me/preferences", headers=viewer)).json() == {
        "document_view": "brief",
        # A1: Home's Set up checklist is shown until they hide it.
        "setup_hidden": False,
        # A1: Home's welcome for invited members is shown until they dismiss it.
        "welcome_dismissed": False,
        # Slack pings: review requested and draft ready until they choose (oracle.slack.pings).
        "slack_pings": {"draft_ready": True, "review_requested": True, "comments": False,
                        "feedback_wanted": False, "published": False},
        # #723 S1: the mode they last switched to; unset, they land by role.
        "experience": None,
    }  # fmt: skip
    resp = await client.patch("/v1/me/preferences", json={"document_view": "full"}, headers=viewer)
    assert resp.status_code == 200 and resp.json()["document_view"] == "full"
    assert (await client.get("/v1/me/preferences", headers=viewer)).json()[
        "document_view"
    ] == "full"
    assert (await client.get("/v1/me/preferences", headers=other)).json()[
        "document_view"
    ] == "brief"
    again = await client.patch(
        "/v1/me/preferences", json={"document_view": "brief"}, headers=viewer
    )
    assert again.json()["document_view"] == "brief"
    bad = await client.patch("/v1/me/preferences", json={"document_view": "slides"}, headers=viewer)
    assert bad.status_code == 422


async def test_brief_source_is_stored(tenant_id, client, doc):
    async with tenant_session(tenant_id) as s:
        v = await s.scalar(select(DocumentVersion))
        assert v.brief_source == "template"
