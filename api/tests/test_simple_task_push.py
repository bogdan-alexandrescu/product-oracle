"""#1816 task-push: a task under a roadmap item goes to the connected tracker.

A task added, edited or set to a status over ``/v1/simple/changes`` is pushed through
``oracle.roadmap.tracker.push_task`` (the one tracker gate; while no connector is verified it
refuses, as ``push_track_to_tracker`` does). The task change itself never fails or waits on
the tracker: the task is saved and the push's result is on the task in the Simple roadmap
read (``tracker_ref``, ``tracker_url``, ``tracker_error``), with
``POST /v1/simple/tasks/{task_id}/tracker-push`` to retry. Against Postgres; people, the
clock and the seeded item ``x`` (with its task "Spec"): tests.test_simple_targets_api.

Test cards (protects / fails_when / no_claim):

- test_no_tracker_no_push: protects=with two-way sync off (no tracker connected) a task is
  saved, nothing is pushed and the task carries no tracker failure; fails_when=a push is
  tried, or a failure shows, with no tracker connected; no_claim=the web.
- test_refused_push_shows_on_the_task_with_retry: protects=connected but unverified, an
  added task is saved (201) and its read shows the gate's reason; Retry answers the task
  with the reason again; a viewer may not retry (403); fails_when=the refusal fails the
  change, or it is silent; no_claim=the wording of the reason (oracle.roadmap.tracker).
- test_verified_push_links_and_follows_status: protects=with a verified connector (stubbed
  here: none exists yet) an added task's record is created and linked, its read links it, a
  status change pushes to that record; a failing push on a status change keeps the change,
  the link, and shows the failure until a Retry succeeds; fails_when=the record is not
  linked, the status does not follow, a failure loses the change or stays after a good
  Retry; no_claim=any real tracker's API.
"""

import uuid

import pytest
from sqlalchemy import select

from oracle.config import get_settings
from oracle.roadmap import tracker
from oracle.roadmap.models import TrackerRecord
from oracle.simple.models import RoadmapItemTask
from oracle.tenancy import tenant_session
from tests.test_simple_changes_api import clock, make_people  # noqa: F401
from tests.test_simple_targets_api import World, no_llm  # noqa: F401

ROADMAP = "/v1/simple/roadmap"


def _retry(task_id: str) -> str:
    return f"/v1/simple/tasks/{task_id}/tracker-push"


async def _task(client, ctx, title: str) -> dict:
    r = await client.get(ROADMAP, headers=ctx.as_("owner"))
    assert r.status_code == 200, r.text
    x = next(i for i in r.json()["items"] if i["key"] == "x")
    return next(t for t in x["tasks"] if t["title"] == title)


class Connector:
    """A verified connector, stubbed: it creates a record on the first push and moves it
    after; ``fail`` makes the next push raise."""

    def __init__(self) -> None:
        self.calls: list[tuple[str, str | None]] = []
        self.fail = False

    async def push(self, db, principal, task, record):
        self.calls.append((task.status, str(record.id) if record else None))
        if self.fail:
            self.fail = False
            raise RuntimeError("the tracker timed out")
        state = {"todo": "todo", "doing": "in_progress", "done": "done"}.get(task.status, "todo")
        if record is None:
            record = TrackerRecord(tracker="linear", external_ref=f"ENG-{len(self.calls)}",
                                   title=task.title, url="https://tracker.example.com/ENG-1",
                                   state=state, observed_at=tracker.datetime.now(tracker.UTC),
                                   recorded_by=principal.id)  # fmt: skip
            db.add(record)
        else:
            record.state = state
        await db.flush()
        return record


async def test_no_tracker_no_push(client, monkeypatch):
    """With no tracker connected nothing is pushed and nothing fails."""
    ctx = await make_people()
    w = await World(ctx).build()
    monkeypatch.setattr(get_settings(), "tracker_two_way_enabled", False)
    seen = Connector()
    monkeypatch.setattr(tracker, "push_task", seen.push)
    r = await w.post(client, "owner", "add_item_task")
    assert r.status_code == 201, r.text
    t = await _task(client, ctx, "Write the migration")
    assert (t["tracker_ref"], t["tracker_url"], t["tracker_error"]) == (None, None, None)
    assert seen.calls == []


async def test_refused_push_shows_on_the_task_with_retry(client, monkeypatch):
    """A refused push keeps the task and shows the reason, with Retry."""
    ctx = await make_people()
    w = await World(ctx).build()
    monkeypatch.setattr(get_settings(), "tracker_two_way_enabled", True)
    r = await w.post(client, "owner", "add_item_task")
    assert r.status_code == 201, r.text
    t = await _task(client, ctx, "Write the migration")
    assert t["tracker_error"] == tracker.UNVERIFIED_REASON
    assert t["tracker_ref"] is None
    r = await client.post(_retry(t["id"]), headers=ctx.as_("owner"))
    assert r.status_code == 200, r.text
    assert r.json()["id"] == t["id"]
    assert r.json()["tracker_error"] == tracker.UNVERIFIED_REASON
    r = await client.post(_retry(t["id"]), headers=ctx.as_("viewer"))
    assert r.status_code == 403, r.text
    r = await client.post(_retry(str(uuid.uuid4())), headers=ctx.as_("owner"))
    assert r.status_code == 404, r.text


async def test_verified_push_links_and_follows_status(client, monkeypatch):
    """A verified push links the record, follows status, and shows a failure until Retry."""
    ctx = await make_people()
    w = await World(ctx).build()
    monkeypatch.setattr(get_settings(), "tracker_two_way_enabled", True)
    conn = Connector()
    monkeypatch.setattr(tracker, "push_task", conn.push)
    r = await w.post(client, "owner", "add_item_task")
    assert r.status_code == 201, r.text
    t = await _task(client, ctx, "Write the migration")
    assert (t["tracker_ref"], t["tracker_url"], t["tracker_error"]) == (
        "ENG-1", "https://tracker.example.com/ENG-1", None)  # fmt: skip
    async with tenant_session(ctx.tenant_id) as s:
        row = await s.get(RoadmapItemTask, uuid.UUID(t["id"]))
        assert row is not None and row.tracker_record_id is not None
        record_id = str(row.tracker_record_id)
    target = {"item_id": w.ids["x"], "task_id": t["id"]}
    r = await w.post(client, "owner", "set_item_task_status", target=target,
                     before={"status": "todo"}, after={"status": "doing"})  # fmt: skip
    assert r.status_code == 201, r.text
    assert conn.calls[-1] == ("doing", record_id)
    async with tenant_session(ctx.tenant_id) as s:
        states = list(await s.scalars(select(TrackerRecord.state)))
    assert states == ["in_progress"]
    conn.fail = True
    r = await w.post(client, "owner", "set_item_task_status", target=target,
                     before={"status": "doing"}, after={"status": "done"})  # fmt: skip
    assert r.status_code == 201, r.text
    t = await _task(client, ctx, "Write the migration")
    assert t["status"] == "done"
    assert t["tracker_ref"] == "ENG-1"
    assert t["tracker_error"]
    r = await client.post(_retry(t["id"]), headers=ctx.as_("owner"))
    assert r.status_code == 200, r.text
    assert r.json()["tracker_error"] is None
    assert conn.calls[-1] == ("done", record_id)
    t = await _task(client, ctx, "Write the migration")
    assert t["tracker_error"] is None


@pytest.fixture(autouse=True)
def _two_way_restored(monkeypatch):
    """Each test sets the gate through monkeypatch, so it is put back after."""
    monkeypatch.setattr(get_settings(), "tracker_two_way_enabled",
                        get_settings().tracker_two_way_enabled)  # fmt: skip
