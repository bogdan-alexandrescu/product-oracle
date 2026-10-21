"""Shared setup for the H4 Strategy and vision tests: synthetic strategy and vision
drafts, a small goal graph, a roadmap version with items, and the routes' calls."""

import json
import uuid
from typing import Any

from sqlalchemy import select

from oracle.baseline.models import Edge, Entity
from oracle.docs.models import Document, DocumentVersion
from oracle.roadmap.models import ProductTrack, RoadmapItem
from oracle.tenancy import tenant_session
from tests.baseline_helpers import Ctx
from tests.fixtures import MARKDOWN

STRATEGY = "product-strategy"
VISION = "vision"


def _flow(value: Any) -> str:
    return json.dumps(value)


def choice(
    id_: str,
    stance: str = "focus",
    *,
    goals: list[str] | None = None,
    features: list[str] | None = None,
    title: str | None = None,
) -> dict[str, Any]:
    out: dict[str, Any] = {"id": id_, "title": title or id_.replace("-", " ").title(),
                           "stance": stance}  # fmt: skip
    if goals is not None:
        out["goals"] = goals
    if features is not None:
        out["features"] = features
    return out


def strategy_md(
    choices: list[dict[str, Any]],
    *,
    slug: str = STRATEGY,
    review_on: str | None = "2027-11-01",
    without_sections: tuple[str, ...] = (),
    summary: str = "Win self-serve teams first; stop custom enterprise work.",
) -> str:
    """A product strategy draft: one ``{#choice-<id>}`` section per choice under Focus
    or Stop, except the ids in ``without_sections``."""
    fm = [
        "---",
        f"document: {slug}",
        'title: "Product strategy"',
        "kind: strategy",
        "brief: [summary, focus, stop]",
        "horizon: {from: 2026-11-01, to: 2027-12-31}",
    ]
    if review_on:
        fm.append(f"review_on: {review_on}")
    fm.append("choices:")
    fm += [f"  - {_flow(c)}" for c in choices]
    fm.append("---")

    def sections(stance: str) -> list[str]:
        out = []
        for c in choices:
            if c["stance"] != stance or c["id"] in without_sections:
                continue
            out += [f"### {c['title']} {{#choice-{c['id']}}}", "", f"Why {c['title']}.", ""]
        return out

    body = [
        "",
        "# Product strategy {#title}",
        "",
        "## Strategy in one paragraph {#summary}",
        "",
        summary,
        "",
        "## Focus {#focus}",
        "",
        "The few problems that matter now.",
        "",
        *sections("focus"),
        "## What we stop or won't do {#stop}",
        "",
        "What we stop.",
        "",
        *sections("stop"),
        "# Full version {#full}",
        "",
        "## Insights {#insights}",
        "",
        "From data and customers.",
        "",
        "## Sources and data points {#sources}",
        "",
        "None yet.",
        "",
    ]
    return "\n".join(fm + body)


def belief(id_: str, statement: str, status: str = "untested") -> dict[str, str]:
    return {"id": id_, "statement": statement, "status": status}


def vision_md(
    beliefs: list[dict[str, str]],
    *,
    slug: str = VISION,
    headline: str = "Every small team plans like a large one.",
    review_on: str | None = "2031-11-01",
) -> str:
    fm = [
        "---",
        f"document: {slug}",
        'title: "Vision"',
        "kind: vision",
        "brief: [headline, future, for-whom, beliefs]",
        "horizon_years: 5",
    ]
    if review_on:
        fm.append(f"review_on: {review_on}")
    fm.append("beliefs:")
    fm += [f"  - {_flow(b)}" for b in beliefs]
    fm.append("---")
    body = [
        "",
        "# Vision {#title}",
        "",
        "## Headline {#headline}",
        "",
        headline,
        "",
        "## The future we see {#future}",
        "",
        "A narrative.",
        "",
        "## Who it is for {#for-whom}",
        "",
        "Small product teams.",
        "",
        "## What we believe {#beliefs}",
        "",
        *[f"- {b.get('statement', '')}" for b in beliefs],
        "",
        "# Full version {#full}",
        "",
        "## Sources and data points {#sources}",
        "",
        "None yet.",
        "",
    ]
    return "\n".join(fm + body)


ROADMAP_MD = """---
document: {slug}
title: "Example roadmap"
kind: roadmap
---

# Example roadmap {{#roadmap}}

## Summary {{#summary}}

What we plan.

## Now {{#now}}

The current quarter.
"""


async def import_md(client, headers, slug: str, markdown: str):
    return await client.post(
        f"/v1/documents/{slug}/versions",
        content=markdown.encode(),
        headers={**headers, **MARKDOWN},
    )


async def imported(client, headers, slug: str, markdown: str) -> dict[str, Any]:
    resp = await import_md(client, headers, slug, markdown)
    assert resp.status_code == 201, resp.text
    return resp.json()


async def approve(client, headers, slug: str, n: int):
    return await client.post(f"/v1/documents/{slug}/versions/{n}/approve", headers=headers)


async def approved(client, headers, slug: str, n: int) -> dict[str, Any]:
    resp = await approve(client, headers, slug, n)
    assert resp.status_code == 200, resp.text
    return resp.json()


async def add_entity(
    tenant_id: uuid.UUID, type_: str, key: str, status: str = "confirmed"
) -> uuid.UUID:
    async with tenant_session(tenant_id) as s:
        e = Entity(type=type_, key=key, title=key.replace("-", " ").title(), status=status,
                   origin="user")  # fmt: skip
        s.add(e)
        await s.commit()
        return e.id


async def add_edge(
    tenant_id: uuid.UUID, src: uuid.UUID, dst: uuid.UUID, type_: str, **attrs: Any
) -> uuid.UUID:
    async with tenant_session(tenant_id) as s:
        e = Edge(src_id=src, dst_id=dst, type=type_, status="confirmed", origin="user",
                 attrs=attrs)  # fmt: skip
        s.add(e)
        await s.commit()
        return e.id


async def supports(tenant_id: uuid.UUID, feature: uuid.UUID, goal: uuid.UUID) -> uuid.UUID:
    return await add_edge(tenant_id, feature, goal, "supports", contribution=2)


async def entity(tenant_id: uuid.UUID, type_: str, key: str) -> Entity | None:
    async with tenant_session(tenant_id) as s:
        return await s.scalar(select(Entity).where(Entity.type == type_, Entity.key == key))


async def edges(tenant_id: uuid.UUID, type_: str) -> list[Edge]:
    async with tenant_session(tenant_id) as s:
        return list(await s.scalars(select(Edge).where(Edge.type == type_)))


async def roadmap_with_items(
    client,
    ctx: Ctx,
    items: list[tuple[str, str, uuid.UUID | None]],
    *,
    slug: str = "example-roadmap",
    track: bool = True,
) -> tuple[uuid.UUID, uuid.UUID]:
    """A roadmap document (version 1, imported) with ``items`` (key, horizon, feature id)
    on that version and, with ``track``, an active product track following it.
    Returns (roadmap document id, version id)."""
    await imported(client, ctx.as_("owner"), slug, ROADMAP_MD.format(slug=slug))
    async with tenant_session(ctx.tenant_id) as s:
        doc = await s.scalar(select(Document).where(Document.slug == slug))
        version = await s.scalar(
            select(DocumentVersion).where(DocumentVersion.document_id == doc.id)
        )
        if track:
            prd = Document(slug=f"{slug}-prd", title="Example PRD", kind="prd")
            s.add(prd)
            await s.flush()
            s.add(ProductTrack(prd_document_id=prd.id, roadmap_document_id=doc.id,
                               title="Example track", status="active"))  # fmt: skip
        for position, (key, horizon, feature) in enumerate(items):
            s.add(
                RoadmapItem(
                    roadmap_document_id=doc.id, roadmap_version_id=version.id, item_key=key,
                    position=position, title=key.replace("-", " ").title(), horizon=horizon,
                    feature_id=feature,
                )
            )  # fmt: skip
        await s.commit()
        return doc.id, version.id


async def check(client, ctx: Ctx) -> dict[str, int]:
    resp = await client.post("/v1/strategy/check", headers=ctx.as_("owner"))
    assert resp.status_code == 200, resp.text
    return resp.json()


async def findings(client, ctx: Ctx, who: str = "owner", **params: str) -> list[dict[str, Any]]:
    resp = await client.get("/v1/strategy/findings", params=params, headers=ctx.as_(who))
    assert resp.status_code == 200, resp.text
    return resp.json()
