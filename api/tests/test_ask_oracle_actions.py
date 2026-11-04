"""Ask Oracle does what a person can do (owner, Nov 4): the action catalogue built from the
API (oracle.simple.ask_actions), the chats' reader choosing from it, reads at once, writes
as cards applied through the page's own route as the person, Undo where there is an
inverse; and the dependency op the feature talk lacked (``set_depends_on``). Against
Postgres; the model is always a fake ``ask``.

Test cards (protects / fails_when / no_claim):

- test_every_route_is_allowed_or_denied_by_name: protects=the catalogue is an allow-list:
  every route of the app is in ``ALLOWED`` or named in ask_action_routes, never both; every
  outward or secret-bearing route (invites, Slack, company integrations, analytics, tracker,
  web fetch/search, share links, public pages, tokens, credentials, members' role and
  hand-over) is denied with why; cards' words are plain; fails_when=a route is in neither, or
  one of them is offered.
- test_no_offered_action_takes_a_secret: protects=no offered action has a secret field.
- test_a_new_route_starts_excluded: protects=a route added later is not offered until it is
  allowed by name; fails_when=the catalogue fails open.
- test_viewer_gets_no_card_for_an_approver_action: protects=a viewer's chat is never
  offered an approver-only write and a reader answer naming one is a plain refusal, no
  card; an approver's is a card that writes nothing until Apply, then runs the route as
  them, is logged "via Ask Oracle", and Undo deletes what it made; fails_when=a viewer
  gets a card, a card writes before Apply, or Undo leaves the entity; no_claim=the route's
  own checks (its tests).
- test_a_read_runs_at_once_and_is_worded: protects=a read call runs now as the person and
  a second model call words its result: an answer, no card; fails_when=a read becomes a
  card or is not run.
- test_dependency_removal_card_end_to_end_with_undo: protects=in a feature's talk "it
  should not depend on X. remove that dependency relationship" is one card "Remove
  dependency: <item> no longer depends on <code title>", nothing changes until Apply, the
  item then no longer depends on it, Undo puts it back; adding one works the same;
  fails_when=the talk answers "I could not tell what to change", or the draft keeps or
  loses the wrong key; no_claim=the web card (Playwright).
- test_a_card_names_each_record_and_undo_is_promised_only_when_sure: protects=a card names
  every record its path names (read first; none: no card), Undo only for a 201 create with a
  DELETE, an edit whose record reads back each field sent, else the card says before Apply it
  cannot be undone; the route's own audit rows carry "via Ask Oracle"; fails_when=a card says
  "Delete source" without its name, or promises an Undo it cannot do.
- test_undo_needs_one_id_matching_the_delete: protects=a list or many ids is no Undo.
- test_a_secret_is_never_kept_in_a_card: protects=a value under a secret's key gets no card.
- test_a_meeting_offers_only_reads_every_attendee_reaches: protects=an owner's read in a
  meeting a viewer attends is neither offered nor run; fails_when=members reach the viewer.
- test_apply_all_leaves_api_action_cards_for_their_own_apply.
- test_undo_of_a_dependency_card_turns_back_only_its_dependency: protects=Undo puts back the
  one dependency it removed and keeps one added since; fails_when=the whole list is restored.
"""

import uuid

from fastapi import Depends, FastAPI
from sqlalchemy import select

from oracle.authz import require_role
from oracle.baseline.models import Entity
from oracle.main import app
from oracle.mcp.tools import snake_case
from oracle.models import AuditEvent
from oracle.simple import ask_actions
from oracle.simple.ask_action_routes import NOT_OFFERED, OUTWARD_OR_SECRET
from oracle.tenancy import tenant_session
from tests.test_simple_chat_api import (
    CARDS,
    World,
    make_people,
    meetings,  # noqa: F401 -- the fixture
    n_changes,
)
from tests.test_simple_chat_reader import _meeting, last, post, read
from tests.test_simple_chat_reader import clock as clock  # noqa: F401

WRITES = ("post", "put", "patch", "delete")
# Each reaches people or systems outside Oracle, or carries a secret: never offered.
OUTWARD = (
    "login", "create_personal_token", "change_password", "purge_trash_entry", "remove_member",
    "revoke_api_token", "create_webhook", "add_claude_account", "notify_requesters",
    "post_simple_chat", "apply_simple_chat_card", "create_invite", "resend_invite",
    "retry_invite_access", "mirror_discussion_to_slack", "test_slack_notifications",
    "list_slack_notification_channels", "install_slack_notifications", "list_company_integrations",
    "delete_company_integration", "get_analytics_integration", "link_tracker_issue",
    "push_track_to_tracker", "import_tracker_records", "list_tracker_records",
    "create_share_link", "rotate_share_link_passcode", "put_public_page",
    "retry_alignment_report_slack", "put_analytics_integration", "fetch_web_page", "search_web",
    "update_member", "hand_over", "disable_member",
)  # fmt: skip


def test_every_route_is_allowed_or_denied_by_name():
    cat = ask_actions.catalogue(app)
    named = {**OUTWARD_OR_SECRET, **dict.fromkeys(NOT_OFFERED, "")}
    seen = 0
    for path, item in app.openapi()["paths"].items():
        for method, spec in item.items():
            if method not in (*WRITES, "get"):
                continue
            seen += 1
            op = spec["operationId"]
            # Allowed or denied by name, never both, never neither.
            assert (op in ask_actions.ALLOWED) != (op in named), (method, path, op)
            if op in named:
                assert snake_case(op) not in cat.actions, op
                assert cat.denied.get(op), op
    assert seen > 500
    assert set(ask_actions.ALLOWED) <= set(cat.actions)
    for op in OUTWARD:
        assert OUTWARD_OR_SECRET.get(op), op
        assert snake_case(op) not in cat.actions, op
    # Undo it could not deliver (a list back, a key it cannot read back, a move): not offered.
    for op in ("add_discussion_participants", "put_analytics_integration", "link_tracker_issue"):
        assert snake_case(op) not in cat.actions, op
    assert cat.actions["create_entity"].needs == "approver"
    assert cat.actions["list_entities"].reads is True
    # Plain words, never FastAPI's operation summaries.
    assert cat.actions["create_entity"].summary == "Add a product record"


def test_no_offered_action_takes_a_secret():
    for a in ask_actions.catalogue(app).actions.values():
        fields = ask_actions.body_fields(a.op) if a.body else []
        assert not [f for f in fields if ask_actions.SECRET.search(f)], a.name
        assert not [p for p in a.params if ask_actions.SECRET.search(p)], a.name


def test_a_new_route_starts_excluded():
    toy = FastAPI()

    @toy.post("/v1/widgets", name="make_widget")
    async def make_widget(_p=Depends(require_role("approver"))) -> dict:  # noqa: B008
        return {}

    cat = ask_actions.catalogue(toy)
    assert cat.actions == {}
    assert list(cat.denied.values()) == [ask_actions.NEW_ROUTE_WHY]


def _entity_call(key: str) -> dict:
    return {"calls": [{"action": "create_entity", "args": {"body": {
        "type": "assumption", "key": key, "title": "Night shift nurse"}}}]}  # fmt: skip


async def _entity(ctx, key: str) -> Entity | None:
    async with tenant_session(ctx.tenant_id) as s:
        return await s.scalar(select(Entity).where(Entity.key == key))


async def test_viewer_gets_no_card_for_an_approver_action(client):
    ctx = await make_people()
    await World(ctx).build()
    seen: list = []
    await post(client, ctx, "viewer", "add the assumption night shift nurse")
    await read(ctx, _entity_call("night-nurse"), seen)
    assert "create_entity" not in {a["action"] for a in seen[0]["api"]}
    assert "list_entities" in {a["action"] for a in seen[0]["api"]}
    m = await last(client, ctx, "viewer")
    assert m["cards"] == [] and m["kind"] == "note", m
    assert "approver" in m["body"]
    assert await _entity(ctx, "night-nurse") is None

    await post(client, ctx, "approver", "add the assumption night shift nurse")
    await read(ctx, _entity_call("night-nurse"))
    m = await last(client, ctx, "approver")
    [card] = m["cards"]
    assert card["op"] == "api_action" and card["status"] == "open"
    assert "Night shift nurse" in card["summary"]
    assert await _entity(ctx, "night-nurse") is None  # nothing until Apply
    r = await client.post(f"{CARDS}/{card['id']}/apply", headers=ctx.as_("approver"))
    assert r.status_code == 200, r.text
    assert r.json()["card"]["status"] == "applied"
    assert r.json()["card"]["can_undo"] is True
    assert await _entity(ctx, "night-nurse") is not None
    async with tenant_session(ctx.tenant_id) as s:
        logged = await s.scalar(
            select(AuditEvent).where(AuditEvent.action == "simple_chat.api_action")
        )
    assert logged is not None and logged.data["via"] == "Ask Oracle"
    assert logged.data["action"] == "create_entity"
    r = await client.post(f"{CARDS}/{card['id']}/undo", headers=ctx.as_("approver"))
    assert r.status_code == 200, r.text
    assert r.json()["status"] == "undone"
    gone = await _entity(ctx, "night-nurse")
    assert gone is None or gone.status == "rejected"


async def test_a_read_runs_at_once_and_is_worded(client):
    ctx = await make_people()
    await World(ctx).build()
    seen: list = []

    def answer(payload):
        if payload.get("results"):
            assert payload["results"][0]["action"] == "list_entities"
            return {"answer": "There are no assumptions yet."}
        return {"calls": [{"action": "list_entities", "args": {"type": "assumption"}}]}

    await post(client, ctx, "viewer", "which assumptions do we have?")
    await read(ctx, answer, seen)
    assert len(seen) == 2
    m = await last(client, ctx, "viewer")
    assert m["kind"] == "answer" and m["cards"] == []
    assert m["body"] == "There are no assumptions yet."


async def test_dependency_removal_card_end_to_end_with_undo(client):
    ctx = await make_people()
    w = await World(ctx).build()
    bulk, ledger = w.ids["Bulk import"], w.ids["Ledger v2"]
    talk = f"/simple/roadmap/items/{bulk}"
    line = "it should not depend on Ledger v2. remove that dependency relationship"
    r = await client.post("/v1/simple/chat/messages", json={"text": line, "page": talk},
                          headers=ctx.as_("owner"))  # fmt: skip
    assert r.status_code == 200, r.text
    seen: list = []
    removal = {"op": "remove_dependency", "args": {"item": bulk, "on": ledger}}
    await read(ctx, {"actions": [removal]}, seen)
    assert {"remove_dependency", "add_dependency"} <= {o["op"] for o in seen[0]["ops"]}
    r = await client.get("/v1/simple/chat", params={"page": talk}, headers=ctx.as_("owner"))
    m = r.json()["messages"][-1]
    assert "could not tell" not in m["body"]
    [card] = m["cards"]
    assert card["op"] == "set_depends_on"
    assert card["summary"].startswith("Remove dependency: Bulk import no longer depends on ")
    assert card["summary"].endswith("Ledger v2")
    assert card["after"] == {"depends_on": []}
    assert (await w.item("Bulk import")).depends_on == ["ledger-v2"]
    assert await n_changes(ctx) == 0
    r = await client.post(f"{CARDS}/{card['id']}/apply", headers=ctx.as_("owner"))
    assert r.status_code == 200, r.text
    assert r.json()["card"]["status"] == "applied"
    assert (await w.item("Bulk import")).depends_on == []
    async with tenant_session(ctx.tenant_id) as s:
        logged = await s.scalar(
            select(AuditEvent).where(AuditEvent.action == "simple_chat.card_apply")
        )
    assert logged is not None and logged.data["via"] == "Ask Oracle"
    assert logged.data["op"] == "set_depends_on"
    r = await client.post(f"{CARDS}/{card['id']}/undo", headers=ctx.as_("owner"))
    assert r.status_code == 200, r.text
    assert (await w.item("Bulk import")).depends_on == ["ledger-v2"]

    partner = w.ids["Partner API"]
    await client.post("/v1/simple/chat/messages",
                      json={"text": "it depends on Alert digest",
                            "page": f"/simple/roadmap/items/{partner}"},
                      headers=ctx.as_("owner"))  # fmt: skip
    adding = {"op": "add_dependency", "args": {"item": partner, "on": w.ids["Alert digest"]}}
    await read(ctx, {"actions": [adding]})
    r = await client.get("/v1/simple/chat", params={"page": f"/simple/roadmap/items/{partner}"},
                         headers=ctx.as_("owner"))  # fmt: skip
    [card] = r.json()["messages"][-1]["cards"]
    assert card["summary"].startswith("Add dependency: Partner API depends on ")
    r = await client.post(f"{CARDS}/{card['id']}/apply", headers=ctx.as_("owner"))
    assert r.status_code == 200, r.text
    assert (await w.item("Partner API")).depends_on == ["alert-digest"]


async def _called(client, ctx, who: str, *calls: dict, meeting=None, seen=None) -> dict:
    await post(client, ctx, who, "please do that", meeting)
    await read(ctx, {"calls": list(calls)}, seen)
    return await last(client, ctx, who, meeting)


async def _apply(client, ctx, who: str, card: dict) -> dict:
    r = await client.post(f"{CARDS}/{card['id']}/apply", headers=ctx.as_(who))
    assert r.status_code == 200, r.text
    return r.json()["card"]


async def test_a_card_names_each_record_and_undo_is_promised_only_when_sure(client):
    ctx = await make_people()
    await World(ctx).build()
    m = await _called(client, ctx, "approver", _entity_call("night-nurse")["calls"][0])
    await _apply(client, ctx, "approver", m["cards"][0])
    e = await _entity(ctx, "night-nurse")
    assert e is not None
    # A delete names its record; with no /restore it says before Apply it cannot be undone.
    m = await _called(client, ctx, "approver",
                      {"action": "delete_entity", "args": {"entity_id": str(e.id)}})  # fmt: skip
    [card] = m["cards"]
    assert (
        card["summary"] == "Delete the product record “Night shift nurse”. This cannot be undone."
    )

    # A record that cannot be named gets no card.
    nowhere = {"action": "delete_entity", "args": {"entity_id": str(uuid.uuid4())}}
    m = await _called(client, ctx, "approver", nowhere)
    assert m["cards"] == [] and ask_actions.NO_NAME in m["body"], m

    # An edit of fields its record reads back: Undo puts them back.
    edit = {"action": "update_entity",
            "args": {"entity_id": str(e.id), "body": {"title": "Night shift lead"}}}  # fmt: skip
    m = await _called(client, ctx, "approver", edit)
    [card] = m["cards"]
    assert card["summary"] == (
        "Change the product record “Night shift nurse”: title “Night shift lead”."
    )
    applied = await _apply(client, ctx, "approver", card)
    assert applied["can_undo"] is True
    assert (await _entity(ctx, "night-nurse")).title == "Night shift lead"
    r = await client.post(f"{CARDS}/{card['id']}/undo", headers=ctx.as_("approver"))
    assert r.status_code == 200, r.text
    assert (await _entity(ctx, "night-nurse")).title == "Night shift nurse"

    # A field the record does not read back (reason): no Undo, said before Apply.
    edit["args"]["body"] = {"title": "Night shift lead", "reason": "a typo"}
    m = await _called(client, ctx, "approver", edit)
    [card] = m["cards"]
    assert card["summary"].endswith(ask_actions.CANNOT_UNDO)
    assert (await _apply(client, ctx, "approver", card))["can_undo"] is False

    # A create with no DELETE of what it makes: cannot be undone, said before Apply.
    decision = {"title": "Pick a launch city", "approver_id": str(ctx.users["decider"].id)}
    m = await _called(client, ctx, "approver",
                      {"action": "create_decision", "args": {"body": decision}})  # fmt: skip
    [card] = m["cards"]
    assert card["summary"] == "Add a decision: title “Pick a launch city”. This cannot be undone."
    assert (await _apply(client, ctx, "approver", card))["can_undo"] is False
    # The route's own audit rows say it came via Ask Oracle (written with the change).
    async with tenant_session(ctx.tenant_id) as s:
        rows = list(await s.scalars(select(AuditEvent).where(AuditEvent.action.like("decision%"))))
    assert rows and all(r.data.get("via") == "Ask Oracle" for r in rows), rows


def test_undo_needs_one_id_matching_the_delete():
    cat = ask_actions.catalogue(app).actions
    back = ask_actions._deleter(cat["create_entity"])
    assert back is not None and back.name == "delete_entity"
    assert ask_actions._result_id([{"id": str(uuid.uuid4())}], back) is None
    assert ask_actions._result_id({"items": [{"id": str(uuid.uuid4())}]}, back) is None
    rid = str(uuid.uuid4())
    assert ask_actions._result_id({"id": rid}, back) == rid
    assert ask_actions.inverse(cat["create_decision"]) is None
    assert (
        ask_actions.inverse(cat["update_entity"], {"body": {"reason": "x"}}, {"title": "a"}) is None
    )
    assert (
        ask_actions.inverse(cat["update_entity"], {"body": {"title": "b"}}, {"title": "a"})
        == "edit"
    )
    assert ask_actions.inverse(cat["archive_theme"]) == "restore"


async def test_a_secret_is_never_kept_in_a_card(client):
    ctx = await make_people()
    await World(ctx).build()
    body = {"type": "assumption", "key": "k1", "title": "Example",
            "attrs": {"api_key": "example-value"}}  # fmt: skip
    call = {"action": "create_entity", "args": {"body": body}}
    m = await _called(client, ctx, "approver", call)
    assert m["cards"] == [] and "secret" in m["body"], m
    assert "example-value" not in m["body"]


async def test_a_meeting_offers_only_reads_every_attendee_reaches(client, meetings):  # noqa: F811
    ctx = await make_people()
    await World(ctx).build()
    mid = _meeting(ctx, meetings)  # a viewer attends
    seen: list = []
    m = await _called(client, ctx, "owner", {"action": "list_members", "args": {}},
                      meeting=mid, seen=seen)  # fmt: skip
    assert "list_members" not in {a["action"] for a in seen[0]["api"]}
    assert len(seen) == 1 and m["kind"] == "note", m  # never run, never worded
    assert "dee@example.com" not in m["body"]
    assert "everyone here" in m["body"]
    # The owner's own Ask panel reaches it.
    seen = []
    await _called(client, ctx, "owner", {"action": "list_members", "args": {}}, seen=seen)
    assert "list_members" in {a["action"] for a in seen[0]["api"]}


async def test_apply_all_leaves_api_action_cards_for_their_own_apply(client):
    ctx = await make_people()
    await World(ctx).build()
    m = await _called(client, ctx, "approver", _entity_call("a-one")["calls"][0],
                      _entity_call("a-two")["calls"][0])  # fmt: skip
    assert len(m["cards"]) == 2
    r = await client.post(f"/v1/simple/chat/messages/{m['id']}/apply-all",
                          headers=ctx.as_("approver"))  # fmt: skip
    assert r.status_code == 409, r.text
    assert await _entity(ctx, "a-one") is None and await _entity(ctx, "a-two") is None


async def test_undo_of_a_dependency_card_turns_back_only_its_dependency(client):
    ctx = await make_people()
    w = await World(ctx).build()
    bulk = w.ids["Bulk import"]
    talk = f"/simple/roadmap/items/{bulk}"

    async def dep_card(op: str, on: str) -> dict:
        r = await client.post("/v1/simple/chat/messages", json={"text": "that one", "page": talk},
                              headers=ctx.as_("owner"))  # fmt: skip
        assert r.status_code == 200, r.text
        await read(ctx, {"actions": [{"op": op, "args": {"item": bulk, "on": w.ids[on]}}]})
        r = await client.get("/v1/simple/chat", params={"page": talk}, headers=ctx.as_("owner"))
        [card] = r.json()["messages"][-1]["cards"]
        await _apply(client, ctx, "owner", card)
        return card

    removed = await dep_card("remove_dependency", "Ledger v2")
    await dep_card("add_dependency", "Alert digest")
    assert (await w.item("Bulk import")).depends_on == ["alert-digest"]
    r = await client.post(f"{CARDS}/{removed['id']}/undo", headers=ctx.as_("owner"))
    assert r.status_code == 200, r.text
    assert sorted((await w.item("Bulk import")).depends_on) == ["alert-digest", "ledger-v2"]
