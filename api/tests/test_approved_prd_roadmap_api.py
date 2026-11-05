"""approved-prd-roadmap (the owner's pick: 'Add them as a roadmap draft'): approving a PRD
version puts its dated items (the dates the engineering lead accepted; end-only items stay
end-only) and its milestones (as key dates) into its roadmap's working draft, each marked
as coming from that PRD; no run. Approving again replaces that PRD's items in the draft;
an item already on the published roadmap only adds what changed. Against Postgres.
"""

import hashlib
import uuid
from datetime import UTC, date, datetime

import pytest
from sqlalchemy import select

import oracle.main  # noqa: F401 - registers the lanes' checks
from oracle import company_time
from oracle.docs.models import Document, DocumentVersion
from oracle.roadmap.models import DraftRoadmap, RoadmapItem, ScheduleBasis
from oracle.simple.models import RoadmapKeyDate, SimpleDraft
from oracle.tenancy import tenant_session
from tests.baseline_helpers import Ctx, make_ctx

NOW = datetime(2026, 11, 2, 20, 0, tzinfo=UTC)
ROADMAP = "/v1/simple/roadmap"
DRAFTS = "/v1/simple/drafts"
PRD = "trail-maps"

MILESTONES = """
## Plan {{#plan}}

| Milestone | Name | Start | End |
|---|---|---|---|
| M1 | Private beta | 2026-11-09 | 2026-12-04 |
| M2 | Launch | 2026-12-07 | {end} |
"""


@pytest.fixture(autouse=True)
def clock(monkeypatch):
    moment = {"now": NOW}
    monkeypatch.setattr(company_time, "now", lambda: moment["now"])
    return moment


def _body(n: int, launch_end: str) -> str:
    return (
        f"# Trail maps v{n}\n\n## Summary {{#summary}}\n\nHikers see offline trail maps.\n"
        + MILESTONES.format(end=launch_end)
    )


async def _add(s, row):
    s.add(row)
    await s.flush()
    return row


async def _version(s, doc: Document, n: int, body: str) -> DocumentVersion:
    return await _add(
        s,
        DocumentVersion(
            document_id=doc.id,
            number=n,
            markdown=body,
            content_hash=hashlib.sha256(body.encode()).hexdigest(),
        ),
    )


async def _items(s, doc: Document, pv: DocumentVersion, rm: Document, items: list[dict]) -> None:
    """The version's derived items (E1), ready."""
    dr = await _add(s, DraftRoadmap(prd_document_id=doc.id, prd_version_id=pv.id, status="ready"))
    for i, it in enumerate(items):
        s.add(RoadmapItem(roadmap_document_id=rm.id, draft_roadmap_id=dr.id, item_key=it["key"],
                          title=it["title"], horizon="now", position=i,
                          start_date=it.get("start"), end_date=it.get("end"),
                          prd_document_id=doc.id, prd_version_id=pv.id))  # fmt: skip
    await s.flush()


async def world() -> tuple[Ctx, dict[str, uuid.UUID]]:
    """A published roadmap with one item from the PRD (Offline sync, ends Dec 15); the
    PRD's version 1, not approved yet, with four derived items: Offline sync unchanged,
    Route search end-only (the lead accepted Jan 8), Trip reports dated, Ideas undated."""
    ctx = await make_ctx()
    owner = ctx.users["owner"].id
    async with tenant_session(ctx.tenant_id) as s:
        prd = await _add(s, Document(slug=PRD, title="Trail maps", kind="prd", status="draft",
                                     visibility="company"))  # fmt: skip
        rm = await _add(s, Document(slug="outdoors", title="Outdoors", kind="roadmap",
                                    status="approved", visibility="company"))  # fmt: skip
        body = "# Outdoors v1\n"
        rv = await _add(s, DocumentVersion(
            document_id=rm.id, number=1, markdown=body,
            content_hash=hashlib.sha256(body.encode()).hexdigest(),
            approved_at=datetime(2026, 10, 1, tzinfo=UTC)))  # fmt: skip
        pv = await _version(s, prd, 1, _body(1, "2027-01-29"))
        s.add(RoadmapItem(roadmap_document_id=rm.id, roadmap_version_id=rv.id,
                          item_key="offline-sync", title="Offline sync", horizon="now",
                          position=0, start_date=date(2026, 11, 9), end_date=date(2026, 12, 15),
                          date_source="typed", prd_document_id=prd.id,
                          prd_version_id=pv.id))  # fmt: skip
        await _items(s, prd, pv, rm, [
            {"key": "offline-sync", "title": "Offline sync",
             "start": date(2026, 11, 9), "end": date(2026, 12, 15)},
            {"key": "route-search", "title": "Route search"},
            {"key": "trip-reports", "title": "Trip reports",
             "start": date(2026, 12, 1), "end": date(2027, 1, 15)},
            {"key": "ideas", "title": "Ideas board"},
        ])  # fmt: skip
        s.add(ScheduleBasis(kind="estimate", reference="Lead estimate", status="verified",
                            supports_date=date(2027, 1, 8), prd_document_id=prd.id,
                            item_key="route-search", verified_by=owner,
                            verified_at=NOW))  # fmt: skip
        await s.commit()
        return ctx, {"prd": prd.id, "roadmap": rm.id}


async def approve(client, ctx: Ctx, n: int) -> None:
    r = await client.post(f"/v1/documents/{PRD}/versions/{n}/approve", headers=ctx.as_("owner"))
    assert r.status_code == 200, r.text


async def read(client, ctx: Ctx) -> dict:
    r = await client.get(ROADMAP, headers=ctx.as_("owner"))
    assert r.status_code == 200, r.text
    return r.json()


def by_key(out: dict) -> dict[str, dict]:
    return {i["key"]: i for i in out["items"]}


def assert_milestones_once(out: dict, expected: list[tuple[str, str]]) -> None:
    """ah-prd-milestones-once (the owner's pick: 'Read-only from the PRD'): no own key date
    comes from the PRD; each milestone is there once, read-only, naming the PRD."""
    assert [k for k in out["key_dates"] if k["prd"] is None] == []
    got = sorted((k["name"], k["date"]) for k in out["key_dates"])
    assert got == sorted(expected)
    assert all(k["prd"]["slug"] == PRD and not k["in_draft"] for k in out["key_dates"])


async def test_approval_writes_the_prds_dated_items_and_key_dates_into_the_draft(client):
    """protects=approving a PRD version adds its dated items (the lead's accepted date,
    end-only kept end-only) to its roadmap's working draft, marked as from the PRD, and the
    draft says how many; its milestones show once each, read-only from the PRD, never as
    the draft's own key dates; fails_when=approval writes nothing (only a Build roadmap run
    reaches the roadmap), an undated item is added, an end-only item gets a typed start, an
    unchanged published item is added again, or a milestone is copied into the draft as an
    editable key date beside the read-only one."""
    ctx, ids = await world()
    await approve(client, ctx, 1)
    out = await read(client, ctx)
    items = by_key(out)
    assert set(items) == {"offline-sync", "route-search", "trip-reports"}
    search = items["route-search"]
    assert search["end"]["date"] == "2027-01-08" and not search["end"]["estimated"]
    assert search["start"]["estimated"] is True
    assert items["trip-reports"]["start"]["date"] == "2026-12-01"
    assert items["trip-reports"]["end"]["date"] == "2027-01-15"
    for k in ("route-search", "trip-reports"):
        assert items[k]["prd"]["slug"] == PRD, k
    assert_milestones_once(
        out, [("M1 · Private beta", "2026-12-04"), ("M2 · Launch", "2027-01-29")]
    )
    drafts = (await client.get(DRAFTS, headers=ctx.as_("owner"))).json()
    [d] = [d for d in drafts if d["document"]["id"] == str(ids["roadmap"])]
    [src] = d["from_prds"]
    assert src["prd"]["slug"] == PRD and src["items"] == 2 and src["key_dates"] == 0
    assert d["can_submit"] is True
    # A viewer reads the published roadmap: none of the draft's additions.
    r = await client.get(ROADMAP, headers=ctx.as_("viewer"))
    assert set(by_key(r.json())) == {"offline-sync"}


async def test_reapproval_replaces_the_prds_items_rather_than_adding_them_again(client):
    """protects=approving a later version of the PRD replaces its items and key dates in the
    draft (no duplicates); an item already published only adds what changed;
    fails_when=a second approval doubles the items or key dates, keeps a removed one, or
    leaves a changed published item as it was."""
    ctx, ids = await world()
    await approve(client, ctx, 1)
    async with tenant_session(ctx.tenant_id) as s:
        prd = await s.get(Document, ids["prd"])
        rm = await s.get(Document, ids["roadmap"])
        pv2 = await _version(s, prd, 2, _body(2, "2027-02-05"))
        await _items(s, prd, pv2, rm, [
            {"key": "offline-sync", "title": "Offline sync",
             "start": date(2026, 11, 9), "end": date(2026, 12, 22)},
            {"key": "route-search", "title": "Route search"},
        ])  # fmt: skip
        await s.commit()
    await approve(client, ctx, 2)
    out = await read(client, ctx)
    items = by_key(out)
    assert sorted(i["key"] for i in out["items"]) == ["offline-sync", "route-search"]
    assert items["offline-sync"]["end"]["date"] == "2026-12-22"
    assert items["route-search"]["end"]["date"] == "2027-01-08"
    # The PRD's milestones once each, read-only and as version 2 has them; no own copies.
    assert_milestones_once(
        out, [("M1 · Private beta", "2026-12-04"), ("M2 · Launch", "2027-02-05")]
    )
    drafts = (await client.get(DRAFTS, headers=ctx.as_("owner"))).json()
    [d] = [d for d in drafts if d["document"]["id"] == str(ids["roadmap"])]
    [src] = d["from_prds"]
    assert src["items"] == 2 and src["key_dates"] == 0 and src["version"] == 2
    async with tenant_session(ctx.tenant_id) as s:
        added = list(
            await s.scalars(
                select(RoadmapItem.item_key).where(
                    RoadmapItem.simple_draft_id.is_not(None),
                    RoadmapItem.roadmap_version_id.is_(None),
                )
            )
        )
        assert added == ["route-search"]
        n = await s.scalar(select(SimpleDraft.id).where(SimpleDraft.status == "working"))
        assert n is not None
    # Approving the same version again changes nothing.
    await approve(client, ctx, 2)
    again = await read(client, ctx)
    assert sorted(i["key"] for i in again["items"]) == ["offline-sync", "route-search"]
    assert_milestones_once(
        again, [("M1 · Private beta", "2026-12-04"), ("M2 · Launch", "2027-02-05")]
    )


CHANGES = "/v1/simple/changes"


async def change(client, ctx: Ctx, op: str, target: dict, before: dict, after: dict) -> dict:
    r = await client.post(CHANGES, json={"op": op, "target": target, "before": before,
                                         "after": after}, headers=ctx.as_("owner"))  # fmt: skip
    assert r.status_code == 201, r.text
    return r.json()["change"]


async def retitle(client, ctx: Ctx, item: dict, title: str) -> dict:
    return await change(client, ctx, "edit_title", {"item_id": item["id"]},
                        {"title": item["title"]}, {"title": title})  # fmt: skip


async def source(client, ctx: Ctx, roadmap: uuid.UUID) -> dict:
    drafts = (await client.get(DRAFTS, headers=ctx.as_("owner"))).json()
    [d] = [d for d in drafts if d["document"]["id"] == str(roadmap)]
    return d


async def version(ctx: Ctx, ids: dict, n: int, launch_end: str, items: list[dict]) -> None:
    async with tenant_session(ctx.tenant_id) as s:
        prd = await s.get(Document, ids["prd"])
        rm = await s.get(Document, ids["roadmap"])
        pv = await _version(s, prd, n, _body(n, launch_end))
        await _items(s, prd, pv, rm, items)
        await s.commit()


async def test_reapproval_keeps_the_owners_edits_to_the_prds_items(client):
    """protects=approving the PRD again keeps what the owner changed in the draft on its
    items (an added item's title, a published item's title), and the change that did it
    still undoes; fails_when=re-approval deletes the edited added item (its change left
    pointing at nothing) or drops the owner's edit to a published item."""
    ctx, ids = await world()
    await approve(client, ctx, 1)
    await version(ctx, ids, 2, "2027-02-05", [
        {"key": "offline-sync", "title": "Offline sync",
         "start": date(2026, 11, 9), "end": date(2026, 12, 22)},
        {"key": "route-search", "title": "Route search"},
    ])  # fmt: skip
    await approve(client, ctx, 2)
    items = by_key(await read(client, ctx))
    edited = await retitle(client, ctx, items["route-search"], "Route search by trail")
    await retitle(client, ctx, items["offline-sync"], "Offline sync everywhere")
    await approve(client, ctx, 2)
    out = await read(client, ctx)
    items = by_key(out)
    assert sorted(i["key"] for i in out["items"]) == ["offline-sync", "route-search"]
    assert items["route-search"]["title"] == "Route search by trail"
    assert items["offline-sync"]["title"] == "Offline sync everywhere"
    assert items["offline-sync"]["end"]["date"] == "2026-12-22"
    d = await source(client, ctx, ids["roadmap"])
    assert [s["items"] for s in d["from_prds"]] == [2]
    r = await client.post(f"{CHANGES}/{edited['id']}/undo", headers=ctx.as_("owner"))
    assert r.status_code == 201, r.text
    assert by_key(await read(client, ctx))["route-search"]["title"] == "Route search"


async def test_first_approval_keeps_the_owners_earlier_edit_to_a_published_item(client):
    """protects=a published item of the PRD the owner already changed in the draft keeps
    the owner's change when the PRD is approved; fails_when=approval writes the PRD's title
    and dates over it."""
    ctx, ids = await world()
    items = by_key(await read(client, ctx))
    await retitle(client, ctx, items["offline-sync"], "Offline sync everywhere")
    await approve(client, ctx, 1)
    items = by_key(await read(client, ctx))
    assert items["offline-sync"]["title"] == "Offline sync everywhere"
    assert items["offline-sync"]["end"]["date"] == "2026-12-15"
    assert set(items) == {"offline-sync", "route-search", "trip-reports"}


async def test_the_banner_counts_only_what_is_still_in_the_draft(client):
    """protects=the draft's 'came from <PRD>' counts leave out an added item the owner cut,
    and count no key dates (the milestones are read-only from the PRD); fails_when=the counts
    stay as at approval."""
    ctx, ids = await world()
    await approve(client, ctx, 1)
    out = await read(client, ctx)
    trips = by_key(out)["trip-reports"]
    await change(client, ctx, "cut", {"item_id": trips["id"]}, {"cut": False}, {"cut": True})
    [src] = (await source(client, ctx, ids["roadmap"]))["from_prds"]
    assert (src["items"], src["key_dates"]) == (1, 0)


async def _old_copies(ctx: Ctx, ids: dict) -> list[str]:
    """A draft made before ah-prd-milestones-once: approval also copied each milestone into
    it as an own key date ('From <PRD>', id uuid5(roadmap, prd:code))."""
    rm, prd = ids["roadmap"], ids["prd"]
    copies = {
        str(uuid.uuid5(rm, f"{prd}:M1")): {"name": "Private beta", "date": "2026-12-04",
                                            "note": "From Trail maps"},
        str(uuid.uuid5(rm, f"{prd}:M2")): {"name": "Launch", "date": "2027-01-29",
                                            "note": "From Trail maps"},
    }  # fmt: skip
    async with tenant_session(ctx.tenant_id) as s:
        d = await s.scalar(select(SimpleDraft).where(SimpleDraft.status == "working"))
        assert d is not None
        ov = dict(d.overlay or {})
        src = dict(ov["from_prds"][str(prd)])
        src["key_dates"] = list(copies)
        src["wrote"] = {**(src.get("wrote") or {}), **copies}
        ov["from_prds"] = {**ov["from_prds"], str(prd): src}
        ov["key_dates"] = {**(ov.get("key_dates") or {}), **copies}
        d.overlay = ov
        await s.commit()
    return list(copies)


async def test_an_older_drafts_copied_milestones_show_once(client):
    """protects=a draft that already holds the PRD's milestones copied as own key dates
    shows each milestone once, read-only, on Simple › Roadmap and in the Priorities line
    picker; its banner counts no key dates; approving the PRD again drops the copies, and
    publishing the draft writes none; fails_when=the copies show beside the read-only
    milestones, or are published as the roadmap's key dates."""
    ctx, ids = await world()
    await approve(client, ctx, 1)
    await _old_copies(ctx, ids)
    expected = [("M1 · Private beta", "2026-12-04"), ("M2 · Launch", "2027-01-29")]
    assert_milestones_once(await read(client, ctx), expected)
    [src] = (await source(client, ctx, ids["roadmap"]))["from_prds"]
    assert src["key_dates"] == 0
    r = await client.get("/v1/simple/priorities", headers=ctx.as_("owner"))
    assert r.status_code == 200, r.text
    picker = [x["label"] for x in r.json()["lines"] if x["kind"] == "key_date"]
    assert sorted(picker) == ["M1 · Private beta · Dec 4, 2026", "M2 · Launch · Jan 29, 2027"]
    await approve(client, ctx, 1)
    assert_milestones_once(await read(client, ctx), expected)
    async with tenant_session(ctx.tenant_id) as s:
        d = await s.scalar(select(SimpleDraft).where(SimpleDraft.status == "working"))
        assert d is not None and not (d.overlay or {}).get("key_dates")
    await _old_copies(ctx, ids)
    d = await source(client, ctx, ids["roadmap"])
    r = await client.post(f"{DRAFTS}/{d['id']}/submit", headers=ctx.as_("owner"))
    assert r.status_code == 200, r.text
    r = await client.post(f"{DRAFTS}/{d['id']}/approve", headers=ctx.as_("owner"))
    assert r.status_code == 200, r.text
    async with tenant_session(ctx.tenant_id) as s:
        assert list(await s.scalars(select(RoadmapKeyDate))) == []
    out = (await client.get(ROADMAP, headers=ctx.as_("viewer"))).json()
    assert sorted((k["name"], k["date"]) for k in out["key_dates"]) == sorted(expected)


async def test_an_approver_who_cannot_edit_the_roadmap_does_not_own_its_new_draft(client):
    """protects=when approving a PRD opens the roadmap's draft, it is opened for the people
    who change the roadmap, not for an approver who may not; fails_when=the approver
    becomes the draft's creator (can_resume, can_withdraw)."""
    ctx, ids = await world()
    await approve_as(client, ctx, 1, "approver")
    async with tenant_session(ctx.tenant_id) as s:
        d = await s.scalar(select(SimpleDraft).where(SimpleDraft.status == "working"))
        assert d is not None
        assert d.created_by == ctx.users["owner"].id
        assert ctx.users["approver"].id not in (d.participant_ids or [])


async def approve_as(client, ctx: Ctx, n: int, who: str) -> None:
    r = await client.post(f"/v1/documents/{PRD}/versions/{n}/approve", headers=ctx.as_(who))
    assert r.status_code == 200, r.text


async def test_a_draft_holding_only_the_prds_additions_submits_and_publishes(client):
    """protects=a draft whose only content is what an approved PRD added submits, and its
    approval publishes the PRD's items and no key dates (the milestones stay read-only from
    the PRD); fails_when=submit says there is nothing to submit, publishing drops the items,
    or writes the milestones as the roadmap's own key dates."""
    ctx, ids = await world()
    await approve(client, ctx, 1)
    d = await source(client, ctx, ids["roadmap"])
    r = await client.post(f"{DRAFTS}/{d['id']}/submit", headers=ctx.as_("owner"))
    assert r.status_code == 200, r.text
    r = await client.post(f"{DRAFTS}/{d['id']}/approve", headers=ctx.as_("owner"))
    assert r.status_code == 200 and r.json()["status"] == "approved", r.text
    out = (await client.get(ROADMAP, headers=ctx.as_("viewer"))).json()
    assert set(by_key(out)) == {"offline-sync", "route-search", "trip-reports"}
    async with tenant_session(ctx.tenant_id) as s:
        rows = list(await s.scalars(select(RoadmapKeyDate).order_by(RoadmapKeyDate.on_date)))
        assert rows == []
    assert_milestones_once(
        out, [("M1 · Private beta", "2026-12-04"), ("M2 · Launch", "2027-01-29")]
    )


async def test_already_published_copies_of_the_milestones_show_once(client):
    """protects=a roadmap that published the PRD's milestones as its own key dates before
    ah-prd-milestones-once ('From <PRD>' rows, id uuid5(roadmap, prd:code)) shows each
    milestone once, read-only from the PRD, on Simple › Roadmap and in the Priorities line
    picker; a copy the owner renamed or re-noted since is theirs and stays; fails_when=the
    published copies show beside the read-only milestones."""
    ctx, ids = await world()
    await approve(client, ctx, 1)
    rm, prd = ids["roadmap"], ids["prd"]
    owner = ctx.users["owner"].id
    async with tenant_session(ctx.tenant_id) as s:
        for code, name, day, note in [
            ("M1", "Private beta", date(2026, 12, 4), "From Trail maps"),
            # The PRD moved M2 since; still the PRD's copy as written.
            ("M2", "Launch", date(2027, 1, 22), "From Trail maps"),
            ("M3", "Wrap up", date(2027, 2, 26), "From Trail maps"),
        ]:
            s.add(RoadmapKeyDate(id=uuid.uuid5(rm, f"{prd}:{code}"), roadmap_document_id=rm,
                                 name=name, on_date=day, note=note,
                                 created_by=owner))  # fmt: skip
        await s.commit()
    expected = [("M1 · Private beta", "2026-12-04"), ("M2 · Launch", "2027-01-29")]
    for who in ("owner", "viewer"):
        out = (await client.get(ROADMAP, headers=ctx.as_(who))).json()
        got = sorted((k["name"], k["date"], k["prd"] is None) for k in out["key_dates"])
        # M3 is no milestone of the PRD: the roadmap's own key date, kept.
        assert got == sorted(
            [(n, d, False) for n, d in expected] + [("Wrap up", "2027-02-26", True)]
        )
    r = await client.get("/v1/simple/priorities", headers=ctx.as_("owner"))
    assert r.status_code == 200, r.text
    picker = [x["label"] for x in r.json()["lines"] if x["kind"] == "key_date"]
    assert sorted(picker) == [
        "M1 · Private beta · Dec 4, 2026", "M2 · Launch · Jan 29, 2027", "Wrap up · Feb 26, 2027"
    ]  # fmt: skip
    # The owner re-noted the M1 copy: theirs now, it shows beside the PRD's.
    async with tenant_session(ctx.tenant_id) as s:
        row = await s.get(RoadmapKeyDate, uuid.uuid5(rm, f"{prd}:M1"))
        assert row is not None
        row.note = "Beta for the trail club"
        await s.commit()
    out = await read(client, ctx)
    assert sorted(k["name"] for k in out["key_dates"] if k["prd"] is None) == [
        "Private beta", "Wrap up"
    ]  # fmt: skip


# hotfix (approved-prd-shown-once): the roadmap has no approved version; its latest (v2,
# not approved) holds the PRD's items from an older PRD version; the working draft was
# opened on v1. The read shows v2 plus the draft's additions.


async def unapproved_world() -> tuple[Ctx, dict[str, uuid.UUID]]:
    """Roadmap 'Outdoors' with no approved version: v1 (one item of its own) and v2, its
    latest, holding the PRD's version 1 items Offline sync and Trip reports; a working draft
    opened on v1; the PRD's version 2, not approved yet, with newer dates for both and Route
    search, plus 'Trail reviews', a re-keyed copy of Trip reports (same title)."""
    ctx = await make_ctx()
    owner = ctx.users["owner"].id
    async with tenant_session(ctx.tenant_id) as s:
        prd = await _add(s, Document(slug=PRD, title="Trail maps", kind="prd", status="draft",
                                     visibility="company"))  # fmt: skip
        rm = await _add(s, Document(slug="outdoors", title="Outdoors", kind="roadmap",
                                    status="draft", visibility="company"))  # fmt: skip
        rv1 = await _version(s, rm, 1, "# Outdoors v1\n")
        rv2 = await _version(s, rm, 2, "# Outdoors v2\n")
        pv1 = await _version(s, prd, 1, _body(1, "2027-01-29"))
        s.add(RoadmapItem(roadmap_document_id=rm.id, roadmap_version_id=rv1.id,
                          item_key="camp-finder", title="Camp finder", horizon="now",
                          position=0, start_date=date(2026, 11, 9),
                          end_date=date(2026, 11, 30)))  # fmt: skip
        for i, (key, title, end) in enumerate([
            ("offline-sync", "Offline sync", date(2026, 12, 15)),
            ("trip-reports", "Trip reports", date(2027, 1, 15)),
        ]):  # fmt: skip
            s.add(RoadmapItem(roadmap_document_id=rm.id, roadmap_version_id=rv2.id,
                              item_key=key, title=title, horizon="now", position=i,
                              start_date=date(2026, 11, 9), end_date=end, date_source="typed",
                              prd_document_id=prd.id, prd_version_id=pv1.id))  # fmt: skip
        d = await _add(s, SimpleDraft(document_id=rm.id, base_version_id=rv1.id,
                                      status="working", overlay={}, created_by=owner,
                                      participant_ids=[owner]))  # fmt: skip
        pv2 = await _version(s, prd, 2, _body(2, "2027-02-05"))
        await _items(s, prd, pv2, rm, [
            {"key": "offline-sync", "title": "Offline sync for trails",
             "start": date(2026, 11, 16), "end": date(2026, 12, 22)},
            {"key": "route-search", "title": "Route search",
             "start": date(2026, 12, 1), "end": date(2027, 1, 8)},
            {"key": "trail-reviews", "title": "Trip reports",
             "start": date(2026, 12, 1), "end": date(2027, 1, 22)},
        ])  # fmt: skip
        await s.commit()
        return ctx, {"prd": prd.id, "roadmap": rm.id, "draft": d.id, "v2": rv2.id,
                     "pv2": pv2.id}  # fmt: skip


def keys_once(out: dict) -> list[str]:
    keys = [i["key"] for i in out["items"]]
    assert len(keys) == len(set(keys)), keys
    return sorted(keys)


async def test_approving_a_prd_never_adds_an_item_the_simple_roadmap_shows_already(client):
    """protects=approving a PRD version when the roadmap's shown version (its latest, not
    approved) is not the draft's base updates the PRD's items the page shows (same key, else
    same title) with the PRD's dates and title instead of adding them again;
    fails_when=each of the PRD's items shows twice, once from the roadmap version and once
    from the draft."""
    ctx, ids = await unapproved_world()
    await approve(client, ctx, 2)
    out = await read(client, ctx)
    assert keys_once(out) == ["offline-sync", "route-search", "trip-reports"]
    items = by_key(out)
    assert items["offline-sync"]["title"] == "Offline sync for trails"
    assert items["offline-sync"]["end"]["date"] == "2026-12-22"
    assert items["trip-reports"]["end"]["date"] == "2027-01-22"
    [src] = (await source(client, ctx, ids["roadmap"]))["from_prds"]
    assert src["items"] == 3
    # Approving it again still shows each once.
    await approve(client, ctx, 2)
    assert keys_once(await read(client, ctx)) == ["offline-sync", "route-search", "trip-reports"]


async def _duplicates(ctx: Ctx, ids: dict, cut: str | None = None) -> dict[str, str]:
    """What the draft holds in production: the PRD's version 2 items added to the draft
    again with the same keys as the shown version's (and the banner's source)."""
    async with tenant_session(ctx.tenant_id) as s:
        d = await s.get(SimpleDraft, ids["draft"])
        added = {}
        for i, (key, title, end) in enumerate([
            ("offline-sync", "Offline sync for trails", date(2026, 12, 22)),
            ("trip-reports", "Trip reports", date(2027, 1, 22)),
            ("route-search", "Route search", date(2027, 1, 8)),
        ]):  # fmt: skip
            row = await _add(s, RoadmapItem(
                roadmap_document_id=ids["roadmap"], simple_draft_id=d.id, item_key=key,
                title=title, horizon="now", position=10 + i, start_date=date(2026, 11, 16),
                end_date=end, date_source="accepted", prd_document_id=ids["prd"],
                prd_version_id=ids["pv2"], note="From Trail maps (version 2)"))  # fmt: skip
            added[key] = str(row.id)
        overlay = {
            "from_prds": {
                str(ids["prd"]): {
                    "version": 2,
                    "items": list(added.values()),
                    "key_dates": [],
                    "wrote": {},
                }
            }
        }
        if cut:
            from oracle.simple import drafts

            row = await s.get(RoadmapItem, uuid.UUID(added[cut]))
            values = drafts.snapshot(row)
            values["cut"] = True
            overlay[added[cut]] = values
        d.overlay = overlay
        await s.commit()
    return added


async def test_a_draft_already_holding_the_duplicates_shows_each_item_once(client):
    """protects=a working draft that already holds a copy of a shown item (same roadmap,
    PRD and key) reads it once, with the PRD's newer dates and title, and a cut made on the
    copy still cuts it; the banner counts it once; fails_when=the item shows twice, or the
    copy's dates or cut are lost."""
    ctx, ids = await unapproved_world()
    await _duplicates(ctx, ids, cut="trip-reports")
    out = await read(client, ctx)
    assert keys_once(out) == ["offline-sync", "route-search", "trip-reports"]
    items = by_key(out)
    assert items["offline-sync"]["title"] == "Offline sync for trails"
    assert items["offline-sync"]["end"]["date"] == "2026-12-22"
    assert items["trip-reports"]["status"] == "cut"
    [src] = (await source(client, ctx, ids["roadmap"]))["from_prds"]
    assert src["items"] == 2
    # The owner's own change to the shown item wins over the copy's title.
    await retitle(client, ctx, items["offline-sync"], "Offline sync everywhere")
    items = by_key(await read(client, ctx))
    assert items["offline-sync"]["title"] == "Offline sync everywhere"
    assert items["offline-sync"]["end"]["date"] == "2026-12-22"


async def test_a_draft_holding_duplicates_publishes_one_item_per_key(client):
    """protects=sending a draft that holds a copy of an item its base already has, then
    approving it, publishes one item per key with the copy's dates; fails_when=the new
    version holds the key twice."""
    ctx, ids = await unapproved_world()
    async with tenant_session(ctx.tenant_id) as s:
        d = await s.get(SimpleDraft, ids["draft"])
        d.base_version_id = ids["v2"]
        await s.commit()
    await _duplicates(ctx, ids)
    d = await source(client, ctx, ids["roadmap"])
    r = await client.post(f"{DRAFTS}/{d['id']}/submit", headers=ctx.as_("owner"))
    assert r.status_code == 200, r.text
    r = await client.post(f"{DRAFTS}/{d['id']}/approve", headers=ctx.as_("owner"))
    assert r.status_code == 200 and r.json()["status"] == "approved", r.text
    out = (await client.get(ROADMAP, headers=ctx.as_("viewer"))).json()
    assert keys_once(out) == ["offline-sync", "route-search", "trip-reports"]
    assert by_key(out)["offline-sync"]["end"]["date"] == "2026-12-22"


# hotfix PR 1273 fix 1 (a change to a folded item always takes effect): a change made on
# the one item a shown item and its draft copy read as lands on both, so the read shows it
# even when it puts back the shown item's own stored value.


async def test_restore_after_a_copys_cut_brings_the_item_back(client):
    """protects=restoring a folded item that a cut on its draft copy cut brings it back,
    and the banner counts it again; fails_when=restore is logged but the item stays cut
    (the shown item's restore equals its stored value and the copy's cut wins)."""
    ctx, ids = await unapproved_world()
    await _duplicates(ctx, ids, cut="trip-reports")
    item = by_key(await read(client, ctx))["trip-reports"]
    assert item["status"] == "cut"
    await change(client, ctx, "restore", {"item_id": item["id"]}, {"cut": True}, {"cut": False})
    assert by_key(await read(client, ctx))["trip-reports"]["status"] != "cut"
    [src] = (await source(client, ctx, ids["roadmap"]))["from_prds"]
    assert src["items"] == 3


async def test_moving_a_folded_item_back_to_its_shown_dates_takes_effect(client):
    """protects=moving a folded item (showing its copy's dates) back to the shown item's
    stored dates shows those dates; fails_when=the move is logged but the copy's dates
    still show."""
    ctx, ids = await unapproved_world()
    await _duplicates(ctx, ids)
    item = by_key(await read(client, ctx))["offline-sync"]
    assert (item["start"]["date"], item["end"]["date"]) == ("2026-11-16", "2026-12-22")
    await change(client, ctx, "move_dates", {"item_id": item["id"]},
                 {"start_date": "2026-11-16", "end_date": "2026-12-22"},
                 {"start_date": "2026-11-09", "end_date": "2026-12-15"})  # fmt: skip
    item = by_key(await read(client, ctx))["offline-sync"]
    assert (item["start"]["date"], item["end"]["date"]) == ("2026-11-09", "2026-12-15")


async def test_setting_a_folded_items_title_back_takes_effect(client):
    """protects=setting a folded item's title back to the shown item's stored title shows
    it; fails_when=the copy's title still shows."""
    ctx, ids = await unapproved_world()
    await _duplicates(ctx, ids)
    item = by_key(await read(client, ctx))["offline-sync"]
    assert item["title"] == "Offline sync for trails"
    await retitle(client, ctx, item, "Offline sync")
    assert by_key(await read(client, ctx))["offline-sync"]["title"] == "Offline sync"


async def test_the_banner_does_not_count_a_cut_folded_item(client):
    """protects=cutting a folded item takes it out of the banner's 'N items from <PRD>';
    fails_when=the banner still counts it (it reads only the copy's own entry)."""
    ctx, ids = await unapproved_world()
    await _duplicates(ctx, ids)
    [src] = (await source(client, ctx, ids["roadmap"]))["from_prds"]
    assert src["items"] == 3
    item = by_key(await read(client, ctx))["offline-sync"]
    await change(client, ctx, "cut", {"item_id": item["id"]}, {"cut": False}, {"cut": True})
    assert by_key(await read(client, ctx))["offline-sync"]["status"] == "cut"
    [src] = (await source(client, ctx, ids["roadmap"]))["from_prds"]
    assert src["items"] == 2


async def test_a_copy_from_another_prd_with_the_same_key_stays_its_own_item(client):
    """protects=an item added to the draft from a different PRD with the same key as a shown
    item is not folded into it, and a change to the shown item leaves it alone;
    fails_when=the two read as one item or a cut lands on both."""
    ctx, ids = await unapproved_world()
    async with tenant_session(ctx.tenant_id) as s:
        other = await _add(s, Document(slug="camp-guide", title="Camp guide", kind="prd",
                                       status="draft", visibility="company"))  # fmt: skip
        theirs = await _add(s, RoadmapItem(
            roadmap_document_id=ids["roadmap"], simple_draft_id=ids["draft"],
            item_key="offline-sync", title="Offline camp guide", horizon="now", position=20,
            start_date=date(2026, 12, 1), end_date=date(2027, 1, 29), date_source="accepted",
            prd_document_id=other.id))  # fmt: skip
        await s.commit()
    out = await read(client, ctx)
    same = [i for i in out["items"] if i["key"] == "offline-sync"]
    assert sorted(i["title"] for i in same) == ["Offline camp guide", "Offline sync"]
    [shown] = [i for i in same if i["title"] == "Offline sync"]
    await change(client, ctx, "cut", {"item_id": shown["id"]}, {"cut": False}, {"cut": True})
    same = {i["id"]: i for i in (await read(client, ctx))["items"] if i["key"] == "offline-sync"}
    assert same[shown["id"]]["status"] == "cut"
    assert same[str(theirs.id)]["status"] != "cut"
