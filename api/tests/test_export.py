"""Lane 3 export: HTML / PDF / markdown with a version banner.

Versions are built directly in the database so these tests do not depend on the
import pipeline (Lane 1) or approval (Lane 2).
"""

import hashlib
import io
import os
import re
import uuid
from dataclasses import dataclass
from datetime import UTC, datetime

import pytest
from pypdf import PdfReader

from oracle.auth.service import create_api_token
from oracle.docs.models import Citation, Document, DocumentVersion, Section
from oracle.export import pdf as pdf_module
from oracle.export.pdf import PdfUnavailable, pdf_available
from oracle.export.render import render_markdown
from oracle.tenancy import tenant_session
from tests.conftest import seed_company

V1_MARKDOWN = """---
document: checkout-redesign
title: Checkout redesign PRD
---

# Checkout redesign PRD {#title}

## 1. Goal trace {#goal-trace}
Serves G1 (activation) [c:c1].
"""

SECTIONS = [
    # key, level, heading, body_md
    ("title", 1, "Checkout redesign PRD", "Intro paragraph for the redesign."),
    (
        "goal-trace",
        2,
        "1. Goal trace",
        "Serves G1 (activation) [c:c1]. Drop-off peaks at shipping [c:c2, c1].\n\n"
        "- Measure **conversion**\n- Keep <script>alert('x')</script> out",
    ),
    (
        "s-5-2",
        3,
        "5.2 Shipping step {#s-5-2}",
        "| Step | Drop-off |\n|------|----------|\n| Shipping | 41% |\n\n"
        "Rates come from the carrier API [c:c4].",
    ),
    ("open-questions", 2, "9. Open questions", "Who owns the carrier contract?"),
]

CITATIONS = [
    # key, source, ref, title, excerpt
    (
        "c1",
        "slack",
        "https://example.slack.com/archives/C123/p1700000000",
        "#product thread on drop-off",
        "Most users abandon at the shipping step",
    ),
    (
        "c2",
        "notion",
        "https://notion.so/acme/funnel-review",
        "Funnel review",
        "Shipping is the biggest leak",
    ),
    ("c3", "web", "https://example.com/unused", "Unused source", None),
    ("c4", "upload", "javascript:alert(1)", "Carrier API notes", "Rates are cached for 1h"),
]


@dataclass
class Fixture:
    tenant_id: uuid.UUID
    token: str
    document_id: uuid.UUID

    @property
    def headers(self) -> dict[str, str]:
        return {"Authorization": f"Bearer {self.token}"}


async def _add_version(
    s, doc: Document, number: int, *, approved: bool = False, sections=SECTIONS
) -> DocumentVersion:
    version = DocumentVersion(
        document_id=doc.id,
        number=number,
        markdown=V1_MARKDOWN if number == 1 else V1_MARKDOWN + f"\nRevision {number}.\n",
        content_hash=hashlib.sha256(f"v{number}".encode()).hexdigest(),
        front_matter={"document": doc.slug, "title": doc.title},
        snapshot="2026-10-16T14:00Z",
        warnings=[],
        created_at=datetime(2026, 10, 16, 14, number, tzinfo=UTC),
        approved_at=datetime(2026, 10, 17, 9, 30, tzinfo=UTC) if approved else None,
    )
    s.add(version)
    await s.flush()
    for i, (key, level, heading, body) in enumerate(sections):
        s.add(
            Section(
                version_id=version.id,
                section_key=key,
                ordinal=i,
                level=level,
                heading=heading,
                body_md=body,
                body_text=body,
                content_hash=hashlib.sha256(body.encode()).hexdigest(),
                citation_keys=re.findall(r"c\d", body),
            )
        )
    for key, source, ref, title, excerpt in CITATIONS:
        s.add(
            Citation(
                version_id=version.id,
                cite_key=key,
                source=source,
                ref=ref,
                title=title,
                excerpt=excerpt,
                retrieved_at=datetime(2026, 10, 16, 13, 10, tzinfo=UTC),
            )
        )
    return version


@pytest.fixture
async def fx(tenant_id) -> Fixture:
    await seed_company(tenant_id)
    async with tenant_session(tenant_id) as s:
        doc = Document(slug="checkout-redesign", title="Checkout redesign PRD", status="approved")
        s.add(doc)
        await s.flush()
        await _add_version(s, doc, 1)
        await _add_version(s, doc, 2, approved=True)
        _, token = await create_api_token(s, "test")
        await s.commit()
        return Fixture(tenant_id=tenant_id, token=token, document_id=doc.id)


URL = "/v1/documents/{doc}/versions/{n}/export"


async def _export(client, fx: Fixture, fmt: str, n: int = 2, doc: str = "checkout-redesign"):
    resp = await client.get(URL.format(doc=doc, n=n), params={"format": fmt}, headers=fx.headers)
    assert resp.status_code == 200, resp.text
    return resp


def _text(html: str) -> str:
    return re.sub(r"\s+", " ", re.sub(r"<[^>]+>", " ", html))


# --- HTML -------------------------------------------------------------------------


async def test_html_renders_all_sections_in_order(client, fx):
    resp = await _export(client, fx, "html")
    assert resp.headers["content-type"].startswith("text/html")
    assert 'filename="checkout-redesign-v2.html"' in resp.headers["content-disposition"]
    html = resp.text

    positions = [html.index(f'<section id="{key}"') for key, *_ in SECTIONS]
    assert positions == sorted(positions)
    for key, level, heading, _ in SECTIONS:
        clean = heading.split(" {#")[0]
        pattern = rf'<section id="{key}"[^>]*>\s*<h{level}>{re.escape(clean)}</h{level}>'
        assert re.search(pattern, html)
    assert "{#s-5-2}" not in html  # heading ids never leak into the output
    assert "<strong>conversion</strong>" in html
    assert "<table>" in html and "<td>41%</td>" in html


async def test_html_citations_are_numbered_sources_in_the_appendix(client, fx):
    # No theme chosen: the built-in default theme (clean-document for a PRD), whose body
    # carries no evidence markers and whose Sources and data points appendix lists them.
    html = (await _export(client, fx, "html")).text
    assert 'content="clean-document"' in html
    assert "[c:" not in html and "<sup" not in html

    appendix = html[html.index('class="sources-appendix"') :]
    # Numbered by first use: c1 -> 1, c2 -> 2, c4 -> 3; unused c3 listed last as 4.
    items = re.findall(r'<li id="src-(\d+)"[^>]*data-cite-key="(\w+)"', appendix)
    assert items == [("1", "c1"), ("2", "c2"), ("3", "c4"), ("4", "c3")]
    assert '<a href="#src-1">[1] #product thread on drop-off</a>' in appendix

    src1 = appendix[appendix.index('id="src-1"') : appendix.index('id="src-2"')]
    assert (
        '<a href="https://example.slack.com/archives/C123/p1700000000">'
        "#product thread on drop-off</a>"
    ) in src1
    assert "Most users abandon at the shipping step" in src1
    assert "slack" in src1 and "retrieved 2026-10-16 06:10 PDT" in src1

    # A non-http(s) ref is shown as text, never as a link.
    src3 = appendix[appendix.index('id="src-3"') : appendix.index('id="src-4"')]
    assert 'href="javascript' not in html
    assert "Carrier API notes" in src3 and "javascript:alert(1)" in src3
    assert "Unused source" in appendix[appendix.index('id="src-4"') :]


async def test_html_version_banner(client, fx):
    html = (await _export(client, fx, "html", n=2)).text
    banner = _text(html[html.index("<header") : html.index("</header>")])
    assert "Version 2" in banner
    assert "Approved" in banner
    assert "2026-10-17 02:30 PDT" in banner
    assert "status-approved" in html

    # Older, unapproved version: superseded, dated by import time.
    banner = (await _export(client, fx, "html", n=1)).text
    banner = _text(banner[banner.index("<header") : banner.index("</header>")])
    assert "Version 1" in banner
    assert "Superseded" in banner
    assert "imported 2026-10-16 07:01 PDT" in banner


async def test_html_is_self_contained_and_escapes_raw_html(client, fx):
    html = (await _export(client, fx, "html")).text
    assert "<style>" in html and "@page" in html  # stylesheet inlined
    assert "<link" not in html
    assert "<script>" not in html
    assert "&lt;script&gt;" in html


async def test_export_by_document_id_and_404s(client, fx):
    await _export(client, fx, "html", doc=str(fx.document_id))
    missing_doc = await client.get(URL.format(doc="nope", n=1), headers=fx.headers)
    assert missing_doc.status_code == 404
    missing_version = await client.get(URL.format(doc="checkout-redesign", n=9), headers=fx.headers)
    assert missing_version.status_code == 404
    bad_format = await client.get(
        URL.format(doc="checkout-redesign", n=1), params={"format": "docx"}, headers=fx.headers
    )
    assert bad_format.status_code == 422


async def test_export_is_tenant_scoped(client, fx):
    from tests.conftest import make_tenant

    other = await make_tenant("Other Co")
    async with tenant_session(other) as s:
        _, token = await create_api_token(s, "other")
        await s.commit()
    resp = await client.get(
        URL.format(doc="checkout-redesign", n=1), headers={"Authorization": f"Bearer {token}"}
    )
    assert resp.status_code == 404


# --- PDF --------------------------------------------------------------------------


# The PDF needs Pango on the machine (api/Dockerfile installs it). Without it the test
# is skipped, unless ORACLE_REQUIRE_PDF=1 makes the missing libraries a failure.
requires_pdf = pytest.mark.skipif(
    not os.environ.get("ORACLE_REQUIRE_PDF") and not pdf_available(),
    reason="WeasyPrint system libraries (Pango) not installed; see api/Dockerfile",
)


@requires_pdf
async def test_pdf_is_valid_and_matches_html(client, fx):
    resp = await _export(client, fx, "pdf")
    assert resp.headers["content-type"] == "application/pdf"
    assert 'filename="checkout-redesign-v2.pdf"' in resp.headers["content-disposition"]
    data = resp.content
    assert data.startswith(b"%PDF-")
    assert data.rstrip().endswith(b"%%EOF")

    reader = PdfReader(io.BytesIO(data))
    assert len(reader.pages) >= 1
    text = re.sub(r"\s+", " ", " ".join(page.extract_text() for page in reader.pages))

    # Banner, every section heading, body text, footnotes with excerpts and refs.
    for expected in [
        "Version 2",
        "2026-10-17 02:30 PDT",
        *(heading.split(" {#")[0] for _, _, heading, _ in SECTIONS),
        "Intro paragraph for the redesign.",
        "Who owns the carrier contract?",
        "Sources",
        "#product thread on drop-off",
        "Most users abandon at the shipping step",
        "Funnel review",
        "Unused source",
    ]:
        assert expected in text, f"{expected!r} missing from PDF text"
    assert "APPROVED" in text.upper()
    assert "Page 1 of" in text  # page footer
    assert text.index("1. Goal trace") < text.index("5.2 Shipping step")
    assert "[c:" not in text

    # Footnote links survive into the PDF as link annotations.
    uris = {
        a.get_object()["/A"].get("/URI")
        for page in reader.pages
        for a in page.get("/Annots") or []
        if a.get_object().get("/A")
    }
    assert "https://example.slack.com/archives/C123/p1700000000" in uris


async def test_pdf_without_system_libraries_is_503(client, fx, monkeypatch):
    def missing():
        raise PdfUnavailable("PDF export is unavailable: no Pango")

    monkeypatch.setattr(pdf_module, "_weasyprint", missing)
    resp = await client.get(
        URL.format(doc="checkout-redesign", n=2), params={"format": "pdf"}, headers=fx.headers
    )
    assert resp.status_code == 503
    assert "PDF export is unavailable" in resp.json()["detail"]
    # The other formats do not need WeasyPrint.
    await _export(client, fx, "html")
    await _export(client, fx, "md")


# --- markdown ---------------------------------------------------------------------


async def test_markdown_is_stored_markdown_with_banner_after_front_matter(client, fx):
    resp = await _export(client, fx, "md", n=1)
    assert resp.headers["content-type"].startswith("text/markdown")
    assert 'filename="checkout-redesign-v1.md"' in resp.headers["content-disposition"]
    body = resp.text
    front_matter_end = V1_MARKDOWN.index("---\n", 3) + len("---\n")
    assert body.startswith(V1_MARKDOWN[:front_matter_end])  # front matter stays first
    banner = body[front_matter_end:].splitlines()[0]
    assert banner.startswith("<!-- Product Oracle export:") and banner.endswith("-->")
    assert "version 1" in banner and "status superseded" in banner
    assert "imported 2026-10-16 07:01 PDT" in banner
    # Nothing else changed.
    assert body.replace(banner + "\n", "", 1) == V1_MARKDOWN

    v2 = (await _export(client, fx, "md", n=2)).text
    assert "status approved" in v2 and "approved 2026-10-17 02:30 PDT" in v2


def test_markdown_banner_without_front_matter():
    @dataclass
    class _V:
        number: int = 3
        markdown: str = "# Title {#title}\n"
        created_at: datetime = datetime(2026, 10, 16, tzinfo=UTC)
        approved_at: datetime | None = None

    @dataclass
    class _D:
        slug: str = "x--y"
        title: str = "X"
        status: str = "draft"

    from oracle.export.render import ExportVersion

    out = render_markdown(
        ExportVersion(document=_D(), version=_V(), sections=[], citations=[], latest_number=3)
    )
    first, rest = out.split("\n", 1)
    assert first.startswith("<!-- ") and first.endswith(" -->")
    assert "--" not in first[4:-3]  # cannot close the comment early
    assert "status draft" in first
    assert rest == "# Title {#title}\n"
