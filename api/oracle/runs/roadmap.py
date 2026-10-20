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

:func:`check_items` lists every problem at once, so a reviewer (or a re-run) can fix
the file in one pass. Order matters: an item comes after the items it depends on and is
never in an earlier horizon than them; a milestone carries a date only in Now and only
with the source of that date.
"""

import re
from dataclasses import dataclass, field
from datetime import date, datetime
from typing import Any

from oracle import safe_yaml

HORIZONS = ("now", "next", "later")
CONFIDENCES = ("high", "medium", "low")
REQUIRED = ("id", "title", "outcome", "horizon", "prd_section")

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
) -> ItemsCheck:
    """Parse and check ``roadmap_items.yaml`` against the source PRD version."""
    out = ItemsCheck()
    try:
        data = safe_yaml.load(text)
    except safe_yaml.SafeYamlError as exc:
        out.add("invalid_yaml", f"roadmap_items.yaml is not valid YAML: {exc}")
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
        _check_milestone(out, item_id, horizon, raw.get("milestone"))
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


def _check_milestone(out: ItemsCheck, item_id: str, horizon: str | None, milestone: Any) -> None:
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
