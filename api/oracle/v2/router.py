"""Thin read routes for the v2 tables: a list and a get per entity.

They exist so OpenAPI, the MCP tools (one per operation) and the web client cover the
new tables from wave 1 on. Write routes belong to the lanes, under the same paths.
Every route needs the viewer role; the tenant-scoped session keeps each company to its
own rows, so another company's id is a 404.

The routes are generated from :data:`RESOURCES`; each list takes the filters declared
there plus ``limit`` and ``offset``, and returns rows newest first. A filter typed
``Literal["me"]`` matches the signed-in user's id (``/questions?asked_to=me``). A lane may
register a reader's view of a resource (:func:`register_view`): rows the reader may not see
are left out (a get is 404), and the rest are returned as the view shapes them. A lane that
hides rows also registers the SQL that leaves them out (:func:`register_hidden`), which a
list applies before ``limit`` and ``offset``: pages never shift, so their size never
tells the reader where a hidden row is. A lane whose readers see a value other than the
stored column's registers how a filter on it reads (:func:`register_filter`).
"""

import inspect
import uuid
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field
from typing import Annotated, Any, Literal

from fastapi import APIRouter, Depends, HTTPException, Query, status
from pydantic import BaseModel
from sqlalchemy import select

from oracle.auth.deps import CurrentPrincipal, Principal, TenantDB
from oracle.authz import require_role
from oracle.db import Base
from oracle.v2 import models as m
from oracle.v2 import schemas as s

router = APIRouter(prefix="/v1", tags=["v2"], dependencies=[Depends(require_role("viewer"))])

MAX_LIMIT = 500

# path -> async (db, principal, rows) -> the rows' outputs the principal may see.
View = Callable[[Any, Principal, list[Any]], Awaitable[list[Any]]]
VIEWS: dict[str, View] = {}


# path -> async (db, principal, filters) -> a WHERE clause keeping only rows the
# principal may see, or None when nothing is hidden from them. ``filters``: the list
# call's own filters (column name -> value), so only rows the call may list are read.
Hidden = Callable[[Any, Principal, dict[str, Any]], Awaitable[Any]]
HIDDEN: dict[str, Hidden] = {}


# (path, filter name) -> async (db, principal, value) -> the WHERE clause a list call's
# filter applies, when the value readers see is not always the stored column's.
Filter = Callable[[Any, Principal, Any], Awaitable[Any]]
FILTERS: dict[tuple[str, str], Filter] = {}


def register_filter(path: str, name: str, fn: Filter) -> None:
    FILTERS[(path, name)] = fn


def register_view(path: str, view: View) -> None:
    VIEWS[path] = view


def register_hidden(path: str, hidden: Hidden) -> None:
    HIDDEN[path] = hidden


@dataclass(frozen=True)
class Resource:
    path: str
    model: type[Base]
    out: type[BaseModel]
    # Operation ids (and MCP tool names): list_<plural>, get_<singular>.
    plural: str
    singular: str
    # Query filter name -> its type; each filters the model column of the same name.
    filters: dict[str, Any] = field(default_factory=dict)
    detail: type[BaseModel] | None = None
    load_detail: Callable[..., Any] | None = None


async def _report_detail(db: Any, report: m.EvaluationReport) -> s.EvaluationReportDetail:
    findings = (
        await db.scalars(
            select(m.EvaluationFinding)
            .where(m.EvaluationFinding.report_id == report.id)
            .order_by(m.EvaluationFinding.criterion, m.EvaluationFinding.created_at)
        )
    ).all()
    out = s.EvaluationReportDetail.model_validate(report)
    out.findings = [s.EvaluationFindingOut.model_validate(f) for f in findings]
    return out


U = uuid.UUID | None
RESOURCES: list[Resource] = [
    Resource(
        "/modules",
        m.ModuleDefinition,
        s.ModuleDefinitionOut,
        "modules",
        "module",
        {"key": str | None, "builtin": bool | None},
    ),
    Resource(
        "/module-versions",
        m.ModuleVersion,
        s.ModuleVersionOut,
        "module_versions",
        "module_version",
        {"module_id": U},
    ),
    Resource(
        "/template-module-assignments",
        m.TemplateModuleAssignment,
        s.TemplateModuleAssignmentOut,
        "template_module_assignments",
        "template_module_assignment",
        {"template_id": U, "module_key": str | None},
    ),
    Resource(
        "/compositions",
        m.DocumentComposition,
        s.DocumentCompositionOut,
        "compositions",
        "composition",
        {"document_id": U},
    ),
    Resource(
        "/composition-revisions",
        m.CompositionRevision,
        s.CompositionRevisionOut,
        "composition_revisions",
        "composition_revision",
        {"composition_id": U, "status": s.CompositionRevisionStatus | None},
    ),
    Resource(
        "/intakes",
        m.ProductIntake,
        s.ProductIntakeOut,
        "intakes",
        "intake",
        {"status": s.IntakeStatus | None, "document_id": U},
    ),
    Resource(
        "/gaps",
        m.KnowledgeGap,
        s.KnowledgeGapOut,
        "knowledge_gaps",
        "knowledge_gap",
        {
            "intake_id": U,
            "document_id": U,
            "status": s.GapStatus | None,
            "category": s.GapCategory | None,
            "importance": s.Importance | None,
        },
    ),
    Resource(
        "/questions",
        m.StakeholderQuestion,
        s.StakeholderQuestionOut,
        "stakeholder_questions",
        "stakeholder_question",
        {
            "intake_id": U,
            "document_id": U,
            "gap_id": U,
            "status": s.QuestionStatus | None,
            # Questions asked of the signed-in person: the Inbox's Questions group (I3).
            "asked_to": Literal["me"] | None,
        },
    ),
    Resource(
        "/answers",
        m.StakeholderAnswer,
        s.StakeholderAnswerOut,
        "stakeholder_answers",
        "stakeholder_answer",
        {"question_id": U},
    ),
    Resource(
        "/assumption-decisions",
        m.AssumptionDecision,
        s.AssumptionDecisionOut,
        "assumption_decisions",
        "assumption_decision",
        {"document_id": U, "gap_id": U, "entity_id": U},
    ),
    Resource(
        "/blocker-options",
        m.BlockerOption,
        s.BlockerOptionOut,
        "blocker_options",
        "blocker_option",
        {"blocker_id": U, "status": s.BlockerOptionStatus | None},
    ),
    Resource(
        "/feasibility-experiments",
        m.FeasibilityExperiment,
        s.FeasibilityExperimentOut,
        "feasibility_experiments",
        "feasibility_experiment",
        {"blocker_id": U, "option_id": U, "status": s.ExperimentStatus | None},
    ),
    Resource(
        "/blocker-events",
        m.BlockerResolutionEvent,
        s.BlockerResolutionEventOut,
        "blocker_events",
        "blocker_event",
        {"blocker_id": U},
    ),
    Resource(
        "/change-events",
        m.ChangeEvent,
        s.ChangeEventOut,
        "change_events",
        "change_event",
        {"subject_kind": s.ChangeSubject | None, "subject_id": U, "document_id": U},
    ),
    Resource(
        "/section-links",
        m.DocumentSectionLink,
        s.DocumentSectionLinkOut,
        "section_links",
        "section_link",
        {"document_id": U, "version_id": U, "section_key": str | None, "entity_id": U},
    ),
    Resource(
        "/artifact-dependencies",
        m.ArtifactDependency,
        s.ArtifactDependencyOut,
        "artifact_dependencies",
        "artifact_dependency",
        {
            "artifact_version_id": U,
            "document_version_id": U,
            "upstream_version_id": U,
            "upstream_entity_id": U,
            "freshness": s.Freshness | None,
        },
    ),
    Resource(
        "/evaluation-reports",
        m.EvaluationReport,
        s.EvaluationReportOut,
        "evaluation_reports",
        "evaluation_report",
        {"document_id": U, "version_id": U},
        detail=s.EvaluationReportDetail,
        load_detail=_report_detail,
    ),
    Resource(
        "/evaluation-findings",
        m.EvaluationFinding,
        s.EvaluationFindingOut,
        "evaluation_findings",
        "evaluation_finding",
        {"report_id": U, "status": s.FindingStatus | None},
    ),
    Resource(
        "/artifact-requests",
        m.ArtifactRequest,
        s.ArtifactRequestOut,
        "artifact_requests",
        "artifact_request",
        {
            "source_document_id": U,
            "kind": s.ArtifactKind | None,
            "status": s.ArtifactRequestStatus | None,
        },
    ),
    Resource(
        "/artifact-versions",
        m.ArtifactVersion,
        s.ArtifactVersionOut,
        "artifact_versions",
        "artifact_version",
        {"request_id": U, "freshness": s.Freshness | None},
    ),
    Resource(
        "/artifact-outputs",
        m.ArtifactOutput,
        s.ArtifactOutputOut,
        "artifact_outputs",
        "artifact_output",
        {"version_id": U},
    ),
    Resource(
        "/artifact-review-events",
        m.ArtifactReviewEvent,
        s.ArtifactReviewEventOut,
        "artifact_review_events",
        "artifact_review_event",
        {"version_id": U},
    ),
]


def _list_endpoint(res: Resource) -> Callable[..., Any]:
    async def endpoint(db: TenantDB, principal: Principal, **params: Any) -> list[Any]:
        limit, offset = params.pop("limit"), params.pop("offset")
        stmt = select(res.model)
        filters: dict[str, Any] = {}
        for name, value in params.items():
            if value == "me":
                # An API token that acts for no user: nothing is asked of it.
                value = principal.user_id or uuid.UUID(int=0)
            if value is not None:
                filters[name] = value
        for name, value in filters.items():
            custom = FILTERS.get((res.path, name))
            if custom is not None:
                stmt = stmt.where(await custom(db, principal, value))
            else:
                stmt = stmt.where(getattr(res.model, name) == value)
        hidden = HIDDEN.get(res.path)
        if hidden is not None:
            visible = await hidden(db, principal, filters)
            if visible is not None:
                stmt = stmt.where(visible)
        stmt = stmt.order_by(res.model.created_at.desc(), res.model.id).limit(limit).offset(offset)
        rows = list((await db.scalars(stmt)).all())
        view = VIEWS.get(res.path)
        if view is not None:
            return await view(db, principal, rows)
        return [res.out.model_validate(r) for r in rows]

    kw = inspect.Parameter.KEYWORD_ONLY
    parameters = [
        inspect.Parameter("db", kw, annotation=TenantDB),
        inspect.Parameter("principal", kw, annotation=CurrentPrincipal),
    ]
    for name, annotation in res.filters.items():
        parameters.append(inspect.Parameter(name, kw, default=None, annotation=annotation))
    parameters += [
        inspect.Parameter(
            "limit", kw, default=100, annotation=Annotated[int, Query(ge=1, le=MAX_LIMIT)]
        ),
        inspect.Parameter("offset", kw, default=0, annotation=Annotated[int, Query(ge=0)]),
    ]
    endpoint.__signature__ = inspect.Signature(parameters)  # type: ignore[attr-defined]
    endpoint.__doc__ = f"List {res.plural.replace('_', ' ')}, newest first."
    return endpoint


def _get_endpoint(res: Resource) -> Callable[..., Any]:
    label = res.singular.replace("_", " ")

    async def endpoint(item_id: uuid.UUID, db: TenantDB, principal: CurrentPrincipal) -> Any:
        row = await db.get(res.model, item_id)
        if row is None:
            raise HTTPException(status.HTTP_404_NOT_FOUND, f"{label.capitalize()} not found")
        view = VIEWS.get(res.path)
        if view is not None:
            shown = await view(db, principal, [row])
            if not shown:
                raise HTTPException(status.HTTP_404_NOT_FOUND, f"{label.capitalize()} not found")
            return shown[0]
        if res.load_detail is not None:
            return await res.load_detail(db, row)
        return res.out.model_validate(row)

    endpoint.__doc__ = f"One {label} by id."
    return endpoint


for _res in RESOURCES:
    router.add_api_route(
        _res.path,
        _list_endpoint(_res),
        methods=["GET"],
        name=f"list_{_res.plural}",
        response_model=list[_res.out],
    )
    router.add_api_route(
        _res.path + "/{item_id}",
        _get_endpoint(_res),
        methods=["GET"],
        name=f"get_{_res.singular}",
        response_model=_res.detail or _res.out,
    )
