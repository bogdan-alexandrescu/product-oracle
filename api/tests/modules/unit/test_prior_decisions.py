"""A person's earlier composition decisions carry into the next revision (review MAJOR 1).

A module a person removed stays out, one a person added stays in, and a person's order
holds, until a person decides otherwise. A carried decision that no longer fits is never
applied silently: the composition says why it was set aside.
"""

from oracle.modules.composer import Changes, Decision, compose
from tests.modules.helpers import context

PLATFORM = {
    "category": "ai_agent_platform",
    "scope": {"capabilities": ["tool_use", "memory"]},
    "signals": {"tenant_count": 12},
}
ACTOR = "00000000-0000-0000-0000-00000000000a"


def by_key(comp):
    return {m.key: m for m in comp.modules}


def codes(comp):
    return {p.code for p in comp.problems}


def removed(key, reason="Not this PRD"):
    return Decision(key=key, included=False, reason=reason, actor_id=ACTOR)


def added(key, reason="Needed here"):
    return Decision(key=key, included=True, reason=reason, actor_id=ACTOR)


def test_a_removed_module_stays_out_when_the_next_change_adds_another():
    ctx = context("ai-agent.platform", inputs=PLATFORM, prior_decisions=(
        removed("agents.knowledge-memory"),
    ))  # fmt: skip
    comp = compose(ctx, Changes(add=("platform.cost-quotas",), reason="Quotas matter"))
    m = by_key(comp)
    assert comp.valid, comp.problems
    memory = m["agents.knowledge-memory"]
    assert not memory.included and memory.decided_by == "user"
    assert memory.user_reason == "Not this PRD" and str(memory.overridden_by) == ACTOR
    assert m["platform.cost-quotas"].included and m["platform.cost-quotas"].decided_by == "user"


def test_an_added_module_survives_a_later_change():
    ctx = context("ai-agent.platform", inputs=PLATFORM, prior_decisions=(
        added("platform.brand-governance", "Customers brand their agents"),
    ))  # fmt: skip
    comp = compose(ctx, Changes(remove=("agents.knowledge-memory",), reason="Later"))
    brand = by_key(comp)["platform.brand-governance"]
    assert comp.valid
    assert brand.included and brand.decided_by == "user"
    assert brand.user_reason == "Customers brand their agents"


def test_without_any_change_the_prior_decisions_still_hold():
    ctx = context("ai-agent.platform", inputs=PLATFORM, prior_decisions=(
        removed("agents.knowledge-memory"), added("platform.brand-governance"),
    ))  # fmt: skip
    m = by_key(compose(ctx))
    assert not m["agents.knowledge-memory"].included
    assert m["platform.brand-governance"].included


def test_this_request_overrides_a_prior_decision():
    ctx = context("ai-agent.platform", inputs=PLATFORM, prior_decisions=(
        removed("agents.knowledge-memory"), added("platform.brand-governance"),
    ))  # fmt: skip
    comp = compose(
        ctx,
        Changes(
            add=("agents.knowledge-memory",),
            remove=("platform.brand-governance",),
            reason="Changed our mind",
        ),
    )
    m = by_key(comp)
    assert comp.valid, comp.problems
    assert m["agents.knowledge-memory"].included
    assert m["agents.knowledge-memory"].user_reason == "Changed our mind"
    assert not m["platform.brand-governance"].included
    assert m["platform.brand-governance"].user_reason == "Changed our mind"


def test_a_person_s_order_is_kept_and_new_modules_slot_in():
    base = compose(context("ai-agent.platform", inputs=PLATFORM))
    keys = [m.key for m in base.included]
    # Move risks before scope: allowed (no ordering constraint between them).
    wanted = list(keys)
    wanted.remove("risks.register")
    wanted.insert(wanted.index("scope.non-goals"), "risks.register")
    first = compose(
        context("ai-agent.platform", inputs=PLATFORM), Changes(order=tuple(wanted), reason="r")
    )
    assert [m.key for m in first.included] == wanted
    assert all(m.ordered_by_user for m in first.included)

    ctx = context("ai-agent.platform", inputs=PLATFORM, prior_order=tuple(wanted))
    second = compose(ctx, Changes(add=("platform.cost-quotas",), reason="Quotas"))
    order = [m.key for m in second.included]
    assert second.valid, second.problems
    assert order.index("risks.register") < order.index("scope.non-goals")
    assert "platform.cost-quotas" in order and order[-1] == "sources.data-points"
    assert all(m.ordered_by_user for m in second.included)


def test_a_default_order_is_not_marked_as_a_person_s():
    comp = compose(context("ai-agent.platform", inputs=PLATFORM))
    assert not any(m.ordered_by_user for m in comp.modules)


def test_a_removed_module_that_became_mandatory_comes_back_and_says_why():
    ctx = context(
        "ai-agent.platform",
        inputs=PLATFORM,
        company_required=("agents.knowledge-memory",),
        prior_decisions=(removed("agents.knowledge-memory"),),
    )
    comp = compose(ctx)
    memory = by_key(comp)["agents.knowledge-memory"]
    assert comp.valid  # not fatal: nobody asked for it in this change
    assert memory.included and memory.selection == "mandatory"
    problem = next(p for p in comp.problems if p.code == "decision_superseded")
    assert problem.module == "agents.knowledge-memory" and not problem.fatal


def test_a_removed_dependency_comes_back_when_a_new_module_needs_it():
    # platform.cost-quotas depends on economics.value, which the company relaxed to
    # optional and a person removed earlier.
    ctx = context(
        "ai-agent.platform",
        inputs=PLATFORM,
        company_optional=("economics.value",),
        prior_decisions=(removed("economics.value"),),
    )
    comp = compose(ctx, Changes(add=("platform.cost-quotas",), reason="Quotas"))
    m = by_key(comp)
    assert comp.valid, comp.problems
    assert m["economics.value"].included and m["economics.value"].decided_by == "dependency"
    assert "decision_superseded" in codes(comp)


def test_a_carried_addition_that_is_now_disabled_is_dropped_with_a_note():
    ctx = context(
        "ai-agent.platform",
        inputs=PLATFORM,
        company_disabled=("platform.brand-governance",),
        prior_decisions=(added("platform.brand-governance"),),
    )
    comp = compose(ctx)
    assert comp.valid
    assert not by_key(comp)["platform.brand-governance"].included
    problem = next(p for p in comp.problems if p.code == "decision_dropped")
    assert not problem.fatal


def test_a_carried_addition_of_a_module_now_archived_is_dropped_with_a_note():
    ctx = context(
        "startup.standard",
        unavailable={"company.extra"},
        prior_decisions=(added("company.extra"),),
    )
    comp = compose(ctx)
    assert comp.valid
    assert "decision_dropped" in codes(comp)
