"""Roadmap from an approved PRD (O4b): ``roadmap_items.yaml`` checks and PRD links.

``roadmap_items.yaml`` is what the ``roadmap_items`` segment hands its checkpoint:

    version: 1
    prd: {document: checkout-redesign, version: 3}
    # After a send-back with a review (D6): one answer per review entry.
    resolutions: [{id: bulk-import, action: change, status: declined, note: "..."}]
    items:
      - id: bulk-import
        title: Bulk import
        outcome: New accounts reach their first report on day one
        horizon: now                      # now | next | later (B2 horizons, O4)
        milestone: {name: Beta, date: 2026-11-30, date_source: ENG-412 estimate}
        depends_on: [csv-parser]
        priority: {score: 4.2, rank: 1, explanation: "G1 weight 3 x contribution 2 ..."}
        confidence: high                  # high | medium | low
        prd_section: features-bulk-import
        # Optional (CR-11): the baseline items it delivers and how it is validated.
        feature: bulk-import              # a feature key; else traced from the section
        requirements: [csv-columns]       # requirement keys
        blockers: [vendor-rate-limit]     # constraint (blocker) keys
        validation_gates: [{name: Pilot, criterion: "3 accounts import on day one"}]
        economics: {value: "...", cost: "...", effort: 3}

:func:`check_items` lists every problem at once, so a reviewer (or a re-run) can fix
the file in one pass. Order matters: an item comes after the items it depends on and is
never in an earlier horizon than them; a milestone carries a date only in Now and only
with the source of that date. When the caller passes the verified schedule bases of the
source PRD (``date_bases``, oracle.roadmap.schedule), that source must name a basis that
covers the item and supports exactly that date: a date with no verified estimate,
capacity or commitment behind it is refused (``unverified_date``).

The file is agent output. It is read by :func:`load_items_yaml` on every path (the run's
checkpoint, a run's import, a person's import), through the one safe loader
(:func:`oracle.safe_yaml.load`: no anchors, aliases, tags or duplicate keys, plain
decimal numbers only, ``yes``/``no`` stay strings, bounded size, depth and node count),
plus one cap of its own: at most ``MAX_STORED_BYTES`` once parsed (it is stored as JSON).
Every refusal is an :class:`ItemsYamlError`, never any other exception. Async callers use
:func:`check_items_async`, which checks on the parse pool
(:func:`oracle.safe_yaml.run_parse_within`), at most ``PARSE_SECONDS``: a bad file is a
failed check, never a stalled event loop or a tick exception.

A check is a pure function of the text and the inputs it is given, so
:func:`check_items_async` keeps its last checks by the text's hash and those inputs
(:class:`_Checks`, at most ``CHECKS_KEPT`` checks): the Inbox re-reads every pending
checkpoint's file on each call (D9) and a roadmap import re-checks its run's file, and a
file checked before with the same inputs is neither parsed again nor sent to the parse pool.
A check that timed out or could not read the file is not kept. Every other reader of a
run's file (the plan tables, oracle.runs.plan_tables; the shared queue with the run's items
in it, oracle.roadmap.company.with_run_items) reads it through :func:`parsed_items`, whose
parse is kept in the same cache by the text's hash: one step's check, prompt and plan table
check parse the file once, and clearing the cache forgets both.
"""

import copy
import hashlib
import json
import re
import threading
from collections import OrderedDict
from collections.abc import Collection, Hashable
from dataclasses import dataclass, field
from datetime import date, datetime
from typing import Any

from oracle import safe_yaml
from oracle.roadmap.schedule import Basis, supporting

HORIZONS = ("now", "next", "later")
CONFIDENCES = ("high", "medium", "low")
RESOLUTION_STATUSES = ("done", "declined")
REQUIRED = ("id", "title", "outcome", "horizon", "prd_section")
# Optional trace fields: a key, or a list of keys, of baseline entities.
KEY_LISTS = ("requirements", "blockers")

# A parsed roadmap_items.yaml is at most this large as JSON (oracle.roadmap.items stores it).
MAX_STORED_BYTES = 1_000_000
# The parse and check run on the parse pool, never in the event loop, at most this long.
PARSE_SECONDS = safe_yaml.PARSE_SECONDS
# The checks kept (_Checks): at most this many, least recently used dropped first.
CHECKS_KEPT = 256

# A cross-document link to a document version's section, as the roadmap draft writes it
# (oracle.runs.flows.prd_link): /documents/<slug>/v/<n>#<section>.
DOC_LINK = re.compile(
    r"\]\((/documents/(?P<slug>[A-Za-z0-9][A-Za-z0-9_.-]*)/v/(?P<version>\d+)"
    r"(?:#(?P<section>[A-Za-z0-9][A-Za-z0-9_.:-]*))?)\)"
)


@dataclass(frozen=True)
class Elsewhere:
    """A feature or item of another PRD on the company roadmap an item may depend on (the
    owner, Nov 4), as oracle.roadmap.company.other_prds reads it: its key, its name with its
    PRD ("Account health ledger (Safety PRD)"), its horizon (an item's; None for a feature
    with no item yet) and the keys it depends on."""

    key: str
    label: str
    horizon: str | None = None
    depends_on: tuple[str, ...] = ()


@dataclass
class ItemsCheck:
    items: list[dict[str, Any]] = field(default_factory=list)
    problems: list[dict[str, str]] = field(default_factory=list)
    # D6: the agents' answers to a send-back's review entries, as validated.
    resolutions: list[dict[str, Any]] = field(default_factory=list)

    @property
    def ok(self) -> bool:
        return not self.problems

    def add(self, code: str, message: str, item: str | None = None) -> None:
        self.problems.append({"code": code, "message": message, **({"item": item} if item else {})})

    def as_json(self) -> dict[str, Any]:
        counts = {h: sum(1 for i in self.items if i.get("horizon") == h) for h in HORIZONS}
        return {"items": len(self.items), "by_horizon": counts, "problems": self.problems}


class ItemsYamlError(ValueError):
    """roadmap_items.yaml was refused before it was expanded: ``code`` names why."""

    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code


def _parse(text: str) -> Any:
    try:
        return safe_yaml.load(text)
    except safe_yaml.SafeYamlError as exc:
        raise ItemsYamlError(exc.code, f"roadmap_items.yaml is refused: {exc}") from exc


def load_items_yaml(text: str) -> Any:
    """Parse roadmap_items.yaml the one safe way (:func:`oracle.safe_yaml.load`), at most
    ``MAX_STORED_BYTES`` as JSON. Raises
    :class:`ItemsYamlError` and nothing else: a YAML error, and any other failure to read
    the file (a recursion, a number Python will not convert, memory), is a refusal with
    its code."""
    try:
        data = _parse(text)
        size = len(json.dumps(data, default=str).encode())
        if size > MAX_STORED_BYTES:
            raise ItemsYamlError(
                "too_large",
                f"roadmap_items.yaml is {size} bytes once parsed, over {MAX_STORED_BYTES}",
            )
        return data
    except ItemsYamlError:
        raise
    except Exception as exc:  # noqa: BLE001 - agent output: every failure is a refusal
        raise ItemsYamlError(
            "unreadable_yaml",
            f"roadmap_items.yaml could not be read ({type(exc).__name__}: {str(exc)[:200]})",
        ) from exc


def _text(value: Any) -> str | None:
    if value is None:
        return None
    return value.strip() if isinstance(value, str) else str(value)


def check_items(
    text: str,
    *,
    prd_slug: str | None = None,
    prd_version: int | None = None,
    prd_sections: set[str] | None = None,
    date_bases: list[Basis] | None = None,
    elsewhere: Collection[str | Elsewhere] | None = None,
    prd_name: str | None = None,
) -> ItemsCheck:
    """Parse and check ``roadmap_items.yaml`` against the source PRD version (and, with
    ``date_bases``, every date against the verified schedule bases). ``elsewhere``: other
    PRDs' features and items on the company roadmap, which an item may depend on (the owner,
    Nov 4; a bare key has no horizon and no dependencies), checked for the horizon and for a
    cycle through them; ``prd_name`` names this PRD in a cycle ("Scale PRD")."""
    out = ItemsCheck()
    try:
        data = parsed_items(text)
    except ItemsYamlError as exc:
        out.add(exc.code, str(exc))
        return out
    if not isinstance(data, dict):
        out.add("invalid_shape", "roadmap_items.yaml must be a mapping with an items list")
        return out
    prd = data.get("prd")
    if isinstance(prd, dict):
        if prd_slug and prd.get("document") not in (None, prd_slug):
            out.add("wrong_prd", f"prd.document is {prd.get('document')!r}, not {prd_slug!r}")
        if prd_version and prd.get("version") not in (None, prd_version):
            out.add("wrong_prd", f"prd.version is {prd.get('version')!r}, not {prd_version}")
    _check_resolutions(out, data)
    items = data.get("items")
    if not isinstance(items, list) or not items:
        out.add("no_items", "roadmap_items.yaml lists no items")
        return out

    seen: dict[str, int] = {}
    for n, raw in enumerate(items, start=1):
        if not isinstance(raw, dict):
            out.add("invalid_item", f"item {n} is not a mapping")
            continue
        item_id = _text(raw.get("id")) or f"#{n}"
        missing = [k for k in REQUIRED if not _text(raw.get(k))]
        if missing:
            out.add("missing_field", f"item {item_id} lacks {', '.join(missing)}", item_id)
        if item_id in seen:
            out.add("duplicate_id", f"item id {item_id} is used twice", item_id)
        seen[item_id] = n
        horizon = _text(raw.get("horizon"))
        if horizon and horizon not in HORIZONS:
            out.add(
                "invalid_horizon",
                f"item {item_id}: horizon {horizon!r} is not now, next or later",
                item_id,
            )
        confidence = raw.get("confidence")
        if confidence is not None and not (
            confidence in CONFIDENCES
            or (isinstance(confidence, int | float) and 0 <= confidence <= 1)
        ):
            out.add(
                "invalid_confidence",
                f"item {item_id}: confidence {confidence!r} is not high, medium, low or 0-1",
                item_id,
            )
        priority = raw.get("priority")
        if priority is not None:
            if not isinstance(priority, dict):
                out.add(
                    "invalid_priority",
                    f"item {item_id}: priority must be a mapping (score, rank, explanation)",
                    item_id,
                )
            elif priority.get("score") is not None and not _text(priority.get("explanation")):
                out.add(
                    "unexplained_priority",
                    f"item {item_id}: a priority score needs its explanation",
                    item_id,
                )
        _check_milestone(out, item_id, horizon, raw.get("milestone"), date_bases)
        _check_trace_fields(out, item_id, raw)
        section = _text(raw.get("prd_section"))
        if section and prd_sections is not None and section not in prd_sections:
            out.add(
                "unknown_prd_section",
                f"item {item_id}: PRD section {section!r} is not in the PRD version",
                item_id,
            )
        deps = raw.get("depends_on") or []
        if not isinstance(deps, list):
            out.add("invalid_depends_on", f"item {item_id}: depends_on must be a list", item_id)
            deps = []
        out.items.append({**raw, "id": item_id, "depends_on": [str(d) for d in deps]})

    # Dependencies: known ids, listed earlier, never in a later horizon than the item.
    index = {i["id"]: n for n, i in enumerate(out.items)}
    others = {
        e.key: e
        for e in (x if isinstance(x, Elsewhere) else Elsewhere(x, x) for x in elsewhere or ())
    }
    for n, item in enumerate(out.items):
        for dep in item["depends_on"]:
            if dep not in index and dep in others:
                # Another PRD's, on the company roadmap: the queue orders by it.
                _check_other(out, item, others[dep])
                continue
            if dep not in index:
                out.add(
                    "unknown_dependency",
                    f"item {item['id']} depends on unknown item {dep}",
                    item["id"],
                )
                continue
            if index[dep] > n:
                out.add(
                    "order_breaks_dependency",
                    f"item {item['id']} is listed before {dep}, which it depends on",
                    item["id"],
                )
            mine, theirs = item.get("horizon"), out.items[index[dep]].get("horizon")
            if (
                mine in HORIZONS
                and theirs in HORIZONS
                and (HORIZONS.index(theirs) > HORIZONS.index(mine))
            ):
                out.add(
                    "horizon_breaks_dependency",
                    f"item {item['id']} is in {mine} but depends on {dep} in {theirs}",
                    item["id"],
                )
    _check_cycles(out, index, others, prd_name)
    _check_slices(out)
    return out


def _check_other(out: ItemsCheck, item: dict[str, Any], other: Elsewhere) -> None:
    """An item never in an earlier horizon than another PRD's item it waits on."""
    mine, theirs = item.get("horizon"), other.horizon
    if mine in HORIZONS and theirs in HORIZONS and HORIZONS.index(theirs) > HORIZONS.index(mine):
        title = _text(item.get("title")) or item["id"]
        out.add(
            "horizon_breaks_dependency",
            f"{title} is in {str(mine).capitalize()} but waits on {other.label} in "
            f"{str(theirs).capitalize()}",
            item["id"],
        )


def _check_cycles(
    out: ItemsCheck,
    index: dict[str, int],
    others: dict[str, Elsewhere],
    prd_name: str | None,
) -> None:
    """``dependency_cycle`` for each item that waits, through another PRD's feature or item,
    on itself (this PRD's items wait on each other in list order, checked above): it and the
    other PRD's feature are named, each with its PRD."""
    if not others:
        return
    # An item is named by its id, or by its feature's key.
    mine: dict[str, str] = {}
    for i in out.items:
        mine.setdefault(i["id"], i["id"])
        if feature := _text(i.get("feature")):
            mine.setdefault(feature, i["id"])

    def deps(node: str) -> list[str]:
        if node in index:
            return out.items[index[node]]["depends_on"]
        return list(others[node].depends_on) if node in others else []

    for item in out.items:
        start = item["id"]
        for first in item["depends_on"]:
            if first in index or first not in others:
                continue
            seen: set[str] = set()
            stack = [first]
            found = False
            while stack and not found:
                node = stack.pop()
                if node in seen:
                    continue
                seen.add(node)
                for d in deps(node):
                    d = d if d in index else mine.get(d, d)
                    if d == start:
                        found = True
                        break
                    stack.append(d)
            if found:
                title = _text(item.get("title")) or start
                out.add(
                    "dependency_cycle",
                    f"{title} ({prd_name or 'this PRD'}) and {others[first].label} wait on "
                    "each other",
                    start,
                )
                break


def _names(text: str, item: dict[str, Any]) -> bool:
    """``text`` names the item: its id or its title, as whole words."""
    names = {str(item["id"]), _text(item.get("title")) or ""} - {""}
    return any(re.search(rf"(?<![\w-]){re.escape(n)}(?![\w-])", text, re.I) for n in names)


def later_slices(items: list[dict[str, Any]]) -> list[tuple[str, str, str, str]]:
    """roadmap-draft-wording review: (item, dependency, slice, feature) for each item that
    waits on a later slice of a feature than the slice its estimate (the milestone's name
    and date_source) names. A feature's slices are the items sharing its ``feature``, in
    list order."""
    index = {i["id"]: n for n, i in enumerate(items)}
    slices: dict[str, list[str]] = {}
    for i in items:
        if feature := _text(i.get("feature")):
            slices.setdefault(feature, []).append(i["id"])
    out: list[tuple[str, str, str, str]] = []
    for item in items:
        milestone = item.get("milestone")
        if not isinstance(milestone, dict):
            continue
        estimate = " ".join(
            t for t in (_text(milestone.get("name")), _text(milestone.get("date_source"))) if t
        )
        for dep in item.get("depends_on") or []:
            feature = _text(items[index[dep]].get("feature")) if dep in index else None
            group = slices.get(feature or "", [])
            if len(group) < 2 or _names(estimate, items[index[dep]]):
                continue
            earlier = [s for s in group[: group.index(dep)] if _names(estimate, items[index[s]])]
            if earlier and feature:
                out.append((item["id"], dep, earlier[0], feature))
    return out


def _check_slices(out: ItemsCheck) -> None:
    for item, dep, named, feature in later_slices(out.items):
        out.add(
            "later_slice",
            f"item {item} waits on {dep}, a later slice of {feature} than the {named} slice "
            f"its estimate names: wait on {named}",
            item,
        )


class _Checks:
    """The last checks (or parses) of roadmap_items.yaml, by the SHA-256 of the text and the
    check's inputs, least recently used dropped first. Each caller gets its own copy, so no caller
    sees another's changes."""

    def __init__(self, keep: int) -> None:
        self.keep = keep
        self._lock = threading.Lock()
        self._kept: OrderedDict[Hashable, Any] = OrderedDict()

    def __len__(self) -> int:
        return len(self._kept)

    @staticmethod
    def key(text: str, kwargs: dict[str, Any]) -> Hashable:
        digest = hashlib.sha256(text.encode("utf-8", "surrogatepass")).digest()
        inputs = []
        for name, value in sorted(kwargs.items()):
            if isinstance(value, set | frozenset):
                value = ("set", frozenset(value))
            elif isinstance(value, list):
                value = ("list", tuple(value))
            inputs.append((name, value))
        return digest, tuple(inputs)

    def get(self, key: Hashable) -> Any:
        with self._lock:
            found = self._kept.get(key)
            if found is None:
                return None
            self._kept.move_to_end(key)
        return copy.deepcopy(found)

    def put(self, key: Hashable, check: Any) -> None:
        check = copy.deepcopy(check)
        with self._lock:
            self._kept.pop(key, None)
            self._kept[key] = check
            while len(self._kept) > self.keep:
                self._kept.popitem(last=False)

    def clear(self) -> None:
        with self._lock:
            self._kept.clear()


_checks = _Checks(CHECKS_KEPT)


def parsed_items(text: str) -> Any:
    """:func:`load_items_yaml` once per text: a text parsed before (by a check, a prompt's or
    a draft's plan tables, the shared queue) is returned as it was parsed, or refused as it
    was, each caller getting its own copy. Kept in :data:`_checks`, the one cache, under the
    text's hash and an input no check takes; a file that could not be read is not kept (it
    may read next time)."""
    key = _Checks.key(text, {"parsed": True})
    kept = _checks.get(key)
    if kept is None:
        try:
            kept = ("parsed", load_items_yaml(text))
        except ItemsYamlError as exc:
            kept = ("refused", exc.code, str(exc))
        if kept[0] == "parsed" or kept[1] != "unreadable_yaml":
            _checks.put(key, kept)
    if kept[0] == "refused":
        raise ItemsYamlError(kept[1], kept[2])
    return kept[1]


async def check_items_async(text: str, **kwargs: Any) -> ItemsCheck:
    """:func:`check_items` in a worker thread, at most ``PARSE_SECONDS``: the event loop
    (every company's requests and ticks) never waits on agent output. A check that takes
    longer, or fails in any way, is a problem, never an exception. A check made before with
    the same text and inputs is returned as it was (:class:`_Checks`)."""
    try:
        key = _Checks.key(text, kwargs)
        hash(key)
    except TypeError:  # an input that can not be a key: checked, not kept
        key = None
    if key is not None and (kept := _checks.get(key)) is not None:
        return kept
    try:
        check = await safe_yaml.run_parse_within(
            check_items, text, name="roadmap_items.yaml", seconds=PARSE_SECONDS, **kwargs
        )
    except safe_yaml.ParseBusy:
        raise  # no worker for it: the caller gives up for now and retries
    except safe_yaml.ParseTimeout:
        out = ItemsCheck()
        out.add(
            "too_slow",
            f"roadmap_items.yaml took more than {PARSE_SECONDS:g} s to read; keep it small "
            "and plain",
        )
        return out
    except Exception as exc:  # noqa: BLE001 - agent output: every failure is a problem
        out = ItemsCheck()
        name = type(exc).__name__
        out.add("unreadable_yaml", f"roadmap_items.yaml could not be checked ({name})")
        return out
    # A file that could not be read may read next time (memory): not kept.
    if key is not None and not any(p["code"] == "unreadable_yaml" for p in check.problems):
        _checks.put(key, check)
    return check


def _check_resolutions(out: ItemsCheck, data: dict[str, Any]) -> None:
    """D6: ``resolutions`` (optional) is a list of mappings with an ``id`` and a ``status``
    of done or declined; anything else is a problem of the whole file, never ignored."""
    value = data.get("resolutions")
    if value is None:
        return
    if not isinstance(value, list) or not all(
        isinstance(r, dict) and _text(r.get("id")) and r.get("status") in RESOLUTION_STATUSES
        for r in value
    ):
        out.add(
            "invalid_resolutions",
            "resolutions must be a list of mappings, each with an id and a status of done or "
            "declined",
        )
        return
    out.resolutions = [
        {
            "id": _text(r["id"]),
            "action": _text(r.get("action")),
            "status": r["status"],
            "note": _text(r.get("note")),
        }
        for r in value
    ]


def _check_trace_fields(out: ItemsCheck, item_id: str, raw: dict[str, Any]) -> None:
    feature = raw.get("feature")
    if feature is not None and not isinstance(feature, str):
        out.add("invalid_feature", f"item {item_id}: feature must be a feature key", item_id)
    for name in KEY_LISTS:
        value = raw.get(name)
        if value is not None and not (
            isinstance(value, list) and all(isinstance(v, str) for v in value)
        ):
            out.add("invalid_" + name, f"item {item_id}: {name} must be a list of keys", item_id)
    gates = raw.get("validation_gates")
    if gates is not None and not (
        isinstance(gates, list) and all(isinstance(g, dict) and _text(g.get("name")) for g in gates)
    ):
        out.add(
            "invalid_validation_gates",
            f"item {item_id}: validation_gates must be a list of mappings with a name",
            item_id,
        )
    economics = raw.get("economics")
    if economics is not None and not isinstance(economics, dict):
        out.add("invalid_economics", f"item {item_id}: economics must be a mapping", item_id)


def _check_milestone(
    out: ItemsCheck,
    item_id: str,
    horizon: str | None,
    milestone: Any,
    date_bases: list[Basis] | None = None,
) -> None:
    if milestone is None or isinstance(milestone, str):
        return
    if not isinstance(milestone, dict):
        out.add(
            "invalid_milestone", f"item {item_id}: milestone must be a name or a mapping", item_id
        )
        return
    when = milestone.get("date")
    if when is None:
        return
    if horizon != "now":
        out.add(
            "date_outside_now",
            f"item {item_id}: dated milestones belong only in now (this item is in {horizon})",
            item_id,
        )
    if not _text(milestone.get("date_source")):
        out.add(
            "undated_source",
            f"item {item_id}: the milestone date needs the source that gives it (date_source)",
            item_id,
        )
    if not isinstance(when, date | datetime):
        try:
            date.fromisoformat(str(when))
        except ValueError:
            out.add(
                "invalid_date",
                f"item {item_id}: milestone date {when!r} is not YYYY-MM-DD",
                item_id,
            )
            return
    source = _text(milestone.get("date_source"))
    if date_bases is not None and source and not supporting(when, source, date_bases, item_id):
        out.add(
            "unverified_date",
            f"item {item_id}: no verified estimate, capacity or commitment of this PRD (for "
            f"this item) named in date_source ({source!r}) supports {when}; drop the date "
            "or record the basis",
            item_id,
        )


def doc_links(markdown: str) -> list[dict[str, Any]]:
    """Every cross-document link in a draft: path, slug, version and section."""
    return [
        {
            "href": m.group(1),
            "slug": m["slug"],
            "version": int(m["version"]),
            "section": m["section"],
        }
        for m in DOC_LINK.finditer(markdown)
    ]
