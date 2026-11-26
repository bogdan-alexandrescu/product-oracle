"""panel-stages (#1879): the feature panel's Status, any stage to any other.

Draft, Planned and Done, either way: a move back (Done to Planned or Draft, Planned to
Draft) says why, kept on the change (``target.reason``) for its history. Draft keeps the plan
(dates, horizon, track, milestone, dependencies) stored, so planning it again restores them.
"""

from typing import Any

from oracle import company_time

# The statuses a person sets (the others come from the tracker or a merge).
STATUSES = ("draft", "planned", "done", "cut")
PANEL_DONE = "Marked done in its panel"
NOTE_MAX = 500
_RANK = {"draft": 0, "planned": 1, "in_progress": 1, "done": 2}


def status_after(entry: Any, body: Any, target: dict[str, Any], me: str) -> dict[str, Any]:
    """set_status's stored after ({cut, shipped, draft}); 422 on an unknown status or a move
    back with no reason. ``target`` takes the reason."""
    from oracle.simple.changes import ChangeError

    row, status, now = entry.row, body.after.get("status"), entry.status
    if status not in STATUSES:
        raise ChangeError(422, "after.status: draft, planned, done or cut")
    back = now in _RANK and status in _RANK and _RANK[status] < _RANK[now]
    why = " ".join(str(body.after.get("reason") or body.reason or "").split())
    if back and not why:
        raise ChangeError(422, "Say why it moves back")
    if back:
        target["reason"] = why[:NOTE_MAX]
    if back and now == "done" and status == "planned" and not row.shipped:
        # Done from its tracker's records, not a mark: no mark here undoes that (Draft does).
        raise ChangeError(422, "Its tracker says it is done: reopen it there")
    # Planned clears only the panel's own mark: a shipped mark from elsewhere (the tracker,
    # the item's talk) stays, so planned never undoes what the panel did not do; a move back
    # from Done reopens it (the mark stays in the change's ``before``).
    shipped = None if (row.shipped or {}).get("note") == PANEL_DONE else row.shipped
    if back and now == "done":
        shipped = None
    if status == "done":
        shipped = row.shipped or {
            "note": PANEL_DONE,
            "by": me,
            "on": company_time.today().isoformat(),
        }
    after: dict[str, Any] = {"cut": status == "cut", "shipped": shipped}
    if status != "cut":  # a cut draft stays a draft, so Restore brings it back as one
        after["draft"] = status == "draft"
    return after
