"""Simple S3b (#723): the change engine's non-versioned targets. These are not part of a
roadmap's versions, so an applied change writes them directly (no working draft):
priority overrides, item tasks (``roadmap_item_tasks``), action items
(``simple_action_items``) and launch tasks (the launch checklist). oracle.simple.changes
hands these ops here; the change row, sessions, ``before`` checks, undo and audit follow
its rules.

**Who**: a target under a roadmap item (``target.item_id``) follows the item's rule
(oracle.simple.service.can_decide: an owner, the roadmap's decider, else its owner apply;
approvers and commenters propose to the decider, else the roadmap's owner, else the
company's owners). An action item under no item is an owner's: others propose to the
company's owners. A proposal writes nothing, an add creates no row, until accepted.

**Ops** (``before``: the fields as the caller saw them; ``after``: what is written):

- ``override_priority``: a live-ranking pin of the item's feature through
  oracle.priorities.service (Oracle's pushback and reason check included; a pushback is
  409 and nothing is stored, ``after.confirm`` keeps the pin anyway; accepting a proposal
  keeps it, confirm). ``after`` {position, reason: one line}; ``before``/stored ``after``
  ``{"override": {kind, position, above_feature_id, reason} | null}``. It replaces the
  feature's active override; its undo re-creates the previous one (which replaces this
  one) or, with none, removes it.
- ``estimate_feature`` (S6): a person's estimate of the item's feature (``target.feature_id``)
  in the baseline's attrs: ``after`` any of {goal_value, effort}, numbers (goal_value 0 or
  more, effort > 0), rounded to 1 decimal (oracle.priorities.scoring reads ``goal_value``
  in place of the goals' sum);
  ``before`` {goal_value, effort} as the caller saw them (attrs ``goal_value``; ``effort``,
  else ``effort_weeks``, as the ranking reads it; null when absent). Its undo restores the
  attrs as they were (a key that was absent is removed).
- ``add_item_task`` / ``edit_item_task`` / ``set_item_task_status``: title, owner_id,
  due_date, status (todo, doing, done, dropped). The new task's id is chosen when the
  change is made (``target.task_id``); its undo deletes the task.
- ``add_action_item`` / ``edit_action_item`` / ``set_action_item_status``: the same on
  an action item (``target.action_item_id``; owner_id required; status open, done,
  dropped). Its undo deletes it.
- ``add_feature_ask`` (S9): a feature ask filed in Oracle's Requests (``product_requests``,
  state new, ``target.request_id``): ``after`` {title, requester_name, requester_kind,
  channel}. Anyone who may file a request (commenter and up) files it directly, as in
  Requests; its undo deletes it while it is still new and unchanged.
- ``add_launch_task`` / ``set_launch_task_status``: a task on the item's live launch
  (a launch of its track whose items include it; ``target.launch_id``, ``task_id`` once
  added) through oracle.launches.service. The launches service deletes no task: the undo
  of an add skips it ("Undone in Simple").

History is never deleted: the change rows stay in ``simple_changes``.
"""

import uuid
from typing import Any

from pydantic import ValidationError
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from oracle import audit, company_time
from oracle.auth.models import User
from oracle.authz import has_role
from oracle.baseline.models import Entity
from oracle.launches import service as launches
from oracle.launches.models import TASK_AUDIENCES, Launch, LaunchTask
from oracle.launches.models import TASK_STATUSES as LAUNCH_TASK_STATUSES
from oracle.priorities import service as priorities
from oracle.priorities.models import PriorityOverride
from oracle.priorities.schemas import OverrideCreate
from oracle.priorities.scoring import _number
from oracle.requests.models import CHANNELS as REQUEST_CHANNELS
from oracle.requests.models import REQUESTER_KINDS, ProductRequest
from oracle.roadmap.models import RoadmapItem
from oracle.simple import changes, service
from oracle.simple.changes import ChangeError
from oracle.simple.models import (
    ACTION_STATUSES,
    TASK_STATUSES,
    RoadmapItemTask,
    SimpleActionItem,
    SimpleChange,
    SimpleSession,
)
from oracle.simple.schemas import SimpleChangeIn, SimpleChangeResult

KIND = {
    "override_priority": "override",
    "estimate_feature": "estimate",
    "add_item_task": "task",
    "edit_item_task": "task",
    "set_item_task_status": "task",
    "add_action_item": "action",
    "edit_action_item": "action",
    "set_action_item_status": "action",
    "add_launch_task": "launch",
    "set_launch_task_status": "launch",
    "add_feature_ask": "ask",
}
OPS: frozenset[str] = frozenset(KIND)
ID_KEY = {
    "task": "task_id",
    "action": "action_item_id",
    "launch": "task_id",
    "estimate": "feature_id",
    "ask": "request_id",
}
ESTIMATES = ("goal_value", "effort")
MODEL: dict[str, Any] = {
    "task": RoadmapItemTask,
    "action": SimpleActionItem,
    "launch": LaunchTask,
    "ask": ProductRequest,
}
STATUSES = {"task": TASK_STATUSES, "action": ACTION_STATUSES, "launch": LAUNCH_TASK_STATUSES}
EDITABLE = ("title", "owner_id", "due_date")
TITLE_MAX = {"task": 200, "action": 200, "launch": 300, "ask": 200}
NAME_MAX = 200
REASON_MAX = 500
SKIP_MAX = 2000
UNDONE = "Undone in Simple"


# --------------------------------------------------------------------------- values


def _title(value: Any, kind: str) -> str:
    title = " ".join(str(value or "").split())
    if not title or len(title) > TITLE_MAX[kind]:
        raise ChangeError(422, f"after.title: 1 to {TITLE_MAX[kind]} characters")
    return title


def _id_str(value: Any, name: str) -> str | None:
    if value in (None, ""):
        return None
    try:
        return str(uuid.UUID(str(value)))
    except ValueError as e:
        raise ChangeError(422, f"{name}: an id") from e


async def _owner(db: AsyncSession, value: Any, required: bool) -> str | None:
    owner = _id_str(value, "after.owner_id")
    if owner is None:
        if required:
            raise ChangeError(422, "after.owner_id: who owns it")
        return None
    if not await db.scalar(
        select(User.id).where(User.id == uuid.UUID(owner), User.disabled_at.is_(None))
    ):
        raise ChangeError(422, "after.owner_id: a member of this company")
    return owner


def _normal(values: dict[str, Any], keys: tuple[str, ...] | list[str]) -> dict[str, Any]:
    """The caller's values of ``keys`` as stored values read (ids and days as text)."""
    out: dict[str, Any] = {}
    for k in keys:
        v = values.get(k)
        if k == "owner_id":
            out[k] = _id_str(v, f"before.{k}")
        elif k == "due_date":
            out[k] = changes._iso(changes._day(v, f"before.{k}"))
        else:
            out[k] = v
    return out


def _values(row: Any, keys: tuple[str, ...] | list[str]) -> dict[str, Any]:
    out: dict[str, Any] = {}
    for k in keys:
        v = getattr(row, k)
        out[k] = str(v) if k == "owner_id" and v is not None else v
        if k == "due_date":
            out[k] = changes._iso(v)
    return out


def _snap(o: PriorityOverride | None) -> dict[str, Any] | None:
    if o is None:
        return None
    above = str(o.above_feature_id) if o.above_feature_id else None
    return {"kind": o.kind, "position": o.position, "above_feature_id": above, "reason": o.reason}


def _keys(c: SimpleChange) -> tuple[str, ...]:
    """The fields a change's ``before``/``after`` are compared on."""
    if KIND[c.op] == "override":
        return ("override",)
    if c.op.startswith("set_"):
        return ("status",)
    return tuple(c.after)


def estimates(attrs: dict[str, Any] | None) -> dict[str, float | None]:
    """A feature's goal value estimate and effort as the ranking reads them (S6)."""
    attrs = attrs or {}
    goal = _number(attrs.get("goal_value"))
    effort = _number(attrs["effort"]) if "effort" in attrs else _number(attrs.get("effort_weeks"))
    return {"goal_value": goal if goal is not None and goal >= 0 else None, "effort": effort}


async def _feature(db: AsyncSession, feature_id: Any) -> Entity | None:
    return await db.get(
        Entity, uuid.UUID(str(feature_id)), with_for_update=True, populate_existing=True
    )


async def _active(db: AsyncSession, feature_id: uuid.UUID) -> PriorityOverride | None:
    return await db.scalar(
        select(PriorityOverride).where(
            PriorityOverride.feature_id == feature_id,
            PriorityOverride.snapshot_id.is_(None),
            PriorityOverride.removed_at.is_(None),
        )
    )


async def _row(db: AsyncSession, kind: str, target: dict[str, Any]) -> Any:
    rid = target.get(ID_KEY[kind])
    if rid is None:
        return None
    return await db.get(MODEL[kind], uuid.UUID(rid), with_for_update=True, populate_existing=True)


async def _current(db: AsyncSession, c: SimpleChange) -> dict[str, Any] | None:
    """The stored values of the change's fields; None when its target is gone."""
    if KIND[c.op] == "override":
        return {"override": _snap(await _active(db, uuid.UUID(c.target["feature_id"])))}
    if KIND[c.op] == "estimate":
        f = await _feature(db, c.target["feature_id"])
        if f is None:
            return None
        now_ = estimates(f.attrs)
        return {k: now_[k] for k in _keys(c)}
    row = await _row(db, KIND[c.op], c.target)
    return _values(row, _keys(c)) if row is not None else None


async def _live_launch(db: AsyncSession, entry: service.Entry) -> Launch | None:
    track_id = entry.track.id if entry.track is not None else entry.row.track_id
    if track_id is None:
        return None
    return await db.scalar(
        select(Launch)
        .where(
            Launch.track_id == track_id,
            Launch.item_keys.contains([entry.row.item_key]),
            Launch.state != "cancelled",
        )
        .order_by((Launch.state == "launched").asc(), Launch.created_at.desc())
        .limit(1)
    )


# --------------------------------------------------------------------------- who


async def _last_writer(db: AsyncSession, c: SimpleChange) -> tuple[Any, Any]:
    """(SimplePersonRef dict, when) of the last write to the change's target: the active
    override's author for a priority, else the last change through Simple."""
    kind = KIND[c.op]
    who: tuple[Any, uuid.UUID] | None = None
    if kind == "override":
        o = await _active(db, uuid.UUID(c.target["feature_id"]))
        if o is not None:
            who = (o.created_at, o.created_by)
    else:
        rows = await db.scalars(
            select(SimpleChange)
            .where(
                SimpleChange.status.in_(changes.WRITTEN),
                SimpleChange.op.in_([op for op, k in KIND.items() if k == kind]),
                SimpleChange.target.contains({ID_KEY[kind]: c.target.get(ID_KEY[kind])}),
            )
            .limit(500)
        )
        for r in rows:
            at = r.decided_at if r.status == "accepted" and r.decided_at else r.at
            by = r.decided_by if r.status == "accepted" and r.decided_by else r.by
            if who is None or at > who[0]:
                who = (at, by)
    if who is None:
        return None, None
    names = await changes._names(db, {who[1]})
    return {"id": str(who[1]), "name": names.get(who[1], "someone")}, who[0]


async def _conflict(db: AsyncSession, c: SimpleChange, current: Any, lead: str) -> ChangeError:
    who, at = await _last_writer(db, c)
    name = who["name"] if who else "someone outside Simple"
    return ChangeError(409, {"message": f"{lead}: changed by {name}", "current": current,
                             "changed_by": who,
                             "changed_at": at.isoformat() if at else None})  # fmt: skip


def may_decide(principal: Any, c: SimpleChange, view: Any) -> bool:
    item_id = c.target.get("item_id")
    if item_id:
        try:
            e = view.by_id.get(uuid.UUID(str(item_id)))
        except ValueError:
            return False
        return e is not None and service.can_decide(principal, e, view.deciders)
    return principal is not None and has_role(principal.role, "owner")


# --------------------------------------------------------------------------- planning


async def _plan(
    db: AsyncSession, op: str, body: SimpleChangeIn, entry: service.Entry | None
) -> tuple[dict[str, Any], dict[str, Any], dict[str, Any]]:
    """(target, before as stored now, after) for a new change; 409 on a stale ``before``,
    422 on a malformed change."""
    kind, a, given = KIND[op], body.after, body.before
    target: dict[str, Any] = {"item_id": str(entry.row.id)} if entry is not None else {}
    if kind == "action" and body.target.get("meeting_id"):
        target["meeting_id"] = _id_str(body.target["meeting_id"], "target.meeting_id")
    if kind == "ask":
        name = " ".join(str(a.get("requester_name") or "").split()) or None
        if name is not None and len(name) > NAME_MAX:
            raise ChangeError(422, f"after.requester_name: at most {NAME_MAX} characters")
        rkind = a.get("requester_kind") or ("customer" if name else "unknown")
        channel = a.get("channel") or "other"
        if rkind not in REQUESTER_KINDS:
            raise ChangeError(422, f"after.requester_kind: one of {', '.join(REQUESTER_KINDS)}")
        if channel not in REQUEST_CHANNELS or channel in ("interview", "in_app"):
            raise ChangeError(422, "after.channel: where the ask came from")
        target[ID_KEY[kind]] = str(uuid.uuid4())
        after = {"title": _title(a.get("title"), kind), "requester_name": name,
                 "requester_kind": rkind, "channel": channel}  # fmt: skip
        return target, {}, after
    if entry is None and kind != "action":
        raise ChangeError(422, "target.item_id: the roadmap item")

    if kind == "override":
        row = entry.row  # type: ignore[union-attr]
        if row.feature_id is None:
            raise ChangeError(422, "This item has no feature in the baseline to rank")
        target["feature_id"] = str(row.feature_id)
        clear = a.get("clear") is True
        pos = a.get("position")
        if not clear and (not isinstance(pos, int) or isinstance(pos, bool) or pos < 1):
            raise ChangeError(422, "after.position: a rank from 1 (the top)")
        reason = str(a.get("reason") or "").strip()
        if not clear and (
            not reason or "\n" in reason or "\r" in reason or len(reason) > REASON_MAX
        ):
            raise ChangeError(
                422, f"after.reason: why, in one line of 1 to {REASON_MAX} characters"
            )
        if "override" not in given:
            raise ChangeError(
                422, "before.override: the feature's override as you saw it (or null)"
            )
        await db.execute(
            select(PriorityOverride.id)
            .where(PriorityOverride.feature_id == row.feature_id)
            .with_for_update()
        )
        current = {"override": _snap(await _active(db, row.feature_id))}
        seen = given["override"]
        if isinstance(seen, dict):
            seen = {**seen, "above_feature_id": _id_str(seen.get("above_feature_id"), "before")}
        if seen != current["override"]:
            raise await _conflict(db, SimpleChange(op=op, target=target), current,
                                  "Changed since you saw it")  # fmt: skip
        if clear:
            # ``after.clear``: back to Oracle's rank (the active override ends; undo puts it back).
            active = await _active(db, row.feature_id)
            if active is None:
                raise ChangeError(409, "It is at Oracle's rank already")
            target["override_id"] = str(active.id)
            return target, current, {"override": None}
        after = {"override": {"kind": "pin", "position": pos, "above_feature_id": None,
                              "reason": reason}}  # fmt: skip
        return target, current, after

    if kind == "estimate":
        row = entry.row  # type: ignore[union-attr]
        if row.feature_id is None:
            raise ChangeError(422, "This item has no feature in the baseline to estimate")
        target["feature_id"] = str(row.feature_id)
        after = {}
        for k in ESTIMATES:
            if k not in a:
                continue
            v = a[k]
            # qa-simple-plan-6: a goal value may go down to 0 (worth nothing to the goals);
            # an effort stays above 0 (the score divides by it).
            zero = k == "goal_value"
            words = "0 or more" if zero else "above 0"
            if isinstance(v, bool) or not isinstance(v, int | float):
                raise ChangeError(422, f"after.{k}: a number {words}")
            after[k] = round(float(v), 1)
            if after[k] < 0 or (after[k] == 0 and not zero):
                raise ChangeError(422, f"after.{k}: a number {words}")
        if not after:
            raise ChangeError(422, "after: any of goal_value, effort")
        missing = [k for k in ESTIMATES if k not in given]
        if missing:
            raise ChangeError(422, f"before: {', '.join(missing)} as you saw them")
        f = await _feature(db, row.feature_id)
        if f is None:
            raise ChangeError(422, "This item has no feature in the baseline to estimate")
        current = estimates(f.attrs)
        seen = {k: given[k] for k in ESTIMATES}
        if any(not (v is None or (isinstance(v, int | float) and not isinstance(v, bool)))
               for v in seen.values()):  # fmt: skip
            raise ChangeError(422, "before: goal_value and effort as numbers or null")
        if seen != current:
            raise await _conflict(db, SimpleChange(op=op, target=target, after=after), current,
                                  "Changed since you saw it")  # fmt: skip
        return target, current, after

    if op.startswith("add_"):
        after = {"title": _title(a.get("title"), kind),
                 "owner_id": await _owner(db, a.get("owner_id"), kind == "action")}  # fmt: skip
        if kind == "launch":
            launch = await _live_launch(db, entry)  # type: ignore[arg-type]
            if launch is None:
                raise ChangeError(422, "No live launch covers this item")
            target["launch_id"] = str(launch.id)
            audience = a.get("audience") or "internal"
            if audience not in TASK_AUDIENCES:
                raise ChangeError(422, "after.audience: internal or external")
            after |= {"audience": audience, "status": "todo"}
        else:
            target[ID_KEY[kind]] = str(uuid.uuid4())
            after["due_date"] = changes._iso(changes._day(a.get("due_date"), "after.due_date"))
            status = a.get("status") or STATUSES[kind][0]
            if status not in STATUSES[kind]:
                raise ChangeError(422, f"after.status: one of {', '.join(STATUSES[kind])}")
            after["status"] = status
        return target, {}, after

    target[ID_KEY[kind]] = _id_str(body.target.get(ID_KEY[kind]), f"target.{ID_KEY[kind]}")
    row = await _row(db, kind, target)
    if row is not None and kind == "launch":
        launch = await db.get(Launch, row.launch_id)
        if entry is None or launch is None or entry.row.item_key not in (launch.item_keys or []):
            row = None
        else:
            target["launch_id"] = str(launch.id)
    elif row is not None and (str(row.item_id) if row.item_id else None) != target.get("item_id"):
        row = None
    if row is None:
        raise ChangeError(404, "No such task or action item here")
    if op.startswith("set_"):
        status = a.get("status")
        if status not in STATUSES[kind]:
            raise ChangeError(422, f"after.status: one of {', '.join(STATUSES[kind])}")
        after = {"status": status}
        if kind == "launch" and status == "skipped":
            skip = str(a.get("skip_reason") or "").strip()
            if not skip or len(skip) > SKIP_MAX:
                raise ChangeError(422, "after.skip_reason: why it is skipped")
            after["skip_reason"] = skip
        keys: tuple[str, ...] = ("status",)
    else:
        keys = tuple(k for k in EDITABLE if k in a)
        if not keys:
            raise ChangeError(422, f"after: any of {', '.join(EDITABLE)}")
        after = {}
        for k in keys:
            if k == "title":
                after[k] = _title(a[k], kind)
            elif k == "owner_id":
                after[k] = await _owner(db, a[k], kind == "action")
            else:
                after[k] = changes._iso(changes._day(a[k], "after.due_date"))
    missing = [k for k in keys if k not in given]
    if missing:
        raise ChangeError(422, f"before: {', '.join(missing)} as you saw them")
    probe = SimpleChange(op=op, target=target, after=after)
    current = _values(row, keys)
    if _normal(given, keys) != current:
        raise await _conflict(db, probe, current, "Changed since you saw it")
    before = current | ({"skip_reason": row.skip_reason} if kind == "launch" else {})
    return target, before, after


# --------------------------------------------------------------------------- writing


def _fail(e: Exception) -> ChangeError:
    if isinstance(e, launches.LaunchError):
        return ChangeError(e.status, str(e))
    if isinstance(e, priorities.Pushback):
        return ChangeError(409, {"message": e.body["detail"], "pushback": e.body["pushback"],
                                 "reason_check": e.body.get("reason_check"),
                                 "preview_rank": e.body.get("preview_rank"),
                                 "held_below": e.body.get("held_below"),
                                 "hint": "after.confirm: true keeps the pin"})  # fmt: skip
    status = {priorities.InvalidError: 422, priorities.ConflictError: 409,
              priorities.ForbiddenError: 403, priorities.NotFoundError: 404}  # fmt: skip
    return ChangeError(next((s for t, s in status.items() if isinstance(e, t)), 422), str(e))


async def _pin(db: AsyncSession, principal: Any, feature_id: str, o: dict, confirm: bool) -> str:
    """Store the override ``o`` (it replaces the feature's active one); commits."""
    try:
        data = OverrideCreate(feature_id=uuid.UUID(feature_id), kind=o["kind"],
                              above_feature_id=o["above_feature_id"], position=o["position"],
                              reason=o["reason"], confirm=confirm)  # fmt: skip
        return str((await priorities.create_override(db, data, principal)).id)
    except ValidationError as e:
        raise ChangeError(422, "The override is not one the ranking takes") from e
    except (priorities.Pushback, priorities.InvalidError, priorities.ConflictError,
            priorities.ForbiddenError) as e:  # fmt: skip
        raise _fail(e) from e


async def _unpin(db: AsyncSession, principal: Any, override_id: str) -> None:
    """End the override ``override_id``: its feature goes back to Oracle's rank."""
    try:
        await priorities.remove_override(db, uuid.UUID(override_id), "Back to Oracle's rank",
                                         principal)  # fmt: skip
    except (priorities.ConflictError, priorities.NotFoundError) as e:
        raise _fail(e) from e


def _set(row: Any, values: dict[str, Any]) -> None:
    for k, v in values.items():
        if k == "owner_id":
            v = uuid.UUID(v) if v else None
        elif k == "due_date":
            v = changes._day(v, k)
        setattr(row, k, v)


async def _apply(
    db: AsyncSession, principal: Any, c: SimpleChange, values: dict[str, Any], undo: bool = False
) -> None:
    """Write ``values`` (the change's after, or its before for an undo) to the target. An
    override commits (the priorities service does); everything else only flushes."""
    kind, t = KIND[c.op], c.target
    if kind == "estimate":
        f = await _feature(db, t["feature_id"])
        if f is None:
            raise ChangeError(409, "The feature is gone")
        attrs = dict(f.attrs or {})
        if undo:
            # The attrs as they were (a key that was absent is removed).
            raw = t.get("raw") or {k: values.get(k) for k in c.after}
            for k, v in raw.items():
                if v is None:
                    attrs.pop(k, None)
                else:
                    attrs[k] = v
        else:
            c.target = {**t, "raw": {k: attrs.get(k) for k in values}}
            attrs.update(values)
        f.attrs = attrs
        await db.flush()
        return
    if kind == "override":
        if not undo and values["override"] is None:
            await _unpin(db, principal, t["override_id"])
        elif not undo:
            oid = await _pin(db, principal, t["feature_id"], values["override"], True)
            c.target = {**t, "override_id": oid}
        elif values["override"] is not None:
            await _pin(db, principal, t["feature_id"], values["override"], True)
        else:
            try:
                await priorities.remove_override(db, uuid.UUID(t["override_id"]), UNDONE, principal)
            except (priorities.ConflictError, priorities.NotFoundError) as e:
                raise _fail(e) from e
        return
    try:
        if c.op.startswith("add_") and not undo:
            await _create(db, principal, c)
        elif kind == "launch":
            task = await _row(db, kind, t)
            if task is None:
                raise ChangeError(409, "The launch task is gone")
            fields = (
                {"status": "skipped", "skip_reason": UNDONE}
                if c.op == "add_launch_task"
                else {"status": values["status"], "skip_reason": values.get("skip_reason")}
            )
            await launches.update_task(db, principal, task, {"lock_version": task.lock_version,
                                                             **fields})  # fmt: skip
        else:
            row = await _row(db, kind, t)
            if row is None:
                raise ChangeError(409, "The task or action item is gone")
            if c.op.startswith("add_"):
                await db.delete(row)
            else:
                _set(row, values)
    except launches.LaunchError as e:
        raise _fail(e) from e
    await db.flush()


async def _create(db: AsyncSession, principal: Any, c: SimpleChange) -> None:
    kind, t, a = KIND[c.op], c.target, c.after
    if kind == "ask":
        db.add(ProductRequest(id=uuid.UUID(t["request_id"]), title=a["title"],
                              channel=a["channel"], origin="person",
                              requester_name=a["requester_name"],
                              requester_kind=a["requester_kind"], filed_by=c.by))  # fmt: skip
        return
    item = await db.get(RoadmapItem, uuid.UUID(t["item_id"])) if t.get("item_id") else None
    if t.get("item_id") and item is None:
        raise ChangeError(409, "The roadmap item is gone")
    if kind == "launch":
        launch = await db.get(Launch, uuid.UUID(t["launch_id"]), with_for_update=True)
        if launch is None or launch.state == "cancelled":
            raise ChangeError(409, "The launch is gone or cancelled")
        owner = uuid.UUID(a["owner_id"]) if a["owner_id"] else None
        task = await launches.add_task(db, principal, launch, None, a["title"], a["audience"],
                                       owner)  # fmt: skip
        c.target = {**t, "task_id": str(task.id)}
        return
    if kind == "task":
        assert item is not None
        last = await db.scalar(
            select(func.max(RoadmapItemTask.position)).where(
                RoadmapItemTask.roadmap_document_id == item.roadmap_document_id,
                RoadmapItemTask.item_key == item.item_key,
            )
        )
        row: Any = RoadmapItemTask(position=(last or 0) + 1)
    else:
        row = SimpleActionItem(
            meeting_id=uuid.UUID(t["meeting_id"]) if t.get("meeting_id") else None
        )
    row.id = uuid.UUID(t[ID_KEY[kind]])
    row.item_id = item.id if item is not None else None
    row.roadmap_document_id = item.roadmap_document_id if item is not None else None
    row.item_key = item.item_key if item is not None else None
    row.created_by = c.by
    _set(row, a)
    db.add(row)


# --------------------------------------------------------------------------- the routes


async def _who(
    db: AsyncSession, principal: Any, item_id: Any, op: str = ""
) -> tuple[service.Entry | None, bool, list]:
    """(the item's entry, whether the caller applies, who a proposal goes to)."""
    if KIND.get(op) == "ask":
        # Filing a feature ask is every commenter's right in Requests (C1).
        return None, has_role(principal.role, "commenter"), []
    if item_id in (None, ""):
        if has_role(principal.role, "owner"):
            return None, True, []
        return None, False, await changes._company_owners(db)
    iid = changes._uuid(item_id, "item_id")
    await changes._lock(db, [iid])
    read_ = await service.load(db)
    entry = read_.by_id().get(iid)
    if entry is None:
        raise ChangeError(404, "No such roadmap item")
    if service.can_decide(principal, entry, read_.deciders):
        return entry, True, []
    return entry, False, await changes.routed_to(db, entry, read_)


async def _record(db: AsyncSession, principal: Any, c: SimpleChange, **data: Any) -> None:
    await audit.record(db, principal, f"simple_change.{c.status}", "simple_change", c.id,
                       data={"op": c.op, "target": c.target, **data})  # fmt: skip


async def create(db: AsyncSession, principal: Any, body: SimpleChangeIn) -> SimpleChangeResult:
    me, now = changes._me(principal), company_time.now()
    entry, applies, routed = await _who(db, principal, body.target.get("item_id"), body.op)
    session = await changes._session_for_change(db, me, body.session_id, applies, now)
    target, before, after = await _plan(db, body.op, body, entry)
    c = SimpleChange(session_id=session.id if session else None,
                     document_id=entry.roadmap.id if entry is not None else None, op=body.op,
                     target=target, before=before, after=after,
                     status="applied" if applies else "proposed", by=me, at=now,
                     reason=body.reason, routed_to=routed)  # fmt: skip
    if applies:
        if KIND[body.op] == "override" and after["override"] is None:
            await _unpin(db, principal, target["override_id"])
        elif KIND[body.op] == "override":
            # Before the row exists: a pushback commits the reason check and raises.
            oid = await _pin(db, principal, target["feature_id"], after["override"],
                             bool(body.after.get("confirm")))  # fmt: skip
            c.target = {**target, "override_id": oid}
        else:
            await _apply(db, principal, c, after)
        session.last_change_at = now  # type: ignore[union-attr]
    db.add(c)
    await db.flush()
    await _record(db, principal, c, before=before, after=after,
                  document_id=str(c.document_id) if c.document_id else None)  # fmt: skip
    await db.commit()
    return SimpleChangeResult(change=await changes.one_out(db, principal, c), flags=[])


async def decide(
    db: AsyncSession, principal: Any, c: SimpleChange, action: str, reason: str | None
) -> SimpleChangeResult:
    """Accept (apply the proposal, unless outdated) or decline it."""
    me, now = changes._me(principal), company_time.now()
    view = await changes._view(db, principal, [c])
    if not may_decide(principal, c, view):
        raise ChangeError(403, "Only an owner or the roadmap's decider (with no decider, its "
                               "owner) decides proposals")  # fmt: skip
    if c.status != "proposed":
        raise ChangeError(409, f"This change is {c.status} already")
    if action == "accept" and not c.op.startswith("add_"):
        current = await _current(db, c)
        if current is None:
            raise ChangeError(409, "outdated: its task or action item is gone")
        if current != {k: c.before.get(k) for k in _keys(c)}:
            raise await _conflict(db, c, current, "outdated")
    c.status = "accepted" if action == "accept" else "declined"
    c.decided_by, c.decided_at, c.decision_reason = me, now, reason
    await db.flush()
    await _record(db, principal, c, reason=reason)
    if action == "accept":
        # An override commits with the decision; the target id it gets is stored after.
        await _apply(db, principal, c, c.after)
    await db.commit()
    return SimpleChangeResult(change=await changes.one_out(db, principal, c), flags=[])


async def undo(db: AsyncSession, principal: Any, c: SimpleChange) -> SimpleChangeResult:
    me, now = changes._me(principal), company_time.now()
    if c.status != "applied":
        raise ChangeError(409, f"Only an applied change undoes; this one is {c.status}")
    if c.by != me:
        raise ChangeError(403, "Only the person who made a change undoes it")
    if await db.scalar(select(SimpleChange.id).where(SimpleChange.undoes_id == c.id)):
        raise ChangeError(409, "This change is undone already")
    session = (
        await db.get(SimpleSession, c.session_id, with_for_update=True) if c.session_id else None
    )
    if session is None or session.closed_at is not None or changes._idle(session, now):
        raise ChangeError(409, "Its session is closed: undo works only in the change's session")
    current = await _current(db, c)
    if current is None:
        raise ChangeError(409, "Its task or action item is gone")
    if KIND[c.op] == "override":
        active = await _active(db, uuid.UUID(c.target["feature_id"]))
        # A clear's undo needs the feature still at Oracle's rank; a pin's, its own pin active.
        cleared = c.after.get("override", ...) is None
        mine = (
            active is None
            if cleared
            else (active is not None and str(active.id) == c.target.get("override_id"))
        )
    else:
        mine = True
    if not mine or current != {k: c.after.get(k) for k in _keys(c)}:
        raise await _conflict(db, c, current, "Changed since")
    u = SimpleChange(session_id=c.session_id, document_id=c.document_id, op=c.op, target=c.target,
                     before=c.after, after=c.before, status="undone", by=me, at=now,
                     undoes_id=c.id, routed_to=[])  # fmt: skip
    db.add(u)
    session.last_change_at = now
    await db.flush()
    await _record(db, principal, u, undoes_id=str(c.id))
    await _apply(db, principal, c, c.before, undo=True)
    await db.commit()
    return SimpleChangeResult(change=await changes.one_out(db, principal, u), flags=[])
