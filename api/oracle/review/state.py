"""Review state per stable section id and revision (CR-06, build prompt §9).

A section's **revision** (``sections.revision``) covers its text, the citation entries
it cites (ref, title, excerpt) and its brief-layer membership, so changing the evidence
behind a section is a new revision too (``oracle.docs.parser.section_revision``).
Versions are immutable, so a revision appears in one version and in every later version that kept
the section unchanged. A verdict binds to the revision it was given on
(``section_reviews.section_hash``; for verdicts older than 0013 the revision of the
section in the verdict's version), so:

- an approval holds in later versions while the section keeps that revision;
- a substantive change (any new revision) leaves the approval behind: the section is
  ``approval_stale`` until someone approves the new revision;
- the change handler registered below (:func:`invalidate_approvals`) also records the
  invalidated approvals on the section's :class:`SectionReviewState`, so an approval
  never comes back if the text later returns to its old revision, requests re-review
  where the policy says so, and notifies the section's owner and reviewers. Other
  sections are untouched.

A verdict binds to the section's **review revision** (:func:`review_revision`): its
revision plus its section links, read at gate time, so a link added after an approval
leaves it stale. And an approval counts only while its approver still is one
(:func:`standing`, :func:`counting_history`): a demoted or disabled member's approvals and
a revoked token's are left out wherever approvals are counted. Those lapse for good
(C2): the role change, the disable or the token revocation marks them lapsed in its own
transaction (:func:`lapse_approvals`), so a re-promotion or a restore never revives
them. A verdict given through an API token records the token (``token_id``).

The legacy per-version view is unchanged: ``SectionOut.verdict`` and
``locked_section_keys`` still read the verdicts of one version only.

The review policy (:func:`effective_policy`) names the designated decider (the only one
who approves a version when set; F2), mandatory reviewers (no unanimity unless a company
configures them) and which sections need an approval of their current revision before a
publish.
"""

import hashlib
import json
import uuid
from collections import defaultdict
from collections.abc import Iterable
from dataclasses import dataclass, field
from datetime import UTC, datetime
from typing import TYPE_CHECKING, Any

from sqlalchemy import func, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from oracle import audit, changes, webhooks
from oracle.auth.models import ApiToken, User
from oracle.authz import has_role
from oracle.docs.models import Document, DocumentVersion, Section
from oracle.review.models import (
    DocumentReviewPolicy,
    FeedbackItem,
    SectionReview,
    SectionReviewState,
)
from oracle.review.schemas import (
    MandatoryApproval,
    ReviewPolicyIn,
    ReviewPolicyOut,
    SectionApproval,
    SectionInvalidation,
    SectionStateOut,
    SectionStatesOut,
)
from oracle.v2.models import (
    ChangeEvent,
    CompositionRevision,
    DocumentComposition,
    DocumentSectionLink,
)

if TYPE_CHECKING:
    from oracle.auth.deps import Principal

# The company-wide default (``PUT /v1/settings/review_policy``); a document's own
# policy row replaces it entirely.
POLICY_SETTING = "review_policy"
DEFAULT_POLICY: dict[str, Any] = {
    "decider_id": None,
    "mandatory_reviewer_ids": [],
    "required_section_keys": [],
    "section_approval": "required_sections",
    "rereview_on_change": True,
}


def now() -> datetime:
    return datetime.now(UTC)


class PolicyError(ValueError):
    pass


# --- policy -------------------------------------------------------------------------------


async def _approver_users(db: AsyncSession, ids: list[uuid.UUID], what: str) -> None:
    if not ids:
        return
    users = {u.id: u for u in await db.scalars(select(User).where(User.id.in_(ids)))}
    for uid in ids:
        user = users.get(uid)
        if user is None or user.disabled_at is not None:
            raise PolicyError(f"{what}: user {uid} is not a member of this company")
        if not has_role(user.role, "approver"):
            raise PolicyError(f"{what}: user {uid} needs the approver role")


async def validate_policy(db: AsyncSession, value: Any) -> dict[str, Any]:
    """A policy value (the company setting or a document's), checked; JSON-ready."""
    try:
        policy = ReviewPolicyIn.model_validate(value)
    except Exception as e:  # noqa: BLE001 - pydantic's message is the answer
        raise PolicyError(f"review_policy: {e}") from None
    if policy.decider_id is not None:
        await _approver_users(db, [policy.decider_id], "decider_id")
    await _approver_users(db, policy.mandatory_reviewer_ids, "mandatory_reviewer_ids")
    out = policy.model_dump(mode="json", exclude={"lock_version"})
    out["mandatory_reviewer_ids"] = list(dict.fromkeys(out["mandatory_reviewer_ids"]))
    out["required_section_keys"] = list(dict.fromkeys(out["required_section_keys"]))
    return out


async def effective_policy(db: AsyncSession, document: Document) -> ReviewPolicyOut:
    row = await db.scalar(
        select(DocumentReviewPolicy).where(DocumentReviewPolicy.document_id == document.id)
    )
    if row is not None:
        return ReviewPolicyOut(
            document_id=document.id,
            decider_id=row.decider_id,
            mandatory_reviewer_ids=list(row.mandatory_reviewer_ids),
            required_section_keys=list(row.required_section_keys),
            section_approval=row.section_approval,  # type: ignore[arg-type]
            rereview_on_change=row.rereview_on_change,
            source="document",
            lock_version=row.lock_version,
        )
    from oracle.tenant_settings import TenantSetting

    setting = await db.scalar(select(TenantSetting).where(TenantSetting.key == POLICY_SETTING))
    value = {**DEFAULT_POLICY, **(setting.value if setting is not None else {})}
    return ReviewPolicyOut(
        document_id=document.id,
        **{k: value[k] for k in DEFAULT_POLICY},
        source="company" if setting is not None else "default",
    )


async def set_policy(
    db: AsyncSession, principal: "Principal", document: Document, body: ReviewPolicyIn
) -> ReviewPolicyOut:
    """Set a document's own review policy (owner only). Under the review gate, shared:
    the caller must still be an owner (C2), and the decider and reviewers it names are
    read while no role change or disable can commit."""
    from oracle.auth.service import caller_refusal
    from oracle.review import publish
    from oracle.review.service import ReviewError
    from oracle.v2.concurrency import VersionConflict, expect_version, flush_or_conflict

    await publish.gate_lock(db, shared=True)
    refusal = await caller_refusal(db, principal, "owner")
    if refusal is not None:
        raise ReviewError("forbidden", refusal)
    value = await validate_policy(db, body.model_dump(mode="json"))
    # The publish lock: a policy change never commits while a publish renders.
    await publish.lock_document(db, document.id)
    row = await db.scalar(
        select(DocumentReviewPolicy)
        .where(DocumentReviewPolicy.document_id == document.id)
        .with_for_update()
    )
    before = None
    if row is None:
        if body.lock_version is not None:
            raise VersionConflict(None)
        row = DocumentReviewPolicy(document_id=document.id)
        db.add(row)
    else:
        if body.lock_version is None:
            raise VersionConflict(row.lock_version)
        expect_version(row, body.lock_version)
        before = {
            "decider_id": str(row.decider_id) if row.decider_id else None,
            "mandatory_reviewer_ids": [str(i) for i in row.mandatory_reviewer_ids],
        }
    row.decider_id = uuid.UUID(value["decider_id"]) if value["decider_id"] else None
    row.mandatory_reviewer_ids = [uuid.UUID(i) for i in value["mandatory_reviewer_ids"]]
    row.required_section_keys = value["required_section_keys"]
    row.section_approval = value["section_approval"]
    row.rereview_on_change = value["rereview_on_change"]
    row.updated_by = principal.user_id or principal.id
    await flush_or_conflict(db)
    await audit.record(
        db,
        principal,
        "review_policy.update",
        "document",
        document.id,
        {"before": before, "after": value},
    )
    return await effective_policy(db, document)


# --- required sections ----------------------------------------------------------------


async def template_required_sections(
    db: AsyncSession, document: Document, version: DocumentVersion
) -> tuple[list[str], str | None]:
    """The required sections of the template version the version names, and why they
    could not be read (an unknown template, a version that is not a number or does not
    exist). Fails closed: the publish check blocks on the reason, never drops the
    template's required sections. A version that names no template has none."""
    from oracle.templates.builtins import ensure_builtins
    from oracle.templates.models import Template, TemplateVersion

    fm = version.front_matter or {}
    key = fm.get("template") or document.template
    if not key:
        return [], None
    raw = fm.get("template_version") if fm.get("template") else document.template_version
    number = "" if raw is None else str(raw).strip()
    if not number.isdigit():
        return [], (
            f"template {key!r} names version {number or '(none)'!r}, which is not a version "
            "number; its required sections cannot be checked"
        )

    async def lookup() -> list[str] | None:
        row = await db.scalar(
            select(TemplateVersion)
            .join(Template, Template.id == TemplateVersion.template_id)
            .where(Template.key == str(key), TemplateVersion.version == int(number))
        )
        return None if row is None else list(row.required_sections or [])

    required = await lookup()
    if required is None and await ensure_builtins(db):
        required = await lookup()
    if required is None:
        return [], (
            f"template {key!r} version {number} does not exist; its required sections "
            "cannot be checked"
        )
    return required, None


async def required_sections(
    db: AsyncSession, document: Document, version: DocumentVersion, policy: ReviewPolicyOut
) -> list[str]:
    """The template version's required sections, the sections of the composition's
    included required modules, and the policy's own, in that order."""
    keys, _ = await template_required_sections(db, document, version)
    keys = list(keys)
    revision = await current_composition(db, document.id)
    if revision is not None:
        for module in revision.modules or []:
            if module.get("included") and module.get("policy") == "required":
                keys += list(module.get("section_ids") or [])
    keys += policy.required_section_keys
    return list(dict.fromkeys(keys))


async def current_composition(
    db: AsyncSession, document_id: uuid.UUID
) -> CompositionRevision | None:
    composition = await db.scalar(
        select(DocumentComposition).where(DocumentComposition.document_id == document_id)
    )
    if composition is None or composition.current_revision is None:
        return None
    return await db.scalar(
        select(CompositionRevision).where(
            CompositionRevision.composition_id == composition.id,
            CompositionRevision.number == composition.current_revision,
        )
    )


# --- verdict history ----------------------------------------------------------------------


@dataclass
class Verdict:
    id: uuid.UUID
    section_key: str
    verdict: str
    reviewer_id: uuid.UUID | None
    version: int
    revision: str | None
    created_at: datetime
    # The section's stored revision in the verdict's version (without its links).
    base: str | None = None
    # The API token the verdict was given through, if any.
    token_id: uuid.UUID | None = None
    # The MCP OAuth grant it was given through, if any.
    grant_id: uuid.UUID | None = None
    # Why the approval lapsed for good (:func:`lapse_approvals`); None while it holds.
    lapsed: str | None = None


@dataclass
class History:
    """Verdicts of a document up to a version, by section key, oldest first."""

    by_key: dict[str, list[Verdict]] = field(default_factory=dict)

    def on_revision(self, key: str, revision: str) -> list[Verdict]:
        return [v for v in self.by_key.get(key, []) if v.revision == revision]


async def history(
    db: AsyncSession, document_id: uuid.UUID, upto: int | None = None, key: str | None = None
) -> History:
    stmt = (
        select(
            SectionReview,
            DocumentVersion.number,
            func.coalesce(SectionReview.section_hash, Section.revision),
            Section.revision,
        )
        .join(DocumentVersion, DocumentVersion.id == SectionReview.version_id)
        .outerjoin(
            Section,
            (Section.version_id == SectionReview.version_id)
            & (Section.section_key == SectionReview.section_key),
        )
        .where(DocumentVersion.document_id == document_id)
        .order_by(SectionReview.created_at, SectionReview.id)
    )
    if upto is not None:
        stmt = stmt.where(DocumentVersion.number <= upto)
    if key is not None:
        stmt = stmt.where(SectionReview.section_key == key)
    out = History()
    for review, number, revision, base in (await db.execute(stmt)).all():
        out.by_key.setdefault(review.section_key, []).append(
            Verdict(
                review.id,
                review.section_key,
                review.verdict,
                review.reviewer_id,
                number,
                revision,
                review.created_at,
                base,
                review.token_id,
                review.grant_id,
                (review.lapse_reason or "lapsed") if review.lapsed_at is not None else None,
            )
        )
    return out


def review_revision(revision: str, links: list[list[str | None]] | None) -> str:
    """What a verdict binds to: the section's revision (text, cited entries, layer)
    and its section links (kind, target, precision, claim), so a link added or changed
    after an approval leaves the approval stale. A section without links: its
    revision."""
    if not links:
        return revision
    canonical = json.dumps(
        [revision, sorted(links, key=json.dumps)], ensure_ascii=False, separators=(",", ":")
    )
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()


async def review_revisions(
    db: AsyncSession, document_id: uuid.UUID, version_id: uuid.UUID, revisions: dict[str, str]
) -> dict[str, str]:
    """:func:`review_revision` of each section of a version (by key, from its stored
    revision); the links of the version and those of every version count."""
    links: dict[str, list[list[str | None]]] = defaultdict(list)
    if revisions:
        for link in await db.scalars(
            select(DocumentSectionLink).where(
                DocumentSectionLink.document_id == document_id,
                (DocumentSectionLink.version_id == version_id)
                | DocumentSectionLink.version_id.is_(None),
                DocumentSectionLink.section_key.in_(list(revisions)),
            )
        ):
            links[link.section_key].append(
                [
                    link.kind,
                    str(link.entity_id) if link.entity_id else None,
                    str(link.evidence_id) if link.evidence_id else None,
                    str(link.source_item_id) if link.source_item_id else None,
                    link.precision,
                    link.claim,
                ]
            )
    return {k: review_revision(r, links.get(k)) for k, r in revisions.items()}


async def standing(
    db: AsyncSession, ids: "Iterable[uuid.UUID | None]"
) -> dict[uuid.UUID, str | None]:
    """Whether each reviewer may approve now: ``None`` when they may, else why not.

    Read at gate time, never only at verdict time: an active user with the approver role
    (or above) today; an API token acting for a user is that user; a user-less API token
    that is active and has the approver role. A disabled member, a demoted one, a
    revoked token: their approvals no longer count (CR-06, C2)."""
    wanted = {i for i in ids if i is not None}
    if not wanted:
        return {}
    users = {u.id: u for u in await db.scalars(select(User).where(User.id.in_(wanted)))}
    rest = wanted - users.keys()
    tokens = (
        {t.id: t for t in await db.scalars(select(ApiToken).where(ApiToken.id.in_(rest)))}
        if rest
        else {}
    )
    behind = {t.user_id for t in tokens.values() if t.user_id is not None} - users.keys()
    if behind:
        users |= {u.id: u for u in await db.scalars(select(User).where(User.id.in_(behind)))}
    out: dict[uuid.UUID, str | None] = {}
    for i in wanted:
        token = tokens.get(i)
        if token is not None and token.revoked_at is not None:
            out[i] = "is an API token that was revoked"
            continue
        user = users.get(token.user_id if token is not None and token.user_id else i)
        if user is not None and user.disabled_at is not None:
            out[i] = "was removed from this company (disabled)"
        elif user is not None:
            ok = has_role(user.role, "approver")
            out[i] = None if ok else f"no longer has the approver role (now {user.role})"
        elif token is not None and token.user_id is None:
            ok = has_role(token.role, "approver")
            out[i] = None if ok else f"is an API token without the approver role ({token.role})"
        else:
            out[i] = "is no longer a member of this company"
    return out


GRANT_REVOKED = "is an MCP OAuth grant that was revoked"


async def revoked_grants(
    db: AsyncSession, ids: "Iterable[uuid.UUID | None]"
) -> dict[uuid.UUID, str]:
    """The MCP OAuth grants (``oauth_tokens.family_id``) among ``ids`` that were revoked
    (no token of the grant is unrevoked, or the grant is gone): id -> why. Read at gate
    time, like :func:`standing`, so a grant revoked outside the endpoint voids too. An
    expired grant is not revoked."""
    from oracle.mcp.oauth.models import OAuthToken

    wanted = {i for i in ids if i is not None}
    if not wanted:
        return {}
    live = set(
        await db.scalars(
            select(OAuthToken.family_id)
            .where(OAuthToken.family_id.in_(wanted), OAuthToken.revoked_at.is_(None))
            .distinct()
        )
    )
    return {i: GRANT_REVOKED for i in wanted - live}


async def counting_history(
    db: AsyncSession, document_id: uuid.UUID, upto: int | None = None, key: str | None = None
) -> tuple[History, dict[str, dict[uuid.UUID | None, str]]]:
    """The verdict history with only the approvals that count now (not lapsed for good,
    and :func:`standing` of the reviewer and of the token they acted through), and per
    section key the approvals left out: reviewer id -> why it no longer counts. Other
    verdicts (changes requested, rejected) stay: an objection never lapses."""
    hist = await history(db, document_id, upto=upto, key=key)
    approvals = [v for vs in hist.by_key.values() for v in vs if v.verdict == "approved"]
    why = await standing(
        db, {v.reviewer_id for v in approvals} | {v.token_id for v in approvals if v.token_id}
    )
    grants = await revoked_grants(db, {v.grant_id for v in approvals})
    lapsed: dict[str, dict[uuid.UUID | None, str]] = {}
    for section_key, verdicts in hist.by_key.items():
        kept = []
        for v in verdicts:
            reason = (
                v.lapsed
                or (why.get(v.reviewer_id) if v.reviewer_id else "has no reviewer")
                or (why.get(v.token_id) if v.token_id else None)
                or (grants.get(v.grant_id) if v.grant_id else None)
            )
            if v.verdict == "approved" and reason:
                lapsed.setdefault(section_key, {})[v.reviewer_id] = reason
            else:
                kept.append(v)
        hist.by_key[section_key] = kept
    return hist, lapsed


def lapse_entry(version: DocumentVersion, at: datetime, reason: str) -> dict[str, str | None]:
    """The record of a version approval that lapses (``approval_lapses``)."""

    def text(value: object) -> str | None:
        return None if value is None else str(value)

    return {
        "approved_at": version.approved_at.isoformat() if version.approved_at else None,
        "approved_by": text(version.approved_by),
        "approved_token_id": text(version.approved_token_id),
        "approved_grant_id": text(version.approved_grant_id),
        "lapsed_at": at.isoformat(),
        "reason": reason,
    }


def _lapsing_queries(
    reviewer_id: uuid.UUID | None, token_id: uuid.UUID | None, grant_id: uuid.UUID | None
):
    """The section approvals (with their document and version number) and the version
    approvals :func:`lapse_approvals` lapses: one place for it and its preview."""
    review_who = []
    version_who = []
    if reviewer_id is not None:
        review_who.append(SectionReview.reviewer_id == reviewer_id)
        version_who.append(DocumentVersion.approved_by == reviewer_id)
    if token_id is not None:
        review_who += [SectionReview.token_id == token_id, SectionReview.reviewer_id == token_id]
        version_who += [
            DocumentVersion.approved_token_id == token_id,
            DocumentVersion.approved_by == token_id,
        ]
    if grant_id is not None:
        review_who.append(SectionReview.grant_id == grant_id)
        version_who.append(DocumentVersion.approved_grant_id == grant_id)
    reviews = (
        select(SectionReview, DocumentVersion.document_id, DocumentVersion.number)
        .join(DocumentVersion, DocumentVersion.id == SectionReview.version_id)
        .where(
            SectionReview.verdict == "approved",
            SectionReview.lapsed_at.is_(None),
            or_(*review_who),
        )
    )
    versions = select(DocumentVersion).where(
        DocumentVersion.approved_at.is_not(None), or_(*version_who)
    )
    return reviews, versions


async def select_lapsing_approvals(
    db: AsyncSession,
    *,
    reviewer_id: uuid.UUID | None = None,
    token_id: uuid.UUID | None = None,
    grant_id: uuid.UUID | None = None,
) -> tuple[list[SectionReview], list[DocumentVersion]]:
    """What :func:`lapse_approvals` would lapse: (section approvals, version
    approvals). No locks, no writes (A5's preview)."""
    if reviewer_id is None and token_id is None and grant_id is None:
        return [], []
    reviews_q, versions_q = _lapsing_queries(reviewer_id, token_id, grant_id)
    rows = (await db.execute(reviews_q)).all()
    return [r for r, _, _ in rows], list(await db.scalars(versions_q))


async def lapse_approvals(
    db: AsyncSession,
    principal: "Principal | None",
    *,
    reason: str,
    reviewer_id: uuid.UUID | None = None,
    token_id: uuid.UUID | None = None,
    grant_id: uuid.UUID | None = None,
) -> dict[str, list[str]]:
    """Mark lapsed for good every approval ``reviewer_id`` gave (a member demoted below
    approver, or disabled), or every approval given through ``token_id`` (a revoked
    API token, user-less or acting for a user) or ``grant_id`` (a revoked MCP OAuth
    grant, its refresh-token family): section approvals get ``lapsed_at``,
    version approvals move to ``approval_lapsed_*`` (``approved_at`` and ``approved_by``
    cleared, ``approved_token_id`` kept, so exports
    and the document's status stop saying approved). Nothing revives them: a
    re-promotion, a restore, a new token. Re-review is requested where the policy says
    so, as an edit does. In the caller's transaction (it holds the review gate)."""
    from oracle.review import collab

    if reviewer_id is None and token_id is None and grant_id is None:
        return {"section_review_ids": [], "version_ids": []}
    at = now()
    reviews_q, versions_q = _lapsing_queries(reviewer_id, token_id, grant_id)
    rows = (await db.execute(reviews_q.with_for_update(of=SectionReview))).all()
    sections: dict[tuple[uuid.UUID, str], int] = {}
    for review, document_id, number in rows:
        review.lapsed_at = at
        review.lapse_reason = reason
        key = (document_id, review.section_key)
        sections[key] = max(sections.get(key, 0), number)
    versions = list(await db.scalars(versions_q.with_for_update()))
    for v in versions:
        v.approval_lapses = [*(v.approval_lapses or []), lapse_entry(v, at, reason)]
        v.approval_lapsed_at = at
        v.approval_lapsed_by = v.approved_by
        v.approval_lapse_reason = reason
        # approved_token_id stays: which token gave the lapsed approval.
        v.approved_at = None
        v.approved_by = None
    await db.flush()
    for document_id in {v.document_id for v in versions}:
        document = await db.get(Document, document_id, with_for_update=True)
        still = await db.scalar(
            select(DocumentVersion.id)
            .where(
                DocumentVersion.document_id == document_id,
                DocumentVersion.approved_at.is_not(None),
            )
            .limit(1)
        )
        if document is not None and document.status == "approved" and still is None:
            document.status = "in_review"
            await webhooks.capture(
                db,
                "draft.in_review",
                principal,
                document_id=document.id,
                version=max(v.number for v in versions if v.document_id == document_id),
            )
    policies: dict[uuid.UUID, ReviewPolicyOut] = {}
    for (document_id, key), number in sections.items():
        if document_id not in policies:
            policies[document_id] = await effective_policy(db, await db.get(Document, document_id))
        if not policies[document_id].rereview_on_change:
            continue
        row = await get_or_create_state(db, document_id, key)
        row.rereview_requested_at = at
        await collab.notify(
            db,
            [row.owner_id, *row.reviewer_ids],
            kind="rereview_requested",
            title=f"Re-review requested: an approval of {key} lapsed",
            actor=principal.actor if principal else "system",
            document_id=document_id,
            version_number=number,
            section_key=key,
            data={"cause": "approval_lapsed", "reason": reason},
        )
    await db.flush()
    out = {
        "section_review_ids": [str(r.id) for r, _, _ in rows],
        "version_ids": [str(v.id) for v in versions],
    }
    if rows or versions:
        await audit.record(
            db,
            principal,
            "approval.lapse",
            "api_token" if token_id is not None else "oauth_grant" if grant_id else "user",
            token_id or grant_id or reviewer_id,
            {"reason": reason, **out},
        )
    # I1: one event per version whose approvals lapsed, with a code, never the text.
    code = (
        "token_revoked"
        if token_id is not None
        else "grant_revoked"
        if grant_id is not None
        else "approver_disabled"
        if "disabled" in reason
        else "approver_demoted"
    )
    lapsed = {(v.document_id, v.number) for v in versions} | set(
        (document_id, number) for (document_id, _), number in sections.items()
    )
    for document_id, number in sorted(lapsed, key=lambda k: (str(k[0]), k[1])):
        await webhooks.capture(
            db,
            "approval.approvals_invalidated",
            principal,
            document_id=document_id,
            version=number,
            reason=code,
        )
    return out


@dataclass
class Status:
    status: str
    approval: Verdict | None = None


def section_status(verdicts: list[Verdict], revision: str, invalidated: set[uuid.UUID]) -> Status:
    if not verdicts:
        return Status("unreviewed")
    on_rev = [v for v in verdicts if v.revision == revision]
    if on_rev:
        last = on_rev[-1]
        if last.verdict == "approved":
            if last.id in invalidated:
                return Status("approval_stale", last)
            return Status("approved", last)
        return Status(last.verdict)
    last = verdicts[-1]
    if last.verdict == "approved":
        return Status("approval_stale", last)
    return Status("revised")


def reviewer_approved(
    verdicts: list[Verdict], revision: str, reviewer: uuid.UUID, invalidated: set[uuid.UUID]
) -> bool:
    mine = [v for v in verdicts if v.revision == revision and v.reviewer_id == reviewer]
    return bool(mine) and mine[-1].verdict == "approved" and mine[-1].id not in invalidated


async def states_by_key(db: AsyncSession, document_id: uuid.UUID) -> dict[str, SectionReviewState]:
    rows = await db.scalars(
        select(SectionReviewState).where(SectionReviewState.document_id == document_id)
    )
    return {r.section_key: r for r in rows}


async def _revision_since(db: AsyncSession, document_id: uuid.UUID, number: int) -> dict[str, int]:
    """For each section of version ``number``: the first version of the unbroken run
    of versions, ending at ``number``, in which it has its current revision."""
    rows = (
        await db.execute(
            select(DocumentVersion.number, Section.section_key, Section.revision)
            .join(Section, Section.version_id == DocumentVersion.id)
            .where(DocumentVersion.document_id == document_id, DocumentVersion.number <= number)
        )
    ).all()
    by_version: dict[int, dict[str, str]] = defaultdict(dict)
    for n, key, h in rows:
        by_version[n][key] = h
    current = by_version.get(number, {})
    since = {}
    for key, h in current.items():
        first = number
        n = number - 1
        while n >= 1 and by_version.get(n, {}).get(key) == h:
            first = n
            n -= 1
        since[key] = first
    return since


def _overdue(due_at: datetime | None, status: str, at: datetime) -> bool:
    return due_at is not None and status != "approved" and due_at < at


async def section_states(
    db: AsyncSession, document: Document, version: DocumentVersion
) -> SectionStatesOut:
    policy = await effective_policy(db, document)
    sections = list(
        await db.scalars(
            select(Section).where(Section.version_id == version.id).order_by(Section.ordinal)
        )
    )
    hist, _ = await counting_history(db, document.id, upto=version.number)
    current = await review_revisions(
        db, document.id, version.id, {s.section_key: s.revision for s in sections}
    )
    rows = await states_by_key(db, document.id)
    since = await _revision_since(db, document.id, version.number)
    required = set(await required_sections(db, document, version, policy))
    approval_scope = approval_required_keys(policy, [s.section_key for s in sections], required)
    mandatory_scope = approval_scope or {s.section_key for s in sections}
    open_items = (
        await db.execute(
            select(FeedbackItem.section_key, FeedbackItem.severity).where(
                FeedbackItem.document_id == document.id,
                FeedbackItem.status == "open",
                FeedbackItem.raised_on_version <= version.number,
            )
        )
    ).all()
    open_by: dict[str, dict[str, int]] = defaultdict(lambda: defaultdict(int))
    for key, severity in open_items:
        if key:
            open_by[key][severity or "unclassified"] += 1
    latest = await db.scalar(
        select(func.max(DocumentVersion.number)).where(DocumentVersion.document_id == document.id)
    )
    at = now()
    out: list[SectionStateOut] = []
    counts: dict[str, int] = defaultdict(int)
    for s in sections:
        row = rows.get(s.section_key)
        verdicts = hist.by_key.get(s.section_key, [])
        first = since.get(s.section_key, version.number)
        # An approval given in this revision's unbroken run of versions still held
        # then: in an older version's view, later invalidations do not apply.
        invalidated = {
            v.id
            for v in verdicts
            if row and v.id in set(row.invalidated_review_ids) and v.version < first
        }
        st = section_status(verdicts, current[s.section_key], invalidated)
        counts[st.status] += 1
        approval = (
            SectionApproval(
                review_id=st.approval.id,
                reviewer_id=st.approval.reviewer_id,
                version=st.approval.version,
                revision=st.approval.revision,
                approved_at=st.approval.created_at,
            )
            if st.approval
            else None
        )
        invalidation = (
            SectionInvalidation(
                at=row.invalidated_at,
                change_id=row.invalidated_change_id,
                revision=row.invalidated_hash,
            )
            if row and row.invalidated_at and st.status == "approval_stale"
            else None
        )
        out.append(
            SectionStateOut(
                section_key=s.section_key,
                heading=s.heading,
                ordinal=s.ordinal,
                layer=s.layer,  # type: ignore[arg-type]
                revision=s.revision,
                revision_since_version=first,
                status=st.status,  # type: ignore[arg-type]
                approval=approval,
                invalidated=invalidation,
                rereview_requested=bool(row and row.rereview_requested_at)
                and st.status != "approved",
                required=s.section_key in required,
                approval_required=s.section_key in approval_scope,
                mandatory_approvals=[
                    MandatoryApproval(
                        reviewer_id=r,
                        approved=reviewer_approved(
                            verdicts, current[s.section_key], r, invalidated
                        ),
                    )
                    for r in policy.mandatory_reviewer_ids
                ]
                if s.section_key in mandatory_scope
                else [],
                owner_id=row.owner_id if row else None,
                reviewer_ids=list(row.reviewer_ids) if row else [],
                due_at=row.due_at if row else None,
                overdue=_overdue(row.due_at if row else None, st.status, at),
                open_feedback=sum(open_by[s.section_key].values()),
                open_by_severity=dict(open_by[s.section_key]),
                lock_version=row.lock_version if row else None,
            )
        )
    return SectionStatesOut(
        document_id=document.id,
        version=version.number,
        latest_version=latest or version.number,
        sections=out,
        counts=dict(counts),  # type: ignore[arg-type]
    )


def approval_required_keys(
    policy: ReviewPolicyOut, keys: list[str], required: set[str]
) -> set[str]:
    if policy.section_approval == "all_sections":
        return set(keys)
    if policy.section_approval == "required_sections":
        return {k for k in keys if k in required}
    return set()


# --- the change handler -------------------------------------------------------------


async def get_or_create_state(
    db: AsyncSession, document_id: uuid.UUID, key: str
) -> SectionReviewState:
    """The section's state row, locked; created first when it has none (insert ... on
    conflict do nothing, so two writers never race on the unique key)."""
    from sqlalchemy.dialects.postgresql import insert

    from oracle.tenancy import current_tenant

    await db.execute(
        insert(SectionReviewState)
        .values(
            id=uuid.uuid4(),
            tenant_id=current_tenant(db),
            document_id=document_id,
            section_key=key,
            reviewer_ids=[],
            invalidated_review_ids=[],
            lock_version=1,
        )
        .on_conflict_do_nothing(index_elements=["document_id", "section_key"])
    )
    return await db.scalar(
        select(SectionReviewState)
        .where(SectionReviewState.document_id == document_id, SectionReviewState.section_key == key)
        .with_for_update()
        .execution_options(populate_existing=True)
    )


async def invalidate_approvals(db: AsyncSession, event: ChangeEvent) -> None:
    """A section's text changed: invalidate the approvals of its previous revision.

    Only the affected section of the event's document; every other section keeps its
    approvals. Re-review is requested when the policy says so, and the section's owner,
    reviewers and the approvers whose approval lapsed are notified.
    """
    data = event.data or {}
    key = data.get("section_key")
    before, after = data.get("before_hash"), data.get("after_hash")
    if event.document_id is None or not key or not before or before == after:
        return
    hist = await history(db, event.document_id, key=key)
    # Approvals of the old revision, with or without the section links of the time.
    approvals = [
        v
        for v in hist.by_key.get(key, [])
        if v.verdict == "approved" and before in (v.revision, v.base)
    ]
    if not approvals:
        return
    row = await get_or_create_state(db, event.document_id, key)
    lapsed = [v for v in approvals if v.id not in set(row.invalidated_review_ids)]
    if not lapsed:
        return
    document = await db.get(Document, event.document_id)
    policy = await effective_policy(db, document)
    at = now()
    row.invalidated_review_ids = [*row.invalidated_review_ids, *(v.id for v in lapsed)]
    row.invalidated_at = at
    row.invalidated_change_id = event.id
    row.invalidated_hash = before
    if policy.rereview_on_change:
        row.rereview_requested_at = at
    await db.flush()
    await audit.record(
        db,
        None,
        "section_approval.invalidate",
        "document",
        document.id,
        {
            "section_key": key,
            "review_ids": [str(v.id) for v in lapsed],
            "change_id": str(event.id),
            "cause": event.cause,
            "by": event.actor,
            "version": data.get("version"),
            "rereview_requested": policy.rereview_on_change,
        },
    )
    await webhooks.capture(
        db,
        "approval.approvals_invalidated",
        event.actor,
        document_id=document.id,
        version=data.get("version"),
        reason="edited",
    )
    if policy.rereview_on_change:
        from oracle.review import collab

        recipients = [row.owner_id, *row.reviewer_ids, *(v.reviewer_id for v in lapsed)]
        await collab.notify(
            db,
            recipients,
            kind="rereview_requested",
            title=f"Re-review requested: {key} changed in {document.title}",
            actor=event.actor,
            document_id=document.id,
            version_number=data.get("version"),
            section_key=key,
            data={"cause": event.cause, "change_id": str(event.id)},
        )


changes.register_handler(
    "review.invalidate_approvals", invalidate_approvals, subjects={"document_section"}
)


async def record_section_changes(
    db: AsyncSession,
    principal: "Principal | str | None",
    document: Document,
    previous: DocumentVersion | None,
    version: DocumentVersion,
    new_hashes: dict[str, str],
    cause: str,
    *,
    part_of: uuid.UUID | None = None,
) -> list[ChangeEvent]:
    """One ``document_section`` change per section whose revision differs from the
    previous version's (added and removed sections included). A document's first
    version changes nothing that could depend on it. ``part_of``: the version's own
    change (``document_version``) these are parts of; the trace handles that one."""
    if previous is None:
        return []
    old = dict(
        (
            await db.execute(
                select(Section.section_key, Section.revision).where(
                    Section.version_id == previous.id
                )
            )
        ).all()
    )
    events = []
    for key in [*new_hashes, *(k for k in old if k not in new_hashes)]:
        before, after = old.get(key), new_hashes.get(key)
        if before == after:
            continue
        events.append(
            await changes.record_change(
                db,
                "document_section",
                cause=cause,
                actor=principal,
                subject_ref=f"{document.slug}@{version.number}#{key}",
                document_id=document.id,
                data={
                    "section_key": key,
                    "before_hash": before,
                    "after_hash": after,
                    "version": version.number,
                    "previous_version": previous.number,
                    "version_id": str(version.id),
                    **({"part_of_change_id": str(part_of)} if part_of else {}),
                },
            )
        )
    return events


async def approved_keys(
    db: AsyncSession, document_id: uuid.UUID, version: DocumentVersion
) -> set[str]:
    """Section keys of ``version`` approved on their current revision."""
    hashes = dict(
        (
            await db.execute(
                select(Section.section_key, Section.revision).where(
                    Section.version_id == version.id
                )
            )
        ).all()
    )
    hashes = await review_revisions(db, document_id, version.id, hashes)
    hist, _ = await counting_history(db, document_id, upto=version.number)
    rows = await states_by_key(db, document_id)
    out = set()
    for key, h in hashes.items():
        row = rows.get(key)
        invalidated = set(row.invalidated_review_ids) if row else set()
        if section_status(hist.by_key.get(key, []), h, invalidated).status == "approved":
            out.add(key)
    return out
