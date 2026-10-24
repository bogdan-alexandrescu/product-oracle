"""The pricing owner, the pricing memo list, and Decide: from an approved memo to one
proposed decision in the decision log (H9).

The price is decided by one accountable owner (research [74]): the company setting
``pricing_owner``, an active owner, by default the earliest active owner. Approving a memo
means "ready for the decision"; Decide creates (or opens) the proposed decision, which the
pricing owner decides on Company › Decisions as any other.
"""

import uuid
from typing import Any

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from oracle import audit
from oracle.auth.deps import Principal
from oracle.auth.models import User
from oracle.decisions import service as decisions
from oracle.decisions.models import Decision
from oracle.decisions.schemas import MAX_PEOPLE, DecisionCreate, DecisionOption, Subject
from oracle.docs import layers
from oracle.docs.models import Document, DocumentVersion, Section
from oracle.members.names import display_name
from oracle.pricing import frontmatter
from oracle.pricing.schemas import MemoDecision, PricingMemoSummary, PricingOwner
from oracle.tenant_settings_api import InvalidSetting, get_setting

SOURCE_KIND = "pricing_memo_version"
SUMMARY_MAX = 500
CONTEXT_MAX = 4000
TITLE_MAX = 200


class PricingError(Exception):
    def __init__(self, status: int, message: str) -> None:
        super().__init__(message)
        self.status = status


def _active_owners():
    return (
        select(User)
        .where(User.role == "owner", User.disabled_at.is_(None))
        .order_by(User.created_at, User.id)
    )


async def pricing_owner(db: AsyncSession) -> User | None:
    """The setting's owner while they are an active owner; else the earliest active owner."""
    value = await get_setting(db, "pricing_owner")
    if value:
        try:
            chosen = await db.get(User, uuid.UUID(str(value)))
        except ValueError:
            chosen = None
        if chosen is not None and chosen.role == "owner" and chosen.disabled_at is None:
            return chosen
    return await db.scalar(_active_owners().limit(1))


async def check_pricing_owner(db: AsyncSession, value: Any) -> str | None:
    """A ``pricing_owner`` value: null, or an active owner's user id."""
    if value is None:
        return None
    try:
        user_id = uuid.UUID(str(value))
    except ValueError:
        raise InvalidSetting("pricing_owner must be an active owner's user id") from None
    user = await db.get(User, user_id)
    if user is None or user.role != "owner" or user.disabled_at is not None:
        raise InvalidSetting("The pricing owner must be an active owner")
    return str(user_id)


def name_of(user: User | None) -> str:
    return display_name(user.email, user.name) if user is not None else "the pricing owner"


async def _memo(db: AsyncSession, doc: str) -> Document:
    from oracle.docs.service import find_document

    document = await find_document(db, doc)
    if document is None or document.kind != "pricing":
        raise PricingError(404, f"pricing memo '{doc}' not found")
    return document


async def _latest(db: AsyncSession, document_id: uuid.UUID) -> DocumentVersion | None:
    return await db.scalar(
        select(DocumentVersion)
        .where(DocumentVersion.document_id == document_id)
        .order_by(DocumentVersion.number.desc())
        .limit(1)
    )


async def _decisions(db: AsyncSession, document_ids: list[uuid.UUID]) -> dict[uuid.UUID, Decision]:
    """The latest pricing decision of each memo."""
    if not document_ids:
        return {}
    rows = await db.execute(
        select(DocumentVersion.document_id, Decision)
        .join(DocumentVersion, DocumentVersion.id == Decision.source_id)
        .where(Decision.source_kind == SOURCE_KIND, DocumentVersion.document_id.in_(document_ids))
        .order_by(Decision.number)
    )
    return {document_id: d for document_id, d in rows.all()}


async def list_memos(db: AsyncSession, principal: Principal) -> list[PricingMemoSummary]:
    documents = list(
        await db.scalars(
            select(Document).where(Document.kind == "pricing").order_by(Document.updated_at.desc())
        )
    )
    found = await _decisions(db, [d.id for d in documents])
    decider = await pricing_owner(db) if documents else None
    owner = PricingOwner(id=decider.id, name=name_of(decider)) if decider is not None else None
    out = []
    for document in documents:
        latest = await _latest(db, document.id)
        d = found.get(document.id)
        if d is not None and d.status == "decided":
            state = "decided"
        elif latest is not None and latest.approved_at is not None:
            state = "approved"
        else:
            state = "in_review" if document.status == "in_review" else "draft"
        chosen = next(
            (o.get("label") for o in (d.options if d else []) if o.get("key") == d.chosen_option),
            None,
        )
        out.append(
            PricingMemoSummary(
                document_id=document.id,
                slug=document.slug,
                title=document.title,
                question=frontmatter.question_of(latest.front_matter if latest else {}),
                state=state,
                decision=(
                    MemoDecision(
                        number=d.number, title=d.title, status=d.status, chosen_label=chosen
                    )
                    if d is not None
                    else None
                ),
                updated_at=document.updated_at,
                pricing_owner=owner,
            )
        )
    return out


def _first_paragraph(body_md: str) -> str | None:
    text = layers.strip_comments(body_md or "").strip()
    for block in text.split("\n\n"):
        plain = " ".join(block.split())
        if plain:
            return plain[:SUMMARY_MAX]
    return None


async def decide(
    db: AsyncSession, principal: Principal, doc: str, *, replaces: int | None = None
) -> tuple[Decision, bool]:
    """The memo's proposed decision, created on the first call (True) and returned as it
    is on a repeat (False). Only the pricing owner; only on an approved latest version."""
    document = await _memo(db, doc)
    owner = await pricing_owner(db)
    if principal.is_run or owner is None or (principal.user_id or principal.id) != owner.id:
        raise PricingError(403, f"Only {name_of(owner)} decides prices")
    version = await _latest(db, document.id)
    if version is None or version.approved_at is None:
        raise PricingError(409, "Decide follows an approved memo: approve its latest version first")
    existing = await db.scalar(
        select(Decision).where(
            Decision.source_kind == SOURCE_KIND, Decision.source_id == version.id
        )
    )
    if existing is not None:
        return existing, False

    question = frontmatter.question_of(version.front_matter) or document.title
    options = frontmatter.options_of(version.front_matter)
    ignore = frontmatter.recommendation_ignored(version.warnings)
    sections = {
        s.section_key: s
        for s in await db.scalars(select(Section).where(Section.version_id == version.id))
    }
    recommended = next((o for o in options if o.recommended and not ignore), None)
    people = list(
        await db.scalars(
            select(User.id)
            .where(User.role.in_(("owner", "approver")), User.disabled_at.is_(None))
            .order_by(User.created_at)
            .limit(MAX_PEOPLE)
        )
    )
    recommendation = sections.get(frontmatter.RECOMMENDATION_KEY)
    context = (
        " ".join(layers.strip_comments(recommendation.body_md).split())[:CONTEXT_MAX]
        if recommendation is not None
        else ""
    )
    supersedes = None
    if replaces is not None:
        try:
            supersedes = await decisions.resolve(db, f"D-{replaces}")
        except decisions.DecisionError as e:
            raise PricingError(422, f"D-{replaces} is not a decision to replace") from e
    body = DecisionCreate(
        title=f"Price: {question}"[:TITLE_MAX],
        question=question,
        context=context or None,
        options=[
            DecisionOption(
                key=o.id,
                label=o.title,
                summary=_first_paragraph(sections[o.section_key].body_md)
                if o.section_key in sections
                else None,
                recommended=recommended is not None and o.id == recommended.id,
            )
            for o in options
        ],
        approver_id=owner.id,
        reversibility=recommended.reversibility if recommended else "irreversible",
        informed_ids=people,
        subjects=[
            Subject(kind="document", id=document.id, ref=document.slug),
            Subject(
                kind="document_version", id=version.id, ref=f"{document.slug} v{version.number}"
            ),
        ],
    )
    try:
        d = await decisions.create(db, principal, body, supersedes=supersedes)
    except decisions.DecisionError as e:
        raise PricingError(e.status, e.message) from e
    d.origin = "pricing"
    d.source_kind = SOURCE_KIND
    d.source_id = version.id
    await db.flush()
    await audit.record(
        db,
        principal,
        "pricing_memo.decide",
        "document",
        document.id,
        {"version": version.number, "decision": d.number},
    )
    return d, True
