"""item-chat-understands (Nov 3): an item's talk understands "this already exists" and
never answers "Say it another way" alone to plain talk. Against Postgres; the reader's
model is a fake ``ask`` (tests.test_simple_chat_join.read). The world is
tests.test_simple_roadmap_talk's (``a`` Adaptive pacing, ``b`` Reliability work).

Test cards (protects / fails_when / no_claim):

- test_already_shipped_line_offers_mark_as_shipped: protects=a line saying the item already
  runs ("this is already happening now in our other app's review section ... will keep
  improving it") gives a "Mark as already shipped" card whose evidence note is where it
  runs, from the person's words, and a "Keep improving it" card; the owner's Apply marks the
  item shipped (its status reads done, out of planned work) and Undo puts it back; a
  commenter cannot apply it; fails_when=the line gets "Say it another way", no card, or the
  card writes nothing; no_claim=the model.
- test_reader_mark_shipped_action_builds: protects=the reader may read a line into
  mark_shipped (offered in its ops) and gets the same cards; fails_when=the op is unknown.
- test_answer_about_the_item_without_its_name_is_shown: protects=in an item's talk the
  reader's answer about "it" is shown even when it does not repeat the item's name (the
  talk's context is the item), while an off-topic answer is still dropped;
  fails_when=such an answer is replaced by "Say it another way".
- test_unread_line_asks_with_choices: protects=a line the reader reads no change in gets a
  short question with two or three choices drawn from what was said (a shipped-sounding
  line offers "Mark it as already shipped?" first), never "Say it another way" alone; a
  picked choice builds its card; fails_when=the reply is the bare "Say it another way".
"""

import uuid

from oracle.roadmap.models import RoadmapItem
from oracle.simple import chat, drafts, service
from oracle.tenancy import tenant_session
from tests.test_simple_changes_api import clock as clock  # noqa: F401
from tests.test_simple_chat_join import act
from tests.test_simple_roadmap_talk import CHAT, CARDS, apply, page, reads, say, world

LINE = ("this is already happening now in our other app's review section. This is shipped "
        "and will continue to improve it")  # fmt: skip


async def status_of(w, key: str) -> str:
    async with tenant_session(w.ctx.tenant_id) as s:
        read_ = await service.load(s, await drafts.overlays_for(s, None))
        return read_.by_id()[uuid.UUID(w.ids[f"move_dates-{key}"])].status


async def shipped_of(w, key: str):
    async with tenant_session(w.ctx.tenant_id) as s:
        return (await s.get(RoadmapItem, uuid.UUID(w.ids[f"move_dates-{key}"]))).shipped


async def test_already_shipped_line_offers_mark_as_shipped(client):
    w = await world()
    m = await say(client, w, "owner", LINE, page(w))
    assert m["kind"] == "cards", m["body"]
    assert chat.SAY_AGAIN not in m["body"]
    ship, keep = m["cards"]
    assert ship["op"] == "mark_shipped"
    assert ship["summary"] == "Mark as already shipped: Adaptive pacing"
    assert ship["after"]["shipped"]["note"] == "Runs in our other app's review section"
    assert keep["op"] == "add_item" and keep["summary"].startswith("Keep improving it")
    # A commenter's line gets the cards, but only an owner applies them.
    c = await say(client, w, "commenter", "it is already live", page(w))
    r = await apply(client, w, "commenter", c["cards"][0]["id"])
    assert r.status_code == 403, r.text
    assert await shipped_of(w, "a") is None
    r = await apply(client, w, "owner", ship["id"])
    assert r.status_code == 200, r.text
    assert (await shipped_of(w, "a"))["note"] == "Runs in our other app's review section"
    assert await status_of(w, "a") == "done"
    assert await status_of(w, "b") != "done"
    r = await client.post(f"{CARDS}/{ship['id']}/undo", headers=w.ctx.as_("owner"))
    assert r.status_code == 200, r.text
    assert await shipped_of(w, "a") is None
    assert await status_of(w, "a") == "planned"


async def test_reader_mark_shipped_action_builds(client):
    w = await world()
    seen: list = []
    m = await reads(client, w, "owner", "we've had this for months in the partner app",
                    {"actions": [act("mark_shipped", item=w.ids["move_dates-a"],
                                     where="the partner app")],
                     "clarify": None, "answer": None}, page(w), seen)  # fmt: skip
    assert "mark_shipped" in {o["op"] for o in seen[0]["ops"]}
    assert m["kind"] == "cards", m["body"]
    [card] = m["cards"]
    assert card["op"] == "mark_shipped"
    assert card["after"]["shipped"]["note"] == "Runs in the partner app"


async def test_answer_about_the_item_without_its_name_is_shown(client):
    w = await world()
    said = "Got it: this already runs elsewhere, so it needs no new dates."
    m = await reads(client, w, "owner", "we do this elsewhere already, right?",
                    {"actions": [], "clarify": None, "answer": said, "source": "roadmap"},
                    page(w))  # fmt: skip
    assert m["kind"] == "answer" and m["body"] == said
    m = await reads(client, w, "owner", "tell me a joke",
                    {"actions": [], "clarify": None, "answer": "The weather is fine today.",
                     "source": "roadmap"}, page(w))  # fmt: skip
    assert m["kind"] != "answer" and "weather" not in m["body"]
    assert m["body"] != f"I could not tell what to change. {chat.SAY_AGAIN}"


async def test_unread_line_asks_with_choices(client):
    w = await world()
    m = await reads(client, w, "owner", "folks have been using a version of this for a while",
                    {"actions": [], "clarify": None, "answer": None}, page(w))  # fmt: skip
    assert m["kind"] == "question", m["body"]
    assert chat.SAY_AGAIN not in m["body"] and len(m["body"]) <= 80
    labels = [ch["label"] for ch in m["choices"]]
    assert labels[0] == "Mark it as already shipped?"
    assert "Add this as a task?" in labels and labels[-1] == "Neither"
    assert 3 <= len(labels) <= 4
    r = await client.post(f"{CHAT}/messages/{m['id']}/choose", json={"index": 0},
                          headers=w.ctx.as_("owner"))  # fmt: skip
    assert r.status_code == 200, r.text
    [card] = r.json()["messages"][-1]["cards"]
    assert card["op"] == "mark_shipped"
    # Plain talk with nothing shipped in it: still choices, never the bare refusal.
    m = await reads(client, w, "owner", "the sales team liked the demo",
                    {"actions": [], "clarify": None, "answer": None}, page(w))  # fmt: skip
    assert m["kind"] == "question" and chat.SAY_AGAIN not in m["body"]
    labels = [ch["label"] for ch in m["choices"]]
    assert "Add this as a task?" in labels and 3 <= len(labels) <= 4
