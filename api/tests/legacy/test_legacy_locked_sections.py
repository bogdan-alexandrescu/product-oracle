"""Locked sections as they work today: an `approved` verdict locks a section of that
version; a later import that changes or removes it is accepted with a stored
`locked_section_changed` warning; the feedback package names the locked sections
(build prompt §9, §16.10; C1)."""

from tests.fixtures import seed_auth
from tests.legacy.helpers import DOC, add_feedback, fixture, import_md, user_cookie

V1 = fixture("legacy_prd_v1.md")
V2 = fixture("legacy_prd_v2.md")
VERSION1 = f"/v1/documents/{DOC}/versions/1"


async def verdict(client, headers, key: str, value: str, n: int = 1):
    return await client.put(
        f"/v1/documents/{DOC}/versions/{n}/sections/{key}/review",
        json={"verdict": value, "note": f"{value} by the legacy test"},
        headers=headers,
    )


async def _setup(client):
    tenant_id, auth = await seed_auth()
    v1 = await import_md(client, auth, V1)
    assert v1.status_code == 201, v1.text
    approver = await user_cookie(tenant_id, "approver")
    return tenant_id, auth, approver, v1.json()


async def test_approved_sections_lock_and_a_changed_one_is_flagged_not_refused(client):
    tenant_id, auth, approver, v1 = await _setup(client)
    for key, value in (
        ("problem", "approved"),  # unchanged in v2
        ("req-invite", "approved"),  # changed in v2
        ("risks", "approved"),  # changed in v2, but the latest verdict is not approved
        ("risks", "changes_requested"),
    ):
        resp = await verdict(client, approver, key, value)
        assert resp.status_code == 200, resp.text

    package = (await client.get(f"{VERSION1}/feedback-package", headers=auth)).json()
    assert sorted(package["locked_section_keys"]) == ["problem", "req-invite"]
    # The changes_requested verdict opened a feedback item on its section.
    assert [(i["section_key"], i["verdict"]) for i in package["open_items"]] == [
        ("risks", "changes_requested")
    ]

    await add_feedback(tenant_id, v1["document_id"])
    resp = await import_md(client, auth, V2)
    assert resp.status_code == 201, resp.text
    v2 = resp.json()
    assert [(w["code"], w["section_keys"]) for w in v2["warnings"]] == [
        ("locked_section_changed", ["req-invite"])
    ]
    # qa4-docs-21: names the version approved; the page follows it with the sections' headings.
    assert v2["warnings"][0]["message"] == "Sections approved in v1 changed in this version:"
    # The warning is stored with the version; locks do not carry over to v2.
    listed = (await client.get(f"/v1/documents/{DOC}/versions", headers=auth)).json()
    assert listed[1]["warnings"] == v2["warnings"]
    package2 = (
        await client.get(f"/v1/documents/{DOC}/versions/2/feedback-package", headers=auth)
    ).json()
    assert package2["locked_section_keys"] == []
    # v1 keeps its verdicts.
    read = (await client.get(VERSION1, headers=auth)).json()
    verdicts = {s["section_key"]: (s["verdict"] or {}).get("verdict") for s in read["sections"]}
    assert verdicts["problem"] == "approved" and verdicts["risks"] == "changes_requested"
    assert verdicts["summary"] is None


async def test_a_removed_locked_section_is_reported(client):
    _, auth, approver, _ = await _setup(client)
    assert (await verdict(client, approver, "req-checklist", "approved")).status_code == 200
    removed = V1.replace(
        "### Checklist panel {#req-checklist}\n\nShow the five steps with their state on the"
        " home screen.\n\n",
        "",
    )
    assert removed != V1
    resp = await import_md(client, auth, removed)
    assert resp.status_code == 201, resp.text
    assert [(w["code"], w["section_keys"]) for w in resp.json()["warnings"]] == [
        ("locked_section_changed", ["req-checklist"])
    ]


async def test_verdicts_need_an_approver_and_comments_a_commenter(client):
    tenant_id, _, _, _ = await _setup(client)
    viewer = await user_cookie(tenant_id, "viewer")
    commenter = await user_cookie(tenant_id, "commenter")
    for who in (viewer, commenter):
        assert (await verdict(client, who, "problem", "approved")).status_code == 403
    comment = {
        "body": "Which week counts as the first?",
        "section_key": "problem",
        "anchor": {"exact": "first week"},
    }
    resp = await client.post(f"{VERSION1}/comments", json=comment, headers=viewer)
    assert resp.status_code == 403
    resp = await client.post(f"{VERSION1}/comments", json=comment, headers=commenter)
    assert resp.status_code == 201, resp.text


async def test_approving_the_version_and_reimporting_reopens_review(client):
    tenant_id, auth, approver, v1 = await _setup(client)
    resp = await client.post(f"{VERSION1}/approve", headers=approver)
    assert resp.status_code == 200, resp.text
    assert resp.json()["document_status"] == "approved"
    assert resp.json()["version"]["approved_at"]
    await add_feedback(tenant_id, v1["document_id"])
    assert (await import_md(client, auth, V2)).status_code == 201
    doc = (await client.get(f"/v1/documents/{DOC}", headers=auth)).json()
    assert doc["status"] != "approved"
    # The approved version stays approved and unchanged.
    v1_read = (await client.get(VERSION1, headers=auth)).json()
    assert v1_read["approved_at"] and v1_read["content_hash"] == v1["content_hash"]
