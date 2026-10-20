"""One row of every v2 table for a company, linked the way the lanes will link them.

Synthetic placeholders only.
"""

import hashlib
import uuid
from dataclasses import dataclass, field

from oracle.baseline.models import Entity
from oracle.docs.models import Document, DocumentVersion, Section
from oracle.templates.models import Template, TemplateVersion
from oracle.tenancy import tenant_session
from oracle.v2 import models as m
from oracle.v2.contract import contract_hash, contract_json, validate_contract

CONTRACT = {
    "id": "constraints.solutions",
    "version": "1.0.0",
    "title": "Constraints, Blockers & Solution Strategy",
    "policy": "required",
    "depends_on": ["goals.outcomes"],
    "outputs": ["prd"],
}


def sha(text: str) -> str:
    return hashlib.sha256(text.encode()).hexdigest()


@dataclass
class Seeded:
    tenant_id: uuid.UUID
    document_id: uuid.UUID
    version_id: uuid.UUID
    section_hash: str
    blocker_id: uuid.UUID
    requirement_id: uuid.UUID
    template_id: uuid.UUID
    # Table name -> id of its row.
    ids: dict[str, uuid.UUID] = field(default_factory=dict)


async def seed_v2(tenant_id: uuid.UUID, slug: str = "checkout-redesign") -> Seeded:
    async with tenant_session(tenant_id) as s:
        doc = Document(slug=slug, title="Checkout redesign PRD", kind="prd")
        s.add(doc)
        await s.flush()
        body = "Most users abandon at the shipping step."
        version = DocumentVersion(
            document_id=doc.id, number=1, markdown=f"# Goal {{#goal-trace}}\n{body}",
            content_hash=sha(body),
        )  # fmt: skip
        s.add(version)
        await s.flush()
        s.add(
            Section(
                version_id=version.id, section_key="goal-trace", ordinal=0, level=1,
                heading="Goal", body_md=body, body_text=body, content_hash=sha(body),
            )
        )  # fmt: skip
        template = Template(key="example-template", name="Example", kind="prd")
        s.add(template)
        await s.flush()
        s.add(TemplateVersion(template_id=template.id, version=1, body="# T {#t}\n"))
        blocker = Entity(
            type="constraint", key="api-rate-limit", title="Partner API rate limit",
            origin="user", attrs={"blocker": {"type": "hard", "limit_kind": "capacity"}},
        )  # fmt: skip
        requirement = Entity(
            type="requirement", key="saved-addresses", title="Saved addresses", origin="user"
        )
        s.add_all([blocker, requirement])
        await s.flush()

        contract = validate_contract(CONTRACT)
        module = m.ModuleDefinition(key=contract.id, title=contract.title, builtin=True)
        s.add(module)
        await s.flush()
        mv = m.ModuleVersion(
            module_id=module.id, version=contract.version, contract=contract_json(contract),
            contract_hash=contract_hash(contract),
        )  # fmt: skip
        assignment = m.TemplateModuleAssignment(
            template_id=template.id, module_key=contract.id, policy="required",
            section_ids=["risks"],
        )  # fmt: skip
        composition = m.DocumentComposition(document_id=doc.id, template=template.key)
        s.add_all([mv, assignment, composition])
        await s.flush()
        revision = m.CompositionRevision(
            composition_id=composition.id, number=1, status="working",
            modules=[{"key": contract.id, "version": "1.0.0", "policy": "required",
                      "included": True, "reason": "company policy", "order": 60}],
            inputs={"category": "platform"}, reason="initial",
        )  # fmt: skip
        intake = m.ProductIntake(
            title="Saved addresses", brief="Returning buyers retype addresses; fix that.",
            source_snapshot_ids=[uuid.uuid4()], document_id=doc.id,
        )  # fmt: skip
        s.add_all([revision, intake])
        await s.flush()
        gap = m.KnowledgeGap(
            intake_id=intake.id, category="success_metric", statement="No baseline metric",
            impact=["goals", "scope"], importance="critical", entity_ids=[requirement.id],
            section_keys=["goal-trace"], related_modules=[contract.id],
            stop_condition="A named metric with a baseline value",
        )  # fmt: skip
        s.add(gap)
        await s.flush()
        question = m.StakeholderQuestion(
            gap_id=gap.id, intake_id=intake.id, category="success_metric",
            prompt="Which metric shows this worked?", status="asked",
        )  # fmt: skip
        s.add(question)
        await s.flush()
        answer = m.StakeholderAnswer(question_id=question.id, kind="dont_know")
        decision = m.AssumptionDecision(
            gap_id=gap.id, document_id=doc.id, statement="Repeat checkout rate is the metric",
            decision="accept_assumption", rationale="Best available signal",
        )  # fmt: skip
        option = m.BlockerOption(
            blocker_id=blocker.id, title="Batch requests within the published quota",
            approach="architecture", compliance="compliant",
            details={"fallback": "Queue and retry within limits"},
        )  # fmt: skip
        s.add_all([answer, decision, option])
        await s.flush()
        experiment = m.FeasibilityExperiment(
            blocker_id=blocker.id, option_id=option.id, hypothesis="Batching halves calls"
        )
        s.add(experiment)
        await s.flush()
        event = m.BlockerResolutionEvent(
            blocker_id=blocker.id, option_id=option.id, experiment_id=experiment.id,
            kind="experiment_started", from_status="open", to_status="mitigating",
            actor="system",
        )  # fmt: skip
        change = m.ChangeEvent(
            subject_kind="document_section", document_id=doc.id, cause="section_edited",
            actor="system", subject_ref=f"{slug}@1#goal-trace",
        )  # fmt: skip
        link = m.DocumentSectionLink(
            document_id=doc.id, version_id=version.id, section_key="goal-trace",
            section_hash=sha(body), kind="implements", entity_id=requirement.id,
        )  # fmt: skip
        report = m.EvaluationReport(document_id=doc.id, version_id=version.id, evaluator="rules")
        request = m.ArtifactRequest(
            kind="tech_brief", title="Saved addresses tech brief", source_document_id=doc.id,
            source_version_id=version.id, requirement_ids=[requirement.id],
        )  # fmt: skip
        s.add_all([event, change, link, report, request])
        await s.flush()
        finding = m.EvaluationFinding(
            report_id=report.id, criterion="problem_clarity", status="warning",
            rationale="The user is named but the pain has one source",
        )  # fmt: skip
        av = m.ArtifactVersion(request_id=request.id, number=1, source_version_id=version.id)
        s.add_all([finding, av])
        await s.flush()
        output = m.ArtifactOutput(
            version_id=av.id, name="brief.md", media_type="text/markdown", size_bytes=5,
            sha256=sha("hello"), content="hello",
        )  # fmt: skip
        review = m.ArtifactReviewEvent(version_id=av.id, kind="comment", actor="system")
        dependency = m.ArtifactDependency(
            artifact_version_id=av.id, upstream_version_id=version.id,
            upstream_section_key="goal-trace", upstream_section_hash=sha(body),
        )  # fmt: skip
        s.add_all([output, review, dependency])
        await s.flush()
        rows = {
            "module_definitions": module, "module_versions": mv,
            "template_module_assignments": assignment, "document_compositions": composition,
            "composition_revisions": revision, "product_intakes": intake,
            "knowledge_gaps": gap, "stakeholder_questions": question,
            "stakeholder_answers": answer, "assumption_decisions": decision,
            "blocker_options": option, "feasibility_experiments": experiment,
            "blocker_resolution_events": event, "change_events": change,
            "document_section_links": link, "artifact_dependencies": dependency,
            "evaluation_reports": report, "evaluation_findings": finding,
            "artifact_requests": request, "artifact_versions": av,
            "artifact_outputs": output, "artifact_review_events": review,
        }  # fmt: skip
        await s.commit()
        return Seeded(
            tenant_id=tenant_id,
            document_id=doc.id,
            version_id=version.id,
            section_hash=sha(body),
            blocker_id=blocker.id,
            requirement_id=requirement.id,
            template_id=template.id,
            ids={name: row.id for name, row in rows.items()},
        )
