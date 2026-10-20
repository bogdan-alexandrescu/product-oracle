"""The seventeen question categories of §5, what each one affects, and how gaps rank.

Each category has a default importance, the areas a missing answer affects (§5 step 5:
goals, feasibility, scope, economics, risks, module selection), the question Oracle asks,
the stop condition that closes it, and the module keys it informs. Signals found in the
brief raise a category's importance (a partner API makes third-party policy critical).

Module keys are *hints* for the modules lane's composer (``constraints.solutions`` is the
foundation's seed key); the composer decides, through its own routes.
"""

import re
from dataclasses import dataclass

from oracle.v2.schemas import GapCategory, ImpactArea, Importance


@dataclass(frozen=True)
class Category:
    key: GapCategory
    label: str
    importance: Importance
    impact: tuple[ImpactArea, ...]
    statement: str
    prompt: str
    stop: str
    modules: tuple[str, ...] = ()
    # Signal name -> importance when the signal is present.
    raised_by: tuple[tuple[str, Importance], ...] = ()
    # Importance when none of ``raised_by`` is present (else ``importance``).
    quiet: Importance | None = None


CATEGORIES: tuple[Category, ...] = (
    Category(
        "customer_user", "Customer and user", "high", ("goals", "scope", "module_selection"),
        "The primary user or customer segment is not confirmed.",
        "Who exactly is this for, and which user or customer segment comes first?",
        "A named primary segment, confirmed by the decider.",
        ("context.users",),
    ),
    Category(
        "pain_evidence", "Pain evidence", "high", ("goals", "economics"),
        "There is no confirmed evidence that the pain is real and frequent.",
        "What shows this pain is real (support tickets, interviews, data), and how often "
        "does it happen?",
        "At least one cited source, or an explicitly accepted assumption.",
        ("problem.evidence",),
    ),
    Category(
        "goal_alignment", "Company-goal alignment", "critical", ("goals", "scope"),
        "No confirmed company goal is linked to this idea.",
        "Which confirmed company goal does this serve, and how much does it contribute "
        "(0-3)?",
        "A link to a confirmed goal, or a logged decision to proceed without one.",
        ("goals.outcomes",),
    ),
    Category(
        "success_metric", "Success metric and baseline", "critical", ("goals", "scope"),
        "No success metric with a baseline value and a target is agreed.",
        "Which metric shows this worked, what is its value today, and what target by when?",
        "A named metric with a baseline value and a dated target.",
        ("goals.outcomes",),
    ),
    Category(
        "differentiation", "Strategic differentiation", "medium", ("goals", "economics"),
        "Why this beats what competitors or the status quo offer is not stated.",
        "What makes this better than what buyers can already do or buy?",
        "A one-sentence differentiation the decider agrees with.",
    ),
    Category(
        "alternatives", "Alternatives", "medium", ("scope", "feasibility"),
        "Alternatives (including doing nothing) have not been compared.",
        "Which alternatives did you consider, including doing nothing, and why not those?",
        "At least one alternative with the reason it lost.",
    ),
    Category(
        "constraints", "Current and future constraints", "high", ("feasibility", "scope"),
        "Technical, legal or organisational constraints are not listed.",
        "Which technical, legal or team constraints apply now, and which may apply later?",
        "Constraints listed, or a confirmed 'none known'.",
        ("constraints.solutions",),
    ),
    Category(
        "blockers", "Blockers", "high", ("feasibility", "risks", "module_selection"),
        "It is unknown whether anything could stop this from shipping.",
        "What could stop this from shipping at all: hard limits, dependencies, approvals?",
        "Every known blocker recorded with an owner, or a confirmed 'none known'.",
        ("constraints.solutions",),
        raised_by=(("blockers", "critical"),),
    ),
    Category(
        "economic_benefit", "Expected economic benefit", "high", ("economics", "goals"),
        "The expected economic benefit is not estimated.",
        "What is this worth: revenue, retention or cost saved, roughly and by when?",
        "An order-of-magnitude benefit with its assumption.",
        ("business.case",),
    ),
    Category(
        "effort_cost", "Effort and cost", "medium", ("economics", "feasibility"),
        "Effort and running cost are not estimated.",
        "Roughly how much effort and running cost would this take (team-weeks, monthly cost)?",
        "An effort range from engineering, or a feasibility experiment to get one.",
    ),
    Category(
        "security_privacy", "Security and privacy", "medium",
        ("risks", "feasibility", "module_selection"),
        "Security and privacy impact is not assessed.",
        "Which personal or sensitive data does this touch, and which security or privacy "
        "review does it need?",
        "Data touched is listed and the required review is named.",
        ("security.privacy",),
        raised_by=(("personal_data", "critical"),),
    ),
    Category(
        "ownership", "Team ownership", "high", ("risks", "scope"),
        "No team or person owns the outcome.",
        "Which team and which person own building it and its outcome?",
        "A named owning team and an accountable person.",
    ),
    Category(
        "non_goals", "Non-goals", "medium", ("scope",),
        "What is deliberately out of scope is not stated.",
        "What is deliberately out of scope for the first release?",
        "At least one confirmed non-goal.",
        ("scope.non_goals",),
    ),
    Category(
        "release_rollout", "Release and rollout", "medium", ("risks", "scope"),
        "How this is released and rolled back is not planned.",
        "How should this roll out (flag, beta, regions), and how would we roll it back?",
        "A rollout plan with a rollback path.",
        ("launch.rollout",),
    ),
    Category(
        "evaluation_criteria", "Evaluation criteria", "medium", ("goals", "risks"),
        "How quality is evaluated before launch is not defined.",
        "How will we judge quality before launch (acceptance criteria, evals, review)?",
        "Acceptance criteria, or an eval set for model-driven behaviour.",
        ("quality.evaluation",),
        raised_by=(("ai", "high"),),
        quiet="low",
    ),
    Category(
        "third_party_policy", "Third-party policy and API limits", "medium",
        ("feasibility", "risks", "module_selection"),
        "Third-party API eligibility, limits, permissions and policies are not checked.",
        "Which third-party APIs or platforms does this rely on, and what are their rate "
        "limits, eligibility rules, permissions and policies?",
        "Each dependency's limits and policy checked, with a compliant option chosen.",
        ("constraints.solutions", "integrations.third_party"),
        raised_by=(("third_party", "critical"),),
        quiet="low",
    ),
    Category(
        "configurability_scaling", "Configurability and scaling", "medium",
        ("feasibility", "economics"),
        "Expected scale and what must be configurable are not known.",
        "What scale must this handle at launch and in a year, and what must be "
        "configurable per customer?",
        "Launch and one-year scale targets, and the configurable settings.",
        ("scaling.operations",),
        raised_by=(("scale", "high"),),
        quiet="low",
    ),
)  # fmt: skip

BY_KEY: dict[str, Category] = {c.key: c for c in CATEGORIES}
ORDER: dict[str, int] = {c.key: i for i, c in enumerate(CATEGORIES)}

# Categories whose unresolved critical gaps are hard blockers in the review gate (T2:
# a critical unresolved hard blocker, or an unsupported third-party operation).
HARD_BLOCKER_CATEGORIES = frozenset({"blockers", "third_party_policy"})


def reviewer(category: str) -> str:
    """Who reviews a critical gap answered below the owner role (B4): an owner for a
    hard blocker, an approver otherwise."""
    return "owner" if category in HARD_BLOCKER_CATEGORIES else "approver"


# Brief fields that speak to a category (the author's claim, a hypothesis).
BRIEF_FIELDS = {
    "customer_user": "users",
    "non_goals": "non_goals",
    "constraints": "dependencies",
    "blockers": "blockers",
}
# What the brief speaking to a category does to its importance.
LOWER = {"critical": "critical", "high": "medium", "medium": "low", "low": "low"}
# A category nothing public speaks to: the same words whoever reads (S6).
UNKNOWN_REASON = "Nothing in the pinned sources or the baseline answers it."

# §5 step 5: how much each area weighs when ranking a missing answer.
IMPACT_WEIGHTS: dict[str, float] = {
    "goals": 3.0,
    "feasibility": 3.0,
    "scope": 2.0,
    "economics": 2.0,
    "risks": 2.0,
    "module_selection": 1.0,
}
IMPORTANCE_WEIGHTS: dict[str, float] = {"critical": 4.0, "high": 3.0, "medium": 2.0, "low": 1.0}
# How much of a gap is already known, by its knowledge state (§5 step 3). Confidence of
# the evidence behind an inference refines it; it never makes the gap a fact.
KNOWN: dict[str, float] = {
    "unknown": 0.0,
    # The brief's word: it says what the author believes, not what is known.
    "hypothesis": 0.1,
    "ai_inference": 0.4,
    "user_decision": 1.0,
    "verified_fact": 1.0,
}

SIGNALS: dict[str, re.Pattern[str]] = {
    "ai": re.compile(
        r"\b(ai|llm|llms|model[- ]driven|machine learning|ml|agents?|gpt|claude|classifier)\b",
        re.I,
    ),
    "third_party": re.compile(
        r"\b(api|apis|third[- ]party|partners?|platforms?|integrations?|vendors?|"
        r"marketplace|app store|webhooks?|oauth)\b",
        re.I,
    ),
    "personal_data": re.compile(
        r"\b(personal data|personal|pii|privacy|gdpr|addresses|address|e-?mails?|phone|"
        r"payments?|cards?|health|locations?|passwords?)\b",
        re.I,
    ),
    "blockers": re.compile(
        r"\b(rate limits?|quotas?|limits?|blocked|blockers?|approvals?|policy|policies|"
        r"compliance|legal|regulat\w*|depends on|dependency|dependencies|cannot|can't)\b",
        re.I,
    ),
    "scale": re.compile(
        r"\b(scale|scaling|millions?|thousands|concurrent|throughput|latency|configurable|"
        r"per[- ]customer|multi[- ]tenant)\b",
        re.I,
    ),
    "new_product": re.compile(
        r"\b(new product|new market|from scratch|launch a|new business)\b", re.I
    ),
    "small_change": re.compile(r"\b(small|tweak|minor|copy change|quick fix)\b", re.I),
}


def signals_in(text: str) -> dict[str, bool]:
    return {name: bool(pattern.search(text)) for name, pattern in SIGNALS.items()}


def importance_for(category: Category, signals: dict[str, bool]) -> Importance:
    raised = [imp for name, imp in category.raised_by if signals.get(name)]
    if raised:
        return min(raised, key=lambda i: -IMPORTANCE_WEIGHTS[i])
    if category.raised_by and category.quiet:
        return category.quiet
    return category.importance


def brief_importance(
    category: Category, signals: dict[str, bool], brief_speaks: bool
) -> Importance:
    """A rule-made gap's importance from the brief alone (S6, owner 2026-10-19): a
    person's private sources never raise or lower it."""
    importance = importance_for(category, signals)
    return LOWER[importance] if brief_speaks else importance  # type: ignore[return-value]


def brief_reason(texts: list[str]) -> str:
    return "Only the brief states it: " + "; ".join(texts)


def rank_score(
    importance: str, impact: list[str], knowledge_state: str, confidence: float | None
) -> float:
    """Expected effect of the missing answer: importance x affected areas x unknown share."""
    areas = sum(IMPACT_WEIGHTS.get(a, 0.0) for a in impact)
    known = KNOWN.get(knowledge_state, 0.0)
    if knowledge_state == "ai_inference" and confidence is not None:
        known = max(known, min(0.8, float(confidence)))
    return round(IMPORTANCE_WEIGHTS.get(importance, 1.0) * areas * (1 - known), 3)


def rank_reason(category: Category, importance: str, impact: list[str], state: str) -> str:
    areas = ", ".join(a.replace("_", " ") for a in impact) or "nothing listed"
    known = {
        "unknown": "nothing in the pinned sources or the baseline answers it",
        "hypothesis": "only the brief states it; nobody has confirmed it",
        "ai_inference": "Oracle inferred it from sources; a person has not confirmed it",
        "user_decision": "a person decided it",
        "verified_fact": "a pinned source states it",
    }[state]
    return f"{importance.capitalize()} {category.label.lower()} gap: affects {areas}; {known}."
