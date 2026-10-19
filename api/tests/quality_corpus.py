"""The PRD quality evaluation corpus (tests/fixtures/eval): load a case and seed it.

A case is YAML (see tests/fixtures/eval/README.md). ``extends`` starts from another case;
``overrides`` changes fields of its items by ``ref``, ``remove`` drops items by ``ref`` (and
whatever points at a removed entity), ``add`` appends items. Everything is synthetic.
"""

import copy
import re
import uuid
from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta
from decimal import Decimal
from pathlib import Path
from typing import Any

import yaml

from oracle.baseline.models import Conflict, Edge, Entity, Evidence
from oracle.review.models import Comment, SectionReview
from oracle.tenancy import tenant_session
from oracle.v2 import models as m

CORPUS = Path(__file__).resolve().parent / "fixtures" / "eval"
CASES = CORPUS / "cases"
LISTS = {
    "entities": ("baseline", "entities"),
    "edges": ("baseline", "edges"),
    "evidence": ("baseline", "evidence"),
    "conflicts": ("baseline", "conflicts"),
    "links": ("links",),
    "gaps": ("gaps",),
    "decisions": ("decisions",),
    "blockers": ("blockers",),
    "artifacts": ("artifacts",),
    "reviews": ("reviews",),
}


def case_paths() -> list[Path]:
    return sorted(CASES.glob("*.yaml"))


def _get(case: dict, path: tuple[str, ...]) -> list[dict]:
    node = case
    for key in path[:-1]:
        node = node.setdefault(key, {})
    return node.setdefault(path[-1], [])


def load_case(name: str | Path) -> dict[str, Any]:
    path = Path(name) if isinstance(name, Path) else CASES / f"{name}.yaml"
    raw = yaml.safe_load(path.read_text(encoding="utf-8"))
    if "extends" not in raw:
        case = copy.deepcopy(raw)
    else:
        case = load_case(raw["extends"])
        for key in ("id", "description", "covers", "human_ratings", "model_output"):
            case.pop(key, None)
        for key, value in raw.items():
            if key not in ("extends", "overrides", "remove", "add", "expected", "blocked"):
                case[key] = copy.deepcopy(value)
        for kind, changes in (raw.get("overrides") or {}).items():
            items = {i.get("ref"): i for i in _get(case, LISTS[kind])}
            for ref, fields in changes.items():
                items[ref].update(copy.deepcopy(fields))
        removed = set(raw.get("remove") or [])
        for path in LISTS.values():
            items = _get(case, path)
            items[:] = [
                i
                for i in items
                if i.get("ref") not in removed
                and not removed & {i.get("src"), i.get("dst"), i.get("entity")}
            ]
        for kind, items in _flatten_add(raw.get("add") or {}).items():
            _get(case, LISTS[kind]).extend(copy.deepcopy(items))
        case["expected"] = {**case.get("expected", {}), **(raw.get("expected") or {})}
        if "blocked" in raw:
            case["blocked"] = raw["blocked"]
        case.setdefault("rationale_contains", {})
    case.setdefault("rationale_contains", {})
    case.setdefault("blocked", False)
    return case


def _flatten_add(add: dict) -> dict[str, list]:
    out: dict[str, list] = {}
    for key, value in add.items():
        if key == "baseline":
            out.update(value)
        else:
            out[key] = value
    return out


_HEADING = re.compile(r"^#{1,6}\s")


def markdown_of(case: dict[str, Any]) -> str:
    spec = case["document"]
    if "markdown" in spec:
        return spec["markdown"]
    text = (CORPUS / spec["from"]).read_text(encoding="utf-8")
    lines = text.splitlines()
    for key in spec.get("drop") or []:
        lines = _replace_section(lines, key, None)
    for key, body in (spec.get("replace") or {}).items():
        lines = _replace_section(lines, key, body)
    return "\n".join(lines) + "\n"


def _replace_section(lines: list[str], key: str, body: str | None) -> list[str]:
    start = next(i for i, line in enumerate(lines) if f"{{#{key}}}" in line)
    end = next((i for i in range(start + 1, len(lines)) if _HEADING.match(lines[i])), len(lines))
    if body is None:
        return lines[:start] + lines[end:]
    return lines[: start + 1] + ["", *body.rstrip("\n").splitlines(), ""] + lines[end:]


@dataclass
class SeededCase:
    document_id: uuid.UUID
    version_id: uuid.UUID
    slug: str
    number: int
    refs: dict[str, uuid.UUID] = field(default_factory=dict)


async def import_markdown(client, headers: dict, markdown: str) -> dict:
    slug = re.search(r"^document:\s*(\S+)", markdown, re.M)
    slug = slug.group(1) if slug else "corpus-case"
    resp = await client.post(
        f"/v1/documents/{slug}/versions",
        content=markdown.encode(),
        headers={**headers, "Content-Type": "text/markdown"},
    )
    assert resp.status_code in (200, 201), resp.text
    return {**resp.json(), "slug": slug}


async def seed_case(client, ctx, case: dict[str, Any]) -> SeededCase:
    """Import the case's document as the owner, then seed its baseline and v2 rows."""
    version = await import_markdown(client, ctx.as_("owner"), markdown_of(case))
    owner_id = ctx.users["owner"].id
    seeded = SeededCase(
        document_id=uuid.UUID(version["document_id"]),
        version_id=uuid.UUID(version["id"]),
        slug=version["slug"],
        number=version["number"],
    )
    refs = seeded.refs
    now = datetime.now(UTC)
    baseline = case.get("baseline") or {}
    async with tenant_session(ctx.tenant_id) as s:
        for e in baseline.get("entities") or []:
            row = Entity(
                type=e["type"], key=e["key"], title=e["title"], body=e.get("body"),
                status=e.get("status", "confirmed"), origin="user", attrs=e.get("attrs") or {},
            )  # fmt: skip
            s.add(row)
            await s.flush()
            refs[e["ref"]] = row.id
        for e in baseline.get("edges") or []:
            row = Edge(
                src_id=refs[e["src"]], dst_id=refs[e["dst"]], type=e["type"],
                attrs=e.get("attrs") or {}, status=e.get("status", "confirmed"), origin="user",
            )  # fmt: skip
            s.add(row)
            await s.flush()
            refs[e.get("ref") or f"edge-{row.id}"] = row.id
        for ev in baseline.get("evidence") or []:
            factors = {"freshness": ev["freshness"]} if "freshness" in ev else {}
            row = Evidence(
                entity_id=refs[ev["entity"]], excerpt=ev.get("excerpt"), ref=ev.get("ref"),
                confidence=Decimal(str(ev["confidence"])), confidence_factors=factors,
                retrieved_at=now - timedelta(days=ev.get("age_days", 1)), scored_at=now,
            )  # fmt: skip
            s.add(row)
            await s.flush()
            refs[ev["ref"]] = row.id
        for c in baseline.get("conflicts") or []:
            row = Conflict(
                entity_id=refs[c["entity"]], field=c["field"], claims=c.get("claims") or [],
                material=c.get("material", False), status=c.get("status", "open"),
            )  # fmt: skip
            s.add(row)
            await s.flush()
            refs[c["ref"]] = row.id

        for b in case.get("blockers") or []:
            attrs: dict[str, Any] = {"blocker": b["blocker"]}
            if "third_party" in b:
                attrs["third_party"] = b["third_party"]
            row = Entity(
                type="constraint", key=b["key"], title=b["title"], status="confirmed",
                origin="user", attrs=attrs,
            )  # fmt: skip
            s.add(row)
            await s.flush()
            refs[b["ref"]] = row.id
            for section in b.get("links") or []:
                s.add(
                    m.DocumentSectionLink(
                        document_id=seeded.document_id, version_id=seeded.version_id,
                        section_key=section, kind="mentions", entity_id=row.id,
                    )
                )  # fmt: skip
            for o in b.get("options") or []:
                s.add(
                    m.BlockerOption(
                        blocker_id=row.id, title=o["title"], approach=o["approach"],
                        compliance=o.get("compliance", "needs_review"),
                        status=o.get("status", "proposed"),
                        technical_feasibility=o.get("technical_feasibility", "unknown"),
                        policy_feasibility=o.get("policy_feasibility", "unknown"),
                    )
                )  # fmt: skip
            for x in b.get("experiments") or []:
                s.add(
                    m.FeasibilityExperiment(
                        blocker_id=row.id, hypothesis=x["hypothesis"],
                        status=x.get("status", "planned"), success_threshold=x.get("threshold"),
                    )
                )  # fmt: skip
        await s.flush()

        for link in case.get("links") or []:
            s.add(
                m.DocumentSectionLink(
                    document_id=seeded.document_id, version_id=seeded.version_id,
                    section_key=link["section"], kind=link.get("kind", "implements"),
                    entity_id=refs[link["entity"]], precision=link.get("precision", "section"),
                    claim=link.get("claim"),
                )
            )  # fmt: skip
        for g in case.get("gaps") or []:
            s.add(
                m.KnowledgeGap(
                    document_id=seeded.document_id, category=g["category"],
                    statement=g["statement"], importance=g.get("importance", "medium"),
                    status=g.get("status", "unknown"),
                    knowledge_state=g.get("knowledge_state", "unknown"),
                    owner_id=owner_id if g.get("owned", True) else None,
                )
            )  # fmt: skip
        for d in case.get("decisions") or []:
            s.add(
                m.AssumptionDecision(
                    document_id=seeded.document_id, entity_id=refs.get(d.get("entity")),
                    statement=d["statement"], decision=d.get("decision", "accept_risk"),
                    rationale=d.get("rationale", "Synthetic decision"), decided_by=owner_id,
                )
            )  # fmt: skip
        for a in case.get("artifacts") or []:
            request = m.ArtifactRequest(
                kind=a.get("kind", "engineering_spec"), title=a["title"],
                source_document_id=seeded.document_id, source_version_id=seeded.version_id,
                section_keys=[a["section"]], status="succeeded",
            )  # fmt: skip
            s.add(request)
            await s.flush()
            av = m.ArtifactVersion(
                request_id=request.id, number=1, source_version_id=seeded.version_id,
                freshness=a.get("freshness", "fresh"), status=a.get("status", "approved"),
            )  # fmt: skip
            s.add(av)
            await s.flush()
            s.add(
                m.ArtifactDependency(
                    artifact_version_id=av.id, upstream_version_id=seeded.version_id,
                    upstream_section_key=a["section"], freshness=a.get("freshness", "fresh"),
                    stale_since=now if a.get("freshness") == "potentially_stale" else None,
                )
            )  # fmt: skip
        for r in case.get("reviews") or []:
            if "comment" in r:
                s.add(
                    Comment(
                        version_id=seeded.version_id, section_key=r["section"],
                        body=r["comment"], author_id=ctx.users["commenter"].id,
                    )
                )  # fmt: skip
            if "verdict" in r:
                s.add(
                    SectionReview(
                        version_id=seeded.version_id, section_key=r["section"],
                        verdict=r["verdict"], reviewer_id=ctx.users["approver"].id,
                    )
                )  # fmt: skip
        await s.commit()
    return seeded
