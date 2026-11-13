"""A Simple working draft's version carries the plan as the items are: approving it applies a
plan table of every item with its own dates, so Simple's line says it matches that version
(hotfix 4, Nov 6: the company roadmap's version 8 carried the base version's old plan table,
and Simple said 58 items were added after version 8 and two had other dates). A person's own
dates stay theirs; the banner names the number the draft becomes.

Test cards (protects / fails_when / no_claim):

- test_the_approved_draft_matches_its_version: protects=after approving a draft over a base
  whose plan table is stale, Simple's applied-version line has no differences and says it
  matches, the version's text lists every item with its current dates (not the old plan),
  its item rows carry the draft's dates, and a person's own dates stay "typed";
  fails_when=the old plan table is carried over, a row has other dates, or the line reports
  differences; no_claim=the banner, or items cut in the draft.
- test_the_banner_names_the_number_the_draft_becomes: protects=when a run's later version
  exists, the working draft shows its base version's number and a next version one past the
  latest; fails_when=the next number is the base's plus one; no_claim=approval itself.
- test_a_cut_item_is_no_difference: protects=an item cut in the draft is left out of the
  version's plan and Simple's plan, so the applied-version line still has no differences and
  matches; fails_when=the cut item shows as a difference; no_claim=the dates of the items
  that stay (first test).
"""

import hashlib
import uuid
from datetime import date

from sqlalchemy import func, select

from oracle.docs.models import DocumentVersion, Section
from oracle.roadmap.models import RoadmapItem
from oracle.tenancy import tenant_session
from tests.test_simple_changes_api import World, make_people
from tests.test_simple_changes_api import clock as clock  # noqa: F401

DRAFTS = "/v1/simple/drafts"
ROADMAP = "/v1/simple/roadmap?roadmap=payments"

# The base version's own plan, written before the draft's changes: it lists one item with
# dates the items no longer have.
OLD_PLAN = """| Key | Item | Start | End | Dates from | Status |
|---|---|---|---|---|---|
| move_dates-b | Old title | Dec 1, 2026 | Jan 8, 2027 | engineering estimate | planned |"""


async def _base(ctx, w: World) -> DocumentVersion:
    async with tenant_session(ctx.tenant_id) as s:
        base = await s.scalar(
            select(DocumentVersion)
            .where(DocumentVersion.document_id == uuid.UUID(w.roadmap_id))
            .order_by(DocumentVersion.number.desc())
            .limit(1)
        )
        s.add(
            Section(
                version_id=base.id,
                section_key="plan",
                heading="Plan",
                level=2,
                ordinal=50,
                body_md=OLD_PLAN,
                content_hash=hashlib.sha256(OLD_PLAN.encode()).hexdigest(),
            )
        )
        await s.commit()
        return base


async def _approve(client, ctx, w: World) -> dict:
    r = await w.post(client, "decider", "move_dates")
    assert r.status_code == 201, r.text
    draft_id = r.json()["change"]["draft_ids"][0]
    r = await client.post(f"{DRAFTS}/{draft_id}/approve", headers=ctx.as_("decider"))
    assert r.status_code == 200, r.text
    return r.json()


async def test_the_approved_draft_matches_its_version(client):
    ctx = await make_people()
    w = await World(ctx).build(decider=True, ops=["move_dates"])
    await _base(ctx, w)
    await _approve(client, ctx, w)
    r = await client.get(ROADMAP, headers=ctx.as_("decider"))
    assert r.status_code == 200, r.text
    [line] = r.json()["applied_versions"]
    assert line["differences"] == [] and line["matches"] is True, line
    async with tenant_session(ctx.tenant_id) as s:
        version = await s.scalar(
            select(DocumentVersion).where(
                DocumentVersion.document_id == uuid.UUID(w.roadmap_id),
                DocumentVersion.number == line["version"],
            )
        )
        # The version's text lists every item with its dates as they are, not the old plan.
        assert "| move_dates-a |" in version.markdown and "Oct 5, 2026" in version.markdown
        assert "| move_dates-b |" in version.markdown and "Jan 8, 2027" not in version.markdown
        rows = {
            r.item_key: r
            for r in await s.scalars(
                select(RoadmapItem).where(RoadmapItem.roadmap_version_id == version.id)
            )
        }
    a, b = rows["move_dates-a"], rows["move_dates-b"]
    assert (a.start_date, a.end_date) == (date(2026, 10, 5), date(2026, 11, 20))
    assert (b.start_date, b.end_date) == (date(2026, 11, 10), date(2026, 12, 15))
    # A person's own dates stay theirs when the version agrees with them.
    assert a.date_source == "typed" and b.date_source == "typed"


async def test_the_banner_names_the_number_the_draft_becomes(client):
    """A run's later version exists: the working draft becomes the version after the latest,
    not its base's number plus one."""
    ctx = await make_people()
    w = await World(ctx).build(decider=True, ops=["move_dates"])
    base = await _base(ctx, w)
    async with tenant_session(ctx.tenant_id) as s:
        latest = await s.scalar(
            select(func.max(DocumentVersion.number)).where(
                DocumentVersion.document_id == base.document_id
            )
        )
        s.add(
            DocumentVersion(
                document_id=base.document_id,
                number=latest + 1,
                markdown="# Payments\n",
                content_hash=hashlib.sha256(b"run").hexdigest(),
                front_matter={},
            )
        )
        await s.commit()
    r = await w.post(client, "decider", "move_dates")
    assert r.status_code == 201, r.text
    r = await client.get(DRAFTS, headers=ctx.as_("decider"))
    assert r.status_code == 200, r.text
    [d] = [x for x in r.json() if x["status"] == "working"]
    assert d["base_version"] == base.number
    assert d["next_version"] == latest + 2


async def test_a_cut_item_is_no_difference(client):
    """An item cut in the draft is left out of the version's plan and off Simple's plan: the
    line still says it matches (the company roadmap has an item below the line)."""
    ctx = await make_people()
    w = await World(ctx).build(decider=True, ops=["move_dates", "cut"])
    await _base(ctx, w)
    r = await w.post(client, "decider", "cut")
    assert r.status_code == 201, r.text
    await _approve(client, ctx, w)
    r = await client.get(ROADMAP, headers=ctx.as_("decider"))
    assert r.status_code == 200, r.text
    [line] = r.json()["applied_versions"]
    assert line["differences"] == [] and line["matches"] is True, line
