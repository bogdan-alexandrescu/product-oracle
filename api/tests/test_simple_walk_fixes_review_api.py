"""The walk-fixes review (2026-10-28): what the review of the walk's fixes found. Against
Postgres; jobs run with fakes.

Test cards (protects / fails_when / no_claim):

- test_item_code_is_the_features_code: protects=Home's item code is the feature's code
  (a feature keyed F-12 with no PRD section reads F-12, as on Priorities); fails_when=it
  reads null; no_claim=initials (no code on Home).
- test_draft_rows_lend_no_prd_code: protects=a PRD code only an unpublished draft's row
  carries never names the feature on Priorities; fails_when=a viewer reads F-06 from a
  draft; no_claim=the draft's own item.
- test_later_code_key_never_renames_an_older_feature: protects=a feature created later
  whose key is the code an older feature reads from its PRD section never takes it;
  fails_when=the older feature's code moves.
- test_looks_like_and_merged_into_read_prd_codes: protects=the card's "Looks like" and
  "Merged into" name the kept item by its PRD code (F-06); fails_when=they read its slug.
- test_next_review_drops_who_is_no_longer_listed: protects=the next review lists who was
  present at the last review held only until the ritual's list is edited after it, and
  never who was absent; fails_when=someone who attended once stays listed for good.
"""

import uuid
from datetime import timedelta

from sqlalchemy import select

from oracle import company_time
from oracle.rituals.models import Ritual
from oracle.roadmap.models import DraftRoadmap, RoadmapItem
from oracle.simple.models import SimpleMeeting
from oracle.simple.priorities import short_codes
from oracle.tenancy import tenant_session
from tests.test_simple_additions_api import CHANGES
from tests.test_simple_additions_api import World as AdditionsWorld
from tests.test_simple_meetings_api import start, uid
from tests.test_simple_meetings_api import world as meeting_world
from tests.test_simple_meetings_walk import ritual
from tests.test_simple_priorities_api import World as PriorityWorld
from tests.test_simple_priorities_api import make_people
from tests.test_simple_roadmap_api import Seed


async def test_item_code_is_the_features_code(client):
    ctx = await make_people()
    async with tenant_session(ctx.tenant_id) as s:
        seed = Seed(s)
        _, pv, _, rv = await seed.roadmap("guards")
        f = await seed.entity("feature", "F-12", effort=1)
        await seed.item(rv, pv, "conversion", feature_id=f.id)
        g = await seed.entity("feature", "loop-guards", effort=1)
        await seed.item(rv, pv, "loops", feature_id=g.id, position=1)
        await s.commit()
    for who in ("owner", "viewer"):
        r = await client.get("/v1/simple/roadmap", headers=ctx.as_(who))
        assert r.status_code == 200, r.text
        codes = {i["key"]: i["code"] for i in r.json()["items"]}
        assert codes == {"conversion": "F-12", "loops": None}, who


async def test_draft_rows_lend_no_prd_code(client):
    ctx = await make_people()
    w = await PriorityWorld(ctx).build()
    async with tenant_session(ctx.tenant_id) as s:
        seed = Seed(s)
        _, pv, _, rv = await seed.roadmap("guards")
        f = await seed.entity("feature", "delivery-integrity", effort=1)
        await seed.item(rv, pv, "delivery-integrity", feature_id=f.id)
        await s.flush()
        # The same feature in a PRD draft's items-only roadmap, from section f-06.
        dr = await seed.add(DraftRoadmap(prd_document_id=pv.document_id, prd_version_id=pv.id))
        s.add(RoadmapItem(roadmap_document_id=rv.document_id, draft_roadmap_id=dr.id,
                          item_key="delivery-integrity-d", title="Delivery integrity",
                          horizon="now", position=0, feature_id=f.id,
                          prd_section_key="f-06"))  # fmt: skip
        await s.commit()
    for who in ("owner", "viewer"):
        out = await w.read(client, who)
        codes = {r["code"]: r["short_code"] for r in out["rows"]}
        assert codes["delivery-integrity"] == "DI", who


def test_later_code_key_never_renames_an_older_feature():
    keys = ["delivery-integrity", "F-06"]
    prd = {"delivery-integrity": "F-06"}
    older = short_codes(keys[:1], prd)
    assert older == ["F-06"]
    both = short_codes(keys, prd)
    assert both[0] == "F-06" and both[1] != "F-06"
    assert short_codes(["F-06", "loop-guards"], {"loop-guards": "F-06"}) == ["F-06", "LG"]


async def test_looks_like_and_merged_into_read_prd_codes(client):
    w = await AdditionsWorld().build()
    async with tenant_session(w.ctx.tenant_id) as s:
        row = await s.get(RoadmapItem, uuid.UUID(w.ids["import-a"]))
        row.prd_section_key = "f-06"
        await s.commit()
    c = (await w.add(client, "owner", "Bulk import"))["change"]
    draft = c["target"]["item_id"]
    for who in ("owner", "approver"):
        item = (await w.items(client, who))[draft]
        assert item["looks_like"][0]["code"] == "F-06", who
    r = await client.post(CHANGES, headers=w.as_("owner"), json={
        "op": "merge_item", "target": {"item_id": draft, "into_id": w.ids["import-a"]},
        "before": {}, "after": {}})  # fmt: skip
    assert r.status_code == 201, r.text
    assert (await w.items(client))[draft]["merged_into"]["code"] == "F-06"


async def test_next_review_drops_who_is_no_longer_listed(client):
    w = await meeting_world()
    ritual_id, due = await ritual(w, owner="owner")
    await start(client, w, "owner", ritual_id=ritual_id, due_at=due.isoformat())

    async def listed() -> set[str]:
        got = (await client.get("/v1/simple/meetings", headers=w.ctx.as_("viewer"))).json()
        row = next(x for x in got["upcoming"] if x["ritual_id"] == ritual_id)
        return {a["id"] for a in row["attendees"]}

    assert uid(w, "commenter") in await listed()
    # Who was marked absent at the review held is not one of its real attendees.
    async with tenant_session(w.ctx.tenant_id) as s:
        meeting = await s.scalar(select(SimpleMeeting).order_by(SimpleMeeting.started_at.desc()))
        meeting.absent_ids = [uuid.UUID(uid(w, "commenter"))]
        await s.commit()
    assert uid(w, "commenter") not in await listed()
    assert uid(w, "approver") in await listed()
    # The ritual's list edited after the review: the ritual's list is the list.
    async with tenant_session(w.ctx.tenant_id) as s:
        r = await s.get(Ritual, uuid.UUID(ritual_id))
        r.attendee_ids = [uuid.UUID(uid(w, "commenter"))]
        r.attendees_edited_at = company_time.now() + timedelta(minutes=1)
        await s.commit()
    assert await listed() == {uid(w, "owner"), uid(w, "commenter")}
