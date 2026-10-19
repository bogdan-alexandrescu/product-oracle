"""The packaged modules, the two packs (§4.4) and the built-in template manifests.

§16 item 5: both seeded packs are templates only, with no prewritten imagined platform
features, brands, characters or personas.
"""

import json
import re

from oracle.modules.catalog import (
    builtin_contracts,
    builtin_manifests,
    builtin_packs,
    default_pack_for,
)
from oracle.templates.builtins import BUILTIN_TEMPLATES, BUILTIN_TEMPLATES_BY_KEY, builtin_body
from oracle.templates.validation import check_template
from oracle.v2.contract import ALWAYS

PACK_A = [
    "decision.executive",  # executive decision
    "strategy.alignment",  # strategic alignment
    "problem.opportunity",  # opportunity/problem
    "evidence.assumptions",  # evidence & assumptions
    "users.jtbd",  # users/JTBD
    "goals.outcomes",  # intended outcomes/success metrics
    "solution.alternatives",  # alternatives/tradeoffs
    "scope.non-goals",  # scope/non-goals
    "requirements.functional",  # functional requirements/acceptance
    "constraints.solutions",  # constraints/blockers and mitigation
    "requirements.nonfunctional",  # nonfunctional requirements
    "economics.value",  # value/cost economics
    "risks.register",  # risks
    "validation.plan",  # validation
    "release.rollout",  # release
    "decision.history",  # decision/change history
    "sources.data-points",  # sources/data points
]
PACK_B_SPECIALISED = [
    "platform.customer-onboarding",  # customer/onboarding/workspaces
    "platform.tenant-isolation",  # multi-tenant isolation
    "platform.config-precedence",  # configuration precedence/versioning
    "agents.archetypes",  # agent archetypes and behavior configuration
    "agents.tool-policies",  # tool policies
    "agents.knowledge-memory",  # knowledge/memory/state contracts
    "agents.evaluation",  # testing/simulation/evaluation
    "platform.rollout-migration",  # rollout/version migration
    "platform.fleet-operations",  # fleet operations/observability
    "platform.cost-quotas",  # cost/quotas
    "agents.external-channels",  # external social/API channel constraints
    "agents.human-interaction",  # human-agent interaction policy configurability
    "platform.brand-governance",  # customer-brand governance
    "agents.continuous-improvement",  # continuous agent improvement
    "agents.capability-portability",  # capability portability
]


def test_every_packaged_contract_validates_and_is_unique():
    contracts = builtin_contracts()
    assert len(contracts) == len(PACK_A) + len(PACK_B_SPECIALISED)
    sections = [s for c in contracts.values() for s in c.effective_section_ids()]
    assert len(sections) == len(set(sections))


def test_pack_a_is_exactly_the_section_4_4_core():
    pack = builtin_packs()["startup.standard"]
    assert list(pack.modules) == PACK_A
    assert pack.title == "General Tech Startup"


def test_pack_b_is_the_shared_core_plus_conditional_specialised_modules():
    pack = builtin_packs()["ai-agent.platform"]
    assert list(pack.modules) == PACK_A + PACK_B_SPECIALISED
    assert pack.title == "Multi-tenant AI Agent Platform"
    contracts = builtin_contracts()
    for key in PACK_B_SPECIALISED:
        # "Do not require every specialized module for every PRD."
        assert contracts[key].policy == "conditional", key
        assert contracts[key].condition != ALWAYS, key
        assert contracts[key].applies_to == ["ai-agent.platform"], key


def test_constraints_solutions_is_a_module_definition():
    c = builtin_contracts()["constraints.solutions"]
    assert c.title == "Constraints, blockers and solution strategy"
    assert c.policy == "required"
    assert c.depends_on == ["goals.outcomes"]
    assert {q.category for q in c.question_prompts} >= {"blockers", "third_party_policy"}


def test_dependencies_resolve_inside_each_pack():
    contracts = builtin_contracts()
    for pack in builtin_packs().values():
        for key in pack.modules:
            assert set(contracts[key].depends_on) <= set(pack.modules), key


def test_category_selects_a_pack():
    assert default_pack_for("ai_agent_platform") == "ai-agent.platform"
    assert default_pack_for("b2b_saas") == "startup.standard"
    assert default_pack_for(None) == "startup.standard"


# --- §16.5: templates only -------------------------------------------------------------

# Content a template must never prewrite: examples, named products, brands or characters.
FORBIDDEN = [
    r"\be\.g\.",
    r"\bfor example\b",
    r"\bsuch as\b",
    r"\bacme\b",
    r"\bnamed\b",
    r"\bcalled\b",
    r"\bher\b",
    r"\bhis\b",
    r"\bshe\b",
    r"\bhe\b",
    r"\byour (brand|character|persona)\b",
    r"\bcatchphrase\b",
    r"\bbackstory\b",
    r'"[A-Z][a-z]+ [A-Z][a-z]+"',
]
# Words that may appear only to say the content lives in a linked configuration artifact.
CONFIG_ONLY = ("persona", "character", "brand canon", "relationship mode")


def _texts(obj) -> list[str]:
    if isinstance(obj, str):
        return [obj]
    if isinstance(obj, dict):
        return [t for v in obj.values() for t in _texts(v)]
    if isinstance(obj, list):
        return [t for v in obj for t in _texts(v)]
    return []


def test_packs_are_templates_only_no_prewritten_content():
    for key, contract in builtin_contracts().items():
        data = contract.model_dump(mode="json")
        for text in _texts(data):
            for pattern in FORBIDDEN:
                assert not re.search(pattern, text, re.I), (key, pattern, text)
            lowered = text.lower()
            if any(word in lowered for word in CONFIG_ONLY):
                assert "configuration artifact" in lowered, (key, text)
        # Field definitions are typed slots: no defaults, examples or prefilled values.
        for f in contract.fields:
            assert set(f.model_dump(exclude_none=True)) <= {
                "key", "label", "type", "required", "help", "options", "item_type",
                "reference_type",
            }  # fmt: skip
            assert f.help is None and not f.options
        # Nothing that reads like a requirement already decided.
        blob = json.dumps(data).lower()
        assert "shall" not in blob and "must support" not in blob, key


def test_module_text_keeps_to_oracle_words():
    """Build brief §2 and build prompt §1: no SwarmCloud jargon in Oracle's product (MOD-1)."""
    for key, c in builtin_contracts().items():
        text = " ".join(_texts(c.model_dump(mode="json"))).lower()
        assert "workspace" not in text, key
        assert "swarm" not in text, key


def test_specialised_platform_modules_point_people_at_configuration_artifacts():
    contracts = builtin_contracts()
    for key in ("agents.archetypes", "platform.brand-governance", "platform.config-precedence"):
        c = contracts[key]
        assert "linked configuration artifact" in " ".join(_texts(c.model_dump())).lower(), key
        assert any(f.key.endswith("artifact") for f in c.fields), key


def test_every_module_keeps_evidence_out_of_the_body():
    for key, c in builtin_contracts().items():
        assert c.evidence_policy == "record_provenance_in_appendix", key
    assert builtin_contracts()["sources.data-points"].effective_section_ids()[0] == "sources"


# --- manifests --------------------------------------------------------------------------


def test_each_builtin_prd_template_has_a_manifest_and_no_roadmap_does():
    prd = {t.key for t in BUILTIN_TEMPLATES if t.kind == "prd"}
    assert set(builtin_manifests()) == prd
    assert len(prd) == 7


def test_manifest_sections_exist_in_their_template_and_map_once():
    for key, manifest in builtin_manifests().items():
        body = builtin_body(BUILTIN_TEMPLATES_BY_KEY[key])
        sections = set(check_template(body).section_keys)
        mapped = [s for ss in manifest.modules.values() for s in ss]
        assert len(mapped) == len(set(mapped)), key
        assert set(mapped) <= sections, (key, set(mapped) - sections)
        # O1c: every template's appendix belongs to the sources module.
        assert manifest.modules["sources.data-points"][0] == "sources", key
        # Unmapped sections stay template-owned (title, features, milestones...).
        assert {"title", "brief-items", "feature-detail"} <= sections - set(mapped), key


def test_manifests_only_map_where_unambiguous():
    m = builtin_manifests()
    # Container and mixed sections are never mapped.
    assert all("problem-alignment" not in ss for ss in m["oracle-default"].modules.values())
    assert all("goals" not in ss for ss in m["prd-rfc"].modules.values())  # goals AND non-goals
    # Different names for the same thing map to the same module.
    assert m["one-pager"].modules["scope.non-goals"] == ("non-goals",)
    assert m["pr-faq"].modules["scope.non-goals"] == ("not-doing",)
    assert m["shape-up-pitch"].modules["scope.non-goals"] == ("no-gos",)
