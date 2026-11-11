"""A roadmap's Markdown export names the PRDs that feed it (owner, Nov 10: 'Name the PRDs
that feed it'): one plain line under the title, "From the PRDs: Scale, User Safety", the
PRDs in the company's PRD order (oracle.docs.prd_order), by name; no HTML comment. The
import drops the line again, so the file imports as the text it was exported from.
Invented data only (tests.test_export_audience's roadmap).
"""

import pytest
from sqlalchemy import func, select, update

from oracle.docs import parser
from oracle.docs.models import Document, DocumentVersion
from oracle.roadmap.models import RoadmapItem
from oracle.tenancy import tenant_session
from tests.baseline_helpers import make_ctx
from tests.specs_helpers import MARKDOWN
from tests.test_export_audience import EXPORT, SECTIONS, SLUG, seed_roadmap


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
    # A roadmap's import drops the line: the title section reads as stored.
    parsed = parser.parse_draft(parser.without_prds_line(
        f"---\ndocument: {SLUG}\ntitle: Example Labs roadmap\n---\n" + resp.text))  # fmt: skip
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
    assert parser.without_prds_line(md) == head + stored
    assert prds_line(body, []) == body


# Review of train BM (Nov 11): the line is an export's, so only a roadmap's import through the
# import route drops it, and only directly under its first level-1 heading (or at the top of a
# body with none). A person's own paragraph that starts the same way stays everywhere else.

PRD_TEXT = (
    "---\ndocument: example-notes\ntitle: Example notes\n---\n"
    "# Example notes {#notes}\n\nFrom the PRDs: what we learnt.\n\n"
    "## Summary {#summary}\n\nWe grow activation.\n"
)
ROADMAP_HEAD = f"---\ndocument: {SLUG}\ntitle: Example Labs roadmap\n---\n"
# The seeded sections with no date (an import refuses an unverified one).
UNDATED = [(k, lv, h, "- Pricing tier: owner Ana" if k == "decisions" else b)
           for k, lv, h, b in SECTIONS]  # fmt: skip


def test_a_parse_keeps_a_paragraph_that_starts_like_the_line():
    # Every parse (a PRD's, a spec's, a section edit's composed draft) reads the text as written.
    assert parser.parse_draft(PRD_TEXT).sections[0].body_md == "From the PRDs: what we learnt."
    roadmap = ROADMAP_HEAD + "# Example Labs roadmap {#roadmap}\n\nFrom the PRDs: our own note.\n"
    assert parser.parse_draft(roadmap).sections[0].body_md == "From the PRDs: our own note."


def test_only_the_line_under_the_first_title_or_at_the_top_is_dropped():
    first = "# Example Labs roadmap {#roadmap}\n\n"
    second = "## Summary {#summary}\n\nWe grow.\n\n# Full version {#full}\n\n"
    line = "From the PRDs: Scale\n\n"
    rest = "## Now {#now}\n\nShip it.\n"
    # Under the first title: dropped.
    assert parser.without_prds_line(ROADMAP_HEAD + first + line + rest) == (
        ROADMAP_HEAD + first + rest
    )
    # At the top of a body with no title: dropped.
    assert parser.without_prds_line(ROADMAP_HEAD + line + rest) == ROADMAP_HEAD + rest
    # Under a later level-1 heading, or at the top of a body that has a title: kept.
    for kept in (
        ROADMAP_HEAD + first + second + line + rest,
        ROADMAP_HEAD + line + first + rest,
        # A paragraph that goes on past the line is a person's: kept.
        ROADMAP_HEAD + first + "From the PRDs: Scale\nand more of ours.\n\n" + rest,
    ):
        assert parser.without_prds_line(kept) == parser.prepared(kept)


async def test_a_roadmap_export_round_trips_through_the_import_route(client, ctx):
    await seed_roadmap(ctx, sections=UNDATED)
    await _feed(ctx)
    # The seeded version stores no front matter; a real one carries it into its export.
    md = (await client.get(EXPORT, params={"format": "md"}, headers=ctx.as_("viewer"))).text
    assert "From the PRDs: " in md
    md = ROADMAP_HEAD + md
    resp = await client.post(
        f"/v1/documents/{SLUG}/versions",
        params={"base_version": 1},
        content=md.encode(),
        headers={**ctx.as_("owner"), **MARKDOWN},
    )
    assert resp.status_code == 201, resp.text
    async with tenant_session(ctx.tenant_id) as s:
        doc = await s.scalar(select(Document).where(Document.slug == SLUG))
        v2 = await s.scalar(
            select(DocumentVersion).where(
                DocumentVersion.document_id == doc.id, DocumentVersion.number == 2
            )
        )
        assert "From the PRDs" not in v2.markdown
    again = await client.get(
        f"/v1/documents/{SLUG}/versions/2/export",
        params={"format": "md"},
        headers=ctx.as_("viewer"),
    )
    assert again.text.count("From the PRDs: ") == 1


async def test_the_import_route_keeps_the_paragraph_in_a_prd(client, ctx):
    resp = await client.post(
        "/v1/documents/example-notes/versions",
        content=PRD_TEXT.encode(),
        headers={**ctx.as_("owner"), **MARKDOWN},
    )
    assert resp.status_code == 201, resp.text
    async with tenant_session(ctx.tenant_id) as s:
        doc = await s.scalar(select(Document).where(Document.slug == "example-notes"))
        v1 = await s.scalar(select(DocumentVersion).where(DocumentVersion.document_id == doc.id))
        assert "From the PRDs: what we learnt." in v1.markdown


async def test_the_import_route_keeps_a_roadmap_paragraph_under_a_later_title(client, ctx):
    await seed_roadmap(ctx, sections=UNDATED)
    md = (await client.get(EXPORT, params={"format": "md"}, headers=ctx.as_("viewer"))).text
    assert "From the PRDs" not in md
    full = "# Full version {#full}\n"
    md = ROADMAP_HEAD + md.replace(full, f"{full}\nFrom the PRDs: ours.\n")
    resp = await client.post(
        f"/v1/documents/{SLUG}/versions",
        params={"base_version": 1},
        content=md.encode(),
        headers={**ctx.as_("owner"), **MARKDOWN},
    )
    assert resp.status_code == 201, resp.text
    async with tenant_session(ctx.tenant_id) as s:
        doc = await s.scalar(select(Document).where(Document.slug == SLUG))
        v2 = await s.scalar(
            select(DocumentVersion).where(
                DocumentVersion.document_id == doc.id, DocumentVersion.number == 2
            )
        )
        assert "From the PRDs: ours." in v2.markdown


async def test_a_prd_in_trash_is_left_out_of_the_line(client, ctx):
    await seed_roadmap(ctx)
    await _feed(ctx)
    async with tenant_session(ctx.tenant_id) as s:
        await s.execute(
            update(Document).where(Document.slug == "scale").values(deleted_at=func.now())
        )
        await s.commit()
    md = (await client.get(EXPORT, params={"format": "md"}, headers=ctx.as_("viewer"))).text
    assert "From the PRDs: User Safety, Example Labs PRD\n" in md
    assert "Scale" not in md.split("From the PRDs: ")[1].split("\n")[0]


async def test_a_title_with_a_comma_reads_clearly(client, ctx):
    # Commas part the titles, so a title holding one is quoted.
    await seed_roadmap(ctx)
    await _feed(ctx)
    async with tenant_session(ctx.tenant_id) as s:
        await s.execute(
            update(Document).where(Document.slug == "scale").values(title="Scale, phase 2")
        )
        await s.commit()
    md = (await client.get(EXPORT, params={"format": "md"}, headers=ctx.as_("viewer"))).text
    assert 'From the PRDs: "Scale, phase 2", User Safety, Example Labs PRD\n' in md


async def test_only_the_markdown_export_reads_the_prds(client, ctx, monkeypatch):
    from oracle.export import render

    async def refused(*_args, **_kwargs):
        raise AssertionError("feeding_prds read for a format that does not show it")

    await seed_roadmap(ctx)
    await _feed(ctx)
    monkeypatch.setattr(render, "feeding_prds", refused)
    resp = await client.get(EXPORT, params={"format": "html"}, headers=ctx.as_("viewer"))
    assert resp.status_code == 200, resp.text
