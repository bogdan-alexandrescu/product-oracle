"""The publish check and the immutable publish transaction (CR-06, build prompt §9,
§16.11 and §16.17).

``publish_check`` lists everything that blocks publishing a version; ``publish`` runs
the same check under the document's row lock and either refuses (nothing written) or
writes one :class:`~oracle.review.models.DocumentPublication`.

A publish is refused for:

- a version the decider has not approved (or approved by someone other than the
  designated decider), a version approver or a designated decider who is no longer an
  approver (approvals count only while the approver still is one, read now:
  ``oracle.review.state.standing``);
- missing required sections (template, composition and policy);
- stale or missing mandatory approvals: each section the policy requires must be
  approved on its current revision, and every mandatory reviewer must have approved it
  (no unanimity unless the company configures mandatory reviewers);
- an open critical change request (T2: a critical unresolved blocker);
- a hard readiness check that is critical (``oracle.readiness.evaluate``; a critical
  unresolved blocker, a failed security or policy check). Advisory results never block
  (T2);
- invalidated source permissions: evidence of the version (section links to items,
  baseline evidence and entities, and citations by normalized URL, item id, evidence
  id or external id) from a
  source item that was deleted, whose connection was revoked or deleted, or that a
  ``source_permission`` change event (a revocation tombstone) revoked;
- a version already published;
- a superseded version (a newer one exists), unless the company turned the
  ``publish_latest_only`` setting off;
- a template whose required sections cannot be read (unknown template or version):
  it fails closed.

A publication pins the version (its markdown and content hash), the template version,
the composition revision, the last approval and the decider, every section's
approval, the evidence snapshot (citations and section links), the Sources and data
points appendix, the pushback override log, the readiness results and the rendered
HTML (full, brief and deck). A trigger refuses any UPDATE of the row, so later edits
and source updates never change it; its exports are served from the stored HTML.
"""

import hashlib
import json
import re
import string
import uuid
from collections import defaultdict
from typing import TYPE_CHECKING, Any
from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit

from sqlalchemy import delete, func, or_, select, text
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from oracle import audit, changes, readiness
from oracle.baseline.models import Evidence
from oracle.connections.models import Connection
from oracle.docs.models import Citation, Document, DocumentVersion, Section
from oracle.jobs.models import LlmSuggestion
from oracle.readiness import CheckOutcome, ReadinessContext
from oracle.review.models import (
    DocumentPublication,
    FeedbackItem,
    SectionReviewState,
)
from oracle.review.schemas import (
    PublishCheckOut,
    PublishProblem,
    ReadinessResultOut,
    SectionStatesOut,
)
from oracle.review.state import (
    counting_history,
    current_composition,
    effective_policy,
    required_sections,
    revoked_grants,
    section_states,
    standing,
    template_required_sections,
)
from oracle.sources.models import Source, SourceItem
from oracle.v2.models import ChangeEvent, DocumentSectionLink

if TYPE_CHECKING:
    from oracle.auth.deps import Principal

# The hard readiness check this lane registers (the review invariants, for the
# readiness dashboard); the publish check computes them itself and skips it.
REVIEW_CHECK_KEY = "review_approvals"
# ``source_permission`` change-event causes that revoke and that restore access. A
# lane recording a permission change uses one of these, with ``subject_id`` the source
# or source item id (or ``document_id`` the document it affects).
REVOKING_CAUSES = frozenset(
    {
        "revoked",
        "permission_revoked",
        "source_revoked",
        "source_deleted",
        "connection_revoked",
        "acl_narrowed",
    }
)
RESTORING_CAUSES = frozenset({"restored", "permission_restored", "granted"})
MANIFEST_FORMAT = 1
PUBLISH_LATEST_ONLY = "publish_latest_only"


class PublishRefusedError(Exception):
    def __init__(self, check: PublishCheckOut, message: str | None = None):
        self.check = check
        codes = ", ".join(dict.fromkeys(b.code for b in check.blockers))
        super().__init__(message or f"publish refused: {codes}")


# --- the review gate lock ---------------------------------------------------------------


async def gate_lock(db: AsyncSession, *, shared: bool) -> None:
    """The company's review gate, a transaction-scoped advisory lock. A publish takes it
    shared (with the document's row lock), company-wide changes the gate reads take it
    exclusively: source revocations, the company review policy and publish settings. So
    nothing those change commits while a publish renders."""
    from oracle.tenancy import current_tenant

    fn = "pg_advisory_xact_lock_shared" if shared else "pg_advisory_xact_lock"
    await db.execute(
        text(f"SELECT {fn}(hashtextextended(:k, 0))"),
        {"k": f"oracle-review-gate:{current_tenant(db)}"},
    )


async def lock_document(db: AsyncSession, document_id: uuid.UUID) -> Document | None:
    """The document's row lock: the publish lock section verdicts, approvals and policy
    changes take too, so none of them commits while a publish renders."""
    return await db.scalar(
        select(Document)
        .where(Document.id == document_id)
        .with_for_update()
        .execution_options(populate_existing=True)
    )


# --- source permissions -------------------------------------------------------------


# Query parameters that only track a click; they never name another page.
TRACKING_PARAMS = frozenset({"fbclid", "gclid", "dclid", "msclkid", "mc_cid", "mc_eid", "_hsenc"})
# A citation's ``source`` and the source kinds its external ids come from.
CITATION_SOURCE_KINDS = {"gdocs": "google_docs"}
# Google Docs, Sheets, Slides, Forms and Drive files: one document whatever the view
# (/edit, /view, /preview, a /u/<n> account prefix) and the share parameter (usp).
GOOGLE_HOSTS = frozenset({"docs.google.com", "drive.google.com"})
_GOOGLE_DOC = re.compile(
    r"/(document|spreadsheets|presentation|forms|file|drawings)(?:/u/\d+)?/d/([^/]+)(?:/.*)?"
)
GOOGLE_VIEW_PARAMS = frozenset({"usp"})
_ESCAPE = re.compile(r"%([0-9A-Fa-f]{2})")
_UNRESERVED = frozenset(string.ascii_letters + string.digits + "-._~")


def _escapes(path: str) -> str:
    """Percent-escapes in one form: an unreserved character decoded, others upper-cased."""

    def fix(m: re.Match[str]) -> str:
        ch = chr(int(m.group(1), 16))
        return ch if ch in _UNRESERVED else "%" + m.group(1).upper()

    return _ESCAPE.sub(fix, path)


def normalize_url(url: str) -> str:
    """A URL as citations and source items are matched: ``http`` is ``https``, the host
    lower-cased without ``www.``, the default port, fragment and trailing slash dropped,
    percent-escapes in one form, the query without tracking parameters (``utm_*``, click
    ids) and sorted; a Google document is its id whatever the view (``/edit``,
    ``/view``, ``?usp=``). Idempotent, so URLs a tombstone recorded with an earlier
    normalization still match."""
    raw = url.strip()
    try:
        parts = urlsplit(raw)
    except ValueError:
        return raw
    if not parts.scheme or not parts.netloc:
        return raw
    scheme = parts.scheme.lower()
    if scheme == "http":
        scheme = "https"
    host = (parts.hostname or "").lower().removeprefix("www.")
    try:
        port = parts.port
    except ValueError:
        port = None
    if port and port not in (80, 443):
        host = f"{host}:{port}"
    if parts.username or parts.password:
        auth = parts.username or ""
        host = f"{auth}@{host}"
    path = _escapes(parts.path).rstrip("/")
    google = host in GOOGLE_HOSTS
    if google and (doc := _GOOGLE_DOC.fullmatch(path)):
        path = f"/{doc.group(1)}/d/{doc.group(2)}"
    query = urlencode(
        sorted(
            (k, v)
            for k, v in parse_qsl(parts.query, keep_blank_values=True)
            if not k.lower().startswith("utm_")
            and k.lower() not in TRACKING_PARAMS
            and not (google and k.lower() in GOOGLE_VIEW_PARAMS)
        )
    )
    return urlunsplit((scheme, host, path, query, ""))


def external_key(value: str | None) -> str:
    """A provider's id as compared: a UUID in any spelling (undashed, uppercase, in
    braces, ``urn:uuid:``) as its canonical form, so a Notion page id cited one way
    matches the item stored another; anything else as is, stripped."""
    text_value = str(value or "").strip()
    try:
        return str(uuid.UUID(text_value))
    except ValueError:
        return text_value


def _hex32(value: Any) -> Any:
    """SQL: a stored id with dashes, braces and a ``urn:uuid:`` prefix removed,
    lowercased; a UUID in any spelling becomes its 32 hex digits."""
    return func.lower(func.regexp_replace(value, "^urn:uuid:|[{}-]", "", "gi"))


def _as_uuid(value: str | None) -> uuid.UUID | None:
    try:
        return uuid.UUID(str(value).strip()) if value else None
    except ValueError:
        return None


async def revocation_record(db: AsyncSession, source_ids: list[uuid.UUID]) -> dict[str, Any]:
    """What a revocation of these sources takes away, kept on its ``source_permission``
    event (a tombstone): the items' ids and normalized URLs, the baseline evidence from
    them, and the section links to them (which go with a hard delete)."""
    items = (
        await db.execute(
            select(SourceItem.id, SourceItem.url, SourceItem.external_id).where(
                SourceItem.source_id.in_(source_ids)
            )
        )
    ).all()
    item_ids = [i for i, _, _ in items]
    evidence_ids: list[uuid.UUID] = []
    links: list[DocumentSectionLink] = []
    if item_ids:
        evidence_ids = list(
            await db.scalars(select(Evidence.id).where(Evidence.source_item_id.in_(item_ids)))
        )
        links = list(
            await db.scalars(
                select(DocumentSectionLink).where(DocumentSectionLink.source_item_id.in_(item_ids))
            )
        )
    return {
        "source_ids": [str(i) for i in source_ids],
        "item_ids": [str(i) for i in item_ids],
        "urls": sorted({normalize_url(u) for _, u, _ in items if u}),
        "external_ids": sorted({x for _, _, x in items if x}),
        "evidence_ids": [str(i) for i in evidence_ids],
        "links": [
            {
                "id": str(link.id),
                "document_id": str(link.document_id),
                "version_id": str(link.version_id) if link.version_id else None,
                "section_key": link.section_key,
            }
            for link in links
        ],
    }


async def record_source_revocation(
    db: AsyncSession,
    principal: "Principal | None",
    sources: list[Source],
    cause: str,
    *,
    drop_links: bool,
) -> list[ChangeEvent]:
    """Record a ``source_permission`` revocation per source, before its items go (a
    deleted source or connection). Takes the review gate exclusively, so it never lands
    mid-publish. ``drop_links``: the items are about to be hard-deleted, so the section
    links that point only at them are removed (the tombstone keeps them)."""
    if not sources:
        return []
    await gate_lock(db, shared=False)
    events = []
    for source in sources:
        record = await revocation_record(db, [source.id])
        record.update({"source_kind": source.kind, "source_name": source.name})
        events.append(
            await changes.record_change(
                db,
                "source_permission",
                cause=cause,
                actor=principal,
                subject_id=source.id,
                subject_ref=f"source:{source.name}",
                data=record,
            )
        )
        if drop_links and record["item_ids"]:
            # A link to the item alone would break its target check (the item's foreign
            # key sets null); a link with an entity or evidence keeps those.
            only_item = (
                DocumentSectionLink.source_item_id.in_([uuid.UUID(i) for i in record["item_ids"]])
                & DocumentSectionLink.entity_id.is_(None)
                & DocumentSectionLink.evidence_id.is_(None)
            )
            await db.execute(delete(DocumentSectionLink).where(only_item))
    return events


async def _gate_on_revocation(db: AsyncSession, event: ChangeEvent) -> None:
    """A revocation any lane records through ``oracle.changes`` takes the review gate
    exclusively, so it commits before or after a publish, never during one."""
    if event.cause in REVOKING_CAUSES:
        await gate_lock(db, shared=False)


changes.register_handler(
    "review.source_permission_gate", _gate_on_revocation, subjects={"source_permission"}
)


async def _url_items(db: AsyncSession, urls: set[str]) -> list[SourceItem]:
    """Source items whose normalized URL is one of ``urls``."""
    hosts = {urlsplit(u).hostname for u in urls if "://" in u}
    hosts.discard(None)
    if not hosts:
        return []
    # Not indexed: a scan of the company's items by host, then an exact match on the
    # normalized URL (an indexed lookup needs a normalized-URL column; see the PR). The
    # host follows "://" or, in a URL with a user name, "@".
    candidates = await db.scalars(
        select(SourceItem).where(
            SourceItem.url.is_not(None),
            or_(
                *(
                    func.lower(SourceItem.url).contains(f"{p}{w}{h}")
                    for h in hosts
                    for w in ("", "www.")
                    for p in ("://", "@")
                )
            ),
        )
    )
    return [i for i in candidates if normalize_url(i.url) in urls]


async def _external_items(
    db: AsyncSession, refs: dict[tuple[str, str], set[str]]
) -> list[tuple[SourceItem, str]]:
    """Source items a citation names by external id: (citation source, ref) -> items of
    a source of that kind with that external id (any kind for a web citation)."""
    if not refs:
        return []
    wanted = {ref for _, ref in refs}
    hexes = {uuid.UUID(ref).hex for ref in wanted if _as_uuid(ref) is not None}
    match = SourceItem.external_id.in_(wanted)
    if hexes:
        # Stored ids are compared in canonical form too (a page id saved undashed).
        match = match | _hex32(SourceItem.external_id).in_(hexes)
    rows = (
        await db.execute(
            select(SourceItem, Source.kind)
            .join(Source, Source.id == SourceItem.source_id)
            .where(match)
        )
    ).all()
    return [
        (item, kind)
        for item, kind in rows
        if any(
            ref == external_key(item.external_id) and _same_kind(source, kind)
            for source, ref in refs
        )
    ]


def _same_kind(citation_source: str | None, source_kind: str | None) -> bool:
    if not citation_source or citation_source == "web" or not source_kind:
        return True
    return CITATION_SOURCE_KINDS.get(citation_source, citation_source) == source_kind


async def source_permission_problems(
    db: AsyncSession, document: Document, version: DocumentVersion
) -> list[PublishProblem]:
    """Evidence of the version from a revoked source. The version's evidence is followed
    back to source items: section links (to an item, to baseline evidence, to an
    entity and its evidence) and citations (by normalized URL or item id). An item is
    revoked when it was deleted, its connection revoked, a ``source_permission`` event
    revoked it or its source, or a revocation tombstone names it, its URL, the evidence
    or the link."""
    links = list(
        await db.scalars(
            select(DocumentSectionLink).where(
                DocumentSectionLink.document_id == document.id,
                (DocumentSectionLink.version_id == version.id)
                | DocumentSectionLink.version_id.is_(None),
            )
        )
    )
    item_keys: dict[uuid.UUID, set[str]] = defaultdict(set)
    url_keys: dict[str, set[str]] = defaultdict(set)
    evidence_keys: dict[uuid.UUID, set[str]] = defaultdict(set)
    link_keys: dict[uuid.UUID, set[str]] = defaultdict(set)
    entity_keys: dict[uuid.UUID, set[str]] = defaultdict(set)
    for link in links:
        link_keys[link.id].add(link.section_key)
        if link.source_item_id is not None:
            item_keys[link.source_item_id].add(link.section_key)
        if link.evidence_id is not None:
            evidence_keys[link.evidence_id].add(link.section_key)
        if link.entity_id is not None:
            entity_keys[link.entity_id].add(link.section_key)
    # Citations name their source by URL, by an item or evidence id, or by the item's
    # external id in its source.
    cite_sections: dict[str, set[str]] = defaultdict(set)
    for s in await db.scalars(select(Section).where(Section.version_id == version.id)):
        for key in s.citation_keys:
            cite_sections[key].add(s.section_key)
    external_keys: dict[tuple[str, str], set[str]] = defaultdict(set)
    for c in await db.scalars(select(Citation).where(Citation.version_id == version.id)):
        keys = cite_sections.get(c.cite_key, set())
        ref = (c.ref or "").strip()
        ref_id = _as_uuid(ref)
        if ref_id is not None:
            item_keys[ref_id] |= keys
            evidence_keys[ref_id] |= keys
            # A UUID can also be a provider's id (a Notion page id): an external id too.
            external_keys[(c.source, external_key(ref))] |= keys
        elif "://" in ref:
            url_keys[normalize_url(ref)] |= keys
        elif ref:
            external_keys[(c.source, external_key(ref))] |= keys
    for item, _ in await _external_items(db, external_keys):
        for (_, ref), cited in external_keys.items():
            if ref == external_key(item.external_id):
                item_keys[item.id] |= cited
    if evidence_keys or entity_keys:
        for e in await db.scalars(
            select(Evidence).where(
                Evidence.id.in_(list(evidence_keys)) | Evidence.entity_id.in_(list(entity_keys))
            )
        ):
            keys = evidence_keys[e.id] | entity_keys.get(e.entity_id, set())
            evidence_keys[e.id] = keys
            if e.source_item_id is not None:
                item_keys[e.source_item_id] |= keys
            if e.url:
                url_keys[normalize_url(e.url)] |= keys
    for item in await _url_items(db, set(url_keys)):
        item_keys[item.id] |= url_keys[normalize_url(item.url)]

    items = list(await db.scalars(select(SourceItem).where(SourceItem.id.in_(list(item_keys)))))
    sources = {
        s.id: s
        for s in await db.scalars(select(Source).where(Source.id.in_({i.source_id for i in items})))
    }
    connection_ids = {s.connection_id for s in sources.values() if s.connection_id}
    revoked_connections = set(
        await db.scalars(
            select(Connection.id).where(
                Connection.id.in_(connection_ids), Connection.status == "revoked"
            )
        )
    )
    events = await _revoking_events(db, document.id)
    by_subject = {e.subject_id for e in events}
    revoked: set[uuid.UUID] = set()
    keys: set[str] = set()
    for item in items:
        source = sources.get(item.source_id)
        if (
            item.deleted_at is not None
            or source is None
            or source.connection_id in revoked_connections
            or item.id in by_subject
            or item.source_id in by_subject
        ):
            revoked.add(item.id)
    # Linked items that no longer exist at all.
    existing = {x.id for x in items}
    revoked |= {
        link.source_item_id
        for link in links
        if link.source_item_id is not None and link.source_item_id not in existing
    }
    for i in revoked:
        keys |= item_keys.get(i, set())
    matched: list[ChangeEvent] = []
    for e in events:
        data = e.data or {}
        hit: set[str] = set()
        for i in data.get("item_ids") or []:
            item_id = _as_uuid(i)
            if item_id in item_keys:
                revoked.add(item_id)
                hit |= item_keys[item_id]
        for u in data.get("urls") or []:
            hit |= url_keys.get(normalize_url(u), set())
        for x in data.get("external_ids") or []:
            for (source, ref), cited in external_keys.items():
                if ref == external_key(x) and _same_kind(source, data.get("source_kind")):
                    hit |= cited
        for i in data.get("evidence_ids") or []:
            hit |= evidence_keys.get(_as_uuid(i), set())
        for link in data.get("links") or []:
            if link.get("document_id") == str(document.id) and link.get("version_id") in (
                None,
                str(version.id),
            ):
                hit.add(link.get("section_key"))
            hit |= link_keys.get(_as_uuid(link.get("id")), set())
        if hit or e.subject_id in existing or e.subject_id in {i.source_id for i in items}:
            matched.append(e)
        keys |= hit
    whole_document = [
        e
        for e in events
        if e.subject_id == document.id or (e.subject_id is None and e.document_id == document.id)
    ]
    if not revoked and not keys and not whole_document:
        return []
    keys.discard(None)
    problem = PublishProblem(
        code="source_permission_revoked",
        message="Evidence comes from a source whose permission was revoked; remove or "
        "replace it before publishing",
        section_keys=sorted(keys),
        ids=[*sorted(revoked, key=str), *(e.id for e in [*whole_document, *matched])],
    )
    problem.ids = list(dict.fromkeys(problem.ids))
    return [problem]


async def _revoking_events(db: AsyncSession, document_id: uuid.UUID) -> list[ChangeEvent]:
    """The company's ``source_permission`` events whose latest word on their subject is
    a revoke (only this document's when they name a document)."""
    rows = list(
        await db.scalars(
            select(ChangeEvent)
            .where(
                ChangeEvent.subject_kind == "source_permission",
                ChangeEvent.document_id.is_(None) | (ChangeEvent.document_id == document_id),
            )
            .order_by(ChangeEvent.created_at, ChangeEvent.id)
        )
    )
    last: dict[Any, ChangeEvent] = {}
    for e in rows:
        if e.cause in REVOKING_CAUSES or e.cause in RESTORING_CAUSES:
            last[e.subject_id or e.document_id] = e
    return [e for e in last.values() if e.cause in REVOKING_CAUSES]


# --- the check ----------------------------------------------------------------------


def _problem(code: str, message: str, **kw: Any) -> PublishProblem:
    return PublishProblem(code=code, message=message, **kw)  # type: ignore[arg-type]


async def review_problems(
    db: AsyncSession, document: Document, version: DocumentVersion, states: SectionStatesOut
) -> tuple[list[PublishProblem], list[PublishProblem], list[str], list[str]]:
    """Blockers and warnings from the review invariants, the required sections and the
    approval-required sections."""
    policy = await effective_policy(db, document)
    required = await required_sections(db, document, version, policy)
    blockers: list[PublishProblem] = []
    warnings: list[PublishProblem] = []
    # Approvers are who they are now (CR-06): a demoted or removed member, a revoked
    # token no longer approves; read at gate time, not only when the approval was given.
    _, lapsed = await counting_history(db, document.id, upto=version.number)
    why = await standing(
        db,
        [
            policy.decider_id,
            version.approved_by,
            version.approved_token_id,
            *policy.mandatory_reviewer_ids,
        ],
    )
    # The token or grant an approval came through: revoked (even outside the API), it
    # voids it.
    token_reason = why.get(version.approved_token_id) if version.approved_token_id else None
    if token_reason is None and version.approved_grant_id is not None:
        token_reason = (await revoked_grants(db, [version.approved_grant_id])).get(
            version.approved_grant_id
        )
    if policy.decider_id is not None and why.get(policy.decider_id):
        blockers.append(
            _problem(
                "decider_not_current",
                f"The designated decider {policy.decider_id} {why[policy.decider_id]}; change "
                "the review policy",
                ids=[policy.decider_id],
            )
        )
    if version.approved_at is None and version.approval_lapsed_at is not None:
        # Lapsed for good (C2): the approver was demoted or disabled, or the token revoked.
        by = version.approval_lapsed_by
        blockers.append(
            _problem(
                "version_approval_lapsed",
                f"Version {version.number} was approved by {by or 'someone'}, whose "
                "approval no longer counts and never will again "
                f"({version.approval_lapse_reason or 'lapsed'}); it needs an approval again",
                ids=[by] if by else [],
            )
        )
    elif version.approved_at is None:
        who = "the designated decider" if policy.decider_id else "an approver"
        blockers.append(
            _problem("version_not_approved", f"Version {version.number} needs {who}'s approval")
        )
    elif version.approved_by is None or why.get(version.approved_by) or token_reason:
        reason = (
            (why.get(version.approved_by) or token_reason) if version.approved_by else "is unknown"
        )
        blockers.append(
            _problem(
                "version_approval_lapsed",
                f"Version {version.number} was approved by {version.approved_by or 'someone'}, "
                f"who {reason}; it needs an approval again",
                ids=[version.approved_by] if version.approved_by else [],
            )
        )
    elif policy.decider_id is not None and version.approved_by != policy.decider_id:
        blockers.append(
            _problem(
                "approval_not_by_decider",
                "The version was approved by someone other than the designated decider",
                ids=[policy.decider_id],
            )
        )
    _, unresolved = await template_required_sections(db, document, version)
    if unresolved:
        # Fails closed: the template's required sections are unknown, so they block.
        blockers.append(_problem("template_unresolved", unresolved))
    by_key = {s.section_key: s for s in states.sections}
    # A required section must be present (a heading-only section, such as the title or
    # a parent of sub-sections, counts).
    missing = [k for k in required if k not in by_key]
    if missing:
        blockers.append(
            _problem(
                "missing_required_section",
                "Required sections are missing: " + ", ".join(missing),
                section_keys=missing,
            )
        )
    scope = [s for s in states.sections if s.approval_required]
    stale = [s.section_key for s in scope if s.status == "approval_stale"]
    unapproved = [s.section_key for s in scope if s.status not in ("approved", "approval_stale")]
    if stale:
        blockers.append(
            _problem(
                "stale_approval",
                "These sections changed after they were approved; approve their current "
                "text: " + ", ".join(stale),
                section_keys=stale,
            )
        )
    if unapproved:
        gone = {r: why for k in unapproved for r, why in lapsed.get(k, {}).items()}
        note = (
            "; approvals that no longer count: "
            + "; ".join(f"{r or 'someone'} {why}" for r, why in gone.items())
            if gone
            else ""
        )
        blockers.append(
            _problem(
                "missing_approval",
                "These sections need an approval of their current text: "
                + ", ".join(unapproved)
                + note,
                section_keys=unapproved,
                ids=[r for r in gone if r is not None],
            )
        )
    for reviewer in policy.mandatory_reviewer_ids:
        pending = [
            s.section_key
            for s in states.sections
            if any(m.reviewer_id == reviewer and not m.approved for m in s.mandatory_approvals)
        ]
        if pending:
            message = (
                f"Mandatory reviewer {reviewer} {why[reviewer]}, so their approvals do not "
                "count; change the review policy or have them approve again: "
                if why.get(reviewer)
                else f"Mandatory reviewer {reviewer} has not approved the current text of: "
            )
            blockers.append(
                _problem(
                    "mandatory_reviewer_pending",
                    message + ", ".join(pending),
                    section_keys=pending,
                    ids=[reviewer],
                )
            )
    optional_stale = [
        s.section_key
        for s in states.sections
        if not s.approval_required and s.status == "approval_stale"
    ]
    if optional_stale:
        warnings.append(
            _problem(
                "approval_stale_optional",
                "Approvals lapsed when these sections changed: " + ", ".join(optional_stale),
                section_keys=optional_stale,
            )
        )
    overdue = [s.section_key for s in states.sections if s.overdue]
    if overdue:
        warnings.append(
            _problem(
                "review_overdue",
                "Reviews are past due: " + ", ".join(overdue),
                section_keys=overdue,
            )
        )
    items = list(
        await db.scalars(
            select(FeedbackItem).where(
                FeedbackItem.document_id == document.id,
                FeedbackItem.status == "open",
                FeedbackItem.raised_on_version <= version.number,
            )
        )
    )
    critical = [i for i in items if i.severity == "critical"]
    if critical:
        # T2: a critical unresolved change request is a hard blocker.
        blockers.append(
            _problem(
                "open_critical_change_request",
                f"{len(critical)} critical change request(s) are still open; address or "
                "decline them before publishing",
                section_keys=sorted({i.section_key for i in critical if i.section_key}),
                ids=[i.id for i in critical],
            )
        )
    others = [i for i in items if i.severity != "critical"]
    if others:
        warnings.append(
            _problem(
                "open_change_request",
                f"{len(others)} feedback item(s) are still open",
                ids=[i.id for i in others],
            )
        )
    approval_scope = [s.section_key for s in scope]
    return blockers, warnings, required, approval_scope


async def publish_latest_only(db: AsyncSession) -> bool:
    """The company setting ``publish_latest_only`` (default true): a superseded version
    is never published."""
    from oracle.tenant_settings import TenantSetting

    value = await db.scalar(
        select(TenantSetting.value).where(TenantSetting.key == PUBLISH_LATEST_ONLY)
    )
    return value is not False


async def publish_check(
    db: AsyncSession, document: Document, version: DocumentVersion
) -> PublishCheckOut:
    states = await section_states(db, document, version)
    blockers, warnings, required, scope = await review_problems(db, document, version, states)
    policy = await effective_policy(db, document)

    composition = await current_composition(db, document.id)
    keys = [r.key for r in readiness.checks() if r.key != REVIEW_CHECK_KEY]
    report = await readiness.evaluate(
        ReadinessContext(
            db,
            document.id,
            version.id,
            composition_revision=composition.number if composition else None,
            purpose="publish",
        ),
        keys=keys,
    )
    for r in report.results:
        if r.hard and r.status == "critical":
            blockers.append(
                _problem(
                    "readiness_critical",
                    f"{r.key}: {r.rationale}",
                    check_key=r.key,
                    section_keys=r.section_keys,
                    ids=r.evidence_ids,
                )
            )
        elif r.status in ("critical", "warning"):
            warnings.append(
                _problem(
                    "readiness_warning",
                    f"{r.key}: {r.rationale}",
                    check_key=r.key,
                    section_keys=r.section_keys,
                    ids=r.evidence_ids,
                )
            )
    blockers += await source_permission_problems(db, document, version)
    latest = await db.scalar(
        select(func.max(DocumentVersion.number)).where(DocumentVersion.document_id == document.id)
    )
    if latest is not None and latest > version.number and await publish_latest_only(db):
        blockers.append(
            _problem(
                "superseded_version",
                f"Version {version.number} is not the latest (version {latest} is); only "
                "the latest version is published (company setting publish_latest_only)",
            )
        )
    published = await db.scalar(
        select(DocumentPublication.number).where(DocumentPublication.version_id == version.id)
    )
    if published is not None:
        blockers.append(
            _problem(
                "already_published",
                f"Version {version.number} is already publication {published}",
            )
        )
    return PublishCheckOut(
        document_id=document.id,
        version=version.number,
        content_hash=version.content_hash,
        can_publish=not blockers,
        blockers=blockers,
        warnings=warnings,
        required_sections=required,
        approval_required_sections=scope,
        decider_id=policy.decider_id,
        approved_at=version.approved_at,
        approved_by=version.approved_by,
        readiness=[ReadinessResultOut(**r.model_dump()) for r in report.results],
    )


async def _review_check(ctx: ReadinessContext) -> CheckOutcome:
    """The review invariants as a hard readiness check (for the readiness dashboard)."""
    document = await ctx.db.get(Document, ctx.document_id)
    if ctx.version_id is not None:
        version = await ctx.db.get(DocumentVersion, ctx.version_id)
    else:
        version = await ctx.db.scalar(
            select(DocumentVersion)
            .where(DocumentVersion.document_id == ctx.document_id)
            .order_by(DocumentVersion.number.desc())
            .limit(1)
        )
    if document is None or version is None:
        return CheckOutcome(status="not_applicable", rationale="No version to review")
    states = await section_states(ctx.db, document, version)
    blockers, _, _, _ = await review_problems(ctx.db, document, version, states)
    if not blockers:
        return CheckOutcome(status="pass", rationale="Approvals and required sections are current")
    keys = sorted({k for b in blockers for k in b.section_keys})
    return CheckOutcome(
        status="critical",
        rationale="; ".join(b.message for b in blockers),
        section_keys=keys,
    )


readiness.register_check(REVIEW_CHECK_KEY, _review_check, hard=True)


# --- the transaction ----------------------------------------------------------------


def _iso(value: Any) -> Any:
    return value.isoformat() if hasattr(value, "isoformat") else value


async def _manifest(
    db: AsyncSession,
    principal: "Principal",
    document: Document,
    version: DocumentVersion,
    check: PublishCheckOut,
    note: str | None,
) -> dict[str, Any]:
    from oracle.export.render import SOURCES_KEY, sources_keys
    from oracle.templates.models import Template, TemplateVersion

    policy = await effective_policy(db, document)
    states = await section_states(db, document, version)
    sections = list(
        await db.scalars(
            select(Section).where(Section.version_id == version.id).order_by(Section.ordinal)
        )
    )
    fm = version.front_matter or {}
    template_key = fm.get("template") or document.template
    template_version = str(fm.get("template_version") or document.template_version or "")
    template: dict[str, Any] | None = None
    if template_key:
        row = None
        if template_version.isdigit():
            row = await db.scalar(
                select(TemplateVersion)
                .join(Template, Template.id == TemplateVersion.template_id)
                .where(
                    Template.key == template_key,
                    TemplateVersion.version == int(template_version),
                )
            )
        template = {
            "key": template_key,
            "version": template_version or None,
            "body_sha256": hashlib.sha256(row.body.encode()).hexdigest() if row else None,
            "required_sections": list(row.required_sections or []) if row else [],
        }
    composition = await current_composition(db, document.id)
    citations = list(
        await db.scalars(
            select(Citation).where(Citation.version_id == version.id).order_by(Citation.cite_key)
        )
    )
    links = list(
        await db.scalars(
            select(DocumentSectionLink)
            .where(
                DocumentSectionLink.document_id == document.id,
                (DocumentSectionLink.version_id == version.id)
                | DocumentSectionLink.version_id.is_(None),
            )
            .order_by(DocumentSectionLink.created_at, DocumentSectionLink.id)
        )
    )
    appendix = sources_keys(sections)
    overrides = list(
        await db.scalars(
            select(LlmSuggestion)
            .where(
                LlmSuggestion.document_id == document.id,
                LlmSuggestion.override_reason.is_not(None),
            )
            .order_by(LlmSuggestion.decided_at, LlmSuggestion.id)
        )
    )
    by_key = {s.section_key: s for s in states.sections}
    return {
        "format": MANIFEST_FORMAT,
        "document": {
            "id": str(document.id),
            "slug": document.slug,
            "title": document.title,
            "kind": document.kind,
            "theme": document.theme,
        },
        "version": {
            "id": str(version.id),
            "number": version.number,
            "content_hash": version.content_hash,
            "base_number": version.base_number,
            "brief_source": version.brief_source,
            "imported_by": str(version.imported_by) if version.imported_by else None,
            "imported_at": _iso(version.created_at),
            "source_version_id": str(version.source_version_id)
            if version.source_version_id
            else None,
        },
        "template": template,
        "composition": {
            "revision": composition.number,
            "status": composition.status,
            "modules": composition.modules,
            "decided_by": str(composition.decided_by) if composition.decided_by else None,
            "decided_at": _iso(composition.decided_at),
        }
        if composition
        else None,
        "approval": {
            "approved_at": _iso(version.approved_at),
            "approved_by": str(version.approved_by) if version.approved_by else None,
            "decider_id": str(policy.decider_id) if policy.decider_id else None,
            "mandatory_reviewer_ids": [str(r) for r in policy.mandatory_reviewer_ids],
            "policy_source": policy.source,
        },
        "sections": [
            {
                "section_key": s.section_key,
                "heading": s.heading,
                "layer": s.layer,
                "revision": s.revision,
                "status": by_key[s.section_key].status,
                "approval": by_key[s.section_key].approval.model_dump(mode="json")
                if by_key[s.section_key].approval
                else None,
            }
            for s in sections
        ],
        "evidence": {
            "snapshot": version.snapshot,
            "citations": [
                {
                    "cite_key": c.cite_key,
                    "source": c.source,
                    "ref": c.ref,
                    "title": c.title,
                    "excerpt": c.excerpt,
                    "retrieved_at": _iso(c.retrieved_at),
                    "section_keys": sorted(
                        s.section_key for s in sections if c.cite_key in s.citation_keys
                    ),
                }
                for c in citations
            ],
            "section_links": [
                {
                    "id": str(link.id),
                    "section_key": link.section_key,
                    "section_hash": link.section_hash,
                    "kind": link.kind,
                    "precision": link.precision,
                    "claim": link.claim,
                    "entity_id": str(link.entity_id) if link.entity_id else None,
                    "evidence_id": str(link.evidence_id) if link.evidence_id else None,
                    "source_item_id": str(link.source_item_id) if link.source_item_id else None,
                }
                for link in links
            ],
        },
        "appendix": {
            "section_key": SOURCES_KEY if appendix else None,
            "section_keys": [s.section_key for s in sections if s.section_key in appendix],
            "markdown": "\n\n".join(
                f"{'#' * s.level} {s.heading} {{#{s.section_key}}}\n\n{s.body_md}".rstrip()
                for s in sections
                if s.section_key in appendix
            ),
        },
        "overrides": [
            {
                "suggestion_id": str(o.id),
                "feedback_item_id": str(o.feedback_item_id),
                "reason": o.override_reason,
                "pushback": (o.pushback or {}).get("reason"),
                "decided_by": str(o.decided_by) if o.decided_by else None,
                "decided_at": _iso(o.decided_at),
            }
            for o in overrides
        ],
        "readiness": [r.model_dump(mode="json") for r in check.readiness],
        "warnings": [w.model_dump(mode="json") for w in check.warnings],
        "published_by": str(principal.id),
        "note": note,
    }


async def _render(db: AsyncSession, document: Document, number: int) -> dict[str, str | None]:
    from oracle.export.deck import build_deck, render_deck_html
    from oracle.export.render import (
        NoBrief,
        apply_layer,
        load_export_version,
        render_html,
        render_markdown,
    )

    full = apply_layer(await load_export_version(db, str(document.id), number), "full")
    out: dict[str, str | None] = {
        "markdown": render_markdown(full),
        "html_full": render_html(full),
        "html_brief": None,
        "html_deck": None,
    }
    try:
        brief = apply_layer(await load_export_version(db, str(document.id), number), "brief")
        out["html_brief"] = render_html(brief)
        deck = apply_layer(await load_export_version(db, str(document.id), number), "deck")
        out["html_deck"] = render_deck_html(build_deck(deck))
    except NoBrief:
        pass
    return out


def published_markdown(row: DocumentPublication) -> str:
    """The pinned draft with a publication banner after its front matter (it can still
    be re-imported, like the markdown export)."""
    import re

    banner = (
        f"<!-- Product Oracle publication {row.number}: {row.manifest['document']['slug']} "
        f"version {row.version_number}, published {_iso(row.created_at)}, manifest "
        f"{row.manifest_hash} -->\n"
    )
    m = re.compile(r"^---[ \t]*\n.*?^(?:---|\.\.\.)[ \t]*(?:\n|\Z)", re.S | re.M).match(
        row.markdown
    )
    if m:
        return row.markdown[: m.end()] + banner + row.markdown[m.end() :]
    return banner + row.markdown


def manifest_hash(manifest: dict[str, Any], markdown: str) -> str:
    canonical = json.dumps(manifest, sort_keys=True, separators=(",", ":"), default=str)
    return hashlib.sha256(f"{canonical}\n{markdown}".encode()).hexdigest()


async def publish(
    db: AsyncSession,
    principal: "Principal",
    document: Document,
    version: DocumentVersion,
    *,
    content_hash: str | None,
    note: str | None,
) -> DocumentPublication:
    """Check and publish under the publish lock (the document's row lock and the
    company's review gate, shared), so no verdict, approval, policy change or source
    revocation commits mid-render. The caller commits."""
    await gate_lock(db, shared=True)
    locked = await lock_document(db, document.id)
    await db.refresh(version)
    check = await publish_check(db, locked, version)
    if content_hash is not None and content_hash != version.content_hash:
        raise PublishRefusedError(
            check, "the version's content is not the one you checked; check again"
        )
    if not check.can_publish:
        raise PublishRefusedError(check)
    manifest = await _manifest(db, principal, locked, version, check, note)
    rendered = await _render(db, locked, version.number)
    number = (
        await db.scalar(
            select(func.max(DocumentPublication.number)).where(
                DocumentPublication.document_id == locked.id
            )
        )
        or 0
    ) + 1
    row = DocumentPublication(
        document_id=locked.id,
        number=number,
        version_id=version.id,
        version_number=version.number,
        content_hash=version.content_hash,
        manifest=manifest,
        manifest_hash=manifest_hash(manifest, version.markdown),
        markdown=version.markdown,
        html_full=rendered["html_full"],
        html_brief=rendered["html_brief"],
        html_deck=rendered["html_deck"],
        published_by=principal.id,
    )
    db.add(row)
    try:
        await db.flush()
    except IntegrityError as e:
        await db.rollback()
        raise PublishRefusedError(check, "the version was published concurrently") from e
    await audit.record(
        db,
        principal,
        "document.publish",
        "document_publication",
        row.id,
        {
            "document_id": str(locked.id),
            "version": version.number,
            "publication": number,
            "manifest_hash": row.manifest_hash,
            "approved_by": manifest["approval"]["approved_by"],
            "decider_id": manifest["approval"]["decider_id"],
            "warnings": [w.code for w in check.warnings],
        },
    )
    from oracle.review import collab

    owners = await db.scalars(
        select(SectionReviewState.owner_id).where(SectionReviewState.document_id == locked.id)
    )
    await collab.notify(
        db,
        [version.approved_by, *owners],
        kind="published",
        title=f"{locked.title} v{version.number} was published",
        actor=principal.actor,
        document_id=locked.id,
        version_number=version.number,
        data={"publication": number},
    )
    return row
