"""Roadmap items go potentially stale when what they trace to changes (§11.5, CR-11).

The ``roadmap.items`` handler on :mod:`oracle.changes` runs after the trace lane's
``trace.mark_stale`` (which marks the roadmap *version* through its derived
dependencies) and marks the *items*:

- ``document_version`` on a PRD: items traced to an earlier version of that PRD whose
  section's content hash differs in the new version, or is gone. An item with no PRD
  section has nothing of its own a new version changes: it is not marked (the owner's
  walk, P11: a plan approved a week ago read "40 of 40 items need attention (40 stale)");
  the track says the PRD has a newer approved version instead;
- ``document_section``: items traced to that section of that PRD;
- ``requirement``, ``decision``, ``entity``, ``blocker_status``: items whose feature,
  requirements or blockers include the changed entity (or a batch's roots, or what the
  trace handler found downstream, ``data["trace"]["entity_ids"]``), and items whose PRD
  section links it.

``document_version`` on a roadmap stores the version's items (oracle.roadmap.items).

The handler writes only the items' freshness columns: an item's content, and an approved
roadmap version, are never rewritten. A person settles staleness: ``review`` (under
review) or ``reconcile`` (with a reason; the PRD's latest approved version and that
section's hash are recorded as what the item was reconciled against, and later changes
are judged against them; the item's own trace is kept as built).
"""

import json
import re
import uuid
from collections.abc import Iterable
from dataclasses import replace
from datetime import UTC, datetime
from typing import Any

from sqlalchemy import and_, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from oracle import audit
from oracle.auth.deps import Principal
from oracle.docs.models import Document, DocumentVersion, Section
from oracle.models import AuditEvent
from oracle.roadmap import items as items_mod
from oracle.roadmap.models import RoadmapItem
from oracle.v2.models import ChangeEvent, DocumentSectionLink

HANDLER = "roadmap.items"
SUBJECTS = (
    "document_version",
    "document_section",
    "requirement",
    "decision",
    "entity",
    "blocker_status",
)
ENTITY_SUBJECTS = ("requirement", "decision", "entity", "blocker_status")
VERBS = {
    "entity_updated": "changed",
    "entity_confirmed": "was confirmed",
    "entity_rejected": "was rejected",
    "entity_deleted": "was deleted",
    "edge_created": "gained a link",
    "edge_deleted": "lost a link",
    "edge_updated": "had a link changed",
}
FROM_STATES = {
    "review": ("potentially_stale",),
    "reconcile": ("potentially_stale", "under_review"),
}


class Conflict(RuntimeError):
    pass


class Invalid(ValueError):
    pass


def _uuid(value: Any) -> uuid.UUID | None:
    try:
        return value if isinstance(value, uuid.UUID) else uuid.UUID(str(value))
    except ValueError:
        return None


def _entity_ids(event: ChangeEvent) -> set[uuid.UUID]:
    data = event.data or {}
    ids = {event.subject_id} if event.subject_id else set()
    for root in data.get("roots") or []:
        if isinstance(root, dict) and (u := _uuid(root.get("id"))):
            ids.add(u)
    for raw in (data.get("trace") or {}).get("entity_ids") or []:
        if u := _uuid(raw):
            ids.add(u)
    return ids


# A bulk write's reason: "11 Ground Truth items changed" (#505). Change events and
# reasons stored before the Ground Truth rename say "11 baseline items": they count the
# same, and the read path says them in the new words (:func:`_reworded`).
_COUNTED = re.compile(r"(\d+) (?:Ground Truth|baseline) items? (.+)")
_SIZE = re.compile(r"\d+ (?:Ground Truth|baseline) items?")
_OLD_COUNT = re.compile(r"\b(\d+) baseline (items?)\b")


# A PRD version's reason on one section ("PRD section Checkout changed in version 5").
_SECTION_VERSION = re.compile(r"PRD section (.+) (?:changed|is gone) in version \d+")


def one_count(reasons: Iterable[str]) -> list[str]:
    """The reasons with one counted line per verb, the latest (#505): two bulk writes read
    "11 Ground Truth items changed", never "42 Ground Truth items changed; 11 Ground
    Truth items changed". And one line per PRD section, the latest version's (the
    stale-marks walk): "PRD section Checkout changed in version 5", never once per
    version."""
    out: list[str] = []
    for reason in reasons:
        if m := _COUNTED.fullmatch(reason):
            out = [r for r in out if not ((o := _COUNTED.fullmatch(r)) and o[2] == m[2])]
        if m := _SECTION_VERSION.fullmatch(reason):
            out = [r for r in out if not ((o := _SECTION_VERSION.fullmatch(r)) and o[1] == m[1])]
        if reason not in out:
            out.append(reason)
    return out


def with_heading(reasons: Iterable[str], section_key: str | None, heading: str | None) -> list[str]:
    """``reasons`` naming the item's own PRD section by its heading, not its key (the
    stale-marks walk: "PRD section feature-x-2217a4 changed in version 4" read as a key).
    A reason stored with the key reads with the heading, with no migration needed."""
    if not section_key or not heading or heading == section_key:
        return list(reasons)
    old, new = f"PRD section {section_key} ", f"PRD section {heading} "
    return [new + r[len(old) :] if r.startswith(old) else r for r in reasons]


def refs_in(reasons: Iterable[str]) -> set[tuple[str, str]]:
    """The Ground Truth items the reasons name by ref, as ``(type, key)``."""
    out: set[tuple[str, str]] = set()
    for reason in reasons:
        if _REF.fullmatch(reason):
            kind, _, key = reason.split(" ", 1)[0].partition(":")
            out.add((kind, key))
    return out


def name_refs(reasons: Iterable[str], names: dict[str, str] | None) -> list[str]:
    """A reason naming one Ground Truth item by ref, the only one with its verb, said with
    that item's name (the stale-marks walk: "goal:kr-3-4-every-client-fit-scored was
    rejected" reads 'The goal "Every client fit scored" was rejected'). Several with one
    verb stay counted (:func:`in_words`: "The feature and 2 goals changed"); a ref with no
    known name is left to :func:`in_words`. ``names``: {"type:key": title}."""
    reasons = list(reasons)
    if not names:
        return reasons
    by_verb: dict[str, list[int]] = {}
    for i, reason in enumerate(reasons):
        if m := _REF.fullmatch(reason):
            by_verb.setdefault(m[2], []).append(i)
    for verb, at in by_verb.items():
        if len(at) != 1:
            continue
        ref = reasons[at[0]][: -(len(verb) + 1)]
        if title := names.get(ref):
            kind = ref.partition(":")[0].replace("_", " ")
            reasons[at[0]] = f'The {kind} "{title}" {verb}'
    return reasons


def say(reasons: Iterable[str], names: dict[str, str] | None = None) -> list[str]:
    """Reasons as a person reads them: each said once, a lone Ground Truth item by its
    name, the rest in words (:func:`one_count`, :func:`name_refs`, :func:`in_words`)."""
    return in_words(name_refs(one_count(reasons), names))


# A reason naming one Ground Truth item by its ref ("feature:delivery-x changed").
_REF = re.compile(r"([a-z][a-z_]*):\S+ (.+)")
# What there is one of for an item: its feature, the product.
_THE = ("feature", "product")


def _noun(kind: str, n: int) -> str:
    word = kind.replace("_", " ")
    if n == 1:
        return f"the {word}" if kind in _THE else f"a {word}"
    if word.endswith("y") and not word.endswith(("ay", "ey", "oy", "uy")):
        return f"{n} {word[:-1]}ies"
    return f"{n} {word}{'es' if word.endswith(('s', 'x', 'ch', 'sh')) else 's'}"


def in_words(reasons: Iterable[str]) -> list[str]:
    """Reasons naming Ground Truth items by ref, said in words (prod-6): "feature:delivery-x
    changed", "goal:g-b changed", "goal:g-c changed" read "The feature and 2 goals
    changed"; one line per verb, where its first reason stood. Other reasons are kept."""
    out: list[str | tuple[str, dict[str, int]]] = []
    by_verb: dict[str, dict[str, int]] = {}
    for reason in reasons:
        m = _REF.fullmatch(reason)
        if not m:
            if reason not in out:
                out.append(reason)
            continue
        kind, verb = m[1], m[2]
        if verb not in by_verb:
            by_verb[verb] = {}
            out.append((verb, by_verb[verb]))
        by_verb[verb][kind] = by_verb[verb].get(kind, 0) + 1
    lines: list[str] = []
    for entry in out:
        if isinstance(entry, str):
            lines.append(entry)
            continue
        verb, kinds = entry
        nouns = [_noun(k, n) for k, n in kinds.items()]
        subject = nouns[0] if len(nouns) == 1 else f"{', '.join(nouns[:-1])} and {nouns[-1]}"
        many = len(nouns) > 1 or next(iter(kinds.values())) > 1
        said = verb.replace("was ", "were ", 1) if many and verb.startswith("was ") else verb
        line = f"{subject} {said}"
        lines.append(line if lines else line[0].upper() + line[1:])
    return lines


def stale_why(
    reasons: Iterable[str] | None, default: str, names: dict[str, str] | None = None
) -> str:
    """An item's stale reasons as one line, each said once, in words. A reason stored
    in the old literal form (prod-6) is reworded first (:func:`_reworded`), with no
    migration needed."""
    reworded = [_reworded(r) for r in (reasons or [])]
    return "; ".join(say(reworded, names)) or default


# A reason naming what the reader may not see, said without it (#541).
HIDDEN_REASON = "a linked Ground Truth item changed"

# A section-link reason stored before prod-6's fix, naming the linked item by its bare
# ref ("PRD section s-5-1 links feature:promo-codes, which changed") instead of its
# name. There is no name to recover from the stored text, only its kind, so it is put
# into words the same way a ref-named reason already is (:func:`in_words`'s ``_noun``).
_OLD_SECTION_LINK = re.compile(r"PRD section (\S+) links ([a-z][a-z_]*):\S+(, which changed)")


def _reworded(reason: str) -> str:
    """A stored reason rewritten in words if it is in the old literal form, so a
    migration is never needed: the read path keeps up with the wording on its own."""
    if m := _OLD_SECTION_LINK.fullmatch(reason):
        return f"PRD section {m[1]} links {_noun(m[2], 1)}{m[3]}"
    return ground_truth_count(reason)


def ground_truth_count(text: str) -> str:
    """``text`` with an old bulk write's size ("42 baseline items") in the Ground Truth
    words; the stale reasons and a change's impact page (oracle.trace.impact) read it so."""
    return _OLD_COUNT.sub(r"\1 Ground Truth \2", text)


# The reason an earlier rule wrote on an item with no PRD section for any new PRD version:
# not a reason of the item's own (P11), so it never makes the item stale on a read.
_WHOLE_PRD = re.compile(r"the PRD has a new version \(\d+\)")
STALE_STATES = ("potentially_stale", "under_review")


def own_reasons(item: Any) -> list[str]:
    """The item's stale reasons of its own: without "the PRD has a new version (N)"."""
    return [r for r in item.stale_reasons or [] if not _WHOLE_PRD.fullmatch(r)]


def is_stale(item: Any) -> bool:
    """The per-item stale rule, as every read counts it (the track's headline, its at-risk
    list, alerts): the item is potentially stale or under review for a reason of its own
    (what it traces changed). An item marked only because the PRD got a new version (the
    earlier rule for an item with no section) is not stale."""
    if item.freshness not in STALE_STATES:
        return False
    return not item.stale_reasons or bool(own_reasons(item))


def for_reader(reasons: Iterable[str] | None, hidden: Any) -> list[str]:
    """``reasons`` as the reader may read them: one naming a decision or document the
    reader may not see (``hidden``, :func:`oracle.docs.visibility.hidden_for_reader`;
    None sees all) is said as :data:`HIDDEN_REASON`, once. A reason stored in the old
    literal form (prod-6) is put into words (:func:`_reworded`), with no migration."""
    if hidden is None:
        return [_reworded(r) for r in (reasons or [])]
    # Hidden is judged on the stored text: rewording an old literal reason ("... links
    # decision:d-7, which changed") would drop the ref the check looks for.
    return list(
        dict.fromkeys(HIDDEN_REASON if hidden.names(r) else _reworded(r) for r in (reasons or []))
    )


def stored_detail(reasons: list[str]) -> str:
    """A stale alert's reasons as stored: a JSON list, so a reason naming a title that
    holds ``"; "`` is never cut in two when it is read (cld-4)."""
    return json.dumps(reasons, ensure_ascii=False)


def stored_reasons(detail: str) -> list[str] | None:
    """The reasons of a detail stored by :func:`stored_detail`; None for a line stored
    before it, its reasons joined by ``"; "``."""
    if not detail.startswith("["):
        return None
    try:
        reasons = json.loads(detail)
    except ValueError:
        return None
    if isinstance(reasons, list) and all(isinstance(r, str) for r in reasons):
        return reasons
    return None


def _old_reasons(detail: str, hidden: Any) -> list[str]:
    """The reasons of a line stored before cld-4, joined by ``"; "``: split on it, and the
    parts that only together name something hidden (a title holding ``"; "``, cut in two)
    said as :data:`HIDDEN_REASON`. Judged on the stored text, before any part is put into
    words or counted, which could break the title up; the other parts are kept."""
    parts = detail.split("; ")
    if hidden is None:
        return parts
    cut = [False] * len(parts)
    # Only a title can hold "; " (an id, a slug or "D-7" cannot): each is found on its own,
    # as the fewest parts that name it, so a reason beside it is never taken for it.
    for word in (w for w in hidden.words if "; " in w):
        title = replace(hidden, ids=frozenset(), numbers=frozenset(), words=frozenset({word}))
        for i in range(len(parts)):
            if title.names(parts[i]):
                continue  # a part naming it whole is hidden as itself (for_reader)
            for j in range(i + 1, len(parts)):
                if title.names("; ".join(parts[i : j + 1])):
                    if _starts_in(title, parts, i, j):
                        cut[i : j + 1] = [True] * (j + 1 - i)
                    break
    return [HIDDEN_REASON if c else p for p, c in zip(parts, cut, strict=True)]


def _starts_in(title: Any, parts: list[str], i: int, j: int) -> bool:
    """Whether a naming of ``title`` across ``parts[i..j]`` starts in part ``i``: read
    with part ``j`` growing a character at a time, the parts from ``i`` name it before
    the parts after ``i`` do. Not whether the parts after ``i`` name it at all: a later
    part can hold the title whole in other characters (a fullwidth semicolon folds to
    ";", cld-8) while the naming that starts in part ``i`` is still cut on "; "."""
    head = "; ".join(parts[i:j]) + "; "
    rest = "".join(f"{p}; " for p in parts[i + 1 : j])
    for end in range(1, len(parts[j]) + 1):
        if title.names(rest + parts[j][:end]):
            return False
        if title.names(head + parts[j][:end]):
            return True
    return False


def detail_for_reader(
    detail: str | None, hidden: Any, names: dict[str, str] | None = None
) -> str | None:
    """A stored stale alert's reasons (:func:`stored_detail`) as one line for the reader:
    what they may not see is hidden first (:func:`for_reader`), then the rest is put into
    words (:func:`in_words`), so a reader never learns the kind of a hidden item ("A
    decision ... changed"). A line stored before cld-4, its reasons joined by ``"; "``, is
    split on it (:func:`_old_reasons`). A reason stored in an older form (worded, or
    prod-6's literal refs) reads the same way, with no migration needed."""
    if not detail:
        return detail
    reasons = stored_reasons(detail)
    if reasons is None:
        reasons = _old_reasons(detail, hidden)
    line = "; ".join(say(for_reader(reasons, hidden), names))
    # The last word: a line read that still names something hidden is not shown.
    return HIDDEN_REASON if hidden is not None and hidden.names(line) else line


def _mark(item: RoadmapItem, event: ChangeEvent, reason: str, now: datetime) -> None:
    if item.freshness != "potentially_stale" or item.stale_since is None:
        item.stale_since = now
    item.freshness = "potentially_stale"
    item.caused_by_change_id = event.id
    reasons = list(item.stale_reasons or [])
    if reason not in reasons:
        reasons.append(reason)
    item.stale_reasons = one_count(reasons)[-20:]


async def _by_prd_version(db: AsyncSession, event: ChangeEvent, found: dict) -> None:
    new = await db.get(DocumentVersion, event.subject_id)
    if new is None:
        return
    hashes: dict[str, str] = {}
    headings: dict[str, str] = {}
    for key, content_hash, heading in await db.execute(
        select(Section.section_key, Section.content_hash, Section.heading).where(
            Section.version_id == new.id
        )
    ):
        hashes[key], headings[key] = content_hash, heading
    rows = await db.scalars(
        select(RoadmapItem).where(
            RoadmapItem.prd_document_id == new.document_id,
            RoadmapItem.roadmap_version_id.is_not(None),
        )
    )
    gone: list[tuple[RoadmapItem, uuid.UUID | None, str]] = []
    for item in rows:
        version_id, section_hash = anchor(item)
        if version_id == new.id:
            continue
        key = item.prd_section_key
        if key is None:
            continue  # nothing of its own changed (P11): see the module's docstring
        # The section by its heading (the stale-marks walk), never its key.
        if key not in hashes:
            gone.append((item, version_id, key))
            found[item.id] = (item, f"PRD section {key} is gone in version {new.number}")
        elif hashes[key] != section_hash:
            found[item.id] = (
                item,
                f"PRD section {headings.get(key) or key} changed in version {new.number}",
            )
    if not gone:
        return
    # A gone section by the heading it had where each item was anchored: one read for all.
    versions = {v for _, v, _ in gone if v is not None}
    old_headings = (
        {
            (v, k): h
            for v, k, h in await db.execute(
                select(Section.version_id, Section.section_key, Section.heading).where(
                    Section.version_id.in_(versions),
                    Section.section_key.in_({k for _, _, k in gone}),
                )
            )
        }
        if versions
        else {}
    )
    for item, version_id, key in gone:  # in place: the order items were found in stays
        if heading := old_headings.get((version_id, key)):
            found[item.id] = (item, f"PRD section {heading} is gone in version {new.number}")


async def _by_section(db: AsyncSession, event: ChangeEvent, found: dict) -> None:
    key = (event.data or {}).get("section_key")
    if event.document_id is None or not key:
        return
    rows = await db.scalars(
        select(RoadmapItem).where(
            RoadmapItem.prd_document_id == event.document_id,
            RoadmapItem.prd_section_key == key,
            RoadmapItem.roadmap_version_id.is_not(None),
        )
    )
    for item in rows:
        found[item.id] = (item, f"PRD section {key} changed ({event.cause})")


async def _by_entities(db: AsyncSession, event: ChangeEvent, found: dict) -> None:
    ids = _entity_ids(event)
    if not ids:
        return
    verb = VERBS.get(event.cause, "changed")
    if event.subject_kind == "blocker_status":
        verb = "changed status"
    # A bulk write names its size ("42 Ground Truth items"); an item says what of it is its own.
    counted = event.subject_ref is None or bool(_SIZE.fullmatch(event.subject_ref))
    refs = {
        u: str(root["ref"])
        for root in (event.data or {}).get("roots") or []
        if isinstance(root, dict) and root.get("ref") and (u := _uuid(root.get("id")))
    }
    # The changed entity's own name (prod-6): a PRD section link names what it links by
    # its title, never its bare ref ("feature:promo-codes").
    names: dict[uuid.UUID, str] = {
        u: str(title)
        for root in (event.data or {}).get("roots") or []
        if isinstance(root, dict)
        and (u := _uuid(root.get("id")))
        and isinstance(root.get("entity"), dict)
        and (title := root["entity"].get("title"))
    }
    entity = (event.data or {}).get("entity")
    if event.subject_id is not None and isinstance(entity, dict) and entity.get("title"):
        names.setdefault(event.subject_id, str(entity["title"]))

    def named(linked: set[uuid.UUID]) -> str:
        if len(linked) == 1 and (name := names.get(next(iter(linked)))):
            return name
        n = len(linked) or len(ids)
        return f"{n} Ground Truth item{'' if n == 1 else 's'}"

    def what(linked: set[uuid.UUID]) -> str:
        if not counted:
            return event.subject_ref or ""
        if len(linked) == 1 and (ref := refs.get(next(iter(linked)))):
            return ref
        n = len(linked) or len(ids)
        return f"{n} Ground Truth item{'' if n == 1 else 's'}"

    def said(linked: set[uuid.UUID]) -> str:
        subject = what(linked)
        many = bool(_SIZE.fullmatch(subject)) and not subject.startswith("1 ")
        return f"{subject} {verb.replace('was ', 'were ', 1) if many else verb}"

    id_list = list(ids)
    rows = await db.scalars(
        select(RoadmapItem).where(
            or_(
                RoadmapItem.feature_id.in_(id_list),
                RoadmapItem.requirement_ids.overlap(id_list),
                RoadmapItem.blocker_ids.overlap(id_list),
            ),
            RoadmapItem.roadmap_version_id.is_not(None),
        )
    )
    for item in rows:
        own = {item.feature_id, *(item.requirement_ids or []), *(item.blocker_ids or [])}
        found.setdefault(item.id, (item, said(ids & own)))
    # Items whose PRD section links a changed entity.
    links = (
        await db.execute(
            select(
                DocumentSectionLink.version_id,
                DocumentSectionLink.section_key,
                DocumentSectionLink.entity_id,
            ).where(
                DocumentSectionLink.entity_id.in_(id_list),
                DocumentSectionLink.version_id.is_not(None),
            )
        )
    ).all()
    if links:
        linked: dict[tuple, set[uuid.UUID]] = {}
        for v, k, e in links:
            linked.setdefault((v, k), set()).add(e)
        headings = {
            (v, k): h
            for v, k, h in (
                await db.execute(
                    select(Section.version_id, Section.section_key, Section.heading).where(
                        or_(
                            *(
                                and_(Section.version_id == v, Section.section_key == k)
                                for v, k in linked
                            )
                        )
                    )
                )
            ).all()
        }
        rows = await db.scalars(
            select(RoadmapItem).where(
                or_(
                    *(
                        and_(
                            RoadmapItem.prd_version_id == v,
                            RoadmapItem.prd_section_key == k,
                        )
                        for v, k in linked
                    )
                ),
                RoadmapItem.roadmap_version_id.is_not(None),
            )
        )
        for item in rows:
            own = linked.get((item.prd_version_id, item.prd_section_key), set())
            heading = headings.get((item.prd_version_id, item.prd_section_key))
            heading = heading or item.prd_section_key
            found.setdefault(
                item.id,
                (item, f"PRD section {heading} links {named(own)}, which changed"),
            )


async def mark_items(db: AsyncSession, event: ChangeEvent) -> None:
    """The ``roadmap.items`` change handler.

    A section change that is part of a version's change (``part_of_change_id``: the
    version import recorded both) is that change's: marked once, from the version, as
    ``trace.mark_stale`` does."""
    if event.subject_kind == "document_section" and (event.data or {}).get("part_of_change_id"):
        return
    found: dict[uuid.UUID, tuple[RoadmapItem, str]] = {}
    if event.subject_kind == "document_version" and event.subject_id is not None:
        document = await db.get(Document, event.document_id) if event.document_id else None
        if document is None:
            return
        if document.kind == "roadmap" and event.cause == "version_imported":
            version = await db.get(DocumentVersion, event.subject_id)
            if version is not None:
                await items_mod.on_roadmap_version(db, version, document)
            return
        if document.kind == "prd" and event.cause == "version_imported":
            await _by_prd_version(db, event, found)
    elif event.subject_kind == "document_section":
        await _by_section(db, event, found)
    elif event.subject_kind in ENTITY_SUBJECTS:
        await _by_entities(db, event, found)
    if not found:
        return
    now = datetime.now(UTC)
    for item, reason in found.values():
        _mark(item, event, reason, now)
    await db.flush()
    event.data = {
        **(event.data or {}),
        "roadmap": {
            "item_ids": [str(i) for i in found],
            "reasons": {str(i): r for i, (_, r) in found.items()},
        },
    }
    db.add(
        AuditEvent(
            actor="system",
            action="roadmap.items_marked_stale",
            entity="change_event",
            entity_id=event.id,
            data={"caused_by": event.actor, "items": len(found)},
        )
    )
    await db.flush()


# --- human actions --------------------------------------------------------------------------


def anchor(item: RoadmapItem) -> tuple[uuid.UUID | None, str | None]:
    """The PRD version and section hash the item is judged against: what a person last
    reconciled it with, else what it was built from."""
    if item.reconciled_version_id is not None:
        return item.reconciled_version_id, item.reconciled_section_hash
    return item.prd_version_id, item.prd_section_hash


async def _reconcile_anchor(db: AsyncSession, item: RoadmapItem) -> dict[str, Any]:
    """Record the PRD's latest approved version (and that section's hash) as what the
    item was reconciled against, when it is at least as recent as the item's anchor. The
    item's own trace (the version it was built from) is never rewritten."""
    version_id, section_hash = anchor(item)
    before = {
        "version_id": str(version_id) if version_id else None,
        "section_hash": section_hash,
    }
    if item.prd_document_id is None:
        return before
    latest = await db.scalar(
        select(DocumentVersion)
        .where(
            DocumentVersion.document_id == item.prd_document_id,
            DocumentVersion.approved_at.is_not(None),
        )
        .order_by(DocumentVersion.number.desc())
        .limit(1)
    )
    current = (
        await db.scalar(select(DocumentVersion.number).where(DocumentVersion.id == version_id))
        if version_id
        else None
    )
    if latest is None or (current is not None and latest.number < current):
        return before
    item.reconciled_version_id = latest.id
    item.reconciled_section_hash = None
    if item.prd_section_key:
        item.reconciled_section_hash = await db.scalar(
            select(Section.content_hash).where(
                Section.version_id == latest.id, Section.section_key == item.prd_section_key
            )
        )
    return before


# What a refusal says of the items' state, in plain words (the stale-marks walk: a second
# Review read "nothing to review: under_review").
STATE_WORDS = {
    "fresh": "up to date",
    "potentially_stale": "marked as possibly stale",
    "under_review": "already under review",
    "reconciled": "already marked still valid",
}
ACTION_WORDS = {"review": "review", "reconcile": "mark still valid"}


def refusal(action: str, items: list[RoadmapItem]) -> str:
    """Why nothing was done, in plain words: "Nothing to review: this item is already
    under review"."""
    states = sorted({i.freshness for i in items})
    if not states:
        return f"Nothing to {ACTION_WORDS.get(action, action)}: no such item"
    words = " or ".join(STATE_WORDS.get(s, s.replace("_", " ")) for s in states)
    subject = "this item is" if len(items) == 1 else "these items are"
    return f"Nothing to {ACTION_WORDS.get(action, action)}: {subject} {words}"


async def act(
    db: AsyncSession,
    principal: Principal,
    action: str,
    items: list[RoadmapItem],
    reason: str | None,
) -> list[dict[str, Any]]:
    """Review or reconcile items. The caller commits. Conflict when none is in a state
    the action applies to."""
    if action == "reconcile" and not (reason or "").strip():
        raise Invalid("reconciling needs a reason")
    targets = [i for i in items if i.freshness in FROM_STATES[action]]
    if not targets:
        raise Conflict(refusal(action, items))
    now = datetime.now(UTC)
    changed = []
    for item in targets:
        entry: dict[str, Any] = {"item": item.item_key, "id": str(item.id), "from": item.freshness}
        if action == "reconcile":
            entry["anchor_before"] = await _reconcile_anchor(db, item)
            item.freshness = "reconciled"
            item.reconciled_by = principal.id
            item.reconciled_at = now
        else:
            item.freshness = "under_review"
        if reason:
            item.note = reason
        entry["to"] = item.freshness
        changed.append(entry)
    await db.flush()
    await audit.record(
        db,
        principal,
        f"roadmap.items.{action}",
        "document",
        targets[0].roadmap_document_id,
        {"items": changed, "reason": reason},
    )
    await db.flush()
    return changed
