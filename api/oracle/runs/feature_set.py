"""Feature set and PRD scope (C6): ``feature_set.yaml``, its check and the scope it becomes.

``feature_set.yaml`` (version 1) is what the ``feature_set`` segment hands its checkpoint:

    version: 1
    document: saved-addresses          # the run's PRD slug
    features:
      - key: saved-addresses           # a baseline feature key, or one this run proposed
        title: Saved addresses
        summary: Returning buyers pick a saved address at checkout
        goals:                         # confirmed goal keys with contribution 0-3; [] = serves none
          - {key: activation, contribution: 2}
        depends_on: [address-lookup]   # feature keys
        blockers: [card-vault-limits]  # constraint keys (optional)
        confidence: 0.7                # 0-1, from the evidence
        evidence: [<evidence or source item ids>]   # optional
        requirements:
          - key: saved-addresses-pick  # a baseline requirement key, or one this run proposed
            text: The buyer picks one of up to five saved addresses
            acceptance: ["Five addresses at most", "The last used one is preselected"]
    excluded:                          # considered and left out, with a reason
      - key: address-sharing
        reason: Serves no confirmed goal

:func:`check_feature_set` lists every problem at once. Blocking problems (Approve is
refused while any is open, call c3): ``unreadable_yaml``, ``wrong_version``,
``wrong_document``, ``no_features``, ``missing_field``, ``invalid_field`` (a field of the
wrong shape: a contribution outside 0-3, a confidence outside 0-1, a list that is not
one), ``duplicate_key``, ``unknown_feature``, ``unknown_requirement``, ``unknown_goal``
(only confirmed goals count), ``unknown_dependency``, ``depends_on_excluded``,
``dependency_cycle`` and ``unknown_blocker``. Advisory flags, per included feature:
``serves_no_goal``, ``low_confidence`` (below the company's low threshold),
``linked_blocker`` (a listed blocker that is open and gates publishing), ``new_feature``
(a proposal of this run, not in the baseline yet) and ``duplicate_of_existing`` (its
title, lower-cased and without punctuation, is another feature's).

The file is agent output. It is read by :func:`load_feature_set` through the one safe
loader (:func:`oracle.safe_yaml.load`: no anchors, aliases, tags or duplicate keys,
bounded size, depth and node count), at most ``MAX_STORED_BYTES`` once parsed. Every
refusal is a :class:`FeatureSetError`. Async callers use :func:`check_feature_set_async`,
which checks on the parse pool (:func:`oracle.safe_yaml.run_parse_within`), at most
``PARSE_SECONDS``.

When the segment ends Oracle writes a **proposed scope** (:func:`write_scope`,
oracle.runs.scope_models), even with blocking problems; approving the checkpoint
approves it after :func:`check_scope` re-checks the rows as stored with the same rules
(:func:`check_rows`). The priority order, the PRD draft and the document's next drafts
read the approved scope (``GET /v1/runs/{id}/scope``, ``GET /v1/documents/{doc}/scope``,
the curated MCP tool ``get_prd_scope``, or :func:`scope_yaml` pasted in the prompt).
Excluded and deferred features are scope-only: nothing in the baseline changes.
"""

import json
import re
import uuid
from collections import Counter
from dataclasses import dataclass, field
from datetime import UTC, datetime
from decimal import Decimal, InvalidOperation
from typing import Any

from sqlalchemy import delete, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from oracle import confidence as confidence_weights
from oracle import safe_yaml
from oracle.baseline.models import Entity, Proposal
from oracle.runs.schemas import FeatureSetCheck as CheckOut
from oracle.runs.schemas import PrdScopeOut, ScopeFeatureOut, ScopeGoal, ScopeRequirementOut
from oracle.runs.scope_models import PrdScope, PrdScopeItem
from oracle.tenant_settings import TenantSetting

FILE = "feature_set.yaml"
# A parsed feature_set.yaml is at most this large as JSON.
MAX_STORED_BYTES = 1_000_000
# The parse and check run on the parse pool, never in the event loop, at most this long.
PARSE_SECONDS = safe_yaml.PARSE_SECONDS
# The format, as the module docstring and the segment's task state it (oracle.runs.flows).
FORMAT = """\
version: 1
document: <this PRD's slug>
features:
  - key: <a baseline feature key, or one you proposed with propose_change>
    title: <title>
    summary: <one line>
    goals: [{key: <a confirmed goal key>, contribution: <0-3>}]   # [] = serves none
    depends_on: [<feature keys>]
    blockers: [<constraint keys>]        # optional
    confidence: <0-1, from the evidence>
    evidence: [<evidence or source item ids>]   # optional
    requirements:
      - key: <a baseline requirement key, or one you proposed>
        text: <the requirement>
        acceptance: [<criteria>]
excluded:                                # considered and left out
  - key: <feature key>
    reason: <why>
"""

CONTRIBUTIONS = range(0, 4)
FLAG_ORDER = (
    "serves_no_goal",
    "low_confidence",
    "linked_blocker",
    "new_feature",
    "duplicate_of_existing",
)
# Features a scope leaves out (scope-only: the baseline keeps them).
LEFT_OUT = ("exclude", "defer")


def blocking_message(n: int) -> str:
    """Why Approve is refused while ``n`` blocking problems are open (web, Inbox, MCP)."""
    return (
        f"The feature set has {n} blocking problem{'' if n == 1 else 's'}; send it back with "
        "Request changes"
    )


def norm_title(title: str) -> str:
    """A title lower-cased, without punctuation, single-spaced: two features with the same
    normalized title are likely the same feature."""
    return " ".join(re.sub(r"[^\w\s]", " ", title.lower()).split())


@dataclass(frozen=True)
class Ref:
    """A key the check knows: a baseline entity, or an open create-proposal of this run."""

    entity_id: uuid.UUID | None = None
    proposal_id: uuid.UUID | None = None
    title: str = ""

    @property
    def new(self) -> bool:
        return self.entity_id is None and self.proposal_id is not None


@dataclass
class Known:
    """What the check reads from the baseline (:func:`known_for_run`)."""

    # Non-rejected feature entities and this run's open create-proposals of type feature.
    features: dict[str, Ref] = field(default_factory=dict)
    # The same for requirements.
    requirements: dict[str, Ref] = field(default_factory=dict)
    # Confirmed goals only.
    goals: dict[str, uuid.UUID] = field(default_factory=dict)
    # Non-rejected constraint entities.
    constraints: dict[str, uuid.UUID] = field(default_factory=dict)
    # Constraint keys that are open blockers gating publishing.
    gating: set[str] = field(default_factory=set)
    # (key, normalized title) of every non-rejected feature entity.
    titles: list[tuple[str, str]] = field(default_factory=list)
    # The company's low-confidence threshold.
    low: float = 0.4


@dataclass
class FeatureSetCheck:
    # Included features, parsed, in file order (key, title, summary, goals, depends_on,
    # blockers, confidence, evidence, requirements: key, text, acceptance).
    features: list[dict[str, Any]] = field(default_factory=list)
    # Left out: key and reason (and decision, when deferred).
    excluded: list[dict[str, Any]] = field(default_factory=list)
    problems: list[dict[str, Any]] = field(default_factory=list)
    flags: dict[str, list[str]] = field(default_factory=dict)

    def add(
        self,
        code: str,
        message: str,
        feature: str | None = None,
        requirement: str | None = None,
        *,
        blocking: bool = True,
    ) -> None:
        self.problems.append(
            {
                "code": code,
                "blocking": blocking,
                "feature": feature,
                "requirement": requirement,
                "message": message,
            }
        )

    @property
    def blocking(self) -> int:
        return sum(1 for p in self.problems if p.get("blocking", True))

    def as_json(self) -> dict[str, Any]:
        return {
            "features": len(self.features),
            "requirements": sum(len(f["requirements"]) for f in self.features),
            "excluded": len(self.excluded),
            "problems": self.problems,
            "flags": self.flags,
        }


def blocking_of(check: dict[str, Any] | None) -> int:
    """Blocking problems in a stored check (``as_json``)."""
    if not isinstance(check, dict):
        return 0
    return sum(1 for p in check.get("problems") or [] if p.get("blocking", True))


class FeatureSetError(ValueError):
    """feature_set.yaml was refused before it was checked: ``code`` names why."""

    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code


def load_feature_set(text: str) -> Any:
    """Parse feature_set.yaml the one safe way, at most ``MAX_STORED_BYTES`` as JSON.
    Raises :class:`FeatureSetError` and nothing else."""
    try:
        try:
            data = safe_yaml.load(text)
        except safe_yaml.SafeYamlError as exc:
            raise FeatureSetError(exc.code, f"{FILE} is refused: {exc}") from exc
        size = len(json.dumps(data, default=str).encode())
        if size > MAX_STORED_BYTES:
            raise FeatureSetError(
                "too_large", f"{FILE} is {size} bytes once parsed, over {MAX_STORED_BYTES}"
            )
        return data
    except FeatureSetError:
        raise
    except Exception as exc:  # noqa: BLE001 - agent output: every failure is a refusal
        raise FeatureSetError(
            "unreadable_yaml",
            f"{FILE} could not be read ({type(exc).__name__}: {str(exc)[:200]})",
        ) from exc


def _text(value: Any) -> str | None:
    if value is None or isinstance(value, bool):
        return None
    if isinstance(value, str):
        return value.strip() or None
    if isinstance(value, int | float):
        return str(value)
    return None


def _keys(value: Any) -> list[str] | None:
    """A list of keys, or None when ``value`` is not one (absent is an empty list)."""
    if value is None:
        return []
    if not isinstance(value, list) or not all(_text(v) for v in value):
        return None
    return [_text(v) for v in value]  # type: ignore[misc]


def check_feature_set(text: str, *, document: str | None, known: Known) -> FeatureSetCheck:
    """Parse and check ``feature_set.yaml`` against the run's PRD slug (``document``; None:
    any) and what the baseline holds (``known``)."""
    out = FeatureSetCheck()
    try:
        data = load_feature_set(text)
    except FeatureSetError as exc:
        out.add("unreadable_yaml", str(exc))
        return out
    if not isinstance(data, dict):
        out.add("unreadable_yaml", f"{FILE} must be a mapping with a features list")
        return out
    if data.get("version") != 1:
        out.add("wrong_version", f"version is {data.get('version')!r}, not 1")
    if document and _text(data.get("document")) != document:
        out.add(
            "wrong_document", f"document is {data.get('document')!r}, not this PRD ({document})"
        )
    features = data.get("features")
    if not isinstance(features, list) or not features:
        out.add("no_features", f"{FILE} lists no features")
        features = []
    excluded = data.get("excluded")
    if excluded is not None and not isinstance(excluded, list):
        out.add("invalid_field", "excluded must be a list")
        excluded = []
    _check_sets(out, features, excluded or [], known)
    return out


async def check_feature_set_async(text: str, **kwargs: Any) -> FeatureSetCheck:
    """:func:`check_feature_set` in a worker thread, at most ``PARSE_SECONDS``: a check
    that takes longer, or fails in any way, is a problem, never an exception."""
    try:
        return await safe_yaml.run_parse_within(
            check_feature_set, text, name=FILE, seconds=PARSE_SECONDS, **kwargs
        )
    except safe_yaml.ParseTimeout:
        out = FeatureSetCheck()
        out.add(
            "unreadable_yaml",
            f"{FILE} took more than {PARSE_SECONDS:g} s to read; keep it small and plain",
        )
        return out
    except Exception as exc:  # noqa: BLE001 - agent output: every failure is a problem
        out = FeatureSetCheck()
        out.add("unreadable_yaml", f"{FILE} could not be checked ({type(exc).__name__})")
        return out


def _parse_goals(out: FeatureSetCheck, key: str | None, raw: Any) -> list[dict[str, Any]]:
    if raw is None:
        return []
    if not isinstance(raw, list):
        out.add("invalid_field", f"feature {key}: goals must be a list", key)
        return []
    goals = []
    for g in raw:
        if isinstance(g, str) and _text(g):
            goals.append({"key": g.strip(), "contribution": None})
            continue
        gkey = _text(g.get("key")) if isinstance(g, dict) else None
        if gkey is None:
            out.add("invalid_field", f"feature {key}: each goal needs a key", key)
            continue
        c = g.get("contribution")
        if c is not None and (
            isinstance(c, bool) or not isinstance(c, int) or c not in CONTRIBUTIONS
        ):
            out.add(
                "invalid_field",
                f"feature {key}: goal {gkey} contribution {c!r} is not 0-3",
                key,
            )
            c = None
        goals.append({"key": gkey, "contribution": c})
    return goals


def _parse_feature(out: FeatureSetCheck, n: int, raw: Any) -> dict[str, Any] | None:
    if not isinstance(raw, dict):
        out.add("missing_field", f"feature {n} is not a mapping")
        return None
    key = _text(raw.get("key"))
    label = key or f"#{n}"
    missing = [f for f in ("key", "title") if not _text(raw.get(f))]
    if raw.get("goals") is None:
        missing.append("goals")
    if missing:
        out.add("missing_field", f"feature {label} lacks {', '.join(missing)}", key)
    lists: dict[str, list[str]] = {}
    for name in ("depends_on", "blockers", "evidence"):
        value = _keys(raw.get(name))
        if value is None:
            out.add("invalid_field", f"feature {label}: {name} must be a list of keys", key)
            value = []
        lists[name] = value
    conf = raw.get("confidence")
    if conf is not None and (
        isinstance(conf, bool) or not isinstance(conf, int | float) or not 0 <= conf <= 1
    ):
        out.add("invalid_field", f"feature {label}: confidence {conf!r} is not 0-1", key)
        conf = None
    reqs_raw = raw.get("requirements")
    if reqs_raw is not None and not isinstance(reqs_raw, list):
        out.add("invalid_field", f"feature {label}: requirements must be a list", key)
        reqs_raw = []
    requirements = []
    for m, r in enumerate(reqs_raw or [], start=1):
        if not isinstance(r, dict):
            out.add("missing_field", f"requirement {m} of feature {label} is not a mapping", key)
            continue
        rkey = _text(r.get("key"))
        rmissing = [f for f in ("key", "text") if not _text(r.get(f))]
        if rmissing:
            out.add(
                "missing_field",
                f"requirement {rkey or f'#{m}'} of feature {label} lacks {', '.join(rmissing)}",
                key,
                rkey,
            )
        acceptance = r.get("acceptance")
        if acceptance is None:
            acceptance = []
        elif not isinstance(acceptance, list) or not all(_text(a) for a in acceptance):
            out.add(
                "invalid_field",
                f"requirement {rkey or f'#{m}'} of feature {label}: acceptance must be a list "
                "of criteria",
                key,
                rkey,
            )
            acceptance = []
        requirements.append(
            {
                "key": rkey,
                "text": _text(r.get("text")),
                "acceptance": [_text(a) for a in acceptance],
            }
        )
    return {
        "key": key,
        "title": _text(raw.get("title")),
        "summary": _text(raw.get("summary")),
        "goals": _parse_goals(out, label, raw.get("goals")),
        "depends_on": lists["depends_on"],
        "blockers": lists["blockers"],
        "evidence": lists["evidence"],
        "confidence": float(conf) if conf is not None else None,
        "requirements": requirements,
    }


def _check_sets(
    out: FeatureSetCheck, features: list[Any], excluded: list[Any], known: Known
) -> None:
    """The rules over a parsed set (the file's, or a stored scope's): every problem and
    every flag, in one pass."""
    for n, raw in enumerate(features, start=1):
        parsed = _parse_feature(out, n, raw)
        if parsed is not None:
            out.features.append(parsed)
    for n, raw in enumerate(excluded, start=1):
        key = _text(raw.get("key")) if isinstance(raw, dict) else None
        if key is None:
            out.add("missing_field", f"excluded entry {n} lacks key")
            continue
        entry = {"key": key, "reason": _text(raw.get("reason"))}
        if raw.get("decision") == "defer":
            entry["decision"] = "defer"
        out.excluded.append(entry)

    included = [f["key"] for f in out.features if f["key"]]
    left_out = [e["key"] for e in out.excluded]
    for key, count in Counter(included + left_out).items():
        if count > 1:
            out.add("duplicate_key", f"feature key {key} appears {count} times", key)
    req_keys = [(f["key"], r["key"]) for f in out.features for r in f["requirements"] if r["key"]]
    for rkey, count in Counter(r for _, r in req_keys).items():
        if count > 1:
            owner = next(f for f, r in req_keys if r == rkey)
            out.add("duplicate_key", f"requirement key {rkey} appears {count} times", owner, rkey)

    for key in dict.fromkeys(included + left_out):
        if key not in known.features:
            out.add(
                "unknown_feature",
                f"{key} is neither a baseline feature nor one this run proposed",
                key,
            )
    included_set, left_set = set(included), set(left_out) - set(included)
    for f in out.features:
        key = f["key"]
        for r in f["requirements"]:
            if r["key"] and r["key"] not in known.requirements:
                out.add(
                    "unknown_requirement",
                    f"requirement {r['key']} of {key} is neither a baseline requirement nor "
                    "one this run proposed",
                    key,
                    r["key"],
                )
        for g in f["goals"]:
            if g["key"] not in known.goals:
                out.add("unknown_goal", f"{key}: goal {g['key']} is not a confirmed goal", key)
        for dep in f["depends_on"]:
            if dep in left_set:
                out.add("depends_on_excluded", f"{key} depends on {dep}, which is excluded", key)
            elif dep not in included_set and dep not in known.features:
                out.add(
                    "unknown_dependency",
                    f"{key} depends on {dep}, which is not in the feature set or the baseline",
                    key,
                )
        for b in f["blockers"]:
            if b not in known.constraints:
                out.add("unknown_blocker", f"{key}: blocker {b} is not a constraint", key)

    for cycle in _cycles({f["key"]: f["depends_on"] for f in out.features if f["key"]}):
        out.add(
            "dependency_cycle",
            "the included features depend on each other in a cycle: " + " -> ".join(cycle),
            cycle[0],
        )
    out.flags = _flags(out.features, known)


def _cycles(graph: dict[str, list[str]]) -> list[list[str]]:
    """Each dependency cycle among the included features, once, starting at its smallest
    key and closed (``[a, b, a]``)."""
    edges = {k: [d for d in deps if d in graph] for k, deps in graph.items()}
    found: dict[tuple[str, ...], list[str]] = {}
    state: dict[str, int] = {}  # 1: on the path, 2: done
    path: list[str] = []

    def visit(node: str) -> None:
        state[node] = 1
        path.append(node)
        for dep in edges[node]:
            if state.get(dep) == 1:
                ring = path[path.index(dep) :]
                start = ring.index(min(ring))
                ring = ring[start:] + ring[:start]
                found.setdefault(tuple(ring), [*ring, ring[0]])
            elif state.get(dep) is None:
                visit(dep)
        path.pop()
        state[node] = 2

    for node in edges:
        if state.get(node) is None:
            visit(node)
    return list(found.values())


def _flags(features: list[dict[str, Any]], known: Known) -> dict[str, list[str]]:
    flags: dict[str, list[str]] = {}
    for f in features:
        key = f["key"]
        if not key:
            continue
        mine: list[str] = []
        if f["goals"] == []:
            mine.append("serves_no_goal")
        if f["confidence"] is not None and f["confidence"] < known.low:
            mine.append("low_confidence")
        if any(b in known.gating for b in f["blockers"]):
            mine.append("linked_blocker")
        ref = known.features.get(key)
        if ref is not None and ref.new:
            mine.append("new_feature")
        title = norm_title(f["title"] or "")
        if title and any(t == title and k != key for k, t in known.titles):
            mine.append("duplicate_of_existing")
        if mine:
            flags[key] = mine
    return flags


# --------------------------------------------------------------------------- rows


def rows_of(check: FeatureSetCheck) -> list[dict[str, Any]]:
    """The scope's rows for a checked set, in file order (features included, then left
    out; each requirement after its feature, ``parent`` naming it). Duplicate and keyless
    entries are dropped: the check has reported them."""
    rows: list[dict[str, Any]] = []
    seen: set[str] = set()
    position = 0
    for f in check.features:
        key = f["key"]
        if not key or key in seen:
            continue
        seen.add(key)
        rows.append(
            {
                "kind": "feature",
                "key": key,
                "title": f["title"],
                "text": f["summary"],
                "decision": "include",
                "decision_reason": None,
                "goals": [dict(g) for g in f["goals"]],
                "depends_on": list(f["depends_on"]),
                "blocker_keys": list(f["blockers"]),
                "confidence": f["confidence"],
                "evidence": list(f["evidence"]),
                "position": position,
            }
        )
        position += 1
    req_seen: set[str] = set()
    for f in check.features:
        if not f["key"]:
            continue
        n = 0
        for r in f["requirements"]:
            if not r["key"] or r["key"] in req_seen:
                continue
            req_seen.add(r["key"])
            rows.append(
                {
                    "kind": "requirement",
                    "parent": f["key"],
                    "key": r["key"],
                    "text": r["text"],
                    "acceptance": list(r["acceptance"]),
                    "decision": "keep",
                    "position": n,
                }
            )
            n += 1
    for e in check.excluded:
        if e["key"] in seen:
            continue
        seen.add(e["key"])
        rows.append(
            {
                "kind": "feature",
                "key": e["key"],
                "title": None,
                "decision": e.get("decision", "exclude"),
                "decision_reason": e.get("reason"),
                "goals": [],
                "depends_on": [],
                "blocker_keys": [],
                "confidence": None,
                "evidence": [],
                "position": position,
            }
        )
        position += 1
    return rows


def check_rows(rows: list[dict[str, Any]], *, known: Known) -> FeatureSetCheck:
    """The same rules as :func:`check_feature_set`, over a scope as stored (rows): kept
    requirements of included features, then the features left out."""
    features = sorted(
        (r for r in rows if r["kind"] == "feature"), key=lambda r: r.get("position", 0)
    )
    reqs = sorted(
        (r for r in rows if r["kind"] == "requirement" and r.get("decision") == "keep"),
        key=lambda r: r.get("position", 0),
    )
    included, left_out = [], []
    for f in features:
        if f["decision"] in LEFT_OUT:
            entry = {"key": f["key"], "reason": f.get("decision_reason")}
            if f["decision"] == "defer":
                entry["decision"] = "defer"
            left_out.append(entry)
            continue
        included.append(
            {
                "key": f["key"],
                "title": f.get("title") or f["key"],
                "summary": f.get("text"),
                "goals": [
                    {"key": g["key"], "contribution": g.get("contribution")}
                    for g in f.get("goals") or []
                ],
                "depends_on": list(f.get("depends_on") or []),
                "blockers": list(f.get("blocker_keys") or []),
                "evidence": [str(e) for e in f.get("evidence") or []],
                "confidence": f.get("confidence"),
                "requirements": [
                    {"key": r["key"], "text": r.get("text"), "acceptance": r.get("acceptance")}
                    for r in reqs
                    if r.get("parent") == f["key"]
                ],
            }
        )
    out = FeatureSetCheck()
    if not included:
        out.add("no_features", "the scope includes no features")
    _check_sets(out, included, left_out, known)
    return out


# --------------------------------------------------------------------------- database


async def low_threshold(db: AsyncSession) -> float:
    row = await db.scalar(select(TenantSetting).where(TenantSetting.key == "confidence_weights"))
    overrides = row.value if row is not None and isinstance(row.value, dict) else None
    return float(confidence_weights.merged(overrides)["low"])


async def known_for_run(db: AsyncSession, run_id: uuid.UUID) -> Known:
    """What the check reads: the baseline's features, requirements, confirmed goals and
    constraints (rejected ones never count), this run's open create-proposals of features
    and requirements, the blockers that gate publishing, and the low threshold."""
    from oracle.blockers import service as blockers

    known = Known(low=await low_threshold(db))
    entities = list(
        await db.scalars(
            select(Entity).where(
                Entity.type.in_(("feature", "requirement", "goal", "constraint")),
                Entity.status != "rejected",
            )
        )
    )
    blocker_rows = []
    for e in entities:
        if e.type == "feature":
            known.features[e.key] = Ref(entity_id=e.id, title=e.title)
            known.titles.append((e.key, norm_title(e.title)))
        elif e.type == "requirement":
            known.requirements[e.key] = Ref(entity_id=e.id, title=e.title)
        elif e.type == "goal":
            if e.status == "confirmed":
                known.goals[e.key] = e.id
        else:
            known.constraints[e.key] = e.id
            if isinstance(e.attrs, dict) and "blocker" in e.attrs:
                blocker_rows.append(e)
    if blocker_rows:
        inputs = await blockers.gate_inputs(db, [e.id for e in blocker_rows])
        for e in blocker_rows:
            spec = blockers.safe_spec(e)
            if spec is not None and spec.status not in ("open", "mitigating"):
                continue
            if blockers.assess(e, spec, inputs).status == "critical":
                known.gating.add(e.key)
    proposals = await db.scalars(
        select(Proposal).where(
            Proposal.run_id == run_id,
            Proposal.status == "open",
            Proposal.entity_id.is_(None),
            Proposal.edge_id.is_(None),
        )
    )
    for p in proposals:
        payload = p.payload or {}
        fields = payload.get("fields") or {}
        if payload.get("op") != "create" or payload.get("kind") != "entity":
            continue
        key, title = _text(fields.get("key")), _text(fields.get("title")) or ""
        target = {"feature": known.features, "requirement": known.requirements}.get(
            fields.get("type")
        )
        if key and target is not None and key not in target:
            target[key] = Ref(proposal_id=p.id, title=title)
    return known


def _uuids(values: list[str]) -> list[uuid.UUID]:
    out = []
    for v in values:
        try:
            out.append(uuid.UUID(str(v)))
        except ValueError:
            continue
    return out


def _confidence(value: float | None) -> Decimal | None:
    if value is None:
        return None
    try:
        return Decimal(str(value)).quantize(Decimal("0.001"))
    except InvalidOperation:
        return None


async def write_scope(
    db: AsyncSession,
    run: Any,
    *,
    segment_seq: int,
    attempt: int,
    check: FeatureSetCheck,
    known: Known,
) -> PrdScope:
    """The proposed scope of this attempt of the run's feature-set segment (rules 1-2): one
    row per feature and requirement, in file order, with their baseline entity or this
    run's proposal; written again for the same attempt it replaces the earlier rows. Any
    other proposed scope of the run is superseded. The caller commits."""
    await db.execute(
        delete(PrdScope).where(
            PrdScope.run_id == run.id,
            PrdScope.segment_seq == segment_seq,
            PrdScope.attempt == attempt,
        )
    )
    await db.execute(
        update(PrdScope)
        .where(PrdScope.run_id == run.id, PrdScope.status == "proposed")
        .values(status="superseded", lock_version=PrdScope.lock_version + 1)
        .execution_options(synchronize_session="fetch")
    )
    scope = PrdScope(
        id=uuid.uuid4(),
        run_id=run.id,
        segment_seq=segment_seq,
        attempt=attempt,
        document_id=run.document_id,
        status="proposed",
        check_result=check.as_json(),
    )
    db.add(scope)
    await db.flush()
    parents: dict[str, uuid.UUID] = {}
    for row in rows_of(check):
        if row["kind"] == "feature":
            ref = known.features.get(row["key"])
            item = PrdScopeItem(
                id=uuid.uuid4(),
                scope_id=scope.id,
                kind="feature",
                key=row["key"],
                title=row["title"] or (ref.title if ref and ref.title else row["key"]),
                text=row.get("text"),
                goals=[
                    {
                        "goal_id": str(known.goals[g["key"]]) if g["key"] in known.goals else None,
                        "key": g["key"],
                        "contribution": g["contribution"],
                    }
                    for g in row["goals"]
                ],
                depends_on=row["depends_on"],
                blocker_keys=row["blocker_keys"],
                confidence=_confidence(row["confidence"]),
                evidence_ids=_uuids(row["evidence"]),
                decision=row["decision"],
                decision_reason=row["decision_reason"],
                origin="agent",
                flags=list(check.flags.get(row["key"], [])),
                position=row["position"],
                entity_id=ref.entity_id if ref else None,
                proposal_id=ref.proposal_id if ref else None,
            )
            parents[row["key"]] = item.id
        else:
            ref = known.requirements.get(row["key"])
            text = row["text"] or ""
            item = PrdScopeItem(
                id=uuid.uuid4(),
                scope_id=scope.id,
                kind="requirement",
                parent_id=parents[row["parent"]],
                key=row["key"],
                title=(ref.title if ref and ref.title else text[:200]) or row["key"],
                text=row["text"],
                acceptance=row["acceptance"],
                decision="keep",
                origin="agent",
                position=row["position"],
                entity_id=ref.entity_id if ref else None,
                proposal_id=ref.proposal_id if ref else None,
            )
        db.add(item)
    await db.flush()
    return scope


async def scope_items(db: AsyncSession, scope_id: uuid.UUID) -> list[PrdScopeItem]:
    return list(
        await db.scalars(
            select(PrdScopeItem)
            .where(PrdScopeItem.scope_id == scope_id)
            .order_by(PrdScopeItem.kind, PrdScopeItem.position, PrdScopeItem.key)
        )
    )


def _rows(items: list[PrdScopeItem]) -> list[dict[str, Any]]:
    keys = {i.id: i.key for i in items if i.kind == "feature"}
    return [
        {
            "kind": i.kind,
            "parent": keys.get(i.parent_id) if i.parent_id else None,
            "key": i.key,
            "title": i.title,
            "text": i.text,
            "acceptance": list(i.acceptance or []),
            "decision": i.decision,
            "decision_reason": i.decision_reason,
            "goals": list(i.goals or []),
            "depends_on": list(i.depends_on or []),
            "blocker_keys": list(i.blocker_keys or []),
            "confidence": float(i.confidence) if i.confidence is not None else None,
            "evidence": [str(e) for e in i.evidence_ids or []],
            "position": i.position,
        }
        for i in items
    ]


async def check_scope(db: AsyncSession, scope: PrdScope) -> FeatureSetCheck:
    """Re-check the scope as stored, with the same rules as the file (:func:`check_rows`)
    against the baseline now (a proposal rejected since, a goal unconfirmed): its stored
    check and each feature's flags follow. The caller commits."""
    items = await scope_items(db, scope.id)
    check = check_rows(_rows(items), known=await known_for_run(db, scope.run_id))
    scope.check_result = check.as_json()
    for item in items:
        if item.kind == "feature" and item.decision == "include":
            flags = check.flags.get(item.key, [])
            if list(item.flags or []) != flags:
                item.flags = flags
    return check


async def latest_scope(
    db: AsyncSession, run_id: uuid.UUID, *, segment_seq: int | None = None
) -> PrdScope | None:
    """The run's latest scope, any status (of one segment, with ``segment_seq``)."""
    q = select(PrdScope).where(PrdScope.run_id == run_id)
    if segment_seq is not None:
        q = q.where(PrdScope.segment_seq == segment_seq)
    return await db.scalar(
        q.order_by(PrdScope.segment_seq.desc(), PrdScope.attempt.desc()).limit(1)
    )


async def approved_scope(db: AsyncSession, *, run_id: uuid.UUID | None = None,
                         document_id: uuid.UUID | None = None) -> PrdScope | None:  # fmt: skip
    """The run's approved scope, else (with ``document_id``) the document's."""
    if run_id is not None:
        found = await db.scalar(
            select(PrdScope)
            .where(PrdScope.run_id == run_id, PrdScope.status == "approved")
            .order_by(PrdScope.attempt.desc())
            .limit(1)
        )
        if found is not None or document_id is None:
            return found
    if document_id is None:
        return None
    return await db.scalar(
        select(PrdScope)
        .where(PrdScope.document_id == document_id, PrdScope.status == "approved")
        .order_by(PrdScope.approved_at.desc().nulls_last(), PrdScope.created_at.desc())
        .limit(1)
    )


async def supersede_others(db: AsyncSession, scope: PrdScope) -> None:
    """Every other approved scope of the scope's document becomes superseded: a document
    has one approved scope."""
    if scope.document_id is None:
        return
    await db.execute(
        update(PrdScope)
        .where(
            PrdScope.document_id == scope.document_id,
            PrdScope.status == "approved",
            PrdScope.id != scope.id,
        )
        .values(status="superseded", lock_version=PrdScope.lock_version + 1)
        .execution_options(synchronize_session="fetch")
    )


async def approve(db: AsyncSession, scope: PrdScope, by: uuid.UUID | None, document_id:
                  uuid.UUID | None = None) -> None:  # fmt: skip
    """Approve the scope (rule 3; ``by`` None: Oracle, the stop was off) and supersede the
    document's earlier approved one. The caller audits and commits."""
    if scope.document_id is None and document_id is not None:
        scope.document_id = document_id
    scope.status = "approved"
    scope.approved_by = by
    scope.approved_at = datetime.now(UTC)
    scope.lock_version += 1
    await db.flush()
    await supersede_others(db, scope)


async def fill_document(db: AsyncSession, run_id: uuid.UUID, document_id: uuid.UUID) -> None:
    """Rule 6: once the run's draft imports, its scopes name the document; its approved
    one then supersedes the document's earlier approved scope."""
    scopes = list(
        await db.scalars(
            select(PrdScope).where(PrdScope.run_id == run_id, PrdScope.document_id.is_(None))
        )
    )
    for scope in scopes:
        scope.document_id = document_id
    await db.flush()
    for scope in scopes:
        if scope.status == "approved":
            await supersede_others(db, scope)


def scope_yaml(scope: PrdScope, items: list[PrdScopeItem]) -> str:
    """The scope as pasted in a prompt when MCP is not attached: the included features
    with their kept requirements, then the excluded and deferred keys with reasons."""
    features = [i for i in items if i.kind == "feature"]
    by_parent: dict[uuid.UUID, list[PrdScopeItem]] = {}
    for i in items:
        if i.kind == "requirement" and i.decision == "keep" and i.parent_id:
            by_parent.setdefault(i.parent_id, []).append(i)
    included = []
    for f in sorted(features, key=lambda i: i.position):
        if f.decision != "include":
            continue
        entry: dict[str, Any] = {"key": f.key, "title": f.title}
        if f.text:
            entry["summary"] = f.text
        entry["goals"] = [
            {"key": g.get("key"), "contribution": g.get("contribution")} for g in f.goals or []
        ]
        if f.depends_on:
            entry["depends_on"] = list(f.depends_on)
        entry["requirements"] = [
            {"key": r.key, "text": r.text, **({"acceptance": r.acceptance} if r.acceptance else {})}
            for r in sorted(by_parent.get(f.id, []), key=lambda i: i.position)
        ]
        included.append(entry)
    left = [
        {"key": f.key, "decision": f.decision, "reason": f.decision_reason}
        for f in sorted(features, key=lambda i: i.position)
        if f.decision in LEFT_OUT
    ]
    data = {"status": scope.status, "features": included, "excluded": left}
    return safe_yaml.dump(data, sort_keys=False, allow_unicode=True)


def scope_out(scope: PrdScope, items: list[PrdScopeItem]) -> PrdScopeOut:
    """``PrdScopeOut``: the features in file order, each with its requirements."""
    reqs: dict[uuid.UUID, list[PrdScopeItem]] = {}
    for i in items:
        if i.kind == "requirement" and i.parent_id:
            reqs.setdefault(i.parent_id, []).append(i)
    features = [
        ScopeFeatureOut(
            id=f.id,
            key=f.key,
            title=f.title,
            decision=f.decision,  # type: ignore[arg-type]
            decision_reason=f.decision_reason,
            origin=f.origin,  # type: ignore[arg-type]
            goals=[ScopeGoal(**g) for g in f.goals or []],
            depends_on=list(f.depends_on or []),
            blocker_keys=list(f.blocker_keys or []),
            confidence=float(f.confidence) if f.confidence is not None else None,
            flags=list(f.flags or []),
            entity_id=f.entity_id,
            proposal_id=f.proposal_id,
            requirements=[
                ScopeRequirementOut(
                    id=r.id,
                    key=r.key,
                    title=r.title,
                    text=r.text,
                    acceptance=list(r.acceptance or []),
                    decision=r.decision,  # type: ignore[arg-type]
                    decision_reason=r.decision_reason,
                    origin=r.origin,  # type: ignore[arg-type]
                    entity_id=r.entity_id,
                    proposal_id=r.proposal_id,
                )
                for r in sorted(reqs.get(f.id, []), key=lambda i: i.position)
            ],
        )
        for f in sorted((i for i in items if i.kind == "feature"), key=lambda i: i.position)
    ]
    check = scope.check_result or {}
    return PrdScopeOut(
        id=scope.id,
        run_id=scope.run_id,
        document_id=scope.document_id,
        segment_seq=scope.segment_seq,
        attempt=scope.attempt,
        status=scope.status,  # type: ignore[arg-type]
        check=CheckOut(
            features=check.get("features", 0),
            requirements=check.get("requirements", 0),
            excluded=check.get("excluded", 0),
            problems=check.get("problems") or [],
            flags=check.get("flags") or {},
        ),
        features=features,
        approved_by=scope.approved_by,
        approved_at=scope.approved_at,
        lock_version=scope.lock_version,
    )
