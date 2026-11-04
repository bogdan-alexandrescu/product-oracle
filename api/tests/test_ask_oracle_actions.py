"""Ask Oracle does what a person can do (owner, Nov 4): the action catalogue built from the
API (oracle.simple.ask_actions), the chats' reader choosing from it, reads at once, writes
as cards applied through the page's own route as the person, Undo where there is an
inverse; and the dependency op the feature talk lacked (``set_depends_on``). Against
Postgres; the model is always a fake ``ask``.

Test cards (protects / fails_when / no_claim):

- test_every_write_route_is_an_action_or_denied: protects=every write route of the app is
  in the catalogue (its role, reads=False) or deny-listed with a reason; auth, tokens,
  credentials, secrets, member removal, Trash purge and outward sends are denied;
  fails_when=a write route is in neither, or a denied one is offered; no_claim=GETs' own
  wording.
- test_a_new_route_joins_the_catalogue: protects=generated, not hand-listed: a route added
  to an app is an action with its route's role; fails_when=the catalogue is a fixed list.
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
"""

from fastapi import Depends, FastAPI
from sqlalchemy import select

from oracle.authz import require_role
from oracle.baseline.models import Entity
from oracle.main import app
from oracle.mcp.tools import snake_case
from oracle.models import AuditEvent
from oracle.simple import ask_actions
from oracle.tenancy import tenant_session
from tests.test_simple_chat_api import CARDS, World, make_people, n_changes
from tests.test_simple_chat_reader import clock as clock  # noqa: F401
from tests.test_simple_chat_reader import last, post, read

WRITES = ("post", "put", "patch", "delete")


def test_every_write_route_is_an_action_or_denied():
    cat = ask_actions.catalogue(app)
    seen = 0
    for path, item in app.openapi()["paths"].items():
        for method, spec in item.items():
            if method not in WRITES:
                continue
            seen += 1
            op = spec["operationId"]
            a = cat.actions.get(snake_case(op))
            if a is not None and a.path == path:
                assert not a.reads and a.method == method.upper(), op
                assert a.needs in ("viewer", "commenter", "approver", "owner"), op
            else:
                assert cat.denied.get(op), (method, path, "neither an action nor denied")
    assert seen > 100
    for op in ("login", "create_personal_token", "change_password", "purge_trash_entry",
               "remove_member", "revoke_api_token", "create_webhook", "add_claude_account",
               "notify_requesters", "post_simple_chat", "apply_simple_chat_card"):  # fmt: skip
        assert cat.denied.get(op), op
        assert snake_case(op) not in cat.actions, op
    assert cat.actions["create_entity"].needs == "approver"
    assert cat.actions["list_entities"].reads is True


def test_a_new_route_joins_the_catalogue():
    toy = FastAPI()

    @toy.post("/v1/widgets", name="make_widget")
    async def make_widget(_p=Depends(require_role("approver"))) -> dict:  # noqa: B008
        return {}

    [a] = [a for a in ask_actions.catalogue(toy).actions.values() if a.path == "/v1/widgets"]
    assert (a.method, a.needs, a.reads) == ("POST", "approver", False)


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
