"""A dropped task goes to Settings > Trash (owner's pick, Nov 10: "A dropped task leaves the
list and goes to Settings > Trash, where it is restored from").

- test_dropped_task_goes_to_trash_and_restores: protects=a task dropped through the Simple
  change engine leaves the item's tasks and is listed in GET /v1/trash (root type "task",
  its title, who dropped it); Restore puts it back with the status it had and the entry
  leaves Trash; fails_when=a dropped task is nowhere to be found or cannot come back;
  no_claim=the web.
- test_undoing_the_drop_takes_it_out_of_trash: protects=the drop's Undo brings the task
  back and its Trash entry goes; fails_when=an undone drop is still listed in Trash.
"""

import pytest

from oracle.simple.models import RoadmapItemTask
from oracle.tenancy import tenant_session
from tests.test_simple_changes_api import CHANGES, clock, make_people  # noqa: F401
from tests.test_simple_targets_api import World


@pytest.fixture(autouse=True)
def no_llm(monkeypatch):
    from oracle.priorities import reason_check

    async def refuse(*a, **kw):
        raise RuntimeError("no model in tests")

    monkeypatch.setattr(reason_check.gateway, "complete", refuse)


async def _drop(client, w: World, before: str = "doing"):
    task = {"item_id": w.ids["x"], "task_id": w.ids["task"]}
    r = await w.post(client, "owner", "set_item_task_status", target=task,
                     before={"status": "todo"}, after={"status": before})  # fmt: skip
    assert r.status_code == 201, r.text
    r = await w.post(client, "owner", "set_item_task_status", target=task,
                     before={"status": before}, after={"status": "dropped"})  # fmt: skip
    assert r.status_code == 201, r.text
    return r.json()["change"]


async def _task_titles(client, w: World) -> set[str]:
    r = await client.get("/v1/simple/roadmap", headers=w.ctx.as_("owner"))
    assert r.status_code == 200, r.text
    x = next(i for i in r.json()["items"] if i["key"] == "x")
    return {t["title"] for t in x["tasks"]}


async def _task_entries(client, w: World) -> list[dict]:
    r = await client.get("/v1/trash", headers=w.ctx.as_("owner"))
    assert r.status_code == 200, r.text
    return [e for e in r.json() if e["root"]["type"] == "task"]


async def _status(w: World) -> str:
    async with tenant_session(w.ctx.tenant_id) as s:
        return (await s.get(RoadmapItemTask, w.ids["task"])).status


async def test_dropped_task_goes_to_trash_and_restores(client):
    ctx = await make_people()
    w = await World(ctx).build()
    assert "Spec" in await _task_titles(client, w)
    await _drop(client, w, "doing")
    assert "Spec" not in await _task_titles(client, w)
    [entry] = await _task_entries(client, w)
    assert entry["root"]["id"] == w.ids["task"]
    assert (entry["root"]["title"], entry["root"]["kind"]) == ("Spec", "Task")
    assert entry["deleted_by_name"]
    assert entry["can_restore"] is True
    r = await client.post(f"/v1/trash/{entry['id']}/restore", headers=ctx.as_("owner"))
    assert r.status_code == 200, r.text
    assert await _status(w) == "doing"
    assert "Spec" in await _task_titles(client, w)
    assert await _task_entries(client, w) == []


async def test_undoing_the_drop_takes_it_out_of_trash(client):
    ctx = await make_people()
    w = await World(ctx).build()
    change = await _drop(client, w, "done")
    assert len(await _task_entries(client, w)) == 1
    r = await client.post(f"{CHANGES}/{change['id']}/undo", headers=ctx.as_("owner"))
    assert r.status_code == 201, r.text
    assert await _status(w) == "done"
    assert await _task_entries(client, w) == []
