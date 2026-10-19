"""The industry packs (O1h, owner, 2026-10-19): six packs beside General Tech Startup and
the Multi-tenant AI Agent Platform. Each reuses the shared core and adds its own
required, conditional and optional modules. Templates only, no prewritten content.
"""

import json
import re
from pathlib import Path

import pytest
import yaml

from oracle.modules.catalog import BUILTIN_DIR, builtin_contracts, builtin_packs, default_pack_for
from oracle.modules.composer import compose
from oracle.templates.builtins import BUILTIN_TEMPLATES
from oracle.v2.contract import ALWAYS, MODULE_ID_PATTERN, SEMVER_PATTERN, Contains, condition_stats
from tests.modules.helpers import context
from tests.modules.unit.test_catalog import PACK_A

INDUSTRY = {
    "marketplace.ecommerce": ("Marketplace and e-commerce", "marketplace", "marketplace.yaml"),
    "fintech.payments": ("Fintech and payments", "fintech", "fintech.yaml"),
    "hardware.iot": ("Hardware and IoT", "hardware", "hardware.yaml"),
    "saas.b2b": ("SaaS and B2B products", "saas", "saas.yaml"),
    "smb.services": ("SMB services", "smb_services", "smb.yaml"),
    "enterprise.software": ("Enterprise software", "enterprise_software", "enterprise.yaml"),
}
PRD_TEMPLATES = [None, *sorted(t.key for t in BUILTIN_TEMPLATES if t.kind == "prd")]
FIXTURES = Path(__file__).resolve().parents[1] / "fixtures"


def _leaves(node):
    args = getattr(node, "args", None)
    if args is not None:
        return [leaf for a in args for leaf in _leaves(a)]
    if getattr(node, "arg", None) is not None:
        return _leaves(node.arg)
    return [node]


def test_the_catalogue_has_all_eight_packs_in_order():
    assert list(builtin_packs()) == ["startup.standard", "ai-agent.platform", *INDUSTRY]


@pytest.mark.parametrize("pack_id", INDUSTRY)
def test_each_pack_reuses_the_shared_core_and_adds_its_own_modules(pack_id):
    title, namespace, _ = INDUSTRY[pack_id]
    pack = builtin_packs()[pack_id]
    contracts = builtin_contracts()
    assert pack.title == title and pack.core == "startup.standard"
    assert list(pack.modules) == PACK_A + list(pack.own)
    assert 5 <= len(pack.own) <= 10
    prefix = pack_id.split(".")[0]
    for key in pack.own:
        c = contracts[key]
        assert re.match(MODULE_ID_PATTERN, key) and key.startswith(prefix + "."), key
        assert re.match(SEMVER_PATTERN, c.version), key
        # Only its own pack: the core modules and the other packs are untouched.
        assert c.applies_to == [pack_id], key
        # Dependencies stay in the pack (its own modules or the shared core).
        assert set(c.depends_on) <= set(pack.modules), key
        assert c.question_prompts and c.instructions and c.fields, key


@pytest.mark.parametrize("pack_id", INDUSTRY)
def test_each_pack_uses_all_three_tiers(pack_id):
    contracts = builtin_contracts()
    own = builtin_packs()[pack_id].own
    tiers = {p: [k for k in own if contracts[k].policy == p] for p in _TIERS}
    assert len(tiers["required"]) >= 2, tiers
    assert len(tiers["conditional"]) >= 2, tiers
    assert len(tiers["optional"]) >= 1, tiers  # the optional tier is used (O1h)
    for key in tiers["conditional"]:
        c = contracts[key]
        assert c.condition != ALWAYS
        assert any(isinstance(leaf, Contains) for leaf in _leaves(c.condition)), key
        assert condition_stats(c.condition)[0] <= 3, key


_TIERS = ("required", "conditional", "optional")


@pytest.mark.parametrize("pack_id", INDUSTRY)
@pytest.mark.parametrize("template", PRD_TEMPLATES)
def test_each_pack_composes_a_valid_explained_composition(pack_id, template):
    comp = compose(context(pack_id, template))
    assert comp.valid, (pack_id, template, comp.problems)
    contracts = builtin_contracts()
    own = builtin_packs()[pack_id].own
    m = {x.key: x for x in comp.modules}
    for key in own:
        mod = m[key]
        assert mod.reason and mod.explanation, key
        policy = contracts[key].policy
        if policy == "required":
            assert mod.included and mod.selection == "mandatory", key
        elif policy == "conditional":
            # Nothing is known yet: not suggested, and the missing inputs are said.
            assert mod.selection == "optional" and not mod.included, key
            assert mod.missing_information, key
        else:
            assert mod.selection == "optional" and not mod.included, key
            assert mod.reason == "Not suggested: it is optional.", key
    # The shared core is all there, and Sources and data points stays last (O1c).
    assert {"constraints.solutions", "sources.data-points"} <= {x.key for x in comp.included}
    assert comp.included[-1].key == "sources.data-points"


@pytest.mark.parametrize("pack_id", INDUSTRY)
def test_conditional_modules_are_suggested_by_their_capabilities(pack_id):
    contracts = builtin_contracts()
    conditional = [k for k in builtin_packs()[pack_id].own if contracts[k].policy == "conditional"]
    tags = sorted(
        {
            leaf.value
            for k in conditional
            for leaf in _leaves(contracts[k].condition)
            if isinstance(leaf, Contains) and leaf.path == "scope.capabilities"
        }
    )
    comp = compose(context(pack_id, "oracle-default", inputs={"scope": {"capabilities": tags}}))
    assert comp.valid, comp.problems
    m = {x.key: x for x in comp.modules}
    for key in conditional:
        assert m[key].selection == "suggested" and m[key].included, key
        assert m[key].reason.startswith("Suggested: "), key
        assert any(b.holds for b in m[key].basis), key
    # The optional tier is added by a person only, never suggested.
    for key in builtin_packs()[pack_id].own:
        if contracts[key].policy == "optional":
            assert not m[key].included


@pytest.mark.parametrize("pack_id", INDUSTRY)
def test_a_person_can_add_every_optional_module(pack_id):
    from oracle.modules.composer import Changes

    contracts = builtin_contracts()
    optional = tuple(k for k in builtin_packs()[pack_id].own if contracts[k].policy == "optional")
    comp = compose(context(pack_id, "prd-rfc"), Changes(add=optional, reason="Needed"))
    assert comp.valid, comp.problems
    m = {x.key: x for x in comp.modules}
    assert all(m[k].included and m[k].decided_by == "user" for k in optional)


@pytest.mark.parametrize("pack_id", INDUSTRY)
def test_a_category_selects_the_pack(pack_id):
    _, category, _ = INDUSTRY[pack_id]
    assert default_pack_for(category) == pack_id
    assert category in builtin_packs()[pack_id].categories


def test_section_ids_are_stable_and_unique_across_every_pack():
    sections = [s for c in builtin_contracts().values() for s in c.effective_section_ids()]
    assert len(sections) == len(set(sections))
    for pack_id in INDUSTRY:
        for key in builtin_packs()[pack_id].own:
            for s in builtin_contracts()[key].effective_section_ids():
                assert s.startswith(pack_id.split(".")[0] + "-"), (key, s)


# --- templates only: a lint over the YAML -----------------------------------------------

# Prewritten content a template must never carry: examples, named organisations, people,
# places, amounts, links, or anything a real company could be recognised by.
YAML_FORBIDDEN = [
    r"\be\.g\.",
    r"\bi\.e\.",
    r"\bfor (example|instance)\b",
    r"\bsuch as\b",
    r"\bexample\b",
    r"\bsample\b",
    r"\blorem\b",
    r"\bacme\b",
    r"\bfoo\b",
    r"\b(named|called)\b",
    r"\b(he|she|his|her|him)\b",
    r"\b(inc|ltd|llc|gmbh|plc|corp)\b\.?",
    r"https?://",
    r"www\.",
    r"\S+@\S+\.\S+",
    r"[$€£¥]\s?\d",
    r"\b\d+(\.\d+)?\s?(usd|eur|gbp|dollars?|euros?)\b",
    r"\b\d{3,}\b(?!\s*(days|hours))",
    r'"[A-Z][a-z]+ [A-Z][a-z]+"',
    r"\bshall\b",
    r"\bmust support\b",
    r"\bworkspace",
    r"\bswarm",
]
# Brands, networks, vendors, stores and regulators: never named in a template.
BRANDS = [
    "stripe",
    "adyen",
    "paypal",
    "square",
    "visa",
    "mastercard",
    "amex",
    "american express",
    "shopify",
    "amazon",
    "ebay",
    "etsy",
    "uber",
    "airbnb",
    "doordash",
    "instacart",
    "salesforce",
    "hubspot",
    "slack",
    "zoom",
    "okta",
    "auth0",
    "azure",
    "aws",
    "google",
    "gcp",
    "apple",
    "app store",
    "play store",
    "android",
    "ios",
    "microsoft",
    "oracle cloud",
    "sap",
    "workday",
    "servicenow",
    "jira",
    "notion",
    "github",
    "twilio",
    "plaid",
    "fca",
    "sec",
    "finra",
    "fincen",
    "ecb",
    "fda",
    "fcc",
    "ofcom",
    "cnil",
    "ftc",
    "united states",
    "europe",
    "european union",
    "uk",
    "china",
    "india",
    "california",
]


def _yaml_texts(obj) -> list[str]:
    if isinstance(obj, str):
        return [obj]
    if isinstance(obj, dict):
        return [
            t for k, v in obj.items() for t in (k if isinstance(k, str) else "", *_yaml_texts(v))
        ]
    if isinstance(obj, list):
        return [t for v in obj for t in _yaml_texts(v)]
    return []


@pytest.mark.parametrize("name", ["packs.yaml", *(v[2] for v in INDUSTRY.values())])
def test_no_pack_contains_example_content(name):
    raw = (BUILTIN_DIR / name).read_text(encoding="utf-8")
    data = yaml.safe_load(raw)
    for text in _yaml_texts(data):
        for pattern in YAML_FORBIDDEN:
            assert not re.search(pattern, text, re.I), (name, pattern, text)
        lowered = text.lower()
        for brand in BRANDS:
            assert not re.search(rf"(?<![a-z0-9]){re.escape(brand)}(?![a-z0-9])", lowered), (
                name,
                brand,
                text,
            )
        for word in ("persona", "character", "brand canon", "relationship mode"):
            assert word not in lowered or "configuration artifact" in lowered, (name, text)
    # Typed slots only: no defaults, enumerated values, help text or examples in fields.
    if name != "packs.yaml":
        for module in data:
            for f in module.get("fields", []):
                assert set(f) <= {
                    "key", "label", "type", "required", "item_type", "reference_type"
                }, (module["id"], f)  # fmt: skip


def test_the_lint_catches_example_content():
    """The lint itself works: each kind of prewritten content is caught."""
    samples = [
        "Describe payouts, for example weekly.",
        "Sellers on Etsy.",
        "Charge $5 per order.",
        'The "Acme Market" seller tools.',
        "See https://example.com.",
    ]
    for text in samples:
        hits = [p for p in YAML_FORBIDDEN if re.search(p, text, re.I)] + [
            b
            for b in BRANDS
            if re.search(rf"(?<![a-z0-9]){re.escape(b)}(?![a-z0-9])", text.lower())
        ]
        assert hits, text


# --- existing compositions are unchanged -------------------------------------------------


def test_existing_pack_compositions_are_unchanged():
    """The packs added beside them change nothing in General Tech Startup or the AI Agent
    Platform: the same modules, versions, selections, order and outline as before
    (captured from the release before the industry packs)."""
    golden = json.loads((FIXTURES / "existing_compositions.json").read_text())
    platform = {
        "category": "ai_agent_platform",
        "scope": {"capabilities": ["tool_use", "memory"]},
        "signals": {"tenant_count": 12},
    }
    for name, expected in golden.items():
        template, pack, inputs = name.split("|")
        comp = compose(
            context(
                pack,
                None if template == "None" else template,
                inputs=platform if inputs == "platform" else {},
            )
        )
        got = {
            "valid": comp.valid,
            "modules": [
                [m.key, m.version, m.included, m.selection, m.decided_by, m.order, m.section_ids]
                for m in comp.modules
            ],
            "outline": [o.section_id for o in comp.outline],
        }
        assert got == expected, name


def test_core_module_contracts_are_unchanged():
    """No core or platform module's contract changed, so no company gets a new release of
    them and no existing composition sees a version change."""
    contracts = builtin_contracts()
    for key in PACK_A:
        assert contracts[key].version == "1.0.0"
        assert contracts[key].applies_to == ["startup.standard", "ai-agent.platform"], key


def test_every_condition_tag_can_be_inferred_from_a_brief():
    """Each capability tag an industry module's condition reads has advisory keyword
    hints, and no hint phrase is shared between tags."""
    from oracle.modules.service import CAPABILITY_HINTS, infer_capabilities

    contracts = builtin_contracts()
    for pack_id in INDUSTRY:
        for key in builtin_packs()[pack_id].own:
            for leaf in _leaves(contracts[key].condition):
                if isinstance(leaf, Contains) and leaf.path == "scope.capabilities":
                    assert leaf.value in CAPABILITY_HINTS, (key, leaf.value)
                    phrase = CAPABILITY_HINTS[leaf.value][0]
                    assert leaf.value in infer_capabilities(f"A brief about {phrase}."), phrase
    phrases = [p for ps in CAPABILITY_HINTS.values() for p in ps]
    assert len(phrases) == len(set(phrases))
