"""A Simple change in plain words, as Home's "Since your last visit" says it (the walk, H2):
who, what, the item's code and name, and "· undone" once undone. Never the op's internal
name: every op of the change engine (oracle.simple.schemas.ChangeOp) has its sentence
here, and an op without one reads "changed <the item>".

"Ana changed the estimate of F-08 Billing page · undone".
"""

import re
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
    from oracle.simple import plan_changes

    if op in plan_changes.OPS:
        return plan_changes.phrase(op, target, before, after, item)
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
        case "cut_with_dependents":
            rest = [str(t) for t in (target.get("titles") or [])[1:]]
            if not rest:
                return f"cut {x} and its dependents"
            names = rest[0] if len(rest) == 1 else f"{', '.join(rest[:-1])} and {rest[-1]}"
            return f"cut {x} and its dependents {names}"
        case "edit_title":
            return f"renamed {x} to {title}" if title else f"renamed {x}"
        case "edit_note":
            return f"changed the notes of {x}"
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
        case "set_section_number":
            return _number_sentence(target, before, after)
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
        case "set_goals":
            return f"moved {x} to another goal"
        case "add_feature_ask":
            return f"filed the feature ask {title}" if title else "filed a feature ask"
        case "set_owner":
            return f"changed the owner of {x}"
        case "set_decider":
            return f"changed the decider of {x}"
        case "set_confidence":
            return f"changed the confidence of {x}"
        case "set_track":
            return f"changed the track of {x}"
        case "set_prd":
            return f"changed the PRD of {x}"
        case "set_goal":
            return f"changed the goal of {x}"
        case "set_depends":
            # ask-oracle-actions: a dependency added or removed in the feature talk names it.
            dep = target.get("dependency")
            gone = len(after.get("depends_on") or []) < len(before.get("depends_on") or [])
            if not dep:
                return f"changed what {x} depends on"
            return f"{x} no longer depends on {dep}" if gone else f"{x} now depends on {dep}"
        case "set_code":
            code = target.get("code")
            return f"gave {x} the code {code}" if code else f"took the code off {x}"
        case "set_feature":
            return f"linked {x} to a feature" if after.get("feature_id") else f"unlinked {x}"
        # feature-parts: target names the parent (the new one, else the one left).
        case "set_parent":
            parent = " ".join(str(target.get(k) or "") for k in ("code", "title")).strip()
            if after.get("parent_key"):
                return f"made {x} part of {parent or 'another feature'}"
            return f"took {x} out of {parent or 'the feature it was part of'}"
        case "set_goal_measure":
            return f"changed how the goal of {x} is measured"
        case "set_status":
            word = "cut" if after.get("cut") else "done" if after.get("shipped") else "planned"
            return f"marked {x} {word}"
        # prd-questions: a PRD question (a decision) answered, or its decider named.
        case "decide_question":
            return f"decided {x}"
        case "name_decider":
            return f"named who decides {x}"
        # edit-decisions (oracle.simple.decision_sheet): the sheet's changes.
        case "edit_decision" | "edit_question":
            kind = "decision" if op == "edit_decision" else "question"
            name = _quoted(target.get("name"))
            return f"changed {name}" if name else f"changed a {kind} on {x}"
        case "withdraw_decision":
            return f"withdrew {_quoted(target.get('name')) or x}"
        case "add_question":
            asked = _quoted(after.get("title")) or "a question"
            prd = target.get("name")
            return f"asked {asked} in {prd}" if prd else f"asked {asked}{on}"
        # Goal milestones: a PRD's own milestone's date or counts-when rule, asked of its owner.
        case "edit_goal_milestone":
            name = _quoted(target.get("name")) or item
            if "milestone" in before and after.get("milestone") is None:
                return f"removed the milestone {name}" if name else "removed a milestone"
            # milestone-rename: a new name (a roadmap's own: in ``milestone``; a PRD's: as is).
            was, to = (before.get("milestone") or before), (after.get("milestone") or after)
            new = _quoted(to.get("name")) if isinstance(to, dict) else None
            old = was.get("name") if isinstance(was, dict) else None
            if new and old and old != to.get("name"):
                return f"renamed the milestone {_quoted(old)} to {new}"
            return f"changed the milestone {name}" if name else "changed a milestone"
        # trash-features-goals: a feature deleted to Trash (oracle.simple.trash_items).
        case "delete_item":
            return f"moved {x} to Trash"
        # edit-goals-prds: a goal archived, moved to Trash or restored (oracle.simple.goal_asks).
        # The goal by its title, or else by the name the reader knows it by.
        case "archive_goal" | "delete_goal" | "unarchive_goal":
            verb = {"archive_goal": "archived", "delete_goal": "moved"}.get(op, "restored")
            goal = _quoted(target.get("title")) or item
            tail = " to Trash" if op == "delete_goal" else ""
            return f"{verb} the goal {goal}{tail}" if goal else f"{verb} a goal{tail}"
        # roadmap-decide: a cut item's fix, the dependency dropped.
        case "remove_dependency":
            titles = target.get("titles") or []
            dep = _quoted(titles[1]) if len(titles) > 1 else None
            return f"removed {x}'s dependency on {dep}" if dep else f"removed a dependency of {x}"
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
    what = phrase(op, target, before, after, item)
    words = f"{who} {what}"
    # What was asked, not done: "proposed: move F-26 Alert rules engine to Trash".
    asked = what
    if op in ("delete_item", "delete_goal"):
        asked = "move" + what[len("moved") :]
    elif op == "archive_goal":
        asked = "archive" + what[len("archived") :]
    elif op == "unarchive_goal":
        asked = "restore" + what[len("restored") :]
    if status == "proposed":
        words = f"{who} proposed: {asked}"
    elif status == "declined":
        words = f"{who} proposed: {asked} · declined"
    if undone:
        words += " · undone"
    return words


# A heading's own count (" · 8 items", " (8 items)") is not part of the section's name.
_HEAD_COUNT = re.compile(r"\s*(?:·\s*\d+\s+items?|\(\s*\d+\s+items?\s*\))\s*$", re.I)


def _number_sentence(target: dict, before: dict, after: dict) -> str:
    """set_section_number, naming the section: "set the count in “Later” to 6" (a
    heading's count), "set the number in “Not this quarter” to 6" (its words)."""
    key = str(target.get("section") or "")
    sec = (before.get("sections") or {}).get(key) or {}
    name = _HEAD_COUNT.sub("", str(sec.get("heading") or "")).strip()
    what = "the count" if target.get("part") == "heading" else "the number"
    where = f" in “{name}”" if name else " in a PRD section"
    n = str(after.get("number") or "")
    return f"set {what}{where} to {n}" if n else f"set {what}{where}"
