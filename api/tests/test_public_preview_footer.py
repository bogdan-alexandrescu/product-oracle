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
