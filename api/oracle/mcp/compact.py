"""Compact forms of the heavy MCP reads, so a run's agent keeps its session small.

A PRD writer that read every entity with its body, a whole intake summary and whole
earlier files filled SwarmCloud's 200,000-token session and failed (Nov 6). These
shape what the curated tools return: chosen fields, filters and pages, with a way on
to the next page and to the full text when it is asked for.
"""

import json
from typing import Any

# list_entities: the fields an entity comes back with unless others are asked for.
ENTITY_FIELDS = ("id", "type", "key", "title", "status", "parent_id", "confidence")
ENTITY_LIMIT = 50
ENTITY_MAX_LIMIT = 200
# get_intake_summary: a summary up to SUMMARY_WHOLE bytes comes back whole; a larger one
# as an outline listing this many items of each section, cut to TEXT_CUT, except the
# sections the PRD writer must use whole (every work item is a requirement).
SUMMARY_WHOLE = 64_000
WHOLE_SECTIONS = frozenset({"work", "features", "goals"})
OUTLINE_ITEMS = 3
SECTION_LIMIT = 20
TEXT_CUT = 300
ITEM_CUT = 2_000
# get_run_output: characters per page.
TEXT_PAGE = 20_000


def _list(value: Any) -> list[str] | None:
    if value is None or value == "":
        return None
    if isinstance(value, str):
        return [v.strip() for v in value.split(",") if v.strip()]
    return [str(v) for v in value]


def _int(value: Any, default: int, low: int, high: int | None = None) -> int:
    try:
        n = int(value) if value is not None else default
    except (TypeError, ValueError):
        n = default
    n = max(low, n)
    return min(n, high) if high is not None else n


def entities_page(rows: list[dict[str, Any]], args: dict[str, Any]) -> dict[str, Any]:
    """One page of ``rows`` (list_entities' REST answer) filtered by ``args``: ids, keys,
    type (one or more), status, q (in key or title); ``fields`` chosen (id always), the
    body only when asked; ``limit`` and ``offset``."""
    ids, keys, types = _list(args.get("ids")), _list(args.get("keys")), _list(args.get("type"))
    status, q = args.get("status"), str(args.get("q") or "").strip().lower()
    picked = [
        r
        for r in rows
        # ids takes a scope row's entity_id or its key.
        if (ids is None or str(r.get("id")) in ids or r.get("key") in ids)
        and (keys is None or r.get("key") in keys)
        and (types is None or r.get("type") in types)
        and (not status or r.get("status") == status)
        and (not q or q in f"{r.get('key', '')} {r.get('title', '')}".lower())
    ]
    fields = _list(args.get("fields")) or list(ENTITY_FIELDS)
    if args.get("include_body") and "body" not in fields:
        fields.append("body")
    fields = ["id", *(f for f in fields if f != "id")]
    limit = _int(args.get("limit"), ENTITY_LIMIT, 1, ENTITY_MAX_LIMIT)
    offset = _int(args.get("offset"), 0, 0)
    page = picked[offset : offset + limit]
    end = offset + len(page)
    return {
        "entities": [{f: r.get(f) for f in fields if f in r} for r in page],
        "total": len(picked),
        "offset": offset,
        "next_offset": end if end < len(picked) else None,
    }


def _cut(value: Any, n: int) -> Any:
    """``value`` with every string longer than ``n`` cut, saying how long it was."""
    if isinstance(value, str):
        return value if len(value) <= n else value[:n] + f"… [{len(value)} characters]"
    if isinstance(value, list):
        return [_cut(v, n) for v in value]
    if isinstance(value, dict):
        return {k: _cut(v, n) for k, v in value.items()}
    return value


def summary_view(data: Any, section: str | None, offset: Any, limit: Any) -> dict[str, Any]:
    """An intake summary (no ``section``): whole up to :data:`SUMMARY_WHOLE` bytes, else
    an outline: its plain fields and :data:`WHOLE_SECTIONS` whole, each other list's count
    and first items, cut short. With ``section``, a page of that section (items of
    :data:`WHOLE_SECTIONS` whole, others with long texts cut to :data:`ITEM_CUT`)."""
    if not isinstance(data, dict):
        return {"result": _cut(data, ITEM_CUT)}
    if section is None:
        if len(json.dumps(data, default=str)) <= SUMMARY_WHOLE:
            return data
        out: dict[str, Any] = {}
        sections: dict[str, int] = {}
        for k, v in data.items():
            if k in WHOLE_SECTIONS:
                out[k] = v
            elif isinstance(v, list):
                sections[k] = len(v)
                out[k] = _cut(v[:OUTLINE_ITEMS], TEXT_CUT)
            elif isinstance(v, dict) and len(json.dumps(v, default=str)) > ITEM_CUT:
                sections[k] = len(v)
                out[k] = {kk: _cut(vv, TEXT_CUT) for kk, vv in list(v.items())[:OUTLINE_ITEMS]}
            else:
                out[k] = _cut(v, TEXT_CUT)
        out["sections"] = sections
        out["how_to_read"] = (
            "An outline: work, features and goals are whole; each other list shows its "
            "first items, long texts are cut. Read one section whole with section=<name>, "
            "a page at a time (offset, limit)."
        )
        return out
    if section not in data:
        return {"error": f"No section {section}; sections: {', '.join(data)}"}
    value = data[section]
    if not isinstance(value, list):
        return {section: _cut(value, ITEM_CUT)}
    limit_n = _int(limit, SECTION_LIMIT, 1, 100)
    start = _int(offset, 0, 0)
    page = value[start : start + limit_n]
    end = start + len(page)
    return {
        # Every work item is a requirement: the sections the writer must use come whole.
        section: page if section in WHOLE_SECTIONS else _cut(page, ITEM_CUT),
        "total": len(value),
        "offset": start,
        "next_offset": end if end < len(value) else None,
    }


def text_page(text: str, offset: Any, max_chars: Any) -> str:
    """A page of a long text: a header line saying which characters it holds and how to
    read on, then the page. A text that fits comes back as it is."""
    size = _int(max_chars, TEXT_PAGE, 1_000, 100_000)
    start = _int(offset, 0, 0)
    if start == 0 and len(text) <= size:
        return text
    page = text[start : start + size]
    end = start + len(page)
    more = (
        f"; call again with offset={end} for the rest (or save it to a file and grep it)"
        if end < len(text)
        else "; the end"
    )
    return f"[characters {start}-{end} of {len(text)}{more}]\n{page}"


# A search hit's item keeps these (not its acl or fetch bookkeeping); the snippet shows
# the text, get_source_item reads the whole item.
ITEM_FIELDS = (
    "id",
    "source_id",
    "source_kind",
    "kind",
    "title",
    "url",
    "author",
    "occurred_at",
    "source_updated_at",
    "version_id",
    "confidence",
)


def search_view(data: Any, *, full: bool) -> Any:
    """Search hits with their items cut to :data:`ITEM_FIELDS` (the snippet stays), unless
    ``full``."""
    if full or not isinstance(data, dict) or not isinstance(data.get("hits"), list):
        return data
    hits = []
    for hit in data["hits"]:
        if isinstance(hit, dict) and isinstance(hit.get("item"), dict):
            item = hit["item"]
            hit = {**hit, "item": {k: item[k] for k in ITEM_FIELDS if k in item}}
        hits.append(hit)
    return {**data, "hits": hits}
