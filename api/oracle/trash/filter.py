"""Trashed rows are absent from every read (#482).

Every ORM SELECT on a tenant session gets ``deleted_at IS NULL`` for
:class:`~oracle.docs.models.Document`, :class:`~oracle.v2.models.ProductIntake` and
:class:`~oracle.runs.models.Run` wherever they appear (joins and relationship loads
included), and what hangs off a trashed one (its versions, feedback, discussions,
campaigns, change sets, publications, draft roadmaps, spec requests, a run's checkpoints
and segments, an intake's gaps and questions) is left out with it, as the tenant scope is
added (oracle.tenancy). Lists, direct reads (a 404), the Inbox, Home, Plan and the agents'
MCP reads all go through here; a new read path cannot forget it.

Only oracle.trash reads trashed rows, with the :data:`INCLUDE_TRASHED` execution option
(Trash itself, restore and the purge). tests/test_trash.py scans the code for reads that
would get around this (raw SQL or Core reads of these tables).
"""

from typing import Any

from sqlalchemy import ColumnElement, Table, and_, event, or_, select
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
    from oracle.review.models import DocumentPublication, FeedbackItem, ReviewCampaign
    from oracle.roadmap.models import DraftRoadmap, ProductTrack, RoadmapChangeSet
    from oracle.runs.models import Checkpoint, Run, RunSegment
    from oracle.v2.models import ArtifactRequest, KnowledgeGap, ProductIntake, StakeholderQuestion

    docs, runs, intakes = Document.__table__, Run.__table__, ProductIntake.__table__
    return {
        DocumentVersion: [("document_id", docs)],
        FeedbackItem: [("document_id", docs)],
        ReviewCampaign: [("document_id", docs)],
        DocumentPublication: [("document_id", docs)],
        RoadmapChangeSet: [("roadmap_document_id", docs)],
        DraftRoadmap: [("prd_document_id", docs)],
        ProductTrack: [("prd_document_id", docs)],
        ArtifactRequest: [("source_document_id", docs)],
        Discussion: [("document_id", docs), ("run_id", runs), ("intake_id", intakes)],
        Checkpoint: [("run_id", runs)],
        RunSegment: [("run_id", runs)],
        KnowledgeGap: [("intake_id", intakes)],
        StakeholderQuestion: [("intake_id", intakes)],
    }


_CRITERIA: dict[type, ColumnElement[bool]] = {}


def criteria() -> dict[type, ColumnElement[bool]]:
    """Mapped class -> the clause keeping only its live rows (built once: plain
    expressions, no bound values, so the statement cache keeps working)."""
    if not _CRITERIA:
        from oracle.docs.models import Document
        from oracle.runs.models import Run
        from oracle.v2.models import ProductIntake

        for entity in (Document, ProductIntake, Run):
            _CRITERIA[entity] = entity.deleted_at.is_(None)
        for entity, parents in _children().items():
            _CRITERIA[entity] = and_(
                *(
                    or_(getattr(entity, name).is_(None), getattr(entity, name).not_in(_trashed(t)))
                    for name, t in parents
                )
            )
    return _CRITERIA


@event.listens_for(TenantSession, "do_orm_execute")
def _leave_out_trash(state: ORMExecuteState) -> None:
    if not state.is_select or state.execution_options.get(INCLUDE_TRASHED):
        return
    state.statement = state.statement.options(
        *(
            with_loader_criteria(entity, clause, include_aliases=True)
            for entity, clause in criteria().items()
        )
    )
