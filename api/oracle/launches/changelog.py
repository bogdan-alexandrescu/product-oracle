"""The changelog for people (Keep a Changelog [65]): newest first, dated, grouped as
Added, Changed, Deprecated, Removed, Fixed, Security.

Internal entries are seen by every member; public ones need an approver's Publish.
Oracle never publishes a public entry (ceiling L1). It publishes internal entries of a
launch itself only when the company lets it act within limits on launches (H11
Autonomy, ``launches``), at Mark launched. Public entries leave Oracle only as an export
(Markdown or HTML) that a person posts; Oracle posts nothing outside and serves no
public page.
"""

import html
import re
from collections.abc import Iterable
from dataclasses import dataclass
from datetime import date

from oracle.launches.models import CHANGELOG_CATEGORIES

HEADINGS = {c: c.capitalize() for c in CHANGELOG_CATEGORIES}


@dataclass(frozen=True)
class ExportEntry:
    category: str
    audience: str
    title: str
    body: str
    released_on: date


def _one_line(text: str) -> str:
    return re.sub(r"\s+", " ", text or "").strip()


def grouped(
    entries: Iterable[ExportEntry],
) -> list[tuple[date, list[tuple[str, list[ExportEntry]]]]]:
    """[(day, [(category, entries)])], newest day first, categories in their order."""
    days: dict[date, dict[str, list[ExportEntry]]] = {}
    for e in entries:
        days.setdefault(e.released_on, {}).setdefault(e.category, []).append(e)
    return [
        (day, [(c, days[day][c]) for c in CHANGELOG_CATEGORIES if c in days[day]])
        for day in sorted(days, reverse=True)
    ]


def render_markdown(entries: Iterable[ExportEntry]) -> str:
    lines = ["# Changelog"]
    for day, groups in grouped(entries):
        lines += ["", f"## {day.isoformat()}"]
        for category, rows in groups:
            lines += ["", f"### {HEADINGS[category]}", ""]
            for e in rows:
                body = _one_line(e.body)
                title = _one_line(e.title)
                lines.append(f"- **{title}**: {body}" if body else f"- **{title}**")
    return "\n".join(lines) + "\n"


def render_html(entries: Iterable[ExportEntry]) -> str:
    out = ['<section class="changelog">', "<h1>Changelog</h1>"]
    for day, groups in grouped(entries):
        out.append(f"<h2>{day.isoformat()}</h2>")
        for category, rows in groups:
            out.append(f"<h3>{HEADINGS[category]}</h3>")
            out.append("<ul>")
            for e in rows:
                title = html.escape(_one_line(e.title))
                body = html.escape(_one_line(e.body))
                item = f"<strong>{title}</strong>" + (f": {body}" if body else "")
                out.append(f"<li>{item}</li>")
            out.append("</ul>")
    out.append("</section>")
    return "\n".join(out) + "\n"
