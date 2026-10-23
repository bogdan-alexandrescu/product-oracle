"""Shared fixtures for the tech brief tests (F5-1): the contract's sample file, a
baseline with two features and their requirements, and a run flow whose Engineering
check segment writes tech_briefs.yaml (F4 adds that segment to the real flow; until
then the tests stand it in). Synthetic placeholders only."""

import dataclasses
import uuid

from oracle.baseline.models import Edge, Entity
from oracle.runs import flows
from oracle.swarm import FakeRuntime
from oracle.swarm.fake import document_of
from oracle.tenancy import tenant_session

SAMPLE = """\
version: 1
code_map:
  used: true
  repos:
    - {repo: "org/app", commit: "3f2c9a1", as_of: "2026-10-18T10:00:00Z"}
features:
  - feature: feature-a
    title: "Feature A"
    approach: "Add an invoice endpoint to the billing module and reuse notifications."
    touches:
      - {area: "api/billing", kind: module, change: change, ref: "module:billing"}
      - {area: "POST /v1/invoices", kind: api, change: new, ref: null}
    reuse: ["module:notifications"]
    risks:
      - {risk: "Invoices are written by two jobs", level: medium, mitigation: "One writer"}
    questions:
      - {id: q1, question: "Can the nightly job run hourly?", why: "Freshness", blocking: true}
    size: m
    size_why: "Two endpoints and one migration"
    depends_on: [feature-b]
    assumptions: []
  - feature: feature-b
    title: "Feature B"
    approach: "Extend the notifications module with a digest."
    touches:
      - {area: "api/notifications", kind: module, change: change, ref: "module:notifications"}
    reuse: []
    risks: []
    questions: []
    size: s
    size_why: "One module"
    depends_on: []
    assumptions: []
"""

FEATURES = ("feature-a", "feature-b")
CODE_MAP = {"module:billing", "module:notifications"}

# A brief written without a shared code map: no refs, assumptions instead.
NO_MAP = """\
version: 1
code_map: {used: false, repos: []}
features:
  - feature: feature-a
    title: "Feature A"
    approach: "Assume a billing module exists; add an invoice endpoint."
    touches:
      - {area: "billing", kind: module, change: change, ref: null}
    reuse: []
    risks: []
    questions: []
    size: l
    size_why: "Unknown code"
    depends_on: []
    assumptions: ["A billing module exists"]
  - feature: feature-b
    title: "Feature B"
    approach: "Assume notifications can send a digest."
    touches: []
    reuse: []
    risks: []
    questions: []
    size: xs
    size_why: "Copy change"
    depends_on: []
    assumptions: ["Notifications send email"]
"""


async def seed_features(tenant_id: uuid.UUID) -> dict[str, uuid.UUID]:
    """feature-a with two requirements, feature-b with one; ids by key."""
    ids: dict[str, uuid.UUID] = {}
    async with tenant_session(tenant_id) as s:
        specs = [
            ("feature", "feature-a", "Feature A"),
            ("feature", "feature-b", "Feature B"),
            ("requirement", "req-a1", "Requirement A1"),
            ("requirement", "req-a2", "Requirement A2"),
            ("requirement", "req-b1", "Requirement B1"),
        ]
        for type_, key, title in specs:
            e = Entity(type=type_, key=key, title=title, status="confirmed", origin="user")
            s.add(e)
            await s.flush()
            ids[key] = e.id
        for req, feature in (("req-a1", "feature-a"), ("req-a2", "feature-a"),
                             ("req-b1", "feature-b")):  # fmt: skip
            s.add(
                Edge(src_id=ids[req], dst_id=ids[feature], type="part_of", status="confirmed",
                     origin="user")
            )  # fmt: skip
        await s.commit()
    return ids


ENG_CHECK = flows.SegmentDef(
    name="eng_check",
    title="Engineering check",
    roles=("architect",),
    scopes=(*flows.READ, "read:documents"),
    outputs=(flows.BRIEFS_FILE,),
    checkpoint="eng_review",
    task=flows.TECH_BRIEF_TASK,
    tools=("get_baseline", "search"),
)


def flow_with_eng_check() -> flows.FlowDef:
    """baseline_to_prd with the Engineering check after the feature set: the stand-in in
    place of F4's segment, which runs with its stop off too (F4 skips its own whole)."""
    base = flows.FLOWS["baseline_to_prd"]
    segments = [s for s in base.segments if s.name != "eng_review"]
    at = next(i for i, s in enumerate(segments) if s.name == "feature_set") + 1
    segments.insert(at, ENG_CHECK)
    return dataclasses.replace(base, segments=tuple(segments))


class BriefsRuntime(FakeRuntime):
    """The fake runtime whose feature set is the briefs' two features (C6's format, for
    the run's document): F4's Engineering check checks the briefs against the run's
    approved scope."""

    async def artifacts(self, workflow_id: str, steps=None) -> dict[str, str]:
        files = await super().artifacts(workflow_id, steps)
        record = self._record(workflow_id)
        if record.segment != "feature_set" or record.outcome.artifacts is not None:
            return files
        document = document_of(record.spec.steps[-1].prompt)
        files["feature_set.yaml"] = (
            "version: 1\n" + (f"document: {document}\n" if document else "") + "features:\n"
            "  - {key: feature-a, title: Feature A, summary: Invoices by email, goals: [],\n"
            "     depends_on: [feature-b], confidence: 0.8, requirements: []}\n"
            "  - {key: feature-b, title: Feature B, summary: A notifications digest, goals: [],\n"
            "     depends_on: [], confidence: 0.8, requirements: []}\n"
            "excluded: []\n"
        )
        return files
