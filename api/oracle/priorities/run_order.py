"""Priority order snapshot (C8): ``priority.yaml``, its check and the snapshot it becomes.

``priority.yaml`` (version 1) is what the ``priority`` segment hands its checkpoint:

    version: 1
    method: goal_weighted          # goal_weighted | rice | moscow | wsjf
    order:
      - key: address-lookup        # a feature included in the approved PRD scope (C6)
        rank: 1
        score: 4.2
        explanation: "Activation weight 3 x contribution 2 x confidence 0.7 / effort 1"
      - key: saved-addresses
        rank: 2
        score: 3.6
        explanation: "Needs address-lookup first; Activation weight 3 x contribution 2 x 0.6 / 1"

:func:`check_order` lists every problem at once. Blocking problems (Approve is refused
while any is open, call c3): ``unreadable_yaml``, ``wrong_version`` and ``unknown_method``
(the file), ``duplicate_key``, ``duplicate_rank`` and ``rank_gap`` (the ranks are not
1..N, each once), ``unknown_feature`` (not a non-rejected feature, nor one of the approved
scope), ``not_in_scope`` and ``missing_feature`` (an approved PRD scope exists and the
feature is not included in it, or is included and not ranked) and ``before_prerequisite``
(ranked above a feature it depends on: decision O3, ordered by dependencies) and
``new_feature_no_goal`` (a feature new in this PRD whose row and feature-set entry name no
known goal it serves: none joins the Ground Truth without its goal) and ``unknown_goal`` (a
new feature's row or entry names a goal the Ground Truth does not have, or rejected; a
contribution of 0 from either source means it does not serve). Advisory:
``differs_from_live`` (its place among the ranked live features differs by more than
``LIVE_SLACK`` from the live ranking of the same method, restricted to the same features)
and ``no_goal`` (the live ranking flags it ``no_confirmed_goal``).

The file is agent output, read the way ``roadmap_items.yaml`` is (oracle.runs.roadmap):
through the one safe loader (:func:`oracle.safe_yaml.load`), at most ``MAX_STORED_BYTES``
once parsed, and checked on the parse pool (:func:`check_order_async`), at most
``PARSE_SECONDS``.

When the segment ends Oracle stores the order as a **proposed** snapshot
(:func:`propose`), even with blocking problems; approving the checkpoint saves it for the
PRD (:func:`approve`), Request changes discards it (:func:`discard`), a re-run's proposal
discards the earlier one, and the stop turned off saves a clean order by Oracle. Readers
(the snapshot list and read routes, the roadmap's priority order) see saved snapshots
only. Moving and pinning rows is pick C9.
"""

import json
import uuid
from dataclasses import dataclass, field
from datetime import UTC, datetime
from typing import Any

from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession

from oracle import safe_yaml
from oracle.priorities.models import PRIORITY_METHODS, PrioritySnapshot

FILE = "priority.yaml"
# A parsed priority.yaml is at most this large as JSON (it is stored on the snapshot).
MAX_STORED_BYTES = 1_000_000
# The parse and check run on the parse pool, never in the event loop, at most this long.
PARSE_SECONDS = safe_yaml.PARSE_SECONDS
# The formula's inputs a run sets on a feature new in its PRD (not in the baseline yet), so
# the order stop scores it on the same formula as the rest (decision RP1, 'Scored with the
# rest'): the goal it serves, that goal's weight, its contribution, confidence and effort.
NEW_INPUTS = ("goal", "weight", "contribution", "confidence", "effort")
# A rank this far from the live one or nearer is not worth a flag.
LIVE_SLACK = 2
# The format, as the module docstring and the segment's task state it (oracle.runs.flows).
FORMAT = """\
version: 1
method: <goal_weighted | rice | moscow | wsjf>
order:                                 # every feature the approved PRD scope includes
  - key: <a feature key of the approved PRD scope>
    rank: <1..N, each once; a feature after every feature it depends on>
    score: <the score you computed>
    explanation: <every number of the score, and why it is ranked here>
    # A feature new in this PRD (not in the baseline yet) also gives the formula's inputs,
    # so it is scored on the same formula and ranked among the rest:
    goal: <the goal key it serves>
    weight: <that goal's weight>
    contribution: <1..3>
    confidence: <0..1, your estimate; it has no evidence yet>
    effort: <person-weeks>
"""


def blocking_message(n: int) -> str:
    """Why Approve is refused while ``n`` blocking problems are open (web, Inbox, MCP)."""
    return (
        f"The priority order has {n} blocking problem{'' if n == 1 else 's'}; send it back "
        "with Request changes"
    )


def blocking_of(check: dict[str, Any] | None) -> int:
    """Blocking problems in a stored check (``as_json``)."""
    if not isinstance(check, dict):
        return 0
    return sum(1 for p in check.get("problems") or [] if p.get("blocking", True))


@dataclass
class Known:
    """What the check reads (:func:`known_for_run`)."""

    # Non-rejected baseline features and the approved scope's included ones: key -> title.
    features: dict[str, str] = field(default_factory=dict)
    # The approved PRD scope's included feature keys, in scope order; None: no scope.
    scope: list[str] | None = None
    # Feature key -> the keys it depends on (the baseline's edges and the scope's).
    depends_on: dict[str, set[str]] = field(default_factory=dict)
    # Method -> the live ranking (RankedFeature as JSON), in rank order.
    live: dict[str, list[dict[str, Any]]] = field(default_factory=dict)
    # A scope feature not in the baseline (new in this PRD) -> the goals its feature-set
    # entry names: key and contribution (None: named by key alone).
    new_goals: dict[str, list[dict[str, Any]]] = field(default_factory=dict)
    # The Ground Truth's non-rejected goals: key -> title. Only these count as served.
    goals: dict[str, str] = field(default_factory=dict)
    # Every goal the Ground Truth has, rejected ones too: key -> title. A problem names a
    # goal by it, never by its key (:func:`goal_words`).
    goal_names: dict[str, str] = field(default_factory=dict)


@dataclass
class OrderCheck:
    method: str | None = None
    # The ranked features, in rank order: key, rank, score, explanation, live_rank.
    order: list[dict[str, Any]] = field(default_factory=list)
    problems: list[dict[str, Any]] = field(default_factory=list)

    def add(self, code: str, message: str, feature: str | None = None, *, blocking: bool = True):
        self.problems.append(
            {"code": code, "blocking": blocking, "feature": feature, "message": message}
        )

    @property
    def blocking(self) -> int:
        return sum(1 for p in self.problems if p["blocking"])

    def as_json(self) -> dict[str, Any]:
        return {
            "method": self.method,
            "features": len(self.order),
            "problems": self.problems,
            "order": self.order,
        }


class PriorityOrderError(ValueError):
    """priority.yaml was refused before it was checked: ``code`` names why."""

    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code


def load_order(text: str) -> Any:
    """Parse priority.yaml the one safe way, at most ``MAX_STORED_BYTES`` as JSON. Raises
    :class:`PriorityOrderError` and nothing else."""
    try:
        try:
            data = safe_yaml.load(text)
        except safe_yaml.SafeYamlError as exc:
            raise PriorityOrderError(exc.code, f"{FILE} is refused: {exc}") from exc
        size = len(json.dumps(data, default=str).encode())
        if size > MAX_STORED_BYTES:
            raise PriorityOrderError(
                "too_large", f"{FILE} is {size} bytes once parsed, over {MAX_STORED_BYTES}"
            )
        return data
    except PriorityOrderError:
        raise
    except Exception as exc:  # noqa: BLE001 - agent output: every failure is a refusal
        raise PriorityOrderError(
            "unreadable_yaml",
            f"{FILE} could not be read ({type(exc).__name__}: {str(exc)[:200]})",
        ) from exc


def _number(value: Any) -> float | None:
    if isinstance(value, bool) or not isinstance(value, int | float):
        return None
    return float(value)


def _text(value: Any) -> str | None:
    if isinstance(value, str) and value.strip():
        return value.strip()
    return None


def _rank(value: Any) -> int | None:
    return value if isinstance(value, int) and not isinstance(value, bool) and value > 0 else None


def live_ranks(keys: list[str], live: list[dict[str, Any]]) -> dict[str, int]:
    """The live rank of each of ``keys``: their places in the live ranking restricted to
    them (a feature the run leaves out shifts nothing)."""
    wanted = set(keys)
    ordered = [f["key"] for f in sorted(live, key=lambda f: f.get("rank") or 0)]
    return {key: n for n, key in enumerate((k for k in ordered if k in wanted), start=1)}


def check_order(text: str, *, known: Known) -> OrderCheck:
    """Every problem of ``text`` against what is known, in one pass (module docstring)."""
    out = OrderCheck()
    try:
        data = load_order(text)
    except PriorityOrderError as exc:
        out.add("unreadable_yaml", str(exc))
        return out
    if not isinstance(data, dict):
        out.add("unreadable_yaml", f"{FILE} is not a mapping with version, method and order")
        return out
    if data.get("version") != 1:
        out.add("wrong_version", f"{FILE} is version {data.get('version')!r}; version 1 is read")
    method = data.get("method")
    if method not in PRIORITY_METHODS:
        out.add(
            "unknown_method",
            f"method {method!r} is not one of {', '.join(PRIORITY_METHODS)}",
        )
    else:
        out.method = method
    raw = data.get("order")
    if not isinstance(raw, list) or not raw:
        out.add("unreadable_yaml", f"{FILE} lists no order: a list of key, rank, score")
        return out
    rows: list[dict[str, Any]] = []
    seen: dict[str, int] = {}
    for n, entry in enumerate(raw, start=1):
        if not isinstance(entry, dict):
            out.add("unreadable_yaml", f"order entry #{n} is not a mapping")
            continue
        key = _text(entry.get("key"))
        rank = _rank(entry.get("rank"))
        if key is None or rank is None:
            what = "key" if key is None else "a rank of 1 or more"
            out.add("unreadable_yaml", f"order entry #{n} lacks {what}", key)
            continue
        if key in seen:
            seen[key] += 1
            continue
        seen[key] = 1
        row = {
            "key": key,
            "rank": rank,
            "score": _number(entry.get("score")),
            "explanation": _text(entry.get("explanation")),
        }
        # A feature new in this PRD carries the formula's inputs the run set (NEW_INPUTS).
        for name in NEW_INPUTS:
            value = _text(entry.get(name)) if name == "goal" else _number(entry.get(name))
            if value is not None:
                row[name] = value
        rows.append(row)
    for key, times in seen.items():
        if times > 1:
            title = known.features.get(key) or key
            out.add("duplicate_key", f"{title} is ranked {times} times", key)
    rows.sort(key=lambda r: r["rank"])
    ranks: dict[int, str] = {}
    for r in rows:
        if r["rank"] in ranks:
            out.add(
                "duplicate_rank",
                f"{r['key']} and {ranks[r['rank']]} are both ranked {r['rank']}",
                r["key"],
            )
        else:
            ranks[r["rank"]] = r["key"]
    gaps = [n for n in range(1, len(ranks) + 1) if n not in ranks]
    if gaps:
        out.add(
            "rank_gap",
            f"ranks run 1..{len(ranks)} once each; missing: {', '.join(map(str, gaps[:10]))}",
        )
    _check_features(out, rows, known)
    for r in rows:
        if r["key"] in known.new_goals:
            _check_new_goals(out, r, known)
    live = known.live.get(out.method or "", [])
    live_rank = live_ranks([r["key"] for r in rows], live)
    by_key = {f["key"]: f for f in live}
    for r in rows:
        r["live_rank"] = live_rank.get(r["key"])
    # Where each sits among the live features the run ranks, as outside_limits reads it: new
    # features ranked above a feature do not move it (review of PR 1244, RP1 a).
    in_live = sorted((r for r in rows if r["live_rank"] is not None), key=lambda r: r["rank"])
    position = {r["key"]: i for i, r in enumerate(in_live, start=1)}
    for r in rows:
        if r["live_rank"] is not None and abs(r["live_rank"] - position[r["key"]]) > LIVE_SLACK:
            out.add(
                "differs_from_live",
                f"{r['key']} is ranked {r['rank']} here and {r['live_rank']} in the live ranking",
                r["key"],
                blocking=False,
            )
        if "no_confirmed_goal" in ((by_key.get(r["key"]) or {}).get("flags") or []):
            out.add(
                "no_goal",
                f"{r['key']} serves no confirmed goal in the live ranking",
                r["key"],
                blocking=False,
            )
    out.order = rows
    return out


def _check_features(out: OrderCheck, rows: list[dict[str, Any]], known: Known) -> None:
    ranked = {r["key"]: r["rank"] for r in rows}
    scope = set(known.scope) if known.scope is not None else None
    for r in rows:
        key = r["key"]
        if key not in known.features:
            out.add("unknown_feature", f"{key} is not a feature of the baseline or the scope", key)
        elif scope is not None and key not in scope:
            out.add("not_in_scope", f"{key} is not included in the approved PRD scope", key)
    for key in known.scope or []:
        if key not in ranked:
            title = known.features.get(key) or key
            out.add("missing_feature", f"{title} is in the approved PRD scope and not ranked", key)
    for r in rows:
        for dep in sorted(known.depends_on.get(r["key"], ())):
            if dep in ranked and ranked[dep] > r["rank"]:
                out.add(
                    "before_prerequisite",
                    f"{r['key']} is ranked {r['rank']}, above {dep} (rank {ranked[dep]}), "
                    "which it depends on",
                    r["key"],
                )


def _check_new_goals(out: OrderCheck, row: dict[str, Any], known: Known) -> None:
    """A new feature names a goal it serves: its row's goal or its feature-set entry's, a
    goal of the Ground Truth (not rejected), with no contribution or one above 0. A 0 from
    either source wins (does not serve). A goal the Ground Truth does not have is blocking
    on its own: its link would be dropped (review of PR 1244, round 3)."""
    key = row["key"]
    title = known.features.get(key) or key
    named = [
        {"key": row.get("goal"), "contribution": row.get("contribution")},
        *known.new_goals[key],
    ]
    keys = [str(g["key"]) for g in named if g.get("key")]
    zero = {str(g["key"]) for g in named if g.get("key") and g.get("contribution") == 0}
    unknown = [k for k in dict.fromkeys(keys) if k not in known.goals]
    for goal in unknown:
        out.add("unknown_goal", unknown_goal_message(title, known.goal_names.get(goal)), key)
    if not unknown and not any(k in known.goals and k not in zero for k in keys):
        out.add(
            "new_feature_no_goal",
            f"{title} is new and names no goal it serves: the run must name one",
            key,
        )


def unknown_goal_message(feature: str, goal: str | None) -> str:
    """A new feature names a goal that is not one of the Ground Truth, said by the goal's last
    known name; with none (the goal was deleted, or never was one), never by its key."""
    if goal:
        return (
            f"{feature} names the goal {goal}, which is not a goal in the Ground Truth: "
            "the run must name one that is"
        )
    return f"{feature} names a goal that was deleted: the run must name a goal of the Ground Truth"


async def check_order_async(text: str, **kwargs: Any) -> OrderCheck:
    """:func:`check_order` in a worker thread, at most ``PARSE_SECONDS``: a check that
    takes longer, or fails in any way, is a problem, never an exception."""
    try:
        return await safe_yaml.run_parse_within(
            check_order, text, name=FILE, seconds=PARSE_SECONDS, **kwargs
        )
    except safe_yaml.ParseBusy:
        raise  # no worker for it: the caller gives up for now and retries
    except safe_yaml.ParseTimeout:
        out = OrderCheck()
        out.add(
            "unreadable_yaml",
            f"{FILE} took more than {PARSE_SECONDS:g} s to read; keep it small and plain",
        )
        return out
    except Exception as exc:  # noqa: BLE001 - agent output: every failure is a problem
        out = OrderCheck()
        out.add("unreadable_yaml", f"{FILE} could not be checked ({type(exc).__name__})")
        return out


# --------------------------------------------------------------------------- the snapshot


async def known_for_run(db: AsyncSession, run: Any) -> tuple[Known, uuid.UUID | None]:
    """The baseline's features, the run's approved PRD scope (C6) and the live ranking of
    every method, read once; with the scope's id (None without one)."""
    from oracle.baseline.models import Entity
    from oracle.priorities import service
    from oracle.priorities.scoring import rank
    from oracle.runs import feature_set

    features = await service.load_features(db)
    goals = list(await db.scalars(select(Entity).where(Entity.type == "goal")))
    known = Known(
        features={f.key: f.title for f in features},
        depends_on={f.key: set(f.depends_on) for f in features},
        live={m: list(rank(features, m)["features"]) for m in PRIORITY_METHODS},
        goals={g.key: g.title for g in goals if g.status != "rejected"},
        goal_names={g.key: g.title for g in goals},
    )
    scope = await feature_set.approved_scope(db, run_id=run.id, document_id=run.document_id)
    if scope is None:
        return known, None
    included = [
        i
        for i in await feature_set.scope_items(db, scope.id)
        if i.kind == "feature" and i.decision == "include"
    ]
    known.scope = [i.key for i in included]
    for i in included:
        if i.key not in known.features:
            known.new_goals[i.key] = list(i.goals or [])
        known.features.setdefault(i.key, i.title or i.key)
        known.depends_on.setdefault(i.key, set()).update(i.depends_on or [])
    return known, scope.id


def ranking_of(check: OrderCheck, known: Known) -> list[dict[str, Any]]:
    """For each ranked key in the live ranking: its live ``RankedFeature`` of the file's
    method, with ``rank`` the run's rank, ``live_rank`` and ``run_explanation``. A feature
    new in this PRD (known, not in the live ranking) is scored on the same formula from the
    inputs the run set (:func:`new_feature`), marked ``new``. An unknown key stays in the
    check's order only."""
    method = check.method or "goal_weighted"
    live_rows = known.live.get(method, [])
    live = {f["key"]: f for f in live_rows}
    rows = []
    for r in check.order:
        f = live.get(r["key"])
        if f is None:
            if r["key"] in known.features:
                rows.append(new_feature(r, known.features[r["key"]], method, live_rows, known))
            continue
        rows.append(
            {
                **json.loads(json.dumps(f, default=str)),
                "rank": r["rank"],
                "live_rank": r["live_rank"],
                "run_explanation": r["explanation"],
            }
        )
    return rows


def _goal_title(
    key: str | None, live_rows: list[dict[str, Any]], names: dict[str, str] | None = None
) -> str | None:
    if key is not None and names and key in names:
        return names[key]
    for f in live_rows:
        for g in (f.get("explanation") or {}).get("goals") or []:
            if g.get("goal") == key:
                return g.get("title")
    return key


def _goal_weight(key: str | None, live_rows: list[dict[str, Any]]) -> float | None:
    """The goal's weight as the live ranking reads it (not assumed), or None."""
    for f in live_rows:
        for g in (f.get("explanation") or {}).get("goals") or []:
            if g.get("goal") == key and not g.get("weight_assumed"):
                return g.get("weight")
    return None


def _num(v: float) -> str:
    return f"{v:g}"


def new_feature(
    r: dict[str, Any],
    title: str,
    method: str,
    live_rows: list[dict[str, Any]],
    known: Known | None = None,
) -> dict[str, Any]:
    """A feature new in this PRD as a ``RankedFeature``: goal weight × contribution ×
    confidence ÷ effort from the inputs the run set; the file's score when one is missing.
    A goal named with no weight takes the goal's weight in the live ranking, with no
    contribution the scorer's default: either then marked assumed, as the scorer marks a
    link's. Its confidence is the run's, with no evidence yet. What it depends on, and what
    waits on it, are the edges the baseline and the run's feature set give (``known``)."""
    from oracle.priorities.scoring import DEFAULT_CONTRIBUTION, DEFAULT_WEIGHT, FORMULAS

    goal, given_weight, given = r.get("goal"), r.get("weight"), r.get("contribution")
    confidence, effort = r.get("confidence"), r.get("effort")
    goals, steps, missing = [], [], []
    score = r.get("score")
    if goal is not None:
        # A goal named with no weight or contribution: the scorer's default, marked assumed.
        live_weight = _goal_weight(goal, live_rows)
        weight = next(w for w in (given_weight, live_weight, DEFAULT_WEIGHT) if w is not None)
        contribution = given if given is not None else DEFAULT_CONTRIBUTION
        value = weight * contribution
        goal_title = _goal_title(goal, live_rows, known.goal_names if known else None)
        goals.append(
            {
                "goal": goal,
                "title": goal_title,
                "weight": weight,
                "weight_assumed": given_weight is None and live_weight is None,
                "contribution": int(contribution),
                "contribution_assumed": given is None,
                "link_status": "proposed",
                "term": value,
            }
        )
        # In the scorer's words (oracle.priorities.scoring), so the page shows them as every
        # row's: confidence as a percent, the score to two decimals.
        steps.append(
            f"goal value = {_num(weight)}×{_num(contribution)} ({goal_title}) = {_num(value)}"
        )
        if confidence is not None and effort:
            score = round(value * confidence / effort, 4)
            steps.append(
                f"score = {_num(value)} × {_num(confidence)} ÷ {_num(effort)} = {_num(score)}"
            )
    else:
        value = None
        missing.append("goal")
    if confidence is None:
        missing.append("confidence")
    if effort is None:
        missing.append("effort")
    edges = known.depends_on if known is not None else {}
    key = r["key"]
    depends_on = sorted(d for d in edges.get(key, ()) if d != key)
    dependents = sorted(k for k, deps in edges.items() if k != key and key in deps)
    return {
        "rank": r["rank"],
        "score_rank": r["rank"],
        "entity_id": "",
        "key": r["key"],
        "title": title,
        "status": "proposed",
        "score": score,
        "serves_goal": bool(goals),
        "flags": [],
        "depends_on": depends_on,
        "dependents": dependents,
        "explanation": {
            "method": method,
            "formula": FORMULAS.get(method, ""),
            "inputs": {
                "effort": {"value": effort, "attr": "effort", "raw": effort},
                "goal_value": {"value": value, "terms": goals},
            },
            "confidence": {
                "value": confidence or 0,
                "source": "attrs" if confidence is not None else "default",
                "explain": "Set by the run: new in this PRD, no evidence yet",
                "evidence": [],
            },
            "goals": goals,
            "missing": missing,
            "steps": steps,
            "order": [],
        },
        "live_rank": None,
        "run_explanation": r.get("explanation"),
        "new": True,
    }


async def propose(
    db: AsyncSession,
    run: Any,
    *,
    segment_seq: int,
    attempt: int,
    check: OrderCheck,
    known: Known,
    scope_id: uuid.UUID | None,
) -> PrioritySnapshot:
    """Rule 1: the order is stored as the run's proposed snapshot. Rule 2: the run's other
    proposed one is discarded; one written again for the same attempt (a resumed segment
    end) is replaced, not doubled."""
    same = await db.scalar(
        select(PrioritySnapshot).where(
            PrioritySnapshot.run_id == run.id,
            PrioritySnapshot.status == "proposed",
            PrioritySnapshot.params["segment_seq"].as_integer() == segment_seq,
            PrioritySnapshot.params["attempt"].as_integer() == attempt,
        )
    )
    await db.execute(
        update(PrioritySnapshot)
        .where(
            PrioritySnapshot.run_id == run.id,
            PrioritySnapshot.status == "proposed",
            PrioritySnapshot.id != (same.id if same is not None else uuid.uuid4()),
        )
        .values(status="discarded", decided_at=datetime.now(UTC))
    )
    from oracle.priorities.scoring import FORMULAS

    method = check.method or "goal_weighted"
    params = {
        "segment_seq": segment_seq,
        "attempt": attempt,
        "formula": FORMULAS.get(method),
        "generated_at": datetime.now(UTC).isoformat(),
    }
    snapshot = same or PrioritySnapshot(run_id=run.id, status="proposed")
    snapshot.method = method
    snapshot.params = params
    snapshot.ranking = ranking_of(check, known)
    snapshot.check_result = check.as_json()
    snapshot.document_id = run.document_id
    snapshot.scope_id = scope_id
    if same is None:
        db.add(snapshot)
    await db.flush()
    return snapshot


def _goals(row: dict[str, Any]) -> set[str]:
    return {str(g.get("goal")) for g in (row.get("explanation") or {}).get("goals") or []}


def outside_limits(rows: list[dict[str, Any]], *, max_rank_move: int) -> str | None:
    """Why a run's order is outside H11 ``priorities`` limits, or None: compared with the
    live ranking of the same features, a feature moves more than ``max_rank_move`` places,
    or passes a feature that shares no goal with it (C9: within one goal). Features the
    live ranking does not hold are not moves."""
    ranked = sorted((r for r in rows if r.get("live_rank") is not None), key=lambda r: r["rank"])
    for position, r in enumerate(ranked, start=1):
        moved = abs(position - int(r["live_rank"]))
        if moved > max_rank_move:
            places = "1 place" if moved == 1 else f"{moved} places"
            return f"{r['key']} moves {places}, more than {max_rank_move}"
    for i, a in enumerate(ranked):
        for b in ranked[i + 1 :]:
            # a is now above b; it was below: a passed b.
            if a["live_rank"] > b["live_rank"] and not _goals(a) & _goals(b):
                return f"{a['key']} passes {b['key']}, which serves another goal"
    return None


async def snapshot_for(db: AsyncSession, cp: Any) -> PrioritySnapshot | None:
    """The snapshot a priority-order checkpoint decides, if it has one."""
    if cp.kind != "priority_order":
        return None
    raw = (cp.payload or {}).get("priority_snapshot_id")
    if raw:
        try:
            found = await db.get(PrioritySnapshot, uuid.UUID(str(raw)))
        except ValueError:
            found = None
        if found is not None:
            return found
    return await db.scalar(select(PrioritySnapshot).where(PrioritySnapshot.checkpoint_id == cp.id))


def approve(snapshot: PrioritySnapshot, by: uuid.UUID | None, document_id: uuid.UUID | None):
    """The order is saved for the PRD (``by`` None: Oracle saved it, the stop was off)."""
    snapshot.status = "saved"
    snapshot.decided_by = by
    snapshot.decided_at = datetime.now(UTC)
    if document_id is not None:
        snapshot.document_id = document_id


# The mark on a problem :func:`stale_goals` added: the goal's key, so a later read drops the
# problem once the goal is a goal of the Ground Truth again.
STALE_GOAL = "stale_goal"
# How a stale-goal problem stored before the mark reads (a rejected goal, by its title).
_STALE_TEXT = "after the order was checked"


def _is_stale(problem: dict[str, Any]) -> bool:
    return bool(problem.get(STALE_GOAL)) or _STALE_TEXT in str(problem.get("message") or "")


async def stale_goals(
    db: AsyncSession, snapshot: PrioritySnapshot, problems: list[dict[str, Any]] | None = None
) -> list[dict[str, Any]]:
    """The goals the order's new features serve that the Ground Truth rejected (or lost)
    since the order was checked, as blocking ``unknown_goal`` problems ``problems`` (the
    order's check by default) do not have yet: approving would add the feature with no
    supports link (review of PR 1244, round 4). The goals read as :func:`_propose_links`
    reads them. A goal no longer in the Ground Truth is named by its last known name (the
    order's row kept it), else as a goal that was deleted: never by its key."""
    from oracle.baseline.models import Entity

    rows = [r for r in snapshot.ranking or [] if r.get("new")]
    if not rows:
        return []
    items = await _scope_features(db, snapshot.scope_id)
    goals = {g.key: g for g in await db.scalars(select(Entity).where(Entity.type == "goal"))}
    if problems is None:
        problems = (snapshot.check_result or {}).get("problems") or []
    known = {p.get("message") for p in problems}
    out: list[dict[str, Any]] = []
    for row in rows:
        key = row["key"]
        item = items.get(key)
        terms = (row.get("explanation") or {}).get("goals") or []
        named = [*terms, *[{**g, "goal": g.get("key")} for g in (item.goals if item else [])]]
        # A 0 from either source: the feature does not serve that goal, so it needs no link.
        zero = {str(g["goal"]) for g in named if g.get("goal") and g.get("contribution") == 0}
        for goal in dict.fromkeys(str(g["goal"]) for g in named if g.get("goal")):
            if goal in zero:
                continue
            found = goals.get(goal)
            if found is not None and found.status != "rejected":
                continue
            feature = row.get("title") or key
            if found is None:
                # Its last known name: a term's title, when the row kept one (not the key).
                name = next(
                    (
                        str(g["title"])
                        for g in named
                        if g.get("goal") == goal and g.get("title") and g["title"] != goal
                    ),
                    None,
                )
                message = unknown_goal_message(feature, name)
            else:
                message = (
                    f"{feature} serves the goal {found.title}, which was "
                    "rejected after the order was checked: the run must name a goal of the "
                    "Ground Truth"
                )
            if message not in known:
                known.add(message)
                out.append(
                    {
                        "code": "unknown_goal",
                        "blocking": True,
                        "feature": key,
                        "message": message,
                        STALE_GOAL: goal,
                    }
                )
    return out


async def recheck_goals(
    db: AsyncSession, snapshot: PrioritySnapshot, *, add: bool = True
) -> tuple[dict[str, Any], list[dict[str, Any]]]:
    """The order's check with its stale-goal problems (:func:`stale_goals`) as of now, and
    those problems. One whose goal is a goal of the Ground Truth again (restored, confirmed)
    is dropped; ``add``: one newly stale is added too (Approve order), else only what the
    order already said is kept (a read: the band, the gate, the Inbox)."""
    check = dict(snapshot.check_result or {})
    problems = list(check.get("problems") or [])
    kept = [p for p in problems if not _is_stale(p)]
    said = {p.get("message") for p in problems if _is_stale(p)}
    stale = [
        p for p in await stale_goals(db, snapshot, kept) if add or p["message"] in said
    ]
    check["problems"] = [*kept, *stale]
    return check, stale


async def accept_new(db: AsyncSession, snapshot: PrioritySnapshot, principal: Any) -> int:
    """An approved order adds the features new in its PRD to the baseline as proposed: the
    run's open proposals that create them are accepted (RP1), one per feature; another open
    create of a feature already added is rejected as the same feature. A new feature the
    run left no open create for is made from its ranking row and the approved feature set's
    entry, never skipped. Each carries the run's effort and confidence, and, as proposed
    links a person confirms, the goals it serves and what it depends on (review of PR 1244:
    every feature traces to its goal). Returns how many were added."""
    from oracle.baseline.models import Proposal
    from oracle.baseline.service import Writer, create_entity, decide_proposal, find_entity

    rows = {r["key"]: r for r in snapshot.ranking or [] if r.get("new")}
    if not rows or snapshot.run_id is None:
        return 0
    items = await _scope_features(db, snapshot.scope_id)
    open_ = await db.scalars(
        select(Proposal)
        .where(Proposal.run_id == snapshot.run_id, Proposal.status == "open")
        .order_by(Proposal.created_at, Proposal.id)
    )
    creates: dict[str, list[Proposal]] = {}
    for p in list(open_):
        fields = (p.payload or {}).get("fields") or {}
        key = fields.get("key")
        if (p.payload or {}).get("op") == "create" and fields.get("type", "feature") == "feature":
            if key in rows:
                creates.setdefault(key, []).append(p)
    added: list[str] = []
    for key, row in rows.items():
        mine = creates.get(key, [])
        exists = await find_entity(db, "feature", key) is not None
        # Rejected before the first is accepted, which would close it as already done.
        for p in mine[0 if exists else 1 :]:
            await decide_proposal(db, p.id, principal, False, SAME_FEATURE)
        if exists:
            continue
        attrs = _new_attrs(row)
        if mine:
            # As proposed: an accepted create is confirmed unless its fields say otherwise.
            p = mine[0]
            fields = (p.payload or {}).get("fields") or {}
            fields = {**fields, "attrs": {**(fields.get("attrs") or {}), **attrs}}
            p.payload = {**p.payload, "fields": {**fields, "status": "proposed"}}
            await decide_proposal(db, p.id, principal, True, "Added by the approved order")
        else:
            item = items.get(key)
            writer = Writer(
                principal, "user", run_id=snapshot.run_id, reason="Added by the approved order"
            )
            await create_entity(
                db,
                writer,
                type_="feature",
                key=key,
                title=row.get("title") or (item.title if item else None) or key,
                body=item.text if item else None,
                attrs=attrs,
                status="proposed",
            )
        added.append(key)
    for key in added:
        await _propose_links(db, snapshot.run_id, key, rows[key], items.get(key))
    return len(added)


async def _scope_features(db: AsyncSession, scope_id: uuid.UUID | None) -> dict[str, Any]:
    """The approved feature set's included features by key ({} without one)."""
    if scope_id is None:
        return {}
    from oracle.runs import feature_set

    return {
        i.key: i
        for i in await feature_set.scope_items(db, scope_id)
        if i.kind == "feature" and i.decision == "include"
    }


def _new_attrs(row: dict[str, Any]) -> dict[str, Any]:
    """The effort and confidence the run set for a new feature (its ranking row)."""
    e = row.get("explanation") or {}
    out: dict[str, Any] = {}
    effort = ((e.get("inputs") or {}).get("effort") or {}).get("value")
    if effort is not None:
        out["effort"] = effort
    confidence = e.get("confidence") or {}
    if confidence.get("source") == "attrs" and confidence.get("value") is not None:
        out["confidence"] = confidence["value"]
    return out


def _contribution(value: Any) -> int | None:
    if isinstance(value, bool) or not isinstance(value, int | float) or value != int(value):
        return None
    return int(value) if 0 <= value <= 3 else None


# A supports link proposed for a goal named with no contribution: the scorer's default,
# marked assumed on the link so a person sees it and sets the real one.
ASSUMED_LINK = {"contribution": 1, "contribution_assumed": True}


async def _propose_links(
    db: AsyncSession, run_id: uuid.UUID, key: str, row: dict[str, Any], item: Any
) -> None:
    """A new feature's supports links to the goals it serves (its ranking row's, then the
    feature set's) and depends_on links to the features it needs, proposed by the run. A
    goal named with no usable contribution still gets its link, the contribution assumed
    (``ASSUMED_LINK``) unless the other names one; a 0 from either source (does not serve)
    gets none."""
    from oracle.baseline.service import Writer, create_edge, find_edge, find_entity

    feature = await find_entity(db, "feature", key)
    if feature is None:
        return
    writer = Writer(None, "agent", run_id=run_id, reason="Proposed by the approved order")
    goals: dict[str, dict[str, Any]] = {}
    terms = (row.get("explanation") or {}).get("goals") or []
    named = [*terms, *[{**g, "goal": g.get("key")} for g in (item.goals if item else [])]]
    # A 0 from either source wins: the feature does not serve that goal.
    zero = {str(g["goal"]) for g in named if g.get("goal") and g.get("contribution") == 0}
    for g in named:
        contribution = _contribution(g.get("contribution"))
        if not g.get("goal") or str(g["goal"]) in zero:
            continue
        if contribution is None or g.get("contribution_assumed"):
            goals.setdefault(str(g["goal"]), ASSUMED_LINK)
        elif goals.get(str(g["goal"]), ASSUMED_LINK) is ASSUMED_LINK:
            goals[str(g["goal"])] = {"contribution": contribution}
    links: list[tuple[str, str, str, dict[str, Any]]] = [
        ("goal", goal, "supports", dict(attrs)) for goal, attrs in goals.items()
    ]
    depends = {*(row.get("depends_on") or []), *(item.depends_on if item else [])}
    links += [("feature", d, "depends_on", {}) for d in sorted(depends) if d != key]
    for type_, other_key, edge_type, attrs in links:
        other = await find_entity(db, type_, other_key)
        if other is None or other.status == "rejected":
            continue
        if await find_edge(db, feature.id, other.id, edge_type) is None:
            await create_edge(
                db,
                writer,
                src_id=feature.id,
                dst_id=other.id,
                type_=edge_type,
                attrs=attrs,
                status="proposed",
            )


# Why an approved order rejects a second open create of a feature it already added.
SAME_FEATURE = "The same feature as one the approved order added"


def discard(snapshot: PrioritySnapshot, by: uuid.UUID | None) -> None:
    snapshot.status = "discarded"
    snapshot.decided_by = by
    snapshot.decided_at = datetime.now(UTC)


def reopen(snapshot: PrioritySnapshot) -> None:
    """A decision voided or not posted: the order is proposed again."""
    snapshot.status = "proposed"
    snapshot.decided_by = None
    snapshot.decided_at = None


async def fill_document(db: AsyncSession, run_id: uuid.UUID, document_id: uuid.UUID) -> None:
    """Rule 6: once the run's draft imports, its snapshots name the document."""
    await db.execute(
        update(PrioritySnapshot)
        .where(PrioritySnapshot.run_id == run_id, PrioritySnapshot.document_id.is_(None))
        .values(document_id=document_id)
    )
