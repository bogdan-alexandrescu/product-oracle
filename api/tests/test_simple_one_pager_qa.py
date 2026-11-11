"""Pre-demo QA of Simple's one-pagers (S-8, P-9, P-5). Against Postgres; invented data.

Test cards (protects / fails_when / no_claim):

- test_timeline_counts_the_company_roadmap_items_of_the_prd: protects=the Timeline is the
  PRD's roadmap items: its own (prd_document_id) and the company roadmap's items that name
  no PRD (or another) but deliver one of the PRD's features, by code (the item's code, a
  slice's feature's code) or by the feature its plan links; fails_when=the Timeline reads
  "No roadmap items yet" while the Roadmap has the PRD's items, or another feature's item is
  counted; no_claim=the strip's layout (tests/test_simple_plan_strip*).
- test_timeline_places_items_by_this_prds_plan: protects=each listed item sits under THIS
  PRD's milestone that slices its feature, else "No milestone", in this PRD's dates;
  fails_when=another PRD's plan (whose milestone slices the same feature code) names a row
  ("M1 · Billing beta"), merges into this PRD's M1 or sets the span; no_claim=the strip's
  layout.
- test_a_plan_led_page_lists_the_items_with_no_plan_milestone: protects=a PRD whose plan has
  its own milestones still sends each of its roadmap items with no plan milestone, by id,
  in the strip's last row "No milestone" (the When card lists them there, owner Nov 10 'Add
  rows to the plan card'); fails_when=such an item is left out of the strip; no_claim=the
  card's look (web/e2e/vqa-one-pager.spec.ts).
- test_timeline_reads_the_approved_versions_plan: protects=a PRD whose plan is read from
  its approved version's Milestones/Features tables (no stored plan) lists the company
  roadmap's items of those features, placed in its milestones; fails_when=only a stored
  "ready" plan is read; no_claim=the tables' parsing (tests/test_simple_plan*).
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


async def other_prd_slicing_f07(s) -> Document:
    """Another PRD whose own plan slices F-07 into its M1 "Billing beta"."""
    other = Document(slug="usage-billing", title="Usage billing", kind="prd",
                     status="approved", visibility="company")  # fmt: skip
    s.add(other)
    await s.flush()
    ov = await version(s, other, 1, "# Usage billing\n")
    s.add(SimplePrdPlan(document_id=other.id, version_id=ov.id, status="ready", source="prd",
                        data={"milestones": [{"code": "M1", "name": "Billing beta",
                                              "start": "2026-09-01", "end": "2027-03-31"}],
                              "features": [{"code": "F-07", "name": "Setup checklist",
                                            "milestones": ["M1"]}]}))  # fmt: skip
    return other


@pytest.mark.parametrize("own_plan", [False, True])
async def test_timeline_places_items_by_this_prds_plan(client, own_plan):
    ctx = await world(client)
    async with tenant_session(ctx.tenant_id) as s:
        prd = await s.scalar(select(Document).where(Document.slug == "guided-setup"))
        pv = await s.scalar(select(DocumentVersion).where(DocumentVersion.document_id == prd.id))
        other = await other_prd_slicing_f07(s)
        features = [{"code": "F-07", "name": "Setup checklist", "milestones": ["M1"]}]
        data = (
            {"milestones": [{"code": "M1", "name": "Setup basics",
                             "start": "2026-11-02", "end": "2026-12-18"}], "features": features}
            if own_plan
            else {"features": [{"code": "F-07", "name": "Setup checklist"}]}
        )  # fmt: skip
        s.add(SimplePrdPlan(document_id=prd.id, version_id=pv.id, status="ready", source="prd",
                            data=data))  # fmt: skip
        await company_roadmap(s, prd.id, [
            {"item_key": "own", "title": "Progress meter", "prd_document_id": prd.id,
             "prd_section_key": "f-07"},
            # The other PRD's item of this PRD's feature F-07.
            {"item_key": "f-07", "title": "Setup checklist", "prd_section_key": "f-07",
             "prd_document_id": other.id},
        ])  # fmt: skip
        await s.commit()
    view = await get(client, ctx, "viewer")
    assert sorted(i["title"] for i in view["timeline"]) == ["Progress meter", "Setup checklist"]
    rows = view["plan"]["rows"]
    names = [r["name"] for r in rows]
    assert not any("Billing beta" in n for n in names), names
    if own_plan:
        assert names == ["M1 · Setup basics"], names
        assert (view["span_start"], view["span_end"]) == ("2026-11-02", "2026-12-18")
    else:
        assert names == ["No milestone"], names
        assert rows[0]["items"] == 2
        assert view["span_start"] is None and view["span_end"] is None


async def test_a_plan_led_page_lists_the_items_with_no_plan_milestone(client):
    ctx = await world(client)
    async with tenant_session(ctx.tenant_id) as s:
        prd = await s.scalar(select(Document).where(Document.slug == "guided-setup"))
        pv = await s.scalar(select(DocumentVersion).where(DocumentVersion.document_id == prd.id))
        s.add(SimplePrdPlan(document_id=prd.id, version_id=pv.id, status="ready", source="prd",
                            data={"milestones": [{"code": "M1", "name": "Setup basics",
                                                  "start": "2026-11-02", "end": "2026-12-18"}],
                                  "features": [{"code": "F-07", "name": "Setup checklist",
                                                "milestones": ["M1"]}]}))  # fmt: skip
        await company_roadmap(s, prd.id, [
            {"item_key": "own", "title": "Progress meter", "prd_document_id": prd.id,
             "prd_section_key": "f-07"},
            # No feature of the plan: no plan milestone.
            {"item_key": "loose", "title": "Calendar invite sync", "prd_document_id": prd.id},
        ])  # fmt: skip
        await s.commit()
    view = await get(client, ctx, "viewer")
    ids = {i["title"]: i["id"] for i in view["timeline"]}
    rows = view["plan"]["rows"]
    assert [r["name"] for r in rows] == ["M1 · Setup basics", "No milestone"], rows
    assert rows[0]["item_ids"] == [ids["Progress meter"]]
    assert rows[-1]["item_ids"] == [ids["Calendar invite sync"]] and not rows[-1]["milestone"]


PLAN_TABLES = """

## Milestones

| Milestone | Name | Start | End |
|---|---|---|---|
| M1 | Setup basics | 2 Nov 2026 | 18 Dec 2026 |

## Features

| Feature | Name | Milestone |
|---|---|---|
| F-01 | Checklist polish | M1 |
"""


async def test_timeline_reads_the_approved_versions_plan(client):
    ctx = await world(client)
    async with tenant_session(ctx.tenant_id) as s:
        prd = await s.scalar(select(Document).where(Document.slug == "guided-setup"))
        pv = await s.scalar(select(DocumentVersion).where(DocumentVersion.document_id == prd.id))
        pv.markdown = (pv.markdown or "") + PLAN_TABLES
        await company_roadmap(s, prd.id, [
            {"item_key": "f-01", "title": "Checklist polish", "prd_section_key": "f-01"},
        ])  # fmt: skip
        await s.commit()
    view = await get(client, ctx, "viewer")
    assert [i["title"] for i in view["timeline"]] == ["Checklist polish"]
    # No roadmap item names the PRD, so its M1 is no roadmap milestone: its name, no code.
    assert [r["name"] for r in view["plan"]["rows"]] == ["Setup basics"]


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
