"""e2e-pdf-export (production pass, 2026-10-30): what an exported PDF says. Against Postgres;
an invented PRD ("Guided setup") and invented company names.

Test cards (protects / fails_when / no_claim):

- test_exports_never_print_the_placeholder_company: protects=the one-pager's PDF and the
  full export carry the company's own name (Settings › Company › Branding) and never the
  seed's placeholder "Example Co"; with no name set they print no name at all;
  fails_when="Example Co" appears in either export; no_claim=the logo (test_branding.py).
- test_one_page_overflow_is_told_to_the_person_not_printed: protects=a one-pager that runs
  past a page carries no warning in the document; the response says how many pages it runs
  to (X-Oracle-Overflow-Pages) for the web's note; fails_when=the warning is printed in the
  PDF or the header is missing; no_claim=the theme fit (test_drafts_export.py).
- test_branding_never_offers_or_saves_the_placeholder: protects=Settings › Branding never
  pre-fills the seed's placeholder as the display name, refuses to save it, and a stored
  placeholder still prints no name in an export; fails_when="Example Co" is offered, saved
  or exported after an owner saves only an accent; no_claim=the web form (branding.spec.ts).
- test_shared_and_public_pages_never_name_the_placeholder: protects=a share link's sender
  and the public roadmap's company never read the placeholder; fails_when="Example Co" is
  returned; no_claim=webhooks.
- test_one_page_overflow_without_pango: protects=the overflow header and the unprinted
  warning with a laid-out document stubbed in, so it runs without WeasyPrint's libraries;
  fails_when=the header is missing or wrong, or the PDF's HTML carries a warning.
- test_cover_times_read_month_first: protects=an export's cover words its times month first
  ("Oct 30, 2026, 2:49 PM PDT"); fails_when=an ISO time ("2026-10-30 14:49 PDT") is printed;
  no_claim=the web's dates.
"""

import io
import re

from pypdf import PdfReader

from oracle import branding, company_time
from oracle.auth.deps import Principal
from oracle.export import pdf as pdf_mod
from oracle.export.pdf import pdf_available
from oracle.roadmap import public
from oracle.shares import render
from oracle.simple import one_pager
from oracle.tenancy import tenant_session
from tests.test_drafts_export import requires_pdf
from tests.test_simple_one_pager_api import (
    URL,
    clock,  # noqa: F401 - the autouse clock
    world,
)

PLACEHOLDER = "Example Co"
NAME = "Northwind Labs"
FULL = "/v1/documents/guided-setup/versions/1/export"


async def _one_pager_html(ctx) -> str:
    async with tenant_session(ctx.tenant_id) as s:
        p = Principal(tenant_id=ctx.tenant_id, kind="user", role="viewer",
                      user_id=ctx.users["viewer"].id)  # fmt: skip
        html, _ = await one_pager.pdf_html(s, p, "guided-setup")
    return html


def _text(content: bytes) -> str:
    return "\n".join(p.extract_text() for p in PdfReader(io.BytesIO(content)).pages)


async def test_exports_never_print_the_placeholder_company(client):
    ctx = await world(client)
    # The seed's placeholder is no name: neither export prints it.
    assert PLACEHOLDER not in await _one_pager_html(ctx)
    full = await client.get(FULL, params={"format": "html"}, headers=ctx.as_("viewer"))
    assert full.status_code == 200 and PLACEHOLDER not in full.text
    body = {"display_name": NAME, "accent": None, "oracle_mark": True,
            "public_disclaimer": "Plans can change."}  # fmt: skip
    put = await client.put("/v1/branding", json=body, headers=ctx.as_("owner"))
    assert put.status_code == 200
    html = await _one_pager_html(ctx)
    assert NAME in html and PLACEHOLDER not in html
    full = await client.get(FULL, params={"format": "html"}, headers=ctx.as_("viewer"))
    assert NAME in full.text and PLACEHOLDER not in full.text
    if pdf_available():
        for url in (f"{URL}/guided-setup/pdf", f"{FULL}?format=pdf"):
            r = await client.get(url, headers=ctx.as_("viewer"))
            assert r.status_code == 200, r.text
            text = _text(r.content)
            assert NAME in text and PLACEHOLDER not in text


@requires_pdf
async def test_one_page_overflow_is_told_to_the_person_not_printed(client, monkeypatch):
    ctx = await world(client)
    long = "<li>" + "A long line about setup that goes on. " * 40 + "</li>"

    async def overflowing(db, principal, doc):
        html, stem = await original(db, principal, doc)
        return html.replace("</ul>", long * 30 + "</ul>", 1), stem

    original = one_pager.pdf_html
    monkeypatch.setattr(one_pager, "pdf_html", overflowing)
    r = await client.get(f"{URL}/guided-setup/pdf", headers=ctx.as_("viewer"))
    assert r.status_code == 200, r.text
    pages = len(PdfReader(io.BytesIO(r.content)).pages)
    assert pages > 1
    assert r.headers["X-Oracle-Overflow-Pages"] == str(pages)
    text = _text(r.content)
    assert "meant to fit one page" not in text and "Shorten it" not in text
    monkeypatch.setattr(one_pager, "pdf_html", original)
    short = await client.get(f"{URL}/guided-setup/pdf", headers=ctx.as_("viewer"))
    assert "X-Oracle-Overflow-Pages" not in short.headers


class _Laid:
    """A laid-out document of ``n`` pages (WeasyPrint's render(), stubbed)."""

    def __init__(self, n: int):
        self.pages = [object()] * n

    def write_pdf(self) -> bytes:
        return b"%PDF-1.7 stub"


async def test_one_page_overflow_without_pango(client, monkeypatch):
    ctx = await world(client)
    laid: list[str] = []
    pages = {"n": 3}

    def document(html):
        laid.append(html)
        return _Laid(pages["n"])

    monkeypatch.setattr(pdf_mod, "_document", document)
    r = await client.get(f"{URL}/guided-setup/pdf", headers=ctx.as_("viewer"))
    assert r.status_code == 200, r.text
    assert r.headers["X-Oracle-Overflow-Pages"] == "3"
    assert laid and "meant to fit one page" not in laid[-1] and "Shorten it" not in laid[-1]
    pages["n"] = 1
    fits = await client.get(f"{URL}/guided-setup/pdf", headers=ctx.as_("viewer"))
    assert fits.status_code == 200 and "X-Oracle-Overflow-Pages" not in fits.headers


async def test_branding_never_offers_or_saves_the_placeholder(client):
    ctx = await world(client)
    got = await client.get("/v1/branding", headers=ctx.as_("owner"))
    assert got.status_code == 200 and got.json()["display_name"] == ""
    body = {"display_name": PLACEHOLDER, "accent": "#0369a1", "oracle_mark": True,
            "public_disclaimer": "Plans can change."}  # fmt: skip
    put = await client.put("/v1/branding", json=body, headers=ctx.as_("owner"))
    assert put.status_code == 422 and "company's name" in put.json()["detail"]
    # A placeholder stored before this check still prints no name.
    async with tenant_session(ctx.tenant_id) as s:
        p = Principal(tenant_id=ctx.tenant_id, kind="user", role="owner",
                      user_id=ctx.users["owner"].id)  # fmt: skip
        value = await branding.stored(s)
        value.update(display_name=PLACEHOLDER, accent="#0369a1")
        await branding._save(s, p, value, "branding.update")
        await s.commit()
    got = await client.get("/v1/branding", headers=ctx.as_("owner"))
    assert got.json()["display_name"] == "" and got.json()["accent"] == "#0369a1"
    assert PLACEHOLDER not in await _one_pager_html(ctx)
    full = await client.get(FULL, params={"format": "html"}, headers=ctx.as_("viewer"))
    assert full.status_code == 200 and PLACEHOLDER not in full.text


async def test_shared_and_public_pages_never_name_the_placeholder(client):
    ctx = await world(client)
    async with tenant_session(ctx.tenant_id) as s:
        assert await render.company(s) is None
        assert await public.company_name(s) == "Our"


ISO_TIME = re.compile(r"\d{4}-\d{2}-\d{2} \d{2}:\d{2}")
MONTH_FIRST = re.compile(r"[A-Z][a-z]{2} \d{1,2}, \d{4}, \d{1,2}:\d{2} [AP]M [A-Z]{2,5}")


async def test_cover_times_read_month_first(client):
    ctx = await world(client)
    full = await client.get(FULL, params={"format": "html"}, headers=ctx.as_("viewer"))
    assert full.status_code == 200
    assert MONTH_FIRST.search(full.text), full.text[:2000]
    assert not ISO_TIME.search(full.text)
    zone = "America/Los_Angeles"
    from datetime import UTC, datetime

    at = datetime(2026, 10, 30, 21, 49, tzinfo=UTC)
    assert company_time.stamp(at, zone) == "Oct 30, 2026, 2:49 PM PDT"
