"""A composed template renders to an ordinary draft (§4.3 step 6, §16 item 1): ``{#id}``
headings, front matter, brief markers (O1f) and the final Sources and data points
section (O1c); the parser accepts it and every template section survives, in order."""

import pytest

from oracle.docs.parser import parse_draft
from oracle.modules.catalog import builtin_contracts, builtin_manifests
from oracle.modules.composer import compose
from oracle.modules.skeleton import render_body
from oracle.templates.builtins import BUILTIN_TEMPLATES_BY_KEY, builtin_body
from oracle.templates.service import draft_skeleton
from oracle.templates.validation import check_template
from tests.modules.helpers import context

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
