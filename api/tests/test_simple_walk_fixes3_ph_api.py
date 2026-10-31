"""The owner's production walk of Simple mode (P4, P11). Against Postgres; invented PRDs.

Test cards (protects / fails_when / no_claim):

- test_owner_is_the_documents_owner: protects=an approved PRD's one-pager names the
  document's owner (the person who brought it in, its first version's importer) even when
  a later version came from a service token, and a PRD a service token imported names the
  person who approved it; ``owner`` is null only with no such person; fails_when=the meta
  reads "No owner yet" for a PRD that has an owner; no_claim=the web's wording (spec).
- test_span_from_dated_milestones: protects=the header's span runs from the earliest start
  of the items under dated milestones to the latest milestone date (page and PDF), never
  out to undated items' estimated windows; fails_when=the span ends on an item's estimated
  end (a year out) or on an item with no milestone; no_claim=the plan strip (its tests).
- test_no_dated_milestone_no_span: protects=a PRD whose items carry no dated milestone has
  no span (null; the PDF prints none); fails_when=the estimated windows' year shows;
  no_claim=the timeline items.
- test_new_prd_version_leaves_items_with_no_section: protects=an item with no PRD section
  is not marked stale by a new PRD version (nothing of its own changed), while an item whose
  section changed is; fails_when=every section-less item goes stale on any new version;
  no_claim=entity-driven staleness (test_roadmap_item_staleness).
- test_track_headline_counts_only_own_staleness: protects=items an earlier rule marked
  stale only for "the PRD has a new version (N)" are not stale on the track: the headline
  never reads "N of N items need attention (N stale)"; an item stale for its own reason is
  counted, in plain words ("1 may be out of date"); fails_when=the headline counts the
  whole-PRD marks or says "stale"; no_claim=alerts' wording.
- test_headline_plain_when_only_the_prd_moved: protects=a track at risk only because the
  PRD has a newer approved version says that, never "0 of N items need attention";
  fails_when=the headline counts zero items; no_claim=the web's chip.
"""

from datetime import UTC, datetime

from sqlalchemy import select, update

from oracle.docs.models import Document, DocumentVersion
from oracle.roadmap import views
from oracle.roadmap.models import RoadmapItem
from oracle.simple import one_pager
from oracle.tenancy import tenant_session
from tests.fixtures import import_draft
from tests.test_roadmap import (  # noqa: F401 - fixtures
    approved_prd,
    built_roadmap,
    owner,
    runtime,
)
from tests.test_roadmap_item_staleness import items, prd_v2
from tests.test_simple_one_pager_api import (
    MD,
    PRD,
    clock,  # noqa: F401 - the autouse clock
    get,
    world,
)
from tests.test_simple_one_pager_polish import nm, seed_slice
from tests.test_simple_roadmap_api import NOW, Seed


async def _approve(ctx, slug: str, number: int, by=None) -> None:
    async with tenant_session(ctx.tenant_id) as s:
        doc = await s.scalar(select(Document).where(Document.slug == slug))
        v = await s.scalar(
            select(DocumentVersion).where(
                DocumentVersion.document_id == doc.id, DocumentVersion.number == number
            )
        )
        v.approved_at = NOW
        v.approved_by = by
        await s.commit()


async def _pdf(ctx, slug: str = "guided-setup") -> str:
    from oracle.auth.deps import Principal

    async with tenant_session(ctx.tenant_id) as s:
        p = Principal(tenant_id=ctx.tenant_id, kind="user", role="viewer",
                      user_id=ctx.users["viewer"].id)  # fmt: skip
        html, _ = await one_pager.pdf_html(s, p, slug)
    return html


async def test_owner_is_the_documents_owner(client):
    ctx = await world(client)
    # A later version pushed by a service token, approved: still the document's owner.
    v2 = PRD.replace("A sample project created on day one", "A guided tour on day one")
    r = await client.post("/v1/documents/guided-setup/versions", content=v2.encode(),
                          headers=MD | ctx.as_("token"))  # fmt: skip
    assert r.status_code in (200, 201), r.text
    await _approve(ctx, "guided-setup", 2)
    view = await get(client, ctx, "viewer")
    assert view["version"] == 2
    assert view["owner"] and view["owner"]["name"] == nm(ctx.users["owner"])
    html = await _pdf(ctx)
    assert f"owner {nm(ctx.users['owner'])}" in html and "No owner yet" not in html

    # Imported by a service token and approved by a person: that person owns it.
    r = await client.post("/v1/documents/plan-d/versions", content=PRD.encode(),
                          headers=MD | ctx.as_("token"))  # fmt: skip
    assert r.status_code in (200, 201), r.text
    await _approve(ctx, "plan-d", 1, by=ctx.users["approver"].id)
    assert (await get(client, ctx, "viewer", "plan-d"))["owner"]["name"] == (
        nm(ctx.users["approver"])
    )

    # Nobody at all: no owner yet.
    r = await client.post("/v1/documents/plan-e/versions", content=PRD.encode(),
                          headers=MD | ctx.as_("token"))  # fmt: skip
    assert r.status_code in (200, 201), r.text
    assert (await get(client, ctx, "viewer", "plan-e"))["owner"] is None


async def test_span_from_dated_milestones(client):
    ctx = await world(client)
    await seed_slice(ctx)  # M1 (Nov 20) and M3 (Jan 29) dated; two items with none
    view = await get(client, ctx, "viewer")
    assert (view["span_start"], view["span_end"]) == ("2026-10-05", "2027-01-29")
    html = await _pdf(ctx)
    assert "2026-10-05 – 2027-01-29" in html
    assert "2027-03-31" not in html.split("<body", 1)[-1].split("class='plan'", 1)[0]


async def test_no_dated_milestone_no_span(client):
    ctx = await world(client)
    async with tenant_session(ctx.tenant_id) as s:
        seed = Seed(s)
        doc = await s.scalar(select(Document).where(Document.slug == "guided-setup"))
        pv = await s.scalar(select(DocumentVersion).where(DocumentVersion.document_id == doc.id))
        rv = await seed.version(await seed.doc("setup-roadmap", "roadmap"))
        await seed.item(rv, pv, "undated-now", horizon="now")
        await seed.item(rv, pv, "undated-later", horizon="later")
        await seed.item(rv, pv, "named", horizon="next", milestone={"name": "M2"})
        await s.commit()
    view = await get(client, ctx, "viewer")
    assert view["timeline"], view  # the items are there, estimated
    assert view["span_start"] is None and view["span_end"] is None
    html = await _pdf(ctx)
    assert " – 20" not in html.split("class='plan'", 1)[0]


async def _section_less(tenant_id, key: str) -> None:
    async with tenant_session(tenant_id) as s:
        await s.execute(
            update(RoadmapItem).where(RoadmapItem.item_key == key).values(prd_section_key=None)
        )
        await s.commit()


async def test_new_prd_version_leaves_items_with_no_section(client, owner, runtime):  # noqa: F811
    tenant_id, auth = owner
    await approved_prd(client, auth)
    await built_roadmap(client, auth, runtime)
    await _section_less(tenant_id, "payment-step")
    assert (await import_draft(client, auth, prd_v2())).status_code == 201
    got = await items(client, auth)
    assert got["payment-step"]["freshness"] == "fresh", got["payment-step"]
    assert got["shipping-step"]["freshness"] == "potentially_stale"
    assert got["shipping-step"]["stale_reasons"] == ["PRD section s-5-2 changed in version 2"]


async def _mark(tenant_id, key: str | None, reason: str) -> None:
    async with tenant_session(tenant_id) as s:
        q = update(RoadmapItem)
        if key is not None:
            q = q.where(RoadmapItem.item_key == key)
        await s.execute(
            q.values(
                freshness="potentially_stale",
                stale_since=datetime(2026, 10, 21, tzinfo=UTC),
                stale_reasons=[reason],
            )
        )
        await s.commit()


async def _track(client, auth) -> dict:
    tracks = (await client.get("/v1/tracks", headers=auth)).json()
    assert len(tracks) == 1, tracks
    return (await client.get(f"/v1/tracks/{tracks[0]['id']}", headers=auth)).json()


async def test_track_headline_counts_only_own_staleness(client, owner, runtime):  # noqa: F811
    tenant_id, auth = owner
    await approved_prd(client, auth)
    await built_roadmap(client, auth, runtime)
    # As production rows read: every item marked by the earlier whole-PRD rule.
    await _mark(tenant_id, None, "the PRD has a new version (2)")
    track = await _track(client, auth)
    assert track["counts"]["stale"] == 0, track["headline"]
    assert all(r["kind"] != "stale" for i in track["at_risk"] for r in i["reasons"])
    assert "stale" not in track["headline"]
    assert f"{track['counts']['items']} of {track['counts']['items']}" not in track["headline"]

    # One item's own section changed: that one counts, in plain words.
    await _mark(tenant_id, "shipping-step", "PRD section s-5-2 changed in version 2")
    track = await _track(client, auth)
    assert track["counts"]["stale"] == 1
    assert track["health"] in ("at_risk", "off_track")
    headline = track["headline"]
    assert "1 of 2 items needs attention (may be out of date)" in headline, headline
    assert "stale" not in track["headline"]
    reasons = {i["item_key"]: [r["detail"] for r in i["reasons"] if r["kind"] == "stale"]
               for i in track["at_risk"]}  # fmt: skip
    assert reasons.get("shipping-step") == ["PRD section s-5-2 changed in version 2"]
    assert not reasons.get("payment-step")


def test_headline_plain_when_only_the_prd_moved():
    counts = {"items": 40, "now": 40, "next": 0, "later": 0, "at_risk": 0, "blocked": 0,
              "stale": 0, "slipping": 0, "done": 0}  # fmt: skip
    text = views._headline("at_risk", counts, None, 3)
    assert text == "At risk: The PRD has a newer approved version (v3)."
    assert "0 of" not in text and "need attention" not in text
    counts |= {"at_risk": 2, "stale": 1, "blocked": 1}
    assert views._headline("at_risk", counts, None) == (
        "At risk: 2 of 40 items need attention (1 blocked, 1 may be out of date)."
    )
    assert views._headline("on_track", {**counts, "items": 1}, None) == "On track: 1 item."
