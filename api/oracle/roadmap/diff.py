"""The one roadmap item diff: what changed between two lists of roadmap items.

Pure (no database). Every comparison of roadmap items in Oracle calls :func:`diff_items`:
the roadmap items checkpoint's reasons (``horizon_changed``, ``new_item``,
``dropped_item``, oracle.runs.reasons), per-item resolutions, the roadmap item diff and
the plan screen. None of them writes a comparison of its own.

Items are compared as :class:`ItemSnapshot`: from a stored :class:`RoadmapItem` row
(:func:`snapshot_from_row`) or from an item of ``roadmap_items.yaml``
(:func:`snapshot_from_raw`).

Matching: an item of the base and one of the head are the same item when they share a key;
the rest are matched one-to-one by normalised title (a rename), when that title is unique
among the unmatched items on both sides. An item is then:

- ``added``: in the head only;
- ``dropped``: in the base only;
- ``moved``: its horizon changed (whatever else changed);
- ``changed``: a counted field changed (:data:`COUNTED_FIELDS`, the key on a rename, a
  rank move of :data:`RANK_THRESHOLD` places or more);
- ``unchanged``: nothing counted changed; it may carry notes (:data:`NOTE_FIELDS`, a rank
  shift under the threshold).

Plan changes count; confidence changes and one-place rank shifts are notes only.
"""

import re
import unicodedata
from dataclasses import dataclass, field
from datetime import date, datetime
from typing import Any, Literal

Status = Literal["added", "dropped", "moved", "changed", "unchanged"]
STATUSES: tuple[Status, ...] = ("added", "dropped", "moved", "changed", "unchanged")

# What makes an item "changed" (the plan: horizon, milestone or its date, dependencies,
# outcome or title, PRD section, and rank moves of RANK_THRESHOLD or more).
COUNTED_FIELDS: tuple[str, ...] = (
    "title",
    "outcome",
    "horizon",
    "milestone_name",
    "milestone_date",
    "depends_on",
    "prd_section",
    "rank",
)
# Recorded on the item, never counted: how sure, whether the date is verified, the
# section's hash.
NOTE_FIELDS: tuple[str, ...] = ("confidence", "date_state", "section_hash")
ALL_FIELDS: tuple[str, ...] = COUNTED_FIELDS + NOTE_FIELDS
# A rank move of this many places or more counts; a smaller one is a note.
RANK_THRESHOLD = 2


@dataclass(frozen=True)
class ItemSnapshot:
    key: str
    title: str
    outcome: str | None = None
    horizon: str | None = None
    milestone_name: str | None = None
    milestone_date: str | None = None
    # "verified" (a verified basis supports it), "refused" (kept, refused), "proposed"
    # (a file's date, not checked yet), or None (no date).
    date_state: str | None = None
    depends_on: tuple[str, ...] = ()
    rank: int | None = None
    confidence: str | None = None
    prd_section: str | None = None
    section_hash: str | None = None
    position: int = 0


@dataclass(frozen=True)
class FieldChange:
    field: str
    before: Any
    after: Any


@dataclass(frozen=True)
class ItemDiff:
    status: Status
    # The head's key, or the base's for a dropped item.
    key: str
    base: ItemSnapshot | None
    head: ItemSnapshot | None
    changes: tuple[FieldChange, ...] = ()
    notes: tuple[FieldChange, ...] = ()

    @property
    def base_key(self) -> str | None:
        return self.base.key if self.base is not None else None

    @property
    def renamed(self) -> bool:
        return self.base is not None and self.head is not None and self.base.key != self.head.key

    def changed(self, name: str) -> FieldChange | None:
        return next((c for c in self.changes if c.field == name), None)


@dataclass(frozen=True)
class ItemsDiff:
    items: tuple[ItemDiff, ...] = ()
    summary: dict[str, int] = field(default_factory=dict)

    def by_key(self, key: str) -> ItemDiff | None:
        return next((d for d in self.items if d.key == key), None)

    def of(self, status: Status) -> list[ItemDiff]:
        return [d for d in self.items if d.status == status]


def _text(value: Any) -> str | None:
    if value is None:
        return None
    text = value.strip() if isinstance(value, str) else str(value)
    return text or None


def _day(value: Any) -> str | None:
    if isinstance(value, datetime):
        return value.date().isoformat()
    if isinstance(value, date):
        return value.isoformat()
    return _text(value)


def _rank(priority: Any) -> int | None:
    if not isinstance(priority, dict):
        return None
    rank = priority.get("rank")
    if isinstance(rank, bool):
        return None
    if isinstance(rank, int):
        return rank
    if isinstance(rank, float) and rank.is_integer():
        return int(rank)
    return None


def _deps(value: Any) -> tuple[str, ...]:
    if not isinstance(value, list):
        return ()
    return tuple(str(v) for v in value)


def normalize(title: str | None) -> str:
    """A title as compared for a rename: case, accents, punctuation and spacing aside."""
    text = unicodedata.normalize("NFKD", title or "")
    text = "".join(c for c in text if not unicodedata.combining(c)).casefold()
    return " ".join(re.sub(r"[^0-9a-z]+", " ", text).split())


def snapshot_from_raw(raw: dict[str, Any], position: int) -> ItemSnapshot:
    """An item of ``roadmap_items.yaml`` (oracle.runs.roadmap's item shape)."""
    milestone = raw.get("milestone")
    name = when = None
    if isinstance(milestone, str):
        name = _text(milestone)
    elif isinstance(milestone, dict):
        name, when = _text(milestone.get("name")), _day(milestone.get("date"))
    confidence = raw.get("confidence")
    return ItemSnapshot(
        key=_text(raw.get("id")) or f"#{position + 1}",
        title=_text(raw.get("title")) or "",
        outcome=_text(raw.get("outcome")),
        horizon=_text(raw.get("horizon")),
        milestone_name=name,
        milestone_date=when,
        date_state="proposed" if when else None,
        depends_on=_deps(raw.get("depends_on")),
        rank=_rank(raw.get("priority")),
        confidence=None if confidence is None else str(confidence),
        prd_section=_text(raw.get("prd_section")),
        position=position,
    )


def snapshot_from_row(row: Any, live_milestone: Any = None) -> ItemSnapshot:
    """A stored roadmap item (:class:`oracle.roadmap.models.RoadmapItem`), with its
    milestone as it stands now (oracle.roadmap.items.live_milestones), else as stored."""
    milestone = live_milestone if live_milestone is not None else row.milestone
    name = when = state = None
    if isinstance(milestone, dict):
        name = _text(milestone.get("name"))
        if milestone.get("date"):
            when, state = _day(milestone.get("date")), "verified"
        elif milestone.get("refused_date"):
            when, state = _day(milestone.get("refused_date")), "refused"
    return ItemSnapshot(
        key=row.item_key,
        title=row.title or "",
        outcome=_text(row.outcome),
        horizon=row.horizon,
        milestone_name=name,
        milestone_date=when,
        date_state=state,
        depends_on=tuple(row.depends_on or ()),
        rank=_rank(row.priority),
        confidence=_text(row.confidence),
        prd_section=row.prd_section_key,
        section_hash=row.prd_section_hash,
        position=row.position,
    )


def _compare(
    base: ItemSnapshot,
    head: ItemSnapshot,
    counted: tuple[str, ...],
    rank_threshold: int,
) -> tuple[list[FieldChange], list[FieldChange]]:
    changes: list[FieldChange] = []
    notes: list[FieldChange] = []
    if base.key != head.key:
        changes.append(FieldChange("key", base.key, head.key))
    for name in ALL_FIELDS:
        before, after = getattr(base, name), getattr(head, name)
        if before == after:
            continue
        change = FieldChange(name, before, after)
        if name == "rank" and before is not None and after is not None:
            counts = abs(after - before) >= rank_threshold and "rank" in counted
            (changes if counts else notes).append(change)
        elif name in counted:
            changes.append(change)
        else:
            notes.append(change)
    return changes, notes


def _match(
    base: list[ItemSnapshot], head: list[ItemSnapshot]
) -> tuple[dict[int, int], set[int], set[int]]:
    """head index -> base index; unmatched base and head indexes."""
    pairs: dict[int, int] = {}
    base_by_key: dict[str, int] = {}
    for i, b in enumerate(base):
        base_by_key.setdefault(b.key, i)
    taken: set[int] = set()
    for j, h in enumerate(head):
        i = base_by_key.get(h.key)
        if i is not None and i not in taken:
            pairs[j] = i
            taken.add(i)
    free_base = [i for i in range(len(base)) if i not in taken]
    free_head = [j for j in range(len(head)) if j not in pairs]

    def unique(indexes: list[int], items: list[ItemSnapshot]) -> dict[str, int]:
        seen: dict[str, list[int]] = {}
        for n in indexes:
            title = normalize(items[n].title)
            if title:
                seen.setdefault(title, []).append(n)
        return {t: ns[0] for t, ns in seen.items() if len(ns) == 1}

    base_titles, head_titles = unique(free_base, base), unique(free_head, head)
    for title, j in head_titles.items():
        i = base_titles.get(title)
        if i is not None:
            pairs[j] = i
            taken.add(i)
    return (
        pairs,
        {i for i in range(len(base)) if i not in taken},
        {j for j in range(len(head)) if j not in pairs},
    )


def diff_items(
    base: list[ItemSnapshot],
    head: list[ItemSnapshot],
    *,
    counted: tuple[str, ...] = COUNTED_FIELDS,
    rank_threshold: int = RANK_THRESHOLD,
) -> ItemsDiff:
    """Compare two lists of items. The result follows the head's order, by position; each
    dropped item follows the head item that matched the base item just before it (or
    leads, when none did)."""
    base = sorted(base, key=lambda s: s.position)
    head = sorted(head, key=lambda s: s.position)
    pairs, dropped, _added = _match(base, head)

    out: list[ItemDiff] = []
    for j, h in enumerate(head):
        i = pairs.get(j)
        if i is None:
            out.append(ItemDiff("added", h.key, None, h))
            continue
        b = base[i]
        changes, notes = _compare(b, h, counted, rank_threshold)
        if any(c.field == "horizon" for c in changes):
            status: Status = "moved"
        elif changes:
            status = "changed"
        else:
            status = "unchanged"
        out.append(ItemDiff(status, h.key, b, h, tuple(changes), tuple(notes)))

    # Each dropped item goes after the head item matched to its nearest earlier base item.
    head_of_base = {i: j for j, i in pairs.items()}
    after: dict[int, list[ItemDiff]] = {}
    for i in sorted(dropped):
        anchor = next((head_of_base[k] for k in range(i - 1, -1, -1) if k in head_of_base), -1)
        after.setdefault(anchor, []).append(ItemDiff("dropped", base[i].key, base[i], None))
    ordered: list[ItemDiff] = list(after.get(-1, []))
    for j, d in enumerate(out):
        ordered.append(d)
        ordered.extend(after.get(j, []))
    summary = {s: sum(1 for d in ordered if d.status == s) for s in STATUSES}
    return ItemsDiff(tuple(ordered), summary)
