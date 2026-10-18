"""PDF via WeasyPrint, from exactly the HTML the HTML export returns.

WeasyPrint needs Pango at runtime (see api/Dockerfile for the system packages).
It is imported lazily so the API still starts, and the other formats still work,
on a machine without those libraries; a PDF request there gets ``PdfUnavailable``.

The renderer fetches nothing over the network or from disk: themes are company
supplied, so only ``data:`` URLs load. A theme that asks for a one-page fit
(``<meta name="oracle-page-fit" content="one_page">``) is checked after layout; an
overflowing document is rendered again with a visible warning at the top.
"""

import re

from oracle.export.render import HERE


class PdfUnavailable(RuntimeError):
    """WeasyPrint's system libraries (Pango, GObject, ...) cannot be loaded."""


def _weasyprint():
    try:
        import weasyprint
    except OSError as e:  # raised by cffi when a shared library is missing
        raise PdfUnavailable(
            "PDF export is unavailable: WeasyPrint cannot load its system libraries "
            f"(install Pango, see api/Dockerfile): {e}"
        ) from e
    return weasyprint


def pdf_available() -> bool:
    try:
        _weasyprint()
    except PdfUnavailable:
        return False
    return True


def _url_fetcher():
    """Only ``data:`` URLs; everything else is refused (and logged by WeasyPrint)."""
    from weasyprint import urls

    if hasattr(urls, "URLFetcher"):  # WeasyPrint 66+
        return urls.URLFetcher(allowed_protocols=["data"])

    def fetch(url: str, *args, **kwargs):  # pragma: no cover - older WeasyPrint
        if url.startswith("data:"):
            return urls.default_url_fetcher(url, *args, **kwargs)
        raise ValueError(f"export does not load external resources: {url[:80]}")

    return fetch


_PAGE_FIT = re.compile(r'<meta name="oracle-page-fit" content="one_page">')
_BODY_OPEN = re.compile(r"<body[^>]*>")


def _document(html: str):
    weasyprint = _weasyprint()
    # base_url resolves any relative URL against the export package (none today:
    # stylesheets are inlined); the fetcher refuses everything but data: URLs.
    return weasyprint.HTML(string=html, base_url=str(HERE), url_fetcher=_url_fetcher()).render()


def fit_warning(pages: int) -> str:
    return (
        f'<p class="fit-warning" role="alert">This document is meant to fit one page but '
        f"runs to {pages} pages. Shorten it, or pick a theme without a page limit.</p>"
    )


def html_to_pdf(html: str) -> bytes:
    document = _document(html)
    if _PAGE_FIT.search(html) and len(document.pages) > 1:
        m = _BODY_OPEN.search(html)
        if m:
            warned = html[: m.end()] + fit_warning(len(document.pages)) + html[m.end() :]
            document = _document(warned)
    return document.write_pdf()


def page_count(html: str) -> int:
    """Pages the HTML lays out to (used by tests and the one-page check)."""
    return len(_document(html).pages)
