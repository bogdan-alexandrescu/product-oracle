"""Step 1 of Oracle's pushback on a move or pin (C9, decision C1b Pushback policy): four
rules on the ranking's own numbers. Pure functions, no database, no model call.

Each rule reads the order the person sees (``before``) and the order the change would
produce (``after``), both rows of :func:`oracle.priorities.scoring.apply_overrides`, and
says why, with the numbers from the explanation (decision O3: every number explained).
A feature *passes* another when it was below it before and is above it after.

- ``no_confirmed_goal``: it serves no confirmed goal and passes a feature that serves one.
- ``low_confidence``: its confidence is below the company's low threshold and it passes a
  feature at or above it.
- ``against_score``: it rises 3 or more places above its formula rank and passes a
  feature whose score is at least twice its own.
- ``open_blocker``: it enters the top 3 while an open blocker that gates publishing is
  linked to it.
"""

from typing import Any

RISE = 3
SCORE_FACTOR = 2
TOP = 3


def _n(x: float | None) -> str:
    return "—" if x is None else f"{round(x, 2):g}"


def _confidence(row: dict[str, Any]) -> float | None:
    return (row.get("explanation") or {}).get("confidence", {}).get("value")


def _sources(row: dict[str, Any]) -> int:
    return len((row.get("explanation") or {}).get("confidence", {}).get("evidence") or [])


def _top_goal(row: dict[str, Any]) -> dict[str, Any] | None:
    goals = (row.get("explanation") or {}).get("goals") or []
    return max(goals, key=lambda g: g.get("term") or 0, default=None)


def passes(before: list[dict[str, Any]], after: list[dict[str, Any]], key: str) -> list[dict]:
    """The rows ``key`` passes, in the order they come after the change."""
    was = {r["key"]: r["rank"] for r in before}
    now = {r["key"]: r["rank"] for r in after}
    if key not in was or key not in now:
        return []
    return [
        r
        for r in after
        if r["key"] != key and was.get(r["key"], 0) < was[key] and now[r["key"]] > now[key]
    ]


def rules(
    before: list[dict[str, Any]],
    after: list[dict[str, Any]],
    key: str,
    *,
    low: float,
    blockers: dict[str, list[str]],
) -> list[dict[str, Any]]:
    """The rule messages for moving ``key`` from ``before`` to ``after`` (empty: none)."""
    row = next((r for r in after if r["key"] == key), None)
    if row is None:
        return []
    passed = passes(before, after, key)
    out: list[dict[str, Any]] = []

    if not row["serves_goal"]:
        p = next((r for r in passed if r["serves_goal"]), None)
        if p is not None:
            goal = _top_goal(p) or {}
            out.append(
                {
                    "code": "no_confirmed_goal",
                    "message": (
                        f"{row['title']} serves no confirmed goal. Features that serve none "
                        f"sink (score {_n(row['score'])}); {p['title']} serves "
                        f"{goal.get('title', 'a confirmed goal')} (weight "
                        f"{_n(goal.get('weight'))}, contribution {goal.get('contribution')})."
                    ),
                    "numbers": {
                        "score": row["score"],
                        "passes": p["key"],
                        "passes_score": p["score"],
                        "goal": goal.get("goal"),
                        "weight": goal.get("weight"),
                        "contribution": goal.get("contribution"),
                    },
                }
            )

    conf = _confidence(row)
    if conf is not None and conf < low:
        p = next((r for r in passed if (_confidence(r) or 0) >= low), None)
        if p is not None:
            n = _sources(p)
            source = f" from {n} source{'s' if n != 1 else ''}" if n else ""
            out.append(
                {
                    "code": "low_confidence",
                    "message": (
                        f"Confidence {_n(conf)} is below {_n(low)}; {p['title']} has "
                        f"{_n(_confidence(p))}{source}."
                    ),
                    "numbers": {
                        "confidence": conf,
                        "threshold": low,
                        "passes": p["key"],
                        "passes_confidence": _confidence(p),
                        "passes_sources": n,
                    },
                }
            )

    formula_rank = row.get("formula_rank") or row["rank"]
    score = row["score"]
    if formula_rank - row["rank"] >= RISE and score is not None:
        higher = [
            r
            for r in passed
            if r["score"] is not None and r["score"] > 0 and r["score"] >= SCORE_FACTOR * score
        ]
        if higher:
            p = max(higher, key=lambda r: r["score"])
            ratio = ""
            if score > 0:
                times = p["score"] / score
                ratio = f" ({round(times) if times >= 10 else round(times, 1):g}× higher)"
            out.append(
                {
                    "code": "against_score",
                    "message": (
                        f"Score {_n(score)} against {_n(p['score'])} for {p['title']}{ratio}."
                    ),
                    "numbers": {
                        "score": score,
                        "formula_rank": formula_rank,
                        "rank": row["rank"],
                        "passes": p["key"],
                        "passes_score": p["score"],
                    },
                }
            )

    was = next((r["rank"] for r in before if r["key"] == key), None)
    linked = blockers.get(key) or []
    if linked and row["rank"] <= TOP and (was is None or was > TOP):
        out.append(
            {
                "code": "open_blocker",
                "message": (f"An open critical blocker ({', '.join(linked)}) is linked to it."),
                "numbers": {"rank": row["rank"], "blockers": linked},
            }
        )
    return out
