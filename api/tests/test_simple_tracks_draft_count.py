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

from sqlalchemy import select

from oracle.roadmap.models import ProductTrack
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
    assert await counts(client, w, "decider") == {"Track": (4, 4), "Gift boxes": (5, 5)}
    # A viewer reads the published version, its counts unchanged.
    assert await counts(client, w, "viewer") == published
