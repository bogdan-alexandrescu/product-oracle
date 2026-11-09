"""approved-roadmap-to-simple (the owner, Nov 3: one roadmap, one set of dates): approving a
roadmap version applies its plan to the roadmap's items, so Simple reads what the approved
version says. (1) each item's dates from the version, with the date's source kept and shown,
never over a person's own dates; (2) a shipped item leaves the plan, a new item is added, an
item moved to the next PRD moves out; (3) the version's milestones are Simple's milestone
marks; (4) dependency marks follow the new dates; (5) one line says which version Simple
matches, or what differs. Also on demand for the latest approved version. Against Postgres.
Invented data only.
"""

import hashlib
from datetime import UTC, date, datetime

import pytest
from sqlalchemy import select

import oracle.main  # noqa: F401 - registers the lanes' checks
from oracle import company_time
from oracle.docs.models import Document, DocumentVersion
from oracle.launches.models import Launch
from oracle.roadmap.models import ProductTrack, RoadmapItem, ScheduleBasis, TrackMilestone
from oracle.tenancy import tenant_session
from tests.baseline_helpers import Ctx, make_ctx

NOW = datetime(2026, 11, 3, 20, 0, tzinfo=UTC)
ROADMAP = "/v1/simple/roadmap?roadmap=outdoors"
APPLY = "/v1/simple/roadmap/apply-approved?roadmap=outdoors"

PLAN = """# Outdoors v3 {#roadmap}

## Plan {#plan}

| Key | Item | Start | End | Dates from | Status |
|---|---|---|---|---|---|
| route-search | Route search | Dec 1, 2026 | Jan 8, 2027 | founder commitment | planned |
| trip-reports | Trip reports | Jan 11, 2027 | Jan 22, 2027 | engineering estimate | planned |
| photo-pins | Photo pins | Dec 7, 2026 | Dec 18, 2026 | set by Pat Example | planned |
| offline-sync | Offline sync | | | | shipped |
| keep-improving | Keep improving trail maps | Feb 1, 2027 | Mar 31, 2027 | engineering estimate | new |
| trail-chat | Trail chat | | | | next PRD |

## Milestones {#milestones}

| Milestone | Date | Gates | Counts when |
|---|---|---|---|
| Beta | Jan 15, 2027 | route-search | 50 hikers use it each week |
| Launch | Jan 29, 2027 | route-search, trip-reports | every gated item has shipped |
"""  # noqa: E501
PLAN_DATES = [date(2026, 12, 1), date(2027, 1, 8), date(2027, 1, 11), date(2027, 1, 22),
              date(2026, 12, 7), date(2026, 12, 18), date(2027, 2, 1), date(2027, 3, 31),
              date(2027, 1, 15), date(2027, 1, 29)]  # fmt: skip


@pytest.fixture(autouse=True)
def clock(monkeypatch):
    monkeypatch.setattr(company_time, "now", lambda: NOW)


async def _add(s, row):
    s.add(row)
    await s.flush()
    return row


async def _row(s, ids: dict, key: str) -> RoadmapItem:
    return await s.scalar(
        select(RoadmapItem).where(
            RoadmapItem.roadmap_version_id == ids["v3"], RoadmapItem.item_key == key
        )
    )


def _hash(body: str) -> str:
    return hashlib.sha256(body.encode()).hexdigest()


# The items of version 2 (and of version 3, carried forward): the old engineering estimates.
# Trip reports starts before Route search ends: a broken dependency under the old dates.
OLD = [
    ("offline-sync", "Offline sync", date(2026, 11, 2), date(2026, 11, 27), "engineering"),
    ("route-search", "Route search", date(2026, 11, 9), date(2027, 1, 20), "engineering"),
    ("trip-reports", "Trip reports", date(2026, 12, 14), date(2027, 1, 8), "engineering"),
    ("photo-pins", "Photo pins", date(2026, 12, 2), date(2026, 12, 30), "engineering"),
    ("trail-chat", "Trail chat", date(2027, 1, 4), date(2027, 2, 26), "engineering"),
]


async def world(*, person_dates: bool = True, approved: bool = False) -> tuple[Ctx, dict]:
    """A PRD (Trail maps, approved) with its track; the roadmap Outdoors: version 2 approved
    with five items on the old estimates, version 3 drafted from the PRD with the same
    items carried forward and the re-planned dates and milestones in its text. With
    ``person_dates`` a person set Photo pins' dates themselves (Dec 2 - Dec 30, typed)."""
    ctx = await make_ctx()
    owner = ctx.users["owner"].id
    async with tenant_session(ctx.tenant_id) as s:
        prd = await _add(s, Document(slug="trail-maps", title="Trail maps", kind="prd",
                                     status="approved", visibility="company"))  # fmt: skip
        pv = await _add(s, DocumentVersion(document_id=prd.id, number=1, markdown="# Trail maps",
                                           content_hash=_hash("# Trail maps"),
                                           approved_at=datetime(2026, 10, 1,
                                                                tzinfo=UTC)))  # fmt: skip
        track = await _add(s, ProductTrack(prd_document_id=prd.id, title="Trail maps",
                                           started_version_id=pv.id,
                                           current_version_id=pv.id))  # fmt: skip
        rm = await _add(s, Document(slug="outdoors", title="Outdoors", kind="roadmap",
                                    status="in_review", visibility="company"))  # fmt: skip
        track.roadmap_document_id = rm.id
        v2 = await _add(s, DocumentVersion(document_id=rm.id, number=2, markdown="# Outdoors",
                                           content_hash=_hash("# Outdoors"),
                                           source_version_id=pv.id,
                                           approved_at=datetime(2026, 10, 15,
                                                                tzinfo=UTC)))  # fmt: skip
        v3 = await _add(s, DocumentVersion(document_id=rm.id, number=3, markdown=PLAN,
                                           content_hash=_hash(PLAN), source_version_id=pv.id,
                                           approved_at=NOW if approved else None,
                                           approved_by=owner if approved else None))  # fmt: skip
        for v in (v2, v3):
            for i, (key, title, start, end, src) in enumerate(OLD):
                typed = person_dates and v is v3 and key == "photo-pins"
                s.add(RoadmapItem(roadmap_document_id=rm.id, roadmap_version_id=v.id,
                                  track_id=track.id, item_key=key, title=title, horizon="now",
                                  position=i, start_date=start, end_date=end,
                                  date_source="typed" if typed else src,
                                  depends_on=["route-search"] if key == "trip-reports" else [],
                                  prd_document_id=prd.id, prd_version_id=pv.id))  # fmt: skip
        for d in PLAN_DATES:
            s.add(ScheduleBasis(kind="estimate", reference="Lead estimate", status="verified",
                                supports_date=d, prd_document_id=prd.id, verified_by=owner,
                                verified_at=NOW))  # fmt: skip
        await s.commit()
        return ctx, {"prd": prd.id, "roadmap": rm.id, "v3": v3.id, "track": track.id}


async def approve(client, ctx: Ctx) -> None:
    r = await client.post("/v1/documents/outdoors/versions/3/approve", headers=ctx.as_("owner"))
    assert r.status_code == 200, r.text


async def read(client, ctx: Ctx, who: str = "owner") -> dict:
    r = await client.get(ROADMAP, headers=ctx.as_(who))
    assert r.status_code == 200, r.text
    return r.json()


def by_key(out: dict) -> dict[str, dict]:
    return {i["key"]: i for i in out["items"]}


async def test_approval_puts_the_versions_dates_on_the_items_with_their_source(client):
    """protects=(1) approving version 3 gives each item the version's start and end, with
    the date's source as the version names it, shown in Simple; a person's own dates stay;
    fails_when=Simple still shows the old engineering estimates, the source words are lost,
    or the person's own dates are replaced by the version's."""
    ctx, _ = await world()
    before = by_key(await read(client, ctx))
    assert before["route-search"]["end"]["date"] == "2027-01-20"
    await approve(client, ctx)
    items = by_key(await read(client, ctx))
    search = items["route-search"]
    assert (search["start"]["date"], search["end"]["date"]) == ("2026-12-01", "2027-01-08")
    assert not search["start"]["estimated"] and not search["end"]["estimated"]
    assert search["date_basis"] == "founder commitment"
    trips = items["trip-reports"]
    assert (trips["start"]["date"], trips["end"]["date"]) == ("2027-01-11", "2027-01-22")
    assert trips["date_basis"] == "engineering estimate"
    pins = items["photo-pins"]
    assert (pins["start"]["date"], pins["end"]["date"]) == ("2026-12-02", "2026-12-30")
    assert pins["date_basis"] is None


async def test_a_version_with_no_person_dates_sets_set_by_words(client):
    """protects=(1) 'set by <person>' is kept as the version writes it; fails_when=only the
    engineering words are kept."""
    ctx, _ = await world(person_dates=False)
    await approve(client, ctx)
    pins = by_key(await read(client, ctx))["photo-pins"]
    assert (pins["start"]["date"], pins["end"]["date"]) == ("2026-12-07", "2026-12-18")
    assert pins["date_basis"] == "set by Pat Example"


async def test_shipped_leaves_new_is_added_and_next_prd_moves_out(client):
    """protects=(2) the shipped item leaves the plan, marked shipped; the new item is on it
    with its dates; the item moved to the next PRD is off it; fails_when=Simple still shows
    the shipped item as planned work, lacks the new item, or keeps the moved item."""
    ctx, ids = await world()
    await approve(client, ctx)
    out = await read(client, ctx)
    items = by_key(out)
    assert "offline-sync" not in items and "trail-chat" not in items
    new = items["keep-improving"]
    assert new["title"] == "Keep improving trail maps"
    assert (new["start"]["date"], new["end"]["date"]) == ("2027-02-01", "2027-03-31")
    [line] = out["applied_versions"]
    assert line["shipped"] == ["Offline sync"]
    assert line["moved_out"] == ["Trail chat"]
    async with tenant_session(ctx.tenant_id) as s:
        row = await _row(s, ids, "offline-sync")
        assert row.plan_state == "shipped"


async def test_the_versions_milestones_are_simples_milestone_marks(client):
    """protects=(3) the version's milestones (name, date, gated items, how each counts) are
    Simple's milestone marks; fails_when=GET /v1/simple/roadmap returns no milestones."""
    ctx, _ = await world()
    assert (await read(client, ctx))["milestones"] == []
    await approve(client, ctx)
    out = await read(client, ctx)
    items = by_key(out)
    got = [(m["name"], m["date"], sorted(m["item_ids"]), m["done_when"]) for m in out["milestones"]]
    assert got == [
        ("Beta", "2027-01-15", [items["route-search"]["id"]], ["50 hikers use it each week"]),
        ("Launch", "2027-01-29", sorted([items["route-search"]["id"], items["trip-reports"]["id"]]),
         ["every gated item has shipped"]),
    ]  # fmt: skip
    # Approving again (on demand) never adds them twice.
    r = await client.post(APPLY, headers=ctx.as_("owner"))
    assert r.status_code == 200, r.text
    assert len((await read(client, ctx))["milestones"]) == 2


async def test_dependency_marks_follow_the_new_dates(client):
    """protects=(4) the broken dependency mark is recomputed from the version's dates;
    fails_when=Trip reports still reads broken after the re-plan moved it after Route
    search."""
    ctx, _ = await world()
    flags = by_key(await read(client, ctx))["trip-reports"]["flags"]
    assert any(f["kind"] == "dependency_order" for f in flags)
    await approve(client, ctx)
    flags = by_key(await read(client, ctx))["trip-reports"]["flags"]
    assert not any(f["kind"] == "dependency_order" for f in flags)


async def test_one_line_says_simple_matches_the_version_or_what_differs(client):
    """protects=(5) Simple says it matches roadmap version 3 (approved when, with a link),
    or what differs when a person changed something; fails_when=no line, or a person's
    later change is not named."""
    ctx, ids = await world(person_dates=False)
    assert (await read(client, ctx))["applied_versions"] == []
    await approve(client, ctx)
    [line] = (await read(client, ctx))["applied_versions"]
    assert line["version"] == 3 and line["matches"] is True and line["differences"] == []
    assert line["approved_at"]
    assert line["href"] == "/documents/outdoors/v/3"
    assert line["roadmap"]["slug"] == "outdoors"
    async with tenant_session(ctx.tenant_id) as s:
        row = await _row(s, ids, "trip-reports")
        row.end_date, row.date_source = date(2027, 1, 27), "typed"
        await s.commit()
    [line] = (await read(client, ctx))["applied_versions"]
    assert line["matches"] is False
    assert line["differences"] == ["Trip reports ends Jan 27, version 3 says Jan 22"]


async def test_the_persons_own_dates_show_as_a_difference(client):
    """protects=(1)+(5) a person's own dates kept over the version are named as a
    difference; fails_when=the line says it matches."""
    ctx, _ = await world()
    await approve(client, ctx)
    [line] = (await read(client, ctx))["applied_versions"]
    assert line["matches"] is False
    assert line["differences"] == [
        "Photo pins runs Dec 2 to Dec 30, version 3 says Dec 7 to Dec 18"
    ]


async def test_on_demand_applies_the_latest_approved_version(client):
    """protects=the latest approved version is applied on demand (an approver and up);
    fails_when=only a new approval applies a plan, or a viewer may apply it."""
    ctx, _ = await world(person_dates=False, approved=True)
    assert by_key(await read(client, ctx))["route-search"]["end"]["date"] == "2027-01-20"
    r = await client.post(APPLY, headers=ctx.as_("viewer"))
    assert r.status_code == 403, r.text
    r = await client.post(APPLY, headers=ctx.as_("approver"))
    assert r.status_code == 200, r.text
    assert r.json()["version"] == 3
    items = by_key(await read(client, ctx))
    assert items["route-search"]["end"]["date"] == "2027-01-08"
    assert "offline-sync" not in items and "keep-improving" in items
    # The viewer reads the same plan.
    assert by_key(await read(client, ctx, "viewer"))["route-search"]["end"]["date"] == "2027-01-08"


async def test_a_version_with_no_plan_table_changes_nothing(client):
    """protects=a roadmap version whose text has no plan table leaves its items as they
    are; fails_when=its items are dropped or re-dated."""
    ctx, _ = await world(person_dates=False)
    async with tenant_session(ctx.tenant_id) as s:
        v3 = await s.scalar(select(DocumentVersion).where(DocumentVersion.number == 3))
        v3.markdown = "# Outdoors v3\n\nThe same plan.\n"
        v3.content_hash = _hash(v3.markdown)
        await s.commit()
    await approve(client, ctx)
    out = await read(client, ctx)
    assert by_key(out)["route-search"]["end"]["date"] == "2027-01-20"
    assert "offline-sync" in by_key(out)
    assert out["applied_versions"] == []


async def test_launches_are_planned_from_the_applied_plan(client):
    """protects=(2) approving plans launches after the version's plan is applied: the item it
    adds gets one, the items it marks shipped or moves to the next PRD get none;
    fails_when=launches are planned from the carried-forward items before the plan."""
    ctx, ids = await world()
    await approve(client, ctx)
    async with tenant_session(ctx.tenant_id) as s:
        keys = {k for launch in await s.scalars(select(Launch)) for k in launch.item_keys}
    assert "keep-improving" in keys
    assert "offline-sync" not in keys and "trail-chat" not in keys
    assert {"route-search", "trip-reports", "photo-pins"} <= keys


async def test_a_later_version_with_no_plan_does_not_claim_the_earlier_one(client):
    """protects=(5) once version 4 is approved without plan tables, Simple no longer says it
    matches version 3; fails_when=its carried-forward rows keep version 3's applied mark and
    the line still reads "Matches roadmap version 3"."""
    ctx, ids = await world(person_dates=False)
    await approve(client, ctx)
    assert (await read(client, ctx))["applied_versions"][0]["version"] == 3
    async with tenant_session(ctx.tenant_id) as s:
        v3 = await s.get(DocumentVersion, ids["v3"])
        body = "# Outdoors v4\n\nThe same plan, a new intro.\n"
        v4 = await _add(s, DocumentVersion(document_id=ids["roadmap"], number=4, markdown=body,
                                           content_hash=_hash(body),
                                           source_version_id=v3.source_version_id))  # fmt: skip
        for r in await s.scalars(
            select(RoadmapItem).where(RoadmapItem.roadmap_version_id == ids["v3"])
        ):
            s.add(RoadmapItem(roadmap_document_id=r.roadmap_document_id,
                              roadmap_version_id=v4.id, track_id=r.track_id,
                              item_key=r.item_key, title=r.title, horizon=r.horizon,
                              position=r.position, start_date=r.start_date,
                              end_date=r.end_date, date_source=r.date_source,
                              date_basis=r.date_basis, plan_state=r.plan_state,
                              applied=r.applied, prd_document_id=r.prd_document_id,
                              prd_version_id=r.prd_version_id))  # fmt: skip
        await s.commit()
    r = await client.post("/v1/documents/outdoors/versions/4/approve", headers=ctx.as_("owner"))
    assert r.status_code == 200, r.text
    out = await read(client, ctx)
    assert out["applied_versions"] == []
    assert by_key(out)["route-search"]["end"]["date"] == "2027-01-08"


async def test_a_persons_milestone_of_the_same_name_is_left_alone(client):
    """protects=(3) a milestone a person made is never taken over by the version's one of the
    same name, nor deleted by a later apply; fails_when=its gates, basis and version are
    replaced, or it is deleted."""
    ctx, ids = await world()
    async with tenant_session(ctx.tenant_id) as s:
        own = await _add(s, TrackMilestone(track_id=ids["track"], name="Beta", horizon="now",
                                           status="planned",
                                           item_keys=["photo-pins"]))  # fmt: skip
        own_id = own.id
        await s.commit()
    await approve(client, ctx)
    r = await client.post(APPLY, headers=ctx.as_("owner"))
    assert r.status_code == 200, r.text
    async with tenant_session(ctx.tenant_id) as s:
        m = await s.get(TrackMilestone, own_id)
        assert m is not None
        assert (m.target_date, m.item_keys, m.roadmap_version_id, m.basis_ids) == (
            None,
            ["photo-pins"],
            None,
            [],
        )
        names = [x.name for x in await s.scalars(
            select(TrackMilestone).where(TrackMilestone.track_id == ids["track"])
        )]  # fmt: skip
    assert sorted(names) == ["Beta", "Launch"]


async def test_an_added_item_never_takes_a_trashed_features_key(client):
    """protects=(trash-features-goals review) the plan's new item does not take the key of
    a feature in Trash, so Restore brings that feature back beside it; fails_when=the new
    item takes the key and Restore refuses (409)."""
    ctx, ids = await world()
    async with tenant_session(ctx.tenant_id) as s:
        for v in await s.scalars(
            select(DocumentVersion).where(DocumentVersion.document_id == ids["roadmap"])
        ):
            s.add(RoadmapItem(roadmap_document_id=ids["roadmap"], roadmap_version_id=v.id,
                              track_id=ids["track"], item_key="keep-improving",
                              title="Keep improving", horizon="later", position=9,
                              prd_document_id=ids["prd"]))  # fmt: skip
        await s.commit()
    old = by_key(await read(client, ctx))["keep-improving"]["id"]
    r = await client.delete(f"/v1/simple/roadmap/items/{old}", headers=ctx.as_("owner"))
    assert r.status_code == 200, r.text
    await approve(client, ctx)
    added = by_key(await read(client, ctx))
    new = next(i for i in added.values() if i["title"] == "Keep improving trail maps")
    assert new["key"] != "keep-improving"
    r = await client.post(f"/v1/simple/roadmap/items/{old}/restore", headers=ctx.as_("owner"))
    assert r.status_code == 200, r.text
    items = by_key(await read(client, ctx))
    assert items["keep-improving"]["title"] == "Keep improving" and new["key"] in items


async def test_a_plan_row_never_gives_a_live_items_code_to_a_second_item(client):
    """protects=(every-field) a plan row whose title code a live item has already ("F-31 Launch
    flow" while Trip reports reads "F-31 Alert routing by team") adds no second item: the live
    one stays, the approval goes through, and the line says in plain words that the row was
    not added, on approval and on demand; fails_when=two items read F-31, or the approval
    fails; no_claim=a row matched by its key (it updates that item)."""
    ctx, ids = await world(person_dates=False)
    async with tenant_session(ctx.tenant_id) as s:
        v3 = await s.get(DocumentVersion, ids["v3"])
        v3.markdown = PLAN.replace("| keep-improving | Keep improving trail maps |",
                                   "| launch-flow | F-31 Launch flow |")  # fmt: skip
        for r in await s.scalars(select(RoadmapItem).where(RoadmapItem.item_key == "photo-pins")):
            r.title = "F-31 Alert routing by team"
        await s.commit()
    await approve(client, ctx)
    out = await read(client, ctx)
    codes = [i["code"] for i in out["items"]]
    assert codes.count("F-31") == 1, codes
    assert "launch-flow" not in by_key(out)
    said = "F-31 Launch flow was not added: F-31 is already the code of F-31 Alert routing by team"
    [line] = out["applied_versions"]
    assert said in line["differences"] and line["matches"] is False
    r = await client.post(APPLY, headers=ctx.as_("approver"))
    assert r.status_code == 200, r.text
    assert said in r.json()["differences"]
    assert [i["code"] for i in (await read(client, ctx))["items"]].count("F-31") == 1


async def test_a_plan_row_never_gives_the_code_a_live_item_shows_to_a_second_item(client):
    """protects=(every-field) the code an item shows comes from its feature first: a plan row
    "F-31 Launch flow" while Photo pins shows F-31 by its feature adds no second item, and the
    line says so in plain words; fails_when=two items show F-31."""
    from oracle.baseline.models import Entity

    ctx, ids = await world(person_dates=False)
    async with tenant_session(ctx.tenant_id) as s:
        feature = Entity(type="feature", key="F-31", title="Pins", status="confirmed",
                         origin="user", attrs={})  # fmt: skip
        s.add(feature)
        await s.flush()
        v3 = await s.get(DocumentVersion, ids["v3"])
        v3.markdown = PLAN.replace("| keep-improving | Keep improving trail maps |",
                                   "| launch-flow | F-31 Launch flow |")  # fmt: skip
        for r in await s.scalars(select(RoadmapItem).where(RoadmapItem.item_key == "photo-pins")):
            r.feature_id = feature.id
            holder = r.title
        await s.commit()
    await approve(client, ctx)
    out = await read(client, ctx)
    codes = [i["code"] for i in out["items"]]
    assert codes.count("F-31") == 1, codes
    assert "launch-flow" not in by_key(out)
    said = f"F-31 Launch flow was not added: F-31 is already the code of F-31 {holder}"
    [line] = out["applied_versions"]
    assert said in line["differences"], line
