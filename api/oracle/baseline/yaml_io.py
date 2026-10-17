"""The whole graph as YAML: export, and an import that respects locks.

    version: 1
    entities:
      - type: goal
        key: activation
        title: Raise activation
        status: confirmed
        attrs: {metric: activated accounts, target: "40%", horizon: short, weight: 3}
        evidence:
          - url: https://notes.example.com/okrs
            ref: Company goals
            excerpt: Activation is the first goal this half.
    edges:
      - src: feature:guided-setup
        dst: goal:activation
        type: supports
        attrs: {contribution: 3}
        evidence: []

Entities are matched by (type, key) and edges by (src, dst, type), so importing the
same file twice changes nothing. Items not in the file are left alone. Writes are
``import`` writes: a locked item that would change gets a proposal instead, and a
goal never becomes confirmed through an import (it lands proposed; an approver
confirms it). Evidence is matched by (url, ref, excerpt) on its item; a
``source_item`` id is exported and honoured only for the caller's own items.
"""

import uuid
from datetime import datetime
from typing import Any

import yaml
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from oracle.auth.deps import Principal
from oracle.baseline import scoring, service
from oracle.baseline.models import EDGE_TYPES, ENTITY_TYPES, NODE_STATUSES, Edge, Entity, Evidence
from oracle.baseline.schemas import ImportIssue, YamlImportResult
from oracle.sources.models import Source, SourceItem

FORMAT_VERSION = 1


class YamlInvalid(Exception):
    def __init__(self, problems: list[ImportIssue]):
        super().__init__(f"{len(problems)} problem(s)")
        self.problems = problems


def _ref(e: Entity) -> str:
    return f"{e.type}:{e.key}"


async def _own_item_ids(db: AsyncSession, principal: Principal) -> set[uuid.UUID]:
    if principal.user_id is None:
        return set()
    rows = await db.scalars(
        select(SourceItem.id)
        .join(Source, Source.id == SourceItem.source_id)
        .where(Source.owner_user_id == principal.user_id)
    )
    return set(rows.all())


def _evidence_out(ev: Evidence, own: set[uuid.UUID]) -> dict[str, Any]:
    out: dict[str, Any] = {}
    for f in ("url", "ref", "excerpt"):
        if getattr(ev, f):
            out[f] = getattr(ev, f)
    if ev.retrieved_at:
        out["retrieved_at"] = ev.retrieved_at.isoformat()
    if ev.source_item_id and ev.source_item_id in own:
        out["source_item"] = str(ev.source_item_id)
    return out


async def export(db: AsyncSession, principal: Principal) -> str:
    entities = (await db.scalars(select(Entity).order_by(Entity.type, Entity.key))).all()
    edges = (await db.scalars(select(Edge).order_by(Edge.type, Edge.created_at))).all()
    evidence = (await db.scalars(select(Evidence).order_by(Evidence.created_at))).all()
    own = await _own_item_ids(db, principal)
    by_target: dict[uuid.UUID, list[dict]] = {}
    for ev in evidence:
        by_target.setdefault(ev.entity_id or ev.edge_id, []).append(_evidence_out(ev, own))
    refs = {e.id: _ref(e) for e in entities}

    def entity_doc(e: Entity) -> dict[str, Any]:
        doc: dict[str, Any] = {"type": e.type, "key": e.key, "title": e.title}
        if e.body:
            doc["body"] = e.body
        doc["status"] = e.status
        if e.attrs:
            doc["attrs"] = dict(e.attrs)
        if e.locked:
            doc["locked"] = True
        if by_target.get(e.id):
            doc["evidence"] = by_target[e.id]
        return doc

    def edge_doc(e: Edge) -> dict[str, Any]:
        doc: dict[str, Any] = {"src": refs[e.src_id], "dst": refs[e.dst_id], "type": e.type}
        if e.attrs:
            doc["attrs"] = dict(e.attrs)
        doc["status"] = e.status
        if e.locked:
            doc["locked"] = True
        if by_target.get(e.id):
            doc["evidence"] = by_target[e.id]
        return doc

    data = {
        "version": FORMAT_VERSION,
        "entities": [entity_doc(e) for e in entities],
        "edges": [edge_doc(e) for e in edges],
    }
    return yaml.safe_dump(data, sort_keys=False, allow_unicode=True, width=100)


# --- import ---------------------------------------------------------------------------------


def _parse(text: str) -> dict[str, Any]:
    try:
        data = yaml.safe_load(text)
    except yaml.YAMLError as e:
        raise YamlInvalid([ImportIssue(code="invalid_yaml", message=str(e))]) from None
    if data is None:
        data = {}
    if not isinstance(data, dict):
        raise YamlInvalid([ImportIssue(code="invalid_yaml", message="expected a mapping")])
    return data


def _validate(data: dict[str, Any]) -> list[ImportIssue]:
    problems: list[ImportIssue] = []

    def bad(code: str, message: str, where: str) -> None:
        problems.append(ImportIssue(code=code, message=message, where=where))

    if data.get("version", FORMAT_VERSION) != FORMAT_VERSION:
        bad("unsupported_version", f"version must be {FORMAT_VERSION}", "version")
    entities = data.get("entities") or []
    edges = data.get("edges") or []
    if not isinstance(entities, list) or not isinstance(edges, list):
        bad("invalid_shape", "entities and edges must be lists", "")
        return problems
    seen: set[str] = set()
    for i, e in enumerate(entities):
        where = f"entities[{i}]"
        if not isinstance(e, dict):
            bad("invalid_shape", "an entity must be a mapping", where)
            continue
        if e.get("type") not in ENTITY_TYPES:
            bad("invalid_type", f"type must be one of {', '.join(ENTITY_TYPES)}", where)
        if not isinstance(e.get("key"), str) or not e.get("key"):
            bad("missing_key", "key is required", where)
        if not isinstance(e.get("title"), str) or not e.get("title"):
            bad("missing_title", "title is required", where)
        if e.get("status") is not None and e["status"] not in NODE_STATUSES:
            bad("invalid_status", f"status must be one of {', '.join(NODE_STATUSES)}", where)
        if e.get("attrs") is not None and not isinstance(e["attrs"], dict):
            bad("invalid_attrs", "attrs must be a mapping", where)
        ref = f"{e.get('type')}:{e.get('key')}"
        if ref in seen:
            bad("duplicate_entity", f"{ref} appears twice", where)
        seen.add(ref)
        problems += _validate_evidence(e.get("evidence"), where)
    for i, e in enumerate(edges):
        where = f"edges[{i}]"
        if not isinstance(e, dict):
            bad("invalid_shape", "an edge must be a mapping", where)
            continue
        if e.get("type") not in EDGE_TYPES:
            bad("invalid_type", f"type must be one of {', '.join(EDGE_TYPES)}", where)
        for end in ("src", "dst"):
            if not isinstance(e.get(end), str) or ":" not in e[end]:
                bad("invalid_ref", f"{end} must be '<type>:<key>'", where)
        if e.get("status") is not None and e["status"] not in NODE_STATUSES:
            bad("invalid_status", f"status must be one of {', '.join(NODE_STATUSES)}", where)
        if e.get("attrs") is not None and not isinstance(e["attrs"], dict):
            bad("invalid_attrs", "attrs must be a mapping", where)
        problems += _validate_evidence(e.get("evidence"), where)
    return problems


def _validate_evidence(evidence: Any, where: str) -> list[ImportIssue]:
    if evidence is None:
        return []
    if not isinstance(evidence, list):
        return [
            ImportIssue(code="invalid_evidence", message="evidence must be a list", where=where)
        ]
    problems = []
    for j, ev in enumerate(evidence):
        if not isinstance(ev, dict) or not (ev.get("url") or ev.get("ref") or ev.get("excerpt")):
            problems.append(
                ImportIssue(
                    code="invalid_evidence",
                    message="evidence needs a url, ref or excerpt",
                    where=f"{where}.evidence[{j}]",
                )
            )
    return problems


def _when(value: Any) -> datetime | None:
    if isinstance(value, datetime):
        return value
    if isinstance(value, str):
        try:
            return datetime.fromisoformat(value)
        except ValueError:
            return None
    return None


async def _import_evidence(
    db: AsyncSession,
    items: list[dict] | None,
    own: set[uuid.UUID],
    result: YamlImportResult,
    *,
    entity_id: uuid.UUID | None = None,
    edge_id: uuid.UUID | None = None,
) -> bool:
    if not items:
        return False
    stmt = select(Evidence).where(
        Evidence.entity_id == entity_id if entity_id else Evidence.edge_id == edge_id
    )
    existing = {(e.url, e.ref, e.excerpt) for e in (await db.scalars(stmt)).all()}
    added = False
    for ev in items:
        sig = (ev.get("url"), ev.get("ref"), ev.get("excerpt"))
        if sig in existing:
            continue
        item_id = None
        if ev.get("source_item"):
            try:
                candidate = uuid.UUID(str(ev["source_item"]))
            except ValueError:
                candidate = None
            if candidate in own:
                item_id = candidate
        db.add(
            Evidence(
                entity_id=entity_id,
                edge_id=edge_id,
                source_item_id=item_id,
                url=sig[0],
                ref=sig[1],
                excerpt=sig[2],
                retrieved_at=_when(ev.get("retrieved_at")),
            )
        )
        existing.add(sig)
        result.evidence_added += 1
        added = True
    return added


def _count(result: YamlImportResult, write: service.WriteResult, changed: bool) -> None:
    if write.proposal is not None:
        result.proposals += 1
    elif changed:
        result.updated += 1
    else:
        result.unchanged += 1


async def import_yaml(
    db: AsyncSession, principal: Principal, text: str, run_id: uuid.UUID | None = None
) -> YamlImportResult:
    data = _parse(text)
    problems = _validate(data)
    if problems:
        raise YamlInvalid(problems)
    writer = service.Writer(principal, "import", run_id=run_id, reason="YAML import")
    own = await _own_item_ids(db, principal)
    result = YamlImportResult()
    by_ref: dict[str, Entity] = {_ref(e): e for e in (await db.scalars(select(Entity))).all()}

    for i, doc in enumerate(data.get("entities") or []):
        ref = f"{doc['type']}:{doc['key']}"
        status = doc.get("status")
        entity = by_ref.get(ref)
        if (
            doc["type"] == "goal"
            and status == "confirmed"
            and (entity is None or entity.status != "confirmed")
        ):
            status = "proposed" if entity is None else None
            result.notes.append(
                ImportIssue(
                    code="goal_needs_confirmation",
                    message=f"{ref} is not confirmed here; an approver confirms goals",
                    where=f"entities[{i}]",
                )
            )
        try:
            if entity is None:
                write = await service.create_entity(
                    db,
                    writer,
                    type_=doc["type"],
                    key=doc["key"],
                    title=doc["title"],
                    body=doc.get("body"),
                    attrs=doc.get("attrs") or {},
                    status=status,
                )
                entity = by_ref[ref] = write.entity
                result.created += 1
            else:
                # The file states the full attrs: keys it drops are removed.
                attrs = doc.get("attrs") or {}
                attrs_patch = {**dict.fromkeys(entity.attrs or {}), **attrs}
                changes = {"title": doc["title"], "body": doc.get("body"), "attrs": attrs_patch}
                if status is not None:
                    changes["status"] = status
                changed = bool(service._entity_changes(entity, changes))
                write = await service.update_entity(db, writer, entity, changes)
                _count(result, write, changed)
        except service.BaselineError as e:
            raise YamlInvalid(
                [ImportIssue(code="rejected", message=str(e), where=f"entities[{i}]")]
            ) from None
        await _import_evidence(db, doc.get("evidence"), own, result, entity_id=entity.id)

    for i, doc in enumerate(data.get("edges") or []):
        where = f"edges[{i}]"
        src, dst = by_ref.get(doc["src"]), by_ref.get(doc["dst"])
        if src is None or dst is None:
            missing = doc["src"] if src is None else doc["dst"]
            raise YamlInvalid([ImportIssue(code="unknown_ref", message=missing, where=where)])
        attrs = doc.get("attrs") or {}
        try:
            edge = await service.find_edge(db, src.id, dst.id, doc["type"])
            if edge is None:
                write = await service.create_edge(
                    db,
                    writer,
                    src_id=src.id,
                    dst_id=dst.id,
                    type_=doc["type"],
                    attrs=attrs,
                    status=doc.get("status"),
                )
                edge = write.edge
                result.created += 1
            else:
                changes = {"attrs": {**dict.fromkeys(edge.attrs or {}), **attrs}}
                if doc.get("status"):
                    changes["status"] = doc["status"]
                before = (dict(edge.attrs or {}), edge.status)
                write = await service.update_edge(db, writer, edge, changes)
                after = (
                    service.merge_attrs(before[0], changes["attrs"]),
                    changes.get("status", before[1]),
                )
                _count(result, write, after != before)
        except service.BaselineError as e:
            raise YamlInvalid([ImportIssue(code="rejected", message=str(e), where=where)]) from None
        await _import_evidence(db, doc.get("evidence"), own, result, edge_id=edge.id)

    await db.flush()
    await scoring.rescore_all(db)
    return result
