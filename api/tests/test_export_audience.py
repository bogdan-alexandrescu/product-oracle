"""O5 lane 1: audience variants (spec-O5 §1, Lanes 1).

One roadmap version, four renderings: the registry (oracle.roadmap.variants), the
document's default audience (``documents.audience``, ``StartDraftIn.audience``), the
``audience=`` parameter of the version export, the deck and the publication export, and
a template's ``audiences`` front matter. Invented data only ("Example Labs").
"""

import hashlib
import re
from datetime import UTC, datetime

import pytest
from sqlalchemy import select

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


async def seed_roadmap(ctx, *, audience: str | None = None, publish: bool = False) -> None:
    """A roadmap version with structured items, a track and two tracker issues."""
    await seed_company(ctx.tenant_id)
    async with tenant_session(ctx.tenant_id) as s:
        prd = Document(slug="example-labs-prd", title="Example Labs PRD", kind="prd")
        doc = Document(
            slug=SLUG,
            title="Example Labs roadmap",
            kind="roadmap",
            status="approved",
            template="now-next-later",
            template_version="1",
            audience=audience,
        )
        s.add_all([prd, doc])
        await s.flush()
        markdown = "\n\n".join(f"{'#' * lv} {h} {{#{k}}}\n\n{b}" for k, lv, h, b in SECTIONS)
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
        for i, (key, level, heading, body) in enumerate(SECTIONS):
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
        for position, (key, horizon, title, outcome, extra) in enumerate(ITEMS):
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


def _text(html: str) -> str:
    return re.sub(r"\s+", " ", re.sub(r"<[^>]+>", " ", html))


@pytest.fixture
async def ctx():
    return await make_ctx("Example Labs")


async def _headers(ctx, who: str) -> dict[str, str]:
    if who == "run":
        return await run_headers(ctx, "owner")
    return ctx.as_(who)


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
    # Dependencies collapse into one risk line per item.
    assert "after CSV parser" in text
    # Prose sections are kept whole.
    assert "We grow activation this year." in text


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
    assert "audience Board" in resp.text


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
    team = await client.get(DECK, params={"audience": "team"}, headers=ctx.as_("viewer"))
    assert team.status_code == 200
    assert "Confetti" in " ".join(s["html"] for s in team.json()["slides"])
    assert "Team" in team.json()["banner"]


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
