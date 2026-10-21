"""Roadmap from an approved PRD (O4b): ``roadmap_items.yaml`` checks and PRD links.

``roadmap_items.yaml`` is what the ``roadmap_items`` segment hands its checkpoint:

    version: 1
    prd: {document: checkout-redesign, version: 3}
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
"""

import json
import re
from dataclasses import dataclass, field
from datetime import date, datetime
from typing import Any

from oracle import safe_yaml
from oracle.roadmap.schedule import Basis, supporting

HORIZONS = ("now", "next", "later")
CONFIDENCES = ("high", "medium", "low")
REQUIRED = ("id", "title", "outcome", "horizon", "prd_section")
# Optional trace fields: a key, or a list of keys, of baseline entities.
KEY_LISTS = ("requirements", "blockers")

# A parsed roadmap_items.yaml is at most this large as JSON (oracle.roadmap.items stores it).
MAX_STORED_BYTES = 1_000_000
# The parse and check run on the parse pool, never in the event loop, at most this long.
PARSE_SECONDS = safe_yaml.PARSE_SECONDS

# A cross-document link to a document version's section, as the roadmap draft writes it
# (oracle.runs.flows.prd_link): /documents/<slug>/v/<n>#<section>.
DOC_LINK = re.compile(
    r"\]\((/documents/(?P<slug>[A-Za-z0-9][A-Za-z0-9_.-]*)/v/(?P<version>\d+)"
    r"(?:#(?P<section>[A-Za-z0-9][A-Za-z0-9_.:-]*))?)\)"
)


@dataclass
class ItemsCheck:
    items: list[dict[str, Any]] = field(default_factory=list)
    problems: list[dict[str, str]] = field(default_factory=list)

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
) -> ItemsCheck:
    """Parse and check ``roadmap_items.yaml`` against the source PRD version (and, with
    ``date_bases``, every date against the verified schedule bases)."""
    out = ItemsCheck()
    try:
        data = load_items_yaml(text)
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
    for n, item in enumerate(out.items):
        for dep in item["depends_on"]:
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
    return out


async def check_items_async(text: str, **kwargs: Any) -> ItemsCheck:
    """:func:`check_items` in a worker thread, at most ``PARSE_SECONDS``: the event loop
    (every company's requests and ticks) never waits on agent output. A check that takes
    longer, or fails in any way, is a problem, never an exception."""
    try:
        return await safe_yaml.run_parse_within(
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
