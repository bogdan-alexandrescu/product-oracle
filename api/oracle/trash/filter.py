"""Trashed rows are absent from every read (#482).

Every ORM SELECT on a tenant session gets ``deleted_at IS NULL`` for
:class:`~oracle.docs.models.Document`, :class:`~oracle.v2.models.ProductIntake` and
:class:`~oracle.runs.models.Run` wherever they appear (joins and relationship loads
included), and what hangs off a trashed one (every row pointing at a trashed document:
its versions, feedback, discussions, notifications, campaigns, change sets, publications,
draft roadmaps, plan rows, a roadmap's public texts and checks, spec requests, a spec
request whose own tech brief is trashed; a run's checkpoints and segments; an intake's
gaps and questions) is left out with it, as
the tenant scope is added (oracle.tenancy). tests/test_trash.py walks the mapped models:
a column pointing at documents is followed here or exempt there with its reason.
Lists, direct reads (a 404), the Inbox, Home, Plan and the agents' MCP reads all go
through here; a new read path cannot forget it.

Only oracle.trash reads trashed rows, with the :data:`INCLUDE_TRASHED` execution option
(Trash itself, restore and the purge). tests/test_trash.py scans the code for reads that
would get around this (raw SQL or Core reads of these tables).
"""

from collections.abc import Callable
from typing import Any

from sqlalchemy import ColumnElement, Table, Text, and_, cast, event, literal_column, or_, select
from sqlalchemy.orm import ORMExecuteState, with_loader_criteria

from oracle.tenancy import TenantSession

INCLUDE_TRASHED = "oracle_include_trashed"


def _trashed(table: Table) -> Any:
    # Core tables, not the mapped classes: the criteria below must not apply inside
    # their own subquery.
    return select(table.c.id).where(table.c.deleted_at.is_not(None))


def _children() -> dict[type, list[tuple[str, Table]]]:
    """Mapped class -> (column holding the parent's id, the parent's table)."""
    from oracle.discussions.models import Discussion
    from oracle.docs.models import Document, DocumentVersion
    from oracle.jobs.models import LlmJob, LlmSuggestion
    from oracle.priorities.models import PrioritySnapshot
    from oracle.quality.models import OutcomeRecord
    from oracle.review.models import (
        DocumentPublication,
        DocumentReviewPolicy,
        FeedbackItem,
        Notification,
        ReviewCampaign,
        SectionPatch,
        SectionReviewState,
    )
    from oracle.roadmap.models import (
        DraftRoadmap,
        ProductTrack,
        RoadmapChangeSet,
        RoadmapItem,
        RoadmapPublicCheck,
        RoadmapPublicText,
        ScheduleBasis,
        TrackerRecord,
    )
    from oracle.runs.models import Checkpoint, Run, RunSegment
    from oracle.runs.scope_models import PrdScope
    from oracle.shares.models import ShareLink
    from oracle.simple.models import (
        RoadmapItemTask,
        SimpleActionItem,
        SimpleChange,
        SimpleDraft,
        SimpleOnePager,
        SimpleSessionDraft,
    )
    from oracle.staging.models import NextDraftChange
    from oracle.v2.models import (
        ArtifactRequest,
        AssumptionDecision,
        ChangeEvent,
        DocumentComposition,
        DocumentSectionLink,
        EvaluationReport,
        KnowledgeGap,
        ProductIntake,
        StakeholderQuestion,
    )

    docs, runs, intakes = Document.__table__, Run.__table__, ProductIntake.__table__
    return {
        DocumentVersion: [("document_id", docs)],
        FeedbackItem: [("document_id", docs)],
        ReviewCampaign: [("document_id", docs)],
        DocumentPublication: [("document_id", docs)],
        DocumentReviewPolicy: [("document_id", docs)],
        Notification: [("document_id", docs)],
        SectionPatch: [("document_id", docs)],
        SectionReviewState: [("document_id", docs)],
        NextDraftChange: [("document_id", docs)],
        LlmJob: [("document_id", docs)],
        LlmSuggestion: [("document_id", docs)],
        PrioritySnapshot: [("document_id", docs)],
        PrdScope: [("document_id", docs)],
        OutcomeRecord: [("document_id", docs)],
        ShareLink: [("document_id", docs)],
        RoadmapChangeSet: [("roadmap_document_id", docs)],
        RoadmapItem: [("roadmap_document_id", docs)],
        RoadmapPublicText: [("document_id", docs)],
        RoadmapPublicCheck: [("document_id", docs)],
        DraftRoadmap: [("prd_document_id", docs)],
        ProductTrack: [("prd_document_id", docs)],
        ScheduleBasis: [("prd_document_id", docs)],
        TrackerRecord: [("prd_document_id", docs)],
        ArtifactRequest: [("source_document_id", docs)],
        AssumptionDecision: [("document_id", docs)],
        ChangeEvent: [("document_id", docs)],
        DocumentComposition: [("document_id", docs)],
        DocumentSectionLink: [("document_id", docs)],
        EvaluationReport: [("document_id", docs)],
        Discussion: [("document_id", docs), ("run_id", runs), ("intake_id", intakes)],
        Checkpoint: [("run_id", runs)],
        RunSegment: [("run_id", runs)],
        KnowledgeGap: [("intake_id", intakes), ("document_id", docs)],
        StakeholderQuestion: [("intake_id", intakes), ("document_id", docs)],
        # Simple (#723): a trashed PRD's or roadmap's changes, working drafts, one-pager,
        # item tasks and action items leave Simple's reads with it.
        SimpleChange: [("document_id", docs)],
        SimpleDraft: [("document_id", docs)],
        SimpleSessionDraft: [("document_id", docs)],
        SimpleOnePager: [("document_id", docs)],
        RoadmapItemTask: [("roadmap_document_id", docs)],
        SimpleActionItem: [("roadmap_document_id", docs)],
    }


def _spec_document_live(cls: Any) -> ColumnElement[bool]:
    """A spec request whose own tech brief (``params["document_id"]``) is not trashed."""
    from oracle.docs.models import Document

    docs = Document.__table__
    spec = cls.params.op("->>", return_type=Text)(literal_column("'document_id'"))
    trashed = select(cast(docs.c.id, Text)).where(docs.c.deleted_at.is_not(None))
    return or_(spec.is_(None), spec.not_in(trashed))


def _live_parents(parents: list[tuple[str, Any]]) -> Callable[[Any], ColumnElement[bool]]:
    """The clause for a class (or an alias of it): each parent link empty or not trashed."""
    return lambda cls: and_(
        *(
            or_(getattr(cls, name).is_(None), getattr(cls, name).not_in(_trashed(t)))
            for name, t in parents
        )
    )


_CRITERIA: dict[type, Callable[[Any], ColumnElement[bool]]] = {}


def criteria() -> dict[type, Callable[[Any], ColumnElement[bool]]]:
    """Mapped class -> a function of the class, or of an alias of it, giving the clause that
    keeps only its live rows. Built once; no bound values, so the statement cache works."""
    if not _CRITERIA:
        from oracle.docs.models import Document
        from oracle.runs.models import Run
        from oracle.v2.models import ArtifactRequest, ProductIntake

        for entity in (Document, ProductIntake, Run):
            _CRITERIA[entity] = lambda cls: cls.deleted_at.is_(None)
        for entity, parents in _children().items():
            _CRITERIA[entity] = _live_parents(parents)
        request = _CRITERIA[ArtifactRequest]
        _CRITERIA[ArtifactRequest] = lambda cls: and_(request(cls), _spec_document_live(cls))
    return _CRITERIA


def _live(cls: Any) -> ColumnElement[bool]:
    """The live-rows clause for ``cls``: a mapped class, or the alias a join used, so the
    clause names the alias's own columns."""
    return next(fn for entity, fn in criteria().items() if entity.__table__ is cls.__table__)(cls)


@event.listens_for(TenantSession, "do_orm_execute")
def _leave_out_trash(state: ORMExecuteState) -> None:
    if not state.is_select or state.execution_options.get(INCLUDE_TRASHED):
        return
    # One function for every class: SQLAlchemy caches a criteria function by its code, so
    # per-class closures would all get the first class's clause.
    state.statement = state.statement.options(
        *(
            with_loader_criteria(entity, lambda cls: _live(cls), include_aliases=True)
            for entity in criteria()
        )
    )
