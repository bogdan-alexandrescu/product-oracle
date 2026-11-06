"""Pre-demo QA of Simple's one-pagers (S-8, P-9, P-5). Against Postgres; invented data.

Test cards (protects / fails_when / no_claim):

- test_timeline_counts_the_company_roadmap_items_of_the_prd: protects=the Timeline is the
  PRD's roadmap items: its own (prd_document_id) and the company roadmap's items that name
  no PRD (or another) but deliver one of the PRD's features, by code (the item's code, a
  slice's feature's code) or by the feature its plan links; fails_when=the Timeline reads
  "No roadmap items yet" while the Roadmap has the PRD's items, or another feature's item is
  counted; no_claim=the strip's layout (tests/test_simple_plan_strip*).
- test_not_in_prd_said_once_per_section: protects=a line that only says "Not in the PRD yet"
  (Oracle's answer, a stored build) is never shown: its block is marked missing once;
  fails_when=the words show as lines, twice in a block; no_claim=the job's prompt.
- test_goal_codes_named: protects=each goal code on the one-pager (G2) has its name beside
  it: the Ground Truth goal keyed by it, else the name the PRD gives it ("G3 (calm
  alerts)"); the Edit box keeps the PRD's words; fails_when=a line reads "Setup
  checklist: G2" or "G2 (retention): ..."; no_claim=feature codes (one_pager_checks).
"""

import uuid

import pytest
from sqlalchemy import select

from oracle import company_time
from oracle.baseline.models import Entity
from oracle.docs.models import Document, DocumentVersion
from oracle.roadmap.models import RoadmapItem
from oracle.simple.models import SimpleOnePager, SimplePrdPlan
from oracle.tenancy import tenant_session
from tests.test_simple_one_pager_api import MD, block, get, world
from tests.test_simple_plan_api import version
from tests.test_simple_roadmap_api import NOW


@pytest.fixture(autouse=True)
def clock(monkeypatch):
    monkeypatch.setattr(company_time, "now", lambda: NOW)


async def company_roadmap(s, prd_id: uuid.UUID, items: list[dict]) -> None:
    one = Document(slug="product-roadmap", title="Product roadmap", kind="roadmap",
                   status="approved", visibility="company", company_roadmap=True)  # fmt: skip
    s.add(one)
    await s.flush()
    v = await version(s, one, 1, "# Product roadmap\n")
    for n, it in enumerate(items):
        s.add(RoadmapItem(roadmap_document_id=one.id, roadmap_version_id=v.id, horizon="now",
                          position=n, **it))  # fmt: skip


async def test_timeline_counts_the_company_roadmap_items_of_the_prd(client):
    ctx = await world(client)
    async with tenant_session(ctx.tenant_id) as s:
        prd = await s.scalar(select(Document).where(Document.slug == "guided-setup"))
        pv = await s.scalar(select(DocumentVersion).where(DocumentVersion.document_id == prd.id))
        other = Document(slug="usage-billing", title="Usage billing", kind="prd",
                         visibility="company")  # fmt: skip
        s.add(other)
        linked = Entity(type="feature", key="invite-helper", title="Invite helper",
                        status="confirmed", origin="user")  # fmt: skip
        s.add(linked)
        await s.flush()
        s.add(SimplePrdPlan(document_id=prd.id, version_id=pv.id, status="ready", source="prd",
                            data={"features": [{"code": "F-07", "name": "Setup checklist"},
                                               {"code": "F-9", "name": "Invite helper"}],
                                  "links": {"F-9": str(linked.id)}}))  # fmt: skip
        await company_roadmap(s, prd.id, [
            # Its own item, as before.
            {"item_key": "own", "title": "Progress meter", "prd_document_id": prd.id},
            # The company roadmap's items of its features, naming no PRD.
            {"item_key": "f-07", "title": "Setup checklist", "prd_section_key": "f-07"},
            {"item_key": "helper", "title": "Invite helper", "feature_id": linked.id},
            # Another PRD's feature, and an item of no feature: not this PRD's.
            {"item_key": "f-12", "title": "Usage export", "prd_section_key": "f-12",
             "prd_document_id": other.id},
            {"item_key": "loose", "title": "Billing page"},
        ])  # fmt: skip
        await s.commit()
    view = await get(client, ctx, "viewer")
    titles = sorted(i["title"] for i in view["timeline"])
    assert titles == ["Invite helper", "Progress meter", "Setup checklist"], titles
    assert view["plan"] is not None
    assert view["span_start"] is None or view["span_start"] <= view["span_end"]


NOT_YET = "Not in the PRD yet"


async def test_not_in_prd_said_once_per_section(client):
    ctx = await world(client)
    await get(client, ctx)  # builds and stores the page
    async with tenant_session(ctx.tenant_id) as s:
        row = await s.scalar(select(SimpleOnePager))
        blocks = [dict(b) for b in row.blocks]
        for b in blocks:
            if b["key"] == "not_doing":
                b["lines"] = [
                    {"id": "not_doing-1", "text": f"{NOT_YET}.", "source_keys": ["not-doing"]},
                    {"id": "not_doing-2", "text": NOT_YET, "source_keys": ["not-doing"]},
                ]
            if b["key"] == "risks":
                b["lines"] = [{"id": "risks-1", "text": f"Open decisions: {NOT_YET}",
                               "source_keys": ["risks"]}]  # fmt: skip
        row.blocks = blocks
        await s.commit()
    for who in ("owner", "viewer"):
        view = await get(client, ctx, who)
        for key in ("not_doing", "risks"):
            b = block(view, key)
            assert b["lines"] == [] and b["missing"] is True, (who, b)
        text = " ".join(x["text"] for b in view["blocks"] for x in b["lines"])
        assert NOT_YET.lower() not in text.lower()


GOALS = """---
title: Calm setup
---

## Problem {#problem}

New workspace admins stall during setup and never invite a teammate in week one.

## Goal trace {#goal-trace}

- G2 (retention): admins come back in week two from 30% to 45%
- G3 (calm alerts): fewer setup emails from 6 to 2

## What we will build {#build}

| Feature | Goal |
|---|---|
| Setup checklist | G2 |
| Invite suggestions | G1 |
| Sample project | G3 |
"""


async def test_goal_codes_named(client):
    ctx = await world(client)
    r = await client.post("/v1/documents/calm-setup/versions", content=GOALS.encode(),
                          headers=MD | ctx.as_("owner"))  # fmt: skip
    assert r.status_code in (200, 201), r.text
    async with tenant_session(ctx.tenant_id) as s:
        doc = await s.scalar(select(Document).where(Document.slug == "calm-setup"))
        v = await s.scalar(select(DocumentVersion).where(DocumentVersion.document_id == doc.id))
        v.approved_at = NOW
        for key, title in (("G1", "Faster activation"), ("g2", "Grow retention")):
            s.add(Entity(type="goal", key=key, title=title, status="confirmed", origin="user"))
        await s.commit()
    view = await get(client, ctx, "owner", "calm-setup")
    bets = [x["text"] for x in block(view, "bets")["lines"]]
    assert "Setup checklist: G2 Grow retention" in bets, bets
    assert "Invite suggestions: G1 Faster activation" in bets, bets
    assert "Sample project: G3 Calm alerts" in bets, bets
    outcomes = block(view, "outcomes")["lines"]
    said = [x["text"] for x in outcomes]
    assert any(t.startswith("G2 Grow retention: admins come back") for t in said), said
    assert any(t.startswith("G3 Calm alerts: fewer setup emails") for t in said), said
    # The Edit box starts from the PRD's own words.
    first = next(x for x in outcomes if x["text"].startswith("G2"))
    assert first["words"].startswith("G2 (retention)"), first
