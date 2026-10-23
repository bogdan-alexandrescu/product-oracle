"""Engineering leads (A3): who speaks for engineering, read from ``users.engineering_lead``.

One source of truth for the flag. Every place that checks who decides a checkpoint asks
:func:`may_decide` (C2 Multiple reviewers); the date-basis routes ask
:func:`date_rights` (F3 Date bases). Several members may carry the flag; disabled members
never count.
"""

import uuid
from typing import TYPE_CHECKING, Literal, Protocol

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from oracle.auth.models import User
from oracle.authz import has_role

if TYPE_CHECKING:
    from oracle.auth.deps import Principal

#: The engineering stops of Baseline to PRD (F4 Engineering review stop): the check after the
#: feature set and the dates after the PRD draft's roadmap items. eng_dates is added to
#: CHECKPOINT_KINDS by F4's lane B; listing it here first is harmless.
ENGINEERING_KINDS = ("eng_review", "eng_dates")
#: PR #126's engineering spec flow: its eng_review stop keeps the spec's own rule (the
#: request's named engineering approvers, or an owner; oracle.specs.service).
SPEC_FLOW = "prd_to_spec"
LEAD_ONLY = "Only an engineering lead or an owner decides the engineering stops"
VIEWER_REFUSED = "A viewer can't be the engineering lead. Make them a commenter or above first."


class Stop(Protocol):
    """A checkpoint, or what a segment's would be: its kind and its lowest deciding role."""

    @property
    def kind(self) -> str: ...

    @property
    def approver_role(self) -> str: ...


async def engineering_leads(db: AsyncSession) -> frozenset[uuid.UUID]:
    """Active members carrying the flag (disabled ones left out)."""
    rows = await db.scalars(
        select(User.id).where(User.engineering_lead.is_(True), User.disabled_at.is_(None))
    )
    return frozenset(rows)


def lead_stop(kind: str, flow: str, leads: frozenset[uuid.UUID]) -> bool:
    """Whether a stop of ``kind`` in a run of ``flow`` waits for the engineering leads and
    owners: an engineering stop outside prd_to_spec, once any lead is named."""
    return kind in ENGINEERING_KINDS and flow != SPEC_FLOW and bool(leads)


def decides(
    role: str,
    user_id: uuid.UUID | None,
    stop: Stop,
    flow: str,
    leads: frozenset[uuid.UUID],
) -> bool:
    """:func:`may_decide` for a member's ``role`` and id (the console's answerer, a
    principal)."""
    if lead_stop(stop.kind, flow, leads):
        # A lead acting read-only (a viewer's rights) decides nothing.
        return role == "owner" or (
            user_id is not None and user_id in leads and has_role(role, "commenter")
        )
    return has_role(role, stop.approver_role)  # type: ignore[arg-type]


def may_decide(principal: "Principal", cp: Stop, flow: str, leads: frozenset[uuid.UUID]) -> bool:
    """Whether ``principal`` may decide ``cp`` (C2 Multiple reviewers). An engineering stop
    (the check, eng_review, or the dates, eng_dates) outside prd_to_spec goes to the
    engineering leads and owners once any lead is named. prd_to_spec keeps PR #126's spec
    rule, checked by its own service. Every other kind, and an engineering stop with no lead
    named, goes by role as before. F4 Engineering review stop uses this helper for both of
    its stops; it does not add a second one."""
    return decides(principal.role, principal.user_id, cp, flow, leads)


DateRights = Literal["verify", "propose"]


def date_rights(principal: "Principal", leads: frozenset[uuid.UUID]) -> DateRights | None:
    """What ``principal`` may do with a schedule basis (F3 Date bases, owner 2026-10-21,
    "Who verifies"): ``verify`` (record it verified, verify or reject a proposed one,
    withdraw one) for engineering leads (commenter or above) and owners, and for approvers
    while no lead is named (O4); ``propose`` (record it, waiting for a lead) for approvers
    while a lead is named; None for everyone else. The one rule every caller asks."""
    if principal.role == "owner":
        return "verify"
    if (
        principal.user_id is not None
        and principal.user_id in leads
        and has_role(principal.role, "commenter")
    ):
        return "verify"
    if has_role(principal.role, "approver"):
        return "propose" if leads else "verify"
    return None


async def lead_now(db: AsyncSession, user_id: uuid.UUID) -> bool:
    """The flag read at write time, FOR SHARE on the users row (C2 Multiple reviewers,
    2026-10-20: role re-check on run actions, so an unflag mid-request is honoured)."""
    row = (
        await db.execute(
            select(User.engineering_lead, User.disabled_at)
            .where(User.id == user_id)
            .with_for_update(read=True)
        )
    ).first()
    return row is not None and row.engineering_lead and row.disabled_at is None


async def lead_refusal(db: AsyncSession, principal: "Principal") -> str | None:
    """Why ``principal`` may no longer decide an engineering stop with a lead named, read
    now (the caller holds the review gate and the run's lock), or None: an owner still an
    owner; anyone else still an active commenter or above carrying the flag."""
    from oracle.auth.service import caller_refusal

    if principal.role == "owner":
        return await caller_refusal(db, principal, "owner")
    refusal = await caller_refusal(db, principal, "commenter")
    if refusal is not None:
        return refusal
    if principal.user_id is None or not await lead_now(db, principal.user_id):
        return LEAD_ONLY
    return None
