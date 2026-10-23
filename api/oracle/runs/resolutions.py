"""Per-item resolutions on a re-run (D6): how the next attempt answered the review.

After a send-back with a structured review (D4, oracle.runs.review_file), the agents write
``resolutions:`` at the top of the file they revise, one entry per review entry
(``{id, action, status: done | declined, note}``). :func:`resolve` checks each entry
against the new file without a model call, then reads the agents' answer:

- applied (whatever was said) -> ``done``;
- not applied, declined with a note -> ``declined`` (a person decides again, C1b);
- not applied otherwise -> ``not_applied`` (a claimed "done" included).

It also lists every field of an item under ``unchanged`` that differs from the previous
attempt (``unrequested``). :func:`item_diff` is the per-attempt diff: the one item diff
(:func:`oracle.roadmap.diff.diff_items`) with every field counted, reshaped as JSON.
Both are pure.
"""

from typing import Any

from oracle.roadmap import diff as engine

# The diff's fields: the snapshot's name -> the item file's own name.
FIELDS: dict[str, str] = {
    "horizon": "horizon",
    "milestone_name": "milestone.name",
    "milestone_date": "milestone.date",
    "depends_on": "depends_on",
    "outcome": "outcome",
    "title": "title",
    "prd_section": "prd_section",
    "confidence": "confidence",
    "rank": "priority.rank",
}
SAID = ("done", "declined")
OUTCOMES = ("done", "declined", "not_applied")


def _plain(value: Any) -> Any:
    return list(value) if isinstance(value, tuple) else value


def _snapshots(items: list[dict[str, Any]]) -> list[engine.ItemSnapshot]:
    return [engine.snapshot_from_raw(i, n) for n, i in enumerate(items)]


def _diff(previous: list[dict[str, Any]], items: list[dict[str, Any]]) -> engine.ItemsDiff:
    # Every field counts here, confidence and 1-place rank moves included.
    return engine.diff_items(
        _snapshots(previous), _snapshots(items), counted=engine.ALL_FIELDS, rank_threshold=1
    )


def _changes(d: engine.ItemDiff) -> list[dict[str, Any]]:
    order = list(FIELDS)
    found = [c for c in (*d.changes, *d.notes) if c.field in FIELDS]
    found.sort(key=lambda c: order.index(c.field))
    return [
        {"field": FIELDS[c.field], "from": _plain(c.before), "to": _plain(c.after)} for c in found
    ]


def item_diff(
    previous: list[dict[str, Any]], items: list[dict[str, Any]], against: int | None
) -> dict[str, Any]:
    """Each item's field changes since the previous attempt, and the ids added and removed
    (an id renamed is one removed and one added)."""
    rows: list[dict[str, Any]] = []
    added: list[str] = []
    removed: list[str] = []
    for d in _diff(previous, items).items:
        if d.status == "added":
            added.append(d.key)
        elif d.status == "dropped":
            removed.append(d.key)
        elif d.renamed:
            removed.append(d.base_key or "")
            added.append(d.key)
        elif changes := _changes(d):
            rows.append({"id": d.key, "changes": changes})
    return {"against_attempt": against, "items": rows, "added": added, "removed": removed}


# --------------------------------------------------------------------------- checks


def _text(value: Any) -> str | None:
    return engine._text(value)


def _empty(value: Any) -> bool:
    return value is None or value == [] or value == {} or value == ""


def _requested(entry: dict[str, Any]) -> list[tuple[str, Any]]:
    """(field, requested value) of a change entry, in the file's own field names."""
    out: list[tuple[str, Any]] = []
    for name, value in (entry.get("changes") or {}).items():
        if name == "milestone" and isinstance(value, dict):
            out += [(f"milestone.{k}", v) for k, v in value.items()]
        else:
            out.append((name, value))
    if entry.get("reorder"):
        out.append(("order", {"after": entry["after"]} if entry.get("after") else None))
    return out


def _current(name: str, raw: dict[str, Any] | None, snap: engine.ItemSnapshot | None) -> Any:
    if raw is None or snap is None:
        return None
    if name == "milestone.name":
        return snap.milestone_name
    if name == "milestone.date":
        return snap.milestone_date
    if name == "depends_on":
        return list(snap.depends_on)
    if name in ("horizon", "title", "outcome", "prd_section"):
        return getattr(snap, name)
    if name == "order":
        return None
    return raw.get(name)


def _applied(
    name: str,
    want: Any,
    key: str,
    raw: dict[str, Any] | None,
    snap: engine.ItemSnapshot | None,
    order: list[str],
) -> bool:
    if raw is None or snap is None:
        return False
    if name == "depends_on":
        deps = set(snap.depends_on)
        if isinstance(want, dict):
            add, drop = set(want.get("add") or []), set(want.get("remove") or [])
            return add <= deps and not drop & deps
        return deps == {str(d) for d in want or []}
    if name == "milestone.date":
        return snap.milestone_date == engine._day(want)
    if name in ("milestone.name", "horizon", "title", "outcome", "prd_section"):
        return _current(name, raw, snap) == _text(want)
    if name == "order":
        after = (want or {}).get("after") if isinstance(want, dict) else None
        return after is None or (after in order and order.index(after) < order.index(key))
    if want is None:
        return _empty(raw.get(name))
    return raw.get(name) == want


def _said(said: list[dict[str, Any]], entry: dict[str, Any]) -> dict[str, Any] | None:
    return next(
        (
            r
            for r in said
            if str(r.get("id")) == str(entry.get("id"))
            and r.get("action") in (None, entry.get("action"))
        ),
        None,
    )


def _check(
    entry: dict[str, Any], by_id: dict[str, dict[str, Any]], snaps: dict[str, Any], order: list[str]
) -> tuple[bool, list[dict[str, Any]]]:
    key, action = str(entry.get("id")), entry.get("action")
    if action == "change":
        raw, snap = by_id.get(key), snaps.get(key)
        fields = [
            {
                "field": name,
                "requested": want,
                "applied": _applied(name, want, key, raw, snap, order),
                "current": _plain(_current(name, raw, snap)),
            }
            for name, want in _requested(entry)
        ]
        return all(f["applied"] for f in fields), fields
    if action == "drop":
        return key not in by_id, []
    if action == "restore":
        return key in by_id, []
    if action == "split":
        into = [str(i) for i in entry.get("into") or []]
        return key not in by_id and all(i in by_id for i in into), []
    if action == "merge":
        others = [str(i) for i in entry.get("with") or []]
        gone = all(o not in by_id for o in others)
        named = any(
            set(others) <= {str(m) for m in (i.get("merged_from") or [])}
            for i in by_id.values()
            if isinstance(i.get("merged_from"), list)
        )
        return gone and (key in by_id or named), []
    # question, accept: nothing to check.
    return True, []


def resolve(
    review: dict[str, Any],
    previous_items: list[dict[str, Any]],
    items: list[dict[str, Any]],
    said: list[dict[str, Any]],
) -> dict[str, Any]:
    """Each review entry's outcome in ``items`` (the new attempt) with the agents' answer
    (``said``, the file's validated ``resolutions``), and the unrequested changes of the
    items the review left alone, against ``previous_items``."""
    by_id: dict[str, dict[str, Any]] = {}
    for i in items:
        by_id.setdefault(str(i["id"]), i)
    snaps = {s.key: s for s in reversed(_snapshots(items))}
    order = [str(i["id"]) for i in items]
    entries: list[dict[str, Any]] = []
    for entry in review.get("items") or []:
        applied, fields = _check(entry, by_id, snaps, order)
        answer = _said(said, entry)
        status = answer.get("status") if answer else None
        note = _text(answer.get("note")) if answer else None
        if applied:
            outcome = "done"
        elif status == "declined" and note:
            outcome = "declined"
        else:
            outcome = "not_applied"
        entries.append(
            {
                "id": str(entry.get("id")),
                "action": entry.get("action"),
                "outcome": outcome,
                "said": status if status in SAID else "missing",
                "note": note,
                "fields": fields,
                **{k: entry[k] for k in ("into", "with") if entry.get(k)},
            }
        )
    diffs = _diff(previous_items, items)
    unrequested: list[dict[str, Any]] = []
    for key in review.get("unchanged") or []:
        d = diffs.by_key(str(key))
        if d is None or d.base is None or d.head is None or d.renamed:
            continue
        unrequested += [{"id": d.key, **c} for c in _changes(d)]
    counts = {o: sum(1 for e in entries if e["outcome"] == o) for o in OUTCOMES}
    return {
        "review_attempt": review.get("attempt"),
        "attempt": None,
        "entries": entries,
        "counts": {**counts, "unrequested": len(unrequested)},
        "unrequested": unrequested,
    }
