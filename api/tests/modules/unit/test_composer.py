"""The composer (§4.3), pure: policy, explained suggestions, closure, conflicts, order.

§16 item 4: a required module or dependency cannot be silently removed; valid
conditional rules and company policies explain why modules are suggested.
"""

from oracle.modules.catalog import builtin_contracts
from oracle.modules.composer import Advisory, Changes, Provenance, compose, validate_fields
from oracle.v2.contract import validate_contract
from tests.modules.helpers import context

PLATFORM_INPUTS = {
    "category": "ai_agent_platform",
    "scope": {"capabilities": ["tool_use", "memory"]},
    "signals": {"tenant_count": 12},
}


def by_key(comp):
    return {m.key: m for m in comp.modules}


def codes(comp):
    return {p.code for p in comp.problems}


def custom(**fields) -> dict:
    base = {"version": "1.0.0", "title": fields["id"].title(), "policy": "optional"}
    return {**base, **fields}


def test_required_modules_are_mandatory_and_say_who_requires_them():
    comp = compose(context())
    m = by_key(comp)
    assert comp.valid
    for key in ("decision.executive", "constraints.solutions", "sources.data-points"):
        assert m[key].included and m[key].selection == "mandatory"
        assert m[key].decided_by == "policy"
    assert m["constraints.solutions"].reason == "Mandatory in the startup.standard pack."


def test_company_policy_decides_the_mandatory_modules():
    comp = compose(
        context(
            company_required=("platform.tenant-isolation",),
            company_optional=("validation.plan",),
        )
    )
    m = by_key(comp)
    assert m["platform.tenant-isolation"].selection == "mandatory"
    assert m["platform.tenant-isolation"].reason == "Mandatory: company module policy requires it."
    assert m["platform.tenant-isolation"].policy_source == "company"
    # Its dependency (non-functional requirements) comes along.
    assert m["requirements.nonfunctional"].included
    # Relaxed by the company: optional, and not in oracle-default's sections, so out.
    assert m["validation.plan"].selection == "optional" and not m["validation.plan"].included


def test_conditional_modules_explain_inclusion_and_omission():
    comp = compose(context(pack="ai-agent.platform", inputs=PLATFORM_INPUTS))
    m = by_key(comp)
    tools = m["agents.tool-policies"]
    assert tools.included and tools.selection == "suggested" and tools.decided_by == "condition"
    assert "scope.capabilities contains 'tool_use'" in tools.reason
    assert tools.basis and any(b.holds for b in tools.basis)
    brand = m["platform.brand-governance"]
    assert not brand.included and brand.selection == "optional"
    assert brand.reason.startswith("Not suggested: its condition did not hold")
    # What would have decided it, and is unknown, is missing information.
    assert "Input signals.customer_branded is missing." in brand.missing_information
    assert {b.path for b in brand.basis if b.missing} == {"signals.customer_branded"}


def test_not_every_specialised_module_is_required():
    comp = compose(context(pack="ai-agent.platform", inputs={"category": "b2b_saas"}))
    included = {m.key for m in comp.included}
    assert not any(k.startswith(("agents.", "platform.")) for k in included)


def test_basis_carries_the_source_and_knowledge_state():
    comp = compose(
        context(
            pack="ai-agent.platform",
            inputs=PLATFORM_INPUTS,
            provenance={
                "scope.capabilities": Provenance(
                    "ai_inference",
                    ("9b2f8a8e-6d1c-4d6a-9a43-1f1f2b7c0a01",),
                    "keywords in the intake brief",
                ),
            },
        )
    )
    basis = [b for b in by_key(comp)["agents.tool-policies"].basis if b.holds][0]
    assert basis.knowledge_state == "ai_inference"
    assert basis.source == "keywords in the intake brief"
    assert [str(i) for i in by_key(comp)["agents.tool-policies"].driven_by] == [
        "9b2f8a8e-6d1c-4d6a-9a43-1f1f2b7c0a01"
    ]
    tenants = [b for b in by_key(comp)["platform.tenant-isolation"].basis if b.holds]
    assert {b.knowledge_state for b in tenants} == {"user_decision"}


def test_advisory_scores_never_decide_alone():
    comp = compose(
        context(
            pack="ai-agent.platform",
            inputs={"category": "b2b_saas"},
            advisory={"platform.cost-quotas": Advisory(0.95, "Similar PRDs needed quotas")},
        )
    )
    quotas = by_key(comp)["platform.cost-quotas"]
    assert not quotas.included and quotas.score == 0.95
    assert any("advisory only" in line for line in quotas.explanation)


def test_template_sections_keep_their_module_even_when_its_condition_fails():
    comp = compose(context(template="narrative-memo"))  # renders options -> alternatives
    alt = by_key(comp)["solution.alternatives"]
    # The memo's "Options" heading is level 2: the template's spine makes it mandatory.
    assert alt.included and alt.selection == "mandatory" and alt.policy_source == "template"
    comp = compose(context(template="prd-rfc"))  # alternatives is level 3: optional
    alt = by_key(comp)["solution.alternatives"]
    assert alt.included and alt.decided_by == "template" and alt.selection == "optional"
    assert "already has its sections" in alt.reason


# --- people's changes: never silently remove ---------------------------------------------


def test_a_mandatory_module_cannot_be_removed():
    comp = compose(context(), Changes(remove=("constraints.solutions",), reason="too long"))
    assert not comp.valid
    problem = next(p for p in comp.problems if p.code == "required_module")
    assert problem.module == "constraints.solutions"
    assert "company module policy" in problem.message
    assert by_key(comp)["constraints.solutions"].included


def test_a_dependency_cannot_be_removed_while_a_dependent_stays():
    ctx = context(pack="ai-agent.platform", inputs=PLATFORM_INPUTS)
    comp = compose(ctx, Changes(remove=("agents.archetypes",), reason="not needed"))
    assert "required_dependency" in codes(comp)
    msg = next(p.message for p in comp.problems if p.code == "required_dependency")
    assert "depends on it" in msg
    # Removing the dependents too is allowed.
    comp = compose(
        ctx,
        Changes(
            remove=(
                "agents.archetypes",
                "agents.tool-policies",
                "agents.knowledge-memory",
                "agents.evaluation",
            ),
            reason="Archetypes are out of scope for this PRD",
        ),
    )
    assert comp.valid, comp.problems
    m = by_key(comp)
    assert not m["agents.archetypes"].included and m["agents.archetypes"].decided_by == "user"
    assert m["agents.archetypes"].user_reason == "Archetypes are out of scope for this PRD"


def test_a_removed_suggestion_records_the_person_and_reason():
    ctx = context(pack="ai-agent.platform", inputs=PLATFORM_INPUTS)
    actor = "5d8c1f3e-2a4b-4c6d-8e9f-0a1b2c3d4e5f"
    comp = compose(
        ctx, Changes(remove=("agents.knowledge-memory",), reason="later", actor_id=actor)
    )
    mem = by_key(comp)["agents.knowledge-memory"]
    assert comp.valid and not mem.included
    assert str(mem.overridden_by) == actor and mem.user_reason == "later"


def test_adding_a_module_pulls_in_its_dependencies_with_an_explanation():
    comp = compose(context(), Changes(add=("platform.cost-quotas",), reason="usage pricing"))
    m = by_key(comp)
    assert comp.valid
    assert m["platform.cost-quotas"].included and m["platform.cost-quotas"].decided_by == "user"
    econ = m["economics.value"]
    assert econ.included and econ.decided_by == "dependency"
    assert econ.reason == "Included because Cost and quotas depends on it."
    assert econ.required_by == ["platform.cost-quotas"]


def test_disabled_and_unknown_modules_cannot_be_added():
    comp = compose(
        context(company_disabled=("economics.value",)),
        Changes(add=("economics.value", "made.up"), reason="x"),
    )
    assert {"module_disabled", "unknown_module"} <= codes(comp)


def test_owner_gated_modules_need_the_owner_role():
    contracts = dict(builtin_contracts())
    contracts["compliance.review"] = validate_contract(
        custom(id="compliance.review", required_review_role="owner")
    )
    ctx = context(contracts=contracts)
    comp = compose(ctx, Changes(add=("compliance.review",), reason="x", role="approver"))
    assert "role_required" in codes(comp)
    comp = compose(ctx, Changes(add=("compliance.review",), reason="x", role="owner"))
    assert comp.valid


# --- closure, conflicts, order ------------------------------------------------------------


def test_an_unsatisfiable_required_dependency_fails_clearly():
    comp = compose(context(company_disabled=("goals.outcomes",)))
    assert not comp.valid
    problem = next(p for p in comp.problems if p.code == "unsatisfied_dependency")
    assert "disabled by company policy" in problem.message


def test_a_suggested_module_with_an_unavailable_dependency_is_dropped_and_explained():
    contracts = dict(builtin_contracts())
    contracts.pop("agents.archetypes")  # archived by the company
    comp = compose(context(pack="ai-agent.platform", inputs=PLATFORM_INPUTS, contracts=contracts))
    tools = by_key(comp)["agents.tool-policies"]
    assert comp.valid and not tools.included
    assert "unavailable" in tools.reason
    # Archived by the company: not offered, and the composition says so without failing.
    comp = compose(
        context(
            pack="ai-agent.platform",
            inputs=PLATFORM_INPUTS,
            contracts=contracts,
            unavailable={"agents.archetypes"},
        )
    )
    archived = [p for p in comp.problems if p.code == "module_archived"]
    assert comp.valid and archived and not archived[0].fatal


def test_conflicts_drop_the_weaker_module_or_fail():
    contracts = dict(builtin_contracts())
    contracts["one.way"] = validate_contract(
        custom(
            id="one.way",
            applies_to=["startup.standard"],
            policy="conditional",
            condition={"op": "eq", "path": "category", "value": "x"},
            conflicts_with=["other.way"],
        )
    )
    contracts["other.way"] = validate_contract(
        custom(
            id="other.way",
            applies_to=["startup.standard"],
            policy="conditional",
            condition={"op": "eq", "path": "category", "value": "x"},
        )
    )
    packs = {"startup.standard": (*context().packs["startup.standard"], "one.way", "other.way")}
    ctx = context(contracts=contracts, packs=packs, inputs={"category": "x"})
    comp = compose(ctx, None)
    m = by_key(comp)
    assert comp.valid
    assert m["one.way"].included != m["other.way"].included
    dropped = m["other.way"] if m["one.way"].included else m["one.way"]
    assert dropped.decided_by == "conflict" and "conflicts with" in dropped.reason
    # A person cannot add the dropped one without removing the other.
    comp = compose(ctx, Changes(add=(dropped.key,), reason="prefer it"))
    assert "conflict" in codes(comp)
    # Two mandatory modules that conflict fail clearly.
    comp = compose(
        context(contracts=contracts, packs=packs, company_required=("one.way", "other.way"))
    )
    assert "required_conflict" in codes(comp)


def test_order_is_deterministic_and_respects_constraints():
    ctx = context(pack="ai-agent.platform", inputs=PLATFORM_INPUTS)
    orders = {tuple(m.key for m in compose(ctx).included) for _ in range(5)}
    assert len(orders) == 1
    order = list(orders.pop())
    assert order[-1] == "sources.data-points"  # O1c: the appendix is last
    assert order.index("strategy.alignment") < order.index("goals.outcomes")
    assert order.index("requirements.functional") < order.index("release.rollout")
    assert [m.order for m in compose(ctx).included] == [10 * (i + 1) for i in range(len(order))]


def test_a_person_may_reorder_within_the_constraints():
    ctx = context()
    order = [m.key for m in compose(ctx).included]
    swapped = order.copy()
    i, j = (
        swapped.index("risks.register"),
        swapped.index("economics.value")
        if ("economics.value" in swapped)
        else swapped.index("requirements.nonfunctional"),
    )
    swapped[i], swapped[j] = swapped[j], swapped[i]
    comp = compose(ctx, Changes(order=tuple(swapped), reason="risks first"))
    assert comp.valid and [m.key for m in comp.included] == swapped
    # Breaking a constraint is refused, as is putting anything after the appendix.
    bad = order.copy()
    bad.remove("goals.outcomes")
    bad.insert(0, "goals.outcomes")
    comp = compose(ctx, Changes(order=tuple(bad), reason="x"))
    assert "order_violation" in codes(comp)
    last = order.copy()
    last.remove("sources.data-points")
    last.insert(0, "sources.data-points")
    assert "order_violation" in codes(compose(ctx, Changes(order=tuple(last), reason="x")))
    assert "order_mismatch" in codes(compose(ctx, Changes(order=tuple(order[:-1]), reason="x")))


def test_order_cycles_are_reported():
    contracts = dict(builtin_contracts())
    contracts["a.one"] = validate_contract(custom(id="a.one", order_after=["a.two"]))
    contracts["a.two"] = validate_contract(custom(id="a.two", order_after=["a.one"]))
    comp = compose(context(contracts=contracts, company_required=("a.one", "a.two")))
    assert "order_cycle" in codes(comp)


def test_section_collisions_are_refused():
    contracts = dict(builtin_contracts())
    contracts["dup.module"] = validate_contract(custom(id="dup.module", section_ids=["priority"]))
    comp = compose(
        context(contracts=contracts, template="one-pager", company_required=("dup.module",))
    )
    assert "section_collision" in codes(comp)


# --- brief/full impact, outline and fields ---------------------------------------------


def test_layer_impact_of_template_and_new_modules():
    comp = compose(context(pack="ai-agent.platform", template="one-pager", inputs=PLATFORM_INPUTS))
    m = by_key(comp)
    risks = m["risks.register"].layer_impact
    assert risks.template_sections == ["top-risks"] and risks.brief_sections == ["top-risks"]
    assert risks.new_sections == []
    tenants = m["platform.tenant-isolation"].layer_impact
    assert tenants.new_sections == ["tenant-isolation"] and tenants.full_sections == [
        "tenant-isolation"
    ]
    outline = [e.section_id for e in comp.outline]
    assert outline.index("tenant-isolation") > outline.index("full")
    assert outline.index("tenant-isolation") < outline.index("sources")
    assert outline[0] == "title"


def test_field_values_are_validated_against_the_module_validators():
    contract = builtin_contracts()["goals.outcomes"]
    problems = validate_fields(contract, {"metric": "", "baseline_value": "ten", "nope": 1})
    kinds = {(p.field, p.kind) for p in problems}
    assert ("metric", "required") in kinds
    assert ("baseline_value", "type") in kinds
    assert ("nope", "unknown") in kinds
    ok = validate_fields(
        contract,
        {"outcomes": ["o-1"], "metric": "Weekly active teams", "baseline_value": 10},
        evidence={"baseline_value": ["c1"]},
    )
    assert ok == []
    comp = compose(context(field_values={"goals.outcomes": {"metric": ""}}))
    assert by_key(comp)["goals.outcomes"].field_problems


def test_same_context_same_composition():
    ctx = context(pack="ai-agent.platform", inputs=PLATFORM_INPUTS)
    dumps = {compose(ctx).model_dump_json() for _ in range(3)}
    assert len(dumps) == 1
