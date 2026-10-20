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

import re
from dataclasses import dataclass, field
from datetime import datetime
from typing import Literal

import yaml

from oracle.docs.parser import CITATION_STRIP_RE, DraftError, parse_draft, split_front_matter
from oracle.runs.flows import prd_link

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


def part_of(section_key: str) -> Part:
    """The part a section of a spec version belongs to: the title and the "Full version"
    heading are context; a section the template does not have is proposed."""
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
    wrapped = "---\ntitle: spec\n---\n\n" + body.strip() + "\n"
    try:
        draft = parse_draft(wrapped)
    except DraftError as exc:
        for p in exc.problems:
            problems.append(Problem(p.code, f"spec.md: {p.message}"))
        return {}
    return {s.section_key: s.body_md.strip() for s in draft.sections}


def _requirements_body(inputs: SpecInputs) -> str:
    headings = dict(inputs.sections)
    lines = [REQUIREMENTS_NOTE, ""]
    lines.append(
        f"From PRD [{inputs.prd_title}](/documents/{inputs.prd_slug}/v/{inputs.prd_version}), "
        f"version {inputs.prd_version}."
    )
    lines.append("")
    for r in inputs.requirements:
        lines.append(f"- **{r.key}: {r.title}** (requirement id `{r.id}`)")
        if r.statement:
            lines.append(f"  {r.statement.strip()}")
        for key in r.section_keys:
            link = prd_link(inputs.prd_slug, inputs.prd_version, key)
            lines.append(f"  PRD section: [{headings.get(key, key)}]({link})")
    covered = [k for k, _ in inputs.sections]
    if covered:
        lines += ["", "PRD sections this spec covers:", ""]
        for key in covered:
            link = prd_link(inputs.prd_slug, inputs.prd_version, key)
            lines.append(f"- [{headings[key]}]({link})")
    return "\n".join(lines)


def _acceptance_body(inputs: SpecInputs, proposed: str | None) -> str:
    lines: list[str] = []
    decided = [(r, a) for r in inputs.requirements for a in r.acceptance]
    if decided:
        lines += ["In the baseline (decided with the PRD):", ""]
        lines += [f"- {r.key}: {a}" for r, a in decided]
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
        if not text:
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
    intro = (
        f"{'Technical brief' if inputs.depth == 'brief' else 'Engineering spec'}"
        + (f" for {inputs.feature}" if inputs.feature else "")
        + f", from the approved PRD {inputs.prd_title} (version {inputs.prd_version}). "
        "Product requirements come from that PRD; the engineering approach is proposed until "
        "an engineering approver approves this version."
    )
    out = [
        "---",
        yaml.safe_dump(front, sort_keys=False, allow_unicode=True).rstrip(),
        "---",
        "",
        f"# {inputs.title} {{#{TITLE_ID}}}",
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
        out += [f"## {s.title} {{#{s.key}}}", "", body.strip(), ""]
    return Composed("\n".join(out).rstrip() + "\n", problems)


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
    # The template does not have the section: an edit added it.
    added: bool = False


def part_states(key: str, body: str, approved: bool) -> list[PartState]:
    """The decided/proposed state of a section of a spec version whose approach is
    ``approved`` (or not): decided only for the sections Oracle locks (its own parts),
    else once approved, and never for a section an edit added or for proposed acceptance
    criteria. The summary is decided like the engineering parts."""
    if key == "acceptance-criteria":
        out = [PartState(key, "product_requirement", True, DECIDED_PRD_LABEL, "decided")]
        if split_acceptance(body)[1] is not None:
            out.append(PartState(key, "proposed", False, PROPOSED_ACCEPTANCE_STATE, "proposed"))
        return out
    part = part_of(key)
    if key in ORACLE_PARTS:
        return [PartState(key, part, True, DECIDED_PRD_LABEL)]
    if part == "proposed":
        return [PartState(key, part, False, ADDED_LABEL, added=True)]
    return [PartState(key, part, approved, APPROVED_STATE if approved else PROPOSED_STATE)]


# The sections that show no state: the title and the "Full version" heading hold the
# document together (they are decided, and say where the rest comes from).
UNLABELLED = (TITLE_ID, FULL_ID)


def state_line(label: str) -> str:
    """A state label as the exports and the markdown show it: a paragraph of its own."""
    return f"**{label}**"


_STATE_LINES = frozenset(state_line(label) for label in STATE_LABELS)


def labelled_body(key: str, body: str, approved: bool) -> str:
    """A section's body with its state labels: at the top, and for the acceptance
    criteria also before the proposed half (an export renders this)."""
    if key in UNLABELLED:
        return body
    states = part_states(key, body, approved)
    if len(states) > 1:
        decided, proposed = split_acceptance(body)
        body = (
            f"{decided}\n\n{state_line(states[1].label)}\n\n{ACCEPTANCE_PROPOSED_LABEL}"
            f"\n\n{proposed}"
        )
    return f"{state_line(states[0].label)}\n\n{body}".rstrip()


def label_markdown(markdown: str, approved: bool) -> str:
    """A spec version's markdown with every section's state label after its heading (and
    before the proposed acceptance criteria). :func:`strip_state_labels` undoes it, so the
    markdown imports back as the same version."""
    try:
        draft = parse_draft(markdown)
    except DraftError:
        return markdown
    lines = draft.markdown.split("\n")
    inserts: list[tuple[int, list[str]]] = []
    starts = [s.line - 1 for s in draft.sections] + [len(lines)]
    for i, s in enumerate(draft.sections):
        if s.section_key in UNLABELLED:
            continue
        head = starts[i] + (0 if lines[starts[i]].lstrip().startswith("#") else 1)
        states = part_states(s.section_key, s.body_md, approved)
        inserts.append((head + 1, ["", state_line(states[0].label)]))
        if len(states) > 1:
            at = next(
                (
                    j
                    for j in range(head + 1, starts[i + 1])
                    if lines[j] == ACCEPTANCE_PROPOSED_LABEL and lines[j - 1] == ""
                ),
                None,
            )
            if at is not None:
                inserts.append((at, [state_line(states[1].label), ""]))
    for at, new in sorted(inserts, reverse=True):
        lines[at:at] = new
    return "\n".join(lines)


def strip_state_labels(markdown: str) -> str:
    """The markdown without Oracle's state labels (each with the blank line before it):
    they are shown, never stored, whoever wrote them."""
    lines = markdown.replace("\r\n", "\n").split("\n")
    out: list[str] = []
    for line in lines:
        if line.strip() in _STATE_LINES:
            if out and not out[-1].strip():
                out.pop()
            continue
        out.append(line)
    return "\n".join(out)


# E1 'Added sections, visible' (owner, 2026-10-20): Oracle's parts an edit may not add a
# section inside, and the note and labels an added heading may not take.
PRD_PART_TITLES = {k: SECTIONS_BY_KEY[k].title for k in PRD_PARTS}
_NOTE_PHRASES = ("decided in the approved prd", "decided with the prd")
_STATE_LIKE = re.compile(r"\b(?:decided|proposed)\s*·")
_EMPHASIS = re.compile(r"[*_`~]+")


def _plain(text: str) -> str:
    return " ".join(_EMPHASIS.sub("", text).lower().split())


_COMMENT = re.compile(r"<!--.*?-->", re.S)
_HEADING_LINE = re.compile(r"^ {0,3}#{1,6}(?:\s|$)", re.M)


def _comment_spans(text: str) -> bool:
    """A section's text opens a comment it does not close (or closes one it did not
    open), or holds a comment that hides a heading (one that ran into the next section)."""
    if any(_HEADING_LINE.search(m.group(0)) for m in _COMMENT.finditer(text)):
        return True
    rest = _COMMENT.sub("", text)
    return "<!--" in rest or "-->" in rest


def structure_problems(markdown: str) -> list[Problem]:
    """What an edit may not do with sections (every problem at once): add a section, or
    move one, inside the subtree of Product requirements, the acceptance criteria or
    Sources and data points, add one whose heading is Oracle's own (a part's title, its
    'Decided in the approved PRD' note, a state label), or leave an HTML comment open
    across sections."""
    try:
        draft = parse_draft(markdown)
    except DraftError:
        return []
    problems: list[Problem] = []
    owner: tuple[str, int] | None = None
    titles = {_plain(t): k for k, t in PRD_PART_TITLES.items()}
    for s in draft.sections:
        if _comment_spans(f"{s.heading}\n{s.body_md}"):
            problems.append(
                Problem(
                    "comment_across_sections",
                    "An HTML comment opens and closes within one section: it may not hide a "
                    "heading or run into the next section.",
                    s.section_key,
                )
            )
        if owner is not None and s.level <= owner[1]:
            owner = None
        if s.section_key in PRD_PART_TITLES:
            owner = (s.section_key, s.level)
            continue
        inside = owner[0] if owner is not None else None
        if inside is None and part_of(s.section_key) == "proposed":
            inside = titles.get(_plain(s.heading))
        if inside is not None:
            problems.append(
                Problem(
                    "section_inside_oracle_part",
                    f"Add your section outside {PRD_PART_TITLES[inside]}: Oracle writes it "
                    "from the approved PRD.",
                    s.section_key,
                )
            )
        elif part_of(s.section_key) == "proposed" and (
            any(p in _plain(s.heading) for p in _NOTE_PHRASES)
            or _STATE_LIKE.search(_plain(s.heading))
        ):
            problems.append(
                Problem(
                    "heading_takes_oracle_note",
                    "An added section's heading may not take Oracle's note ('Decided in the "
                    "approved PRD') or its Decided and Proposed labels.",
                    s.section_key,
                )
            )
    return problems


def _leading_label(body: str) -> str | None:
    first = body.strip().split("\n\n", 1)[0].strip()
    return first if first in SECTION_LABELS else None


def prd_parts(markdown: str) -> dict[str, object]:
    """What of a spec version Oracle writes and an edit may not change: (level, heading,
    body) of each of Oracle's sections, their order, the ones the brief lists, the labels
    on the engineering sections and the assumptions, and the front matter's ``spec``
    block (source and requirement ids) and title."""
    try:
        draft = parse_draft(markdown)
    except DraftError:
        return {}
    fm = draft.front_matter or {}
    out: dict[str, object] = {"front_matter": fm.get("spec"), "title": fm.get("title")}
    order: list[str] = []
    labels: set[tuple[str, str]] = set()
    for s in draft.sections:
        body = s.body_md.strip()
        if s.section_key in ORACLE_PARTS:
            if s.section_key == "acceptance-criteria":
                body = split_acceptance(body)[0]
            out[s.section_key] = (s.level, s.heading, body)
            order.append(s.section_key)
        part = part_of(s.section_key)
        if part in ("engineering_approach", "assumption"):
            labels.add((part, _leading_label(body) or ""))
    out["order"] = tuple(order)
    out["brief"] = tuple(k for k in draft.brief or [] if k in ORACLE_PARTS)
    out["labels"] = tuple(sorted(labels))
    return out


def expected_prd_parts(inputs: SpecInputs) -> dict[str, object]:
    """:func:`prd_parts` of the version :func:`compose` writes from ``inputs`` today."""
    stub = "\n\n".join(f"## {s.title} {{#{s.key}}}\n\n-" for s in agent_sections(inputs.depth))
    composed = compose(stub, inputs)
    return prd_parts(composed.markdown) if composed.markdown else {}


SLUG_RE = re.compile(r"[^a-z0-9]+")


def slugify(text: str, limit: int = 60) -> str:
    return SLUG_RE.sub("-", text.lower()).strip("-")[:limit].strip("-") or "spec"
