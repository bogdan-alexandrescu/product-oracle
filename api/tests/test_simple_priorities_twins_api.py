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
"""

import uuid

from sqlalchemy import select

from oracle.baseline.models import Entity
from oracle.roadmap.models import RoadmapItem
from oracle.tenancy import tenant_session
from tests.test_simple_changes_api import clock, make_people  # noqa: F401
from tests.test_simple_priorities_company_roadmap_api import by_feature, company_world
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
