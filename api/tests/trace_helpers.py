"""Shared setup for the trace lane tests (oracle/trace): a PRD in two versions, a
baseline chain from a goal down to an acceptance criterion, and stub downstream
artifacts (wave 2 builds the real ones). Synthetic placeholders only."""

import hashlib
import uuid
from dataclasses import dataclass, field

from sqlalchemy import select

from oracle.baseline.models import Edge, Entity, Evidence
from oracle.docs.models import DocumentVersion, Section
from oracle.tenancy import tenant_session
from oracle.v2 import models as m
from tests.baseline_helpers import Ctx

DOC = "saved-addresses"
MARKDOWN = {"Content-Type": "text/markdown"}

PRD_V1 = """---
document: saved-addresses
title: Saved addresses PRD
snapshot: 2026-10-01T09:00Z
citations:
  - id: c1
    source: upload
    ref: buyer-interviews.md
    title: Buyer interviews
    excerpt: "Repeat buyers retype their address at every checkout"
---

# Saved addresses PRD {#title}

## Summary {#summary}

Returning buyers keep their address between checkouts.

## Requirements {#requirements}

Buyers can save up to five addresses and pick one at checkout. [c:c1]

## Metrics {#metrics}

Repeat checkout takes under a minute.

## Risks {#risks}

Stored addresses are personal data.

## Sources and data points {#sources}

Interviews with returning buyers. [c:c1]
"""

PRD_V2 = PRD_V1.replace(
    "Buyers can save up to five addresses and pick one at checkout.",
    "Buyers can save up to ten addresses, name them, and pick one at checkout.",
)


def sha(text: str) -> str:
    return hashlib.sha256(text.encode()).hexdigest()


async def import_md(client, headers, text: str, doc: str = DOC):
    return await client.post(
        f"/v1/documents/{doc}/versions", content=text.encode(), headers={**headers, **MARKDOWN}
    )


async def version_row(tenant_id: uuid.UUID, number: int, doc: str = DOC) -> DocumentVersion:
    from oracle.docs.models import Document

    async with tenant_session(tenant_id) as s:
        return await s.scalar(
            select(DocumentVersion)
            .join(Document, Document.id == DocumentVersion.document_id)
            .where(Document.slug == doc, DocumentVersion.number == number)
        )


async def section_hash(tenant_id: uuid.UUID, version_id: uuid.UUID, key: str) -> str:
    async with tenant_session(tenant_id) as s:
        return await s.scalar(
            select(Section.content_hash).where(
                Section.version_id == version_id, Section.section_key == key
            )
        )


@dataclass
class Chain:
    """goal -> outcome -> feature -> requirement -> acceptance criterion, plus the
    assumption, blocker, decision, risk and owner linked to the requirement."""

    ids: dict[str, uuid.UUID] = field(default_factory=dict)

    def __getitem__(self, key: str) -> uuid.UUID:
        return self.ids[key]


async def seed_chain(tenant_id: uuid.UUID, *, goal_status: str = "confirmed") -> Chain:
    chain = Chain()
    async with tenant_session(tenant_id) as s:
        specs = [
            ("goal", "goal", "repeat-purchase", "More repeat purchases", goal_status),
            ("outcome", "outcome", "faster-repeat-checkout", "Faster repeat checkout", "confirmed"),
            ("feature", "feature", "saved-addresses", "Saved addresses", "confirmed"),
            ("requirement", "requirement", "save-five", "Save up to five addresses", "confirmed"),
            ("ac", "acceptance_criterion", "pick-saved", "Pick a saved address", "confirmed"),
            ("assumption", "assumption", "buyers-reuse", "Buyers reuse addresses", "proposed"),
            ("blocker", "constraint", "address-api-quota", "Address API quota", "confirmed"),
            ("decision", "decision", "store-in-house", "Store addresses in-house", "confirmed"),
            ("risk", "risk", "personal-data", "Personal data exposure", "proposed"),
            ("owner", "person", "pm-placeholder", "Product owner placeholder", "confirmed"),
            ("orphan", "feature", "gift-wrap", "Gift wrap", "proposed"),
        ]
        for name, type_, key, title, status in specs:
            attrs = {}
            if type_ == "constraint":
                attrs = {"blocker": {"type": "hard", "limit_kind": "capacity", "status": "open"}}
            if type_ == "goal":
                attrs = {"weight": 3}
            if type_ == "feature":
                attrs = {"effort": 2, "confidence": 0.8}
            entity = Entity(
                type=type_, key=key, title=title, status=status, origin="user", attrs=attrs,
                locked=name == "requirement",
            )  # fmt: skip
            s.add(entity)
            await s.flush()
            chain.ids[name] = entity.id
        edges = [
            ("outcome", "goal", "derived_from", {}),
            ("feature", "goal", "supports", {"contribution": 3}),
            ("feature", "outcome", "supports", {"contribution": 2}),
            ("requirement", "feature", "part_of", {}),
            ("requirement", "outcome", "derived_from", {}),
            ("ac", "requirement", "verifies", {}),
            ("assumption", "requirement", "affects", {}),
            ("blocker", "requirement", "blocks", {}),
            ("risk", "requirement", "affects", {}),
            ("decision", "risk", "mitigates", {}),
            ("decision", "requirement", "affects", {}),
            ("requirement", "owner", "owned_by", {}),
        ]
        for src, dst, type_, attrs in edges:
            s.add(
                Edge(
                    src_id=chain[src], dst_id=chain[dst], type=type_, attrs=attrs,
                    status="confirmed", origin="user",
                )
            )  # fmt: skip
        s.add(
            Evidence(
                entity_id=chain["feature"], ref="buyer-interviews.md",
                excerpt="Repeat buyers retype their address", confidence=0.8,
            )
        )  # fmt: skip
        option = m.BlockerOption(
            blocker_id=chain["blocker"], title="Cache lookups within the published quota",
            approach="architecture", compliance="compliant",
        )  # fmt: skip
        s.add(option)
        await s.flush()
        s.add(
            m.FeasibilityExperiment(
                blocker_id=chain["blocker"], option_id=option.id,
                hypothesis="Caching halves quota use",
            )
        )  # fmt: skip
        s.add(
            m.AssumptionDecision(
                entity_id=chain["assumption"], statement="Buyers reuse addresses",
                decision="accept_assumption", rationale="Interview signal",
            )
        )  # fmt: skip
        chain.ids["option"] = option.id
        await s.commit()
    return chain


ARTIFACT_KINDS = ("engineering_spec", "wireframe", "prototype", "acceptance_tests")


async def stub_artifact(
    tenant_id: uuid.UUID,
    document_id: uuid.UUID,
    version_id: uuid.UUID,
    *,
    kind: str = "engineering_spec",
    status: str = "approved",
    requirement_ids: list[uuid.UUID] | None = None,
) -> tuple[uuid.UUID, uuid.UUID]:
    """A stub artifact request and version with one output; (request id, version id)."""
    async with tenant_session(tenant_id) as s:
        request = m.ArtifactRequest(
            kind=kind, title=f"Saved addresses {kind.replace('_', ' ')}",
            source_document_id=document_id, source_version_id=version_id,
            requirement_ids=requirement_ids or [], status="succeeded",
        )  # fmt: skip
        s.add(request)
        await s.flush()
        version = m.ArtifactVersion(
            request_id=request.id, number=1, status=status, source_version_id=version_id,
            content_hash=sha(f"{kind} body"), summary=f"Stub {kind}",
            approved_by=uuid.uuid4() if status == "approved" else None,
        )  # fmt: skip
        s.add(version)
        await s.flush()
        s.add(
            m.ArtifactOutput(
                version_id=version.id, name="spec.md", media_type="text/markdown",
                size_bytes=len(f"{kind} body"), sha256=sha(f"{kind} body"),
                content=f"{kind} body",
            )
        )  # fmt: skip
        await s.commit()
        return request.id, version.id


async def depend(
    tenant_id: uuid.UUID,
    *,
    artifact_version_id: uuid.UUID | None = None,
    document_version_id: uuid.UUID | None = None,
    upstream_version_id: uuid.UUID | None = None,
    section_key: str | None = None,
    entity_id: uuid.UUID | None = None,
) -> uuid.UUID:
    """One fresh artifact dependency, anchored at the section's current hash."""
    async with tenant_session(tenant_id) as s:
        hash_ = None
        if upstream_version_id and section_key:
            hash_ = await s.scalar(
                select(Section.content_hash).where(
                    Section.version_id == upstream_version_id, Section.section_key == section_key
                )
            )
        dep = m.ArtifactDependency(
            artifact_version_id=artifact_version_id, document_version_id=document_version_id,
            upstream_version_id=upstream_version_id, upstream_section_key=section_key,
            upstream_section_hash=hash_, upstream_entity_id=entity_id,
        )  # fmt: skip
        s.add(dep)
        await s.commit()
        return dep.id


async def link_section(
    tenant_id: uuid.UUID,
    document_id: uuid.UUID,
    version_id: uuid.UUID,
    section_key: str,
    *,
    entity_id: uuid.UUID | None = None,
    evidence_id: uuid.UUID | None = None,
    source_item_id: uuid.UUID | None = None,
    kind: str = "implements",
    claim: str | None = None,
) -> uuid.UUID:
    async with tenant_session(tenant_id) as s:
        hash_ = await s.scalar(
            select(Section.content_hash).where(
                Section.version_id == version_id, Section.section_key == section_key
            )
        )
        link = m.DocumentSectionLink(
            document_id=document_id, version_id=version_id, section_key=section_key,
            section_hash=hash_, kind=kind, entity_id=entity_id, evidence_id=evidence_id,
            source_item_id=source_item_id, precision="claim" if claim else "section",
            claim=claim,
        )  # fmt: skip
        s.add(link)
        await s.commit()
        return link.id


async def dependency(tenant_id: uuid.UUID, dep_id: uuid.UUID) -> m.ArtifactDependency:
    async with tenant_session(tenant_id) as s:
        return await s.get(m.ArtifactDependency, dep_id)


async def artifact_version(tenant_id: uuid.UUID, version_id: uuid.UUID) -> m.ArtifactVersion:
    async with tenant_session(tenant_id) as s:
        return await s.get(m.ArtifactVersion, version_id)


async def prd_v1(client, ctx: Ctx) -> DocumentVersion:
    resp = await import_md(client, ctx.as_("approver"), PRD_V1)
    assert resp.status_code == 201, resp.text
    return await version_row(ctx.tenant_id, 1)
