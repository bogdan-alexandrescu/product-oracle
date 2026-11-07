"""The Simple roadmap's draft layer against approval (RP2, 'Draft layer on roadmap'): what
the layer changes is what approval writes; one card per PRD, its newest draft; only items
approval would place. Against Postgres.

Test cards (protects / fails_when / no_claim):

- test_layer_changes_survive_approval: protects=an item left out on the layer is not added
  to the roadmap's working draft at approval, and an item's changed dates win over the
  engineering lead's accepted date; fails_when=approval reads cut items, or the verified
  basis overrides the typed dates; no_claim=the meeting step's own Approve these N dates.
- test_two_versions: protects=a PRD with ready drafts for two versions shows one card, the
  newest's, and none once that version is approved; fails_when=both cards show (one React
  key twice), or the older card survives the newer's approval.
- test_an_approved_later_version_hides_an_older_draft: protects=a PRD whose later version
  is approved (no draft of its own) shows no card for an older draft; fails_when=it does.
- test_only_items_approval_places: protects=the layer lists an item with its own date or a
  verified basis (at the basis's date), never an undated one at its horizon's window;
  fails_when=an undated item shows with made-up dates.
"""

from datetime import date

from oracle.docs.models import Document
from oracle.tenancy import tenant_session
from tests.test_approved_prd_roadmap_api import (
    _body,
    _version,
    approve,
    by_key,
    read,
    version,
    world,
)
from tests.test_approved_prd_roadmap_api import (
    clock as clock,  # noqa: F401
)

DRAFT_PRDS = "/v1/simple/roadmap/draft-prds"


async def layer(client, ctx, who: str = "owner") -> list[dict]:
    r = await client.get(DRAFT_PRDS, headers=ctx.as_(who))
    assert r.status_code == 200, r.text
    return r.json()


def keyed(card: dict) -> dict[str, dict]:
    return {i["key"]: i for i in card["items"]}


async def test_layer_changes_survive_approval(client):
    ctx, _ = await world()
    [card] = await layer(client, ctx)
    items = keyed(card)
    r = await client.post(f"{DRAFT_PRDS}/items/{items['trip-reports']['id']}/leave-out",
                          headers=ctx.as_("owner"))  # fmt: skip
    assert r.status_code == 204, r.text
    body = {"start": "2027-02-01", "end": "2027-03-05"}
    r = await client.post(f"{DRAFT_PRDS}/items/{items['route-search']['id']}/dates", json=body,
                          headers=ctx.as_("owner"))  # fmt: skip
    assert r.status_code == 204, r.text
    await approve(client, ctx, 1)
    got = by_key(await read(client, ctx))
    assert set(got) == {"offline-sync", "route-search"}
    search = got["route-search"]
    assert (search["start"]["date"], search["end"]["date"]) == ("2027-02-01", "2027-03-05")


async def test_two_versions(client):
    ctx, ids = await world()
    await version(ctx, ids, 2, "2027-02-05", [
        {"key": "offline-sync", "title": "Offline sync v2",
         "start": date(2026, 11, 9), "end": date(2026, 12, 22)},
    ])  # fmt: skip
    [card] = await layer(client, ctx)
    assert [i["title"] for i in card["items"]] == ["Offline sync v2"]
    await approve(client, ctx, 2)
    assert await layer(client, ctx) == []


async def test_an_approved_later_version_hides_an_older_draft(client):
    ctx, ids = await world()
    async with tenant_session(ctx.tenant_id) as s:
        prd = await s.get(Document, ids["prd"])
        await _version(s, prd, 2, _body(2, "2027-02-05"))  # no draft of its own
        await s.commit()
    assert len(await layer(client, ctx)) == 1
    await approve(client, ctx, 2)
    assert await layer(client, ctx) == []


async def test_only_items_approval_places(client):
    ctx, _ = await world()  # its Ideas board has no date, no basis, no milestone
    [card] = await layer(client, ctx)
    items = keyed(card)
    assert set(items) == {"offline-sync", "route-search", "trip-reports"}
    assert items["route-search"]["end"] == "2027-01-08"  # the lead's accepted date
