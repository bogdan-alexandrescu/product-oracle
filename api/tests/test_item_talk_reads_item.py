"""Ask Oracle: item talk reads the item (Nov 10). In an item's talk ("Talk to Oracle" in its
panel) a question the reader answers by reading the API answered "I couldn't read that"
(``ask_actions.calls``) or "I couldn't read that just now." (chat.COULD_NOT_READ). Against
Postgres; the reader's model is a fake ``ask`` that, like the real one, can only answer from
what it was given or what its reads returned (it answers None otherwise).

The world is tests.test_simple_roadmap_talk's (``a`` Adaptive pacing, ``b`` Reliability work
depending on it, ``u`` undated; the goal Growth), shaped like a real item: ``b`` serves the
Ground Truth feature F-26 (so its code is not its key and its key is not its id), is tied to
Growth with a measure, and sits on a renamed track behind a few earlier items.

Test cards (protects / fails_when / no_claim):

- test_item_context_carries_what_its_panel_shows: protects=the reader gets the item as its
  panel shows it: its key, its Ground Truth feature, its track, what it depends on and what
  depends on it (by name, with codes), its goal and how that is measured;
  fails_when=one is missing (the reader then reads the API for it); no_claim=the model.
- test_a_read_naming_the_item_reads_it: protects=a read the reader calls with the item's own
  id, key, code or name where the route takes a record's id (get_entity, list_edges) reads
  the item's Ground Truth feature, and an item with no feature reads as itself;
  fails_when=the answer is "I couldn't read that: Entity not found"; no_claim=other talks.
- test_the_roadmap_read_keeps_the_item: protects=the roadmap read in an item's talk keeps
  the item and the items it is linked to in what the reader gets back (the read is cut at
  ``RESULT_MAX``); fails_when=the item is cut off and the answer is "I couldn't read that
  just now."; no_claim=the roadmap page's own Ask.
- test_every_item_shape_is_read: protects=an item with a code in its name, from an approved
  PRD version, on a renamed track, or whose key differs from its id is the talk's item;
  fails_when=the reader gets no item; no_claim=items a person cannot open.
"""

import json
import uuid
from datetime import date
from typing import Any

import pytest
from sqlalchemy import select

from oracle.baseline.models import Entity
from oracle.docs.models import DocumentVersion
from oracle.jobs import kinds
from oracle.jobs.models import LlmJob
from oracle.roadmap.models import ProductTrack, RoadmapItem
from oracle.simple import chat
from oracle.tenancy import tenant_session
from tests.test_simple_changes_api import World
from tests.test_simple_changes_api import clock as clock  # noqa: F401
from tests.test_simple_roadmap_talk import last, page, say, world

FEATURE = "Keys out of checkpoints"


async def talk_world() -> World:
    w = await world()
    async with tenant_session(w.ctx.tenant_id) as s:
        a = await s.get(RoadmapItem, uuid.UUID(w.ids["move_dates-a"]))
        b = await s.get(RoadmapItem, uuid.UUID(w.ids["move_dates-b"]))
        assert a is not None and b is not None
        f = Entity(type="feature", key="F-26", title=FEATURE, status="confirmed", origin="user",
                   attrs={})  # fmt: skip
        s.add(f)
        await s.flush()
        g = await s.get(Entity, uuid.UUID(w.goal))  # type: ignore[attr-defined]
        assert g is not None
        g.attrs = {"metric": "Weekly active teams", "current": 25}
        b.feature_id, b.goal_ids = f.id, [g.id]
        track = await s.get(ProductTrack, b.track_id)
        assert track is not None
        track.title = "Checkout reliability"
        # Earlier items on the same roadmap: the roadmap's read reaches b only past them.
        for n in range(6):
            s.add(RoadmapItem(
                roadmap_document_id=b.roadmap_document_id, roadmap_version_id=b.roadmap_version_id,
                prd_document_id=b.prd_document_id, prd_version_id=b.prd_version_id,
                track_id=b.track_id, item_key=f"early-{n}", position=-10 + n, horizon="now",
                title=f"Early work {n}", outcome="An example outcome for the early work.",
                start_date=date(2026, 10, 1), end_date=date(2026, 10, 20), date_source="typed",
            ))  # fmt: skip
        await s.commit()
        w.feature = str(f.id)  # type: ignore[attr-defined]
    return w


def reader(calls: list[dict], knows: str, said: str):
    """A fake reader: calls ``calls`` first; with results, answers ``said`` only when they
    hold ``knows`` (as the real one cannot answer from what it did not read)."""
    seen: list[dict] = []

    async def ask(kind: str, payload: dict) -> Any:
        assert kind == "chat_reader"
        seen.append(payload)
        if "results" not in payload:
            return {"actions": [], "calls": calls, "clarify": None, "answer": None}
        got = json.dumps(payload["results"])
        return {"actions": [], "clarify": None, "answer": said if knows in got else None}

    return ask, seen


async def run_reader(w: World, ask) -> None:
    async with tenant_session(w.ctx.tenant_id) as s:
        ids = list(await s.scalars(
            select(LlmJob.id).where(LlmJob.kind == "chat_reader", LlmJob.status == "queued")))  # fmt: skip
    assert ids
    for i in ids:
        async with tenant_session(w.ctx.tenant_id) as s:
            job = await s.get(LlmJob, i)
            assert job is not None
            job.output = await kinds.RUNNERS["chat_reader"](s, job, ask)
            job.status = "succeeded"
            await s.commit()


async def talk(client, w: World, line: str, ask, key: str = "b", who: str = "commenter") -> dict:
    m = await say(client, w, who, line, page(w, key))
    assert m["kind"] == "pending", m["body"]
    await run_reader(w, ask)
    return await last(client, w, who, page(w, key))


async def test_item_context_carries_what_its_panel_shows(client):
    w = await talk_world()
    ask, seen = reader([], "-", "-")
    await talk(client, w, "what does it depend on?", ask)
    item = seen[0]["context"]["item"]
    assert item["id"] == w.ids["move_dates-b"] and item["key"] == "move_dates-b"
    assert item["code"] == "F-26"
    assert item["feature"] == {"id": w.feature, "code": "F-26", "title": FEATURE}  # type: ignore[attr-defined]
    assert item["track"] == "Checkout reliability"
    assert item["depends_on"] == ["Adaptive pacing"]
    assert item["needed_by"] == []
    assert item["goal"] == "Growth"
    assert item["goal_measure"]["metric"] == "Weekly active teams"
    assert item["goal_measure"]["current"] == 25
    ask, seen = reader([], "-", "-")
    await talk(client, w, "what needs it?", ask, key="a")
    assert seen[0]["context"]["item"]["needed_by"] == ["F-26 Reliability work"]


@pytest.mark.parametrize("named", ["id", "key", "code", "label"])
async def test_a_read_naming_the_item_reads_it(client, named):
    w = await talk_world()
    value = {"id": w.ids["move_dates-b"], "key": "move_dates-b", "code": "F-26",
             "label": "F-26 Reliability work"}[named]  # fmt: skip
    ask, _ = reader([{"action": "get_entity", "args": {"entity_id": value}}], FEATURE,
                    f"Reliability work builds F-26 {FEATURE}.")  # fmt: skip
    m = await talk(client, w, "which feature is it?", ask)
    assert m["kind"] == "answer", m["body"]
    assert m["body"] == f"Reliability work builds F-26 {FEATURE}."
    ask, seen = reader([{"action": "list_edges", "args": {"entity_id": value}}], "[",
                       "It has no links yet.")  # fmt: skip
    m = await talk(client, w, "what is it linked to?", ask)
    assert m["kind"] == "answer", m["body"]
    # An item with no Ground Truth feature reads as itself (its roadmap record).
    ask, _ = reader([{"action": "get_entity", "args": {"entity_id": w.ids["move_dates-a"]}}],
                    "Adaptive pacing", "Adaptive pacing runs Oct 1 – Nov 15.")  # fmt: skip
    m = await talk(client, w, "tell me about it", ask, key="a")
    assert m["kind"] == "answer", m["body"]
    assert chat.COULD_NOT_READ not in m["body"]


async def test_the_roadmap_read_keeps_the_item(client):
    w = await talk_world()
    ask, seen = reader([{"action": "get_simple_roadmap", "args": {}}],
                       '\\"title\\": \\"Reliability work\\"',
                       "Reliability work depends on Adaptive pacing.")  # fmt: skip
    m = await talk(client, w, "what is it waiting on?", ask)
    assert m["kind"] == "answer", m["body"]
    assert m["body"] == "Reliability work depends on Adaptive pacing."
    got = seen[-1]["results"][0]["result"]
    assert "Adaptive pacing" in got


async def test_every_item_shape_is_read(client):
    w = await talk_world()
    async with tenant_session(w.ctx.tenant_id) as s:
        b = await s.get(RoadmapItem, uuid.UUID(w.ids["move_dates-b"]))
        u = await s.get(RoadmapItem, uuid.UUID(w.ids["move_dates-u"]))
        assert b is not None and u is not None
        # u: a code in its name; b: from the PRD's newer approved version.
        u.title = "F-27 Saved filters"
        v2 = DocumentVersion(document_id=b.prd_document_id, number=2, markdown="# v2\n",
                             content_hash="v2", approved_at=b.created_at)  # fmt: skip
        s.add(v2)
        await s.flush()
        b.prd_version_id = v2.id
        await s.commit()
    for key, title in (("b", "Reliability work"), ("u", "F-27 Saved filters")):
        ask, seen = reader([], "-", "-")
        await talk(client, w, "what is it for?", ask, key=key)
        item = seen[0]["context"]["item"]
        assert item is not None and item["title"] == title
        assert item["id"] == w.ids[f"move_dates-{key}"] != item["key"]
