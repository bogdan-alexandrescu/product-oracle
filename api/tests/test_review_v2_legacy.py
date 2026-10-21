"""CR-06 next to the legacy flows (build prompt §16.1): the legacy drafts still import
through the API, CLI and MCP with ``{#id}``, ``resolutions``, the appendix and brief and
full; per-version verdicts, locks and the feedback package read as before; exports of a
version are unchanged by a publication. The v2 state is an added view on top."""

from tests.fixtures import seed_auth
from tests.legacy.helpers import (
    DOC,
    add_feedback,
    fixture,
    import_md,
    mcp_session,
    user_cookie,
)

V1 = fixture("legacy_prd_v1.md")
V2 = fixture("legacy_prd_v2.md")
BASE = f"/v1/documents/{DOC}"


async def test_legacy_review_flow_is_unchanged_and_v2_state_adds_to_it(client):
    tenant_id, auth = await seed_auth()
    v1 = await import_md(client, auth, V1)
    assert v1.status_code == 201
    approver = await user_cookie(tenant_id, "approver")
    for key in ("problem", "req-invite"):
        resp = await client.put(
            f"{BASE}/versions/1/sections/{key}/review",
            json={"verdict": "approved"},
            headers=approver,
        )
        assert resp.status_code == 200

    await add_feedback(tenant_id, v1.json()["document_id"])
    v2 = await import_md(client, auth, V2)
    assert v2.status_code == 201
    # The legacy warning and the per-version lock view are as before.
    assert [w["code"] for w in v2.json()["warnings"]] == ["locked_section_changed"]
    package = (await client.get(f"{BASE}/versions/2/feedback-package", headers=auth)).json()
    assert package["locked_section_keys"] == []
    read = (await client.get(f"{BASE}/versions/2", headers=auth)).json()
    assert all(s["verdict"] is None for s in read["sections"])

    export_before = await client.get(f"{BASE}/versions/1/export?format=md", headers=auth)

    # The v2 view: an approval holds for the unchanged revision only.
    states = (await client.get(f"{BASE}/versions/2/section-states", headers=auth)).json()
    by_key = {s["section_key"]: s["status"] for s in states["sections"]}
    assert by_key["problem"] == "approved"
    assert by_key["req-invite"] == "approval_stale"

    # Exports of version 1 are unchanged; the legacy template's required sections are
    # what a publish asks for (oracle-default v1 has no "solution" or "metrics").
    assert (await client.post(f"{BASE}/versions/2/approve", headers=approver)).status_code == 200
    check = (await client.get(f"{BASE}/versions/2/publish-check", headers=auth)).json()
    missing = [b for b in check["blockers"] if b["code"] == "missing_required_section"]
    assert missing and set(missing[0]["section_keys"]) == {"solution", "metrics"}
    export_after = await client.get(f"{BASE}/versions/1/export?format=md", headers=auth)
    assert export_after.text == export_before.text


async def test_mcp_import_takes_a_base_version(client):
    _, auth = await seed_auth()
    assert (await import_md(client, auth, V1)).status_code == 201
    token = auth["Authorization"].split(" ", 1)[1]
    changed = V1.replace("New teams get a five-step checklist", "New teams get a checklist")
    async with mcp_session(token) as c:
        result = await c.call_tool(
            "import_version", {"doc": DOC, "body": changed, "base_version": 1}
        )
        assert not result.is_error, result
        assert result.structured_content["number"] == 2
        stale = V1.replace("may feel like nagging", "may feel pushy")
        result = await c.call_tool("import_version", {"doc": DOC, "body": stale, "base_version": 1})
        assert result.is_error
        assert "409" in str(result.content) or "version 2" in str(result.content)
