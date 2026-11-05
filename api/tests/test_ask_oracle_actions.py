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
- test_no_allowed_operation_pings_a_person_or_reaches_an_outbox: protects=no allowed route's
  calls reach a Slack ping, the Slack outbox or the mailer (a question asked of someone, a
  decision requested of its approver are denied with why); fails_when=one does.
- test_a_card_names_every_record_its_body_points_to: protects=create_edge's card names both
  records, a reparent names the new parent, an id no one can name gets no card.
- test_undo_is_not_promised_for_a_merged_value: protects=an edit sending a dict (attrs, which
  the route merges) says before Apply it cannot be undone.
- test_a_meeting_never_reads_one_person_own_records: protects=two members of one role in a
  meeting: the asker's own sources are neither offered nor read there.
- test_a_secret_value_is_never_kept_in_a_card: protects=a token pasted into a title: no card.
- test_a_proposal_answer_promises_no_undo: protects=a 202 (a proposal) keeps no Undo.
- test_a_card_whose_commit_failed_cannot_apply_twice: protects=the route ran, the card's own
  write failed: a second Apply is refused, the route is not called again.
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
from tests.test_slack_pings import bridge_slack, slack  # noqa: F401 -- the fixtures

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
    blocker = {"key": "night-staffing", "statement": "Night staffing is thin", "type": "soft"}
    m = await _called(client, ctx, "approver",
                      {"action": "create_blocker", "args": {"body": blocker}})  # fmt: skip
    [card] = m["cards"]
    assert card["summary"] == (
        "Add a blocker: key “night-staffing”, statement “Night staffing is thin”, type “soft”. "
        "This cannot be undone."
    )
    assert (await _apply(client, ctx, "approver", card))["can_undo"] is False
    # The route's own audit rows say it came via Ask Oracle (written with the change).
    async with tenant_session(ctx.tenant_id) as s:
        rows = list(await s.scalars(select(AuditEvent).where(AuditEvent.action.like("blocker%"))))
    assert rows and all(r.data.get("via") == "Ask Oracle" for r in rows), rows


def test_undo_needs_one_id_matching_the_delete():
    cat = ask_actions.catalogue(app).actions
    back = ask_actions._deleter(cat["create_entity"])
    assert back is not None and back.name == "delete_entity"
    assert ask_actions._result_id([{"id": str(uuid.uuid4())}], back) is None
    assert ask_actions._result_id({"items": [{"id": str(uuid.uuid4())}]}, back) is None
    rid = str(uuid.uuid4())
    assert ask_actions._result_id({"id": rid}, back) == rid
    assert ask_actions.inverse(cat["create_blocker"]) is None
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


# --------------------------------------------------------------------------- fix round 2

# Each sends to a person or a system outside Oracle (Slack DMs and posts, email).
SENDS = (
    "oracle.slack.pings.queue", "oracle.slack.pings.draft_ready", "oracle.slack.pings.notification",
    "oracle.slack.bridge.queue", "oracle.slack.bridge.queue_new", "oracle.slack.models.SlackOutbox",
    "oracle.members.mailer.get_mailer",
)  # fmt: skip


def _reaches(fn, seen: set, path: tuple = ()) -> tuple | None:
    """The call path from ``fn`` to one of ``SENDS`` (None: none): each name the function
    uses, resolved in its module or its own imports, followed into Oracle's functions."""
    import ast
    import importlib
    import inspect
    import textwrap

    fn = inspect.unwrap(fn)
    where = f"{getattr(fn, '__module__', '')}.{getattr(fn, '__qualname__', '')}"
    if where in SENDS:
        return (*path, where)
    if where in seen or not where.startswith("oracle.") or not inspect.isfunction(fn):
        return None
    seen.add(where)
    try:
        tree = ast.parse(textwrap.dedent(inspect.getsource(fn)))
    except (OSError, TypeError, SyntaxError):
        return None
    scope = dict(vars(inspect.getmodule(fn)))
    for node in ast.walk(tree):
        if isinstance(node, ast.ImportFrom) and node.module and node.level == 0:
            for a in node.names:
                try:
                    mod = importlib.import_module(node.module)
                    scope[a.asname or a.name] = getattr(
                        mod, a.name, None
                    ) or importlib.import_module(f"{node.module}.{a.name}")
                except ImportError:
                    continue
    for node in ast.walk(tree):
        chain: list[str] = []
        n = node
        while isinstance(n, ast.Attribute):
            chain.insert(0, n.attr)
            n = n.value
        if not isinstance(n, ast.Name) or not isinstance(node, ast.Name | ast.Attribute):
            continue
        obj = scope.get(n.id)
        for attr in chain:
            obj = getattr(obj, attr, None) if obj is not None else None
        if obj is None:
            continue
        name = f"{getattr(obj, '__module__', '')}.{getattr(obj, '__qualname__', '')}"
        if name in SENDS:
            return (*path, where, name)
        if inspect.isfunction(obj):
            found = _reaches(obj, seen, (*path, where))
            if found:
                return found
    return None


async def _person_name(client, ctx, who: str) -> str:
    r = await client.get("/v1/people", params={"ids": str(ctx.users[who].id)},
                         headers=ctx.as_("viewer"))  # fmt: skip
    assert r.status_code == 200, r.text
    [p] = r.json()
    assert p["name"] and not ask_actions._is_id(p["name"])
    return p["name"]


def _pinging(who: uuid.UUID, entity: str) -> dict[str, dict]:
    """A call of each route that pings ``who`` (fix round 3: offered, its card names them)."""
    subject = {"kind": "entity", "entity_id": entity}
    return {
        "create_decision": {"body": {"title": "Ship the weekly digest", "approver_id": str(who)}},
        "create_question": {"body": {"prompt": "Who reads the digest?", "asked_to": str(who),
                                     "subject": subject}},
    }  # fmt: skip


async def test_an_allowed_route_that_pings_names_each_person_on_its_card(client):
    """A route that reaches a Slack ping, the Slack outbox or the mailer is allowed only
    when its card names the recipients: each such route's card, made here, says "Sends a
    Slack message to <name>". (Company webhooks are Oracle's own events: allowed.)

    The walk's limit: it follows the names a function's body uses, resolved in its module
    or its own imports (functions and module attributes); a method called on an object made
    at run time (``obj.send()``, ``self.x()``) or a function passed in as a value is not
    followed, so a ping reached only that way is missed."""
    from fastapi.routing import iter_route_contexts

    ctx = await make_people()
    await World(ctx).build()
    entity = await _new_entity(client, ctx, "night-nurse", "Night shift nurse")
    name = await _person_name(client, ctx, "decider")
    calls = _pinging(ctx.users["decider"].id, entity)
    by_route = {(m, r.path_format): r.endpoint for r in iter_route_contexts(app.router.routes)
                if hasattr(r, "endpoint") for m in getattr(r, "methods", None) or ()}  # fmt: skip
    reached = {}
    for a in ask_actions.catalogue(app).actions.values():
        if not a.reads and _reaches(by_route[(a.method, a.path)], set()):
            reached[a.name] = a
    # The three the owner restored (Nov 5) are offered and reach a ping.
    assert {"create_decision", "create_question", "update_question"} <= set(reached), reached
    for op in ("create_question", "update_question", "create_decision"):
        assert op not in OUTWARD_OR_SECRET and op in ask_actions.ALLOWED, op
        assert op in ask_actions.PINGS, op
    for n in reached:
        assert n in ask_actions.PINGS, f"{n} pings someone its card does not name"
        if n == "update_question":
            continue  # its card: test_a_reassigned_question_names_the_new_person
        m = await _called(client, ctx, "approver", {"action": n, "args": calls[n]})
        [card] = m["cards"]
        assert f"Sends a Slack message to {name} " in card["summary"], card["summary"]
        assert str(ctx.users["decider"].id) not in card["summary"]


def test_the_walk_sees_a_ping():
    from oracle.decisions import service as decisions
    from oracle.intake import questions

    assert _reaches(questions.ping_asked, set())
    assert _reaches(decisions._ping_approver, set())


async def _new_entity(client, ctx, key: str, title: str) -> str:
    r = await client.post("/v1/baseline/entities", headers=ctx.as_("approver"),
                          json={"type": "assumption", "key": key, "title": title})  # fmt: skip
    assert r.status_code == 201, r.text
    return r.json()["entity"]["id"]


async def test_a_card_names_every_record_its_body_points_to(client):
    ctx = await make_people()
    await World(ctx).build()
    a = await _new_entity(client, ctx, "night-nurse", "Night shift nurse")
    b = await _new_entity(client, ctx, "day-nurse", "Day shift nurse")
    link = {"action": "create_edge",
            "args": {"body": {"src_id": a, "dst_id": b, "type": "depends_on"}}}  # fmt: skip
    m = await _called(client, ctx, "approver", link)
    [card] = m["cards"]
    assert "“Night shift nurse”" in card["summary"] and "“Day shift nurse”" in card["summary"]
    assert card["summary"].startswith("Link two records: from “Night shift nurse”, to “Day shift")
    # A body id no one can name: no card.
    link["args"]["body"]["dst_id"] = str(uuid.uuid4())
    m = await _called(client, ctx, "approver", link)
    assert m["cards"] == [] and ask_actions.NO_NAME in m["body"], m
    # A move to another parent says where to.
    move = {"action": "update_entity", "args": {"entity_id": a, "body": {"parent_id": b}}}
    m = await _called(client, ctx, "approver", move)
    [card] = m["cards"]
    assert "parent “Day shift nurse”" in card["summary"], card["summary"]


async def test_undo_is_not_promised_for_a_merged_value(client):
    ctx = await make_people()
    await World(ctx).build()
    a = await _new_entity(client, ctx, "night-nurse", "Night shift nurse")
    edit = {"action": "update_entity",
            "args": {"entity_id": a, "body": {"attrs": {"shift": "night"}}}}  # fmt: skip
    m = await _called(client, ctx, "approver", edit)
    [card] = m["cards"]
    assert card["summary"].endswith(ask_actions.CANNOT_UNDO), card["summary"]
    assert (await _apply(client, ctx, "approver", card))["can_undo"] is False
    cat = ask_actions.catalogue(app).actions
    assert ask_actions.inverse(cat["update_entity"], {"body": {"attrs": {"x": 1}}},
                               {"attrs": {}}) is None  # fmt: skip


async def test_a_meeting_never_reads_one_person_own_records(client, meetings):  # noqa: F811
    from tests.test_simple_chat_api import MeetingRules

    ctx = await make_people()
    await World(ctx).build()
    # Two members of the same role: each reads only their own sources.
    mid = uuid.uuid4()
    u = ctx.users
    assert u["approver"].role == u["decider"].role
    meetings.rules[mid] = MeetingRules(
        meeting_id=mid, session_id=None, presenter_id=u["approver"].id,
        attendee_ids=[u["approver"].id, u["decider"].id], change_mode="everyone",
    )  # fmt: skip
    seen: list = []
    m = await _called(client, ctx, "approver", {"action": "list_sources", "args": {}},
                      meeting=mid, seen=seen)  # fmt: skip
    offered = {a["action"] for a in seen[0]["api"]}
    assert "list_sources" not in offered and "get_source" not in offered
    assert len(seen) == 1 and m["kind"] == "note", m  # never run, never worded
    seen = []
    await _called(client, ctx, "approver", {"action": "list_sources", "args": {}}, seen=seen)
    assert "list_sources" in {a["action"] for a in seen[0]["api"]}


async def test_a_secret_value_is_never_kept_in_a_card(client):
    ctx = await make_people()
    await World(ctx).build()
    pasted = "ghp_" + "Example0Token1Not2Real3Value4Abc5"
    body = {"type": "assumption", "key": "k2", "title": f"Use {pasted}"}
    m = await _called(client, ctx, "approver", {"action": "create_entity", "args": {"body": body}})
    assert m["cards"] == [] and "secret" in m["body"], m
    assert pasted not in m["body"]
    assert ask_actions._secret({"title": "Night shift nurse, 2026 plan"}) is False


async def test_a_proposal_answer_promises_no_undo(monkeypatch):
    from types import SimpleNamespace

    cat = ask_actions.catalogue(app).actions
    pid = str(uuid.uuid4())

    async def proposed(db, principal, action, args):
        return 202, {"applied": False, "entity": None, "proposal": {"id": pid}}

    async def nothing(*a, **k):
        return None

    class Db:
        async def commit(self):
            return None

    monkeypatch.setattr(ask_actions, "call", proposed)
    monkeypatch.setattr(ask_actions.audit, "record", nothing)
    c = SimpleNamespace(id=uuid.uuid4(), summary="Add a product record", before={},
                        target={"action": "create_entity", "args": {"body": {"key": "k"}}},
                        after={"undo": "delete"})  # fmt: skip
    await ask_actions.apply(Db(), SimpleNamespace(role="approver"), c)
    assert c.after["undo"] is None, c.after
    assert cat["create_entity"].creates


async def test_a_card_whose_commit_failed_cannot_apply_twice(client, monkeypatch):
    ctx = await make_people()
    await World(ctx).build()
    m = await _called(client, ctx, "approver", _entity_call("once-only")["calls"][0])
    [card] = m["cards"]

    real = ask_actions.audit.record

    async def broken(db, principal, action, *a, **k):
        # The card's own row fails, after the route's write.
        if action == "simple_chat.api_action":
            raise RuntimeError("the card's write failed")
        return await real(db, principal, action, *a, **k)

    monkeypatch.setattr(ask_actions.audit, "record", broken)
    try:
        r = await client.post(f"{CARDS}/{card['id']}/apply", headers=ctx.as_("approver"))
        assert r.status_code >= 500
    except RuntimeError:
        pass
    monkeypatch.undo()
    assert await _entity(ctx, "once-only") is not None
    r = await client.post(f"{CARDS}/{card['id']}/apply", headers=ctx.as_("approver"))
    # Refused as a card applied once, not by the route (its record exists already).
    assert r.status_code == 409 and "Oracle could not" not in r.text, r.text


# --------------------------------------------------------------------------- fix round 3


async def test_a_decision_request_names_the_approver_and_apply_pings_exactly_them(client, slack):  # noqa: F811
    from tests.test_slack_bridge import install
    from tests.test_slack_pings import pings_of

    ctx = await make_people()
    await World(ctx).build()
    await install(client, ctx)
    name = await _person_name(client, ctx, "decider")
    ask = {"action": "create_decision", "args": {"body": {
        "title": "Ship the weekly digest",
        "approver_id": str(ctx.users["decider"].id)}}}  # fmt: skip
    m = await _called(client, ctx, "owner", ask)
    [card] = m["cards"]
    assert card["summary"] == (
        f"Request a decision: title “Ship the weekly digest”, approver “{name}”. "
        f"Sends a Slack message to {name} asking for a decision. {ask_actions.CANNOT_UNDO}"
    ), card["summary"]
    assert await pings_of(ctx) == []
    applied = await _apply(client, ctx, "owner", card)
    assert applied["can_undo"] is False
    [ping] = await pings_of(ctx)
    assert ping.recipient_id == ctx.users["decider"].id
    r = await client.get("/v1/decisions", headers=ctx.as_("owner"))
    assert "Ship the weekly digest" in r.text
    # A person no one can name: no card, no ping.
    ask["args"]["body"]["approver_id"] = str(uuid.uuid4())
    m = await _called(client, ctx, "owner", ask)
    assert m["cards"] == [] and ask_actions.NO_NAME in m["body"], m


async def test_a_question_names_whom_it_asks_and_a_reassigned_one_the_new_person(client, slack):  # noqa: F811
    from tests.test_slack_bridge import install
    from tests.test_slack_pings import pings_of

    ctx = await make_people()
    await World(ctx).build()
    await install(client, ctx)
    entity = await _new_entity(client, ctx, "night-nurse", "Night shift nurse")
    decider = await _person_name(client, ctx, "decider")
    approver = await _person_name(client, ctx, "approver")
    ask = {"action": "create_question",
           "args": _pinging(ctx.users["decider"].id, entity)["create_question"]}  # fmt: skip
    [card] = (await _called(client, ctx, "owner", ask))["cards"]
    assert "entity “Night shift nurse”" in card["summary"], card["summary"]
    assert f"Sends a Slack message to {decider} with the question." in card["summary"]
    await _apply(client, ctx, "owner", card)
    assert [p.recipient_id for p in await pings_of(ctx)] == [ctx.users["decider"].id]
    async with tenant_session(ctx.tenant_id) as s:
        from oracle.v2.models import StakeholderQuestion

        q = await s.scalar(select(StakeholderQuestion).where(
            StakeholderQuestion.prompt == "Who reads the digest?"))  # fmt: skip
    move = {"action": "update_question",
            "args": {"question_id": str(q.id),
                     "body": {"asked_to": str(ctx.users["approver"].id)}}}  # fmt: skip
    [card] = (await _called(client, ctx, "owner", move))["cards"]
    assert f"Sends a Slack message to {approver} with the question." in card["summary"]
    assert card["summary"].endswith(ask_actions.CANNOT_UNDO)
    await _apply(client, ctx, "owner", card)
    assert [p.recipient_id for p in await pings_of(ctx)][-1] == ctx.users["approver"].id
    # A withdrawal pings no one, and its card says no message.
    stop = {"action": "update_question",
            "args": {"question_id": str(q.id), "body": {"status": "withdrawn"}}}  # fmt: skip
    [card] = (await _called(client, ctx, "owner", stop))["cards"]
    assert "Slack" not in card["summary"], card["summary"]


async def test_a_card_names_an_intake_a_prd_version_and_a_document(client):
    from oracle.docs.models import Document, DocumentVersion
    from tests.fixtures import draft, import_draft
    from tests.intake_helpers import create_intake

    ctx = await make_people()
    await World(ctx).build()
    intake = await create_intake(client, ctx, "approver", title="Saved addresses")
    gap = {"action": "create_knowledge_gap", "args": {"body": {
        "intake_id": intake["intake"]["id"], "category": "customer_user",
        "statement": "Who saves addresses?",
        "importance": "high"}}}  # fmt: skip
    [card] = (await _called(client, ctx, "approver", gap))["cards"]
    assert "intake “Saved addresses”" in card["summary"], card["summary"]
    await _apply(client, ctx, "approver", card)

    r = await import_draft(client, ctx.as_("approver"), draft("prd_v1.md"))
    assert r.status_code in (200, 201), r.text
    async with tenant_session(ctx.tenant_id) as s:
        doc = await s.scalar(select(Document).where(Document.slug == "checkout-redesign"))
        version = await s.scalar(select(DocumentVersion).where(
            DocumentVersion.document_id == doc.id))  # fmt: skip
    blocker = {"action": "create_blocker", "args": {"body": {
        "type": "dependency", "title": "Address API", "document_ids": [str(doc.id)]}}}  # fmt: skip
    [card] = (await _called(client, ctx, "approver", blocker))["cards"]
    assert f"document “{doc.title}”" in card["summary"], card["summary"]
    outcome = {"action": "create_outcome", "args": {"body": {
        "title": "More saved addresses", "prd_version_id": str(version.id)}}}  # fmt: skip
    [card] = (await _called(client, ctx, "approver", outcome))["cards"]
    assert f"PRD version “{doc.title} version {version.number}”" in card["summary"], card["summary"]
