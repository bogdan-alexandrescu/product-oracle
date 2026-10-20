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


def _leading_label(body: str) -> str | None:
    first = body.strip().split("\n\n", 1)[0].strip()
    return first if first in SECTION_LABELS else None


def prd_parts(markdown: str) -> dict[str, object]:
    """What of a spec version Oracle writes and an edit may not change: (level, heading,
    body) of each of Oracle's sections, their order, the ones the brief lists, the labels
    on the engineering sections and the assumptions, and the front matter's ``spec``
    block (source and requirement ids)."""
    try:
        draft = parse_draft(markdown)
    except DraftError:
        return {}
    out: dict[str, object] = {"front_matter": (draft.front_matter or {}).get("spec")}
    order: list[str] = []
    labels: set[tuple[str, str]] = set()
    for s in draft.sections:
        body = s.body_md.strip()
        if s.section_key in ORACLE_PARTS:
            if s.section_key == "acceptance-criteria":
                body = _PROPOSED_SPLIT.split(body, maxsplit=1)[0].rstrip()
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
