"""The ``constraints.solutions`` module rendered in the draft format (pure functions).

Two sections, following the brief and full conventions (O1f, docs/brief-and-full.md):

- ``## Blockers and solution strategy {#constraints-solutions}``: the brief section, one
  slide: a row per blocker, most severe first, with the path taken;
- ``## Constraints, blockers and solution strategy {#constraints-solutions-detail}``: the
  full layer, one ``### <statement> {#blocker-<key>}`` sub-section per blocker with
  everything §6 lists.

Bodies state conclusions only. Evidence never appears inline (O1c): it comes back as
front matter ``citations`` and as lines for Sources and data points (evidence by section
and data points). User text is flattened to one line with citation markers and ``{#id}``
anchors removed, so nothing typed into a blocker can add a section or a citation.
"""

import re
import uuid
from dataclasses import dataclass, field
from datetime import datetime

from oracle.blockers.policy import LIMIT_KIND_LABELS
from oracle.blockers.schemas import BlockerCitation, BlockerGate, BlockerModuleRender, BlockerSpec
from oracle.docs.parser import strip_citations

MODULE_KEY = "constraints.solutions"
BRIEF_SECTION_ID = "constraints-solutions"
FULL_SECTION_ID = "constraints-solutions-detail"
BRIEF_HEADING = "Blockers and solution strategy"
FULL_HEADING = "Constraints, blockers and solution strategy"
BRIEF_ROWS = 6

APPROACH_LABELS = {
    "direct_remedy": "Direct remedy",
    "alternative_workflow": "Alternative UX or workflow",
    "architecture": "Architecture optimization",
    "partnership": "Approved partnership or commercial path",
    "operations": "Operations or process",
    "distribution": "Alternate distribution or integration",
}
STATUS_LABELS = {
    "open": "Open",
    "mitigating": "Mitigating",
    "resolved": "Resolved",
    "accepted_risk": "Risk accepted",
    "feasibility_only": "Feasibility experiment only",
}
SCALING_LABELS = {
    "tenants": "Companies",
    "agents": "Agents",
    "channels": "Channels",
    "quotas": "Quotas",
    "cost": "Cost",
    "blast_radius": "Blast radius",
}
# Source kinds (sources.models.SOURCE_KINDS, evidence link kinds) -> citation sources.
CITATION_SOURCES = {
    "upload": "upload",
    "github": "github",
    "slack": "slack",
    "notion": "notion",
    "fireflies": "fireflies",
    "google_docs": "gdocs",
    "web": "web",
}

# A Pandoc anchor "{#id ...}", or the "{#" of one left open. The body stops at a brace, so
# a flood of "{#" is scanned once (linear); an anchor nested in another ("{#{#x}id}")
# loses both openers, so stripping never assembles a new one.
_ANCHOR = re.compile(r"\{#[^{}]*+\}|\{#")


def section_id_for(key: str) -> str:
    return f"blocker-{key}"


@dataclass
class EvidenceRef:
    id: uuid.UUID
    # A citation source kind ("web", "slack", ...), None when it cannot be cited.
    source: str | None
    ref: str | None
    title: str | None = None
    excerpt: str | None = None
    retrieved_at: datetime | None = None

    @property
    def citation_id(self) -> str:
        return f"blk-{self.id.hex[:8]}"


@dataclass
class OptionIn:
    id: uuid.UUID
    title: str
    approach: str
    description: str | None
    technical_feasibility: str
    policy_feasibility: str
    compliance: str
    status: str
    details: dict
    selected_reason: str | None
    owner: str | None
    flagged: bool


@dataclass
class ExperimentIn:
    hypothesis: str
    method: str | None
    success_threshold: str | None
    owner: str | None
    decision_gate_at: datetime | None
    status: str
    result: str | None


@dataclass
class BlockerIn:
    key: str
    statement: str
    detail: str | None
    spec: BlockerSpec
    gate: BlockerGate
    owner: str | None = None
    impacted: list[str] = field(default_factory=list)
    options: list[OptionIn] = field(default_factory=list)
    experiments: list[ExperimentIn] = field(default_factory=list)
    evidence: list[EvidenceRef] = field(default_factory=list)
    # "Risk accepted by ... until ...: reason" or the feasibility scope, when one holds.
    decision_note: str | None = None


def _inline(text: str | None) -> str:
    """User text safe for one line of a section body: no citations, anchors or breaks."""
    if not text:
        return ""
    text = strip_citations(text)
    text = _ANCHOR.sub("", text)
    return " ".join(text.split())


def _cell(text: str | None) -> str:
    return _inline(text).replace("|", "\\|") or "-"


def _date(value: datetime | str | None) -> str:
    if value is None:
        return ""
    if isinstance(value, str):
        try:
            value = datetime.fromisoformat(value.replace("Z", "+00:00"))
        except ValueError:
            return _inline(value)
    return value.date().isoformat()


def _cap(text: str) -> str:
    return text[:1].upper() + text[1:] if text else text


def _path(b: BlockerIn) -> str:
    selected = next((o for o in b.options if o.status == "selected"), None)
    if b.spec.status == "resolved":
        return "Resolved" + (f": {_inline(selected.title)}" if selected else "")
    if b.spec.status == "accepted_risk":
        until = _date(b.spec.review_at)
        return "Risk accepted" + (f" until {until}" if until else "")
    if b.spec.status == "feasibility_only":
        gate = next((e.decision_gate_at for e in b.experiments if e.decision_gate_at), None)
        return "Feasibility experiment" + (f", decision {_date(gate)}" if gate else "")
    if selected:
        return _inline(selected.title)
    return "No path selected yet"


def _kind(spec: BlockerSpec, *, lower: bool = False) -> str:
    label = LIMIT_KIND_LABELS.get(spec.limit_kind, spec.limit_kind)
    if lower and not label.startswith("API"):
        label = label[:1].lower() + label[1:]
    return f"{label} ({_inline(spec.third_party)})" if spec.third_party else label


def render_brief(blockers: list[BlockerIn]) -> str:
    lines = [f"## {BRIEF_HEADING} {{#{BRIEF_SECTION_ID}}}", ""]
    if not blockers:
        lines.append(
            "No known blockers. Constraints found later are added here with their solution path."
        )
        return "\n".join(lines)
    lines += ["| Blocker | Kind | Severity | Status | Path |", "|---|---|---|---|---|"]
    for b in blockers[:BRIEF_ROWS]:
        lines.append(
            f"| [{_cell(b.statement)}](#{section_id_for(b.key)}) "
            f"| {_cap(b.spec.type)}, {_cell(_kind(b.spec, lower=True))} "
            f"| {_cap(b.spec.severity)} | {STATUS_LABELS[b.spec.status]} | {_cell(_path(b))} |"
        )
    if len(blockers) > BRIEF_ROWS:
        lines += [
            "",
            f"{len(blockers) - BRIEF_ROWS} more in the [full strategy](#{FULL_SECTION_ID}).",
        ]
    return "\n".join(lines)


def _bullet(label: str, value: str | None) -> str | None:
    value = _inline(value)
    return f"- **{label}:** {value}" if value else None


def _blocker_full(b: BlockerIn) -> list[str]:
    s = b.spec
    out = [f"### {_inline(b.statement) or b.key} {{#{section_id_for(b.key)}}}", ""]
    bullets = [
        f"- **Type:** {_cap(s.type)}. **Kind:** {_inline(_kind(s))}.",
        f"- **Severity:** {_cap(s.severity)}. **Status:** {STATUS_LABELS[s.status]}.",
        _bullet("Timing", s.timing),
        _bullet("Threshold", s.threshold),
        _bullet("Impacts", "; ".join([*b.impacted, *s.impacted_users])),
        _bullet("Owner", b.owner),
        _bullet("Review date", _date(s.review_at)),
    ]
    out += [x for x in bullets if x]
    if detail := _inline(b.detail):
        out += ["", detail]

    shown = [o for o in b.options if not o.flagged and o.compliance != "non_compliant"]
    ruled_out = len(b.options) - len(shown)
    out += ["", "#### Options", ""]
    if shown:
        out += [
            "| Option | Approach | Expected outcome | Cost | Effort | Technical | Policy "
            "| Risk | Residual limits | Status |",
            "|---|---|---|---|---|---|---|---|---|---|",
        ]
        for o in shown:
            d = o.details or {}
            out.append(
                f"| {_cell(o.title)} | {APPROACH_LABELS.get(o.approach, o.approach)} "
                f"| {_cell(d.get('expected_outcome'))} | {_cell(d.get('cost'))} "
                f"| {_cell(d.get('effort'))} | {_cap(o.technical_feasibility)} "
                f"| {_cap(o.policy_feasibility)} | {_cell(d.get('risk'))} "
                f"| {_cell(d.get('residual_limitations'))} | {_cap(o.status)} |"
            )
    else:
        out.append("No solution options recorded yet.")
    if ruled_out:
        noun = "option" if ruled_out == 1 else "options"
        out += ["", f"{ruled_out} {noun} ruled out: outside platform rules."]

    out += ["", "#### Decision", ""]
    selected = next((o for o in b.options if o.status == "selected"), None)
    if selected:
        d = selected.details or {}
        out.append(
            f"Selected: **{_inline(selected.title)}**. "
            f"Reason: {_inline(selected.selected_reason) or 'not given'}."
        )
        decision = [
            _bullet("Fallback", d.get("fallback")),
            _bullet("Monitoring signal", d.get("monitoring_signal")),
            _bullet("Scaling trigger", d.get("scaling_trigger")),
            _bullet("Corrective action", d.get("corrective_action")),
            _bullet("Review date", _date(d.get("review_at"))),
        ]
        if any(decision):
            out += [""] + [x for x in decision if x]
    else:
        out.append("No option selected yet.")
    fallbacks = [o for o in shown if o.status == "fallback"]
    if fallbacks:
        out += ["", "Fallback options: " + "; ".join(_inline(o.title) for o in fallbacks) + "."]
    if b.decision_note:
        out += ["", _inline(b.decision_note)]

    if b.experiments:
        out += ["", "#### Validation", ""]
        for e in b.experiments:
            parts = [f"**{_inline(e.hypothesis)}**"]
            if e.method:
                parts.append(f"Method: {_inline(e.method)}")
            if e.success_threshold:
                parts.append(f"Success threshold: {_inline(e.success_threshold)}")
            if e.owner:
                parts.append(f"Owner: {_inline(e.owner)}")
            if e.decision_gate_at:
                parts.append(f"Decision gate: {_date(e.decision_gate_at)}")
            parts.append(f"Status: {_cap(e.status)}")
            if e.result:
                parts.append(f"Result: {_inline(e.result)}")
            out.append("- " + ". ".join(parts) + ".")

    scaling = [(SCALING_LABELS[k], v) for k, v in s.scaling.model_dump().items() if v]
    if scaling:
        out += ["", "#### Scaling", ""]
        out += [f"- **{label}:** {_inline(v)}" for label, v in scaling]
    return out


def render_full(blockers: list[BlockerIn]) -> str:
    lines = [f"## {FULL_HEADING} {{#{FULL_SECTION_ID}}}", ""]
    if not blockers:
        lines.append("No known blockers or constraints are recorded for this document.")
        return "\n".join(lines)
    lines.append(
        "Each blocker with its classification, impact, the options compared, the path "
        "chosen and how it is validated, watched and revisited."
    )
    for b in blockers:
        lines += ["", *_blocker_full(b)]
    return "\n".join(lines)


def render(blockers: list[BlockerIn]) -> BlockerModuleRender:
    citations: dict[str, BlockerCitation] = {}
    by_section: dict[str, list[str]] = {BRIEF_SECTION_ID: [], FULL_SECTION_ID: []}
    data_points: list[str] = []
    for b in blockers:
        sid = section_id_for(b.key)
        ids: list[str] = []
        for ev in b.evidence:
            if not ev.source or not ev.ref:
                continue
            cid = ev.citation_id
            citations.setdefault(
                cid,
                BlockerCitation(
                    id=cid,
                    source=ev.source,
                    ref=ev.ref,
                    title=ev.title,
                    excerpt=ev.excerpt,
                    retrieved_at=ev.retrieved_at,
                ),
            )
            if cid not in ids:
                ids.append(cid)
        by_section[sid] = ids
        for key in (BRIEF_SECTION_ID, FULL_SECTION_ID):
            by_section[key] += [c for c in ids if c not in by_section[key]]
        if b.spec.threshold:
            point = f"{_inline(b.statement)}: threshold {_inline(b.spec.threshold)}"
            if b.spec.timing:
                point += f"; timing {_inline(b.spec.timing)}"
            point += f" (sources: {', '.join(ids)})" if ids else " (no source yet)"
            data_points.append(point)
    appendix = [f"Evidence by section for {FULL_HEADING.lower()}:", ""]
    for key, ids in by_section.items():
        appendix.append(f"- {key}: {', '.join(ids) if ids else 'no supporting sources yet'}")
    if data_points:
        appendix += ["", "Data points:", ""] + [f"- {p}" for p in data_points]
    return BlockerModuleRender(
        module_key=MODULE_KEY,
        brief_section_id=BRIEF_SECTION_ID,
        full_section_id=FULL_SECTION_ID,
        section_ids=[BRIEF_SECTION_ID, FULL_SECTION_ID, *(section_id_for(b.key) for b in blockers)],
        brief_markdown=render_brief(blockers),
        full_markdown=render_full(blockers),
        citations=list(citations.values()),
        evidence_by_section=by_section,
        data_points=data_points,
        appendix_markdown="\n".join(appendix),
    )
