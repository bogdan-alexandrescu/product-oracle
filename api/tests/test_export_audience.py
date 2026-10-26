"""O5 lane 1: audience variants (spec-O5 §1, Lanes 1).

One roadmap version, four renderings: the registry (oracle.roadmap.variants), the
document's default audience (``documents.audience``, ``StartDraftIn.audience``), the
``audience=`` parameter of the version export, the deck and the publication export, and
a template's ``audiences`` front matter. Invented data only ("Example Labs").
"""

import hashlib
import re
import uuid
from datetime import UTC, datetime

import pytest
from sqlalchemy import select

from oracle.baseline.models import Edge, Entity
from oracle.docs.models import Document, DocumentVersion, Section
from oracle.review.models import DocumentPublication
from oracle.roadmap import variants
from oracle.roadmap.models import ProductTrack, RoadmapItem, TrackerRecord
from oracle.templates import validation
from oracle.tenancy import tenant_session
from tests.baseline_helpers import make_ctx
from tests.conftest import seed_company
from tests.coverage_helpers import run_headers

SLUG = "example-labs-roadmap"
EXPORT = f"/v1/documents/{SLUG}/versions/1/export"
DECK = f"/v1/documents/{SLUG}/versions/1/deck"
ROLES = ["viewer", "commenter", "approver", "owner", "token", "run"]

# Marker strings: unique, so a test can say exactly what a rendering holds.
OWNER_MARK = "Owner: Dana Markerson"
REVENUE_MARK = "revenue-marker-91"

SECTIONS = [
    ("roadmap", 1, "Example Labs roadmap", "As of October."),
    ("summary", 2, "Summary", "We grow activation this year."),
    ("goals", 2, "Goals served", "- G1 Activation: 40% to 55% by Q4"),
    (
        "brief-items",
        2,
        "Items by horizon",
        "| Horizon | Item | Goal | Outcome |\n|---|---|---|---|\n"
        f"| Now | Bulk import | G1 | prose row {OWNER_MARK} |",
    ),
    ("not-doing", 2, "Not doing", "Dark mode: parked."),
    ("top-risks", 2, "Top risks", "- Vendor limits: we cache."),
    ("decisions", 2, "Decisions needed", "- Pricing tier: owner Ana, by Nov 1"),
    ("full", 1, "Full version", ""),
    ("layout", 2, "Layout", "```yaml\nlayout:\n  type: columns\n```"),
    ("now", 2, "Now", ""),
    ("now-bulk-import", 3, "Bulk import", f"New accounts import on day one. {OWNER_MARK}"),
    ("now-csv-parser", 3, "CSV parser", "Parse every column. Serves G1."),
    ("next", 2, "Next", ""),
    ("next-confetti", 3, "Confetti", "Celebrate signups. Serves no confirmed goal."),
    ("later", 2, "Later", ""),
    ("later-stickers", 3, "Stickers", "Ship stickers. Serves no confirmed goal."),
    ("risks", 2, "Risks and dependencies", "Bulk import waits on the CSV parser."),
    ("changes", 2, "Changes since last version", "Added stickers."),
    ("sources", 2, "Sources and data points", "Interview notes, October."),
]

# The items whose feature serves a confirmed goal; the others serve none.
SERVED = ("csv-parser", "bulk-import")

ITEMS = [
    # key, horizon, title, outcome, extra
    (
        "csv-parser",
        "now",
        "CSV parser",
        "Every column parses",
        {"economics": {"effort": 2}, "priority": {"rank": 2}, "confidence": "high"},
    ),
    (
        "bulk-import",
        "now",
        "Bulk import",
        "New accounts reach their first report on day one",
        {
            "economics": {"effort": 5, "revenue_uplift": REVENUE_MARK},
            "priority": {"rank": 1},
            "confidence": "medium",
            "depends_on": ["csv-parser"],
        },
    ),
    ("confetti", "next", "Confetti", "Signups feel celebrated", {"confidence": "low"}),
    ("stickers", "later", "Stickers", "Fans wear the logo", {"confidence": "low"}),
]


async def seed_roadmap(
    ctx,
    *,
    audience: str | None = None,
    publish: bool = False,
    sections: list = SECTIONS,
    template: str = "now-next-later",
    items: list = ITEMS,
    served: tuple[str, ...] = SERVED,
) -> None:
    """A roadmap version with structured items, a track and two tracker issues. The
    items in ``served`` have a baseline feature that supports a confirmed goal (G1)."""
    await seed_company(ctx.tenant_id)
    features = await seed_goal_links(ctx, served)
    async with tenant_session(ctx.tenant_id) as s:
        prd = Document(slug="example-labs-prd", title="Example Labs PRD", kind="prd")
        doc = Document(
            slug=SLUG,
            title="Example Labs roadmap",
            kind="roadmap",
            status="approved",
            template=template,
            template_version="1",
            audience=audience,
        )
        s.add_all([prd, doc])
        await s.flush()
        markdown = "\n\n".join(f"{'#' * lv} {h} {{#{k}}}\n\n{b}" for k, lv, h, b in sections)
        version = DocumentVersion(
            document_id=doc.id,
            number=1,
            markdown=markdown,
            content_hash=hashlib.sha256(markdown.encode()).hexdigest(),
            front_matter={"document": SLUG, "title": doc.title},
            snapshot="2026-10-16T14:00Z",
            warnings=[],
            created_at=datetime(2026, 10, 16, 14, 0, tzinfo=UTC),
            approved_at=datetime(2026, 10, 17, 9, 30, tzinfo=UTC),
        )
        s.add(version)
        await s.flush()
        for i, (key, level, heading, body) in enumerate(sections):
            brief = key in {"summary", "goals", "brief-items", "not-doing", "top-risks"}
            s.add(
                Section(
                    version_id=version.id,
                    section_key=key,
                    ordinal=i,
                    level=level,
                    heading=heading,
                    body_md=body,
                    body_text=body,
                    content_hash=hashlib.sha256(f"{key}{body}".encode()).hexdigest(),
                    citation_keys=[],
                    layer="brief" if brief or key == "decisions" else "detail",
                )
            )
        track = ProductTrack(prd_document_id=prd.id, roadmap_document_id=doc.id, title="Import")
        s.add(track)
        await s.flush()
        for position, (key, horizon, title, outcome, extra) in enumerate(items):
            s.add(
                RoadmapItem(
                    roadmap_document_id=doc.id,
                    roadmap_version_id=version.id,
                    track_id=track.id,
                    item_key=key,
                    position=position,
                    title=title,
                    outcome=outcome,
                    horizon=horizon,
                    # One item is traced to its feature; the others match by key.
                    feature_id=features.get(key) if key == "bulk-import" else None,
                    **extra,
                )
            )
        now = datetime(2026, 10, 16, tzinfo=UTC)
        for ref, item_key in (("ENG-412", "bulk-import"), ("ENG-413", "csv-parser")):
            s.add(
                TrackerRecord(
                    tracker="linear",
                    external_ref=ref,
                    title=f"Issue {ref}",
                    url=f"https://tracker.example.com/{ref}",
                    track_id=track.id,
                    item_key=item_key,
                    state="in_progress",
                    observed_at=now,
                )
            )
        await s.commit()
    if publish:
        from oracle.review import publish as publish_module

        async with tenant_session(ctx.tenant_id) as s:
            doc = await s.scalar(select(Document).where(Document.slug == SLUG))
            version = await s.scalar(
                select(DocumentVersion).where(DocumentVersion.document_id == doc.id)
            )
            rendered = publish_module.render_publication(
                *(await publish_module._layers(s, doc.id, 1))
            )
            s.add(
                DocumentPublication(
                    document_id=doc.id,
                    number=1,
                    version_id=version.id,
                    version_number=1,
                    content_hash=version.content_hash,
                    manifest={"document": {"slug": SLUG}},
                    manifest_hash="x" * 64,
                    markdown="# Example Labs roadmap",
                    **rendered,
                )
            )
            await s.commit()


async def seed_goal_links(ctx, served: tuple[str, ...]) -> dict[str, uuid.UUID]:
    """A confirmed goal (G1) and, per key in ``served``, a feature whose key is the item
    key with a confirmed ``supports`` edge to it: the item's feature-to-goal link."""
    async with tenant_session(ctx.tenant_id) as s:
        goal = Entity(type="goal", key="g1", title="Activation", status="confirmed", origin="user")
        s.add(goal)
        await s.flush()
        out = {}
        for key in served:
            feature = Entity(type="feature", key=key, title=key, status="confirmed", origin="user")
            s.add(feature)
            await s.flush()
            s.add(
                Edge(src_id=feature.id, dst_id=goal.id, type="supports", status="confirmed",
                     origin="user", attrs={"contribution": 2})
            )  # fmt: skip
            out[key] = feature.id
        await s.commit()
    return out


def _text(html: str) -> str:
    return re.sub(r"\s+", " ", re.sub(r"<[^>]+>", " ", html))


@pytest.fixture
async def ctx():
    return await make_ctx("Example Labs")


async def _headers(ctx, who: str) -> dict[str, str]:
    if who == "run":
        return await run_headers(ctx, "owner")
    return ctx.as_(who)


# Every written text of SECTIONS (and the template ones below) that Board never shows.
WRITTEN = ["As of October", "We grow activation", "40% to 55%", "prose row", "Dark mode"]
WRITTEN += ["Vendor limits", "Pricing tier", "Parse every column", "New accounts import"]
WRITTEN += ["Celebrate signups", "waits on the CSV parser", "Interview notes", "Added stickers"]
WRITTEN += ["Example Labs PRD", "Items by horizon", "Summary", "Goals served", "Full version"]
WRITTEN += ["12 interviews", "Appetite", "Status: in progress", "One subsection", "Why:"]
WRITTEN += ["Nothing moved", "Import beta", "Bets placed", "Shaped pitches", "fans wear"]
WRITTEN += ["Release", "Timeline", "Cycle", "Milestone", "Risk", "after CSV parser", "G1 "]


def board_rows(html: str) -> list[str]:
    """The rows of a Board export's tables, as text."""
    return [_text(r).strip() for r in re.findall(r"<tr\b.*?</tr>", html, re.S)]


def assert_board_rows_only(html: str) -> None:
    """A Board export (HTML, a deck's slides) holds the shown items' rows, the title and
    the banner, and no written text of the roadmap (the stylesheet is not text)."""
    text = _text(re.sub(r"<style\b.*?</style>", "", html, flags=re.S))
    for mark in WRITTEN + ["Markerson", REVENUE_MARK, "ENG-412", "ENG-413", ESTIMATE_MARK]:
        assert mark not in text, (mark, text)
    rows = board_rows(html)
    assert "Bulk import New accounts reach their first report on day one medium Activation" in rows
    assert "CSV parser Every column parses high Activation" in rows


# --- the registry -------------------------------------------------------------------


def test_the_registry_holds_four_audiences_and_board_hides_more_than_team():
    """protects=the registry is the one source of what each audience hides;
    fails_when=an audience is missing or Board shows effort, tracker keys or the Sources
    appendix; no_claim=rendering."""
    assert list(variants.VARIANTS) == ["board", "team", "engineering", "public"]
    board, team, eng = (variants.VARIANTS[k] for k in ("board", "team", "engineering"))
    assert board.label == "Board" and board.max_items_per_horizon == 7
    assert not board.appendix and team.appendix and eng.appendix
    assert "sources" in board.hidden_sections and "sources" not in team.hidden_sections
    assert {"effort", "tracker", "depends_on"}.isdisjoint(board.item_fields)
    assert "tracker" not in team.item_fields and "depends_on" in team.item_fields
    assert {"effort", "tracker", "depends_on"} <= eng.item_fields
    assert board.group_by == "goal" and eng.group_by == "team"


@pytest.mark.parametrize("who", ROLES)
async def test_every_member_reads_the_registry(client, ctx, who):
    """protects=GET /v1/roadmap-audiences is viewer and up (the UI reads the registry);
    fails_when=a role gets other than the four audiences; no_claim=the switch's UI."""
    resp = await client.get("/v1/roadmap-audiences", headers=await _headers(ctx, who))
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert [a["key"] for a in body] == ["board", "team", "engineering", "public"]
    board = body[0]
    assert board["label"] == "Board" and board["group_by"] == "goal"
    assert board["max_items_per_horizon"] == 7 and board["appendix"] is False
    assert "sources" in board["hidden_sections"]


# --- exports ------------------------------------------------------------------------


async def test_board_hides_owners_effort_tracker_keys_and_goalless_items(client, ctx):
    """protects=acceptance 1: the Board render has no item owner, no economics, no
    tracker key, no item without a confirmed goal and says how many it left out;
    fails_when=any of those appear; no_claim=the Public audience (lane 2)."""
    await seed_roadmap(ctx)
    resp = await client.get(
        EXPORT, params={"format": "html", "audience": "board"}, headers=ctx.as_("viewer")
    )
    assert resp.status_code == 200, resp.text
    html, text = resp.text, _text(resp.text)
    assert "Markerson" not in html
    assert REVENUE_MARK not in html and "Effort" not in text
    assert "ENG-412" not in html and "ENG-413" not in html
    assert "Confetti" not in text and "Stickers" not in text
    assert "2 items serve no confirmed goal and are left out" in text
    # The Sources appendix and the changes log are not for the board.
    assert "Interview notes, October" not in text and "Added stickers" not in text
    # Items are rebuilt from roadmap_items: titles, outcomes and confidence remain.
    assert "Bulk import" in text and "first report on day one" in text
    assert "Board" in text  # the badge
    # Owner decision 2026-10-26: Board renders from roadmap_items alone, so no prose
    # section, card, table or heading of the written roadmap reaches it.
    assert_board_rows_only(html)


async def test_team_shows_dependencies_and_flags_goalless_items_but_no_tracker(client, ctx):
    """protects=Team shows every item, the ⚑ flag on goal-less ones and dependencies,
    never tracker keys; fails_when=a goal-less item is dropped or a tracker key shows;
    no_claim=goal grouping."""
    await seed_roadmap(ctx)
    resp = await client.get(EXPORT, params={"audience": "team"}, headers=ctx.as_("viewer"))
    assert resp.status_code == 200, resp.text
    text = _text(resp.text)
    assert "Confetti" in text and "Stickers" in text
    assert "serves no confirmed goal" in text.lower()
    assert "ENG-412" not in text
    assert "Depends on: CSV parser" in text
    assert REVENUE_MARK not in text and "Effort" not in text
    assert "Interview notes, October" in text


async def test_engineering_shows_effort_and_tracker_links_but_no_revenue(client, ctx):
    """protects=acceptance 1: Engineering shows effort and tracker links, without the
    board-level revenue framing; fails_when=effort or the tracker link is missing, or a
    revenue key shows; no_claim=capacity and drift (E1 read-back)."""
    await seed_roadmap(ctx)
    resp = await client.get(
        EXPORT, params={"format": "html", "audience": "engineering"}, headers=ctx.as_("viewer")
    )
    assert resp.status_code == 200, resp.text
    html, text = resp.text, _text(resp.text)
    assert "Effort: 5" in text
    assert "ENG-412" in text and 'href="https://tracker.example.com/ENG-412"' in html
    assert REVENUE_MARK not in html
    assert "Confetti" in text


async def test_the_markdown_banner_names_the_audience(client, ctx):
    """protects=banner_line adds "audience Board"; fails_when=the banner omits it;
    no_claim=markdown body filtering (markdown is the stored text)."""
    await seed_roadmap(ctx)
    resp = await client.get(
        EXPORT, params={"format": "md", "audience": "board"}, headers=ctx.as_("viewer")
    )
    assert resp.status_code == 422, resp.text
    resp = await client.get(
        EXPORT, params={"format": "html", "layer": "brief", "audience": "board"},
        headers=ctx.as_("viewer"),
    )  # fmt: skip
    assert resp.status_code == 200, resp.text
    assert "Audience Board" in resp.text


async def test_no_audience_renders_as_before(client, ctx):
    """protects=an export without audience= is unchanged; fails_when=the prose cards or
    the Sources appendix are dropped; no_claim=the default audience preselect (web)."""
    await seed_roadmap(ctx)
    resp = await client.get(EXPORT, headers=ctx.as_("viewer"))
    assert resp.status_code == 200
    assert "Markerson" in resp.text and "Interview notes, October" in _text(resp.text)


async def test_a_prd_with_an_audience_is_422(client, ctx):
    """protects=acceptance 1: audience= is for roadmaps only; fails_when=a PRD export
    accepts it; no_claim=other kinds' variants (later picks)."""
    await seed_roadmap(ctx)
    async with tenant_session(ctx.tenant_id) as s:
        prd = await s.scalar(select(Document).where(Document.slug == "example-labs-prd"))
        s.add(
            DocumentVersion(
                document_id=prd.id, number=1, markdown="# PRD", content_hash="p" * 64,
                front_matter={}, warnings=[],
            )
        )  # fmt: skip
        await s.commit()
    resp = await client.get(
        "/v1/documents/example-labs-prd/versions/1/export",
        params={"audience": "board"},
        headers=ctx.as_("owner"),
    )
    assert resp.status_code == 422
    assert "roadmap" in resp.text


@pytest.mark.parametrize("who", ROLES)
async def test_non_public_audiences_are_open_to_every_reader(client, ctx, who):
    """protects=viewers and up switch Board, Team and Engineering (it hides, never
    adds); fails_when=a role is refused; no_claim=the Public audience."""
    await seed_roadmap(ctx)
    for audience in ("board", "team", "engineering"):
        resp = await client.get(
            EXPORT, params={"audience": audience}, headers=await _headers(ctx, who)
        )
        assert resp.status_code == 200, (who, audience, resp.text)


@pytest.mark.parametrize(
    ("who", "code"),
    [
        ("viewer", 403),
        ("commenter", 403),
        ("approver", 409),
        ("owner", 409),
        ("token", 409),
        ("run", 403),
    ],
)
async def test_the_public_audience_needs_an_approver_and_a_public_check(client, ctx, who, code):
    """protects=the Public audience needs approver or above, and until lane 2's public
    check exists it is never rendered (409 public_not_ready), never a filtered internal
    text; fails_when=a viewer, commenter or run reaches it, or any role gets internal
    text under the Public label; no_claim=render_public (lane 2)."""
    await seed_roadmap(ctx)
    resp = await client.get(EXPORT, params={"audience": "public"}, headers=await _headers(ctx, who))
    assert resp.status_code == code, resp.text
    assert "Bulk import" not in resp.text
    if code == 409:
        assert resp.json()["detail"]["code"] == "public_not_ready"


async def test_the_deck_takes_an_audience(client, ctx):
    """protects=GET …/deck?audience= builds Board slides without hidden items, and a
    kept deck of another audience is never served; fails_when=the Board deck shows a
    goal-less item or the Team deck after a Board one lacks it; no_claim=PPTX."""
    await seed_roadmap(ctx)
    board = await client.get(DECK, params={"audience": "board"}, headers=ctx.as_("viewer"))
    assert board.status_code == 200, board.text
    slides = " ".join(s["html"] for s in board.json()["slides"])
    assert "Confetti" not in slides and "Bulk import" in slides
    assert "Board" in board.json()["banner"]
    assert_board_rows_only(slides)
    deck = board.json()
    expand = " ".join(e["html"] for s in deck["slides"] for e in s["expand"])
    notes = " ".join(s["notes"] or "" for s in deck["slides"])
    for mark in WRITTEN:
        assert mark not in _text(expand) and mark not in notes, mark
    assert "Example Labs PRD" not in board.text
    team = await client.get(DECK, params={"audience": "team"}, headers=ctx.as_("viewer"))
    assert team.status_code == 200
    assert "Confetti" in " ".join(s["html"] for s in team.json()["slides"])
    assert "Team" in team.json()["banner"]


async def test_the_board_deck_file_holds_rows_only(client, ctx):
    """protects=owner decision 2026-10-26: the Board PPTX and the printable deck carry
    the items' rows, the title and the banner only; fails_when=a written card, prose
    section or presenter note reaches a slide; no_claim=PDF rasterising."""
    import io

    from pptx import Presentation

    await seed_roadmap(ctx)
    params = {"layer": "deck", "format": "pptx", "audience": "board"}
    resp = await client.get(EXPORT, params=params, headers=ctx.as_("viewer"))
    assert resp.status_code == 200, resp.text
    deck = Presentation(io.BytesIO(resp.content))
    texts = []
    for slide in deck.slides:
        for shape in slide.shapes:
            if shape.has_text_frame:
                texts.append(shape.text_frame.text)
            if shape.has_table:
                texts += [c.text for r in shape.table.rows for c in r.cells]
        if slide.has_notes_slide:
            texts.append(slide.notes_slide.notes_text_frame.text)
    text = " ".join(texts)
    assert "Bulk import" in text and "first report on day one" in text and "Activation" in text
    for mark in WRITTEN + ["Markerson", REVENUE_MARK, "ENG-412", "Confetti"]:
        assert mark not in text, (mark, text)
    params["format"] = "html"
    printable = await client.get(EXPORT, params=params, headers=ctx.as_("viewer"))
    assert printable.status_code == 200, printable.text
    assert_board_rows_only(printable.text)


async def test_the_publication_export_takes_an_audience(client, ctx):
    """protects=GET …/publications/{p}/export?audience= renders the pinned version in
    that audience; fails_when=Board shows a goal-less item or the owner marker;
    no_claim=share links (lane 3)."""
    await seed_roadmap(ctx, publish=True)
    url = f"/v1/documents/{SLUG}/publications/1/export"
    plain = await client.get(url, headers=ctx.as_("viewer"))
    assert plain.status_code == 200 and "Markerson" in plain.text
    resp = await client.get(url, params={"audience": "board"}, headers=ctx.as_("viewer"))
    assert resp.status_code == 200, resp.text
    text = _text(resp.text)
    assert "Markerson" not in text and "Confetti" not in text and "Bulk import" in text
    assert_board_rows_only(resp.text)
    public = await client.get(url, params={"audience": "public"}, headers=ctx.as_("viewer"))
    assert public.status_code == 403


# --- the template's audiences front matter ----------------------------------------


TEMPLATE = """---
document: roadmap
kind: roadmap
brief: [summary, not-doing]
audiences:
  board: {hide: [not-doing]}
---

# Roadmap {#roadmap}

## Summary {#summary}

## Not doing {#not-doing}

# Full version {#full}

## Now {#now}

## Sources and data points {#sources}
"""


def test_a_template_audiences_key_names_real_sections():
    """protects=acceptance 2: validation checks audiences against the template's
    sections; fails_when=an unknown section or audience passes; no_claim=the route."""
    assert validation.check_template(TEMPLATE).ok
    bad = validation.check_template(TEMPLATE.replace("hide: [not-doing]", "hide: [nope]"))
    assert [p.code for p in bad.problems] == ["unknown_audience_section"]
    assert "nope" in bad.problems[0].message
    odd = validation.check_template(TEMPLATE.replace("board:", "investors:"))
    assert [p.code for p in odd.problems] == ["invalid_audiences"]


async def test_a_template_hiding_not_doing_for_board_drops_it_from_board_only(client, ctx):
    """protects=acceptance 2: a company-edited template's audiences front matter hides
    its own section for Board only; fails_when=Team loses it or Board keeps it;
    no_claim=un-hiding (the registry always wins)."""
    await seed_roadmap(ctx)
    got = await client.get("/v1/templates/now-next-later", headers=ctx.as_("owner"))
    body = got.json()["versions"][-1]["body"]
    edited = body.replace(
        "\n---\n", "\naudiences:\n  board: {hide: [not-doing]}\n  team: {hide: []}\n---\n", 1
    )
    resp = await client.patch(
        "/v1/templates/now-next-later", json={"body": edited}, headers=ctx.as_("owner")
    )
    assert resp.status_code == 200, resp.text
    async with tenant_session(ctx.tenant_id) as s:
        doc = await s.scalar(select(Document).where(Document.slug == SLUG))
        doc.template_version = str(max(v["version"] for v in resp.json()["versions"]))
        await s.commit()
    board = _text((await client.get(EXPORT, params={"audience": "board"},
                                     headers=ctx.as_("viewer"))).text)  # fmt: skip
    team = _text((await client.get(EXPORT, params={"audience": "team"},
                                    headers=ctx.as_("viewer"))).text)  # fmt: skip
    assert "Dark mode: parked." not in board
    assert "Dark mode: parked." in team
    bad = await client.patch(
        "/v1/templates/now-next-later",
        json={"body": edited.replace("hide: [not-doing]", "hide: [nope]")},
        headers=ctx.as_("owner"),
    )
    assert bad.status_code == 422
    assert "nope" in bad.text


# --- the document's default audience -----------------------------------------------


async def test_start_draft_stores_the_audience_and_old_roadmaps_read_as_team(client, ctx):
    """protects=StartDraftIn.audience is stored on the new roadmap and returned;
    today's roadmaps (no audience) read as team; a PRD with an audience is 422;
    fails_when=the audience is lost or a PRD takes one; no_claim=the dialog (lane 5)."""
    await seed_roadmap(ctx)
    resp = await client.post(
        "/v1/drafts",
        json={"kind": "roadmap", "title": "Board roadmap", "template": "now-next-later",
              "audience": "board"},
        headers=ctx.as_("owner"),
    )  # fmt: skip
    assert resp.status_code in (200, 201), resp.text
    slug = resp.json()["slug"]
    doc = (await client.get(f"/v1/documents/{slug}", headers=ctx.as_("viewer"))).json()
    assert doc["audience"] == "board"
    old = (await client.get(f"/v1/documents/{SLUG}", headers=ctx.as_("viewer"))).json()
    assert old["audience"] == "team"
    prd = await client.post(
        "/v1/drafts",
        json={"kind": "prd", "title": "A PRD", "template": "oracle-default", "audience": "board"},
        headers=ctx.as_("owner"),
    )
    assert prd.status_code == 422


# --- #620 review: the Goal column, the why text, the goal link, every template ------


@pytest.mark.parametrize("audience", ["team", "engineering"])
async def test_every_audience_keeps_the_goal_column_and_the_cards_why_text(client, ctx, audience):
    """protects=the spec's table: Board, Team and Engineering all show each item's goal;
    the rebuilt brief table keeps the template's Goal column and each rebuilt card keeps
    its written goal-and-evidence text; fails_when=the Goal column or a card's "why" is
    dropped; no_claim=grouping by goal (an open owner question)."""
    await seed_roadmap(ctx)
    resp = await client.get(EXPORT, params={"audience": audience}, headers=ctx.as_("viewer"))
    assert resp.status_code == 200, resp.text
    html, text = resp.text, _text(resp.text)
    assert re.search(r"<th[^>]*>\s*Goal\s*</th>", html), html
    assert re.search(r"<td[^>]*>\s*G1\s*</td>", html), html
    # The written card of CSV parser: its why (goal and evidence) is kept.
    assert "Parse every column. Serves G1." in text


async def test_serving_no_goal_comes_from_the_items_goal_link_not_the_cards_words(client, ctx):
    """protects=major 3: an item serves no confirmed goal when its feature has no
    confirmed supports edge to a confirmed goal, whatever its card says;
    fails_when=Board shows an unlinked item whose card does not use the phrase, or hides
    a linked item whose card does; no_claim=goal grouping."""
    sections = [*SECTIONS]
    at = sections.index(("next", 2, "Next", ""))
    sections.insert(at, ("now-audit-log", 3, "Audit log", "Record every change."))
    items = [*ITEMS, ("audit-log", "now", "Audit log", "Every change is recorded", {})]
    await seed_roadmap(ctx, sections=sections, items=items, served=(*SERVED, "confetti"))
    resp = await client.get(EXPORT, params={"audience": "board"}, headers=ctx.as_("viewer"))
    assert resp.status_code == 200, resp.text
    text = _text(resp.text)
    assert "Audit log" not in text and "Stickers" not in text
    assert "Confetti" in text  # its feature serves G1, whatever its card says
    assert "Signups feel celebrated" in text and "Celebrate signups" not in text
    assert "2 items serve no confirmed goal and are left out" in text
    team = _text(
        (await client.get(EXPORT, params={"audience": "team"}, headers=ctx.as_("viewer"))).text
    )
    assert "Audit log" in team and "Record every change." in team


ESTIMATE_MARK = "est-marker-8"
OWNER_LINE = "Owner: Dana Markerson."
WHY = "Why: new accounts need data on day one (G1, 12 interviews)."

# Each template's own sections (api/oracle/templates/builtin/roadmap/*.md) with the
# items written where that template keeps them: owners, tracker keys, estimates and a
# goal-less item (Confetti) in the cards, as a writer fills them in.
TEMPLATE_SECTIONS = {
    "release-plan": (
        "Release",
        "releases",
        [
            ("roadmap", 1, "Example Labs release plan", "As of October."),
            ("summary", 2, "Summary", "We grow activation this year."),
            ("goals", 2, "Goals served", "- G1 Activation: 40% to 55% by Q4"),
            (
                "brief-items",
                2,
                "Items by release",
                "| Release | Item | Goal | Outcome |\n|---|---|---|---|\n"
                "| [2.4](#release-2-4) | [Bulk import](#release-2-4) | G1 | day one |\n"
                "| | [CSV parser](#release-2-4) | G1 | parses |\n"
                "| [2.5](#release-2-5) | [Confetti](#release-2-5) | none | delight |",
            ),
            ("full", 1, "Full version", ""),
            ("releases", 2, "Releases", "One subsection per release."),
            (
                "release-2-4",
                3,
                "2.4 (Nov 3)",
                "Status: in progress. Goals served: G1.\n\n"
                f"- Bulk import (must). {OWNER_LINE} Tracker: ENG-412. "
                f"Estimate: {ESTIMATE_MARK} points. {WHY}\n"
                "- CSV parser (must). Tracker: ENG-413. Why: every column parses (G1).",
            ),
            ("release-2-5", 3, "2.5 (Dec 1)", f"- Confetti (could). {OWNER_LINE} Why: delight."),
            ("drift", 2, "Drift", "Nothing moved."),
            ("sources", 2, "Sources and data points", "Interview notes, October."),
        ],
    ),
    "quarterly-timeline": (
        "Quarter",
        "timeline",
        [
            ("roadmap", 1, "Example Labs quarterly roadmap", "As of October."),
            ("summary", 2, "Summary", "We grow activation this year."),
            ("goals", 2, "Goals served", "- G1 Activation: 40% to 55% by Q4"),
            (
                "brief-items",
                2,
                "Items by quarter",
                "| Quarter | Item | Goal | Outcome |\n|---|---|---|---|\n"
                "| [Q4](#timeline) | [Bulk import](#lane-import) | G1 | day one |\n"
                "| | [CSV parser](#lane-import) | G1 | parses |\n"
                "| [Q1](#timeline) | [Confetti](#lane-growth) | none | delight |",
            ),
            ("full", 1, "Full version", ""),
            ("timeline", 2, "Timeline", "One subsection per swimlane."),
            (
                "lane-import",
                3,
                "Import",
                f"- Bulk import: Nov 1 to Dec 15 (estimate). {OWNER_LINE} "
                f"Effort: {ESTIMATE_MARK}. Tracker: ENG-412. {WHY}\n"
                "- CSV parser: Oct 20 to Nov 1. Why: every column parses (G1).",
            ),
            ("lane-growth", 3, "Growth", f"- Confetti: Q1. {OWNER_LINE} Why: delight."),
            (
                "milestones",
                2,
                "Key milestones",
                "| Milestone | Date | Kind | Owner |\n|---|---|---|---|\n"
                "| Import beta | Nov 20 | estimate | Dana Markerson |",
            ),
            ("sources", 2, "Sources and data points", "Interview notes, October."),
        ],
    ),
    "cycle-bets": (
        "Cycle",
        "current",
        [
            ("roadmap", 1, "Example Labs cycle bets", "As of October."),
            ("summary", 2, "Summary", "We grow activation this year."),
            ("goals", 2, "Goals served", "- G1 Activation: 40% to 55% by Q4"),
            (
                "brief-items",
                2,
                "Bets by cycle",
                "| Cycle | Bet | Goal | Outcome |\n|---|---|---|---|\n"
                "| [This cycle](#current) | [Bulk import](#bet-bulk-import) | G1 | day one |\n"
                "| | [CSV parser](#bet-csv-parser) | G1 | parses |\n"
                "| [Next betting table](#candidates) | [Confetti](#pitch-confetti) | none | "
                "delight |",
            ),
            ("full", 1, "Full version", ""),
            ("current", 2, "This cycle", "Bets placed at the last table."),
            (
                "bet-bulk-import",
                3,
                "Bulk import",
                f"Appetite: big batch. {OWNER_LINE} Tracker: ENG-412. "
                f"Estimate: {ESTIMATE_MARK}. {WHY}",
            ),
            ("bet-csv-parser", 3, "CSV parser", "Appetite: small batch. Why: parses (G1)."),
            ("candidates", 2, "Next betting table", "Shaped pitches."),
            ("pitch-confetti", 3, "Confetti", f"Why now: delight. {OWNER_LINE}"),
            ("ideas", 2, "Raw ideas", "- Stickers: fans wear the logo."),
            ("sources", 2, "Sources and data points", "Interview notes, October."),
        ],
    ),
}


@pytest.mark.parametrize("template", list(TEMPLATE_SECTIONS))
async def test_board_hides_internal_item_detail_in_every_template(client, ctx, template):
    """protects=major 1 (acceptance 1): in the release-plan, quarterly-timeline and
    cycle-bets templates Board shows no owner, tracker key, estimate or goal-less item,
    keeps each item's goal and why, and the brief table keeps the template's own
    Release/Quarter/Cycle and Goal columns and links only to sections that exist;
    fails_when=any of those leak, a column is replaced by Horizon or a link points at a
    missing #now-<key>; no_claim=grouping by goal (open owner question)."""
    column, container, sections = TEMPLATE_SECTIONS[template]
    await seed_roadmap(ctx, sections=sections, template=template)
    resp = await client.get(EXPORT, params={"audience": "board"}, headers=ctx.as_("viewer"))
    assert resp.status_code == 200, resp.text
    html, text = resp.text, _text(resp.text)
    assert "Markerson" not in html
    assert "ENG-412" not in html and "ENG-413" not in html
    assert ESTIMATE_MARK not in html
    assert "Confetti" not in text and "Stickers" not in text
    assert "items serve no confirmed goal and are left out" in text
    # Owner decision 2026-10-26: whatever the template, Board is the items' rows only.
    assert_board_rows_only(html)
    assert not re.search(r'href="#', html), html
    assert f'id="{container}"' not in html
    # Team keeps the goal-less item, flagged, and its tracker keys stay hidden.
    team = await client.get(EXPORT, params={"audience": "team"}, headers=ctx.as_("viewer"))
    team_text = _text(team.text)
    assert "Confetti" in team_text and "ENG-412" not in team.text
    assert "12 interviews" in team_text
    # Engineering shows the tracker key and the estimate.
    eng = _text(
        (
            await client.get(EXPORT, params={"audience": "engineering"}, headers=ctx.as_("viewer"))
        ).text
    )
    assert "ENG-412" in eng and ESTIMATE_MARK in eng


# --- #659 review: tables survive redaction; every written owner and estimate form -----


def _tables(html: str) -> int:
    """The content tables of an export (not the header's status table)."""
    return len(re.findall(r"<table\b(?![^>]*status-table)", html))


MILESTONES_TABLE = (
    "| Milestone | Date | Kind | Owner | Depends on |\n|---|---|---|---|---|\n"
    "| Import beta | Nov 20 | estimate | Dana Markerson | CSV parser |"
)
CARD_TABLE = "| Step | Date |\n|:---|---:|\n| Beta | Nov 20 |\n| GA | Dec 15 |"


def _with_tables(template: str) -> list:
    """The template's sections with a table in an item card (and quarterly-timeline's
    Key milestones table, as its template asks), as a writer fills them in."""
    out = []
    for key, level, heading, body in TEMPLATE_SECTIONS[template][2]:
        if key in ("release-2-4", "lane-import", "bet-bulk-import"):
            body = f"{body}\n\n{CARD_TABLE}"
        if key == "milestones":
            body = MILESTONES_TABLE
        out.append((key, level, heading, body))
    return out


@pytest.mark.parametrize("audience", ["team", "engineering"])
@pytest.mark.parametrize("template", list(TEMPLATE_SECTIONS))
async def test_tables_in_item_areas_survive_redaction(client, ctx, template, audience):
    """protects=#659 re-review major 1: a markdown table in an item area (a card's table,
    quarterly-timeline's Key milestones) keeps its separator row and renders as a table in
    every audience, only the hidden columns dropped; fails_when=the |---| row is dropped
    and the table shows as raw "| … |" text; no_claim=tables outside the item areas."""
    await seed_roadmap(ctx, sections=_with_tables(template), template=template)
    resp = await client.get(EXPORT, params={"audience": audience}, headers=ctx.as_("viewer"))
    assert resp.status_code == 200, resp.text
    html = resp.text
    assert not re.search(r"<p>\s*\|", html), html
    # The brief table, the card's table and (quarterly-timeline) Key milestones.
    assert _tables(html) == (3 if template == "quarterly-timeline" else 2), html
    assert re.search(r"<td[^>]*>\s*Beta\s*</td>", html), html
    if template == "quarterly-timeline":
        assert re.search(r"<td[^>]*>\s*Import beta\s*</td>", html), html
        assert "Dana Markerson" in html


@pytest.mark.parametrize("audience", ["team", "engineering"])
async def test_a_roadmap_with_no_items_keeps_its_tables(client, ctx, audience):
    """protects=#659 re-review major 1: a roadmap with no structured items keeps its
    written brief table and quarterly-timeline's Key milestones table as tables;
    fails_when=the separator rows are dropped; no_claim=rebuilt rows (no items)."""
    sections = _with_tables("quarterly-timeline")
    await seed_roadmap(ctx, sections=sections, template="quarterly-timeline", items=[])
    resp = await client.get(EXPORT, params={"audience": audience}, headers=ctx.as_("viewer"))
    assert resp.status_code == 200, resp.text
    html = resp.text
    assert not re.search(r"<p>\s*\|", html), html
    assert _tables(html) == 3, html
    assert re.search(r"<th[^>]*>\s*Quarter\s*</th>", html), html


async def test_board_of_a_version_without_items_says_so_in_words(client, ctx):
    """protects=owner decision 2026-10-26: a version with no roadmap_items renders, on
    Board, a sentence saying so (HTML, deck and publication), never the written text;
    fails_when=Board falls back to the prose or a table; no_claim=Team."""
    sections = _with_tables("quarterly-timeline")
    await seed_roadmap(ctx, sections=sections, template="quarterly-timeline", items=[],
                       publish=True)  # fmt: skip
    for url, params in (
        (EXPORT, {"audience": "board"}),
        (EXPORT, {"audience": "board", "layer": "brief"}),
        (f"/v1/documents/{SLUG}/publications/1/export", {"audience": "board"}),
    ):
        resp = await client.get(url, params=params, headers=ctx.as_("viewer"))
        assert resp.status_code == 200, resp.text
        text = _text(resp.text)
        assert variants.BOARD_NO_ITEMS in text, text
        assert _tables(resp.text) == 0, resp.text
        for mark in WRITTEN + ["Markerson", "Beta"]:
            assert mark not in text, (mark, text)
    deck = await client.get(DECK, params={"audience": "board"}, headers=ctx.as_("viewer"))
    assert deck.status_code == 200, deck.text
    assert variants.BOARD_NO_ITEMS in _text(" ".join(s["html"] for s in deck.json()["slides"]))


# Written owner, estimate and tracker parts as writers put them: (text, field).
WRITTEN_PARTS = [
    ("Owner: Dana M. Markerson.", "owner"),
    ("Owner: Dr. Markerson.", "owner"),
    ("Owners: Dana Markerson, Lee Q. Parkwood.", "owner"),
    ("**Owner:** Dana Markerson.", "owner"),
    ("Lead: Dana Markerson.", "owner"),
    ("DRI: Dana Markerson.", "owner"),
    ("Assignee: Dana Markerson.", "owner"),
    ("Owner (PM): Dana Markerson.", "owner"),
    ("Owned by Dana Markerson.", "owner"),
    ("Owner — Dana Markerson.", "owner"),
    ("Owner - Dana Markerson.", "owner"),
    ("Story points: 8 est-marker.", "effort"),
    ("Points: 8 est-marker.", "effort"),
    ("Size: L est-marker.", "effort"),
    ("Est: 3w est-marker.", "effort"),
    ("Est.: 3w est-marker.", "effort"),
    ("Estimate: 3 weeks est-marker.", "effort"),
    ("Jira: ENG-9 est-marker.", "tracker"),
    ("Ticket: ENG-9 est-marker.", "tracker"),
    ("Tracker: ENG-9 est-marker.", "tracker"),
]
SECRET = {"owner": "Markerson", "effort": "est-marker", "tracker": "est-marker"}


@pytest.mark.parametrize("part,field_", WRITTEN_PARTS)
@pytest.mark.parametrize("audience", ["team", "engineering"])
def test_every_written_form_of_owner_estimate_and_tracker(part, field_, audience):
    """protects=#659 re-review major 2: Team hides estimates and tracker keys and keeps
    owners; Engineering keeps all three; fails_when=a form leaks, or the text around it
    is lost; no_claim=Board (built from the items only)."""
    variant = variants.VARIANTS[audience]
    line = f"- Bulk import (must). {part} Why: day one (G1)."
    out = variants.redact(line, variant, [], [])
    hidden = field_ in variants.hidden_fields(variant)
    assert (SECRET[field_] not in out) is hidden, out
    assert out.startswith("- Bulk import (must).") and out.endswith("Why: day one (G1)."), out


HEADERS = [
    ("Owner(s)", "owner"),
    ("Owners", "owner"),
    ("Assignee", "owner"),
    ("Lead", "owner"),
    ("DRI", "owner"),
    ("Owner (PM)", "owner"),
    ("Story points", "effort"),
    ("Points", "effort"),
    ("Size", "effort"),
    ("Est.", "effort"),
    ("Estimate", "effort"),
    ("Jira", "tracker"),
    ("Ticket", "tracker"),
    ("Tracker", "tracker"),
]


@pytest.mark.parametrize("header,field_", HEADERS)
@pytest.mark.parametrize("audience", ["team", "engineering"])
def test_table_columns_headed_by_any_form_are_dropped(header, field_, audience):
    """protects=#659 re-review major 2: a column headed Owner(s), Assignee, Est., Jira…
    is dropped where the audience hides that field, and the table stays a table;
    fails_when=the column shows, or the separator row is lost; no_claim=prose."""
    variant = variants.VARIANTS[audience]
    table = f"| Item | {header} | Goal |\n|---|---|---|\n| Bulk import | est-marker | G1 |"
    out = variants.redact(table, variant, [], []).split("\n")
    hidden = field_ in variants.hidden_fields(variant)
    assert len(out) == 3 and variants._TABLE_SEP.match(out[1]), out
    assert ("est-marker" not in "\n".join(out)) is hidden, out
    assert len(variants._split_row(out[1])) == len(variants._split_row(out[0])), out


def test_prose_that_only_looks_like_a_label_is_kept():
    """protects=Team keeps prose: "Key points:" or "Sizes vary" are not estimate labels;
    fails_when=a sentence is cut; no_claim=labelled parts."""
    team = variants.VARIANTS["team"]
    line = "Key points: imports lead to reports. Sizes vary by plan."
    assert variants.redact(line, team, [], []) == line


async def test_a_tenant_with_no_confirmed_goals_shows_board_as_before(client, ctx):
    """protects=#659 re-review minor: with no confirmed goal in the tenant there is
    nothing to serve, so Board shows every item rather than none; fails_when=Board is
    empty with "4 items serve no confirmed goal"; no_claim=tenants with goals."""
    await seed_roadmap(ctx, served=())
    async with tenant_session(ctx.tenant_id) as s:
        for goal in await s.scalars(select(Entity).where(Entity.type == "goal")):
            goal.status = "proposed"
        await s.commit()
    resp = await client.get(EXPORT, params={"audience": "board"}, headers=ctx.as_("viewer"))
    assert resp.status_code == 200, resp.text
    text = _text(resp.text)
    assert "Bulk import" in text and "CSV parser" in text, text
    # Every item's row shows (no written card text); nothing is left out or flagged.
    assert "Confetti" in text and "Stickers" in text, text
    assert "Celebrate signups" not in text and "Signups feel celebrated" in text, text
    assert "left out" not in text and variants.NO_GOAL_FLAG not in text, text
    assert "\u2691 Confetti" not in text, text


async def test_loading_the_items_reads_the_goals_once(ctx, monkeypatch):
    """protects=#659 re-review minor: a render loads the confirmed goals once, not per
    item; fails_when=the goals query runs per item; no_claim=query count of the rest."""
    from sqlalchemy import event

    from oracle.db import get_engine
    from oracle.export import render

    await seed_roadmap(ctx)
    async with tenant_session(ctx.tenant_id) as s:
        ev = await render.load_export_version(s, SLUG, 1)
        goal_reads = []

        def count(conn, cursor, statement, *args):
            if "entities.type = " in statement and "entities.status = " in statement:
                goal_reads.append(statement)

        event.listen(get_engine().sync_engine, "before_cursor_execute", count)
        try:
            await render.load_audience(s, ev)
        finally:
            event.remove(get_engine().sync_engine, "before_cursor_execute", count)
    assert len(ev.items) == len(ITEMS)
    assert len(goal_reads) == 1, goal_reads
