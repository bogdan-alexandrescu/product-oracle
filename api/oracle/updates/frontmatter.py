"""An update's front matter and import checks (H8).

- the brief layer opens on the numbers: ``{#metrics}`` is an investor update's first brief
  section, and a board update's ``{#goals}`` comes before its ``{#timeline}``; otherwise
  the draft is refused ("Metrics come first");
- ``period: {from, to}`` is required;
- a figure in ``{#metrics}`` or ``{#goals}`` that no row of Sources and data points
  carries is an ``uncited_figure`` warning (the citation contract);
- Asks text from a run that is not the template's placeholder is an
  ``asks_written_by_oracle`` warning naming the section: Oracle never writes asks.
"""

import re
from datetime import date
from typing import Any

from oracle.docs import layers
from oracle.docs.parser import DraftError, ParsedSection
from oracle.docs.schemas import ImportProblem, VersionWarning

INVESTOR = "investor-update"
BOARD = "board-product"
METRICS_FIRST = "Metrics come first"
FIGURE_SECTIONS = ("metrics", "goals")
ASKS_KEY = "asks"
# What the built-in templates write in Asks; a company template's own text is read from
# its body (:func:`placeholder_of`).
ASKS_PLACEHOLDER = {
    INVESTOR: "Owner to fill: what you need from investors this month (intros, hires, "
    "customers).",
    BOARD: "Owner to fill: the decisions you need from the board this meeting.",
}

# A number as a reader sees it: 1,200 / 42% / 3.5 / $12k. Dates (2026-10-01) are not
# figures.
_DATE = re.compile(r"\b\d{4}-\d{2}-\d{2}\b")
_FIGURE = re.compile(r"(?<![\w.])\d+(?:,\d{3})*(?:\.\d+)?")


def parse_period(value: Any) -> tuple[date, date] | None:
    """``{from, to}`` as two dates, else None."""
    if not isinstance(value, dict):
        return None
    out = []
    for key in ("from", "to"):
        v = value.get(key)
        if isinstance(v, str):
            try:
                v = date.fromisoformat(v)
            except ValueError:
                return None
        if not isinstance(v, date):
            return None
        out.append(v)
    return out[0], out[1]


def template_of(front_matter: dict[str, Any], document_template: str | None) -> str | None:
    named = front_matter.get("template")
    return named if isinstance(named, str) and named else document_template


def _plain(text: str) -> str:
    return " ".join(layers.strip_comments(text or "").split())


def figures(text: str) -> list[str]:
    """The figures a section body writes (commas dropped), dates left out."""
    body = _DATE.sub(" ", layers.strip_comments(text or ""))
    return [m.group(0).replace(",", "") for m in _FIGURE.finditer(body)]


def placeholder_of(template_body: str | None, template: str | None) -> str | None:
    """The Asks placeholder of the update's template: its body's Asks text, else the
    built-in's."""
    if template_body:
        from oracle.docs.parser import _parse_sections, split_front_matter

        _, rest, offset = split_front_matter(template_body.replace("\r\n", "\n"))
        for s in _parse_sections(rest, offset, []):
            if s.section_key == ASKS_KEY and _plain(s.body_md):
                return _plain(s.body_md)
    return ASKS_PLACEHOLDER.get(template or "")


def check_import(
    front_matter: dict[str, Any],
    sections: list[ParsedSection],
    brief: list[str],
    *,
    template: str | None,
    template_body: str | None,
    from_run: bool,
) -> list[VersionWarning]:
    """Refuse (DraftError) an update whose numbers do not come first or that has no
    period; return its warnings otherwise."""
    keys = [s.section_key for s in sections]
    problems: list[ImportProblem] = []
    investor = template == INVESTOR or (template != BOARD and "metrics" in keys)
    board = template == BOARD or (not investor and "goals" in keys)
    if investor and (not brief or brief[0] != "metrics"):
        problems.append(
            ImportProblem(
                code="metrics_not_first",
                message=f"{METRICS_FIRST}: Metrics ({{#metrics}}) must be the first brief "
                "section of an investor update",
                section_key="metrics",
            )
        )
    if board and (
        "goals" not in keys
        or "timeline" not in keys
        or keys.index("goals") > keys.index("timeline")
    ):
        problems.append(
            ImportProblem(
                code="metrics_not_first",
                message=f"{METRICS_FIRST}: Goals ({{#goals}}) must come before Timeline "
                "({#timeline}) in a board update",
                section_key="goals",
            )
        )
    period = front_matter.get("period")
    if period is None:
        problems.append(
            ImportProblem(
                code="missing_period",
                message="an update needs period: {from: YYYY-MM-DD, to: YYYY-MM-DD} in its "
                "front matter",
            )
        )
    else:
        parsed = parse_period(period)
        if parsed is None or parsed[0] > parsed[1]:
            problems.append(
                ImportProblem(
                    code="invalid_period",
                    message="period must be {from: YYYY-MM-DD, to: YYYY-MM-DD} with from on "
                    "or before to",
                )
            )
    if problems:
        raise DraftError(problems)

    warnings: list[VersionWarning] = []
    refs = [layers.SectionRef(s.section_key, s.level) for s in sections]
    in_sources = set(layers.subtree(refs, layers.SOURCES_SECTION_ID))
    cited = {f for s in sections if s.section_key in in_sources for f in figures(s.body_md)}
    for s in sections:
        if s.section_key not in FIGURE_SECTIONS:
            continue
        missing = list(dict.fromkeys(f for f in figures(s.body_md) if f not in cited))
        if missing:
            warnings.append(
                VersionWarning(
                    code="uncited_figure",
                    message=f"{s.section_key}: {', '.join(missing)} "
                    f"{'has' if len(missing) == 1 else 'have'} no data point row in Sources "
                    "and data points; every number cites",
                    section_keys=[s.section_key],
                )
            )
    if from_run:
        asks = next((s for s in sections if s.section_key == ASKS_KEY), None)
        placeholder = placeholder_of(template_body, template)
        if asks is not None and _plain(asks.body_md) != (placeholder or ""):
            warnings.append(
                VersionWarning(
                    code="asks_written_by_oracle",
                    message="asks: Oracle wrote the Asks section; Oracle never writes asks. "
                    "Check it, or put the placeholder back for the owner to fill",
                    section_keys=[ASKS_KEY],
                )
            )
    return warnings
