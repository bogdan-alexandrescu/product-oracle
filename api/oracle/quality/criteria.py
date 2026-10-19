"""The ten PRD quality criteria (§10) and the two hard checks, as readiness checks.

T2 (owner, 2026-10-19): advisory evaluation, gate criticals only. The ten criteria are
registered **advisory**: their ``critical`` is shown on the readiness dashboard and never
blocks. The only checks this lane registers as **hard** are failed critical security or
policy requirements (``security_policy``) and unsupported third-party operation
(``third_party_support``). Approvals and blockers are the review and blockers lanes'
hard checks. There is no numeric publish score.

Every criterion is deterministic and explains itself: a rationale naming what it found,
the evidence (entity, evidence, gap, conflict, option or dependency ids), an owner and the
sections concerned. It reuses the baseline's goal traceability (``baseline.trace``), its
confidence rules (``confidence.low``) and the goal-weighted priority ranking.
"""

import uuid
from collections.abc import Awaitable, Callable
from dataclasses import dataclass

from oracle import readiness
from oracle.quality import text
from oracle.quality.inputs import QualityInputs, for_context
from oracle.quality.schemas import CriterionInfo, PolicyRequirement, ThirdPartyOperation
from oracle.readiness import CheckOutcome, ReadinessContext

Rule = Callable[[QualityInputs], CheckOutcome]


@dataclass(frozen=True)
class Criterion:
    key: str
    title: str
    question: str
    reads: tuple[str, ...]
    rule: Rule
    hard: bool = False

    def info(self) -> CriterionInfo:
        return CriterionInfo(
            key=self.key, title=self.title, question=self.question, hard=self.hard,
            reads=list(self.reads),
        )  # fmt: skip


def _outcome(
    status: str,
    reasons: list[str],
    *,
    evidence: list[uuid.UUID] | None = None,
    owner: uuid.UUID | None = None,
    sections: list[str] | None = None,
) -> CheckOutcome:
    return CheckOutcome(
        status=status,
        rationale=" ".join(r.rstrip(".") + "." for r in reasons if r),
        evidence_ids=list(dict.fromkeys(evidence or [])),
        owner_id=owner,
        section_keys=list(dict.fromkeys(sections or [])),
    )


def _worst(*statuses: str) -> str:
    order = ("critical", "warning", "pass", "not_applicable")
    return min(statuses, key=order.index) if statuses else "pass"


def _keys(sections: list[text.SectionText]) -> list[str]:
    return [s.key for s in sections]


def _uuid(value) -> uuid.UUID | None:
    try:
        return uuid.UUID(str(value)) if value else None
    except ValueError:
        return None


def _gap_owner(gaps: list) -> uuid.UUID | None:
    return next((g.owner_id for g in gaps if g.owner_id), None)


def _missing(q: QualityInputs) -> CheckOutcome | None:
    if q.document is None or q.version is None:
        return _outcome("not_applicable", ["The document or version was not found"])
    return None


# --- 1. problem and user clarity --------------------------------------------------------


def problem_clarity(q: QualityInputs) -> CheckOutcome:
    problem = text.with_role(q.sections, "problem")
    users = text.with_role(q.sections, "users")
    words = sum(s.words for s in problem)
    gaps = q.open_gaps("customer_user", "pain_evidence")
    critical_gaps = [g for g in gaps if g.importance == "critical"]
    problem_keys = set(_keys(problem))
    evidenced = [
        link for link in q.links if link.section_key in problem_keys and link.entity_id is not None
    ]
    evidence = [
        ev.id for ev in q.evidence if ev.entity_id in {link.entity_id for link in evidenced}
    ]
    cited = any(s.citation_keys for s in problem)
    pain_answered = q.closed_gaps("pain_evidence")
    names_users = bool(users) or any(text.USERS_IN_TEXT.search(s.body) for s in problem)
    status, reasons = "pass", []
    if not problem or words < 15:
        status = "critical"
        reasons.append(
            "No problem statement"
            if not problem
            else f"The problem is {words} words: too short to say who hurts and why"
        )
    if critical_gaps:
        status = "critical"
        reasons.append(
            f"{len(critical_gaps)} critical open question(s) about users or pain: "
            + "; ".join(text.quote(g.statement, 60) for g in critical_gaps)
        )
    if not names_users:
        status = _worst(status, "warning")
        reasons.append("No section or sentence names the users")
    if problem and not (evidence or cited or pain_answered):
        status = _worst(status, "warning")
        reasons.append(
            "The pain has no evidence: no linked evidence, citation or answered question"
        )
    if status == "pass":
        reasons.append(
            f"The problem ({words} words) names its users and its pain is backed by "
            f"{len(evidence) or 'cited'} evidence"
        )
    return _outcome(
        status,
        reasons,
        evidence=[*evidence, *(g.id for g in gaps)],
        owner=_gap_owner(gaps) or q.author_id,
        sections=_keys(problem) + _keys(users),
    )


# --- 2. business goal alignment and strategic value -------------------------------------


def goal_alignment(q: QualityInputs) -> CheckOutcome:
    features = q.of_type("feature")
    goals = q.of_type("goal")
    goal_sections = text.with_role(q.sections, "goals")
    gaps = q.open_gaps("goal_alignment", importance=("critical",))
    status, reasons, evidence = "pass", [], [g.id for g in gaps]
    owner = q.author_id
    if features and q.trace is not None:
        by_id = {f.id: f for f in q.trace.features}
        orphan, weak = [], []
        for f in features:
            row = by_id.get(f.id)
            if row is None:
                continue
            evidence.append(f.id)
            evidence += [g.goal_id for g in row.goals]
            rank = q.ranking.get(f.key)
            where = (
                f"ranked {rank['rank']} of {q.ranked} by goal-weighted priority"
                + (f" (score {rank['score']})" if rank and rank.get("score") is not None else "")
                if rank
                else "not ranked"
            )
            if "serves_no_goal" in row.flags:
                orphan.append(f"{f.key} serves no confirmed goal and sinks: {where}")
            elif any(link.contribution < 1 for link in row.goals):
                weak.append(f"{f.key} has a goal link with no stated contribution ({where})")
        if orphan:
            status = "critical"
            reasons += orphan
        if weak:
            status = _worst(status, "warning")
            reasons += weak
        if status == "pass":
            served = sorted({g.key for f in features for g in by_id[f.id].goals} if by_id else [])
            reasons.append(
                f"Every linked feature ({len(features)}) serves a confirmed goal "
                f"({', '.join(served)})"
            )
    elif goals:
        confirmed = [g for g in goals if g.status == "confirmed"]
        evidence += [g.id for g in goals]
        if confirmed:
            reasons.append(
                f"The PRD is traced to confirmed goal(s): {', '.join(g.key for g in confirmed)}"
            )
        else:
            status = "warning"
            reasons.append("The PRD's goals are proposed, not confirmed")
    else:
        if not q.confirmed_goals:
            status = "critical"
            reasons.append("The company baseline has no confirmed goal to trace this PRD to")
        elif not goal_sections:
            status = "critical"
            reasons.append("No goals section and no link to a company goal")
        else:
            status = "warning"
            reasons.append(
                "The goals section names goals in words but is not linked to the baseline's "
                "confirmed goals"
            )
    if gaps:
        status = "critical"
        reasons.append(f"{len(gaps)} critical open question(s) about goal alignment")
        owner = _gap_owner(gaps) or owner
    return _outcome(status, reasons, evidence=evidence, owner=owner, sections=_keys(goal_sections))


# --- 3. source evidence, provenance, stale and conflicting claims -----------------------


def evidence_provenance(q: QualityInputs) -> CheckOutcome:
    citations = sum(len(s.citation_keys) for s in q.sections)
    evidence = q.evidence
    status, reasons, ids = "pass", [], []
    open_conflicts = [c for c in q.conflicts if c.status == "open"]
    material = [c for c in open_conflicts if c.material]
    if material:
        status = "critical"
        names = {e.id: e.key for e in q.entities.values()}
        reasons.append(
            "Open material conflict(s) between sources: "
            + "; ".join(f"{names.get(c.entity_id, 'an item')} {c.field}" for c in material)
        )
        ids += [c.id for c in material]
    other = [c for c in open_conflicts if not c.material]
    if other:
        status = _worst(status, "warning")
        reasons.append(f"{len(other)} immaterial conflict(s) still open")
        ids += [c.id for c in other]
    if not evidence and not citations:
        status = "critical"
        reasons.append("No source evidence: nothing in the baseline or the citations backs the PRD")
    scored = [ev for ev in evidence if ev.confidence is not None]
    low = [ev for ev in scored if float(ev.confidence) < q.low]
    if scored and len(low) == len(scored):
        status = _worst(status, "warning")
        reasons.append(f"All {len(low)} piece(s) of evidence are low confidence (below {q.low})")
        ids += [ev.id for ev in low]
    elif low:
        reasons.append(f"{len(low)} of {len(scored)} piece(s) of evidence are low confidence")
    stale = [ev for ev in evidence if _stale(ev, q)]
    if stale:
        status = _worst(status, "warning")
        reasons.append(f"{len(stale)} piece(s) of evidence are stale")
        ids += [ev.id for ev in stale]
    uncertain = [
        g
        for g in q.open_gaps(importance=("critical", "high"))
        if g.knowledge_state in ("hypothesis", "ai_inference")
    ]
    if uncertain:
        status = _worst(status, "warning")
        reasons.append(
            f"{len(uncertain)} important claim(s) are still a hypothesis or an AI inference: "
            + "; ".join(text.quote(g.statement, 60) for g in uncertain)
        )
        ids += [g.id for g in uncertain]
    claims = [link for link in q.links if link.precision == "claim" and link.entity_id]
    unbacked = [
        link
        for link in claims
        if not any(
            ev.entity_id == link.entity_id and ev.id not in {x.id for x in low} for ev in evidence
        )
    ]
    if unbacked:
        status = _worst(status, "warning")
        reasons.append(f"{len(unbacked)} claim(s) have no evidence above low confidence")
    if status == "pass":
        reasons.append(
            f"{len(evidence)} piece(s) of evidence and {citations} citation(s), "
            "fresh, above low confidence and without open conflicts"
        )
    return _outcome(status, reasons, evidence=ids or [ev.id for ev in evidence], owner=q.author_id)


def _stale(ev, q: QualityInputs) -> bool:
    freshness = (ev.confidence_factors or {}).get("freshness")
    if isinstance(freshness, int | float) and not isinstance(freshness, bool):
        return freshness < 0.3
    if ev.retrieved_at is not None:
        return (q.now - ev.retrieved_at).days > 365
    return False


# --- 4. alternatives explored and trade-offs --------------------------------------------


def alternatives_tradeoffs(q: QualityInputs) -> CheckOutcome:
    sections = text.with_role(q.sections, "alternatives")
    options = [o for b in q.blockers for o in b.options]
    with_choices = [b for b in q.blockers if len(b.options) >= 2]
    items = text.items_of(sections)
    tradeoff = any("trade" in s.body.lower() or "rejected" in s.body.lower() for s in sections)
    gaps = q.open_gaps("alternatives", "differentiation", importance=("critical",))
    status, reasons = "pass", []
    if gaps:
        status = "critical"
        reasons.append(f"{len(gaps)} critical open question(s) about alternatives")
    if len(items) >= 2 and tradeoff:
        reasons.append(f"{len(items)} alternatives are compared with their trade-offs")
    elif with_choices:
        reasons.append(
            f"{len(with_choices)} blocker(s) weigh two or more options ({len(options)} in all)"
        )
    elif sections:
        status = _worst(status, "warning")
        reasons.append(
            "The alternatives section lists fewer than two options or states no trade-off"
        )
    else:
        status = _worst(status, "warning")
        reasons.append("No alternatives considered: no section and no blocker with two options")
    return _outcome(
        status,
        reasons,
        evidence=[o.id for o in options] + [g.id for g in gaps],
        owner=_gap_owner(gaps) or q.author_id,
        sections=_keys(sections),
    )


# --- 5. blocker and feasibility resolution ----------------------------------------------

RESOLVED = ("resolved", "feasibility_only")
# Third-party limits that are about what is permitted, not how much (§16 item 8).
PERMISSION_KINDS = ("eligibility", "permission", "policy")


def blocker_feasibility(q: QualityInputs) -> CheckOutcome:
    risks = text.with_role(q.sections, "risks")
    gaps = q.open_gaps("blockers", "constraints", importance=("critical",))
    status, reasons, ids, owner = "pass", [], [], None
    accepted = {d.entity_id for d in q.decisions if d.decision == "accept_risk"}
    for b in q.blockers:
        a, key = b.attrs, b.entity.key
        ids.append(b.entity.id)
        owner = owner or a.owner_id
        if a.status in RESOLVED:
            continue
        if a.status == "accepted_risk":
            if a.limit_kind in PERMISSION_KINDS:
                status = "critical"
                reasons.append(
                    f"{key}: a {a.limit_kind} limit cannot be accepted as a risk; the plan must "
                    "stay within the provider's rules"
                )
            elif b.entity.id not in accepted:
                status = _worst(status, "warning")
                reasons.append(f"{key}: accepted as a risk without a recorded decision")
            continue
        workable = [o for o in b.options if o.compliance == "compliant" and o.status != "rejected"]
        live = [x for x in b.experiments if x.status in ("planned", "running", "succeeded")]
        selected = [o for o in workable if o.status == "selected"]
        ids += [o.id for o in b.options] + [x.id for x in b.experiments]
        if not workable and not live:
            serious = a.severity == "critical" or a.type == "hard"
            status = _worst(status, "critical" if serious else "warning")
            reasons.append(
                f"{key} ({a.type}, {a.severity}, {a.limit_kind}) has no workable mitigation: "
                "no compliant option and no feasibility experiment"
            )
        elif not selected:
            status = _worst(status, "warning")
            reasons.append(f"{key} is {a.status}: options or experiments exist, none is selected")
    if gaps:
        status = "critical"
        reasons.append(f"{len(gaps)} critical open question(s) about blockers or constraints")
        ids += [g.id for g in gaps]
    if not q.blockers and not gaps:
        if risks:
            reasons.append("No blocker is recorded; the risks section states the constraints")
        else:
            status = "warning"
            reasons.append("No constraints, risks or blockers are recorded: say so explicitly")
    elif status == "pass":
        reasons.append(
            f"Every blocker ({len(q.blockers)}) is resolved or has a selected, compliant option"
        )
    if status == "critical":
        reasons.append(
            "Advisory here; a critical unresolved hard blocker is gated by the blockers check"
        )
    return _outcome(
        status,
        reasons,
        evidence=ids,
        owner=owner or _gap_owner(gaps) or q.author_id,
        sections=_keys(risks) + [k for b in q.blockers for k in b.section_keys],
    )


# --- 6. scope, non-goals and testable requirements --------------------------------------


def scope_testability(q: QualityInputs) -> CheckOutcome:
    scope = text.with_role(q.sections, "scope")
    non_goals = text.with_role(q.sections, "non_goals")
    acceptance = text.with_role(q.sections, "acceptance")
    criteria_entities = q.of_type("acceptance_criterion")
    requirements = q.of_type("requirement")
    verified = {e.dst_id for e in q.edges if e.type == "verifies"}
    items = text.items_of(acceptance) + [e.title for e in criteria_entities]
    vague = [(item, why) for item in items if (why := text.untestable(item))]
    status, reasons = "pass", []
    if not scope:
        status = "critical"
        reasons.append("No scope or requirements section")
    if not items:
        status = "critical"
        reasons.append("No acceptance criteria: nothing says how to test the requirements")
    elif vague:
        share = len(vague) / len(items)
        status = _worst(status, "critical" if share >= 0.5 else "warning")
        reasons.append(
            f"{len(vague)} of {len(items)} acceptance criteria are untestable: "
            + "; ".join(f'"{text.quote(i, 60)}" ({why})' for i, why in vague[:4])
        )
    unverified = [r for r in requirements if r.id not in verified]
    if unverified:
        status = _worst(status, "warning")
        reasons.append(
            "Requirement(s) with no acceptance criterion verifying them: "
            + ", ".join(r.key for r in unverified)
        )
    if not non_goals and not q.closed_gaps("non_goals"):
        status = _worst(status, "warning")
        reasons.append("No non-goals: say what this release will not do")
    if status == "pass":
        reasons.append(
            f"Scope, non-goals and {len(items)} testable acceptance criteria; every linked "
            "requirement is verified"
        )
    return _outcome(
        status,
        reasons,
        evidence=[r.id for r in requirements] + [e.id for e in criteria_entities],
        owner=q.author_id,
        sections=_keys(scope) + _keys(non_goals) + _keys(acceptance),
    )


# --- 7. economic and scaling assumptions ------------------------------------------------

ECONOMIC_GAPS = ("economic_benefit", "effort_cost", "configurability_scaling")
ECONOMIC_MODULE = ("econom", "cost", "pricing", "monetiz", "scal", "capacity")


def economics_scaling(q: QualityInputs) -> CheckOutcome:
    sections = text.with_role(q.sections, "economics") + [
        s for s in text.with_role(q.sections, "scaling") if "economics" not in s.roles
    ]
    modules = [k for k in q.module_keys if any(w in k.lower() for w in ECONOMIC_MODULE)]
    gaps = q.open_gaps(*ECONOMIC_GAPS)
    leaks = text.leakage(q.sections)
    if not (sections or modules or gaps or leaks):
        return _outcome(
            "not_applicable",
            ["No economic or scaling module, section or open question applies to this PRD"],
        )
    status, reasons = "pass", []
    critical = [g for g in gaps if g.importance == "critical"]
    if critical:
        status = "critical"
        reasons.append(
            f"{len(critical)} critical open question(s) about economics or scaling: "
            + "; ".join(text.quote(g.statement, 60) for g in critical)
        )
    elif gaps:
        status = "warning"
        reasons.append(f"{len(gaps)} open question(s) about economics or scaling")
    if leaks:
        status = _worst(status, "warning")
        reasons.append(
            "Tenant-specific behaviour is written into requirements instead of configuration: "
            + "; ".join(f"#{key}: {words}" for key, words in leaks[:4])
        )
    if not sections:
        status = _worst(status, "warning")
        reasons.append(
            "No economics or scaling section"
            + (f" although the composition includes {', '.join(modules)}" if modules else "")
        )
    elif not any(s.has_number for s in sections):
        status = _worst(status, "warning")
        reasons.append("The economic and scaling assumptions are not quantified")
    if status == "pass":
        reasons.append("Costs and scaling assumptions are stated with numbers")
    return _outcome(
        status,
        reasons,
        evidence=[g.id for g in gaps],
        owner=_gap_owner(gaps) or q.author_id,
        sections=_keys(sections) + [key for key, _ in leaks],
    )


# --- 8. validation plan, success metrics and decision thresholds ------------------------


def validation_plan(q: QualityInputs) -> CheckOutcome:
    metrics = text.with_role(q.sections, "metrics")
    plan = text.with_role(q.sections, "validation")
    gaps = q.open_gaps("success_metric", "evaluation_criteria", importance=("critical",))
    experiments = q.experiments
    status, reasons = "pass", []
    if not metrics:
        status = "critical"
        reasons.append("No success metrics")
    else:
        if not any(s.has_number for s in metrics):
            status = _worst(status, "warning")
            reasons.append("The success metrics have no baseline or target number")
        if not any(text.THRESHOLD.search(s.body) for s in metrics + plan):
            status = _worst(status, "warning")
            reasons.append("No decision threshold: what result would change the plan?")
    if not plan and not experiments:
        status = _worst(status, "warning")
        reasons.append("No validation plan or feasibility experiment")
    if gaps:
        status = "critical"
        reasons.append(f"{len(gaps)} critical open question(s) about success metrics")
    if status == "pass":
        reasons.append("Measurable metrics with a decision threshold and a validation plan")
    return _outcome(
        status,
        reasons,
        evidence=[x.id for x in experiments] + [g.id for g in gaps],
        owner=_gap_owner(gaps)
        or next((x.owner_id for x in experiments if x.owner_id), None)
        or q.author_id,
        sections=_keys(metrics) + _keys(plan),
    )


# --- 9. ownership, review and operational readiness -------------------------------------

OWNER_KEYS = ("owner", "owners", "approver", "approvers", "decider", "dri")


def ownership_readiness(q: QualityInputs) -> CheckOutcome:
    named = [k for k in OWNER_KEYS if q.front_matter.get(k)]
    in_text = any(text.OWNER_LINE.search(s.body) for s in q.sections)
    owned = [e for e in q.edges if e.type == "owned_by"]
    ops = text.with_role(q.sections, "operations")
    gaps = q.open_gaps("ownership", "release_rollout", importance=("critical",))
    status, reasons = "pass", []
    if not (named or in_text or owned or q.closed_gaps("ownership")):
        status = "critical"
        reasons.append(
            "Nobody owns this PRD: no owner in the front matter, the text or the baseline"
        )
    if not ops:
        status = _worst(status, "warning")
        reasons.append("No rollout, operations or support plan")
    if not (q.reviews or q.comments):
        status = _worst(status, "warning")
        reasons.append("No review yet: no comment or section verdict on this version")
    if gaps:
        status = "critical"
        reasons.append(f"{len(gaps)} critical open question(s) about ownership or rollout")
    if status == "pass":
        who = ", ".join(named) or ("owned_by links" if owned else "an owner line")
        reasons.append(
            f"Owned ({who}), with a rollout and operations plan and review under way "
            f"({q.comments} comment(s), {q.reviews} verdict(s))"
        )
    reasons.append("Approvals are gated by the review and publish checks, not here")
    owner = _uuid(q.front_matter.get("owner_id")) or _gap_owner(gaps) or q.author_id
    return _outcome(
        status,
        reasons,
        evidence=[e.dst_id for e in owned] + [g.id for g in gaps],
        owner=owner,
        sections=_keys(ops),
    )


# --- 10. downstream design and engineering consistency ----------------------------------


def downstream_consistency(q: QualityInputs) -> CheckOutcome:
    if not q.dependencies and not q.derived_versions:
        return _outcome(
            "not_applicable", ["No downstream design, engineering or roadmap artifact yet"]
        )
    status, reasons = "pass", []
    drifting = [
        (d, t) for d, t in q.dependencies if d.freshness in ("potentially_stale", "under_review")
    ]
    for dep, title in drifting:
        status = "warning"
        where = f"#{dep.upstream_section_key}" if dep.upstream_section_key else "the whole PRD"
        state = dep.freshness.replace("_", " ")
        reasons.append(f"{title or 'An artifact'} is {state} since {where} changed")
    for slug, number, source in q.derived_versions:
        status = "warning"
        reasons.append(f"{slug} v{number} was built from v{source}, not v{q.version.number}")
    if status == "pass":
        reasons.append(f"{len(q.dependencies)} downstream dependency(ies), all fresh or reconciled")
    return _outcome(
        status,
        reasons,
        evidence=[d.id for d, _ in drifting] or [d.id for d, _ in q.dependencies],
        owner=q.author_id,
        sections=[d.upstream_section_key for d, _ in drifting if d.upstream_section_key],
    )


# --- hard: failed critical security or policy requirements ------------------------------


def security_policy(q: QualityInputs) -> CheckOutcome:
    rules: list[tuple] = []
    for e in q.of_type("requirement", "constraint", "risk"):
        raw = (e.attrs or {}).get("policy")
        if not isinstance(raw, dict):
            continue
        try:
            rules.append((e, PolicyRequirement.model_validate(raw)))
        except ValueError:
            rules.append(
                (e, PolicyRequirement(area="security", critical=True, status="unverified"))
            )
    gaps = q.open_gaps("security_privacy", importance=("critical",))
    if not rules and not gaps:
        return _outcome(
            "not_applicable", ["No security, privacy or policy requirement is linked to this PRD"]
        )
    failed = [(e, p) for e, p in rules if p.critical and p.status == "failed"]
    unverified = [(e, p) for e, p in rules if p.critical and p.status == "unverified"]
    status, reasons = "pass", []
    if failed:
        status = "critical"
        reasons.append(
            "Critical requirement(s) failed: "
            + "; ".join(
                f"{e.key} ({p.area}) failed" + (f": {text.quote(p.note, 60)}" if p.note else "")
                for e, p in failed
            )
        )
    if unverified:
        status = _worst(status, "warning")
        reasons.append(
            "Critical requirement(s) not verified yet: " + ", ".join(e.key for e, _ in unverified)
        )
    if gaps:
        status = _worst(status, "warning")
        reasons.append(f"{len(gaps)} critical open question(s) about security or privacy")
    if status == "pass":
        reasons.append(f"{len(rules)} security or policy requirement(s), none failed")
    entities = failed or unverified or rules
    return _outcome(
        status,
        reasons,
        evidence=[e.id for e, _ in entities] + [g.id for g in gaps],
        owner=q.author_id,
        sections=[k for e, _ in entities for k in q.sections_of.get(e.id, [])],
    )


# --- hard: unsupported third-party operation --------------------------------------------


def third_party_support(q: QualityInputs) -> CheckOutcome:
    blockers = {b.entity.id: b for b in q.blockers}
    ops: list[tuple] = []
    for e in q.entities.values():
        raw = (e.attrs or {}).get("third_party")
        if not isinstance(raw, dict):
            continue
        try:
            ops.append((e, ThirdPartyOperation.model_validate(raw)))
        except ValueError:
            continue
    # A policy, eligibility or permission blocker with no third_party attrs still counts.
    for b in q.blockers:
        if b.attrs.limit_kind in PERMISSION_KINDS and "third_party" not in (b.entity.attrs or {}):
            ops.append(
                (b.entity, ThirdPartyOperation(
                    provider="a third party", operation=b.entity.title,
                    limit_kind=b.attrs.limit_kind, supported=None,
                ))
            )  # fmt: skip
    if not ops:
        return _outcome("not_applicable", ["The PRD relies on no third-party operation"])
    reasons: list[str] = []
    # (status, entity and option ids, sections) per operation; the worst ones explain it.
    judged: list[tuple[str, list[uuid.UUID], list[str]]] = []
    groups: dict[str, int] = {}
    for e, op in ops:
        groups[op.limit_kind] = groups.get(op.limit_kind, 0) + 1
        blocker = blockers.get(e.id)
        label = f"{op.provider}: {op.operation} ({op.limit_kind.replace('_', ' ')})"
        selected = [
            o for o in (blocker.options if blocker else [])
            if o.status == "selected" and o.compliance == "compliant"
        ]  # fmt: skip
        ids = [e.id]
        if op.limit_kind == "rate_capacity":
            status = "pass"
            reasons.append(f"{label} is a capacity limit, planned for, not a permission")
        elif op.supported is False and blocker and blocker.attrs.status == "accepted_risk":
            status = "critical"
            reasons.append(
                f"{label} is not permitted; a platform policy limit cannot be accepted as a "
                "risk, the plan must stop relying on it"
            )
        elif op.supported is False and blocker and (blocker.attrs.status in RESOLVED or selected):
            status = "pass"
            ids += [o.id for o in selected]
            reasons.append(
                f"{label} is not permitted, and the plan no longer relies on it"
                + (f": {selected[0].title}" if selected else "")
            )
        elif op.supported is False:
            status = "critical"
            reasons.append(
                f"The PRD relies on {label}, which the provider does not support or permit"
            )
        elif op.supported is None:
            status = "warning"
            reasons.append(f"{label}: support is not verified with the provider yet")
        else:
            status = "pass"
            reasons.append(f"{label} is supported")
        judged.append((status, ids, q.sections_of.get(e.id, [])))
    status = _worst(*(j[0] for j in judged))
    worst = [j for j in judged if j[0] == status]
    summary = ", ".join(f"{n} {k.replace('_', ' ')}" for k, n in sorted(groups.items()))
    reasons.insert(0, f"Third-party limits by kind: {summary}")
    return _outcome(
        status,
        reasons,
        evidence=[i for j in worst for i in j[1]],
        owner=q.author_id,
        sections=[k for j in worst for k in j[2]],
    )


# --- the catalogue and registration -----------------------------------------------------

CRITERIA: tuple[Criterion, ...] = (
    Criterion(
        "problem_clarity",
        "Problem and user clarity",
        "Does the PRD say who has the problem, what it is, and what evidence shows the pain?",
        ("problem and users sections", "evidence linked to them", "user and pain questions"),
        problem_clarity,
    ),
    Criterion(
        "goal_alignment",
        "Business goal alignment and strategic value",
        "Does every feature serve a confirmed company goal, and how does it rank?",
        ("baseline goal traceability", "goal-weighted priority ranking", "goal questions"),
        goal_alignment,
    ),
    Criterion(
        "evidence_provenance",
        "Source evidence and provenance",
        "Is the PRD backed by fresh, confident evidence without open conflicts?",
        ("evidence confidence and freshness", "open conflicts", "claim links", "citations"),
        evidence_provenance,
    ),
    Criterion(
        "alternatives_tradeoffs",
        "Alternatives explored and trade-offs",
        "Were at least two approaches compared, with the trade-off stated?",
        ("alternatives sections", "blocker options"),
        alternatives_tradeoffs,
    ),
    Criterion(
        "blocker_feasibility",
        "Blocker and feasibility resolution",
        "Does every blocker have a workable, compliant mitigation or an experiment?",
        ("blockers on constraint entities", "options", "experiments", "risk decisions"),
        blocker_feasibility,
    ),
    Criterion(
        "scope_testability",
        "Scope, non-goals and testable requirements",
        "Are scope and non-goals explicit, and can each acceptance criterion be tested?",
        ("scope, non-goals and acceptance sections", "requirements and their verifies links"),
        scope_testability,
    ),
    Criterion(
        "economics_scaling",
        "Economic and scaling assumptions",
        "Are costs, benefits and scaling assumptions stated and quantified, and kept as "
        "configuration rather than one tenant's special case?",
        ("economics and scaling sections", "composition modules", "economics questions"),
        economics_scaling,
    ),
    Criterion(
        "validation_plan",
        "Validation plan, success metrics and decision thresholds",
        "Are there measurable metrics, a decision threshold and a plan to validate?",
        ("metrics and validation sections", "feasibility experiments", "metric questions"),
        validation_plan,
    ),
    Criterion(
        "ownership_readiness",
        "Ownership, review and operational readiness",
        "Is there an owner, a rollout and operations plan, and review under way?",
        ("front matter owners", "owned_by links", "operations sections", "comments and verdicts"),
        ownership_readiness,
    ),
    Criterion(
        "downstream_consistency",
        "Downstream design and engineering consistency",
        "Are specs, designs and roadmaps built from this PRD still consistent with it?",
        ("artifact dependencies and their freshness", "roadmap provenance"),
        downstream_consistency,
    ),
)
HARD: tuple[Criterion, ...] = (
    Criterion(
        "security_policy", "Critical security and policy requirements",
        "Has any critical security, privacy or policy requirement failed?",
        ("attrs.policy on linked requirements, constraints and risks", "security questions"),
        security_policy, hard=True,
    ),
    Criterion(
        "third_party_support", "Supported third-party operations",
        "Does the PRD rely on a third-party operation the provider does not support or permit?",
        ("attrs.third_party on linked entities", "policy, eligibility and permission blockers"),
        third_party_support, hard=True,
    ),
)  # fmt: skip

KEYS: tuple[str, ...] = tuple(c.key for c in CRITERIA)
HARD_KEYS: tuple[str, ...] = tuple(c.key for c in HARD)
ALL_KEYS: tuple[str, ...] = KEYS + HARD_KEYS
BY_KEY: dict[str, Criterion] = {c.key: c for c in (*CRITERIA, *HARD)}


def catalogue() -> list[CriterionInfo]:
    return [c.info() for c in (*CRITERIA, *HARD)]


def _check(criterion: Criterion) -> Callable[[ReadinessContext], Awaitable[CheckOutcome]]:
    async def check(ctx: ReadinessContext) -> CheckOutcome:
        q = await for_context(ctx)
        return _missing(q) or criterion.rule(q)

    check.__name__ = criterion.key
    return check


def register() -> None:
    """Register the ten criteria (advisory, T2) and the two hard checks. Idempotent."""
    for criterion in (*CRITERIA, *HARD):
        readiness.register_check(criterion.key, _check(criterion), hard=criterion.hard)
