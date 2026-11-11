"""Tracks sheet counts (owner's Roadmap, Nov 10): a track's feature count is what the Simple
roadmap shows its reader, the working draft for those who read it. Against Postgres.

Test cards (protects / fails_when / no_claim):

- test_a_tracks_count_reads_the_working_draft: protects=``GET /v1/simple/tracks`` counts the
  features the reader's roadmap puts on each track: features moved onto a new track in the
  working draft (op ``set_track``) count on it for the decider, who reads the draft, and
  ``moves_count`` asks about them too, while a viewer, who reads the published version, keeps
  the published counts; fails_when=the new track reads 0 features to the decider after the
  move, or the viewer's counts change; no_claim=the web
  (web/e2e/roadmap-nov10-findings.spec.ts).
"""

import uuid

from sqlalchemy import select

from oracle.roadmap.models import ProductTrack, RoadmapItem
from oracle.simple.drafts import OPEN
from oracle.simple.models import SimpleDraft
from oracle.tenancy import tenant_session
from tests.test_simple_changes_api import CHANGES, World, make_people
from tests.test_simple_changes_api import clock as clock  # noqa: F401

TRACKS = "/v1/simple/tracks"
OPS = ["edit_title", "move_dates", "cut"]


async def counts(client, w: World, who: str) -> dict[str, tuple[int, int]]:
    r = await client.get(TRACKS, headers=w.ctx.as_(who))
    assert r.status_code == 200, r.text
    return {t["title"]: (t["feature_count"], t["moves_count"]) for t in r.json()["tracks"]}


async def test_a_tracks_count_reads_the_working_draft(client):
    w = await World(await make_people()).build(decider=True, ops=OPS)
    async with tenant_session(w.ctx.tenant_id) as s:
        first = await s.scalar(select(ProductTrack))
        # A second track with no PRD (tracks-goal: a PRD is on one track).
        second = ProductTrack(roadmap_document_id=first.roadmap_document_id, title="Gift boxes")
        s.add(second)
        await s.commit()
        old, new = str(first.id), str(second.id)
    published = {"Track": (9, 9), "Gift boxes": (0, 0)}
    assert await counts(client, w, "decider") == published
    moved = ("edit_title-a", "edit_title-b", "move_dates-a", "move_dates-u", "cut-b")
    for key in moved:
        body = {"op": "set_track", "target": {"item_id": w.ids[key]},
                "before": {"track_id": old}, "after": {"track_id": new}}  # fmt: skip
        r = await client.post(CHANGES, json=body, headers=w.ctx.as_("decider"))
        assert r.status_code == 201, r.text
        change = r.json()["change"]
        assert change["status"] == "applied" and change["draft_ids"], change
    # The decider reads the draft: the five are on Gift boxes now.
    # Move to Trash on Track also clears the five still on it in the published version.
    assert await counts(client, w, "decider") == {"Track": (4, 9), "Gift boxes": (5, 5)}
    # A viewer reads the published version, its counts unchanged.
    assert await counts(client, w, "viewer") == published


async def drafts_on(w: World, track_id: str) -> set[str]:
    """The items the roadmap's open drafts put on ``track_id``."""
    async with tenant_session(w.ctx.tenant_id) as s:
        rows = await s.scalars(select(SimpleDraft).where(SimpleDraft.status.in_(OPEN)))
        return {
            k
            for d in rows
            for k, v in (d.overlay or {}).items()
            if isinstance(v, dict) and v.get("track_id") == track_id
        }


async def published_on(w: World, track_id: str) -> set[str]:
    async with tenant_session(w.ctx.tenant_id) as s:
        rows = await s.scalars(
            select(RoadmapItem.id).where(RoadmapItem.track_id == uuid.UUID(track_id))
        )
        return {str(i) for i in rows}


async def two_tracks(client, w: World) -> tuple[str, str, list[str]]:
    """Track (9 features) and Gift boxes; the decider moves five to Gift boxes in the draft."""
    async with tenant_session(w.ctx.tenant_id) as s:
        first = await s.scalar(select(ProductTrack))
        second = ProductTrack(roadmap_document_id=first.roadmap_document_id, title="Gift boxes")
        s.add(second)
        await s.commit()
        old, new = str(first.id), str(second.id)
    moved = ["edit_title-a", "edit_title-b", "move_dates-a", "move_dates-u", "cut-b"]
    for key in moved:
        body = {"op": "set_track", "target": {"item_id": w.ids[key]},
                "before": {"track_id": old}, "after": {"track_id": new}}  # fmt: skip
        r = await client.post(CHANGES, json=body, headers=w.ctx.as_("decider"))
        assert r.status_code == 201, r.text
    return old, new, [w.ids[k] for k in moved]


async def delete(client, w: World, track_id: str) -> dict:
    body = {"op": "delete_track", "target": {"track_id": track_id}, "before": {}, "after": {}}
    r = await client.post(CHANGES, json=body, headers=w.ctx.as_("owner"))
    assert r.status_code == 201, r.text
    assert r.json()["change"]["status"] == "applied", r.text
    return r.json()["change"]


async def test_move_to_trash_counts_the_published_features_moved_off_in_the_draft(client):
    w = await World(await make_people()).build(decider=True, ops=OPS)
    old, new, moved = await two_tracks(client, w)
    held = await published_on(w, old)
    assert len(held) == 9
    # The draft shows four on Track, but Move to Trash also clears the five the draft moved
    # off (still on Track in the published version): it asks about all nine, each once.
    assert await counts(client, w, "owner") == {"Track": (4, 9), "Gift boxes": (5, 5)}
    assert await counts(client, w, "decider") == {"Track": (4, 9), "Gift boxes": (5, 5)}
    # The five the draft moved off, for the confirm's words (draft_off_count).
    r = await client.get(TRACKS, headers=w.ctx.as_("owner"))
    off = {t["title"]: t.get("draft_off_count") for t in r.json()["tracks"]}
    assert off == {"Track": 5, "Gift boxes": 0}
    r = await client.get(TRACKS, headers=w.ctx.as_("viewer"))
    assert {t["title"]: t.get("draft_off_count") for t in r.json()["tracks"]} == {
        "Track": 0,
        "Gift boxes": 0,
    }
    gone = await delete(client, w, old)
    assert await published_on(w, old) == set()
    assert await drafts_on(w, new) == set(moved)
    # Undo puts all nine back on Track; the draft still moves the five to Gift boxes.
    r = await client.post(f"{CHANGES}/{gone['id']}/undo", headers=w.ctx.as_("owner"))
    assert r.status_code == 201, r.text
    assert await published_on(w, old) == held
    assert await drafts_on(w, new) == set(moved)
    assert await counts(client, w, "owner") == {"Track": (4, 9), "Gift boxes": (5, 5)}


async def test_move_to_trash_moves_the_drafts_features_off_and_restore_puts_them_back(client):
    w = await World(await make_people()).build(decider=True, ops=OPS)
    old, new, moved = await two_tracks(client, w)
    # Gift boxes holds five only in the draft: Move to Trash asks about them and moves them.
    assert await counts(client, w, "owner") == {"Track": (4, 9), "Gift boxes": (5, 5)}
    await delete(client, w, new)
    # The draft no longer points at a track in Trash: the five are on no track there.
    assert await drafts_on(w, new) == set()
    assert await drafts_on(w, old) == set()
    async with tenant_session(w.ctx.tenant_id) as s:
        d = await s.scalar(select(SimpleDraft).where(SimpleDraft.status.in_(OPEN)))
        assert all(d.overlay[i]["track_id"] is None for i in moved)
    assert await counts(client, w, "owner") == {"Track": (4, 9)}
    # Restore from Trash puts the five back on Gift boxes in the draft.
    trash = (await client.get("/v1/trash", headers=w.ctx.as_("owner"))).json()
    entry = next(e for e in trash if e["root"]["type"] == "track")
    r = await client.post(f"/v1/trash/{entry['id']}/restore", headers=w.ctx.as_("owner"))
    assert r.status_code == 200, r.text
    assert await drafts_on(w, new) == set(moved)
    assert await counts(client, w, "owner") == {"Track": (4, 9), "Gift boxes": (5, 5)}
    # Undo of a second delete puts them back too.
    gone = await delete(client, w, new)
    assert await drafts_on(w, new) == set()
    r = await client.post(f"{CHANGES}/{gone['id']}/undo", headers=w.ctx.as_("owner"))
    assert r.status_code == 201, r.text
    assert await drafts_on(w, new) == set(moved)
