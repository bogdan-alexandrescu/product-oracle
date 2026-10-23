"""Approve with edits (D7): the staged actions of a Roadmap items checkpoint applied to
``roadmap_items.yaml`` by Oracle, with no model call (owner, c2 Approve with edits).

:func:`apply` is pure: the agents' text and the staged actions (D8 vocabulary) in, the
edited text and the applied entries (D4 entry shape, each with a ``text`` line) out. The
actions are applied in a fixed order (restores, field edits, drops, then the order fix), so
the same draft always gives the same file. The caller writes the result as a new revision
of the file, re-checks it and gates the approval on that check
(:func:`oracle.runs.service.decide_checkpoint`).

Kinds Oracle applies: ``accept``, ``edit`` (every D8 field), ``drop``, ``restore``,
``waive`` and an answered ``question`` (these three change nothing and are recorded).
``split``, ``merge`` and an unanswered ``question`` need the agents (:func:`needs_agents`).
"""

import uuid
from collections.abc import Iterable
from datetime import date
from typing import Any, Protocol
from zoneinfo import ZoneInfo

from oracle import safe_yaml
from oracle.runs.review_file import _change

FILE = "roadmap_items.yaml"
# The checkpoint kinds whose staged edits Oracle applies, and to which file.
FILES = {"roadmap_items": FILE}
# Kinds that change the file (what "Approve with {n} edits" counts).
CHANGES = ("edit", "drop", "restore")
# Kinds only the agents can carry out.
AGENT_KINDS = ("split", "merge")
NO_CHANGE = ("accept", "waive", "question")
# A question still asked (oracle.intake.questions.OPEN): it needs the agents.
OPEN_QUESTIONS = ("asked", "delegated")
# The Company's time zone, for the date in the edited file's header.
COMPANY_ZONE = ZoneInfo("America/Los_Angeles")
_ORDER = {"restore": 0, "edit": 1, "drop": 2}
# D8 edit fields whose value sits in the item's milestone mapping.
_MILESTONE = {"milestone_date": "date", "milestone_name": "name"}


class Action(Protocol):
    id: uuid.UUID
    item_key: str
    kind: str
    field: str | None
    value: Any
    answers: Any
    note: str | None


class EditError(ValueError):
    """An edit that cannot apply to the file as it is (its item gone, a dependency the
    file does not have)."""

    def __init__(self, action_id: uuid.UUID, message: str) -> None:
        super().__init__(message)
        self.action_id = action_id


def edit_count(actions: Iterable[Action]) -> int:
    return sum(1 for a in actions if a.kind in CHANGES)


def label(n: int) -> str:
    """The approve button's words: ``Approve``, or ``Approve with {n} edits``."""
    return f"Approve with {n} edit{'' if n == 1 else 's'}" if n else "Approve"


def needs_agents(actions: Iterable[Action], open_questions: set[uuid.UUID]) -> list[Action]:
    """The staged actions only the agents can carry out: a split, a merge, a question not
    answered yet (``open_questions``: the question ids still asked)."""
    out = []
    for a in actions:
        if a.kind in AGENT_KINDS:
            out.append(a)
        elif a.kind == "question":
            qid = getattr(a, "question_id", None)
            if qid is None or qid in open_questions:
                out.append(a)
    return out


def refusal(blocked: list[Action]) -> str:
    """Why Approve is refused while ``blocked`` (from :func:`needs_agents`) is staged."""
    return " ".join(
        f"{a.kind.capitalize()} on {a.item_key} needs the agents: send back, or remove it to "
        "approve."
        for a in blocked
    )


def header(member: str, on: date, n: int, attempt: int) -> str:
    """The two comment lines that open the edited file."""
    return (
        f"# {FILE}, edited at the Roadmap items checkpoint on {on.isoformat()} by an approver\n"
        f"# ({member}): {n} edit{'' if n == 1 else 's'} applied by Oracle; no agent ran. "
        f"The agents' attempt {attempt} is kept.\n"
    )


def _show(v: Any) -> str:
    return "none" if v is None else str(v)


def _edit(item: dict[str, Any], a: Action, ids: set[str]) -> str | None:
    """Apply one ``edit`` to ``item``; returns the line saying what changed (None for the
    order fix, applied to the whole list afterwards)."""
    f, v, key = a.field or "", a.value, a.item_key
    if f == "order":
        return None
    if f.startswith("clear:"):
        name = f.removeprefix("clear:")
        item.pop(name, None)
        return f"{key} {name} cleared"
    if f in _MILESTONE:
        part = _MILESTONE[f]
        milestone = item.get("milestone")
        milestone = dict(milestone) if isinstance(milestone, dict) else {}
        if f == "milestone_date":
            milestone.pop("date", None)
            milestone.pop("date_source", None)
            if milestone:
                item["milestone"] = milestone
            else:
                item.pop("milestone", None)
            return f"{key} milestone date removed"
        milestone[part] = v
        item["milestone"] = milestone
        return f"{key} milestone name now {v}"
    if f == "depends_on":
        v = v if isinstance(v, dict) else {}
        deps = [str(d) for d in item.get("depends_on") or []]
        for d in v.get("add") or []:
            if d not in ids:
                raise EditError(a.id, f"{key} cannot depend on {d}: no such item in the file")
            if d not in deps:
                deps.append(d)
        gone = set(v.get("remove") or [])
        item["depends_on"] = [d for d in deps if d not in gone]
        said = [f"+{d}" for d in v.get("add") or []] + [f"-{d}" for d in gone]
        return f"{key} depends_on {', '.join(said)}"
    old = item.get(f)
    item[f] = v
    if f == "horizon":
        return f"{key} horizon {_show(old)} → {v}"
    return f"{key} {f} now {v}"


def _sorted(items: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """A stable topological sort: each item after the items it depends on, otherwise in
    its current order (a cycle keeps its current order; the check reports it)."""
    ids = {i.get("id") for i in items}
    placed: list[dict[str, Any]] = []
    done: set[Any] = set()
    left = list(items)
    while left:
        n = next(
            (
                n
                for n, item in enumerate(left)
                if all(d in done for d in item.get("depends_on") or [] if d in ids)
            ),
            0,
        )
        item = left.pop(n)
        placed.append(item)
        done.add(item.get("id"))
    return placed


def _restore(items: list[dict[str, Any]], a: Action, base_items: dict[str, dict[str, Any]]) -> None:
    raw = base_items.get(a.item_key)
    if not isinstance(raw, dict):
        raise EditError(a.id, f"{a.item_key} is not in the comparison base to restore")
    if any(i.get("id") == a.item_key for i in items):
        return
    # In its base place: after the nearest base item before it that the file still has.
    order = list(base_items)
    at = 0
    for before in reversed(order[: order.index(a.item_key)]):
        found = next((n for n, i in enumerate(items) if i.get("id") == before), None)
        if found is not None:
            at = found + 1
            break
    items.insert(at, {"id": a.item_key, **dict(raw)})


def apply(
    text: str, actions: list[Action], base_items: dict[str, dict[str, Any]]
) -> tuple[str, list[dict[str, Any]]]:
    """``text`` with ``actions`` applied (the YAML body, no header) and the applied entries
    in the D4 entry shape with a ``text`` line each. ``base_items``: the comparison base's
    item mappings by id (D2), for ``restore``. Raises :class:`EditError`."""
    data = safe_yaml.load(text)
    if not isinstance(data, dict) or not isinstance(data.get("items"), list):
        raise EditError(actions[0].id if actions else uuid.uuid4(), f"{FILE} lists no items")
    items: list[dict[str, Any]] = [dict(i) for i in data["items"] if isinstance(i, dict)]
    # The entries in the actions' item order (as staged), each item once per kind.
    entries: dict[tuple[str, str], dict[str, Any]] = {}

    def entry(key: str, kind: str) -> dict[str, Any]:
        return entries.setdefault((key, kind), {"id": key, "action": kind, "lines": []})

    base_order = {k: n for n, k in enumerate(base_items)}
    for a in sorted(
        (a for a in actions if a.kind == "restore"), key=lambda a: base_order.get(a.item_key, 0)
    ):
        _restore(items, a, base_items)
        entry(a.item_key, "restore")["lines"].append(f"{a.item_key} restored")
    ids = {str(i.get("id")) for i in items}
    edits_of: dict[str, list[Action]] = {}
    reorder = False
    for a in sorted(
        (a for a in actions if a.kind in _ORDER and a.kind != "restore"),
        key=lambda a: _ORDER[a.kind],
    ):
        item = next((i for i in items if str(i.get("id")) == a.item_key), None)
        if item is None:
            raise EditError(a.id, f"{a.item_key} is not an item of the file any more")
        if a.kind == "drop":
            items.remove(item)
            entry(a.item_key, "drop")["lines"].append(f"{a.item_key} dropped")
            continue
        edits_of.setdefault(a.item_key, []).append(a)
        line = _edit(item, a, ids)
        if line is None:
            reorder = True
            line = f"{a.item_key} moved after the items it depends on"
        entry(a.item_key, "change")["lines"].append(line)
    dropped = {a.item_key for a in actions if a.kind == "drop"}
    for item in items:
        deps = item.get("depends_on")
        if isinstance(deps, list) and any(d in dropped for d in deps):
            item["depends_on"] = [d for d in deps if d not in dropped]
    if reorder:
        items = _sorted(items)
    for a in actions:
        if a.kind in NO_CHANGE:
            entry(a.item_key, a.kind)
    data["items"] = items
    body = safe_yaml.dump(
        data, sort_keys=False, allow_unicode=True, default_flow_style=False, width=4096
    )
    applied: list[dict[str, Any]] = []
    for (key, kind), e in entries.items():
        lines = e.pop("lines")
        out = _change(edits_of[key]) if kind == "change" else e
        out = {**out, "text": "; ".join(lines) or f"{key} {kind}"}
        group = edits_of.get(key, []) if kind == "change" else [
            a for a in actions if a.item_key == key and a.kind == kind
        ]  # fmt: skip
        answers = list(dict.fromkeys(c for a in group for c in a.answers or []))
        if answers:
            out["answers"] = answers
        applied.append(out)
    return body, applied


def summary(applied: list[dict[str, Any]]) -> str:
    """The MERGE finding: what Oracle applied, one clause per changed item."""
    lines = [e["text"] for e in applied if e["action"] in ("change", "drop", "restore")]
    return f"Oracle applied the reviewer's edits to {FILE}: " + "; ".join(lines) + "."
