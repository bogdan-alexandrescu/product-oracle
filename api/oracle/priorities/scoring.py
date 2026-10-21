"""Feature scoring and dependency order. Pure functions over plain inputs, no database.

Methods (O3):

- ``goal_weighted`` (default): sum over confirmed goals of goal weight x the
  ``supports`` contribution (0-3), times confidence, divided by effort.
- ``rice``: reach x impact x confidence / effort.
- ``moscow``: must > should > could > won't; ties broken by goal value.
- ``wsjf``: (business value + time criticality + risk reduction) / job size.

Confidence is the feature's evidence confidence from the baseline (the mean of its
scored evidence), falling back to the feature's stored confidence, then its attrs.

Order: features that serve a confirmed goal and could be scored first, by score;
then those missing an input; then features that serve no confirmed goal (flagged).
Dependencies override that: a feature never comes before something it depends on,
and a prerequisite moves up to just before its highest-ranked dependent. Cycles are
reported and their members flagged, never silently broken.
"""

import heapq
from dataclasses import dataclass, field
from typing import Any

METHODS = ("goal_weighted", "rice", "moscow", "wsjf")
FORMULAS = {
    "goal_weighted": "score = Σ(goal weight × contribution) × confidence ÷ effort",
    "rice": "score = reach × impact × confidence ÷ effort",
    "moscow": "rank = must (4) > should (3) > could (2) > won't (1); ties by goal value",
    "wsjf": "score = (business value + time criticality + risk reduction) ÷ job size",
}
# T-shirt sizes accepted for effort / job size, in person-weeks.
SIZES = {"xs": 0.5, "s": 1, "m": 2, "l": 4, "xl": 8}
CONFIDENCE_WORDS = {"high": 0.8, "medium": 0.5, "low": 0.3}
MOSCOW = {"must": 4, "should": 3, "could": 2, "wont": 1, "won't": 1}
DEFAULT_CONFIDENCE = 0.5
DEFAULT_WEIGHT = 1.0
DEFAULT_CONTRIBUTION = 1
LOW_CONFIDENCE = 0.4


@dataclass
class GoalLink:
    goal_key: str
    goal_title: str
    weight: float | None
    contribution: int | None
    edge_status: str


@dataclass
class EvidenceRef:
    id: str
    confidence: float | None
    ref: str | None
    # From a source item since removed (S5): shown as 'source removed'.
    source_removed: bool = False


@dataclass
class FeatureInput:
    id: str
    key: str
    title: str
    status: str
    attrs: dict[str, Any]
    # Entity.confidence (aggregate stored by the baseline), if any.
    stored_confidence: float | None = None
    evidence: list[EvidenceRef] = field(default_factory=list)
    goals: list[GoalLink] = field(default_factory=list)
    # Keys of features this one depends on (depends_on, or the src of a blocks edge).
    depends_on: list[str] = field(default_factory=list)


@dataclass
class Scored:
    feature: FeatureInput
    score: float | None
    group: int  # 0 scored + serves a goal, 1 unscored + serves a goal, 2 serves no goal
    explanation: dict[str, Any]
    flags: list[str]
    sort_value: tuple = ()


def _number(value: Any) -> float | None:
    if isinstance(value, bool) or value is None:
        return None
    if isinstance(value, int | float):
        return float(value)
    if isinstance(value, str):
        text = value.strip().lower()
        if text in SIZES:
            return float(SIZES[text])
        try:
            return float(text.rstrip("%")) / (100 if text.endswith("%") else 1)
        except ValueError:
            return None
    return None


def _round(x: float | None, n: int = 3) -> float | None:
    return None if x is None else round(x, n)


def confidence_of(f: FeatureInput) -> tuple[float, dict[str, Any]]:
    """The confidence used for scoring, and where it came from."""
    scored = [e for e in f.evidence if e.confidence is not None]
    if scored:
        value = sum(e.confidence for e in scored) / len(scored)  # type: ignore[misc]
        return value, {
            "value": _round(value),
            "source": "evidence",
            "explain": f"mean confidence of {len(scored)} scored evidence item(s)",
            "evidence": [
                {
                    "id": e.id,
                    "confidence": _round(e.confidence),
                    "ref": e.ref,
                    "source_removed": e.source_removed,
                }
                for e in scored
            ],
        }
    if f.stored_confidence is not None:
        return f.stored_confidence, {
            "value": _round(f.stored_confidence),
            "source": "baseline",
            "explain": "the feature's stored confidence (no scored evidence)",
            "evidence": [],
        }
    raw = f.attrs.get("confidence")
    if isinstance(raw, str) and raw.strip().lower() in CONFIDENCE_WORDS:
        value = CONFIDENCE_WORDS[raw.strip().lower()]
        return value, {
            "value": value,
            "source": "attrs",
            "explain": f"attrs.confidence '{raw}' read as {value}",
            "evidence": [],
        }
    number = _number(raw)
    if number is not None:
        value = number / 100 if number > 1 else number
        value = min(max(value, 0.0), 1.0)
        return value, {
            "value": _round(value),
            "source": "attrs",
            "explain": f"attrs.confidence = {raw}",
            "evidence": [],
        }
    return DEFAULT_CONFIDENCE, {
        "value": DEFAULT_CONFIDENCE,
        "source": "default",
        "explain": f"no evidence and no attrs.confidence: assumed {DEFAULT_CONFIDENCE}",
        "evidence": [],
    }


def goal_value(f: FeatureInput) -> tuple[float, list[dict[str, Any]]]:
    terms = []
    total = 0.0
    for g in f.goals:
        weight = g.weight if g.weight is not None else DEFAULT_WEIGHT
        contribution = g.contribution if g.contribution is not None else DEFAULT_CONTRIBUTION
        term = weight * contribution
        total += term
        terms.append(
            {
                "goal": g.goal_key,
                "title": g.goal_title,
                "weight": weight,
                "weight_assumed": g.weight is None,
                "contribution": contribution,
                "contribution_assumed": g.contribution is None,
                "link_status": g.edge_status,
                "term": _round(term),
            }
        )
    return total, terms


def _input(f: FeatureInput, *names: str) -> tuple[float | None, str | None]:
    for name in names:
        if name in f.attrs:
            return _number(f.attrs[name]), name
    return None, None


def score_feature(f: FeatureInput, method: str) -> Scored:
    flags: list[str] = []
    serves_goal = bool(f.goals)
    if not serves_goal:
        flags.append("no_confirmed_goal")
    value, terms = goal_value(f)
    confidence, conf_explain = confidence_of(f)
    if conf_explain["source"] == "default":
        flags.append("no_confidence")
    elif confidence < LOW_CONFIDENCE:
        flags.append("low_confidence")
    inputs: dict[str, Any] = {}
    missing: list[str] = []
    steps: list[str] = []
    score: float | None = None

    def need(label: str, *names: str, positive: bool = False) -> float | None:
        v, used = _input(f, *names)
        inputs[label] = {"value": v, "attr": used or names[0], "raw": f.attrs.get(used or "")}
        if v is None or (positive and v <= 0):
            missing.append(label)
            return None
        return v

    if method == "goal_weighted":
        effort = need("effort", "effort", "effort_weeks", positive=True)
        inputs["goal_value"] = {"value": _round(value), "terms": terms}
        steps.append(
            "goal value = "
            + (" + ".join(f"{t['weight']}×{t['contribution']} ({t['goal']})" for t in terms) or "0")
            + f" = {_round(value)}"
        )
        if effort is not None:
            score = value * confidence / effort
            steps.append(
                f"score = {_round(value)} × {_round(confidence)} ÷ {effort:g} = {_round(score)}"
            )
    elif method == "rice":
        reach = need("reach", "reach")
        impact = need("impact", "impact")
        effort = need("effort", "effort", "effort_weeks", positive=True)
        if None not in (reach, impact, effort):
            score = reach * impact * confidence / effort  # type: ignore[operator]
            steps.append(
                f"score = {reach:g} × {impact:g} × {_round(confidence)} ÷ {effort:g} "
                f"= {_round(score)}"
            )
    elif method == "wsjf":
        bv = need("business_value", "business_value", "user_business_value")
        tc = need("time_criticality", "time_criticality")
        rr = need("risk_reduction", "risk_reduction", "opportunity_enablement")
        size = need("job_size", "job_size", "effort", positive=True)
        if None not in (bv, tc, rr, size):
            cod = bv + tc + rr  # type: ignore[operator]
            score = cod / size  # type: ignore[operator]
            steps.append(f"cost of delay = {bv:g} + {tc:g} + {rr:g} = {cod:g}")
            steps.append(f"score = {cod:g} ÷ {size:g} = {_round(score)}")
    elif method == "moscow":
        raw = f.attrs.get("moscow")
        category = raw.strip().lower().replace("’", "'") if isinstance(raw, str) else None
        rank = MOSCOW.get(category or "")
        inputs["moscow"] = {"value": category, "attr": "moscow", "raw": raw}
        inputs["goal_value"] = {"value": _round(value), "terms": terms}
        if rank is None:
            missing.append("moscow")
        else:
            score = float(rank)
            steps.append(f"{category} = {rank}; tie-break goal value {_round(value)}")
    else:  # pragma: no cover - validated by the router
        raise ValueError(f"unknown method {method}")

    if missing:
        flags.append("missing_inputs")
        steps.append("not scored: missing " + ", ".join(missing))
    group = 2 if not serves_goal else (0 if score is not None else 1)
    explanation = {
        "method": method,
        "formula": FORMULAS[method],
        "inputs": inputs,
        "confidence": conf_explain,
        "goals": terms,
        "missing": missing,
        "steps": steps,
    }
    tie = value if method == "moscow" else 0.0
    return Scored(
        feature=f,
        score=_round(score, 4),
        group=group,
        explanation=explanation,
        flags=flags,
        sort_value=(group, -(score if score is not None else 0.0), -tie, f.title.lower(), f.key),
    )


def _cycles(nodes: list[str], edges: dict[str, list[str]]) -> list[list[str]]:
    """Strongly connected components with more than one node (Tarjan, iterative)."""
    index: dict[str, int] = {}
    low: dict[str, int] = {}
    on_stack: set[str] = set()
    stack: list[str] = []
    out: list[list[str]] = []
    counter = 0
    for root in nodes:
        if root in index:
            continue
        work = [(root, iter(edges.get(root, [])))]
        index[root] = low[root] = counter
        counter += 1
        stack.append(root)
        on_stack.add(root)
        while work:
            node, it = work[-1]
            advanced = False
            for nxt in it:
                if nxt not in index:
                    index[nxt] = low[nxt] = counter
                    counter += 1
                    stack.append(nxt)
                    on_stack.add(nxt)
                    work.append((nxt, iter(edges.get(nxt, []))))
                    advanced = True
                    break
                if nxt in on_stack:
                    low[node] = min(low[node], index[nxt])
            if advanced:
                continue
            work.pop()
            if work:
                parent = work[-1][0]
                low[parent] = min(low[parent], low[node])
            if low[node] == index[node]:
                component = []
                while True:
                    w = stack.pop()
                    on_stack.discard(w)
                    component.append(w)
                    if w == node:
                        break
                if len(component) > 1:
                    out.append(sorted(component))
    return out


def rank(features: list[FeatureInput], method: str = "goal_weighted") -> dict[str, Any]:
    """Score every feature and order them: priority, then dependencies, cycles reported."""
    if method not in METHODS:
        raise ValueError(f"unknown method {method}")
    scored = {f.key: score_feature(f, method) for f in features}
    keys = [f.key for f in features]
    # deps[a] = what a depends on (only features in this ranking).
    deps = {
        k: [d for d in dict.fromkeys(scored[k].feature.depends_on) if d in scored and d != k]
        for k in keys
    }
    dependents: dict[str, list[str]] = {k: [] for k in keys}
    for k, ds in deps.items():
        for d in ds:
            dependents[d].append(k)

    by_score = sorted(keys, key=lambda k: scored[k].sort_value)
    score_rank = {k: i + 1 for i, k in enumerate(by_score)}

    cycles = _cycles(by_score, deps)
    component = {k: k for k in keys}
    for c in cycles:
        lead = min(c, key=lambda k: scored[k].sort_value)
        for k in c:
            component[k] = lead
            scored[k].flags.append("dependency_cycle")
    members: dict[str, list[str]] = {}
    for k in by_score:
        members.setdefault(component[k], []).append(k)

    # Condensed graph: component -> components it depends on.
    cdeps: dict[str, set[str]] = {c: set() for c in members}
    cdependents: dict[str, set[str]] = {c: set() for c in members}
    for k, ds in deps.items():
        for d in ds:
            a, b = component[k], component[d]
            if a != b:
                cdeps[a].add(b)
                cdependents[b].add(a)

    # Effective key: a prerequisite inherits the best key of anything that needs it.
    own = {c: min(scored[k].sort_value for k in ms) for c, ms in members.items()}
    effective = dict(own)
    order_by_key = sorted(members, key=lambda c: own[c])
    for c in order_by_key:  # best first: push its key down to its prerequisites
        todo = [c]
        while todo:
            x = todo.pop()
            for d in cdeps[x]:
                if effective[c] < effective[d]:
                    effective[d] = effective[c]
                    todo.append(d)

    # Kahn's algorithm on the condensed graph, best effective key first.
    remaining = {c: len(cdeps[c]) for c in members}
    heap = [(effective[c], own[c], c) for c in members if remaining[c] == 0]
    heapq.heapify(heap)
    ordered: list[str] = []
    while heap:
        _, _, c = heapq.heappop(heap)
        ordered.extend(members[c])
        for nxt in cdependents[c]:
            remaining[nxt] -= 1
            if remaining[nxt] == 0:
                heapq.heappush(heap, (effective[nxt], own[nxt], nxt))

    rows = []
    for position, k in enumerate(ordered, start=1):
        s = scored[k]
        f = s.feature
        moved = []
        if position < score_rank[k] and dependents[k]:
            needed_by = [d for d in dependents[k] if score_rank[d] < score_rank[k]]
            if needed_by:
                moved.append(
                    "placed earlier because " + ", ".join(sorted(needed_by)) + " depend(s) on it"
                )
                s.flags.append("moved_for_dependency")
        waiting = [d for d in deps[k] if score_rank[d] > score_rank[k]]
        if waiting:
            moved.append("placed after its prerequisite(s) " + ", ".join(sorted(waiting)))
        s.explanation["order"] = moved
        rows.append(
            {
                "rank": position,
                "score_rank": score_rank[k],
                "entity_id": f.id,
                "key": f.key,
                "title": f.title,
                "status": f.status,
                "score": s.score,
                "serves_goal": bool(f.goals),
                "flags": sorted(set(s.flags)),
                "depends_on": deps[k],
                "dependents": sorted(dependents[k]),
                "explanation": s.explanation,
            }
        )
    return {"method": method, "formula": FORMULAS[method], "features": rows, "cycles": cycles}
