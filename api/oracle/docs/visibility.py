"""Who sees a document (H8, owner 2026-10-21 "Update view").

A document's ``visibility`` is ``company`` (every member, S3) or ``approvers`` (owners and
approvers only; an update is created with it). For a commenter or a viewer an
``approvers`` document is absent: a direct read is a 404, a list has no row for it, search
has no hit, and what hangs off it (feedback, comments, suggestions, discussions, Inbox
rows) is not shown either. A run's calls act as the run's creator (oracle.auth.deps), so a
run token reads such a document only when its run was started by an approver or owner,
and never in a run whose output every member reads (below).

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
an approval captured ("Publish <document> v<n>", H1) follows its document the same way,
as does a pricing memo's decision (H9, ``source_kind = 'pricing_memo_version'``), and so
does a decided decision's baseline ``decision`` entity (``Decision.entity_id``): absent
from the entity list, the graph, an entity read, its revisions, evidence, proposals and
conflicts, every edge to or from it, and every change event about it or whose record
names it (its ``affects`` edge, a batch, a trace that reached it), whatever reads them
(the web, MCP, a run). A change event of a hidden document (``document_id``) is hidden
with it.

A ritual pre-read is built with Oracle's view and stored once; each read drops the rows
of hidden decisions and documents (:func:`hidden_decision_ids`, :func:`hidden_document_ids`,
oracle.rituals.blocks.for_reader), and a run reads it as a commenter would, since what it
writes from it is shown to every member.

A run of a flow whose output every member reads (``FlowDef.member_output``: the ritual
summary, variance explanations, the competitive digest, request triage, a code map) reads
every tool as a commenter would, whoever started it (``Principal.as_member``, set from
the run's flow in oracle.auth.deps); its importer checks what it cites as a commenter
(:data:`MEMBER`); and what such a run wrote is withheld at read time from a reader to
whom it names something hidden (:func:`names_hidden`).

A new document's visibility comes from its kind (:func:`default_for`), on every path
that creates one (a template start, an import).
"""

import html
import re
import unicodedata
import uuid
from collections.abc import Iterable
from dataclasses import dataclass
from typing import Any

from sqlalchemy import (
    ColumnElement,
    Select,
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
from oracle.tenancy import TenantSession, current_tenant

COMPANY = "company"
APPROVERS = "approvers"
# The role an ``approvers`` document needs.
MIN_ROLE = "approver"
PRINCIPAL_KEY = "principal"
WORDS = {COMPANY: "Company", APPROVERS: "Owners and approvers"}
# H8: an update (H9: a pricing memo) is for owners and approvers until an owner opens it.
APPROVERS_KINDS = ("update", "pricing")


def default_for(kind: str) -> str:
    """A new document's visibility, from its kind."""
    return APPROVERS if kind in APPROVERS_KINDS else COMPANY


def restricted(principal: Any) -> bool:
    """Whether ``approvers`` documents are hidden from ``principal`` (None: Oracle's own
    work, which sees everything): a commenter or a viewer, and a run whose output every
    member reads (``as_member``), whoever started it."""
    if principal is None:
        return False
    return getattr(principal, "as_member", False) or not has_role(principal.role, MIN_ROLE)


class _Member:
    """A reader who sees what a commenter sees (:data:`MEMBER`)."""

    role = "commenter"
    as_member = True


# For Oracle's own checks of what it keeps for every member (an importer's refs):
# ``bind(session, MEMBER)`` makes the session's reads a commenter's.
MEMBER = _Member()


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
    session: AsyncSession,
    ids: Iterable[uuid.UUID | None] | None = None,
    *,
    as_member: bool = False,
) -> set[uuid.UUID]:
    """The documents (of ``ids``, or all) the session's principal may not see: empty for
    owners, approvers and Oracle's own sessions. ``as_member``: those a commenter may not
    see, whoever reads (what Oracle builds for every member)."""
    if not as_member and not restricted(principal_of(session)):
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


async def hidden_decision_ids(
    session: AsyncSession, ids: Iterable[uuid.UUID | None], *, as_member: bool = False
) -> set[uuid.UUID]:
    """The decisions of ``ids`` the session's principal may not see (the rule below,
    :func:`_decision_visible`): empty for owners, approvers and Oracle's own sessions.
    ``as_member``: those a commenter may not see, whoever reads."""
    if not as_member and not restricted(principal_of(session)):
        return set()
    wanted = {i for i in ids if i is not None}
    if not wanted:
        return set()
    from oracle.decisions.models import Decision

    decisions = Decision.__table__
    # A Core select: the tenant scope (oracle.tenancy) does not apply, so name it here.
    stmt = (
        select(decisions.c.id)
        .where(
            decisions.c.tenant_id == current_tenant(session),
            decisions.c.id.in_(wanted),
            not_(_decision_visible(decisions.c)),
        )
        .execution_options(oracle_all_documents=True)
    )
    return set(await session.scalars(stmt))


@dataclass(frozen=True)
class Hidden:
    """What the session's principal may not see, to check text Oracle wrote for every
    member (a summary, a variance draft) at read time: the hidden decisions (ids, baseline
    entity ids, numbers, titles) and documents (ids, slugs, titles)."""

    decision_ids: frozenset[uuid.UUID]
    document_ids: frozenset[uuid.UUID]
    ids: frozenset[str]
    numbers: frozenset[int]
    words: frozenset[str]

    def cites(
        self,
        decision_ids: Iterable[uuid.UUID | None] = (),
        document_ids: Iterable[uuid.UUID | None] = (),
    ) -> bool:
        return bool(self.decision_ids & set(decision_ids) or self.document_ids & set(document_ids))

    def names(self, text: str | None) -> bool:
        """Whether ``text`` names a hidden decision (``D-<n>``, its title, its id or its
        entity's) or a hidden document (its title, slug or id), whatever the case; an id
        also without its dashes. A title is found whatever its Unicode normalisation,
        whitespace, typographic or ASCII quotes and dashes, and in JSON or HTML escapes
        (#621 review: :func:`_fold`, :func:`_unescaped`). Paraphrase is not caught: a
        decision described without its number, title or id, a title shorter than
        ``_MIN_TITLE``, a one-word slug, a number written another way ("decision 7"), an
        id cut up or re-encoded. Those need
        the meaning of the text, which a read-time check does not have; a run that reads
        as a member never reads them, so only output written before #541 part 4/5 or by
        hand can hold them."""
        if not text:
            return False
        for folded in {_fold(t) for t in _unescaped(text)}:
            if any(i in folded for i in self.ids):
                return True
            if any(w in folded for w in self.words):
                return True
            if any(int(n) in self.numbers for n in _D_NUMBER.findall(folded)):
                return True
        return False

    def names_in(self, value: Any) -> bool:
        """Whether any string in ``value`` (a row: dicts, lists, their keys and values)
        :meth:`names` something hidden, each string checked as itself (#621 review: not
        as ``json.dumps`` of the row, which escapes non-ASCII characters and quotes)."""
        if isinstance(value, str):
            return self.names(value)
        if isinstance(value, dict):
            return any(self.names_in(k) or self.names_in(v) for k, v in value.items())
        if isinstance(value, list | tuple | set | frozenset):
            return any(self.names_in(v) for v in value)
        return value is not None and self.names(str(value))


_D_NUMBER = re.compile(r"\bD-(\d+)\b", re.IGNORECASE)
# #621 review: typographic quotes and dashes read as their ASCII forms, so a title is found
# whichever the text uses.
_TYPOGRAPHIC = str.maketrans(
    dict.fromkeys("\u2018\u2019\u201a\u201b\u2032", "'")
    | dict.fromkeys("\u201c\u201d\u201e\u201f\u2033", '"')
    | dict.fromkeys("\u2010\u2011\u2012\u2013\u2014\u2015\u2212", "-")
)
_SPACE = re.compile(r"\s+")
_JSON_ESCAPE = re.compile(r"\\(u[0-9a-fA-F]{4}|.)", re.DOTALL)
_JSON_CHARS = {"n": "\n", "t": "\t", "r": "\r", "b": "\b", "f": "\f"}


def _fold(text: str) -> str:
    """``text`` as titles are compared (#621 review): case-folded, NFKC-normalised,
    typographic quotes and dashes as ASCII, every run of whitespace one space."""
    folded = unicodedata.normalize("NFKC", text.casefold()).translate(_TYPOGRAPHIC)
    return _SPACE.sub(" ", folded).strip()


def _json_unescaped(text: str) -> str:
    """``text`` with JSON string escapes (``\\u2014``, ``\\"``, a surrogate pair) undone."""

    def one(m: re.Match[str]) -> str:
        e = m.group(1)
        return chr(int(e[1:], 16)) if e[0] == "u" else _JSON_CHARS.get(e, e)

    out = _JSON_ESCAPE.sub(one, text)
    return out.encode("utf-16", "surrogatepass").decode("utf-16", "replace")


def _unescaped(text: str) -> set[str]:
    """``text`` and its readings with JSON and HTML escapes undone (#621 review: a raw
    file, a JSON column or Markdown can carry a title escaped)."""
    out = {text, html.unescape(text)}
    if "\\" in text:
        j = _json_unescaped(text)
        out |= {j, html.unescape(j)}
    return out


# A title shorter than this is not looked for in text (it would match ordinary words).
_MIN_TITLE = 12


def _words_of(*titles: str | None) -> set[str]:
    out = set()
    for title in titles:
        for t in (title or "", (title or "").partition(": ")[2]):
            t = _fold(t)
            if len(t) >= _MIN_TITLE:
                out.add(t)
    return out


def _id_forms(*ids: uuid.UUID | None) -> set[str]:
    """An id as text, lower case, with and without its dashes."""
    return {f for i in ids if i is not None for f in (str(i).lower(), uuid.UUID(str(i)).hex)}


async def hidden_for_reader(session: AsyncSession, *, as_member: bool = False) -> Hidden | None:
    """What the session's principal may not see (:class:`Hidden`); None for owners,
    approvers and Oracle's own sessions, who see everything. ``as_member``: what a
    commenter may not see, whoever reads (what Oracle builds for every member)."""
    if not as_member and not restricted(principal_of(session)):
        return None
    from oracle.decisions.models import Decision

    decisions = Decision.__table__
    documents = Document.__table__
    # Core selects: the tenant scope (oracle.tenancy) does not apply, so name it here, or
    # every company's hidden titles and numbers would hide (and reveal) text in this one.
    tenant = current_tenant(session)
    d_rows = (
        await session.execute(
            select(decisions.c.id, decisions.c.number, decisions.c.title, decisions.c.entity_id)
            .where(decisions.c.tenant_id == tenant, not_(_decision_visible(decisions.c)))
            .execution_options(oracle_all_documents=True)
        )
    ).all()
    doc_rows = (
        await session.execute(
            select(documents.c.id, documents.c.slug, documents.c.title)
            .where(documents.c.tenant_id == tenant, documents.c.visibility != COMPANY)
            .execution_options(oracle_all_documents=True)
        )
    ).all()
    words: set[str] = set()
    ids: set[str] = set()
    for _id, _n, title, entity_id in d_rows:
        words |= _words_of(title)
        ids |= _id_forms(_id, entity_id)
    for _id, slug, title in doc_rows:
        words |= _words_of(title, slug if "-" in (slug or "") else None)
        ids |= _id_forms(_id)
    return Hidden(
        decision_ids=frozenset(r[0] for r in d_rows),
        document_ids=frozenset(r[0] for r in doc_rows),
        ids=frozenset(ids),
        numbers=frozenset(r[1] for r in d_rows),
        words=frozenset(words),
    )


@event.listens_for(TenantSession, "do_orm_execute")
def _add_visibility_criteria(state: ORMExecuteState) -> None:
    if not state.is_select or state.execution_options.get("oracle_all_documents"):
        return
    principal = state.session.info.get(PRINCIPAL_KEY)
    if not restricted(principal):
        return
    from oracle.baseline.models import Conflict, Edge, Entity, EntityRevision, Evidence, Proposal
    from oracle.decisions.models import Decision
    from oracle.v2.models import ChangeEvent

    state.statement = state.statement.options(
        with_loader_criteria(Document, lambda cls: cls.visibility == COMPANY, include_aliases=True),
        # The decision an approval of such a document captured (H1) names it: absent too.
        with_loader_criteria(Decision, _decision_visible, include_aliases=True),
        # As is the baseline entity of such a decision, and what hangs off it.
        with_loader_criteria(Entity, _entity_visible, include_aliases=True),
        with_loader_criteria(Edge, _edge_visible, include_aliases=True),
        *(
            with_loader_criteria(model, _attached_visible, include_aliases=True)
            for model in (EntityRevision, Evidence, Proposal, Conflict)
        ),
        # And a change event about such an entity or document, or whose record names one.
        with_loader_criteria(ChangeEvent, _change_visible, include_aliases=True),
    )


# The capture sources that name one version of a document.
VERSION_SOURCES = ("document_version", "pricing_memo_version")


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
            cls.source_kind.not_in(VERSION_SOURCES),
            cls.source_id.not_in(hidden_versions),
        ),
        or_(cls.run_id.is_(None), cls.run_id.not_in(hidden_runs)),
        not_(names_hidden),
    )


def _hidden_entities() -> Select[Any]:
    """The baseline entities of the decisions :func:`_decision_visible` hides."""
    from oracle.decisions.models import Decision

    decisions = Decision.__table__
    return select(decisions.c.entity_id).where(
        decisions.c.entity_id.is_not(None), not_(_decision_visible(decisions.c))
    )


def _hidden_edges() -> Select[Any]:
    from oracle.baseline.models import Edge

    edges = Edge.__table__
    hidden = _hidden_entities()
    return select(edges.c.id).where(or_(edges.c.src_id.in_(hidden), edges.c.dst_id.in_(hidden)))


def _entity_visible(cls: Any) -> ColumnElement[bool]:
    return or_(cls.type != "decision", cls.id.not_in(_hidden_entities()))


def _edge_visible(cls: Any) -> ColumnElement[bool]:
    hidden = _hidden_entities()
    return and_(cls.src_id.not_in(hidden), cls.dst_id.not_in(hidden))


def _attached_visible(cls: Any) -> ColumnElement[bool]:
    """A revision, evidence row, proposal or conflict on a hidden entity or edge."""
    return and_(
        or_(cls.entity_id.is_(None), cls.entity_id.not_in(_hidden_entities())),
        or_(cls.edge_id.is_(None), cls.edge_id.not_in(_hidden_edges())),
    )


def member_entity_visible(cls: Any) -> ColumnElement[bool]:
    """A baseline entity a commenter may see, whoever reads (what Oracle puts in the
    prompt of a run that reads as a member)."""
    return _entity_visible(cls)


def member_attached_visible(cls: Any) -> ColumnElement[bool]:
    """A revision, evidence row, proposal or conflict a commenter may see, whoever reads
    (a count Oracle builds for every member)."""
    return _attached_visible(cls)


def _change_visible(cls: Any) -> ColumnElement[bool]:
    """A change event whose subject is a hidden decision entity or document, whose record
    (``data``: the entity, an edge's ends, a batch's ids, the trace) holds a hidden
    decision entity's id anywhere, whole or inside a string (``entity:<id>``), or whose
    record's entity is a hidden decision's (``decision`` ``d-<n>``: an ``entity_deleted``
    event, once the entity and the decision's link to it are gone)."""
    from oracle.decisions.models import Decision

    decisions = Decision.__table__
    hidden = _hidden_entities()
    documents = Document.__table__
    names_hidden = (
        select(literal(1))
        .select_from(decisions)
        .where(
            decisions.c.entity_id.is_not(None),
            not_(_decision_visible(decisions.c)),
            cast(cls.data, Text).icontains(cast(decisions.c.entity_id, Text)),
        )
        .exists()
    )
    was_hidden = (
        select(literal(1))
        .select_from(decisions)
        .where(
            decisions.c.tenant_id == cls.tenant_id,
            cls.data["entity"]["type"].astext == "decision",
            cls.data["entity"]["key"].astext == func.concat("d-", decisions.c.number),
            not_(_decision_visible(decisions.c)),
        )
        .exists()
    )
    return and_(
        or_(cls.subject_id.is_(None), cls.subject_id.not_in(hidden)),
        or_(
            cls.document_id.is_(None),
            cls.document_id.not_in(select(documents.c.id).where(documents.c.visibility != COMPANY)),
        ),
        not_(names_hidden),
        not_(was_hidden),
    )
