"""Compositions keep the draft conventions working (§4.3 step 6, §16 item 1 for modules).

- A composed template renders to an ordinary draft: ``{#id}`` headings, front matter,
  brief markers (O1f), the final Sources and data points section (O1c); the parser
  accepts it and every template section survives, in order.
- Section ids are the mapping key: a renamed heading, reordered sections and a
  re-import keep the module mapping; unknown custom sections are preserved as-is.
- Legacy drafts (no composition) import, read and export exactly as before.
"""

import pytest
from sqlalchemy import func, select

from oracle.docs.parser import parse_draft
from oracle.modules.catalog import builtin_contracts, builtin_manifests
from oracle.modules.composer import compose
from oracle.modules.skeleton import render_body
from oracle.templates.builtins import BUILTIN_TEMPLATES_BY_KEY, builtin_body
from oracle.templates.service import draft_skeleton
from oracle.templates.validation import check_template
from oracle.tenancy import tenant_session
from oracle.v2.models import DocumentComposition
from tests.baseline_helpers import make_ctx
from tests.modules.helpers import context, draft, import_md

PLATFORM = {
    "category": "ai_agent_platform",
    "scope": {"capabilities": ["tool_use", "customer_branding"]},
    "signals": {"tenant_count": 3},
}


@pytest.mark.parametrize("template", sorted(builtin_manifests()))
@pytest.mark.parametrize("pack", ["startup.standard", "ai-agent.platform"])
def test_a_composed_template_is_still_a_valid_draft(template, pack):
    body = builtin_body(BUILTIN_TEMPLATES_BY_KEY[template])
    original = check_template(body)
    comp = compose(context(pack=pack, template=template, inputs=PLATFORM))
    assert comp.valid, comp.problems
    composed = render_body(body, comp, builtin_contracts())
    assert check_template(composed).ok
    md = draft_skeleton(
        composed, slug="placeholder", title="Placeholder", kind="prd", template=template,
        version=1, theme=None,
    )  # fmt: skip
    parsed = parse_draft(md)
    keys = [s.section_key for s in parsed.sections]
    # Every template section survives, in its order; new module sections are added.
    assert [k for k in keys if k in original.section_keys] == original.section_keys
    new = {s for m in comp.included for s in m.layer_impact.new_sections}
    assert set(keys) == set(original.section_keys) | new
    # O1c: the appendix stays last.
    assert keys[-4:] == ["sources", "sources-list", "sources-data", "sources-evidence"]
    # O1f: the template's brief markers carry over, plus brief module sections.
    assert parsed.brief[: len(original.brief_sections)] == original.brief_sections
    brief_new = {s for m in comp.included if m.layer_impact.new_sections
                 for s in m.layer_impact.brief_sections}  # fmt: skip
    assert set(parsed.brief) == set(original.brief_sections) | brief_new
    # Every heading id the outline promised is in the draft, once.
    assert sorted(keys) == sorted(e.section_id for e in comp.outline)


def _rename_and_reorder(md: str) -> str:
    """Rename two headings (ids kept) and move a full-layer section."""
    md = md.replace("## Top risks {#top-risks}", "## Biggest risks we see {#top-risks}")
    md = md.replace("## Who it is for {#audience}", "## Audience and jobs {#audience}")
    start = md.index("## What success looks like {#success}")
    end = md.index("## What it looks like {#what}")
    block = md[start:end]
    md = md[:start] + md[end:]
    at = md.index("## Next step {#next-step}")
    return md[:at] + block + md[at:]


async def test_section_ids_hold_under_rename_reorder_and_reimport(client):
    ctx = await make_ctx()
    approver = ctx.as_("approver")
    slug = "placeholder-one-pager"
    v1 = draft("one-pager", slug)
    assert (await import_md(client, approver, slug, v1)).status_code == 201
    resp = await client.post(
        f"/v1/documents/{slug}/composition/revisions",
        json={"base_revision": None, "reason": "Initial"},
        headers=approver,
    )
    assert resp.status_code == 201, resp.text
    before = {
        m["key"]: (m["section_ids"], m["sections_present"])
        for m in resp.json()["current"]["modules"]
    }

    v2 = _rename_and_reorder(v1).replace(
        "## Sources and data points {#sources}",
        "## Our own notes {#custom-notes}\nKept as written.\n\n"
        "## Sources and data points {#sources}",
    )
    resp = await import_md(client, approver, slug, v2)
    assert resp.status_code == 201, resp.text
    # Re-importing the same content is a no-op version; the mapping does not move.
    assert (await import_md(client, approver, slug, v2)).status_code == 200

    inspector = (await client.get(f"/v1/documents/{slug}/composition", headers=approver)).json()
    after = {
        m["key"]: (m["section_ids"], m["sections_present"]) for m in inspector["current"]["modules"]
    }
    assert after == before
    assert after["risks.register"] == (["top-risks"], ["top-risks"])
    assert after["users.jtbd"] == (["audience"], ["audience"])
    assert inspector["sections"]["version"] == 2
    assert "custom-notes" in inspector["sections"]["unmapped"]
    exported = await client.get(f"/v1/documents/{slug}/versions/2/markdown", headers=approver)
    assert "Kept as written." in exported.text


async def test_front_matter_resolutions_and_brief_keep_working_with_a_composition(client):
    ctx = await make_ctx()
    approver = ctx.as_("approver")
    slug = "placeholder-memo"
    v1 = draft("narrative-memo", slug)
    assert (await import_md(client, approver, slug, v1)).status_code == 201
    resp = await client.post(
        f"/v1/documents/{slug}/composition/revisions",
        json={"base_revision": None, "reason": "Initial"},
        headers=approver,
    )
    assert resp.status_code == 201, resp.text
    v2 = v1.replace("\n---\n", "\nresolutions: []\n---\n", 1)
    assert "resolutions: []" in v2
    resp = await import_md(client, approver, slug, v2.replace("<Decision>", "Placeholder decision"))
    assert resp.status_code == 201, resp.text
    version = (await client.get(f"/v1/documents/{slug}/versions/2", headers=approver)).json()
    assert version["brief_source"] == "draft"
    assert "decision" in [s["section_key"] for s in version["sections"] if s["layer"] == "brief"]


async def test_legacy_documents_are_not_given_a_composition_by_reading_them(client):
    ctx = await make_ctx()
    approver = ctx.as_("approver")
    slug = "placeholder-legacy"
    v1 = draft("pr-faq", slug)
    assert (await import_md(client, approver, slug, v1)).status_code == 201
    inspector = (await client.get(f"/v1/documents/{slug}/composition", headers=approver)).json()
    assert inspector["legacy"] and inspector["recommendation"]["template"] == "pr-faq"
    async with tenant_session(ctx.tenant_id) as s:
        assert await s.scalar(select(func.count()).select_from(DocumentComposition)) == 0
    stored = await client.get(f"/v1/documents/{slug}/versions/1/markdown", headers=approver)
    assert stored.text == parse_draft(v1).markdown
