"""PDF via WeasyPrint, from exactly the HTML the HTML export returns.

WeasyPrint needs Pango at runtime (see api/Dockerfile for the system packages).
It is imported lazily so the API still starts, and the other formats still work,
on a machine without those libraries; a PDF request there gets ``PdfUnavailable``.
"""

from oracle.export.render import HERE


class PdfUnavailable(RuntimeError):
    """WeasyPrint's system libraries (Pango, GObject, ...) cannot be loaded."""


def _weasyprint_html():
    try:
        from weasyprint import HTML
    except OSError as e:  # raised by cffi when a shared library is missing
        raise PdfUnavailable(
            "PDF export is unavailable: WeasyPrint cannot load its system libraries "
            f"(install Pango, see api/Dockerfile): {e}"
        ) from e
    return HTML


def pdf_available() -> bool:
    try:
        _weasyprint_html()
    except PdfUnavailable:
        return False
    return True


def html_to_pdf(html: str) -> bytes:
    html_cls = _weasyprint_html()
    # base_url resolves any relative URL against the export package (none today:
    # the stylesheet is inlined).
    return html_cls(string=html, base_url=str(HERE)).write_pdf()
