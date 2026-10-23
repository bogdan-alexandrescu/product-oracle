"""Roadmap items: the structured rows behind a roadmap version (§11.4, CR-11).

A ``prd_to_roadmap`` run's ``roadmap_items.yaml`` (checked by
:func:`oracle.runs.roadmap.check_items`) becomes one :class:`RoadmapItem` per item when
the run's ``roadmap.md`` is imported as a roadmap version. A person can import the same
file for a version (``PUT /v1/roadmaps/{doc}/versions/{n}/items``), and a version
imported without one (the feedback loop, ``oracle push``) carries forward the previous
version's items that its text still names.

Each item is traced to the exact PRD version and section it came from (at the section's
content hash), and through the trace lane's section links and the baseline graph to:

- its feature: declared (``feature: <key>``), else a feature the PRD section links
  (``implements``, ``claims``, ``evidences``, ``tests``), else the feature whose key is
  the item's id;
- its requirements: declared, linked from the section, and the requirements that are
  ``part_of`` its feature;
- its blocker dependencies: declared, linked from the section, and the constraints that
  ``affects`` or ``blocks`` its feature or requirements (oracle.blockers' strategy lives
  on those constraint entities);
- validation gates: declared, the acceptance criteria that ``verifies`` its
  requirements, and its blockers' open feasibility experiments with their decision gate;
- economics: declared, plus the feature's effort and confidence and the item's priority.

``trace`` records how each link was made (``declared``, ``section_link``, ``key_match``,
``graph``), so a reviewer can see why an item claims a requirement. A milestone date is
kept only in Now and only when a verified schedule basis of the item's PRD supports it
(oracle.roadmap.schedule); otherwise the item keeps the milestone's name and records the
refused date. Read views re-check the date (:func:`live_milestones`).
"""

import copy
import hashlib
import json
import logging
import re
import uuid
from collections import OrderedDict
from dataclasses import dataclass, field
from typing import Any

from sqlalchemy import or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from oracle import safe_yaml
from oracle.baseline.models import Edge, Entity
from oracle.docs.models import Document, DocumentVersion, Section
from oracle.roadmap import schedule
from oracle.roadmap.models import HORIZONS, RoadmapItem
from oracle.runs import roadmap as items_file
from oracle.runs.models import Run, RunSegment
from oracle.v2.models import DocumentSectionLink, FeasibilityExperiment

log = logging.getLogger(__name__)

ITEMS_FILE = "roadmap_items.yaml"
ITEMS_SEGMENT = "roadmap_items"
# Section links that tie a section to what it delivers ("mentions" does not).
TRACING_LINKS = ("implements", "claims", "evidences", "tests")
OPEN_EXPERIMENTS = ("planned", "running")
ACTIVE_RUNS = ("running", "awaiting_checkpoint", "paused_overrun")

# Checked items files, by (content hash, PRD version, its sections, the bases): every
# roadmap import while a run is active stores that run's file again, and a file already
# checked against the same inputs is not parsed again (oracle.runs.roadmap's check is
# pure in these inputs).
_CHECKED: "OrderedDict[tuple, items_file.ItemsCheck]" = OrderedDict()
_CHECKED_MAX = 128


async def _checked_items(text: str, **inputs: Any) -> items_file.ItemsCheck:
    bases = inputs.get("date_bases")
    sections = inputs.get("prd_sections")
    key = (
        hashlib.sha256(text.encode("utf-8", "replace")).hexdigest(),
        inputs.get("prd_slug"),
        inputs.get("prd_version"),
        frozenset(sections) if sections is not None else None,
        tuple(bases) if bases is not None else None,
    )
    found = _CHECKED.get(key)
    if found is None:
        found = await items_file.check_items_async(text, **inputs)
        # A slow or failed read is not remembered: the next import tries again.
        if not any(p["code"] in ("too_slow", "unreadable_yaml") for p in found.problems):
            _CHECKED[key] = found
            while len(_CHECKED) > _CHECKED_MAX:
                _CHECKED.popitem(last=False)
    else:
        _CHECKED.move_to_end(key)
    return copy.deepcopy(found)


@dataclass
class ImportResult:
    items: list[RoadmapItem] = field(default_factory=list)
    problems: list[dict[str, str]] = field(default_factory=list)
    refused_dates: list[str] = field(default_factory=list)


# --- reading the baseline --------------------------------------------------------------


async def blockers_of(db: AsyncSession, target_ids: list[uuid.UUID]) -> list[Entity]:
    """Constraints (blockers) that affect or block any of ``target_ids``."""
    if not target_ids:
        return []
    rows = await db.scalars(
        select(Entity)
        .join(Edge, Edge.src_id == Entity.id)
        .where(
            Edge.dst_id.in_(target_ids),
            Edge.type.in_(("affects", "blocks")),
            Edge.status != "rejected",
            Entity.type == "constraint",
            Entity.status != "rejected",
        )
        .order_by(Entity.key)
    )
    return list(dict.fromkeys(rows))


async def blockers_by_target(
    db: AsyncSession, target_ids: list[uuid.UUID]
) -> dict[uuid.UUID, list[Entity]]:
    """:func:`blockers_of` for many targets in one query: target id -> its blockers."""
    if not target_ids:
        return {}
    rows = await db.execute(
        select(Edge.dst_id, Entity)
        .join(Edge, Edge.src_id == Entity.id)
        .where(
            Edge.dst_id.in_(set(target_ids)),
            Edge.type.in_(("affects", "blocks")),
            Edge.status != "rejected",
            Entity.type == "constraint",
            Entity.status != "rejected",
        )
        .order_by(Entity.key)
    )
    out: dict[uuid.UUID, list[Entity]] = {}
    for target, entity in rows.all():
        found = out.setdefault(target, [])
        if entity not in found:
            found.append(entity)
    return out


async def open_experiments(
    db: AsyncSession, blocker_ids: list[uuid.UUID]
) -> list[FeasibilityExperiment]:
    if not blocker_ids:
        return []
    rows = await db.scalars(
        select(FeasibilityExperiment)
        .where(
            FeasibilityExperiment.blocker_id.in_(blocker_ids),
            FeasibilityExperiment.status.in_(OPEN_EXPERIMENTS),
        )
        .order_by(FeasibilityExperiment.decision_gate_at.nulls_last(), FeasibilityExperiment.id)
    )
    return list(rows)


def json_safe(value: Any) -> Any:
    """YAML values as JSON can store them (dates and the like become strings)."""
    return json.loads(json.dumps(value, default=str))


def _keys(value: Any) -> list[str]:
    if isinstance(value, str):
        return [value]
    if isinstance(value, list):
        return [str(v) for v in value if isinstance(v, str)]
    return []


# --- deriving one item's trace -----------------------------------------------------------


async def derive_trace(
    db: AsyncSession, prd_version: DocumentVersion | None, raw: dict[str, Any]
) -> dict[str, Any]:
    """The feature, requirements, blockers, gates and economics of one raw item."""
    return (await derive_traces(db, prd_version, [raw]))[0]


def _merged(lists: list[list[Entity]]) -> list[Entity]:
    """Entities of several targets, each once, in key order (as one query of them all)."""
    return sorted(dict.fromkeys(e for found in lists for e in found), key=lambda e: e.key)


async def _by_type_and_key(
    db: AsyncSession, wanted: set[tuple[str, str]]
) -> dict[tuple[str, str], Entity]:
    if not wanted:
        return {}
    rows = await db.scalars(
        select(Entity).where(
            Entity.type.in_({t for t, _ in wanted}),
            Entity.key.in_({k for _, k in wanted}),
            Entity.status != "rejected",
        )
    )
    return {(e.type, e.key): e for e in rows if (e.type, e.key) in wanted}


async def _linked_by_section(
    db: AsyncSession, prd_version: DocumentVersion, section_keys: set[str]
) -> dict[str, list[Entity]]:
    """:func:`_linked_entities` for many sections in two queries: section -> its entities."""
    if not section_keys:
        return {}
    links = (
        await db.execute(
            select(DocumentSectionLink.section_key, DocumentSectionLink.entity_id).where(
                DocumentSectionLink.document_id == prd_version.document_id,
                DocumentSectionLink.section_key.in_(section_keys),
                DocumentSectionLink.kind.in_(TRACING_LINKS),
                DocumentSectionLink.entity_id.is_not(None),
                or_(
                    DocumentSectionLink.version_id == prd_version.id,
                    DocumentSectionLink.version_id.is_(None),
                ),
            )
        )
    ).all()
    if not links:
        return {}
    rows = list(
        await db.scalars(
            select(Entity)
            .where(Entity.id.in_({i for _, i in links}), Entity.status != "rejected")
            .order_by(Entity.type, Entity.key)
        )
    )
    ids: dict[str, set[uuid.UUID]] = {}
    for key, entity_id in links:
        ids.setdefault(key, set()).add(entity_id)
    return {key: [e for e in rows if e.id in found] for key, found in ids.items()}


async def _related(
    db: AsyncSession, dst_ids: set[uuid.UUID], edge_types: tuple[str, ...], type_: str
) -> dict[uuid.UUID, list[Entity]]:
    """The live ``type_`` entities with a live edge of ``edge_types`` to each of
    ``dst_ids``, in key order, in one query."""
    if not dst_ids:
        return {}
    rows = await db.execute(
        select(Edge.dst_id, Entity)
        .join(Edge, Edge.src_id == Entity.id)
        .where(
            Edge.dst_id.in_(dst_ids),
            Edge.type.in_(edge_types),
            Edge.status != "rejected",
            Entity.type == type_,
            Entity.status != "rejected",
        )
        .order_by(Entity.key)
    )
    out: dict[uuid.UUID, list[Entity]] = {}
    for dst, entity in rows.all():
        found = out.setdefault(dst, [])
        if entity not in found:
            found.append(entity)
    return out


async def derive_traces(
    db: AsyncSession, prd_version: DocumentVersion | None, raws: list[dict[str, Any]]
) -> list[dict[str, Any]]:
    """:func:`derive_trace` of many raw items, in a fixed number of queries whatever their
    number (each step reads for all the items at once); the results are the same."""
    sections = [items_file._text(raw.get("prd_section")) for raw in raws]
    declared = [raw.get("feature") if isinstance(raw.get("feature"), str) else None for raw in raws]
    declared_reqs = [_keys(raw.get("requirements")) for raw in raws]
    declared_blockers = [_keys(raw.get("blockers")) for raw in raws]
    item_keys = [items_file._text(raw.get("id")) for raw in raws]

    wanted = {("feature", k) for k in [*declared, *item_keys] if k}
    wanted |= {("requirement", k) for keys in declared_reqs for k in keys}
    wanted |= {("constraint", k) for keys in declared_blockers for k in keys}
    by_key = await _by_type_and_key(db, wanted)
    linked = (
        await _linked_by_section(db, prd_version, {s for s in sections if s})
        if prd_version is not None
        else {}
    )

    traces: list[list[dict[str, Any]]] = []
    features: list[Entity | None] = []
    requirements_of: list[dict[uuid.UUID, Entity]] = []
    blockers_of_item: list[dict[uuid.UUID, Entity]] = []
    for n in range(len(raws)):
        trace: list[dict[str, Any]] = []

        def note(target: str, entity: Entity, via: str, trace: list = trace) -> None:
            trace.append({"target": target, "id": str(entity.id), "key": entity.key, "via": via})

        feature: Entity | None = None
        requirements: dict[uuid.UUID, Entity] = {}
        blockers: dict[uuid.UUID, Entity] = {}
        declared_feature = declared[n]
        if declared_feature:
            feature = by_key.get(("feature", declared_feature))
            if feature is not None:
                note("feature", feature, "declared")
            else:
                trace.append({"target": "feature", "key": declared_feature, "unresolved": True})
        for key in declared_reqs[n]:
            if (found := by_key.get(("requirement", key))) is not None:
                requirements[found.id] = found
                note("requirement", found, "declared")
            else:
                trace.append({"target": "requirement", "key": key, "unresolved": True})
        for key in declared_blockers[n]:
            if (found := by_key.get(("constraint", key))) is not None:
                blockers[found.id] = found
                note("blocker", found, "declared")
            else:
                trace.append({"target": "blocker", "key": key, "unresolved": True})
        for entity in linked.get(sections[n] or "", []) if sections[n] else []:
            if entity.type == "feature" and feature is None:
                feature = entity
                note("feature", entity, "section_link")
            elif entity.type == "requirement" and entity.id not in requirements:
                requirements[entity.id] = entity
                note("requirement", entity, "section_link")
            elif entity.type == "constraint" and entity.id not in blockers:
                blockers[entity.id] = entity
                note("blocker", entity, "section_link")
        item_key = item_keys[n]
        if feature is None and item_key:
            feature = by_key.get(("feature", item_key))
            if feature is not None:
                note("feature", feature, "key_match")
        traces.append(trace)
        features.append(feature)
        requirements_of.append(requirements)
        blockers_of_item.append(blockers)

    parts = await _related(
        db, {f.id for f in features if f is not None}, ("part_of",), "requirement"
    )
    for n, feature in enumerate(features):
        if feature is not None:
            for req in parts.get(feature.id, []):
                if req.id not in requirements_of[n]:
                    requirements_of[n][req.id] = req
                    traces[n].append(
                        {"target": "requirement", "id": str(req.id), "key": req.key, "via": "graph"}
                    )
    targets = [
        ([f.id] if f is not None else []) + list(reqs)
        for f, reqs in zip(features, requirements_of, strict=True)
    ]
    affecting = await _related(
        db, {t for ts in targets for t in ts}, ("affects", "blocks"), "constraint"
    )
    for n, ts in enumerate(targets):
        for blocker in _merged([affecting.get(t, []) for t in ts]):
            if blocker.id not in blockers_of_item[n]:
                blockers_of_item[n][blocker.id] = blocker
                traces[n].append(
                    {"target": "blocker", "id": str(blocker.id), "key": blocker.key, "via": "graph"}
                )
    verifying = await _related(
        db, {r for reqs in requirements_of for r in reqs}, ("verifies",), "acceptance_criterion"
    )
    experiments = await open_experiments(db, list({b for bs in blockers_of_item for b in bs}))

    out: list[dict[str, Any]] = []
    for n, raw in enumerate(raws):
        feature, requirements, blockers = features[n], requirements_of[n], blockers_of_item[n]
        gates: list[dict[str, Any]] = []
        declared_gates = raw.get("validation_gates")
        for g in declared_gates if isinstance(declared_gates, list) else []:
            if isinstance(g, dict) and items_file._text(g.get("name")):
                gates.append(
                    {
                        "kind": "declared",
                        "name": items_file._text(g.get("name")),
                        "criterion": items_file._text(g.get("criterion")),
                    }
                )
        for criterion in _merged([verifying.get(r, []) for r in requirements]):
            gates.append(
                {
                    "kind": "acceptance_criterion",
                    "name": criterion.title,
                    "entity_id": str(criterion.id),
                    "key": criterion.key,
                }
            )
        for exp in experiments:
            if exp.blocker_id not in blockers:
                continue
            gates.append(
                {
                    "kind": "feasibility_experiment",
                    "name": exp.hypothesis,
                    "experiment_id": str(exp.id),
                    "blocker_id": str(exp.blocker_id),
                    "criterion": exp.success_threshold,
                    "decision_gate_at": exp.decision_gate_at.isoformat()
                    if exp.decision_gate_at
                    else None,
                    "status": exp.status,
                }
            )

        economics: dict[str, Any] = {}
        if isinstance(raw.get("economics"), dict):
            economics["declared"] = json_safe(raw["economics"])
        if feature is not None:
            attrs = feature.attrs or {}
            for k in ("effort", "confidence", "value", "cost"):
                if attrs.get(k) is not None:
                    economics.setdefault("baseline", {})[k] = attrs[k]
        priority = raw.get("priority") if isinstance(raw.get("priority"), dict) else None
        if priority and priority.get("score") is not None:
            economics["priority_score"] = priority.get("score")

        out.append(
            {
                "feature_id": feature.id if feature is not None else None,
                "requirement_ids": list(requirements),
                "blocker_ids": list(blockers),
                "trace": traces[n],
                "validation_gates": gates,
                "economics": economics,
            }
        )
    return out


# --- importing ---------------------------------------------------------------------------


def _milestone(
    raw: Any, bases: list[schedule.Basis], result: ImportResult, key: str, horizon: str | None
) -> Any:
    if raw is None:
        return None
    if isinstance(raw, str):
        return {"name": raw}
    if not isinstance(raw, dict):
        return None
    out: dict[str, Any] = {
        "name": items_file._text(raw.get("name")),
        "date": None,
        "date_source": items_file._text(raw.get("date_source")),
        "basis_ids": [],
    }
    when = raw.get("date")
    if when is None:
        return out
    day = schedule.as_date(when)
    support = schedule.supporting(when, out["date_source"], bases, key)
    if horizon != "now":
        # Dated milestones only in Now (O4): the date is dropped; the check recorded
        # the date_outside_now problem.
        out["refused_date"] = str(when)
        out["refused"] = schedule.OUTSIDE_NOW
        result.refused_dates.append(key)
    elif day is not None and support:
        out["date"] = day.isoformat()
        out["basis_ids"] = [str(b.id) for b in support]
    else:
        # Never a date without a verified basis: keep what was proposed, refused.
        out["refused_date"] = str(when)
        out["refused"] = schedule.UNVERIFIED
        result.refused_dates.append(key)
    return out


async def import_items(
    db: AsyncSession,
    version: DocumentVersion,
    text: str,
    *,
    run_id: uuid.UUID | None = None,
    strict: bool = False,
) -> ImportResult:
    """Store ``roadmap_items.yaml`` as the items of a roadmap version, replacing any it
    had. ``strict``: refuse the whole file on any problem (a person's import); else
    store the items that can be stored (a run's file, already shown at its checkpoint).
    The caller commits."""
    from oracle.roadmap import tracks

    result = ImportResult()
    prd_version = (
        await db.get(DocumentVersion, version.source_version_id)
        if version.source_version_id
        else None
    )
    prd_doc = await db.get(Document, prd_version.document_id) if prd_version else None
    keys = None
    if prd_version is not None:
        keys = set(
            await db.scalars(
                select(Section.section_key).where(Section.version_id == prd_version.id)
            )
        )
    bases = await schedule.verified_bases(db, prd_doc.id if prd_doc else None)
    check = await _checked_items(
        text,
        prd_slug=prd_doc.slug if prd_doc else None,
        prd_version=prd_version.number if prd_version else None,
        prd_sections=keys,
        date_bases=bases,
    )
    result.problems = check.problems
    if strict and check.problems:
        return result
    hashes: dict[str, str | None] = {}
    if prd_version is not None:
        hashes = dict(
            (
                await db.execute(
                    select(Section.section_key, Section.content_hash).where(
                        Section.version_id == prd_version.id
                    )
                )
            ).all()
        )
    track = await tracks.track_for_roadmap(db, version, prd_version)
    for old in await db.scalars(
        select(RoadmapItem).where(RoadmapItem.roadmap_version_id == version.id)
    ):
        await db.delete(old)
    await db.flush()
    seen: set[str] = set()
    for position, raw in enumerate(check.items):
        key = str(raw.get("id"))
        horizon = items_file._text(raw.get("horizon"))
        title = items_file._text(raw.get("title"))
        if horizon not in HORIZONS or not title or key in seen or key.startswith("#"):
            continue
        seen.add(key)
        derived = await derive_trace(db, prd_version, raw)
        section = items_file._text(raw.get("prd_section"))
        if keys is not None and section not in keys:
            section = None
        confidence = raw.get("confidence")
        item = RoadmapItem(
            roadmap_document_id=version.document_id,
            roadmap_version_id=version.id,
            track_id=track.id if track else None,
            run_id=run_id,
            item_key=key,
            position=position,
            title=title,
            outcome=items_file._text(raw.get("outcome")),
            horizon=horizon,
            prd_document_id=prd_doc.id if prd_doc else None,
            prd_version_id=prd_version.id if prd_version else None,
            prd_section_key=section,
            prd_section_hash=hashes.get(section) if section else None,
            depends_on=[
                str(d) for d in raw.get("depends_on") or [] if not isinstance(d, dict | list)
            ],
            milestone=_milestone(raw.get("milestone"), bases, result, key, horizon),
            priority=json_safe(raw["priority"]) if isinstance(raw.get("priority"), dict) else None,
            confidence=None if confidence is None else str(confidence),
            **derived,
        )
        db.add(item)
        result.items.append(item)
    await db.flush()
    return result


COPIED = (
    "track_id",
    "run_id",
    "item_key",
    "position",
    "title",
    "outcome",
    "horizon",
    "prd_document_id",
    "prd_version_id",
    "prd_section_key",
    "prd_section_hash",
    "feature_id",
    "requirement_ids",
    "blocker_ids",
    "depends_on",
    "trace",
    "validation_gates",
    "economics",
    "priority",
    "confidence",
    "freshness",
    "caused_by_change_id",
    "stale_since",
    "stale_reasons",
    "reconciled_by",
    "reconciled_at",
    "reconciled_version_id",
    "reconciled_section_hash",
)


def recheck_date(
    milestone: dict[str, Any] | None,
    bases: list[schedule.Basis],
    item_key: str | None = None,
    horizon: str | None = "now",
) -> Any:
    """A milestone keeps its date only while a verified basis of the item's PRD (and in
    its scope) still supports it, and only in Now. ``bases``: the PRD's verified bases."""
    if not milestone or not milestone.get("date"):
        return milestone
    support = schedule.supporting(milestone["date"], milestone.get("date_source"), bases, item_key)
    if horizon == "now" and support:
        return {**milestone, "basis_ids": [str(b.id) for b in support]}
    return {
        **milestone,
        "date": None,
        "basis_ids": [],
        "refused_date": milestone["date"],
        "refused": schedule.UNVERIFIED if horizon == "now" else schedule.OUTSIDE_NOW,
    }


async def live_milestones(db: AsyncSession, rows: list[RoadmapItem]) -> dict[uuid.UUID, Any]:
    """Each item's milestone as it stands now: its date re-checked against its own PRD's
    verified bases (a withdrawn or out-of-scope basis supports nothing). Read-only: the
    rows are not changed."""
    bases: dict[uuid.UUID | None, list[schedule.Basis]] = {}
    for prd in {r.prd_document_id for r in rows if (r.milestone or {}).get("date")}:
        bases[prd] = await schedule.verified_bases(db, prd)
    return {
        r.id: recheck_date(r.milestone, bases.get(r.prd_document_id, []), r.item_key, r.horizon)
        for r in rows
    }


# A key or title counts as named only as a whole: not inside a longer key ("pay" is not
# named by "payment-step"). Keys run on letters, digits, "-", "_" and ".".
_KEY_CHAR = r"A-Za-z0-9_.\-"


def _whole(needle: str, text: str) -> bool:
    needle = needle.strip()
    if not needle:
        return False
    pattern = rf"(?<![{_KEY_CHAR}]){re.escape(needle)}(?![A-Za-z0-9_\-])"
    return re.search(pattern, text, re.IGNORECASE) is not None


def _named_in(item: RoadmapItem, markdown: str) -> bool:
    """Whether the version's text still names the item: its key exactly (as a word or
    as a horizon anchor, ``{#now-<key>}``), or its title as a whole phrase."""
    if _whole(item.item_key, markdown):
        return True
    if any(_whole(f"{h}-{item.item_key}", markdown) for h in HORIZONS):
        return True
    return _whole(item.title, markdown)


async def carry_forward(db: AsyncSession, version: DocumentVersion) -> int:
    """A roadmap version imported without an items file keeps the previous version's
    items that its text still names (by id or title), with their anchors and freshness."""
    previous = await db.scalar(
        select(DocumentVersion)
        .where(
            DocumentVersion.document_id == version.document_id,
            DocumentVersion.number < version.number,
        )
        .order_by(DocumentVersion.number.desc())
        .limit(1)
    )
    if previous is None:
        return 0
    copied = 0
    rows = list(
        await db.scalars(
            select(RoadmapItem)
            .where(RoadmapItem.roadmap_version_id == previous.id)
            .order_by(RoadmapItem.position)
        )
    )
    prd_ids = {r.prd_document_id for r in rows}
    bases = {p: await schedule.verified_bases(db, p) for p in prd_ids}
    for old in rows:
        if not _named_in(old, version.markdown):
            continue
        db.add(
            RoadmapItem(
                **{c: getattr(old, c) for c in COPIED},
                milestone=recheck_date(
                    old.milestone, bases[old.prd_document_id], old.item_key, old.horizon
                ),
                roadmap_document_id=version.document_id,
                roadmap_version_id=version.id,
                note=f"carried from version {previous.number}",
            )
        )
        copied += 1
    await db.flush()
    return copied


async def run_items_file(db: AsyncSession, document: Document) -> tuple[str, Run] | None:
    """The items file of the active prd_to_roadmap run writing this roadmap, if any."""
    run = await db.scalar(
        select(Run)
        .where(
            Run.flow == "prd_to_roadmap",
            Run.status.in_(ACTIVE_RUNS),
            or_(
                Run.document_id == document.id,
                Run.knobs["document_slug"].astext == document.slug,
            ),
        )
        .order_by(Run.created_at.desc())
        .limit(1)
    )
    if run is None:
        return None
    segment = await db.scalar(
        select(RunSegment)
        .where(RunSegment.run_id == run.id, RunSegment.name == ITEMS_SEGMENT)
        .order_by(RunSegment.seq.desc())
        .limit(1)
    )
    text = ((segment.artifacts or {}).get("files") or {}).get(ITEMS_FILE) if segment else None
    if not isinstance(text, str):
        return None
    return text, run


async def on_roadmap_version(
    db: AsyncSession, version: DocumentVersion, document: Document
) -> None:
    """A roadmap version was imported: its run's items, else carried forward."""
    # Never abort the version's import: items that cannot be stored are left out, and
    # the run's items_check already showed the file's problems at its checkpoint.
    try:
        async with db.begin_nested():
            found = await run_items_file(db, document)
            if found is not None:
                text, run = found
                # Parsed once, by import_items (a refused file stores no items).
                await import_items(db, version, text, run_id=run.id)
            else:
                await carry_forward(db, version)
    except safe_yaml.ParseBusy:
        raise  # no worker for its items: the import gives up whole, the caller retries
    except Exception:  # noqa: BLE001 - logged; the roadmap version still imports
        log.exception("roadmap items for %s v%s were not stored", document.slug, version.number)
