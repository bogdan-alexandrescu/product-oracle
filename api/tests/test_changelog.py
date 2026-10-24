"""H6 changelog: entries newest first, dated and grouped by category (Keep a
Changelog); approvers publish public entries (never Oracle); the Markdown and HTML
export carries published public entries only. Against Postgres.

Every test states its card: protects, fails_when, no_claim."""

from datetime import date

from oracle.launches import changelog
from tests.test_roadmap import as_user, owner, runtime  # noqa: F401 - fixtures


def _entry(**kw):
    base = {"category": "added", "audience": "public", "title": "x", "body": "",
            "released_on": date(2026, 10, 21)}  # fmt: skip
    return changelog.ExportEntry(**{**base, **kw})


def test_export_markdown_format():
    """protects=Keep a Changelog Markdown: newest date first, YYYY-MM-DD headings, the
    category headings in their order (Added, Changed, ..., Security); fails_when=dates
    are out of order, mis-formatted, or categories are not grouped; no_claim=which entries
    are exported (test_publish_and_export)."""
    md = changelog.render_markdown(
        [
            _entry(title="Older fix", category="fixed", released_on=date(2026, 9, 1)),
            _entry(title="Saved cards", body="Pay in one tap."),
            _entry(title="Card vault", category="security"),
            _entry(title="Faster search", category="changed"),
        ]
    )
    assert md.splitlines()[0] == "# Changelog"
    assert md.index("## 2026-10-21") < md.index("## 2026-09-01")
    day = md[md.index("## 2026-10-21") : md.index("## 2026-09-01")]
    assert day.index("### Added") < day.index("### Changed") < day.index("### Security")
    assert "- **Saved cards**: Pay in one tap." in day
    assert "### Fixed\n\n- **Older fix**" in md


def test_export_html_escapes():
    """protects=the HTML export escapes entry text; fails_when=a title's markup reaches the
    page; no_claim=styling."""
    html = changelog.render_html([_entry(title="<script>x</script>")])
    assert "<script>x" not in html and "&lt;script&gt;" in html
    assert "<h2>2026-10-21</h2>" in html and "<h3>Added</h3>" in html


async def test_publish_and_export(client, owner):  # noqa: F811
    """protects=criterion 9: only approvers publish; a public entry needs released_on;
    the export holds published public entries only, newest first, grouped, dated
    YYYY-MM-DD; withdrawn cannot be published again (409); fails_when=a commenter
    publishes, a draft or internal entry is exported, or a withdrawn entry republishes;
    no_claim=where people post it (outside Oracle)."""
    tenant_id, auth = owner
    commenter = await as_user(tenant_id, "commenter")
    viewer = await as_user(tenant_id, "viewer")

    async def create(status=201, headers=auth, **body):
        resp = await client.post("/v1/changelog", json=body, headers=headers)
        assert resp.status_code == status, resp.text
        return resp.json()

    await create(422, category="added", audience="public", title="No date", body="")
    await create(403, headers=commenter, category="added", audience="internal", title="x",
                 body="", released_on="2026-10-21")  # fmt: skip
    cards = await create(category="added", audience="public", title="Saved cards",
                         body="Pay in one tap.", released_on="2026-10-21")  # fmt: skip
    old = await create(category="fixed", audience="public", title="Totals round right",
                       body="", released_on="2026-09-01")  # fmt: skip
    draft = await create(category="changed", audience="public", title="Still a draft",
                         body="", released_on="2026-10-21")  # fmt: skip
    internal = await create(category="added", audience="internal", title="New admin view",
                            body="", released_on="2026-10-21")  # fmt: skip
    assert internal["status"] == "draft"

    publish = "/v1/changelog/{}/publish"
    assert (await client.post(publish.format(cards["id"]), headers=commenter)).status_code == 403
    for e in (cards, old, internal):
        resp = await client.post(publish.format(e["id"]), headers=auth)
        assert resp.status_code == 200 and resp.json()["status"] == "published"
        # A person published it (the seed's token acts for its user), never Oracle.
        assert resp.json()["published_actor"].startswith("user:")
        assert resp.json()["published_by"]

    resp = await client.get(
        "/v1/changelog/export", params={"audience": "public", "format": "md"}, headers=viewer
    )
    assert resp.status_code == 200 and resp.headers["content-type"].startswith("text/markdown")
    md = resp.text
    assert "Saved cards" in md and "Totals round right" in md
    assert "Still a draft" not in md and "New admin view" not in md
    assert md.index("## 2026-10-21") < md.index("## 2026-09-01")
    assert "### Added" in md and "### Fixed" in md
    since = await client.get(
        "/v1/changelog/export", params={"format": "md", "since": "2026-10-01"}, headers=viewer
    )
    assert "Totals round right" not in since.text and "Saved cards" in since.text
    html = await client.get("/v1/changelog/export", params={"format": "html"}, headers=viewer)
    assert html.headers["content-type"].startswith("text/html") and "Saved cards" in html.text

    # Listing: newest first, every member sees internal entries.
    listed = (await client.get("/v1/changelog", headers=viewer)).json()
    assert listed[-1]["title"] == "Totals round right"
    assert {e["title"] for e in listed} == {
        "Saved cards", "Totals round right", "Still a draft", "New admin view"
    }  # fmt: skip
    only = await client.get("/v1/changelog", params={"status": "draft"}, headers=viewer)
    assert [e["title"] for e in only.json()] == ["Still a draft"]

    # Withdraw, then publishing again is refused.
    resp = await client.post(f"/v1/changelog/{cards['id']}/withdraw", headers=auth)
    assert resp.status_code == 200 and resp.json()["status"] == "withdrawn"
    assert (await client.post(publish.format(cards["id"]), headers=auth)).status_code == 409
    md = (await client.get("/v1/changelog/export", headers=viewer)).text
    assert "Saved cards" not in md

    # Edit with lock_version.
    url = f"/v1/changelog/{draft['id']}"
    resp = await client.patch(url, json={"title": "Faster search", "lock_version": 1}, headers=auth)
    assert resp.status_code == 200 and resp.json()["title"] == "Faster search"
    resp = await client.patch(url, json={"title": "Again", "lock_version": 1}, headers=auth)
    assert resp.status_code == 409
    assert (await client.patch(url, json={"title": "x", "lock_version": 2},
                               headers=commenter)).status_code == 403  # fmt: skip


async def test_launched_publishes_internal_entries_only_within_limits(client, owner, runtime):  # noqa: F811
    """protects=the ceiling: on Mark launched, internal draft entries publish themselves
    only when the company lets Oracle act within limits on launches; public entries never
    do; fails_when=a public entry is published by Oracle, or an internal one without the
    setting; no_claim=H11's settings screen."""
    from oracle.launches.models import ChangelogEntry
    from oracle.tenancy import tenant_session
    from tests.launch_helpers import launched_world

    tenant_id, auth = owner
    by_item = await launched_world(client, auth, runtime, tenant_id)

    async def entries_for(launch):
        for audience in ("internal", "public"):
            resp = await client.post(
                "/v1/changelog",
                json={"launch_id": launch["id"], "category": "added", "audience": audience,
                      "title": f"{audience} {launch['item_keys'][0]}", "body": "",
                      "released_on": "2026-10-21"},
                headers=auth,
            )  # fmt: skip
            assert resp.status_code == 201, resp.text

    first, second = by_item["payment-step"], by_item["shipping-step"]
    await entries_for(first)
    await entries_for(second)
    await client.post(f"/v1/launches/{first['id']}/launched", json={}, headers=auth)
    listed = (await client.get("/v1/changelog", headers=auth)).json()
    statuses = {e["title"]: e["status"] for e in listed}
    assert statuses["internal payment-step"] == "draft"

    # H11 Autonomy's shape, through its route (#519 item 1).
    resp = await client.put(
        "/v1/autonomy/launches",
        json={"level": "act", "reason": "Internal entries are routine"},
        headers=auth,
    )
    assert resp.status_code == 200, resp.text
    await client.post(f"/v1/launches/{second['id']}/launched", json={}, headers=auth)
    async with tenant_session(tenant_id) as s:
        from sqlalchemy import select

        rows = {e.title: e for e in await s.scalars(select(ChangelogEntry))}
    assert rows["internal shipping-step"].status == "published"
    assert rows["internal shipping-step"].published_actor == "oracle"
    assert rows["public shipping-step"].status == "draft"
