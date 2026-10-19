"""Legacy PRD drafts: `{#id}` headings, YAML front matter and `resolutions`, brief and
full markers, `notes` blocks and the Sources and data points appendix parse, diff and
export exactly as they do today (build prompt §16.1, O1c, O1f, O1g)."""

import io
import os
import re

import pytest
from pypdf import PdfReader
from sqlalchemy import select

from oracle.export.pdf import pdf_available
from oracle.review.models import FeedbackItem
from oracle.tenancy import tenant_session
from tests.fixtures import seed_auth
from tests.legacy.helpers import (
    DOC,
    FEEDBACK_ADDRESSED,
    FEEDBACK_DECLINED,
    add_feedback,
    fixture,
    import_md,
)

requires_pdf = pytest.mark.skipif(
    not os.environ.get("ORACLE_REQUIRE_PDF") and not pdf_available(),
    reason="WeasyPrint system libraries (Pango) not installed; see api/Dockerfile",
)

V1 = fixture("legacy_prd_v1.md")
V2 = fixture("legacy_prd_v2.md")

# (key, level, layer, citation keys, section hash) of legacy_prd_v1.md as parsed today.
# The hash is sha256(level, heading, body): a parser change that alters any of these
# changes what reviewers' verdicts and locked sections are anchored to.
V1_SECTIONS = [
    ("title", 1, "detail", [], "2724c850f93e48c1dedcc16b661a67d38151dc4404fdd4f93b8c279baa7eda36"),
    ("summary", 2, "brief", [], "da89ad9b2ae50f413577775434dff3455c1d1f6ee89a17c644b1e35dc195368c"),
    (
        "goal-trace",
        2,
        "brief",
        ["c1"],
        "bb7185cde34f7df97186796ef5b2cee57098ad3b9359a920f6ec3944fd2c45d2",
    ),
    (
        "problem",
        2,
        "brief",
        ["c2"],
        "23029139347079bc7b7b06662317e42c9c049bba78f57a80034d160376003e39",
    ),
    ("full", 1, "detail", [], "2f203329ae0aa4028ca66bb9d2ea528494566877bd84b7a72f4759bb0d2e1661"),
    (
        "requirements",
        2,
        "detail",
        [],
        "cce55fd62de27ad399523e36c162f00b0d37b0d8ebfdbac0c827537387ab3da6",
    ),
    (
        "req-checklist",
        3,
        "detail",
        [],
        "5b321d54cdc0bf851456ff56ac6e6fb7e22f509f097b30e8c1a94369e27f5d5a",
    ),
    (
        "req-invite",
        3,
        "detail",
        [],
        "33c4117c12721f899e489cdbe947aadf80aae4d4f122b243f3bb3bedd3e22d3e",
    ),
    ("risks", 2, "detail", [], "22914634611659838b200cfd7548e671612bb89badfce9950e4b52031c7d66fe"),
    (
        "sources",
        2,
        "detail",
        ["c2", "c1"],
        "933444a503649a2734f174a9a15cae536788f1d28319ad499bfb713b59f74b6b",
    ),
]
V1_CONTENT_HASH = "4111cbeab3e924f7969f9b63495b705cea5e5838c012fe15162b5b1794a820a2"
BRIEF_KEYS = ["summary", "goal-trace", "problem"]


def sections_of(version: dict) -> list[tuple]:
    return [
        (s["section_key"], s["level"], s["layer"], s["citation_keys"], s["content_hash"])
        for s in version["sections"]
    ]


def main_of(html: str) -> str:
    return html.split('<main class="prd">', 1)[1].split("</main>", 1)[0]


async def _v1(client):
    tenant_id, auth = await seed_auth()
    resp = await import_md(client, auth, V1)
    assert resp.status_code == 201, resp.text
    return tenant_id, auth, resp.json()


async def test_legacy_prd_parses_to_the_pinned_sections(client):
    _, auth, v1 = await _v1(client)
    assert v1["number"] == 1 and v1["warnings"] == []
    assert v1["content_hash"] == V1_CONTENT_HASH
    assert v1["brief_source"] == "full_heading"
    assert v1["snapshot"] == "2026-09-01T09:00Z"
    assert sections_of(v1) == V1_SECTIONS
    assert [s["ordinal"] for s in v1["sections"]] == list(range(1, 11))
    # A level-4 heading stays in its parent's body; it is not a section.
    invite = next(s for s in v1["sections"] if s["section_key"] == "req-invite")
    assert "#### Edge cases" in invite["body_md"]
    # Presenter notes come only from a `notes` block (O1g).
    notes = {s["section_key"]: s["notes"] for s in v1["sections"] if s["notes"]}
    assert notes == {"summary": "Open with the week-one setup number."}
    assert sorted(v1["front_matter"]) == [
        "citations",
        "document",
        "snapshot",
        "template",
        "template_version",
        "title",
    ]
    cites = {c["cite_key"]: (c["source"], c["ref"]) for c in v1["citations"]}
    assert cites == {
        "c1": ("slack", "https://example.slack.com/archives/C000/p1000"),
        "c2": ("gdocs", "https://docs.example.com/d/activation-review"),
    }

    doc = (await client.get(f"/v1/documents/{DOC}", headers=auth)).json()
    assert (doc["kind"], doc["title"], doc["status"]) == (
        "prd",
        "Onboarding checklist PRD",
        "draft",
    )
    # Reads return the stored version unchanged.
    again = (await client.get(f"/v1/documents/{DOC}/versions/1", headers=auth)).json()
    assert sections_of(again) == V1_SECTIONS


async def test_markdown_round_trips_byte_for_byte(client):
    _, auth, _ = await _v1(client)
    md = await client.get(f"/v1/documents/{DOC}/versions/1/markdown", headers=auth)
    assert md.status_code == 200 and md.text == V1
    # Re-importing the same content returns the existing version, not a new one.
    same = await import_md(client, auth, V1)
    assert same.status_code == 200 and same.json()["number"] == 1


async def test_markdown_export_is_the_draft_with_a_banner_after_front_matter(client):
    _, auth, _ = await _v1(client)
    resp = await client.get(f"/v1/documents/{DOC}/versions/1/export?format=md", headers=auth)
    assert resp.status_code == 200
    assert resp.headers["content-disposition"] == 'attachment; filename="legacy-onboarding-v1.md"'
    front, body = V1.split("\n---\n", 1)
    exported = resp.text
    assert exported.startswith(front + "\n---\n")
    banner, rest = exported[len(front) + 5 :].split("\n", 1)
    assert re.fullmatch(
        r"<!-- Product Oracle export: Onboarding checklist PRD \(legacy-onboarding\)"
        r" · version 1 · status draft · imported .+ UTC -->",
        banner,
    )
    assert rest.strip() == body.strip()


async def test_html_full_export_keeps_citations_out_of_the_body(client):
    _, auth, _ = await _v1(client)
    resp = await client.get(f"/v1/documents/{DOC}/versions/1/export?format=html", headers=auth)
    assert resp.status_code == 200
    html = resp.text
    body = main_of(html)
    keys = re.findall(r'data-section-key="([^"]+)"', body)
    assert keys == [k for k, *_ in V1_SECTIONS if k != "sources"]
    # O1c: no citation chips, notes or evidence markers in the narrative body.
    assert "[c:" not in body and "src-refs" not in body
    assert "week-one setup number" not in html
    # The appendix sits after the body and lists evidence by section.
    appendix = html.split("</main>", 1)[1]
    assert '<section id="sources" class="sources-appendix"' in appendix
    assert 'id="sources-by-section"' in appendix
    assert '<a class="section-link" href="#goal-trace">Goal trace</a>' in appendix
    assert '<a class="section-link" href="#problem">Problem</a>' in appendix
    assert "[1] #product thread on setup" in appendix and "[2] Activation review" in appendix


async def test_brief_layer_exports_only_brief_sections_and_the_appendix(client):
    _, auth, _ = await _v1(client)
    base = f"/v1/documents/{DOC}/versions/1/export"
    html = (await client.get(f"{base}?format=html&layer=brief", headers=auth)).text
    assert re.findall(r'data-section-key="([^"]+)"', main_of(html)) == BRIEF_KEYS
    assert '<section id="sources" class="sources-appendix"' in html
    assert "Brief: the full document has the detail" in html
    # The brief layer is html or pdf only; markdown is the full draft.
    md = await client.get(f"{base}?format=md&layer=brief", headers=auth)
    assert md.status_code == 422


async def test_deck_has_one_slide_per_brief_section_with_notes_only_from_notes_blocks(client):
    _, auth, _ = await _v1(client)
    deck = await client.get(f"/v1/documents/{DOC}/versions/1/deck", headers=auth)
    assert deck.status_code == 200, deck.text
    slides = deck.json()["slides"]
    assert [(s["kind"], s["section_key"]) for s in slides[: len(BRIEF_KEYS) + 1]] == [
        ("title", None),
        *[("section", k) for k in BRIEF_KEYS],
    ]
    assert {s["kind"] for s in slides[len(BRIEF_KEYS) + 1 :]} == {"sources"}
    notes = {s["section_key"]: s["notes"] for s in slides if s["kind"] == "section"}
    assert notes["summary"] == "Open with the week-one setup number."
    assert notes["goal-trace"] is None and notes["problem"] is None
    base = f"/v1/documents/{DOC}/versions/1/export"
    pptx = await client.get(f"{base}?format=pptx&layer=deck", headers=auth)
    assert pptx.status_code == 200 and pptx.content[:2] == b"PK"
    printable = await client.get(f"{base}?format=html&layer=deck", headers=auth)
    assert printable.status_code == 200


async def test_v2_applies_resolutions_and_diffs_by_section(client):
    tenant_id, auth, v1 = await _v1(client)
    await add_feedback(tenant_id, v1["document_id"])
    resp = await import_md(client, auth, V2)
    assert resp.status_code == 201, resp.text
    v2 = resp.json()
    assert v2["number"] == 2 and v2["warnings"] == []
    assert "resolutions" in v2["front_matter"]
    async with tenant_session(tenant_id) as s:
        items = {i.id: i for i in await s.scalars(select(FeedbackItem))}
    assert (items[FEEDBACK_ADDRESSED].status, items[FEEDBACK_ADDRESSED].addressed_in_version) == (
        "addressed",
        2,
    )
    assert items[FEEDBACK_ADDRESSED].resolution_note == "Named the invite form defaults."
    assert items[FEEDBACK_DECLINED].status == "declined"

    diff = await client.get(f"/v1/documents/{DOC}/diff", params={"from": 1, "to": 2}, headers=auth)
    assert diff.status_code == 200, diff.text
    statuses = {d["section_key"]: (d["status"], d["moved"]) for d in diff.json()["sections"]}
    unchanged = ("unchanged", False)
    assert statuses == {
        "title": unchanged,
        "summary": unchanged,
        "goal-trace": unchanged,
        "problem": unchanged,
        "full": unchanged,
        "requirements": unchanged,
        "req-checklist": unchanged,
        "req-invite": ("changed", False),
        "risks": ("changed", False),
        "rollout": ("added", False),
        "sources": unchanged,
    }
    layers = {d["section_key"]: (d["from_layer"], d["to_layer"]) for d in diff.json()["sections"]}
    assert layers["summary"] == ("brief", "brief")
    assert layers["rollout"] == (None, "detail")


async def test_unknown_resolution_ids_still_reject_the_import(client):
    _, auth, _ = await _v1(client)
    resp = await import_md(client, auth, V2)  # no feedback items exist
    assert resp.status_code == 422
    assert [e["code"] for e in resp.json()["errors"]] == ["unknown_feedback_item"] * 2


async def test_legacy_drafts_without_brief_markers_still_import(client):
    _, auth = await seed_auth()
    detail_only = V1.replace("# Full version {#full}\n\n", "").replace(
        "document: legacy-onboarding", "document: legacy-detail-only"
    )
    resp = await import_md(client, auth, detail_only, doc="legacy-detail-only")
    assert resp.status_code == 201, resp.text
    v = resp.json()
    assert v["brief_source"] == "none"
    assert {s["layer"] for s in v["sections"]} == {"detail"}
    brief = await client.get(
        "/v1/documents/legacy-detail-only/versions/1/export?format=html&layer=brief", headers=auth
    )
    full = await client.get(
        "/v1/documents/legacy-detail-only/versions/1/export?format=html", headers=auth
    )
    assert full.status_code == 200
    # A version with no brief has no brief export (it opens full).
    assert brief.status_code in (404, 409, 422)


@requires_pdf
async def test_full_and_brief_pdfs_render_with_the_appendix(client):
    _, auth, _ = await _v1(client)
    base = f"/v1/documents/{DOC}/versions/1/export"
    full = await client.get(f"{base}?format=pdf", headers=auth)
    assert full.status_code == 200 and full.content.startswith(b"%PDF")
    text = " ".join(p.extract_text() for p in PdfReader(io.BytesIO(full.content)).pages)
    assert "Invite step" in text and "Sources and data points" in text
    assert "[c:" not in text
    brief = await client.get(f"{base}?format=pdf&layer=brief", headers=auth)
    assert brief.status_code == 200
    text = " ".join(p.extract_text() for p in PdfReader(io.BytesIO(brief.content)).pages)
    assert "Goal trace" in text and "Invite step" not in text
