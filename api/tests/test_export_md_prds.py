"""A roadmap's Markdown export names the PRDs that feed it (owner, Nov 10: 'Name the PRDs
that feed it'): one plain line under the title, "From the PRDs: Scale, User Safety", the
PRDs in the company's PRD order (oracle.docs.prd_order), by name; no HTML comment. The
import drops the line again, so the file imports as the text it was exported from.
Invented data only (tests.test_export_audience's roadmap).
"""

import pytest
from sqlalchemy import select, update

from oracle.docs import parser
from oracle.docs.models import Document, DocumentVersion
from oracle.roadmap.models import RoadmapItem
from oracle.tenancy import tenant_session
from tests.baseline_helpers import make_ctx
from tests.test_export_audience import EXPORT, SLUG, seed_roadmap


@pytest.fixture
async def ctx():
    return await make_ctx("Example Labs")


async def _feed(ctx) -> None:
    """Two more PRDs feed the roadmap: Scale (first in the company order) and User Safety
    (second); Example Labs PRD, unplaced, follows. The roadmap is built from User Safety."""
    async with tenant_session(ctx.tenant_id) as s:
        safety = Document(slug="user-safety", title="User Safety", kind="prd", position=2)
        scale = Document(slug="scale", title="Scale", kind="prd", position=1)
        unused = Document(slug="unused", title="Unused PRD", kind="prd", position=3)
        s.add_all([safety, scale, unused])
        await s.flush()
        sv = DocumentVersion(
            document_id=safety.id, number=1, markdown="", content_hash="x", front_matter={}
        )
        s.add(sv)
        await s.flush()
        roadmap = await s.scalar(select(Document).where(Document.slug == SLUG))
        version = await s.scalar(
            select(DocumentVersion).where(DocumentVersion.document_id == roadmap.id)
        )
        version.source_version_id = sv.id
        lone = await s.scalar(select(Document).where(Document.slug == "example-labs-prd"))
        for key, prd in (("csv-parser", scale), ("bulk-import", lone), ("confetti", scale)):
            await s.execute(
                update(RoadmapItem)
                .where(RoadmapItem.roadmap_version_id == version.id, RoadmapItem.item_key == key)
                .values(prd_document_id=prd.id)
            )
        await s.commit()


async def test_the_markdown_export_names_the_prds_that_feed_the_roadmap(client, ctx):
    await seed_roadmap(ctx)
    await _feed(ctx)
    resp = await client.get(EXPORT, params={"format": "md"}, headers=ctx.as_("viewer"))
    assert resp.status_code == 200, resp.text
    lines = resp.text.split("\n")
    title = lines.index("# Example Labs roadmap {#roadmap}")
    assert lines[title + 1 : title + 4] == [
        "",
        "From the PRDs: Scale, User Safety, Example Labs PRD",
        "",
    ]
    # No banner comment: the PRDs are named in the plain line only.
    assert "Unused PRD" not in resp.text and "<!-- Product Oracle" not in resp.text
    # The import drops the line: the title section reads as stored.
    parsed = parser.parse_draft(f"---\ndocument: {SLUG}\ntitle: Example Labs roadmap\n---\n"
                                + resp.text)  # fmt: skip
    assert parsed.sections[0].body_md == "As of October."


async def test_a_roadmap_no_prd_feeds_has_no_line(client, ctx):
    await seed_roadmap(ctx)
    async with tenant_session(ctx.tenant_id) as s:
        await s.execute(update(RoadmapItem).values(prd_document_id=None))
        await s.commit()
    md = (await client.get(EXPORT, params={"format": "md"}, headers=ctx.as_("viewer"))).text
    assert "From the PRDs" not in md


def test_a_body_with_no_title_carries_the_line_at_its_top_and_imports_without_it():
    from oracle.export.render import prds_line

    head = f"---\ndocument: {SLUG}\ntitle: Example Labs roadmap\n---\n"
    body = "\n## Summary {#summary}\n\nWe grow activation.\n"
    md = head + prds_line(body, ["Scale", "User Safety"])
    stored = "## Summary {#summary}\n\nWe grow activation.\n"
    assert md == f"{head}From the PRDs: Scale, User Safety\n\n{stored}"
    assert parser.prepared(md) == head + stored
    assert prds_line(body, []) == body
