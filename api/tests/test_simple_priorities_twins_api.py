"""qa-prio-twins (a visual QA of Simple › Priorities): each feature appears once, in one place.
Against Postgres, on tests.test_simple_priorities_company_roadmap_api's world (``payments`` is
the company roadmap; ``widgets``' only item there is the draft ``pay-5``). Invented data.

Test cards (protects / fails_when / no_claim):

- test_a_draft_item_is_on_the_roadmap: protects=a feature whose only item on the company
  roadmap is a draft is on it (``on_roadmap``, ``draft_item_id``), one row, and that draft
  shows on that row (``row_feature_id``, linked), not as a draft of its own;
  fails_when=the row says it is not on the roadmap, or the draft shows twice;
  no_claim=the move (test_a_move_reuses_the_features_draft_item).
- test_a_linked_draft_of_a_ranked_feature_is_on_its_row: protects=a second, draft item linked
  to a feature that has an item (by ``feature_id``, or by its trace's source feature) shows on
  that feature's row, its item first to merge into; fails_when=it is a draft of its own.
- test_same_named_records_show_as_one_row: protects=a second baseline feature and an unlinked
  draft item with a row's name are one row: the row lists the feature with how it merges into
  the row's (the baseline's merge), the draft shows on the row (not linked) with the row's
  item first to merge into; none merged or deleted; fails_when=the feature shows as two rows
  (one above the line, one below) or the draft as its own; or the read merges or deletes.
- test_a_move_confirms_a_trace_linked_draft: protects=a move of a feature whose only item is a
  draft linked by its trace's source feature (no ``feature_id``) confirms that draft and links
  it (``feature_id``); fails_when=the move adds a second item (review of #1503).
- test_a_draft_on_another_roadmap_is_not_on_the_company_roadmap: protects=while there is a
  company roadmap, only its drafts put a feature on it; fails_when=a draft elsewhere reads as on
  the company roadmap.
- test_a_twin_of_a_row_with_only_a_draft_still_merges: protects=a twin whose row has only a draft
  is offered the baseline's Merge into…, and keeps its own rank; fails_when=it offers nothing.
- test_a_twins_merge_proposal_shows: protects=a waiting merge_item of a twin's item is listed;
  fails_when=it shows nowhere (review of #1503).
- test_merging_a_twin_keeps_its_item_on_the_kept_row: protects=Merge into… of a twin whose row
  holds only a draft merges that draft into the twin's confirmed item, links the item to the
  kept feature, then merges the feature: the row keeps its rank and now has the item;
  fails_when=the item loses its feature and drops to Not ranked yet (review of #1503).
- test_merging_a_twin_relinks_its_item_on_another_roadmap: protects=a twin's item on another
  roadmap is linked to the kept feature before the twin's feature goes; fails_when=it is left
  with no feature (Not ranked yet).
- test_merging_a_twin_needs_its_roadmaps_decider: protects=a twin merge whose item the caller
  may not re-link is refused (403) and changes nothing; it is offered as not applying;
  fails_when=the feature is deleted and the item left unlinked.
"""

import uuid
from types import SimpleNamespace

from sqlalchemy import select

from oracle.baseline.models import Entity
from oracle.roadmap.models import RoadmapItem
from oracle.simple import drafts, priorities, service
from oracle.tenancy import tenant_session
from tests.test_simple_changes_api import CHANGES, clock, make_people  # noqa: F401
from tests.test_simple_priorities_company_roadmap_api import REASON, by_feature, company_world
from tests.test_simple_roadmap_api import Seed
from tests.test_simple_targets_api import no_llm  # noqa: F401


async def _add_item(w, key: str, **kw) -> str:
    async with tenant_session(w.ctx.tenant_id) as s:
        base = await s.get(RoadmapItem, uuid.UUID(w.ids["pay-1"]))
        row = RoadmapItem(
            roadmap_document_id=base.roadmap_document_id,
            roadmap_version_id=base.roadmap_version_id,
            prd_document_id=base.prd_document_id,
            prd_version_id=base.prd_version_id,
            track_id=base.track_id,
            item_key=key,
            position=20,
            horizon="next",
            title=kw.pop("title", key.replace("-", " ").title()),
            **kw,
        )
        s.add(row)
        await s.commit()
        w.ids[key] = str(row.id)
        return str(row.id)


async def test_a_draft_item_is_on_the_roadmap(client):
    w = await company_world()
    out = await w.read(client)
    rows = [r for r in out["rows"] if r["feature_id"] == w.ids["widgets"]]
    assert len(rows) == 1
    [row] = rows
    assert row["on_roadmap"] is True, "a draft on the company roadmap reads as not on it"
    assert row["draft_item_id"] == w.ids["pay-5"]
    assert row["item_id"] is None, "a draft is not ranked as the feature's item"
    [draft] = [d for d in out["drafts"] if d["item_id"] == w.ids["pay-5"]]
    assert (draft["row_feature_id"], draft["linked"]) == (w.ids["widgets"], True)


async def test_a_linked_draft_of_a_ranked_feature_is_on_its_row(client):
    w = await company_world()
    await _add_item(w, "pay-8", feature_id=uuid.UUID(w.ids["ledger"]), draft=True)
    trace = [{"target": "feature", "id": w.ids["exports"], "via": "section_link"}]
    await _add_item(w, "pay-9", draft=True, trace=trace)
    out = await w.read(client)
    drafts = {d["code"]: d for d in out["drafts"]}
    for code, feature, into in (("pay-8", "ledger", "pay-1"), ("pay-9", "exports", "pay-3")):
        d = drafts[code]
        assert (d["row_feature_id"], d["linked"]) == (w.ids[feature], True), d
        assert d["merge_into"][0]["code"] == into, d["merge_into"]
    assert drafts["pay-5"]["row_feature_id"] == w.ids["widgets"]
    rows = by_feature(out, w)
    assert rows["ledger"]["twins"] == [] and rows["ledger"]["draft_item_id"] is None


async def test_same_named_records_show_as_one_row(client):
    w = await company_world()
    async with tenant_session(w.ctx.tenant_id) as s:
        (await s.get(RoadmapItem, uuid.UUID(w.ids["pay-1"]))).title = "Ledger"
        await s.commit()
        seed = Seed(s)
        retention = await s.scalar(select(Entity).where(Entity.key == "retention"))
        copy = await seed.entity("feature", "ledger-copy", effort=3)
        copy.title = "ledger "
        await seed.supports(copy, retention)
        await s.commit()
        w.ids["ledger-copy"] = str(copy.id)
    await _add_item(w, "pay-8", title="LEDGER", draft=True)
    out = await w.read(client)
    named = [r for r in out["rows"] if r["title"].strip().lower() == "ledger"]
    assert [r["feature_id"] for r in named] == [w.ids["ledger"]], "one feature, two rows"
    assert w.ids["ledger-copy"] not in [r["feature_id"] for r in out["rows"]]
    [twin] = named[0]["twins"]
    assert (twin["code"], twin["feature_id"]) == ("ledger-copy", w.ids["ledger-copy"])
    assert (twin["merge"], twin["applies"]) == ("entity", True)
    assert twin["goal"]["key"] == "retention"
    [draft] = [d for d in out["drafts"] if d["code"] == "pay-8"]
    assert (draft["row_feature_id"], draft["linked"]) == (w.ids["ledger"], False)
    assert draft["merge_into"][0]["code"] == "pay-1"
    # A viewer reads the same one row, and may merge nothing.
    seen = [r for r in (await w.read(client, "viewer"))["rows"] if r["title"].lower() == "ledger"]
    assert len(seen) == 1
    assert not any(t["applies"] for t in seen[0]["twins"])
    # The read merged and deleted nothing.
    async with tenant_session(w.ctx.tenant_id) as s:
        assert await s.get(Entity, uuid.UUID(w.ids["ledger-copy"])) is not None
        assert (await s.get(RoadmapItem, uuid.UUID(w.ids["pay-8"]))).merged_into is None


async def test_a_move_confirms_a_trace_linked_draft(client):
    w = await company_world()
    trace = [{"target": "feature", "id": w.ids["insights"], "via": "section_link"}]
    await _add_item(w, "pay-8", title="Night digest", draft=True, trace=trace)
    row = by_feature(await w.read(client), w)["insights"]
    assert row["on_roadmap"] is True and row["draft_item_id"] == w.ids["pay-8"]
    body = {"op": "override_priority", "target": {"feature_id": w.ids["insights"]},
            "before": {"override": None},
            "after": {"position": 1, "reason": REASON, "confirm": True}}  # fmt: skip
    r = await client.post(CHANGES, json=body, headers=w.ctx.as_("owner"))
    assert r.status_code in (200, 201), r.text
    async with tenant_session(w.ctx.tenant_id) as s:
        added = (
            await s.scalars(
                select(RoadmapItem).where(RoadmapItem.feature_id == uuid.UUID(w.ids["insights"]))
            )
        ).all()
        assert [str(i.id) for i in added] == [w.ids["pay-8"]], "a second item was added"
        assert added[0].draft is False
    row = by_feature(await w.read(client), w)["insights"]
    assert row["item_id"] == w.ids["pay-8"] and row["draft_item_id"] is None


def test_a_draft_on_another_roadmap_is_not_on_the_company_roadmap():
    company, other = uuid.uuid4(), uuid.uuid4()
    fid = str(uuid.uuid4())

    def draft(key, roadmap):
        row = SimpleNamespace(draft=True, item_key=key, feature_id=fid, trace=None)
        return SimpleNamespace(row=row, status="planned", roadmap=SimpleNamespace(id=roadmap))

    elsewhere, here = draft("a-1", other), draft("b-1", company)
    read_ = SimpleNamespace(entries=[elsewhere, here])
    assert priorities._held(read_, company)[fid] is here
    assert priorities._held(SimpleNamespace(entries=[elsewhere]), company) == {}
    assert priorities._held(read_, None)[fid] is elsewhere, "no company roadmap: every draft"


async def _features(w, *specs: tuple[str, str, int]) -> None:
    """Features (key, title, effort) serving retention."""
    async with tenant_session(w.ctx.tenant_id) as s:
        seed = Seed(s)
        retention = await s.scalar(select(Entity).where(Entity.key == "retention"))
        for key, title, effort in specs:
            f = await seed.entity("feature", key, effort=effort)
            f.title = title
            await seed.supports(f, retention)
            await s.commit()
            w.ids[key] = str(f.id)


async def test_a_twin_of_a_row_with_only_a_draft_still_merges(client):
    w = await company_world()
    await _features(w, ("gadget", "Gadget", 1), ("gadget-copy", "gadget", 9))
    await _add_item(w, "pay-8", title="Gadget", draft=True, feature_id=uuid.UUID(w.ids["gadget"]))
    await _add_item(w, "pay-9", title="Gadget", feature_id=uuid.UUID(w.ids["gadget-copy"]))
    out = await w.read(client)
    [row] = [r for r in out["rows"] if r["title"].lower() == "gadget"]
    assert row["feature_id"] == w.ids["gadget"] and row["draft_item_id"] == w.ids["pay-8"]
    [twin] = row["twins"]
    assert (twin["code"], twin["merge"], twin["applies"]) == ("pay-9", "entity", True), twin
    # The folding by name shows: the twin keeps its own rank, below the row's.
    assert isinstance(twin["rank"], int) and twin["rank"] > row["rank"]


async def test_a_twins_merge_proposal_shows(client):
    w = await company_world()
    await _features(w, ("ledger-copy", "Ledger", 9))
    await _add_item(w, "pay-8", title="Ledger", feature_id=uuid.UUID(w.ids["ledger-copy"]))
    out = await w.read(client)
    [twin] = by_feature(out, w)["ledger"]["twins"]
    assert (twin["code"], twin["merge"], twin["into_id"]) == ("pay-8", "item", w.ids["pay-1"])
    body = {"op": "merge_item", "target": {"item_id": w.ids["pay-8"], "into_id": w.ids["pay-1"]},
            "before": {}, "after": {}, "reason": "Merged into Ledger"}  # fmt: skip
    r = await client.post(CHANGES, json=body, headers=w.ctx.as_("commenter"))
    assert r.status_code in (200, 201), r.text
    assert r.json()["change"]["status"] == "proposed", r.text
    out = await w.read(client)
    merges = [p for p in out["proposals"] if p["op"] == "merge_item"]
    assert [p["item_id"] for p in merges] == [w.ids["pay-8"]], (
        "a twin's waiting merge shows nowhere"
    )
    assert merges[0]["feature_id"] == w.ids["ledger-copy"]


def _merge_url(w, key: str) -> str:
    return f"/v1/simple/priorities/twins/{w.ids[key]}/merge"


async def _feature_of(w, who: str, item: str) -> str | None:
    """The item's feature as ``who`` reads it (their roadmap's working draft included)."""
    async with tenant_session(w.ctx.tenant_id) as s:
        me = SimpleNamespace(id=w.ctx.users[who].id, role=who)
        read_ = await service.load(s, await drafts.overlays_for(s, me))
        e = read_.by_id()[uuid.UUID(w.ids[item])]
        return str(e.row.feature_id) if e.row.feature_id else None


async def test_merging_a_twin_keeps_its_item_on_the_kept_row(client):
    w = await company_world()
    await _features(w, ("gadget", "Gadget", 1), ("gadget-copy", "gadget", 9))
    await _add_item(w, "pay-8", title="Gadget", draft=True, feature_id=uuid.UUID(w.ids["gadget"]))
    await _add_item(w, "pay-9", title="Gadget", feature_id=uuid.UUID(w.ids["gadget-copy"]))
    before = by_feature(await w.read(client), w)["gadget"]
    r = await client.post(
        _merge_url(w, "gadget-copy"), json={"into": w.ids["gadget"]}, headers=w.ctx.as_("owner")
    )
    assert r.status_code == 200, r.text
    assert r.json()["relinked"] == ["pay-9"], r.text
    out = await w.read(client)
    row = by_feature(out, w)["gadget"]
    assert row["item_id"] == w.ids["pay-9"], "the twin's item left the kept row"
    assert (row["rank"], row["twins"], row["draft_item_id"]) == (before["rank"], [], None)
    assert w.ids["pay-9"] not in [u["item_id"] for u in out["unranked"]], "Not ranked yet"
    assert w.ids["pay-8"] not in [d["item_id"] for d in out["drafts"]]
    assert await _feature_of(w, "owner", "pay-9") == w.ids["gadget"]
    async with tenant_session(w.ctx.tenant_id) as s:
        assert await s.get(Entity, uuid.UUID(w.ids["gadget-copy"])) is None


async def _devices(w, key: str, feature: str) -> None:
    """A second roadmap, ``devices``, with one confirmed item ``key`` of ``feature``."""
    async with tenant_session(w.ctx.tenant_id) as s:
        seed = Seed(s)
        _, pv, _, rv = await seed.roadmap("devices")
        row = await seed.item(rv, pv, key, title="Ledger", feature_id=uuid.UUID(w.ids[feature]))
        await s.commit()
        w.ids[key] = str(row.id)


async def test_merging_a_twin_relinks_its_item_on_another_roadmap(client):
    w = await company_world()
    await _features(w, ("ledger-copy", "Ledger", 9))
    await _devices(w, "dev-1", "ledger-copy")
    [twin] = by_feature(await w.read(client), w)["ledger"]["twins"]
    assert (twin["code"], twin["merge"], twin["applies"]) == ("ledger-copy", "entity", True)
    r = await client.post(
        _merge_url(w, "ledger-copy"), json={"into": w.ids["ledger"]}, headers=w.ctx.as_("owner")
    )
    assert r.status_code == 200, r.text
    out = await w.read(client)
    assert by_feature(out, w)["ledger"]["twins"] == []
    assert w.ids["dev-1"] not in [u["item_id"] for u in out["unranked"]], "Not ranked yet"
    assert await _feature_of(w, "owner", "dev-1") == w.ids["ledger"]


async def test_merging_a_twin_needs_its_roadmaps_decider(client):
    w = await company_world()
    await _features(w, ("gadget", "Gadget", 1), ("gadget-copy", "gadget", 9))
    await _add_item(w, "pay-8", title="Gadget", draft=True, feature_id=uuid.UUID(w.ids["gadget"]))
    await _add_item(w, "pay-9", title="Gadget", feature_id=uuid.UUID(w.ids["gadget-copy"]))
    # The approver may merge Ground Truth features, but payments has its own decider.
    [twin] = by_feature(await w.read(client, "approver"), w)["gadget"]["twins"]
    assert (twin["merge"], twin["applies"]) == ("entity", False), twin
    r = await client.post(
        _merge_url(w, "gadget-copy"), json={"into": w.ids["gadget"]}, headers=w.ctx.as_("approver")
    )
    assert r.status_code == 403, r.text
    async with tenant_session(w.ctx.tenant_id) as s:
        assert await s.get(Entity, uuid.UUID(w.ids["gadget-copy"])) is not None
        item = await s.get(RoadmapItem, uuid.UUID(w.ids["pay-9"]))
        assert str(item.feature_id) == w.ids["gadget-copy"]
