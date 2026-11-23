"""Comments on a feature (#1553): the feature panel's Comments, through the routes. Against
Postgres. Synthetic placeholders only.

Test cards (protects / fails_when / no_claim):

- test_every_role_comments_and_reads_oldest_first: protects=a viewer, commenter, approver
  and owner each add a comment and every one reads them oldest first with the author's
  name; fails_when=any role is refused or the order or name is wrong; no_claim=the web.
- test_edit_and_delete_rights: protects=a person edits and deletes their own comment, a
  viewer editing or deleting someone else's is 403, an owner deletes anyone's (but edits
  none of theirs); fails_when=a wrong write is let through or a right one refused;
  no_claim=the Inbox.
- test_blank_and_long_bodies_are_refused: protects=a blank or over-long body is 422;
  fails_when=it is stored; no_claim=the web's count.
- test_another_company_never_sees_them: protects=another company's people get 404 on the
  feature's comments and see no counts; fails_when=a comment or count leaks;
  no_claim=tokens.
- test_comments_follow_the_feature: protects=a comment hangs on the feature (its roadmap
  and key): a new row of it shows it, Trash hides it and restore brings it back, and the
  counts list it only while it has one; fails_when=it stays on one row, shows while in
  Trash, or is lost on restore; no_claim=purge.
- test_a_purged_feature_takes_its_comments: protects=purging a feature from Trash drops
  its comments, so a new feature later given the same key starts with none and no count;
  fails_when=the new feature shows the purged one's comments or count; no_claim=the web.
"""

import pytest

from oracle import company_time
from oracle.tenancy import tenant_session
from oracle.trash import service as trash_service
from tests.baseline_helpers import make_ctx
from tests.test_simple_roadmap_api import NOW, Seed

pytestmark = pytest.mark.asyncio(loop_scope="session")

ITEMS = "/v1/simple/roadmap/items"
COUNTS = "/v1/simple/comment-counts"


@pytest.fixture(autouse=True)
def clock(monkeypatch):
    monkeypatch.setattr(company_time, "now", lambda: NOW)


async def world():
    ctx = await make_ctx()
    async with tenant_session(ctx.tenant_id) as s:
        seed = Seed(s)
        _, pv, rm, rv = await seed.roadmap("payments")
        a = await seed.item(rv, pv, "alerts", position=0)
        b = await seed.item(rv, pv, "billing", position=1)
        await s.commit()
    return ctx, str(a.id), str(b.id), (pv, rm, rv)


async def add(client, ctx, item, who, body, expect=201):
    r = await client.post(f"{ITEMS}/{item}/comments", json={"body": body}, headers=ctx.as_(who))
    assert r.status_code == expect, r.text
    return r.json()


async def read(client, ctx, item, who="viewer", expect=200):
    r = await client.get(f"{ITEMS}/{item}/comments", headers=ctx.as_(who))
    assert r.status_code == expect, r.text
    return r.json()


async def test_every_role_comments_and_reads_oldest_first(client):
    """Every role, a viewer too, comments; all read them oldest first."""
    ctx, a, _, _ = await world()
    for who in ("viewer", "commenter", "approver", "owner"):
        c = await add(client, ctx, a, who, f"  A note from the {who}  ")
        assert c["body"] == f"A note from the {who}"
        assert c["can_edit"] and c["can_delete"]
    for who in ("viewer", "owner"):
        got = await read(client, ctx, a, who)
        assert [c["body"] for c in got] == [
            f"A note from the {w}" for w in ("viewer", "commenter", "approver", "owner")
        ]
        assert got[0]["author"] == {"id": str(ctx.users["viewer"].id), "name": "Viewer"}
    viewer_reads = await read(client, ctx, a, "viewer")
    assert [c["can_edit"] for c in viewer_reads] == [True, False, False, False]
    assert [c["can_delete"] for c in viewer_reads] == [True, False, False, False]
    assert all(c["can_delete"] for c in await read(client, ctx, a, "owner"))


async def test_edit_and_delete_rights(client):
    """Own comments are edited and deleted; an owner deletes any; no one edits another's."""
    ctx, a, _, _ = await world()
    mine = await add(client, ctx, a, "viewer", "First take")
    theirs = await add(client, ctx, a, "commenter", "Second take")
    url = f"{ITEMS}/{a}/comments"

    r = await client.patch(f"{url}/{mine['id']}", json={"body": "Better take"},
                           headers=ctx.as_("viewer"))  # fmt: skip
    assert r.status_code == 200, r.text
    assert r.json()["body"] == "Better take" and r.json()["edited_at"]

    r = await client.patch(f"{url}/{theirs['id']}", json={"body": "Hijack"},
                           headers=ctx.as_("viewer"))  # fmt: skip
    assert r.status_code == 403
    r = await client.patch(f"{url}/{theirs['id']}", json={"body": "Hijack"},
                           headers=ctx.as_("owner"))  # fmt: skip
    assert r.status_code == 403
    r = await client.delete(f"{url}/{theirs['id']}", headers=ctx.as_("viewer"))
    assert r.status_code == 403
    r = await client.delete(f"{url}/{theirs['id']}", headers=ctx.as_("approver"))
    assert r.status_code == 403

    r = await client.delete(f"{url}/{mine['id']}", headers=ctx.as_("viewer"))
    assert r.status_code == 204
    r = await client.delete(f"{url}/{theirs['id']}", headers=ctx.as_("owner"))
    assert r.status_code == 204
    assert await read(client, ctx, a) == []
    r = await client.delete(f"{url}/{mine['id']}", headers=ctx.as_("viewer"))
    assert r.status_code == 404


async def test_blank_and_long_bodies_are_refused(client):
    """A blank or over-long comment is refused."""
    ctx, a, _, _ = await world()
    await add(client, ctx, a, "viewer", "   ", expect=422)
    await add(client, ctx, a, "viewer", "x" * 2001, expect=422)
    await add(client, ctx, a, "viewer", "x" * 2000)


async def test_another_company_never_sees_them(client):
    """Another company never reads a comment or its count."""
    ctx, a, _, _ = await world()
    await add(client, ctx, a, "viewer", "Only for us")
    other = await make_ctx("Other Example Co")
    for who in ("viewer", "owner"):
        await read(client, other, a, who, expect=404)
        await add(client, other, a, who, "Peek", expect=404)
        r = await client.get(COUNTS, headers=other.as_(who))
        assert r.status_code == 200 and r.json() == []


async def test_comments_follow_the_feature(client):
    """A comment hangs on the feature: every row of it, and back from Trash."""
    ctx, a, b, (pv, rm, rv) = await world()
    c = await add(client, ctx, a, "viewer", "Keep this")
    await add(client, ctx, a, "owner", "Kept")
    r = await client.get(COUNTS, headers=ctx.as_("viewer"))
    assert r.json() == [{"roadmap_id": str(rv.document_id), "key": "alerts", "count": 2}]

    # A new version's row of the same feature shows them too; another feature shows none.
    async with tenant_session(ctx.tenant_id) as s:
        seed = Seed(s)
        rv2 = await seed.version(rm, n=2, approved=False)
        a2 = await seed.item(rv2, pv, "alerts", position=0)
        await s.commit()
    assert [x["body"] for x in await read(client, ctx, str(a2.id))] == ["Keep this", "Kept"]
    assert await read(client, ctx, b) == []

    owner = ctx.as_("owner")
    assert (await client.delete(f"{ITEMS}/{a}", headers=owner)).status_code == 200
    await read(client, ctx, a, expect=404)
    r = await client.post(f"{ITEMS}/{a}/restore", headers=owner)
    assert r.status_code == 200, r.text
    assert [x["id"] for x in await read(client, ctx, a)][0] == c["id"]


async def test_a_purged_feature_takes_its_comments(client):
    """A purged feature's comments go with it: a new feature with its key starts empty."""
    ctx, a, _, (pv, _, rv) = await world()
    await add(client, ctx, a, "viewer", "Gone with it")
    assert (await client.delete(f"{ITEMS}/{a}", headers=ctx.as_("owner"))).status_code == 200
    async with tenant_session(ctx.tenant_id) as s:
        for entry in await trash_service.list_entries(s):
            await trash_service.purge_entry(s, None, entry)
        await s.commit()
    async with tenant_session(ctx.tenant_id) as s:
        fresh = await Seed(s).item(rv, pv, "alerts", position=0)
        await s.commit()
    assert await read(client, ctx, str(fresh.id)) == []
    r = await client.get(COUNTS, headers=ctx.as_("viewer"))
    assert r.status_code == 200 and r.json() == []
