"""qa4-docs-share-49: the Public page preview's footer reads as one plain sentence."""

from oracle.roadmap import public


def _page() -> public.PublicPage:
    return public.PublicPage(
        company="Example Labs",
        title="Example Labs roadmap",
        intro=None,
        disclaimer="Plans change.",
        columns=tuple((stage, ()) for stage in public.COLUMN_ORDER),
        oracle_mark=False,
    )


def test_preview_footer_is_plain():
    html = public.render_public(_page())
    assert "On a shared link, this shows when it was shared and when it ends." in html
    assert "Preview: a shared link" not in html
    assert "ends here" not in html


def test_shared_footer_keeps_its_dates():
    html = public.render_public(_page(), shared_on="Oct 30, 2026", expires_on="Nov 13, 2026")
    assert "Shared Oct 30, 2026 · expires Nov 13, 2026" in html


def test_a_links_page_says_when_it_was_shared_and_its_pdf_when_it_ends(monkeypatch):
    """protects=E-14 (fix round): a Public link's page has a header saying when the link
    ends, so its footer reads "Shared Oct 30, 2026" alone; the PDF, with no header, keeps
    "· expires Nov 13, 2026"; fails_when=the page says the end day twice or the PDF drops
    it."""
    from oracle.shares import render

    monkeypatch.setattr(render, "html_to_pdf", lambda html: html.encode())
    page = render._render_public(_page(), "html", "Oct 30, 2026", "Nov 13, 2026")
    assert "Shared Oct 30, 2026" in page and "expires" not in page
    pdf = render._render_public(_page(), "pdf", "Oct 30, 2026", "Nov 13, 2026")
    assert b"Shared Oct 30, 2026 \xc2\xb7 expires Nov 13, 2026" in pdf
