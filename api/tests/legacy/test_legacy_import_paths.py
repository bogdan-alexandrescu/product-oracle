"""The same legacy draft imported through REST, the `oracle push` CLI and the MCP
`import_version` and `push_draft` tools gives the same parse, the same diff and the
same exports (build prompt §16.1, §13: "continue supporting old oracle push/pull")."""

import json
import re
import uuid

import pytest

from tests.legacy.helpers import (
    FEEDBACK_ADDRESSED,
    FEEDBACK_DECLINED,
    FIXTURES,
    add_feedback,
    fixture,
    import_md,
    mcp_session,
    role_token,
    run_cli,
)

V1 = fixture("legacy_prd_v1.md")
V2 = fixture("legacy_prd_v2.md")


def parsed(version: dict) -> list[tuple]:
    return [
        (s["section_key"], s["ordinal"], s["level"], s["layer"], s["content_hash"], s["notes"])
        for s in version["sections"]
    ]


async def _through(path: str, client, tenant_id, slug: str) -> None:
    """Import v1 then v2 of the legacy draft into ``slug`` through ``path``."""
    owner = await role_token(tenant_id, "owner")
    headers = {"Authorization": f"Bearer {owner}"}
    # Feedback ids are global, so each document resolves its own pair.
    ids = (FEEDBACK_ADDRESSED, FEEDBACK_DECLINED) if path == "api" else (uuid.uuid4(), uuid.uuid4())
    for n, text in ((1, V1), (2, V2)):
        text = text.replace("document: legacy-onboarding", f"document: {slug}")
        text = text.replace(str(FEEDBACK_ADDRESSED), str(ids[0]))
        text = text.replace(str(FEEDBACK_DECLINED), str(ids[1]))
        if n == 2:
            doc = (await client.get(f"/v1/documents/{slug}", headers=headers)).json()
            await add_feedback(tenant_id, doc["id"], ids)
        if path == "api":
            resp = await import_md(client, headers, text, doc=slug)
            assert resp.status_code == 201, resp.text
        elif path == "cli":
            draft = FIXTURES.parent / f".{slug}-v{n}.md"
            draft.write_text(text, encoding="utf-8")
            try:
                code, out, err = await run_cli(client, ["push", str(draft)], owner)
            finally:
                draft.unlink()
            assert code == 0, err
            assert out.splitlines() == [f"Imported {slug} version {n}", "No warnings"]
        else:
            tool, arg = ("import_version", "body") if path == "mcp" else ("push_draft", "markdown")
            args = {"doc": slug, arg: text}
            if tool == "push_draft":
                # v2-review: the curated push names the version it was written on.
                args["base_version"] = n - 1
            async with mcp_session(owner) as c:
                result = await c.call_tool(tool, args)
            assert not result.is_error, result
            assert result.structured_content["number"] == n


@pytest.mark.parametrize("path", ["cli", "mcp", "mcp-curated"])
async def test_every_import_path_matches_the_rest_import(client, tenant_id, path):
    viewer = {"Authorization": f"Bearer {await role_token(tenant_id, 'viewer')}"}
    # Seed the built-in templates first: an export before seeding names the template by
    # its key (oracle-default) rather than its name, whichever path imported the draft.
    assert (await client.get("/v1/templates", headers=viewer)).status_code == 200
    await _through("api", client, tenant_id, "via-api")
    await _through(path, client, tenant_id, "via-other")

    async def read(slug: str, url: str):
        return (await client.get(f"/v1/documents/{slug}{url}", headers=viewer)).json()

    for n in (1, 2):
        a, b = await read("via-api", f"/versions/{n}"), await read("via-other", f"/versions/{n}")
        assert parsed(a) == parsed(b)
        assert a["content_hash"] != b["content_hash"]  # the slug differs in the front matter
        assert a["brief_source"] == b["brief_source"] == "full_heading"
        assert [c["cite_key"] for c in a["citations"]] == [c["cite_key"] for c in b["citations"]]

    diff_a = await read("via-api", "/diff?from=1&to=2")
    diff_b = await read("via-other", "/diff?from=1&to=2")
    strip = ("document_id",)
    assert {k: v for k, v in diff_a.items() if k not in strip} == {
        k: v for k, v in diff_b.items() if k not in strip
    }

    for fmt in ("html", "md"):
        url = f"/versions/2/export?format={fmt}"
        ea = (await client.get(f"/v1/documents/via-api{url}", headers=viewer)).text
        eb = (await client.get(f"/v1/documents/via-other{url}", headers=viewer)).text

        # Only the slug, the import time and the feedback ids differ.
        def norm(t: str) -> str:
            t = re.sub(r"feedback_id: [0-9a-f-]{36}", "feedback_id: ID", t)
            t = t.replace("via-api", "SLUG").replace("via-other", "SLUG")
            return re.sub(r"imported \d{4}-\d\d-\d\d \d\d:\d\d UTC", "imported T", t)

        assert norm(ea) == norm(eb)


async def test_cli_pull_writes_the_feedback_package_with_locked_sections(
    client, tenant_id, tmp_path
):
    owner = await role_token(tenant_id, "owner")
    headers = {"Authorization": f"Bearer {owner}"}
    assert (await import_md(client, headers, V1)).status_code == 201
    verdict = await client.put(
        "/v1/documents/legacy-onboarding/versions/1/sections/problem/review",
        json={"verdict": "approved"},
        headers=headers,
    )
    assert verdict.status_code == 200, verdict.text
    code, out, err = await run_cli(
        client, ["pull", "legacy-onboarding", "--version", "1", "--out", str(tmp_path)], owner
    )
    assert code == 0, err
    assert out.splitlines()[0] == (
        "Pulled legacy-onboarding-v1: 0 open item(s), 1 locked section(s) (problem)"
    )
    assert (tmp_path / "legacy-onboarding-v1.md").read_text() == V1
    assert json.loads((tmp_path / "legacy-onboarding-v1.locked.json").read_text()) == ["problem"]
    assert json.loads((tmp_path / "legacy-onboarding-v1.open-items.json").read_text()) == []
