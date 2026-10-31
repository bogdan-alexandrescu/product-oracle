"""Oracle's explanation drafts (H5, the ``metrics_variance`` run): the variances a run is
told about, and the importer that stores its drafts.

The run writes ``summary.md`` (the occurrence's summary, as ``ritual_summary``) and
``variances.yaml``::

    version: 1
    variances: [{id, draft, confidence: high|medium|low,
                 refs: [{kind: launch|changelog|decision|roadmap_item|source_item, id}]}]

Each draft (at most 80 words) goes on its variance, if the occurrence's pre-read lists
it. A ref the run could not read is dropped: an id of none of the company's launches,
changelog entries, decisions or roadmap items, or a source item outside the sources of
the person the run acts for. The drafts are shown to every member, so the run reads as a
commenter (oracle.runs.flows ``member_output``) and its refs are checked the same way,
whoever started it: a decision, or a roadmap item of a document, a commenter may not see
is dropped too (oracle.docs.visibility). What was dropped is counted in the import's
notes.
"""

import uuid
from collections import Counter
from typing import Any

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from oracle import safe_yaml
from oracle.auth.deps import Principal
from oracle.docs import visibility
from oracle.metrics import review
from oracle.metrics.models import CONFIDENCES, Metric, MetricVariance
from oracle.rituals.models import RitualOccurrence
from oracle.tenancy import current_tenant, tenant_session

FILE = "variances.yaml"
MAX_WORDS = 80
MAX_BYTES = 256 * 1024
REF_KINDS = ("launch", "changelog", "decision", "roadmap_item", "source_item")
_DROPS = (
    ("variance", "not in this review"),
    ("variance", "not readable"),
    ("ref", "not readable by the run"),
)
_PLURAL = {"variance": "variances", "ref": "refs"}


async def prompt_lines(db: AsyncSession, occ: RitualOccurrence) -> list[str]:
    """The open variances the run explains, by id, with each metric's id for
    get_metric."""
    rows = await review.open_variances(db, occ.pre_read)
    if not rows:
        return []
    titles = {
        m.id: m.title
        for m in await db.scalars(select(Metric).where(Metric.id.in_({r.metric_id for r in rows})))
    }
    return [
        "The open variances to explain (variance id, metric id, metric, week):",
        *(
            f"- {r.id} · metric {r.metric_id} · {titles.get(r.metric_id, '')} · week of "
            f"{r.week_start.isoformat()}"
            for r in rows
        ),
    ]


def _words(text: str, limit: int = MAX_WORDS) -> str:
    words = text.split()
    return " ".join(words[:limit])


def _uuid(value: Any) -> uuid.UUID | None:
    try:
        return uuid.UUID(str(value))
    except (TypeError, ValueError, AttributeError):
        return None


async def _readable(db: AsyncSession, refs: list[tuple[str, uuid.UUID]], reader) -> set:
    from oracle.decisions.models import Decision
    from oracle.launches.models import ChangelogEntry, Launch
    from oracle.roadmap.draft_items import item_documents
    from oracle.roadmap.models import RoadmapItem
    from oracle.sources.models import Source, SourceItem

    tables = {"launch": Launch, "changelog": ChangelogEntry, "decision": Decision,
              "roadmap_item": RoadmapItem}  # fmt: skip
    out: set[tuple[str, uuid.UUID]] = set()
    for kind, model in tables.items():
        ids = [i for k, i in refs if k == kind]
        if ids:
            found = set(await db.scalars(select(model.id).where(model.id.in_(ids))))
            if kind == "decision":
                found -= await visibility.hidden_decision_ids(db, found, as_member=True)
            elif kind == "roadmap_item" and found:
                docs = await item_documents(db, found)
                hidden = await visibility.hidden_document_ids(db, docs.values(), as_member=True)
                found = {i for i in found if docs.get(i) not in hidden}
            out |= {(kind, i) for i in found}
    items = [i for k, i in refs if k == "source_item"]
    if items and reader is not None:
        found = await db.scalars(
            select(SourceItem.id)
            .join(Source, Source.id == SourceItem.source_id)
            .where(
                SourceItem.id.in_(items),
                SourceItem.deleted_at.is_(None),
                Source.owner_user_id == reader,
            )
        )
        out |= {("source_item", i) for i in found}
    return out


def _notes(drops: Counter[tuple[str, str]]) -> list[str]:
    out = []
    for what, why in _DROPS:
        n = drops[(what, why)]
        if n:
            out.append(f"{n} {what if n == 1 else _PLURAL[what]} dropped ({why})")
    return out


def _parse(text: str) -> list[Any]:
    data = safe_yaml.load(text, limit=MAX_BYTES)
    if not isinstance(data, dict) or data.get("version") != 1:
        raise ValueError(f"{FILE} is not version 1")
    entries = data.get("variances") or []
    if not isinstance(entries, list):
        raise ValueError("variances is not a list")
    return entries


async def import_drafts(
    db: AsyncSession, run: Any, files: dict[str, str], principal: Principal
) -> dict[str, Any]:
    """The ``metrics_variance`` importer: summary.md onto the occurrence (as
    ``ritual_summary``), then each draft onto its variance. Returns ``{drafts, notes}``,
    with ``error`` when a file is missing or unreadable."""
    from oracle.rituals import summaries

    out = await summaries.import_summary(db, run, files, principal)
    occ_id = summaries._occurrence_id(run)
    text = files.get(FILE)
    result: dict[str, Any] = {"drafts": 0, "notes": []}
    if out.get("error"):
        result["error"] = out["error"]
    if occ_id is None:
        return result
    if text is None:
        result.setdefault("error", f"the run left no {FILE}")
        return result
    try:
        entries = await safe_yaml.run_parse_within(_parse, text, name=FILE)
    except (ValueError, safe_yaml.SafeYamlError, safe_yaml.ParseTimeout):
        result.setdefault("error", f"{FILE} could not be read")
        return result
    drops: Counter[tuple[str, str]] = Counter()
    async with tenant_session(current_tenant(db)) as s:
        occ = await s.get(RitualOccurrence, occ_id)
        if occ is None or occ.summary_run_id != run.id:
            return result
        listed = set(review.variance_ids(occ.pre_read))
        wanted: dict[uuid.UUID, dict[str, Any]] = {}
        for entry in entries:
            vid = _uuid(entry.get("id")) if isinstance(entry, dict) else None
            if vid is None:
                drops[("variance", "not readable")] += 1
            elif vid not in listed:
                drops[("variance", "not in this review")] += 1
            elif not isinstance(entry.get("draft"), str) or not entry["draft"].strip():
                drops[("variance", "not readable")] += 1
            else:
                wanted[vid] = entry
        refs: dict[uuid.UUID, list[tuple[str, uuid.UUID]]] = {}
        for vid, entry in wanted.items():
            raw = entry.get("refs") or []
            kept = []
            for ref in raw if isinstance(raw, list) else []:
                kind = ref.get("kind") if isinstance(ref, dict) else None
                rid = _uuid(ref.get("id")) if isinstance(ref, dict) else None
                if kind in REF_KINDS and rid is not None:
                    kept.append((kind, rid))
                else:
                    drops[("ref", "not readable by the run")] += 1
            refs[vid] = kept
        readable = await _readable(s, [r for rs in refs.values() for r in rs], run.created_by)
        rows = {
            r.id: r
            for r in await s.scalars(
                select(MetricVariance).where(MetricVariance.id.in_(list(wanted))).with_for_update()
            )
        }
        for vid, entry in wanted.items():
            row = rows.get(vid)
            if row is None:
                drops[("variance", "not in this review")] += 1
                continue
            kept = [r for r in refs[vid] if r in readable]
            drops[("ref", "not readable by the run")] += len(refs[vid]) - len(kept)
            confidence = entry.get("confidence")
            row.oracle_draft = _words(entry["draft"].strip())
            row.oracle_confidence = confidence if confidence in CONFIDENCES else "low"
            row.oracle_refs = [{"kind": k, "id": str(i)} for k, i in kept]
            row.oracle_run_id = run.id
            row.lock_version += 1
            result["drafts"] += 1
        await s.commit()
    result["notes"] = _notes(drops)
    return result
