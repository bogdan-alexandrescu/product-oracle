"""#255: a PRD started from its template's skeleton says so on its version, so the
document page offers Draft with Oracle before Publish."""

from tests.test_priorities import _token


def _codes(version: dict) -> list[str]:
    return [n["code"] for n in version["notes"]]


async def test_skeleton_version_is_template_only_until_a_draft_replaces_it(client, tenant_id):
    h = await _token(tenant_id, "approver")
    body = {"kind": "prd", "title": "Saved wishlists", "template": "one-pager"}
    out = (await client.post("/v1/drafts", json=body, headers=h)).json()
    slug = out["slug"]

    v1 = (await client.get(f"/v1/documents/{slug}/versions/1", headers=h)).json()
    assert "template_only" in _codes(v1)
    listed = (await client.get(f"/v1/documents/{slug}", headers=h)).json()["versions"]
    assert [_codes(v) for v in listed] == [["template_only"]]

    # A second version with content is not template-only.
    md = (await client.get(f"/v1/documents/{slug}/versions/1/markdown", headers=h)).text
    filled = md.rstrip("\n") + "\n\nShoppers keep a wishlist across devices.\n"
    resp = await client.post(
        f"/v1/documents/{slug}/versions?base_version=1",
        content=filled,
        headers={**h, "content-type": "text/markdown"},
    )
    assert resp.status_code == 201, resp.text
    assert resp.json()["number"] == 2 and "template_only" not in _codes(resp.json())


async def test_imported_first_version_is_not_template_only(client, tenant_id):
    h = await _token(tenant_id, "approver")
    md = "---\ndocument: gift-notes\ntitle: Gift notes\n---\n# Gift notes {#title}\n\nA note.\n"
    resp = await client.post(
        "/v1/documents/gift-notes/versions",
        content=md,
        headers={**h, "content-type": "text/markdown"},
    )
    assert resp.status_code == 201, resp.text
    assert "template_only" not in _codes(resp.json())
