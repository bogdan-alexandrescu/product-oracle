"""de-inst (the owner, Nov 23): a change by a person who may decide the roadmap is instant and
final; a change by a person who may only propose is a proposal until a decider accepts it;
a viewer's is refused. Nothing waits on a publish, a review or a run. Against Postgres.

Roles map through the existing rights (oracle.simple.service.can_decide): the roadmap's
decider (or an owner) decides; a commenter proposes; a viewer reads.

Test cards (protects / fails_when / no_claim):

- test_decider_change_is_live_for_every_reader: protects=a decider's applied change is the
  roadmap every reader reads at once (viewer and commenter too), counts nothing "in review"
  on the Simple roadmap or the document API, and adds no Inbox row; fails_when=readers who
  do not see the draft keep the published values, or the change counts as in review;
  no_claim=PRD sections.
- test_commenter_change_is_a_proposal_until_accepted: protects=the same op by a commenter is
  proposed, nobody reads it as live, it counts in review and reaches the decider's Inbox;
  accepting it makes it live for every reader and clears the count; fails_when=a
  proposal applies, or an accepted one stays hidden; no_claim=meeting routing.
- test_viewer_change_is_refused: protects=a viewer's write is 403 and changes nothing;
  fails_when=a viewer's write lands or files a proposal; no_claim=runs.
"""

import json

from tests.test_simple_changes_api import CHANGES, World, make_people, seeded_title
from tests.test_simple_changes_api import clock as clock  # noqa: F401

ROADMAP = "/v1/simple/roadmap"
OPS = ["edit_title", "move_dates"]
TITLE = seeded_title("edit_title-a")


async def world() -> World:
    return await World(await make_people()).build(decider=True, ops=OPS)


async def view(client, w: World, who: str) -> dict:
    r = await client.get(ROADMAP, headers=w.ctx.as_(who))
    assert r.status_code == 200, r.text
    return r.json()


def item(v: dict, key: str) -> dict:
    return next(i for i in v["items"] if i["key"] == key)


async def doc_in_review(client, w: World, who: str) -> int:
    from oracle.docs.models import Document
    from oracle.tenancy import tenant_session

    async with tenant_session(w.ctx.tenant_id) as s:
        import uuid

        slug = (await s.get(Document, uuid.UUID(w.roadmap_id))).slug
    r = await client.get(f"/v1/documents/{slug}", headers=w.ctx.as_(who))
    assert r.status_code == 200, r.text
    return r.json()["changes_in_review"]


async def inbox_mentions(client, w: World, who: str, change_id: str) -> bool:
    r = await client.get("/v1/inbox", headers=w.ctx.as_(who))
    assert r.status_code == 200, r.text
    return change_id in json.dumps(r.json())


async def test_decider_change_is_live_for_every_reader(client):
    """A decider's change is the roadmap of record for everyone at once."""
    w = await world()
    r = await w.post(client, "decider", "edit_title")
    assert r.status_code == 201, r.text
    change = r.json()["change"]
    assert change["status"] == "applied"
    d = await w.post(client, "decider", "move_dates")
    assert d.status_code == 201 and d.json()["change"]["status"] == "applied"
    for who in ("decider", "owner", "approver", "commenter", "viewer"):
        v = await view(client, w, who)
        assert item(v, "edit_title-a")["title"] == "Ledger v2", who
        moved = item(v, "move_dates-a")
        assert (moved["start"]["date"], moved["end"]["date"]) == ("2026-10-05", "2026-11-20"), who
        assert v["changes_in_review"] == 0, who
        assert await doc_in_review(client, w, who) == 0, who
    for who in ("decider", "owner"):
        assert not await inbox_mentions(client, w, who, change["id"]), who


async def test_commenter_change_is_a_proposal_until_accepted(client):
    """A commenter's change waits for a decider; accepting it makes it live for everyone."""
    w = await world()
    r = await w.post(client, "commenter", "move_dates")
    assert r.status_code == 201, r.text
    prop = r.json()["change"]
    assert prop["status"] == "proposed"
    for who in ("viewer", "commenter", "decider"):
        moved = item(await view(client, w, who), "move_dates-a")
        assert moved["start"]["date"] == "2026-10-01", who
    assert await doc_in_review(client, w, "viewer") == 1
    assert await inbox_mentions(client, w, "decider", prop["id"])
    acc = await client.post(f"{CHANGES}/{prop['id']}/accept", headers=w.ctx.as_("decider"))
    assert acc.status_code == 200, acc.text
    for who in ("viewer", "commenter", "decider"):
        v = await view(client, w, who)
        assert item(v, "move_dates-a")["start"]["date"] == "2026-10-05", who
        assert v["changes_in_review"] == 0, who


async def test_viewer_change_is_refused(client):
    """A viewer may not change the roadmap, nor propose."""
    w = await world()
    r = await w.post(client, "viewer", "edit_title")
    assert r.status_code == 403, r.text
    assert item(await view(client, w, "decider"), "edit_title-a")["title"] == TITLE
    listed = await client.get(CHANGES, headers=w.ctx.as_("decider"))
    assert listed.json() == []
