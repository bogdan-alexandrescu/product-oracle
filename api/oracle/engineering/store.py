"""Registering a run's tech briefs as ``tech_brief`` artifacts (F5-1).

When the run's PRD exists, each feature's brief of an Engineering check segment's
``tech_briefs.yaml`` becomes one artifact:

- at the Engineering check's Approve for an existing PRD (:func:`on_checkpoint_approved`,
  ``source_version_id`` null: the run's draft does not exist yet);
- else with the ``prd_draft`` import, in its transaction (:func:`on_draft_imported`,
  called by :func:`oracle.docs.service.import_draft`), which also fills in
  ``source_version_id`` of briefs registered at the approval.

Rows: ``artifact_requests`` (kind ``tech_brief``, the feature title, the PRD, the
feature's requirements, ``params = {feature_key, run_id, segment_seq}``), one
``artifact_versions`` row (number 1, ``approved`` when the check was approved, by its
decider), outputs ``brief.json`` and ``brief.md``, and ``artifact_dependencies`` on the
feature and its requirements (oracle.trace marks the brief potentially stale when they
change). Registration is idempotent per run, segment and feature.

The Engineering check records the lead's verdicts and answers on its checkpoint, before
Approve (F4)::

    payload["briefs"] = {"verdicts": {<feature>: {"value", "note"}},
                         "answers": {<feature>: [{"question_id", "answer"}]}}

A feature without a recorded verdict gets the check's approval (``value`` null, the
approval's note).
"""

import dataclasses
import hashlib
import json
import logging
import uuid
from collections.abc import Collection
from datetime import datetime
from typing import Any

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from oracle import audit, safe_yaml
from oracle.auth.deps import Principal
from oracle.baseline.models import Edge, Entity
from oracle.docs.models import Document, DocumentVersion
from oracle.engineering import briefs
from oracle.runs.models import Checkpoint, Run, RunSegment
from oracle.v2.models import ArtifactOutput, ArtifactRequest, ArtifactVersion

log = logging.getLogger(__name__)

KIND = "tech_brief"


def _sha(text: str) -> str:
    return hashlib.sha256(text.encode()).hexdigest()


def _iso(at: datetime | None) -> str | None:
    return at.isoformat() if at else None


def _files(segment: RunSegment) -> dict[str, str]:
    return (segment.artifacts or {}).get("files") or {}


async def _checkpoint_of(db: AsyncSession, run_id: uuid.UUID, seq: int) -> Checkpoint | None:
    """The segment's latest checkpoint (a rerun opens a new one)."""
    rows = (
        await db.scalars(
            select(Checkpoint)
            .where(Checkpoint.run_id == run_id)
            .order_by(Checkpoint.created_at.desc(), Checkpoint.id)
        )
    ).all()
    return next((c for c in rows if (c.payload or {}).get("segment_seq") == seq), None)


async def _feature(db: AsyncSession, key: str) -> Entity | None:
    return await db.scalar(
        select(Entity)
        .where(Entity.type == "feature", Entity.key == key)
        .order_by(Entity.created_at)
        .limit(1)
    )


async def _requirements(db: AsyncSession, feature_id: uuid.UUID) -> list[uuid.UUID]:
    """The feature's requirements: entities ``part_of`` it, not rejected."""
    return list(
        await db.scalars(
            select(Entity.id)
            .join(Edge, Edge.src_id == Entity.id)
            .where(
                Edge.dst_id == feature_id,
                Edge.type == "part_of",
                Edge.status != "rejected",
                Entity.type == "requirement",
                Entity.status != "rejected",
            )
            .order_by(Entity.key)
        )
    )


@dataclasses.dataclass(frozen=True)
class Decided:
    """What an approved Engineering check recorded, read off its checkpoint as plain data
    (:func:`prepare` uses it on the parse pool)."""

    recorded: dict[str, Any]
    by: str | None
    note: str | None
    at: str | None


def _decided(cp: Checkpoint | None) -> Decided | None:
    if cp is None or cp.status != "approved":
        return None
    recorded = (cp.payload or {}).get("briefs")
    return Decided(
        recorded=recorded if isinstance(recorded, dict) else {},
        by=str(cp.decided_by) if cp.decided_by else None,
        note=cp.note,
        at=_iso(cp.decided_at),
    )


def _str(value: Any) -> str | None:
    return value if isinstance(value, str) else None


def _of(recorded: dict[str, Any], name: str, key: str) -> Any:
    by_feature = recorded.get(name)
    return by_feature.get(key) if isinstance(by_feature, dict) else None


def _decisions(decided: Decided | None, key: str) -> tuple[dict[str, Any] | None, list[dict]]:
    """(verdict, answers) for a feature: recorded on an approved check, else none. The
    payload is written by a screen: a value that is not text is dropped (a verdict's
    value or note left out, an answer or question id that is not text skips the answer)."""
    if decided is None:
        return None, []
    v = _of(decided.recorded, "verdicts", key)
    v = v if isinstance(v, dict) else {}
    verdict = {
        "value": _str(v.get("value")),
        "note": _str(v.get("note")) or decided.note,
        "by": decided.by,
        "at": decided.at,
    }
    listed = _of(decided.recorded, "answers", key)
    answers = [
        {
            "question_id": a["question_id"],
            "answer": a["answer"],
            "by": _str(a.get("by")) or decided.by,
        }
        for a in (listed if isinstance(listed, list) else [])
        if isinstance(a, dict)
        and isinstance(a.get("question_id"), str)
        and isinstance(a.get("answer"), str)
    ]
    return verdict, answers


@dataclasses.dataclass(frozen=True)
class Prepared:
    """A feature's brief ready to store: its ``brief.json`` and ``brief.md``."""

    entry: briefs.Brief
    body: str
    markdown: str
    verdict: dict[str, Any] | None
    answers: list[dict[str, Any]]


@dataclasses.dataclass(frozen=True)
class Against:
    """What a brief is checked against when no one checked it (the Engineering check
    turned off): the feature set's keys and the ids of the code map the run used (None:
    no code map was available to the run)."""

    feature_keys: frozenset[str]
    code_map: frozenset[str] | None


# The problems that refuse an unchecked brief (the file's shape is refused whole).
REFUSING = ("unknown_feature", "unknown_ref")


def _prepare(
    text: str,
    decided: Decided | None,
    skip: Collection[str] = (),
    against: Against | None = None,
    partial: Collection[str] = (),
) -> tuple[briefs.TechBriefs, list[Prepared]]:
    """Parse ``text`` once and render the briefs of the features not in ``skip``; with
    ``against``, also not those :data:`REFUSING` refuses. ``partial``: the repos (lower
    case) whose map the run used was built from the docs only. Untrusted text:
    :func:`prepare` runs this on the parse pool."""
    if against is None:
        parsed = briefs.parse(text)
    else:
        parsed, problems = briefs.parse_checked(text, against.feature_keys, against.code_map)
        refused = {p.feature for p in problems if p.code in REFUSING}
        if refused:
            log.warning("%s: briefs refused: %s", briefs.FILE, "; ".join(
                p.message for p in problems if p.code in REFUSING))  # fmt: skip
        skip = {*skip, *refused}
    for repo in parsed.code_map.repos:
        repo.partial = parsed.code_map.used and repo.repo.lower() in partial
    out = []
    for entry in parsed.features:
        if entry.feature in skip:
            continue
        verdict, answers = _decisions(decided, entry.feature)
        body = json.dumps(
            {
                **entry.model_dump(),
                "code_map": parsed.code_map.model_dump(),
                "verdict": verdict,
                "answers": answers,
            },
            indent=2,
        )
        markdown = briefs.render_markdown(entry, parsed.code_map, verdict=verdict, answers=answers)
        out.append(Prepared(entry, body, markdown, verdict, answers))
    return parsed, out


async def prepare(
    text: str,
    decided: Decided | None,
    skip: Collection[str] = (),
    against: Against | None = None,
    partial: Collection[str] = (),
) -> tuple[briefs.TechBriefs, list[Prepared]]:
    """:func:`_prepare` on the parse pool (:func:`oracle.safe_yaml.run_parse_within`), at
    most ``PARSE_SECONDS``: the event loop never parses or renders the briefs. Raises
    :class:`briefs.BriefsInvalid` or :class:`oracle.safe_yaml.ParseTimeout`."""
    return await safe_yaml.run_parse_within(
        _prepare, text, decided, skip, against, frozenset(partial), name=briefs.FILE
    )


async def _against(db: AsyncSession, run: Run, cp: Checkpoint | None) -> Against | None:
    """What to check the briefs against when the Engineering check was turned off, else
    None (the lead checked them). The feature set: the baseline's features not rejected.
    The code map: the ids of the shared maps the run recorded as it started (F5-2,
    :func:`oracle.engineering.codemaps.recorded_ids`); None when it recorded none, so any
    ref of an unchecked brief is unknown_ref."""
    from oracle.engineering import codemaps

    if cp is None or cp.status != "skipped":
        return None
    keys = await db.scalars(
        select(Entity.key).where(Entity.type == "feature", Entity.status != "rejected")
    )
    return Against(frozenset(keys), await codemaps.recorded_ids(db, run))


async def _partial(db: AsyncSession, run: Run) -> frozenset[str]:
    """The repos (lower case) whose map the run used was built from the docs only."""
    from oracle.engineering import codemaps

    return frozenset(
        m.repo.lower() for m in await codemaps.recorded(db, run) if (m.content or {}).get("partial")
    )


async def _existing(db: AsyncSession, run_id: uuid.UUID, seq: int) -> dict[str, ArtifactRequest]:
    rows = (
        await db.scalars(
            select(ArtifactRequest).where(
                ArtifactRequest.kind == KIND, ArtifactRequest.run_id == run_id
            )
        )
    ).all()
    return {
        r.params.get("feature_key"): r for r in rows if (r.params or {}).get("segment_seq") == seq
    }


async def _register(
    db: AsyncSession,
    principal: Principal,
    run: Run,
    segment: RunSegment,
    cp: Checkpoint | None,
    document: Document,
    version: DocumentVersion | None,
) -> list[ArtifactVersion]:
    from oracle.trace import staleness
    from oracle.trace.schemas import TraceUpstreamRef

    text = _files(segment).get(briefs.FILE)
    if text is None:
        return []
    existing = await _existing(db, run.id, segment.seq)
    try:
        parsed, fresh = await prepare(
            text,
            _decided(cp),
            frozenset(existing),
            await _against(db, run, cp),
            await _partial(db, run),
        )
    except (briefs.BriefsInvalid, safe_yaml.ParseTimeout) as exc:
        # The Engineering check shows the file's problems; nothing is registered.
        log.warning("run %s: %s not registered: %s", run.id, briefs.FILE, exc)
        return []
    approved = cp is not None and cp.status == "approved"
    repos = [r.model_dump() for r in parsed.code_map.repos]
    out: list[ArtifactVersion] = []
    if version is not None:
        for request in existing.values():
            if request.source_version_id is not None:
                continue
            request.source_version_id = version.id
            for av in await db.scalars(
                select(ArtifactVersion).where(ArtifactVersion.request_id == request.id)
            ):
                av.source_version_id = av.source_version_id or version.id
    for item in fresh:
        entry, body, markdown = item.entry, item.body, item.markdown
        verdict, answers = item.verdict, item.answers
        feature = await _feature(db, entry.feature)
        requirement_ids = await _requirements(db, feature.id) if feature else []
        request = ArtifactRequest(
            kind=KIND,
            title=entry.title,
            source_document_id=document.id,
            source_version_id=version.id if version else None,
            requirement_ids=requirement_ids,
            params={
                "feature_key": entry.feature,
                "run_id": str(run.id),
                "segment_seq": segment.seq,
            },
            status="succeeded",
            run_id=run.id,
            requested_by=run.created_by,
        )
        db.add(request)
        await db.flush()
        av = ArtifactVersion(
            request_id=request.id,
            number=1,
            status="approved" if approved else "draft",
            source_version_id=version.id if version else None,
            content_hash=_sha(body),
            summary=entry.approach[:500],
            provenance={
                "run_id": str(run.id),
                "segment_seq": segment.seq,
                "code_map": repos,
                "verdict": verdict,
                "size": entry.size,
                "answers": answers,
            },
            created_by=run.created_by,
            approved_by=cp.decided_by if approved and cp else None,
            approved_at=cp.decided_at if approved and cp else None,
        )
        db.add(av)
        await db.flush()
        for name, media_type, content in (
            ("brief.json", "application/json", body),
            ("brief.md", "text/markdown", markdown),
        ):
            db.add(
                ArtifactOutput(
                    version_id=av.id,
                    name=name,
                    media_type=media_type,
                    size_bytes=len(content.encode()),
                    sha256=_sha(content),
                    content=content,
                )
            )
        upstream = [TraceUpstreamRef(entity_id=i) for i in ([feature.id] if feature else [])]
        upstream += [TraceUpstreamRef(entity_id=i) for i in requirement_ids]
        if upstream:
            await staleness.add_dependencies(
                db, principal, artifact_version_id=av.id, document_version_id=None,
                upstream=upstream,
            )  # fmt: skip
        await audit.record(
            db,
            principal,
            "tech_brief.registered",
            "artifact_version",
            av.id,
            {
                "run_id": str(run.id),
                "segment_seq": segment.seq,
                "feature_key": entry.feature,
                "document_id": str(document.id),
                "status": av.status,
            },
        )
        out.append(av)
    await db.flush()
    return out


async def on_checkpoint_approved(
    db: AsyncSession, principal: Principal, run: Run, cp: Checkpoint, segment: RunSegment
) -> list[ArtifactVersion]:
    """At an approved checkpoint whose segment wrote tech_briefs.yaml: register the
    briefs when the run's PRD already exists (the caller commits)."""
    if briefs.FILE not in _files(segment) or run.document_id is None:
        return []
    document = await db.get(Document, run.document_id)
    if document is None or document.kind != "prd":
        return []
    has_version = await db.scalar(
        select(DocumentVersion.id).where(DocumentVersion.document_id == document.id).limit(1)
    )
    if has_version is None:
        return []
    return await _register(db, principal, run, segment, cp, document, None)


async def on_draft_imported(
    db: AsyncSession,
    principal: Principal,
    run_id: uuid.UUID,
    document: Document,
    version: DocumentVersion,
) -> list[ArtifactVersion]:
    """With a run's PRD draft import (in its transaction; the caller commits): register
    the run's briefs not yet registered and give those registered at the approval this
    draft version. Only briefs whose check was approved, or turned off, are registered;
    with the check off, not a brief with an unknown_feature or unknown_ref problem."""
    if document.kind != "prd":
        return []
    run = await db.get(Run, run_id)
    if run is None:
        return []
    segments = (
        await db.scalars(
            select(RunSegment).where(RunSegment.run_id == run_id).order_by(RunSegment.seq)
        )
    ).all()
    out: list[ArtifactVersion] = []
    for segment in segments:
        if briefs.FILE not in _files(segment):
            continue
        cp = await _checkpoint_of(db, run_id, segment.seq)
        if cp is None or cp.status not in ("approved", "skipped"):
            continue
        out += await _register(db, principal, run, segment, cp, document, version)
    return out
