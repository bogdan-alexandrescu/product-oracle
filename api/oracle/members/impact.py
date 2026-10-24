"""What removing or demoting a member would do (A5): the preview the owner's dialog shows.

Read through the same selections the removal and the demotion apply
(:mod:`oracle.members.service`, ``oracle.runs.service.select_owed_decisions``,
``oracle.review.state.select_lapsing_approvals``): no locks, no writes, so a preview
never waits on, nor blocks, a change."""

import uuid
from collections import Counter
from datetime import UTC, datetime
from typing import Any, Literal

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from oracle.auth.models import Role, User
from oracle.authz import has_role
from oracle.members import handover, service


def run_title(run: Any) -> str:
    """A run as the Inbox names it: its flow's title."""
    from oracle.runs import flows

    flow = flows.FLOWS.get(run.flow)
    return flow.title if flow is not None else run.flow


async def _lapses(session: AsyncSession, user_id: uuid.UUID) -> dict[str, Any]:
    from oracle.docs.models import Document
    from oracle.review.state import select_lapsing_approvals

    reviews, versions = await select_lapsing_approvals(session, reviewer_id=user_id)
    docs = {
        d.id: d
        for d in await session.scalars(
            select(Document).where(Document.id.in_({v.document_id for v in versions}))
        )
    } if versions else {}  # fmt: skip
    return {
        "section_approvals": len(reviews),
        "version_approvals": [
            {
                "document": docs[v.document_id].slug,
                "title": docs[v.document_id].title or docs[v.document_id].slug,
                "version": v.number,
            }
            for v in versions
        ],
    }


def _checkpoint_out(pairs: list[tuple]) -> list[dict[str, Any]]:
    return [
        {"run_id": run.id, "checkpoint_id": cp.id, "kind": cp.kind, "title": run_title(run)}
        for run, cp in pairs
    ]


async def member_impact(
    session: AsyncSession,
    user_id: uuid.UUID,
    change: Literal["remove", "role"],
    role: Role | None = None,
) -> dict[str, Any]:
    """``GET /v1/members/{id}/impact``: what ``change`` would end, void and lapse, and
    the responsibilities the member holds (``holder_ok``: whether they may keep them)."""
    from oracle.runs.service import select_owed_decisions

    user = await session.get(User, user_id)
    if user is None:
        raise service.MemberError("not_found", f"Member {user_id} not found")
    out: dict[str, Any] = {
        "member_id": user.id,
        "change": change,
        "role": role if change == "role" else None,
        "as_of": datetime.now(UTC),
        "ends": None,
        "voids": {"spend_approvals": [], "resumes": [], "checkpoint_decisions": []},
        "lapses": {"section_approvals": 0, "version_approvals": []},
        "responsibilities": [],
        "nothing": True,
    }
    if change == "role" and role is None:
        raise service.MemberError("invalid", "change=role needs a role")
    if change == "remove" and user.disabled_at is not None:
        return out
    if change == "role" and (role == user.role or has_role(role, user.role)):  # type: ignore[arg-type]
        return out  # the same role, or a promotion: nothing ends
    acted_as = await service._acted_as(session, user.id)
    if change == "remove":
        connections = await service.select_connections(session, user.id)
        out["ends"] = {
            "sign_in": True,
            "api_tokens": len(await service.select_tokens(session, user.id)),
            "mcp_clients": len(await service.select_grants(session, user.id)),
            "connections": dict(Counter(c.provider for c in connections)),
            "sources": len(await service.select_sources(session, user.id)),
            "runs": [
                {"id": r.id, "title": run_title(r), "status": r.status}
                for r in await service.select_runs(session, user.id)
            ],
            "llm_jobs": len(await service.select_llm_jobs(session, acted_as)),
            "invites": len(await service.select_open_invites(session, user, acted_as)),
        }
        approvals, resumes = await service.select_spend_approvals(session, acted_as, user.id)
        decisions = await service.select_checkpoint_decisions(session, acted_as)
        decisions += await select_owed_decisions(session, acted_as)
        out["lapses"] = await _lapses(session, user.id)
    else:
        before = user.role
        approvals, resumes, decisions = [], [], []
        if has_role(before, "approver") and not has_role(role, "approver"):  # type: ignore[arg-type]
            out["lapses"] = await _lapses(session, user.id)
        if has_role(before, "owner"):
            approvals, resumes = await service.select_spend_approvals(session, acted_as, None)
        decisions = await service.select_checkpoint_decisions(session, acted_as, keep_role=role)
        decisions += await select_owed_decisions(session, acted_as, role=role)
    out["voids"] = {
        "spend_approvals": [{"run_id": r.id, "title": run_title(r)} for r in approvals],
        "resumes": [{"run_id": r.id, "title": run_title(r)} for r in resumes],
        "checkpoint_decisions": _checkpoint_out(decisions),
    }
    held = await handover.held_by(session, user.id)
    out["responsibilities"] = [
        {
            **handover.responsibility_out(r, items),
            "holder_ok": change == "role" and has_role(role, r.needs_role),  # type: ignore[arg-type]
        }
        for r, items in held
    ]
    ends = out["ends"] or {}
    out["nothing"] = (
        not any(v for k, v in ends.items() if k != "sign_in")
        and not any(out["voids"].values())
        and not out["lapses"]["section_approvals"]
        and not out["lapses"]["version_approvals"]
        and (
            not out["responsibilities"]
            if change == "remove"
            else all(r["holder_ok"] for r in out["responsibilities"])
        )
    )
    return out


async def joined(session: AsyncSession, user: User) -> dict[str, Any]:
    """How the member joined, from the ``provision`` (and ``invite.accept``) audit
    events: ``invite``, ``access_request``, ``domain`` (joined at once under ``join``),
    ``seeded`` (no sign-in event: made by the seed or an operator, a password member) or
    ``unknown``."""
    from oracle.members.models import Invite
    from oracle.members.names import display_name
    from oracle.models import AuditEvent

    provision = await session.scalar(
        select(AuditEvent)
        .where(AuditEvent.action == "provision", AuditEvent.entity_id == user.id)
        .order_by(AuditEvent.created_at)
        .limit(1)
    )
    via, by_id, at = "unknown", None, user.created_at
    invite = None
    if provision is not None:
        data = provision.data or {}
        at = provision.created_at
        if data.get("invite_id"):
            invite = await session.get(Invite, uuid.UUID(str(data["invite_id"])))
            via = "access_request" if data.get("via") == "access_request" else "invite"
        else:
            via = "domain"
    elif user.password_sign_in:
        via = "seeded"
    if invite is not None:
        by_id = invite.invited_by
    by_user = await session.get(User, by_id) if by_id else None
    return {
        "at": at,
        "via": via,
        "by": by_id,
        "by_name": display_name(by_user.email, by_user.name) if by_user else None,
    }


async def member_detail(session: AsyncSession, user_id: uuid.UUID) -> dict[str, Any]:
    """``GET /v1/members/{id}``: the member, how they joined, what they hold."""
    user = await session.get(User, user_id)
    if user is None:
        raise service.MemberError("not_found", f"Member {user_id} not found")
    [member] = await service.members_out(session, [user])
    acted_as = await service._acted_as(session, user.id)
    approvals = await service.member_approvals(session, user.id)
    spend, resumes = await service.select_spend_approvals(session, acted_as, None)
    from oracle.runs.service import select_owed_decisions

    decisions = await service.select_checkpoint_decisions(session, acted_as)
    decisions += await select_owed_decisions(session, acted_as)
    return {
        **member.model_dump(),
        "joined": await joined(session, user),
        "responsibilities": await handover.remaining(session, user.id),
        "holds": {
            "section_approvals": sum(1 for a in approvals if a["kind"] == "section"),
            "version_approvals": sum(1 for a in approvals if a["kind"] == "version"),
            "spend_approvals": len(spend) + len(resumes),
            "checkpoint_decisions": len(decisions),
        },
    }
