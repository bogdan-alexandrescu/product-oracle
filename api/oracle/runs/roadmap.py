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
checkpoint, a run's import, a person's import), which refuses, as an
:class:`ItemsYamlError` and never any other exception: YAML aliases and anchors
(``yaml.safe_load`` shares an alias's node, so a few hundred bytes can expand to
gigabytes once copied to JSON or text); explicit tags; numbers in any form but plain
decimal (YAML 1.1 base-60 ``1:1:1...`` is quadratic to build, and Python refuses
``int()`` of more than 4,300 digits), NaN and infinities; values longer than
``MAX_SCALAR_CHARS``, nesting deeper than ``MAX_DEPTH`` (a few hundred ``[`` overflow the
composer's recursion), more than ``MAX_NODES`` nodes, and a file larger than
``MAX_STORED_BYTES`` once parsed. Async callers use :func:`check_items_async`, which
parses in a worker thread, at most ``PARSE_SECONDS``: a bad file is a failed check, never
a stalled event loop or a tick exception.
"""

import asyncio
import json
import math
import re
from dataclasses import dataclass, field
from datetime import date, datetime
from typing import Any

import yaml

from oracle.roadmap.schedule import Basis, supporting

HORIZONS = ("now", "next", "later")
CONFIDENCES = ("high", "medium", "low")
REQUIRED = ("id", "title", "outcome", "horizon", "prd_section")
# Optional trace fields: a key, or a list of keys, of baseline entities.
KEY_LISTS = ("requirements", "blockers")

# Caps on a parsed roadmap_items.yaml (oracle.roadmap.items stores it as JSON).
MAX_NODES = 50_000
MAX_STORED_BYTES = 1_000_000
# Caps on the file before and while it is parsed (agent output; the artifact cap is 1 MB).
MAX_TEXT_CHARS = 1_000_000
MAX_SCALAR_CHARS = 20_000
MAX_DEPTH = 32
MAX_DIGITS = 30
# The parse and check run in a worker thread, never in the event loop, at most this long.
PARSE_SECONDS = 5.0

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


class _ItemsResolver(yaml.resolver.BaseResolver):
    """The implicit types roadmap_items.yaml may use, each cheap to build: null, the
    booleans, plain decimal integers and floats of a bounded length, ISO dates and
    timestamps, and the merge key. No YAML 1.1 base-60, octal, hex, binary or ``_``
    forms: those stay strings (``1:30`` is text)."""


_ItemsResolver.add_implicit_resolver(
    "tag:yaml.org,2002:bool",
    re.compile(r"^(?:yes|Yes|YES|no|No|NO|true|True|TRUE|false|False|FALSE|on|On|ON|off|Off|OFF)$"),
    list("yYnNtTfFoO"),
)
_ItemsResolver.add_implicit_resolver(
    "tag:yaml.org,2002:int", re.compile(r"^[-+]?(?:0|[1-9][0-9]{0,17})$"), list("-+0123456789")
)
_ItemsResolver.add_implicit_resolver(
    "tag:yaml.org,2002:float",
    re.compile(
        r"^(?:[-+]?(?:[0-9]{1,18}\.[0-9]{0,18}|\.[0-9]{1,18})(?:[eE][-+]?[0-9]{1,3})?"
        r"|[-+]?[0-9]{1,18}[eE][-+]?[0-9]{1,3}"
        r"|[-+]?\.(?:inf|Inf|INF)|\.(?:nan|NaN|NAN))$"
    ),
    list("-+0123456789."),
)
_ItemsResolver.add_implicit_resolver("tag:yaml.org,2002:merge", re.compile(r"^(?:<<)$"), ["<"])
_ItemsResolver.add_implicit_resolver(
    "tag:yaml.org,2002:null", re.compile(r"^(?:~|null|Null|NULL|)$"), ["~", "n", "N", ""]
)
_ItemsResolver.add_implicit_resolver(
    "tag:yaml.org,2002:timestamp",
    re.compile(
        r"^(?:[0-9]{4}-[0-9]{2}-[0-9]{2}"
        r"|[0-9]{4}-[0-9]{1,2}-[0-9]{1,2}(?:[Tt]|[ \t]+)[0-9]{1,2}:[0-9]{2}:[0-9]{2}"
        r"(?:\.[0-9]{0,9})?(?:[ \t]*(?:Z|[-+][0-9]{1,2}(?::[0-9]{2})?))?)$"
    ),
    list("0123456789"),
)

# A plain scalar that looks like a number but has more digits than any count or score.
_NUMBERISH = re.compile(r"[-+]?[0-9][0-9_:.,eE+-]*")


class _ItemsLoader(
    yaml.reader.Reader,
    yaml.scanner.Scanner,
    yaml.parser.Parser,
    yaml.composer.Composer,
    yaml.constructor.SafeConstructor,
    _ItemsResolver,
):
    """A safe loader without aliases, anchors or explicit tags, with the bounded
    implicit types above, a node budget, and caps on scalar length and nesting depth,
    all checked before a node is built."""

    def __init__(self, stream: str) -> None:
        yaml.reader.Reader.__init__(self, stream)
        yaml.scanner.Scanner.__init__(self)
        yaml.parser.Parser.__init__(self)
        yaml.composer.Composer.__init__(self)
        yaml.constructor.SafeConstructor.__init__(self)
        _ItemsResolver.__init__(self)
        self._nodes = 0
        self._depth = 0

    def compose_node(self, parent: Any, index: Any) -> Any:
        event = self.peek_event()
        where = f"{event.start_mark.line + 1}:{event.start_mark.column + 1}"
        if isinstance(event, yaml.AliasEvent) or getattr(event, "anchor", None):
            raise ItemsYamlError(
                "yaml_alias",
                f"roadmap_items.yaml uses a YAML anchor or alias ({where}); write each value "
                "out in full",
            )
        if getattr(event, "tag", None) not in (None, "!"):
            raise ItemsYamlError(
                "yaml_tag",
                f"roadmap_items.yaml uses the explicit YAML tag {event.tag} ({where}); write "
                "plain values",
            )
        self._nodes += 1
        if self._nodes > MAX_NODES:
            raise ItemsYamlError(
                "too_large", f"roadmap_items.yaml has more than {MAX_NODES} YAML nodes"
            )
        if isinstance(event, yaml.ScalarEvent):
            _check_scalar(event.value, plain=event.implicit[0], where=where)
            return super().compose_node(parent, index)
        nested = isinstance(event, yaml.SequenceStartEvent | yaml.MappingStartEvent)
        if nested:
            self._depth += 1
            if self._depth > MAX_DEPTH:
                raise ItemsYamlError(
                    "too_deep",
                    f"roadmap_items.yaml nests lists or mappings more than {MAX_DEPTH} "
                    f"levels deep ({where})",
                )
        try:
            return super().compose_node(parent, index)
        finally:
            if nested:
                self._depth -= 1


def _check_scalar(value: str, *, plain: bool, where: str) -> None:
    if len(value) > MAX_SCALAR_CHARS:
        raise ItemsYamlError(
            "too_large",
            f"roadmap_items.yaml has a value of {len(value)} characters ({where}), over "
            f"{MAX_SCALAR_CHARS}",
        )
    if plain and _NUMBERISH.fullmatch(value) and sum(c.isdigit() for c in value) > MAX_DIGITS:
        raise ItemsYamlError(
            "invalid_number",
            f"roadmap_items.yaml has a number with more than {MAX_DIGITS} digits ({where})",
        )


def _non_finite(data: Any, path: str = "") -> str | None:
    """The path of the first NaN or infinite number in ``data``, if any."""
    stack: list[tuple[Any, str]] = [(data, path)]
    while stack:
        value, at = stack.pop()
        if isinstance(value, float) and not math.isfinite(value):
            return at or "(top)"
        if isinstance(value, dict):
            stack.extend((v, f"{at}.{k}" if at else str(k)) for k, v in value.items())
        elif isinstance(value, list):
            stack.extend((v, f"{at}[{n}]") for n, v in enumerate(value))
    return None


def _parse(text: str) -> Any:
    if len(text) > MAX_TEXT_CHARS:
        raise ItemsYamlError(
            "too_large", f"roadmap_items.yaml is {len(text)} characters, over {MAX_TEXT_CHARS}"
        )
    # Before the YAML reader: an over-long unbroken token (the base-60 probe) is refused
    # in one linear pass instead of being scanned character by character.
    longest = max(map(len, text.split()), default=0)
    if longest > MAX_SCALAR_CHARS:
        raise ItemsYamlError(
            "too_large",
            f"roadmap_items.yaml has a value of {longest} characters, over {MAX_SCALAR_CHARS}",
        )
    loader = _ItemsLoader(text)
    try:
        return loader.get_single_data()
    finally:
        loader.dispose()


def load_items_yaml(text: str) -> Any:
    """Parse roadmap_items.yaml the one safe way (:class:`_ItemsLoader`): at most
    ``MAX_TEXT_CHARS`` characters, ``MAX_NODES`` nodes, ``MAX_DEPTH`` levels,
    ``MAX_SCALAR_CHARS`` per value and ``MAX_STORED_BYTES`` as JSON, finite numbers only.
    Raises :class:`ItemsYamlError` and nothing else: a YAML error, and any other failure
    to read the file (a recursion, a number Python will not convert, memory), is a
    refusal with its code."""
    try:
        data = _parse(text)
        bad = _non_finite(data)
        if bad is not None:
            raise ItemsYamlError(
                "non_finite_number",
                f"roadmap_items.yaml has NaN or an infinite number at {bad}; write a finite number",
            )
        size = len(json.dumps(data, default=str).encode())
        if size > MAX_STORED_BYTES:
            raise ItemsYamlError(
                "too_large",
                f"roadmap_items.yaml is {size} bytes once parsed, over {MAX_STORED_BYTES}",
            )
        return data
    except ItemsYamlError:
        raise
    except yaml.YAMLError as exc:
        raise ItemsYamlError(
            "invalid_yaml", f"roadmap_items.yaml is not valid YAML: {exc}"
        ) from exc
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
        return await asyncio.wait_for(
            asyncio.to_thread(check_items, text, **kwargs), timeout=PARSE_SECONDS
        )
    except TimeoutError:
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
