"""Who sees a document (H8, owner 2026-10-21 "Update view").

A document's ``visibility`` is ``company`` (every member, S3) or ``approvers`` (owners and
approvers only; an update is created with it). For a commenter or a viewer an
``approvers`` document is absent: a direct read is a 404, a list has no row for it, search
has no hit, and what hangs off it (feedback, comments, suggestions, discussions, Inbox
rows) is not shown either. A run's calls act as the run's creator (oracle.auth.deps), so a
run token reads such a document only when its run was started by an approver or owner.

The rule lives here only:

- :func:`visible_to` is the SQL clause a query adds; :func:`can_see` the same rule on a
  loaded row;
- :func:`bind` puts the request's principal on its session (``oracle.auth.deps.get_db``),
  and every ORM SELECT on that session then gets :func:`visible_to` for
  :class:`~oracle.docs.models.Document` wherever it appears, joins included, as the
  tenant scope is added (oracle.tenancy). A new read path that loads documents through
  the ORM cannot forget it.

A read that reaches a document's rows without selecting :class:`Document` (a comment by
id, an Inbox row) checks :func:`hidden_document_ids` or joins the document. The decision
an approval captured ("Publish <document> v<n>", H1) follows its document the same way.
"""

import uuid
from collections.abc import Iterable
from typing import Any

from sqlalchemy import (
    ColumnElement,
    Text,
    and_,
    cast,
    column,
    event,
    func,
    literal,
    not_,
    or_,
    select,
    true,
)
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import ORMExecuteState, Session, with_loader_criteria

from oracle.authz import has_role
from oracle.docs.models import Document, DocumentVersion
from oracle.tenancy import TenantSession

COMPANY = "company"
APPROVERS = "approvers"
# The role an ``approvers`` document needs.
MIN_ROLE = "approver"
PRINCIPAL_KEY = "principal"
WORDS = {COMPANY: "Company", APPROVERS: "Owners and approvers"}


def restricted(principal: Any) -> bool:
    """Whether ``approvers`` documents are hidden from ``principal`` (None: Oracle's own
    work, which sees everything)."""
    return principal is not None and not has_role(principal.role, MIN_ROLE)


def visible_to(principal: Any) -> ColumnElement[bool]:
    """The documents ``principal`` may see, as a WHERE clause on :class:`Document`."""
    if not restricted(principal):
        return true()
    return Document.visibility == COMPANY


def can_see(principal: Any, document: Document) -> bool:
    return not restricted(principal) or document.visibility == COMPANY


def bind(session: AsyncSession | Session, principal: Any) -> None:
    """Every read on ``session`` follows ``principal``'s view from now on."""
    session.info[PRINCIPAL_KEY] = principal


def principal_of(session: AsyncSession | Session) -> Any:
    return session.info.get(PRINCIPAL_KEY)


async def hidden_document_ids(
    session: AsyncSession, ids: Iterable[uuid.UUID | None] | None = None
) -> set[uuid.UUID]:
    """The documents (of ``ids``, or all) the session's principal may not see: empty for
    owners, approvers and Oracle's own sessions."""
    if not restricted(principal_of(session)):
        return set()
    wanted = {i for i in ids if i is not None} if ids is not None else None
    if wanted is not None and not wanted:
        return set()
    stmt = (
        select(Document.id)
        .where(Document.visibility != COMPANY)
        .execution_options(oracle_all_documents=True)
    )
    if wanted is not None:
        stmt = stmt.where(Document.id.in_(wanted))
    return set(await session.scalars(stmt))


@event.listens_for(TenantSession, "do_orm_execute")
def _add_visibility_criteria(state: ORMExecuteState) -> None:
    if not state.is_select or state.execution_options.get("oracle_all_documents"):
        return
    principal = state.session.info.get(PRINCIPAL_KEY)
    if not restricted(principal):
        return
    from oracle.decisions.models import Decision

    state.statement = state.statement.options(
        with_loader_criteria(Document, lambda cls: cls.visibility == COMPANY, include_aliases=True),
        # The decision an approval of such a document captured (H1) names it: absent too.
        with_loader_criteria(Decision, _decision_visible, include_aliases=True),
    )


def _decision_visible(cls: Any) -> ColumnElement[bool]:
    """A decision about an approvers-only document is hidden with it, whatever recorded it:
    the approval of one of its versions, a stop of a run on it (a checkpoint record), or
    any decision naming it, or one of its versions, as a subject."""
    # Core tables, not the mapped classes: the Document criterion above must not apply
    # inside these subqueries.
    from oracle.runs.models import Run

    versions = DocumentVersion.__table__
    documents = Document.__table__
    runs = Run.__table__
    hidden_docs = select(documents.c.id).where(documents.c.visibility != COMPANY)
    hidden_versions = select(versions.c.id).where(versions.c.document_id.in_(hidden_docs))
    hidden_runs = select(runs.c.id).where(runs.c.document_id.in_(hidden_docs))
    subject = (
        func.jsonb_array_elements(cls.subjects)
        .table_valued(column("value", JSONB))
        .alias("subject")
    )
    names_hidden = (
        select(literal(1))
        .select_from(subject)
        .where(
            or_(
                and_(
                    subject.c.value["kind"].astext == "document",
                    subject.c.value["id"].astext.in_(
                        select(cast(documents.c.id, Text)).where(documents.c.visibility != COMPANY)
                    ),
                ),
                and_(
                    subject.c.value["kind"].astext == "document_version",
                    subject.c.value["id"].astext.in_(
                        select(cast(versions.c.id, Text)).where(
                            versions.c.document_id.in_(hidden_docs)
                        )
                    ),
                ),
            )
        )
        .exists()
    )
    return and_(
        or_(
            cls.source_kind.is_(None),
            cls.source_kind != "document_version",
            cls.source_id.not_in(hidden_versions),
        ),
        or_(cls.run_id.is_(None), cls.run_id.not_in(hidden_runs)),
        not_(names_hidden),
    )
