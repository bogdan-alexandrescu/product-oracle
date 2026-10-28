"""A Simple change in plain words, as Home's "Since your last visit" says it (the walk, H2):
who, what, the item's code and name, and "· undone" once undone. Never the op's internal
name: every op of the change engine (oracle.simple.schemas.ChangeOp) has its sentence
here, and an op without one reads "changed <the item>".

"Ana changed the estimate of F-08 Billing page · undone".
"""

from typing import Any

HORIZON_WORDS = {"now": "Now", "next": "Next", "later": "Later"}


def _quoted(value: Any, limit: int = 80) -> str | None:
    text = " ".join(str(value or "").split())
    if not text:
        return None
    return f"“{text[:limit]}{'…' if len(text) > limit else ''}”"


def _status(after: dict) -> str | None:
    s = after.get("status")
    return str(s).replace("_", " ") if s else None


def _key_date(c_before: dict, c_after: dict) -> str:
    kd = c_after.get("key_date") or c_before.get("key_date") or {}
    name = _quoted(kd.get("name") if isinstance(kd, dict) else None)
    return f"the key date {name}" if name else "a key date"


def phrase(op: str, target: dict, before: dict, after: dict, item: str | None) -> str:
    """What was done, without who: "changed the estimate of F-08 Billing page"."""
    x = item or _quoted(after.get("title") or target.get("title")) or "an item"
    on = f" on {item}" if item else ""
    title = _quoted(after.get("title"))
    status = _status(after)
    match op:
        case "move_dates":
            return f"moved the dates of {x}"
        case "accept_date_suggestion":
            return f"accepted Oracle's dates for {x}"
        case "change_horizon":
            h = HORIZON_WORDS.get(str(after.get("horizon")))
            return f"moved {x} to {h}" if h else f"moved {x} to another horizon"
        case "reorder":
            return f"reordered {x}"
        case "cut":
            return f"cut {x}"
        case "restore":
            return f"restored {x}"
        case "edit_title":
            return f"renamed {x} to {title}" if title else f"renamed {x}"
        case "edit_outcome":
            return f"changed the outcome of {x}"
        case "accept_risk":
            return f"accepted a risk on {x}"
        case "shift_dependents":
            return f"moved {x} and its dependents after what it depends on"
        case "move_dependency":
            return f"moved what {x} depends on"
        case "override_priority":
            return f"changed the priority of {x}"
        case "add_item_task":
            return f"added the task {title} to {x}" if title else f"added a task to {x}"
        case "edit_item_task":
            return f"changed a task on {x}"
        case "set_item_task_status":
            return f"marked a task on {x} {status}" if status else f"changed a task on {x}"
        case "add_action_item":
            return f"added the action item {title}{on}" if title else f"added an action item{on}"
        case "edit_action_item":
            return f"changed an action item{on}"
        case "set_action_item_status":
            return (
                f"marked an action item{on} {status}" if status else f"changed an action item{on}"
            )
        case "add_launch_task":
            return (
                f"added the launch task {title} to {x}" if title else f"added a launch task to {x}"
            )
        case "set_launch_task_status":
            return (
                f"marked a launch task of {x} {status}"
                if status
                else f"changed a launch task of {x}"
            )
        case "estimate_feature":
            return f"changed the estimate of {x}"
        case "confirm_item":
            return f"confirmed {x}"
        case "edit_line":
            line = _quoted(after.get("line"))
            return f"edited a one-pager line to {line}" if line else "edited a one-pager line"
        case "add_key_date":
            return f"added {_key_date(before, after)}"
        case "edit_key_date":
            return f"changed {_key_date(before, after)}"
        case "remove_key_date":
            return f"removed {_key_date(before, after)}"
        case "add_item":
            return f"added {x}"
        case "merge_item":
            into = " ".join(str(target.get(k) or "") for k in ("code", "title")).strip()
            return f"merged {x} into {into}" if into else f"merged {x}"
        case "keep_both":
            return f"kept {x} beside its look-alikes"
        case "set_milestone":
            m = after.get("milestone")
            name = _quoted(m.get("name")) if isinstance(m, dict) else None
            if m is None and "milestone" in after:
                return f"cleared the milestone of {x}"
            return f"set the milestone of {x} to {name}" if name else f"set the milestone of {x}"
        case "add_feature_ask":
            return f"filed the feature ask {title}" if title else "filed a feature ask"
        case "set_owner":
            return f"changed the owner of {x}"
        case "set_decider":
            return f"changed the decider of {x}"
        # prd-questions: a PRD question (a decision) answered, or its decider named.
        case "decide_question":
            return f"decided {x}"
        case "name_decider":
            return f"named who decides {x}"
    return f"changed {x}"


def sentence(
    op: str,
    target: dict | None,
    before: dict | None,
    after: dict | None,
    *,
    who: str,
    item: str | None,
    status: str,
    undone: bool,
) -> str:
    """The whole sentence: "Ana changed the estimate of F-08 Billing page · undone". An undo
    row (``status`` undone) says what it undid; a proposal and a declined one say so."""
    target, before, after = target or {}, before or {}, after or {}
    if status == "undone":
        # The undo row swaps before and after: its words name the change it undid.
        return f"{who} undid: {phrase(op, target, after, before, item)}"
    words = f"{who} {phrase(op, target, before, after, item)}"
    if status == "proposed":
        words = f"{who} proposed: {phrase(op, target, before, after, item)}"
    elif status == "declined":
        words = f"{who} proposed: {phrase(op, target, before, after, item)} · declined"
    if undone:
        words += " · undone"
    return words
