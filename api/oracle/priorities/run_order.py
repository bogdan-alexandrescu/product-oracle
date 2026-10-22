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
(ranked above a feature it depends on: decision O3, ordered by dependencies). Advisory:
``differs_from_live`` (its rank differs by more than ``LIVE_SLACK`` from the live ranking
of the same method, restricted to the same features) and ``no_goal`` (the live ranking
flags it ``no_confirmed_goal``).

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
        rows.append(
            {
                "key": key,
                "rank": rank,
                "score": _number(entry.get("score")),
                "explanation": _text(entry.get("explanation")),
            }
        )
    for key, times in seen.items():
        if times > 1:
            out.add("duplicate_key", f"feature {key} is ranked {times} times", key)
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
    live = known.live.get(out.method or "", [])
    live_rank = live_ranks([r["key"] for r in rows], live)
    by_key = {f["key"]: f for f in live}
    for r in rows:
        r["live_rank"] = live_rank.get(r["key"])
        if r["live_rank"] is not None and abs(r["live_rank"] - r["rank"]) > LIVE_SLACK:
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
            out.add("missing_feature", f"{key} is in the approved PRD scope and not ranked", key)
    for r in rows:
        for dep in sorted(known.depends_on.get(r["key"], ())):
            if dep in ranked and ranked[dep] > r["rank"]:
                out.add(
                    "before_prerequisite",
                    f"{r['key']} is ranked {r['rank']}, above {dep} (rank {ranked[dep]}), "
                    "which it depends on",
                    r["key"],
                )


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
    from oracle.priorities import service
    from oracle.priorities.scoring import rank
    from oracle.runs import feature_set

    features = await service.load_features(db)
    known = Known(
        features={f.key: f.title for f in features},
        depends_on={f.key: set(f.depends_on) for f in features},
        live={m: list(rank(features, m)["features"]) for m in PRIORITY_METHODS},
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
        known.features.setdefault(i.key, i.title or i.key)
        known.depends_on.setdefault(i.key, set()).update(i.depends_on or [])
    return known, scope.id


def ranking_of(check: OrderCheck, known: Known) -> list[dict[str, Any]]:
    """For each ranked key in the live ranking: its live ``RankedFeature`` of the file's
    method, with ``rank`` the run's rank, ``live_rank`` and ``run_explanation``. A key the
    live ranking lacks (a proposal of the run, an unknown key) stays in the check's order."""
    live = {f["key"]: f for f in known.live.get(check.method or "", [])}
    rows = []
    for r in check.order:
        f = live.get(r["key"])
        if f is None:
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
