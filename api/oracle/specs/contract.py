"""The engineering spec's sections, and how Oracle composes a spec version (§11.1).

A spec is an Oracle document of kind ``spec`` with a brief layer (the technical brief) and
a full layer (the engineering spec). Every section belongs to one **part**:

- ``product_requirement``: decided in the approved PRD. Oracle writes these sections
  itself from the request's requirement ids, the baseline and the PRD version, so an agent
  cannot restate or change a requirement.
- ``engineering_approach``: proposed by the agents; not decided until an engineering
  approver approves the spec version.
- ``open_decision``: engineering decisions still open.
- ``assumption``: what the approach assumes. Without a code capability map, the approach
  rests on these, and the spec says so.
- ``context``: the summary and Sources and data points.
- ``proposed``: a section the template does not have, added by an edit (E1, owner,
  2026-10-20): always shown as Proposed, never decided, whatever its title or key.

The agents write ``spec.md`` with a ``{#id}`` on every section heading they write.
:func:`compose` checks it (every problem at once) and builds the version Oracle imports:
front matter (Oracle's), the product requirement sections (Oracle's), the agents'
sections in contract order with a "proposed" label on each engineering approach section,
and Sources and data points (Oracle's provenance). Pure functions, no database.
"""

import html
import json
import re
import unicodedata
from collections.abc import Collection
from dataclasses import dataclass, field
from datetime import datetime
from typing import Any, Literal

import yaml
from markdown_it import MarkdownIt

from oracle.docs import layers
from oracle.docs.parser import (
    CITATION_STRIP_RE,
    DraftError,
    ParsedDraft,
    parse_draft,
    prepared,
    split_front_matter,
)
from oracle.docs.schemas import ImportProblem
from oracle.runs.flows import prd_link
from oracle.specs.confusables import CONFUSABLES

Part = Literal[
    "context",
    "product_requirement",
    "engineering_approach",
    "open_decision",
    "assumption",
    "proposed",
]
Depth = Literal["brief", "full"]
DEPTHS: tuple[str, ...] = ("brief", "full")

# Limits on what the agents hand back.
MAX_SPEC_BYTES = 200_000
MAX_SECTION_CHARS = 20_000

TITLE_ID = "spec"
FULL_ID = "full"


@dataclass(frozen=True)
class SpecSection:
    key: str
    title: str
    part: Part
    # In the brief layer (the technical brief); otherwise under "Full version".
    brief: bool
    # Depths that need the section: a tech brief ("brief") or a full spec ("full").
    depths: tuple[str, ...]
    # "oracle": composed by Oracle from the PRD and the baseline; "agent": the run writes it.
    written_by: Literal["oracle", "agent"] = "agent"
    guidance: str = ""


BOTH = ("brief", "full")
FULL = ("full",)

SECTIONS: tuple[SpecSection, ...] = (
    SpecSection("summary", "Summary", "context", True, BOTH,
                guidance="What this feature does for whom, and what engineering builds, in "
                "plain language."),
    SpecSection("requirements", "Product requirements", "product_requirement", True, BOTH,
                written_by="oracle"),
    SpecSection("approach", "Proposed engineering approach", "engineering_approach", True, BOTH,
                guidance="The approach in a few paragraphs: components, the main choices and "
                "the alternatives you rejected, with why."),
    SpecSection("open-decisions", "Open engineering decisions", "open_decision", True, BOTH,
                guidance="Each decision engineering still has to make: the options, who "
                "decides, and what it blocks."),
    SpecSection("acceptance-criteria", "Acceptance criteria", "product_requirement", False, BOTH,
                written_by="oracle",
                guidance="Optional: acceptance criteria you propose beyond the PRD's. They are "
                "listed as proposals; product approves them in the PRD."),
    SpecSection("user-flows", "User flows", "engineering_approach", False, FULL,
                guidance="The flows engineering implements, step by step, per requirement."),
    SpecSection("inputs-outputs", "Inputs and outputs", "engineering_approach", False, FULL,
                guidance="What each part takes in and gives back: user input, events, files, "
                "API payloads."),
    SpecSection("architecture", "Proposed architecture", "engineering_approach", False, FULL,
                guidance="Components and how they talk; what is new and what changes."),
    SpecSection("apis-data", "APIs and data models", "engineering_approach", False, FULL,
                guidance="Endpoints, schemas and storage, with their owners."),
    SpecSection("dependencies", "Dependencies", "engineering_approach", False, FULL,
                guidance="Other teams, services, third parties and features this depends on."),
    SpecSection("failure-modes", "Failure modes", "engineering_approach", False, FULL,
                guidance="What can fail, how it shows, and how the system recovers."),
    SpecSection("security-privacy-performance", "Security, privacy and performance",
                "engineering_approach", False, FULL,
                guidance="Threats, personal data, access, and performance budgets."),
    SpecSection("test-strategy", "Test strategy", "engineering_approach", False, FULL,
                guidance="How each requirement and acceptance criterion is tested."),
    SpecSection("release-flags", "Release flags", "engineering_approach", False, FULL,
                guidance="Feature flags, who sees what, and the rollout steps."),
    SpecSection("migration-rollback", "Migration and rollback", "engineering_approach", False,
                FULL, guidance="Data and schema migrations, and how to roll back."),
    SpecSection("assumptions", "Assumptions", "assumption", False, BOTH,
                guidance="Every assumption about the current code, systems and data the "
                "approach relies on. Without a code capability map, list them all."),
    SpecSection("sources", "Sources and data points", "context", False, BOTH,
                written_by="oracle"),
)  # fmt: skip
SECTIONS_BY_KEY = {s.key: s for s in SECTIONS}
BRIEF_KEYS = [s.key for s in SECTIONS if s.brief]


def sections_for(depth: str) -> list[SpecSection]:
    return [s for s in SECTIONS if depth in s.depths]


def template_keys(depth: object) -> frozenset[str]:
    """The keys of the sections Oracle writes for a spec of ``depth``: the template's
    sections for that depth, the title and the "Full version" heading. Any other key was
    added in an edit (E1, owner, 2026-10-20: a template section a tech brief does not have,
    e.g. Architecture, is an added section). An unknown depth reads as a brief, the
    smaller set, so nothing is reported Decided by mistake."""
    d = depth if isinstance(depth, str) and depth in DEPTHS else "brief"
    return frozenset([TITLE_ID, FULL_ID, *(s.key for s in sections_for(d))])


def keys_of(front_matter: dict[str, Any] | None) -> frozenset[str]:
    """:func:`template_keys` for a spec version, from its front matter's ``spec.depth``
    (which an edit may not change)."""
    spec = (front_matter or {}).get("spec")
    return template_keys(spec.get("depth") if isinstance(spec, dict) else None)


def part_of(section_key: str, keys: Collection[str] | None = None) -> Part:
    """The part a section of a spec version belongs to: the title and the "Full version"
    heading are context; a section the version Oracle wrote does not have (``keys``, see
    :func:`template_keys`; the whole template when not given) is proposed."""
    if keys is not None and section_key not in keys:
        return "proposed"
    s = SECTIONS_BY_KEY.get(section_key)
    if s is not None:
        return s.part
    return "context" if section_key in (TITLE_ID, FULL_ID) else "proposed"


def agent_sections(depth: str) -> list[SpecSection]:
    """The sections the agents write for ``depth``: (key, title, guidance)."""
    return [s for s in sections_for(depth) if s.written_by == "agent"]


PROPOSED_LABEL = (
    "_Proposed engineering approach: not decided until an engineering approver approves "
    "this spec version._"
)
ASSUMED_LABEL = (
    "_Proposed engineering approach, based on assumptions: no code capability map was "
    "available, so it is not checked against the code (see Assumptions)._"
)
NO_MAP_NOTE = (
    "_No code capability map was available for this spec: every statement about the current "
    "code, systems and data below is an assumption, not a fact checked against the code._"
)
ACCEPTANCE_PROPOSED_LABEL = (
    "Proposed by this spec (not product requirements until the PRD adopts them):"
)
REQUIREMENTS_NOTE = (
    "_Decided in the approved PRD: these are product requirements, not engineering choices. "
    "Change them in the PRD, not here._"
)


@dataclass(frozen=True)
class RequirementRef:
    """A requirement the spec covers: a baseline entity, and the PRD sections that link it."""

    id: str
    key: str
    title: str
    statement: str | None = None
    # PRD section keys (of the source version) that state it.
    section_keys: tuple[str, ...] = ()
    # Acceptance criteria in the baseline that verify it (titles).
    acceptance: tuple[str, ...] = ()


@dataclass(frozen=True)
class SpecInputs:
    slug: str
    title: str
    depth: str
    prd_slug: str
    prd_title: str
    prd_version: int
    # Section keys and headings of the PRD version the spec covers, in document order.
    sections: tuple[tuple[str, str], ...]
    requirements: tuple[RequirementRef, ...]
    capability_map: bool = False
    prd_approved_at: datetime | None = None
    request_id: str | None = None
    run_id: str | None = None
    feature: str | None = None
    # Keys of the request's requirements the PRD version does not adopt (left out).
    dropped: tuple[str, ...] = ()


@dataclass
class Problem:
    code: str
    message: str
    section: str | None = None
    severity: Literal["error", "warning"] = "error"

    def as_json(self) -> dict[str, str]:
        out = {"code": self.code, "message": self.message, "severity": self.severity}
        if self.section:
            out["section"] = self.section
        return out


@dataclass
class Composed:
    markdown: str | None
    problems: list[Problem] = field(default_factory=list)

    @property
    def ok(self) -> bool:
        return self.markdown is not None and not any(p.severity == "error" for p in self.problems)


def _agent_bodies(text: str, problems: list[Problem]) -> dict[str, str]:
    """Section key -> body markdown of the agents' ``spec.md`` (levels 1-3 start a section;
    deeper headings stay in the body). Citation markers are dropped: a spec's evidence is
    its PRD."""
    _, body, _ = split_front_matter(text.replace("\r\n", "\n"))
    body = CITATION_STRIP_RE.sub("", body)
    # Only blank lines are stripped: stripping spaces would turn an indented code line
    # followed by '---' into a setext heading (M1).
    wrapped = "---\ntitle: spec\n---\n\n" + body.strip("\n") + "\n"
    try:
        draft = parse_draft(wrapped)
    except DraftError as exc:
        for p in exc.problems:
            problems.append(Problem(p.code, f"spec.md: {p.message}"))
        return {}
    return {s.section_key: s.body_md.strip("\n") for s in draft.sections}


_INLINE_SPECIAL = re.compile(r"([\\`*_\[\]<>#|~!&{}])")
# What could still open a block at the start of the line: a list item, a thematic break or
# a setext underline ('-', '+', '='), or an ordered list item ('1.', '1)').
_BLOCK_START = re.compile(r"^(?:[-+=](?=[-+=\s]|$)|(\d{1,9})([.)])(?=\s|$))")


def escape_inline(text: str) -> str:
    """Baseline text (a requirement's title or statement, an acceptance criterion) as one
    line of literal markdown: whitespace collapsed (no line can open a code fence, a list
    or a heading) and markdown's special characters escaped (no '<!--', link or
    emphasis), its first character too when it could open a block ('---', '===', '1.')."""
    out = _INLINE_SPECIAL.sub(r"\\\1", " ".join(text.split()))
    return _BLOCK_START.sub(lambda m: f"{m[1]}\\{m[2]}" if m[1] else f"\\{m[0]}", out)


def _oracle_text(text: str | None, fallback: str) -> str:
    """Text Oracle copies into what it writes (a PRD's title, a feature's name): one
    escaped line (:func:`escape_inline`, so no newline, link or emphasis), or
    ``fallback`` when it would read as one of Oracle's labels or notes."""
    if not text or not text.strip() or _takes_label(text, anywhere=True):
        return fallback
    return escape_inline(text)


def _requirements_body(inputs: SpecInputs) -> str:
    headings = dict(inputs.sections)
    lines = [REQUIREMENTS_NOTE, ""]
    lines.append(
        f"From PRD [{_oracle_text(inputs.prd_title, inputs.prd_slug)}]"
        f"(/documents/{inputs.prd_slug}/v/{inputs.prd_version}), "
        f"version {inputs.prd_version}."
    )
    lines.append("")
    for r in inputs.requirements:
        lines.append(
            f"- **{escape_inline(r.key)}: {escape_inline(r.title)}** (requirement id `{r.id}`)"
        )
        if r.statement and r.statement.strip():
            lines.append(f"  {escape_inline(r.statement)}")
        for key in r.section_keys:
            link = prd_link(inputs.prd_slug, inputs.prd_version, key)
            lines.append(f"  PRD section: [{escape_inline(headings.get(key, key))}]({link})")
    covered = [k for k, _ in inputs.sections]
    if covered:
        lines += ["", "PRD sections this spec covers:", ""]
        for key in covered:
            link = prd_link(inputs.prd_slug, inputs.prd_version, key)
            lines.append(f"- [{escape_inline(headings[key])}]({link})")
    return "\n".join(lines)


def _acceptance_body(inputs: SpecInputs, proposed: str | None) -> str:
    lines: list[str] = []
    decided = [(r, a) for r in inputs.requirements for a in r.acceptance]
    if decided:
        lines += ["In the baseline (decided with the PRD):", ""]
        lines += [f"- {escape_inline(r.key)}: {escape_inline(a)}" for r, a in decided]
    else:
        lines.append("The baseline records no acceptance criteria for these requirements yet.")
    if proposed:
        lines += [
            "",
            ACCEPTANCE_PROPOSED_LABEL,
            "",
            proposed,
        ]
    return "\n".join(lines)


def _sources_body(inputs: SpecInputs) -> str:
    approved = f", approved {inputs.prd_approved_at:%Y-%m-%d}" if inputs.prd_approved_at else ""
    lines = [
        f"- Product requirements: PRD {inputs.prd_slug} version {inputs.prd_version}{approved}.",
        "- Requirement ids: " + (", ".join(r.id for r in inputs.requirements) or "none") + ".",
        "- Code capability map: "
        + ("used." if inputs.capability_map else "not available; the approach rests on the "
           "assumptions listed above."),
    ]  # fmt: skip
    if inputs.request_id:
        lines.append(f"- Spec request: {inputs.request_id}.")
    if inputs.run_id:
        lines.append(f"- Written by run {inputs.run_id}.")
    return "\n".join(lines)


def compose(agent_md: str, inputs: SpecInputs) -> Composed:
    """Check the agents' ``spec.md`` and build the spec version Oracle imports."""
    problems: list[Problem] = []
    if len(agent_md.encode("utf-8")) > MAX_SPEC_BYTES:
        return Composed(None, [Problem("too_large", f"spec.md is over {MAX_SPEC_BYTES} bytes")])
    if inputs.depth not in DEPTHS:
        return Composed(None, [Problem("invalid_depth", f"unknown depth {inputs.depth!r}")])
    if not inputs.requirements:
        problems.append(Problem("no_requirements", "the spec request names no requirement"))
    bodies = _agent_bodies(agent_md, problems)
    wanted = sections_for(inputs.depth)
    wanted_keys = {s.key for s in wanted}
    for key in bodies:
        s = SECTIONS_BY_KEY.get(key)
        if s is not None and s.written_by == "oracle" and key != "acceptance-criteria":
            problems.append(
                Problem(
                    "oracle_section",
                    f"section '{key}' is written by Oracle from the PRD; the agents' text was "
                    "left out",
                    key,
                    "warning",
                )
            )
        elif s is None and key not in (TITLE_ID, FULL_ID):
            problems.append(
                Problem("unknown_section", f"section '{key}' is not a spec section", key, "warning")
            )
        elif s is not None and key not in wanted_keys:
            problems.append(
                Problem(
                    "section_not_in_depth",
                    f"section '{key}' belongs to a full spec, not a tech brief; left out",
                    key,
                    "warning",
                )
            )
    for s in wanted:
        if s.written_by != "agent":
            continue
        text = bodies.get(s.key, "")
        if not text.strip():
            problems.append(
                Problem("missing_section", f"spec.md needs a non-empty '{s.title}' {{#{s.key}}}",
                        s.key)
            )  # fmt: skip
        elif len(text) > MAX_SECTION_CHARS:
            problems.append(
                Problem("section_too_long", f"'{s.title}' is over {MAX_SECTION_CHARS} characters",
                        s.key)
            )  # fmt: skip
    if any(p.severity == "error" for p in problems):
        return Composed(None, problems)

    front = {
        "document": inputs.slug,
        "title": inputs.title,
        "kind": "spec",
        "brief": BRIEF_KEYS,
        "spec": {
            "depth": inputs.depth,
            "source": {"document": inputs.prd_slug, "version": inputs.prd_version},
            "requirement_ids": [r.id for r in inputs.requirements],
            "code_capability_map": "used" if inputs.capability_map else "unavailable",
        },
    }
    feature = _oracle_text(inputs.feature, "")
    intro = (
        f"{'Technical brief' if inputs.depth == 'brief' else 'Engineering spec'}"
        + (f" for {feature}" if feature else "")
        + f", from the approved PRD {_oracle_text(inputs.prd_title, inputs.prd_slug)} "
        f"(version {inputs.prd_version}). "
        "Product requirements come from that PRD; the engineering approach is proposed until "
        "an engineering approver approves this version."
    )
    out = [
        "---",
        yaml.safe_dump(front, sort_keys=False, allow_unicode=True).rstrip(),
        "---",
        "",
        # The request's title as one escaped line (it may hold newlines, '{#id}' or
        # markup); one that reads as a label is refused when the spec is requested.
        f"# {_oracle_text(inputs.title, inputs.slug)} {{#{TITLE_ID}}}",
        "",
        intro,
        "",
    ]
    if not inputs.capability_map:
        out += [NO_MAP_NOTE, ""]
    full_started = False
    for s in wanted:
        if not s.brief and not full_started:
            out += [f"# Full version {{#{FULL_ID}}}", ""]
            full_started = True
        if s.key == "requirements":
            body = _requirements_body(inputs)
        elif s.key == "acceptance-criteria":
            body = _acceptance_body(inputs, bodies.get(s.key) or None)
        elif s.key == "sources":
            body = _sources_body(inputs)
        elif s.part == "engineering_approach":
            label = PROPOSED_LABEL if inputs.capability_map else ASSUMED_LABEL
            body = f"{label}\n\n{bodies[s.key]}"
        elif s.key == "assumptions" and not inputs.capability_map:
            body = f"{NO_MAP_NOTE}\n\n{bodies[s.key]}"
        else:
            body = bodies[s.key]
        out += [f"## {s.title} {{#{s.key}}}", "", body.strip("\n"), ""]
    markdown = "\n".join(out).rstrip() + "\n"
    # M1: what Oracle imports is checked like an edit: exactly the sections Oracle wrote,
    # in order (an agent's body can not open a section of its own), and the structure
    # rules (no raw HTML, no label or note copied into a body).
    after = composed_problems(markdown, inputs.depth)
    if after:
        return Composed(None, problems + after)
    # M3: and it can be served with its labels (refused at import, not a 500 when served).
    try:
        label_markdown(markdown, False, None)
    except DraftError as exc:
        return Composed(None, problems + [_problem(p) for p in exc.problems])
    return Composed(markdown, problems)


def _problem(p: ImportProblem) -> Problem:
    return Problem(p.code, f"spec.md: {p.message}", p.section_key)


def expected_keys(depth: str) -> list[str]:
    """The section keys of a version :func:`compose` writes for ``depth``, in order."""
    wanted = sections_for(depth)
    return [
        TITLE_ID,
        *(s.key for s in wanted if s.brief),
        FULL_ID,
        *(s.key for s in wanted if not s.brief),
    ]


def composed_problems(markdown: str, depth: str) -> list[Problem]:
    """What is wrong with a composed spec version: it does not parse, its section keys are
    not exactly :func:`expected_keys` in order, or it breaks a structure rule."""
    try:
        draft = parse_draft(markdown)
    except DraftError as exc:
        return [Problem(p.code, f"spec.md: {p.message}", p.section_key) for p in exc.problems]
    keys = [s.section_key for s in draft.sections]
    out: list[Problem] = []
    if keys != expected_keys(depth):
        extra = [k for k in keys if k not in expected_keys(depth)]
        out.append(
            Problem(
                "section_structure",
                "spec.md changes the spec's sections"
                + (f" (it opens {', '.join(extra)})" if extra else "")
                + ": write each section's body as markdown under its own heading, with no "
                "heading of a deeper section's level 1-3 (setext or indented ones included)",
            )
        )
    return out + structure_problems(markdown, draft)


# E1 (owner, 2026-10-19): the sections Oracle writes from the approved PRD. An edit of a
# spec version may change only its engineering parts: these stay as Oracle wrote them
# (for acceptance criteria, the half decided with the PRD; proposals may change).
PRD_PARTS = ("requirements", "acceptance-criteria", "sources")
# Every section Oracle writes: the PRD parts, the title (its intro names the PRD version)
# and the "Full version" heading. Spec structure (owner, 2026-10-20): an edit may add
# sections, but these keep their key, heading level and place relative to each other, and
# the brief keeps listing the ones it lists.
ORACLE_PARTS = (TITLE_ID, *PRD_PARTS, FULL_ID)
# The labels Oracle puts at the top of the engineering sections and the assumptions.
SECTION_LABELS = (PROPOSED_LABEL, ASSUMED_LABEL, NO_MAP_NOTE)
# Only Oracle's own label, as Oracle writes it, splits the acceptance criteria: an
# editor-written variant stays in the decided half (and so changes it).
_PROPOSED_SPLIT = re.compile(rf"\n\n{re.escape(ACCEPTANCE_PROPOSED_LABEL)}(?:\n|$)")


def split_acceptance(body: str) -> tuple[str, str | None]:
    """The acceptance criteria's two parts: the half Oracle wrote from the PRD (decided)
    and, after Oracle's own label, the proposed half (``None`` when there is none)."""
    parts = _PROPOSED_SPLIT.split(body.strip(), maxsplit=1)
    proposed = parts[1].strip() if len(parts) > 1 else ""
    return parts[0].rstrip(), proposed or None


# Only what Oracle locks is reported Decided (E1, owner, 2026-10-20): the visible state of
# each part of a spec version, in the document view, the exports and the markdown.
ADDED_LABEL = "Proposed · added in an edit"
DECIDED_PRD_LABEL = "Decided · from the approved PRD"
PROPOSED_ACCEPTANCE_STATE = "Proposed · not a product requirement until the PRD adopts it"
PROPOSED_STATE = "Proposed · until an engineering approver approves this version"
APPROVED_STATE = "Decided · approved by an engineering approver"
STATE_LABELS = (
    ADDED_LABEL,
    DECIDED_PRD_LABEL,
    PROPOSED_ACCEPTANCE_STATE,
    PROPOSED_STATE,
    APPROVED_STATE,
)


@dataclass(frozen=True)
class PartState:
    """One part of a section of a spec version: the whole section, or one half of the
    acceptance criteria (``half``)."""

    key: str
    part: Part
    decided: bool
    label: str
    half: Literal["decided", "proposed"] | None = None
    # The version Oracle wrote does not have the section: an edit added it.
    added: bool = False


def part_states(key: str, body: str, approved: bool, keys: Collection[str]) -> list[PartState]:
    """The decided/proposed state of a section of a spec version whose approach is
    ``approved`` (or not): decided only for the sections Oracle locks (its own parts),
    else once approved, and never for a section an edit added or for proposed acceptance
    criteria. ``keys`` are the sections of the version Oracle wrote (:func:`keys_of`): any
    other section was added in an edit, whatever its key or title (E1, owner, 2026-10-20).
    The summary is decided like the engineering parts."""
    if key not in keys:
        return [PartState(key, "proposed", False, ADDED_LABEL, added=True)]
    if key == "acceptance-criteria":
        out = [PartState(key, "product_requirement", True, DECIDED_PRD_LABEL, "decided")]
        if split_acceptance(body)[1] is not None:
            out.append(PartState(key, "proposed", False, PROPOSED_ACCEPTANCE_STATE, "proposed"))
        return out
    part = part_of(key, keys)
    if key in ORACLE_PARTS:
        return [PartState(key, part, True, DECIDED_PRD_LABEL)]
    return [PartState(key, part, approved, APPROVED_STATE if approved else PROPOSED_STATE)]


# The sections that show no state: the title and the "Full version" heading hold the
# document together (they are decided, and say where the rest comes from).
UNLABELLED = (TITLE_ID, FULL_ID)


def state_line(label: str) -> str:
    """A state label as the markdown shows it: a paragraph of its own. (The HTML, PDF and
    slide exports render it as an element no body can produce, :mod:`oracle.export`.)"""
    return f"**{label}**"


_STATE_LINES = frozenset(state_line(label) for label in STATE_LABELS)

# E1 (owner, 2026-10-20): citations added in an edit are listed apart from Oracle's
# Sources. The served markdown names them (ids JSON-quoted) in a YAML comment on the front
# matter's first line.
ADDED_SOURCES = "Added sources"
ADDED_SOURCES_COMMENT = f"# {ADDED_SOURCES} · {ADDED_LABEL} (not Oracle's Sources):"


def section_states(draft: ParsedDraft, approved: bool) -> dict[str, list[PartState]]:
    """Each labelled section's states, by key, for a parsed spec version."""
    keys = keys_of(draft.front_matter)
    return {
        s.section_key: part_states(s.section_key, s.body_md, approved, keys)
        for s in draft.sections
        if s.section_key not in UNLABELLED
    }


def _refuse(code: str, message: str, key: str | None = None) -> DraftError:
    return DraftError([ImportProblem(code=code, message=message, section_key=key)])


def _fenced_lines(body: str, offset: int) -> set[int]:
    """0-based lines (of the whole file) inside code blocks, fenced or indented."""
    out: set[int] = set()
    for tok in _parse_blocks(body):
        if tok.type in ("fence", "code_block") and tok.map:
            out.update(range(tok.map[0] + offset, tok.map[1] + offset))
    return out


_SETEXT_UNDERLINE = re.compile(r"^ {0,3}(?:=+|-+)[ \t]*$")


def label_markdown(
    markdown: str,
    approved: bool,
    oracle_citations: Collection[str] | None = None,
    draft: ParsedDraft | None = None,
) -> str:
    """A spec version's markdown with every section's state label at the start of its
    body (the parser's body line) and before the proposed acceptance criteria, and the
    citations an edit added named in a comment on the front matter's first line (those
    not in ``oracle_citations``; all of them when it is None). :func:`strip_state_labels`
    undoes it, so the markdown imports back with the same sections. Fails closed: a
    version that does not parse, or whose section headings are not top-level ATX
    headings, raises :class:`DraftError` rather than being served unlabelled. ``draft``
    is ``markdown`` already parsed."""
    draft = draft if draft is not None else parse_draft(markdown)
    lines = draft.markdown.split("\n")
    states = section_states(draft, approved)
    inserts: list[tuple[int, list[str]]] = []
    ends = [s.line - 1 for s in draft.sections[1:]] + [len(lines)]
    for s, end in zip(draft.sections, ends, strict=True):
        if not s.markup.startswith("#") or s.nesting:
            raise _refuse(
                "heading_not_atx",
                f"section '{s.section_key}' is not a top-level '#' heading: the version "
                "can not carry its state labels",
                s.section_key,
            )
        if s.section_key not in states:
            continue
        found = states[s.section_key]
        at = s.body_line - 1
        # A blank line after the label when the body starts right under the heading with
        # '---' or '===': the label would read as a setext heading. (Stripped, such a
        # body keeps that blank line: the same sections, one more blank line.)
        tail = [""] if at < len(lines) and _SETEXT_UNDERLINE.match(lines[at]) else []
        inserts.append((at, ["", state_line(found[0].label), *tail]))
        if len(found) > 1:
            split = next(
                (
                    j
                    for j in range(at, end)
                    if lines[j] == ACCEPTANCE_PROPOSED_LABEL and j > 0 and lines[j - 1] == ""
                ),
                None,
            )
            if split is None:
                raise _refuse(
                    "acceptance_split",
                    "the proposed acceptance criteria have no place for their label",
                    s.section_key,
                )
            inserts.append((split, [state_line(found[1].label), ""]))
    added = _added_citation_ids(draft, oracle_citations)
    if added:
        if draft.front_matter is None or not lines or lines[0].strip() != "---":
            raise _refuse("citations_unlabelled", "the added sources can not be labelled")
        # On the front matter's first line, whatever its style (block, flow, indented):
        # a comment there is YAML in any front matter. Ids JSON-quoted.
        ids = ", ".join(json.dumps(i, ensure_ascii=False) for i in added)
        inserts.append((1, [f"{ADDED_SOURCES_COMMENT} {ids}"]))
    for at, new in sorted(inserts, key=lambda i: i[0], reverse=True):
        lines[at:at] = new
    return "\n".join(lines)


def _added_citation_ids(draft: ParsedDraft, oracle: Collection[str] | None) -> list[str]:
    return [c.id for c in draft.citations if oracle is None or c.id not in oracle]


def added_citations(
    front_matter: dict[str, Any] | None, oracle: Collection[str] | None
) -> set[str]:
    """The ids of a spec version's citations an edit added (not in ``oracle``, the
    citations of the version Oracle wrote; all of them when None)."""
    raw = (front_matter or {}).get("citations")
    ids = {str(c.get("id")) for c in raw if isinstance(c, dict)} if isinstance(raw, list) else set()
    return ids if oracle is None else ids - set(oracle)


def strip_state_labels(markdown: str) -> str:
    """The markdown without Oracle's state labels (each with the blank line before it) and
    its Added sources comment: they are shown, never stored, whoever wrote them. Lines
    inside code blocks are left alone. (A body that started right under its heading keeps
    the blank line :func:`label_markdown` put after the label: the same sections.) The
    text is read as :func:`parse_draft` reads it (:func:`prepared`), so the import parses
    the result once."""
    text = prepared(markdown)
    lines = text.split("\n")
    fm, body, offset = split_front_matter(text)
    fenced = _fenced_lines(body, offset)
    out: list[str] = []
    for i, line in enumerate(lines):
        # Only where :func:`label_markdown` puts it: a line further down may be part of a
        # multi-line scalar.
        if fm is not None and i == 1 and line.startswith(ADDED_SOURCES_COMMENT):
            continue
        if i >= offset and i not in fenced and line.strip() in _STATE_LINES:
            if out and not out[-1].strip():
                out.pop()
            continue
        out.append(line)
    return "\n".join(out)


# E1 'Added sections, visible' (owner, 2026-10-20): Oracle's parts an edit may not add a
# section inside, and the note and labels an added heading may not take.
PRD_PART_TITLES = {k: SECTIONS_BY_KEY[k].title for k in PRD_PARTS}

# M4: text compared with Oracle's titles, notes and labels is normalised first: HTML
# entities decoded, NFKC, format and default-ignorable characters (soft hyphen,
# zero-width ones, BOM, Hangul fillers, variation selectors, tags) dropped, markdown
# rendered to its plain text, then reduced to a confusable skeleton (UTS #39 style:
# accents dropped, look-alike letters of any script folded to the Latin letter they look
# like, lower case). Only ever compared with Oracle's few fixed phrases, so non-Latin text
# is refused only when it reads as one of them.
_PLAIN_MD = MarkdownIt("commonmark", {"html": False}).enable("strikethrough")
# Blocks as the views read them (tables on). Never with HTML on: markdown-it's inline
# HTML rule is quadratic on many unclosed '<!--' (or '<?', '<a b="'), and a spec holds no
# raw HTML anyway (:func:`_html_and_data` finds it in the text tokens, linearly).
_BLOCK_MD = MarkdownIt("commonmark", {"html": False}).enable(["table", "strikethrough"])
# markdown-it's parse is quadratic on one long line of tag-like text even with HTML off
# ('<b>' x 300k, 900 KB, takes ~12 s), so a line over this many characters is refused
# (``line_too_long``) before any parse, and the parse run off the event loop is given a
# time cap (:func:`oracle.safe_yaml.run_parse_within`).
MAX_LINE = 20_000
_LONG_LINE = re.compile(rf"[^\n]{{{MAX_LINE + 1}}}")


def _has_long_line(text: str) -> bool:
    return _LONG_LINE.search(text) is not None


def _parse_blocks(text: str) -> list:
    """``_BLOCK_MD``'s tokens for ``text``; none for a text with an over-long line (the
    structure check refuses it, :func:`structure_problems`, so no output is built from it)."""
    return [] if _has_long_line(text) else _BLOCK_MD.parse(text)


_EMPHASIS = re.compile(r"[*_`~]+")
# Default_Ignorable_Code_Point (DerivedCoreProperties.txt) outside category Cf: what
# renders as nothing, or as blank space, yet is a letter or a mark.
_IGNORABLE = re.compile(
    "[\u034f\u115f\u1160\u17b4\u17b5\u180b-\u180f\u3164\ufe00-\ufe0f\uffa0\U000e0000-\U000e0fff]"
)
# After the table: letters that still read alike (I, l, 1, |; O, 0).
_ALIKE = str.maketrans({"l": "i", "1": "i", "0": "o"})


def _visible(text: str) -> str:
    for _ in range(3):
        decoded = html.unescape(text)
        if decoded == text:
            break
        text = decoded
    text = unicodedata.normalize("NFKC", _IGNORABLE.sub("", text))
    text = _IGNORABLE.sub("", text)
    return "".join(ch for ch in text if unicodedata.category(ch) != "Cf")


def skeleton(text: str) -> str:
    """Visible text (already plain) reduced to what it looks like: accents dropped, each
    look-alike letter (:mod:`oracle.specs.confusables`) folded to its Latin prototype,
    lower case, emphasis markers and runs of space collapsed."""
    text = unicodedata.normalize("NFD", _visible(text))
    text = "".join(ch for ch in text if unicodedata.category(ch) != "Mn")
    text = text.translate(CONFUSABLES).lower().translate(CONFUSABLES).translate(_ALIKE)
    return " ".join(_EMPHASIS.sub("", text).split())


def _inline_plain(text: str) -> str:
    if _has_long_line(text):  # refused by structure_problems; not parsed (quadratic)
        return text
    out: list[str] = []
    for block in _PLAIN_MD.parseInline(text):
        for tok in block.children or []:
            if tok.type in ("text", "code_inline", "html_inline"):
                out.append(tok.content)
            elif tok.type in ("softbreak", "hardbreak"):
                out.append(" ")
            # An image is nothing: its alt text is not visible text.
    return "".join(out)


def normalised(text: str) -> str:
    """Markdown text as compared with Oracle's titles, notes and labels (M4)."""
    return skeleton(_inline_plain(_visible(text)))


def _squashed(text: str) -> str:
    """:func:`normalised`, letters and digits only ('P.R.D.' reads as 'prd')."""
    return re.sub(r"[\W_]+", "", normalised(text))


# A leading 'decided' or 'proposed' followed by any separator (a dot, bullet, dash,
# colon...) reads as a state label.
_LABEL_START = re.compile(r"^[\W_]*(?:decided|proposed)\s*[^\w\s]")
# What renders before a block's text, not as text: a list or quote marker, a task-list
# box ('[x]'), a footnote marker ('[^1]:').
_LIST_MARKER = re.compile(r"^\s*(?:(?:>|[-*+]|\d{1,9}[.)]|\[[ x]\]|\[\^[^\]\s]*\]:?)\s*)+")
# Oracle's notes and labels, as skeletons squashed: no body text or added heading may
# take them.
_NOTES = ("decidedintheapprovedprd", "decidedwiththeprd", "inthebaselinedecidedwiththeprd")


def _phrase(text: str) -> str:
    return re.sub(r"[\W_]+", "", skeleton(text))


_PHRASES = tuple(_phrase(p) for p in (*_NOTES, *STATE_LABELS))


def _takes_plain(plain: str, anywhere: bool) -> bool:
    """Plain (rendered) text reads as one of Oracle's labels or notes: at its start, or
    ``anywhere``."""
    sk = skeleton(_LIST_MARKER.sub("", skeleton(plain)))
    squashed = re.sub(r"[\W_]+", "", sk)
    # A bare 'Decided' or 'Proposed' reads as a label too.
    if _LABEL_START.match(sk) or squashed in ("decided", "proposed"):
        return True
    if anywhere:
        return any(n in squashed for n in _PHRASES)
    return squashed.startswith(_PHRASES)


def _takes_label(text: str, anywhere: bool) -> bool:
    """Markdown text (a heading, a title) reads as one of Oracle's labels or notes."""
    return _takes_plain(_inline_plain(_visible(text)), anywhere)


def title_takes_label(title: str) -> bool:
    """A spec request's title reads as one of Oracle's labels or notes (as a heading)."""
    return _takes_label(_heading_plain(title), anywhere=True)


def _plain_runs(body: str) -> list[str]:
    """The rendered text of a body, block by block (a paragraph, a heading, every table
    cell, a list item's paragraph): soft breaks read as spaces; a hard break starts a run
    of its own (and the block is read joined as well); the end of emphasis or a code span
    reads as a separator ('**Decided** R-9' looks like a label); images render as nothing
    (alt text is not visible text); each line of a code block is a run. (Raw HTML is
    refused before, :func:`_html_and_data`.)"""
    runs: list[str] = []
    for tok in _parse_blocks(body):
        if tok.type in ("fence", "code_block"):
            runs += tok.content.split("\n")
        if tok.type != "inline":
            continue
        run: list[str] = []
        joined: list[str] = []
        for child in tok.children or []:
            if child.type == "text":
                run.append(child.content)
            elif child.type == "code_inline":
                run.append(f"{child.content} · ")
            elif child.type in ("strong_close", "em_close", "s_close"):
                run.append(" · ")
            elif child.type == "softbreak":
                run.append(" ")
            elif child.type == "hardbreak":
                runs.append("".join(run))
                joined += [*run, " "]
                run = []
        runs.append("".join(run))
        if joined:
            runs.append("".join(joined + run))
    return runs


def _section_text(s) -> str:
    """A section's heading and body as one text (the heading as a paragraph of its own)."""
    return f"{s.heading}\n\n{s.body_md}"


def _has_comment_syntax(text: str) -> bool:
    """E1 (owner, 2026-10-20): HTML comment syntax, anywhere (code included)."""
    return "<!--" in text or "-->" in text


def _comment_spans(text: str) -> bool:
    """A section's text opens a comment it does not close (or closes one it did not
    open), or holds a comment that hides a heading (one that ran into the next section).
    One linear pass (a lazy-dot regex is quadratic on many unclosed '<!--')."""
    pos = 0
    while (start := text.find("<!--", pos)) >= 0:
        end = text.find("-->", start + 4)
        if end < 0:
            return True
        if _HEADING_LINE.search(text, start, end):
            return True
        pos = end + 3
    return "-->" in layers.strip_comments(text)


_HEADING_LINE = re.compile(r"^ {0,3}#{1,6}(?:\s|$)", re.M)
# A data: URL as a link or image destination, or a reference definition, as written (a
# data: URL markdown-it does not accept stays text here but may render elsewhere).
_DATA_DEST = re.compile(
    r"(?<!\\)(?:\\\\)*\]\(\s*(?:<\s*)?data:|^ {0,3}\[[^\]\n]+\]:\s*(?:<\s*)?data:", re.I | re.M
)
# The same for javascript: and vbscript: (a destination markdown-it refuses stays text
# here, but the raw text is what an export or another reader may link).
_SCRIPT_DEST = re.compile(
    r"(?<!\\)(?:\\\\)*\]\(\s*(?:<\s*)?(?:javascript|vbscript):"
    r"|^ {0,3}\[[^\]\n]+\]:\s*(?:<\s*)?(?:javascript|vbscript):",
    re.I | re.M,
)
_URL_JUNK = re.compile(r"[\x00-\x20\x7f-\x9f]")


def _scheme_of(url: str | None) -> str:
    """The lower-case scheme of ``url`` as a browser reads it (control characters and
    spaces inside it are ignored), or ''."""
    head = _URL_JUNK.sub("", url or "").lower()
    return head.split(":", 1)[0] if ":" in head else ""


def _is_data_url(url: str | None) -> bool:
    return _scheme_of(url) == "data"


def _is_script_url(url: str | None) -> bool:
    return _scheme_of(url) in ("javascript", "vbscript")


# Text markdown-it with HTML on would read as HTML (a block or an inline tag): an open or
# closing tag ('<span', '</div'), a comment, declaration or CDATA ('<!'), a processing
# instruction ('<?'). Not an autolink ('<https://...>', '<a@b.c>').
_TAG_LIKE = re.compile(r"<(?:/?[A-Za-z][A-Za-z0-9-]*(?=[\s/>]|$)|[!?])")


def _html_and_data(text: str) -> tuple[bool, bool, bool]:
    """(raw HTML, a data: URL, a javascript:/vbscript: URL) in ``text``: tag-like text
    outside code (as markdown-it with HTML on would read it, a block or an inline tag;
    text a backslash escapes ('\\<span>') counts, entity-escaped text ('&lt;b&gt;') does
    not: it renders literally), and an image or link whose URL has one of those schemes.
    Linear in the text's lines, each at most ``MAX_LINE`` long (the caller refuses a longer
    one first: markdown-it's parse is quadratic on a long line)."""
    data_found = bool(_DATA_DEST.search(text))
    script_found = bool(_SCRIPT_DEST.search(text))
    if not _TAG_LIKE.search(text):
        # No tag-like text at all: nothing to tell apart from code, no parse.
        return False, data_found, script_found
    html_found = False
    for tok in _parse_blocks(text):
        for child in tok.children or []:
            if child.type == "text" and _TAG_LIKE.search(child.content):
                html_found = True
            elif child.type in ("image", "link_open"):
                url = child.attrGet("src") or child.attrGet("href")
                data_found = data_found or _is_data_url(url)
                script_found = script_found or _is_script_url(url)
    return html_found, data_found, script_found


def _renderings(text: str) -> list[str]:
    """What each output renders of a body (E1, owner, 2026-10-20): the body itself (the
    document view, the markdown), without its citation markers (they render as chips or
    footnote numbers), and as slides and exports show it (:func:`layers.slide_body`, no
    notes blocks or comments), with and without its citation markers."""
    slide = layers.slide_body(text)
    return list(
        dict.fromkeys(
            (text, CITATION_STRIP_RE.sub("", text), slide, CITATION_STRIP_RE.sub("", slide))
        )
    )


def _body_takes_label(text: str) -> bool:
    return any(
        _takes_plain(run, anywhere=False) for out in _renderings(text) for run in _plain_runs(out)
    )


def _heading_plain(heading: str) -> str:
    """A heading without its citation markers (they render as chips or numbers)."""
    return CITATION_STRIP_RE.sub("", heading).strip()


def _editable_text(key: str, body: str) -> str:
    """The text of a section an edit may change: all of it, or for the acceptance
    criteria the proposed half (the decided half is Oracle's)."""
    if key == "acceptance-criteria":
        return split_acceptance(body)[1] or ""
    return body


def structure_problems(markdown: str, draft: ParsedDraft | None = None) -> list[Problem]:
    """What an edit (or a run's import) may not do with a spec's structure, every problem
    at once:

    - a section heading that is not a top-level ATX '#' heading (setext, or inside a list
      or block quote);
    - in any section's heading or body (E1, owner, 2026-10-20): raw HTML (a block or an
      inline tag), HTML comment syntax ('<!--', '-->') or a data: URL;
    - a section added, or moved, inside the subtree of Product requirements, the
      acceptance criteria or Sources and data points, or one of Oracle's parts under an
      added level-1 heading;
    - a template section's title changed (only bodies are editable);
    - a heading (the title's included) that takes a PRD part's title, Oracle's note
      ('Decided in the approved PRD') or a state label, citation markers aside, or a block
      (in a part an edit may change) that starts with a state label or Oracle's note, in
      any spelling (:func:`normalised`) and in every output's rendering of the body
      (:func:`_renderings`);
    - an HTML comment left open across sections."""
    if draft is None:
        try:
            draft = parse_draft(markdown)
        except DraftError:
            return []
    keys = keys_of(draft.front_matter)
    problems: list[Problem] = []
    _, body, offset = split_front_matter(draft.markdown)
    starts = [(s.line, s.section_key) for s in draft.sections]

    def section_at(line: int) -> str | None:
        return next((k for start, k in reversed(starts) if start <= line), None)

    # E1 (owner, 2026-10-20): no section's heading or body holds raw HTML, HTML comment
    # syntax or a data: URL, whatever renders it.
    commented: set[str] = set()
    for s in draft.sections:
        text = _section_text(s)
        if _has_comment_syntax(text):
            # Refused whatever else it holds; not parsed further (linear checks only).
            commented.add(s.section_key)
            problems.append(
                Problem(
                    "inline_comment",
                    "A spec may not hold HTML comment syntax ('<!--' or '-->'), in code "
                    "included: write it as markdown.",
                    s.section_key,
                )
            )
            continue
        if _has_long_line(text):
            problems.append(
                Problem(
                    "line_too_long",
                    f"A spec line may not be over {MAX_LINE:,} characters: break it into "
                    "paragraphs or list items.",
                    s.section_key,
                )
            )
            continue
        raw_html, data_url, script_url = _html_and_data(text)
        if raw_html:
            problems.append(
                Problem(
                    "raw_html",
                    "A spec may not hold raw HTML (<span>, <details>, <script>, <pre>...), "
                    "inline or as a block: write it as markdown.",
                    s.section_key,
                )
            )
        if data_url:
            problems.append(
                Problem(
                    "data_url",
                    "A spec may not hold data: URLs in images or links: link to an https URL.",
                    s.section_key,
                )
            )
        if script_url:
            problems.append(
                Problem(
                    "script_url",
                    "A spec may not hold javascript: or vbscript: URLs in images or links: "
                    "link to an https URL.",
                    s.section_key,
                )
            )
    owner: tuple[str, int] | None = None
    level_one: str | None = None
    titles = {_squashed(t): k for k, t in PRD_PART_TITLES.items()}
    for s in draft.sections:
        if not s.markup.startswith("#") or s.nesting:
            problems.append(
                Problem(
                    "heading_not_atx",
                    "Section headings are top-level '#' headings: no setext underline, none "
                    "inside a list or block quote.",
                    s.section_key,
                )
            )
        if _comment_spans(f"{s.heading}\n{s.body_md}"):
            problems.append(
                Problem(
                    "comment_across_sections",
                    "A comment must open and close within one section: it may not hide a "
                    "heading or run into the next section.",
                    s.section_key,
                )
            )
        if s.level == 1:
            level_one = s.section_key
        elif s.section_key in ORACLE_PARTS and level_one not in (None, *UNLABELLED):
            problems.append(
                Problem(
                    "oracle_part_under_added_section",
                    f"'{s.heading}' is Oracle's: it stays under Oracle's headings, not under "
                    "an added level-1 section.",
                    s.section_key,
                )
            )
        if owner is not None and s.level <= owner[1]:
            owner = None
        heading = _heading_plain(s.heading)
        if s.section_key == TITLE_ID and _takes_label(heading, anywhere=True):
            problems.append(
                Problem(
                    "heading_takes_oracle_note",
                    "The spec's title may not read as Oracle's note or its Decided and "
                    "Proposed labels.",
                    s.section_key,
                )
            )
        if s.section_key in PRD_PART_TITLES:
            owner = (s.section_key, s.level)
            continue
        if s.section_key in ORACLE_PARTS:
            continue
        template = SECTIONS_BY_KEY.get(s.section_key)
        if template is not None and s.heading != template.title:
            problems.append(
                Problem(
                    "template_title_changed",
                    f"Template section titles can't be changed: '{s.section_key}' is "
                    f"'{template.title}'. Only its body is editable.",
                    s.section_key,
                )
            )
        inside = owner[0] if owner is not None else None
        if inside is None and s.section_key not in keys:
            inside = titles.get(_squashed(heading))
        if inside is not None:
            problems.append(
                Problem(
                    "section_inside_oracle_part",
                    f"Add your section outside {PRD_PART_TITLES[inside]}: Oracle writes it "
                    "from the approved PRD.",
                    s.section_key,
                )
            )
        elif _takes_label(s.heading, anywhere=True) or _takes_label(heading, anywhere=True):
            problems.append(
                Problem(
                    "heading_takes_oracle_note",
                    "A section's heading may not take Oracle's note ('Decided in the "
                    "approved PRD') or its Decided and Proposed labels.",
                    s.section_key,
                )
            )
    for s in draft.sections:
        if s.section_key in ORACLE_PARTS and s.section_key != "acceptance-criteria":
            continue
        if s.section_key in commented:
            continue
        text = _editable_text(s.section_key, s.body_md)
        # M4/M6: the text as it renders, block by block (not raw lines: a label may be
        # split over two lines, or hide behind characters that render as nothing), in
        # every output's rendering of it (E1, owner, 2026-10-20).
        if _body_takes_label(text):
            problems.append(
                Problem(
                    "body_takes_oracle_label",
                    "A paragraph, list item, heading or table cell may not start with a "
                    "Decided or Proposed label or Oracle's note ('Decided in the approved "
                    "PRD', 'In the baseline (decided with the PRD)'), in the document, its "
                    "slides or its exports: Oracle shows each part's state itself.",
                    s.section_key,
                )
            )
    if any(_comment_takes_label(c) for c in _front_matter_comments(draft.markdown)):
        problems.append(
            Problem(
                "front_matter_comment",
                "A front matter comment may not read as Oracle's labels, notes or its Added "
                "sources line: Oracle shows them itself.",
            )
        )
    return problems


def _front_matter_comments(markdown: str) -> list[str]:
    """The text after each '#' that may open a YAML comment in the front matter (at the
    start of a line or after a space; one inside a quoted scalar counts too, so nothing
    is missed)."""
    lines = markdown.split("\n")
    if not lines or lines[0].strip() != "---":
        return []
    out: list[str] = []
    for line in lines[1:]:
        if line.strip() in ("---", "..."):
            break
        out += [m.group(1) for m in re.finditer(r"(?:^|\s)#(.*)$", line)]
    return out


def _comment_takes_label(text: str) -> bool:
    plain = _visible(text)
    return _takes_plain(plain, anywhere=True) or "addedsources" in re.sub(
        r"[\W_]+", "", skeleton(plain)
    )


def _leading_label(body: str) -> str | None:
    first = body.strip().split("\n\n", 1)[0].strip()
    return first if first in SECTION_LABELS else None


def _parsed(markdown: str, draft: ParsedDraft | None) -> ParsedDraft | None:
    if draft is not None:
        return draft
    try:
        return parse_draft(markdown)
    except DraftError:
        return None


def prd_parts(markdown: str, draft: ParsedDraft | None = None) -> dict[str, object]:
    """What of a spec version Oracle writes and an edit may not change: (level, heading,
    body) of each of Oracle's sections, their order, the ones the brief lists, the label
    on each engineering section and the assumptions (in order, per section), and the
    front matter's ``spec`` block (source and requirement ids), title, template and
    template version. ``draft`` is ``markdown`` already parsed."""
    draft = _parsed(markdown, draft)
    if draft is None:
        return {}
    fm = draft.front_matter or {}
    keys = keys_of(fm)
    out: dict[str, object] = {
        "front_matter": fm.get("spec"),
        "title": fm.get("title"),
        "template": fm.get("template"),
        "template_version": fm.get("template_version"),
    }
    order: list[str] = []
    labels: list[tuple[str, str, str]] = []
    for s in draft.sections:
        body = s.body_md.strip()
        if s.section_key in ORACLE_PARTS:
            if s.section_key == "acceptance-criteria":
                body = split_acceptance(body)[0]
            out[s.section_key] = (s.level, s.heading, body)
            order.append(s.section_key)
        part = part_of(s.section_key, keys)
        if part in ("engineering_approach", "assumption"):
            labels.append((s.section_key, part, _leading_label(body) or ""))
    out["order"] = tuple(order)
    out["brief"] = tuple(k for k in draft.brief or [] if k in ORACLE_PARTS)
    out["labels"] = tuple(labels)
    return out


def oracle_citations(markdown: str, draft: ParsedDraft | None = None) -> dict[str, dict[str, Any]]:
    """The citations of a version Oracle wrote, by id, as its front matter has them."""
    draft = _parsed(markdown, draft)
    if draft is None:
        return {}
    raw = (draft.front_matter or {}).get("citations")
    if not isinstance(raw, list):
        return {}
    return {str(c["id"]): c for c in raw if isinstance(c, dict) and "id" in c}


def citation_problems(
    markdown: str, oracle: dict[str, dict[str, Any]], draft: ParsedDraft | None = None
) -> list[Problem]:
    """E1 (owner, 2026-10-20): an edit may add citations (listed as Added sources) but
    may not change or remove Oracle's."""
    mine = oracle_citations(markdown, draft)
    return [
        Problem(
            "oracle_citation_changed",
            f"Citation '{cid}' is one of Oracle's Sources: an edit may add citations, not "
            "change or remove Oracle's.",
        )
        for cid, c in oracle.items()
        if mine.get(cid) != c
    ]


def expected_prd_parts(inputs: SpecInputs) -> dict[str, object]:
    """:func:`prd_parts` of the version :func:`compose` writes from ``inputs`` today."""
    stub = "\n\n".join(f"## {s.title} {{#{s.key}}}\n\n-" for s in agent_sections(inputs.depth))
    composed = compose(stub, inputs)
    return prd_parts(composed.markdown) if composed.markdown else {}


@dataclass
class EditCheck:
    """What :func:`edit_check` finds in an edit of a spec version."""

    # Structure, citation and labelling problems (refused whatever else holds).
    problems: list[Problem]
    # :func:`prd_parts` of the edit, and of each version it may keep Oracle's parts as.
    submitted: dict[str, object]
    allowed: list[dict[str, object]]


def edit_check(
    markdown: str,
    written: str | None,
    previous: str | None,
    inputs: SpecInputs,
    draft: ParsedDraft | None = None,
) -> EditCheck:
    """The pure half of an edit's check (:func:`oracle.specs.service.check_edit`), run off
    the event loop: the edit parsed once, then its structure (:func:`structure_problems`),
    Oracle's citations as ``written`` (the version Oracle wrote) has them, Oracle's parts
    against ``written`` and ``previous`` (the version the edit replaces; the version
    :func:`compose` writes from ``inputs`` when there is neither), and whether the
    version can be served with its labels (:func:`label_markdown`, M3: refused here
    rather than a 500 on every read). ``draft``: ``markdown`` as the import already parsed
    it (an API edit is parsed once)."""
    if draft is None or draft.markdown != markdown:
        try:
            draft = parse_draft(markdown)
        except DraftError as exc:
            return EditCheck([_problem(p) for p in exc.problems], {}, [])
    problems = structure_problems(markdown, draft)
    allowed: list[dict[str, object]] = []
    oracle: dict[str, dict[str, Any]] | None = None
    for i, text in enumerate((written, previous)):
        if text is None:
            continue
        other = _parsed(text, None)
        allowed.append(prd_parts(text, other) if other is not None else {})
        if i == 0:
            oracle = oracle_citations(text, other) if other is not None else {}
            problems += citation_problems(markdown, oracle, draft)
    if not allowed:
        allowed.append(expected_prd_parts(inputs))
    try:
        label_markdown(markdown, False, None if oracle is None else list(oracle), draft)
    except DraftError as exc:
        problems += [Problem(p.code, p.message, p.section_key) for p in exc.problems]
    return EditCheck(problems, prd_parts(markdown, draft), allowed)


SLUG_RE = re.compile(r"[^a-z0-9]+")


def slugify(text: str, limit: int = 60) -> str:
    return SLUG_RE.sub("-", text.lower()).strip("-")[:limit].strip("-") or "spec"
