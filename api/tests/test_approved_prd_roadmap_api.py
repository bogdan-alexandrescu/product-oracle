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
