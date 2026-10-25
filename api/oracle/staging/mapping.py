"""G1 change kinds <-> D8 shared-draft actions (G4 3.1).

A discussion's item change is staged as the same D8 action a review screen's row button
writes, so the two are one action. ``section_edit`` waits for the document's next draft
(``next_draft_changes``); priority moves and pins are applied at once (C9's overrides) and
baseline kinds become proposals (G3): neither is staged.
"""

from typing import Any, Literal

from oracle.discussions import kinds
from oracle.runs.schemas import ActionIn

Target = Literal["checkpoint", "next_draft"]

# The checkpoint kind an item change lands at.
CHECKPOINT_KIND: dict[str, str] = {
    **{
        k: "roadmap_items"
        for k in (
            "item_horizon",
            "item_outcome",
            "item_dependency",
            "item_date_remove",
            "item_drop",
            "item_split",
            "item_merge",
            "ask_person",
        )
    },
    "scope_feature": "feature_set",
    "scope_requirement": "feature_set",
}
# Staged at the feature-set stop whose proposed scope holds the feature (C6, C7).
SCOPE_KINDS = ("scope_feature", "scope_requirement")
# Edit fields that map back to one G1 kind.
_FIELDS = {
    "horizon": "item_horizon",
    "outcome": "item_outcome",
    "depends_on": "item_dependency",
    "milestone_date": "item_date_remove",
}


def target_of(kind: str) -> Target | None:
    """Where staging a change of this kind lands; None when it is never staged."""
    if kind == "section_edit":
        return "next_draft"
    return "checkpoint" if kind in CHECKPOINT_KIND else None


def to_action(kind: str, payload: dict[str, Any], item_key: str | None = None) -> ActionIn:
    """The D8 action for a change (``item_key``: the subject's item, for kinds whose
    payload names none, such as ``ask_person``)."""
    p = payload
    item = p.get("item_key") or item_key or "*"
    match kind:
        case "item_horizon":
            return ActionIn(item_key=item, kind="edit", field="horizon", value=p["horizon"])
        case "item_outcome":
            return ActionIn(item_key=item, kind="edit", field="outcome", value=p["outcome"])
        case "item_dependency":
            value = {"add": list(p.get("add") or []), "remove": list(p.get("remove") or [])}
            return ActionIn(item_key=item, kind="edit", field="depends_on", value=value)
        case "item_date_remove":
            return ActionIn(item_key=item, kind="edit", field="milestone_date", value=None)
        case "item_drop":
            return ActionIn(item_key=item, kind="drop", note=p.get("reason"))
        case "item_split":
            return ActionIn(item_key=item, kind="split", value={"into": list(p["into"])})
        case "item_merge":
            return ActionIn(item_key=item, kind="merge", value={"with": list(p["with"])})
        case "ask_person":
            value = {"asked_to": str(p["asked_to"]), "text": p["prompt"]}
            return ActionIn(item_key=item, kind="question", value=value)
        case "scope_feature":
            return ActionIn(
                item_key=str(p["feature_id"]), kind="edit", field="decision",
                value=p["decision"], note=p.get("reason"),
            )  # fmt: skip
        case "scope_requirement":
            if p["op"] == "add":
                value = {"parent": p.get("goal_id"), "text": p.get("text"), "acceptance": None}
                return ActionIn(item_key="*", kind="add", value=value)
            req = str(p.get("requirement_id") or "*")
            if p["op"] == "cut":
                return ActionIn(item_key=req, kind="edit", field="decision", value="cut")
            return ActionIn(item_key=req, kind="edit", field="text", value=p.get("text"))
    raise ValueError(f"{kind} is not staged in a checkpoint's shared draft")


def to_change(
    item_key: str, kind: str, field: str | None, value: Any
) -> tuple[str | None, dict[str, Any] | None]:
    """The G1 kind and payload a D8 action reads as; (None, None) for actions no G1 kind
    has (accept, restore, waive, other edits)."""
    if kind == "edit" and field in _FIELDS:
        g1 = _FIELDS[field]
        if g1 == "item_dependency":
            v = value if isinstance(value, dict) else {}
            return g1, {
                "item_key": item_key,
                "add": v.get("add", []),
                "remove": v.get("remove", []),
            }
        if g1 == "item_date_remove":
            return g1, {"item_key": item_key}
        return g1, {"item_key": item_key, field: value}
    if kind == "edit" and field == "decision":
        if value == "cut":
            return "scope_requirement", {"op": "cut", "requirement_id": item_key}
        return "scope_feature", {"feature_id": item_key, "decision": value}
    if kind == "edit" and field == "text":
        return "scope_requirement", {"op": "enhance", "requirement_id": item_key, "text": value}
    if kind == "add":
        v = value if isinstance(value, dict) else {}
        return "scope_requirement", {"op": "add", "text": v.get("text")}
    if kind == "drop":
        return "item_drop", {"item_key": item_key}
    if kind in ("split", "merge"):
        key = "into" if kind == "split" else "with"
        v = value if isinstance(value, dict) else {}
        return f"item_{kind}", {"item_key": item_key, key: list(v.get(key) or [])}
    if kind == "question":
        v = value if isinstance(value, dict) else {}
        return "ask_person", {"item_key": item_key, "asked_to": v.get("asked_to"),
                              "prompt": v.get("text") or ""}  # fmt: skip
    return None, None


def label(
    kind: str | None,
    payload: dict[str, Any] | None,
    item_key: str | None,
    *,
    d8_kind: str | None = None,
    field: str | None = None,
) -> str:
    """The plain sentence a staged row reads as. The reason shows next to it, so labels
    carry none (a drop reads "Drop <item>" from a row and from a discussion alike)."""
    p = payload or {}
    if kind == "item_drop":
        return f"Drop {p.get('item_key') or item_key}"
    if kind == "scope_feature":
        return f"{str(p['decision']).capitalize()} {p['feature_id']}"
    if kind is not None:
        try:
            return kinds.label(kind, p)
        except (KeyError, TypeError, AttributeError):
            pass
    what = d8_kind or kind or "change"
    if what == "edit" and field:
        return f"Change {item_key}'s {field.removeprefix('clear:')}"
    return f"{what.replace('_', ' ').capitalize()} {item_key}"
