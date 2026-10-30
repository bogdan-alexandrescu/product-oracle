"""Simple S3b (#723): the change engine's non-versioned targets (oracle.simple.targets):
priority overrides, item tasks, action items and launch tasks, over ``/v1/simple/changes``.
Against Postgres.

Each test seeds one roadmap item ``x`` (a feature, a live launch with one task, one item
task and one action item) and ``y`` (no feature, no launch), with a decider on the
roadmap, and acts over REST. People and the clock: tests.test_simple_changes_api. No
Claude account exists and the gateway is stubbed to fail (``no_llm``): an override's
reason check never reaches a model.

Test cards (protects / fails_when / no_claim):

- test_permission_matrix (role x every op): protects=owners and the decider apply (the
  target changes); approvers and commenters propose, routed to the decider, and nothing
  is written (an add creates no row); viewers get 403; fails_when=a proposer writes, a
  decider is refused or a viewer is let in; no_claim=the web.
- test_accept_applies_decline_does_not (every op): protects=a declined proposal leaves the
  target as it was and keeps its reason; an accepted one applies (an add creates its row);
  an approver who does not decide gets 403; fails_when=either way; no_claim=the Inbox
  screen (S3a's tests).
- test_undo_restores (every op): protects=only the author undoes; the undo restores
  ``before`` (an add's undo deletes its task or action item; a launch task, which the
  launches service never deletes, is skipped "Undone in Simple"); the original stays as
  history beside the ``undone`` row, and both are audited; fails_when=the target keeps
  the change, a row survives, or history is lost; no_claim=undo after the session closes
  (S3a's rule, shared code).
- test_stale_before_is_409 (every edit op): protects=a change whose ``before`` no longer
  holds answers 409 with the current values and who changed them, writing nothing, and a
  proposal made before that change is "outdated" on accept; fails_when=a stale change
  lands; no_claim=add ops (their ``before`` is empty).
- test_override_rules: protects=an override needs a one-line reason (422 without) and an
  item with a feature (422); it replaces the feature's active override, whose undo
  re-creates the previous one; fails_when=a reasonless pin lands, or the undo loses the
  earlier override; no_claim=Oracle's pushback wording (tests/test_priority_overrides.py).
- test_launch_task_needs_a_live_launch: protects=add_launch_task on an item no live launch
  covers is 422 and writes nothing; fails_when=a task lands on no launch;
  no_claim=cancelled launches' checklists.
- test_action_item_without_an_item: protects=an action item under no roadmap item is an
  owner's to add directly; others propose to the company's owners, who accept it;
  fails_when=a decider of some roadmap applies it, or it routes elsewhere;
  no_claim=meetings' action items (S8).
"""

from typing import Any

import pytest
from sqlalchemy import func, select

from oracle.auth.models import User
from oracle.launches.models import Launch, LaunchTask
from oracle.models import AuditEvent
from oracle.priorities.models import PriorityOverride
from oracle.review.models import DocumentReviewPolicy
from oracle.simple.models import RoadmapItemTask, SimpleActionItem
from oracle.tenancy import tenant_session
from tests.baseline_helpers import Ctx
from tests.test_simple_changes_api import CHANGES, clock, make_people  # noqa: F401
from tests.test_simple_roadmap_api import Seed

OPS = [
    "override_priority",
    "add_item_task",
    "edit_item_task",
    "set_item_task_status",
    "add_action_item",
    "edit_action_item",
    "set_action_item_status",
    "add_launch_task",
    "set_launch_task_status",
]
EDITS = [op for op in OPS if not op.startswith("add_")]
REASON = "Northwind signs only if it ships first"


@pytest.fixture(autouse=True)
def no_llm(monkeypatch):
    """The reason check asks the gateway, which fails here: no model is reached and the
    pushback rules decide (as in tests/test_priority_overrides.py)."""
    from oracle.priorities import reason_check

    async def refuse(*a, **kw):
        raise RuntimeError("no model in tests")

    monkeypatch.setattr(reason_check.gateway, "complete", refuse)


class World:
    """Item ``x``: feature ``ledger``, a live launch (task "Brief sales"), an item task
    "Spec" and an action item "Call Northwind"; item ``y``: nothing."""

    def __init__(self, ctx: Ctx) -> None:
        self.ctx = ctx
        self.ids: dict[str, str] = {}

    async def build(self) -> "World":
        async with tenant_session(self.ctx.tenant_id) as s:
            seed = Seed(s)
            _, pv, rm, rv = await seed.roadmap("payments")
            track = await seed.track(pv, rm)
            feature = await seed.entity("feature", "ledger", effort=1)
            x = await seed.item(rv, pv, "x", track_id=track.id, feature_id=feature.id)
            y = await seed.item(rv, pv, "y", position=1, track_id=track.id)
            launch = await seed.add(Launch(title="Ledger", track_id=track.id,
                                           roadmap_version_id=rv.id, item_keys=["x"]))  # fmt: skip
            lt = await seed.add(LaunchTask(launch_id=launch.id, title="Brief sales", position=1,
                                           audience="internal"))  # fmt: skip
            owner = self.ctx.users["owner"].id
            task = await seed.add(RoadmapItemTask(item_id=x.id, roadmap_document_id=rm.id,
                                                  item_key="x", title="Spec", position=1,
                                                  created_by=owner))  # fmt: skip
            ai = await seed.add(SimpleActionItem(item_id=x.id, roadmap_document_id=rm.id,
                                                 item_key="x", title="Call Northwind",
                                                 owner_id=owner, created_by=owner))  # fmt: skip
            s.add(DocumentReviewPolicy(document_id=rm.id, decider_id=self.ctx.users["decider"].id))
            await s.commit()
            self.ids = {"x": str(x.id), "y": str(y.id), "feature": str(feature.id),
                        "launch": str(launch.id), "launch_task": str(lt.id),
                        "task": str(task.id), "action": str(ai.id)}  # fmt: skip
        return self

    def body(self, op: str, **over: Any) -> dict[str, Any]:
        x = self.ids["x"]
        task = {"item_id": x, "task_id": self.ids["task"]}
        action = {"item_id": x, "action_item_id": self.ids["action"]}
        commenter = str(self.ctx.users["commenter"].id)
        bodies: dict[str, dict[str, Any]] = {
            "override_priority": {"target": {"item_id": x}, "before": {"override": None},
                                  "after": {"position": 1, "reason": REASON}},
            "add_item_task": {"target": {"item_id": x}, "before": {},
                              "after": {"title": "Write the migration", "due_date": "2026-11-20"}},
            "edit_item_task": {"target": task, "before": {"title": "Spec"},
                               "after": {"title": "Spec v2"}},
            "set_item_task_status": {"target": task, "before": {"status": "todo"},
                                     "after": {"status": "doing"}},
            "add_action_item": {"target": {"item_id": x}, "before": {},
                                "after": {"title": "Send the pricing sheet",
                                          "owner_id": commenter}},
            "edit_action_item": {"target": action, "before": {"title": "Call Northwind"},
                                 "after": {"title": "Call Northwind today"}},
            "set_action_item_status": {"target": action, "before": {"status": "open"},
                                       "after": {"status": "done"}},
            "add_launch_task": {"target": {"item_id": x}, "before": {},
                                "after": {"title": "Tell support", "audience": "internal"}},
            "set_launch_task_status": {"target": {"item_id": x, "task_id": self.ids["launch_task"]},
                                       "before": {"status": "todo"}, "after": {"status": "done"}},
        }  # fmt: skip
        return {"op": op, **bodies[op], **over}

    async def post(self, client, who: str, op: str, **over: Any):
        return await client.post(CHANGES, json=self.body(op, **over), headers=self.ctx.as_(who))

    async def changed(self, op: str) -> bool:
        """Whether the op's effect is on the target."""
        async with tenant_session(self.ctx.tenant_id) as s:
            task = await s.get(RoadmapItemTask, self.ids["task"])
            action = await s.get(SimpleActionItem, self.ids["action"])
            lt = await s.get(LaunchTask, self.ids["launch_task"])
            match op:
                case "override_priority":
                    o = await s.scalar(select(PriorityOverride).where(
                        PriorityOverride.removed_at.is_(None),
                        PriorityOverride.feature_id == self.ids["feature"]))  # fmt: skip
                    return o is not None and (o.position, o.reason) == (1, REASON)
                case "add_item_task":
                    titles = await s.scalars(select(RoadmapItemTask.title))
                    return "Write the migration" in list(titles)
                case "edit_item_task":
                    return task.title == "Spec v2"
                case "set_item_task_status":
                    return task.status == "doing"
                case "add_action_item":
                    titles = await s.scalars(select(SimpleActionItem.title))
                    return "Send the pricing sheet" in list(titles)
                case "edit_action_item":
                    return action.title == "Call Northwind today"
                case "set_action_item_status":
                    return action.status == "done"
                case "add_launch_task":
                    added = await s.scalar(
                        select(LaunchTask).where(LaunchTask.title == "Tell support")
                    )
                    return added is not None and added.status != "skipped"
                case "set_launch_task_status":
                    return lt.status == "done"
        raise AssertionError(op)

    async def count(self, model) -> int:
        async with tenant_session(self.ctx.tenant_id) as s:
            return await s.scalar(select(func.count()).select_from(model))


@pytest.mark.parametrize("role", ["owner", "decider", "approver", "commenter", "viewer"])
async def test_permission_matrix(client, role):
    ctx = await make_people()
    w = await World(ctx).build()
    applies = role in ("owner", "decider")
    for op in OPS:
        r = await w.post(client, role, op)
        if role == "viewer":
            assert r.status_code == 403, (op, r.text)
            assert not await w.changed(op), op
            continue
        assert r.status_code == 201, (op, r.text)
        change = r.json()["change"]
        assert (change["op"], change["status"]) == (op, "applied" if applies else "proposed")
        assert await w.changed(op) is applies, op
        if not applies:
            assert change["routed_to"] == [str(ctx.users["decider"].id)], op
            assert change["session_id"] is None
    if not applies:
        # Proposed adds create nothing.
        assert (await w.count(RoadmapItemTask), await w.count(SimpleActionItem)) == (1, 1)
        assert await w.count(LaunchTask) == 1


@pytest.mark.parametrize("op", OPS)
async def test_accept_applies_decline_does_not(client, op):
    ctx = await make_people()
    w = await World(ctx).build()
    first = (await w.post(client, "commenter", op)).json()["change"]
    r = await client.post(f"{CHANGES}/{first['id']}/decline", json={"reason": "Not now"},
                          headers=ctx.as_("decider"))  # fmt: skip
    assert r.status_code == 200, r.text
    assert (r.json()["change"]["status"], r.json()["change"]["decision_reason"]) == (
        "declined",
        "Not now",
    )
    assert not await w.changed(op)
    second = (await w.post(client, "commenter", op)).json()["change"]
    accept = f"{CHANGES}/{second['id']}/accept"
    assert (await client.post(accept, json={}, headers=ctx.as_("approver"))).status_code == 403
    r = await client.post(accept, json={}, headers=ctx.as_("decider"))
    assert r.status_code == 200, r.text
    assert r.json()["change"]["status"] == "accepted"
    assert await w.changed(op)
    assert (await client.post(accept, json={}, headers=ctx.as_("decider"))).status_code == 409


@pytest.mark.parametrize("op", OPS)
async def test_undo_restores(client, op):
    ctx = await make_people()
    w = await World(ctx).build()
    r = await w.post(client, "decider", op)
    assert r.status_code == 201, r.text
    change = r.json()["change"]
    assert change["can_undo"] is True
    undo = f"{CHANGES}/{change['id']}/undo"
    assert (await client.post(undo, headers=ctx.as_("owner"))).status_code == 403
    r = await client.post(undo, headers=ctx.as_("decider"))
    assert r.status_code == 201, r.text
    assert (r.json()["change"]["status"], r.json()["change"]["undoes_id"]) == (
        "undone",
        change["id"],
    )
    assert not await w.changed(op)
    if op in ("add_item_task", "add_action_item"):
        assert (await w.count(RoadmapItemTask), await w.count(SimpleActionItem)) == (1, 1)
    if op == "add_launch_task":
        async with tenant_session(ctx.tenant_id) as s:
            added = await s.scalar(select(LaunchTask).where(LaunchTask.title == "Tell support"))
            assert (added.status, added.skip_reason) == ("skipped", "Undone in Simple")
    assert (await client.post(undo, headers=ctx.as_("decider"))).status_code == 409
    rows = (await client.get(CHANGES, headers=ctx.as_("owner"))).json()
    assert sorted(c["status"] for c in rows) == ["applied", "undone"]
    async with tenant_session(ctx.tenant_id) as s:
        actions = set(
            await s.scalars(select(AuditEvent.action).where(AuditEvent.entity == "simple_change"))
        )
    assert actions == {"simple_change.applied", "simple_change.undone"}


OTHER = {
    "override_priority": ({"position": 2, "reason": "Sooner"},
                          {"override": {"kind": "pin", "position": 2, "above_feature_id": None,
                                        "reason": "Sooner"}}),
    "edit_item_task": ({"title": "Spec v3"}, {"title": "Spec v3"}),
    "set_item_task_status": ({"status": "done"}, {"status": "done"}),
    "edit_action_item": ({"title": "Email Northwind"}, {"title": "Email Northwind"}),
    "set_action_item_status": ({"status": "dropped"}, {"status": "dropped"}),
    "set_launch_task_status": ({"status": "drafted"}, {"status": "drafted"}),
}  # fmt: skip


@pytest.mark.parametrize("op", EDITS)
async def test_stale_before_is_409(client, op):
    ctx = await make_people()
    w = await World(ctx).build()
    proposal = (await w.post(client, "commenter", op)).json()["change"]
    after, current = OTHER[op]
    r = await w.post(client, "owner", op, after=after)
    assert r.status_code == 201, r.text
    before = await client.get(CHANGES, headers=ctx.as_("owner"))
    r = await w.post(client, "decider", op)
    assert r.status_code == 409, r.text
    detail = r.json()["detail"]
    assert detail["current"] == current
    assert "owner@example.com" in detail["message"]
    assert len((await client.get(CHANGES, headers=ctx.as_("owner"))).json()) == len(before.json())
    assert not await w.changed(op)
    r = await client.post(f"{CHANGES}/{proposal['id']}/accept", json={},
                          headers=ctx.as_("decider"))  # fmt: skip
    assert r.status_code == 409, r.text
    assert r.json()["detail"]["message"].startswith("outdated: changed by owner@example.com")
    assert not await w.changed(op)


async def test_override_rules(client):
    ctx = await make_people()
    w = await World(ctx).build()
    for after in (
        {"position": 1},
        {"position": 1, "reason": "  "},
        {"position": 0, "reason": REASON},
    ):
        r = await w.post(client, "decider", "override_priority", after=after)
        assert r.status_code == 422, (after, r.text)
    r = await w.post(client, "decider", "override_priority", target={"item_id": w.ids["y"]})
    assert r.status_code == 422, r.text
    assert await w.count(PriorityOverride) == 0
    # An earlier pin made on the Priorities screen; Simple's replaces it.
    r = await client.post("/v1/priorities/overrides", headers=ctx.as_("owner"),
                          json={"feature_id": w.ids["feature"], "kind": "pin", "position": 3,
                                "reason": "The first call"})  # fmt: skip
    assert r.status_code == 201, r.text
    earlier = {"kind": "pin", "position": 3, "above_feature_id": None, "reason": "The first call"}
    r = await w.post(client, "decider", "override_priority", before={"override": None})
    assert r.status_code == 409, r.text
    assert r.json()["detail"]["current"] == {"override": earlier}
    r = await w.post(client, "decider", "override_priority", before={"override": earlier},
                     after={"position": 1, "reason": f"{REASON}\nreally"})  # fmt: skip
    assert r.status_code == 422, r.text
    r = await w.post(client, "decider", "override_priority", before={"override": earlier})
    assert r.status_code == 201, r.text
    assert await w.changed("override_priority")
    undo = await client.post(f"{CHANGES}/{r.json()['change']['id']}/undo",
                             headers=ctx.as_("decider"))  # fmt: skip
    assert undo.status_code == 201, undo.text
    async with tenant_session(ctx.tenant_id) as s:
        active = list(await s.scalars(select(PriorityOverride).where(
            PriorityOverride.removed_at.is_(None))))  # fmt: skip
    assert [(o.position, o.reason) for o in active] == [(3, "The first call")]


async def test_override_clear_goes_back_to_oracles_rank(client):
    """qa-simple-plan-4: ``after.clear`` ends the feature's override (no reason, no new pin);
    its undo puts the pin back; with no override it is a 409."""
    ctx = await make_people()
    w = await World(ctx).build()
    r = await w.post(client, "decider", "override_priority", after={"clear": True})
    assert r.status_code == 409, r.text
    r = await w.post(client, "decider", "override_priority")
    assert r.status_code == 201, r.text
    pin = {"kind": "pin", "position": 1, "above_feature_id": None, "reason": REASON}
    r = await w.post(client, "decider", "override_priority", before={"override": pin},
                     after={"clear": True})  # fmt: skip
    assert r.status_code == 201, r.text
    assert r.json()["change"]["status"] == "applied"

    async def active() -> list[tuple[int | None, str]]:
        async with tenant_session(ctx.tenant_id) as s:
            rows = await s.scalars(
                select(PriorityOverride).where(PriorityOverride.removed_at.is_(None))
            )
            return [(o.position, o.reason) for o in rows]

    assert await active() == []
    undo = await client.post(f"{CHANGES}/{r.json()['change']['id']}/undo",
                             headers=ctx.as_("decider"))  # fmt: skip
    assert undo.status_code == 201, undo.text
    assert await active() == [(1, REASON)]


async def test_launch_task_needs_a_live_launch(client):
    ctx = await make_people()
    w = await World(ctx).build()
    r = await w.post(client, "owner", "add_launch_task", target={"item_id": w.ids["y"]})
    assert r.status_code == 422, r.text
    assert await w.count(LaunchTask) == 1


async def test_action_item_without_an_item(client):
    ctx = await make_people()
    w = await World(ctx).build()
    loose = {"target": {}, "before": {}}
    r = await w.post(client, "owner", "add_action_item", **loose)
    assert r.status_code == 201, r.text
    assert r.json()["change"]["status"] == "applied"
    assert r.json()["change"]["document_id"] is None
    owner = str(ctx.users["owner"].id)
    r = await w.post(client, "decider", "add_action_item", **loose,
                     after={"title": "Book the room", "owner_id": owner})  # fmt: skip
    assert r.status_code == 201, r.text
    change = r.json()["change"]
    assert (change["status"], change["routed_to"]) == ("proposed", [str(ctx.users["owner"].id)])
    assert await w.count(SimpleActionItem) == 2
    accept = f"{CHANGES}/{change['id']}/accept"
    assert (await client.post(accept, json={}, headers=ctx.as_("decider"))).status_code == 403
    r = await client.post(accept, json={}, headers=ctx.as_("owner"))
    assert r.status_code == 200, r.text
    async with tenant_session(ctx.tenant_id) as s:
        row = await s.scalar(
            select(SimpleActionItem).where(SimpleActionItem.title == "Book the room")
        )
        assert row is not None and row.item_id is None
        assert (await s.get(User, row.owner_id)).role == "owner"
