"""B6 Goals interview: a discussion on a vague goal in which Oracle proposes measurable
versions (``goal_measure`` changes) and asks for what is missing, until a person accepts one.

- ``POST /v1/baseline/entities/{goal_id}/interview`` reopens the open discussion on the goal
  or starts one, with the goal's owner in it and Oracle's opening turn ``pending`` (G2 Live
  replies streams it); ``POST /v1/baseline/goals/interview`` does that goal by goal;
  ``GET /v1/baseline/goals/vague`` lists the goals to interview.
- Oracle's versions come from its reply's change block (:func:`take_changes`,
  :func:`keep_versions`), cut down to what it may propose (no owner, no weight).
- G3's generic Propose makes a baseline proposal of a version once B5's checks pass, after
  one pushback when its target is already met (:func:`propose_version`);
  :func:`on_proposal_accepted` closes the discussion once the accepted proposal leaves the
  goal measurable.

A person starts every interview (B6 "Interviews", 2026-10-21): nothing here runs on its own.
Run tokens reach none of the writes (no run-token scope names them, oracle.mcp.scopes) nor
the vague list (a people's read), and every write here is a person's.
"""

import json
import logging
import uuid
from datetime import UTC, datetime, timedelta
from typing import Annotated, Any, Literal

from fastapi import APIRouter, Depends, HTTPException, status
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field, ValidationError
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from oracle import audit, autonomy
from oracle.auth.deps import Principal, TenantDB
from oracle.auth.models import User
from oracle.authz import require_role
from oracle.baseline import goals, service
from oracle.baseline.models import Entity, Proposal
from oracle.baseline.schemas import EntityOut
from oracle.discussions import kinds, replies
from oracle.discussions import service as discussions
from oracle.discussions.models import (
    MAX_RATIONALE,
    MAX_SUMMARY,
    MAX_TITLE,
    Discussion,
    DiscussionChange,
    DiscussionMessage,
)
from oracle.discussions.schemas import DiscussionCreate
from oracle.tenancy import tenant_session

log = logging.getLogger(__name__)

router = APIRouter(prefix="/v1/baseline", tags=["baseline"])
Reader = Annotated[Principal, Depends(require_role("viewer"))]
Commenter = Annotated[Principal, Depends(require_role("commenter"))]
Approver = Annotated[Principal, Depends(require_role("approver"))]

ONLY_GOALS = "Only goals can be interviewed"
MEASURABLE = "This goal is already measurable"
# H11: at Observe (Shape goals) Oracle flags vague goals and opens no interview.
OBSERVING = (
    "Oracle is set to observe goals: it flags gaps and drafts nothing. An owner can "
    "change this in Settings › Autonomy."
)
# The goals an interview is offered on (B6 3.1 (2)).
OFFERED = ("confirmed", "proposed")
MAX_VERSIONS = 3
# The versions Oracle keeps per reply at each Shape goals level (H11): none at Observe, one
# for a named person to edit and own at Draft, up to three with a default at Recommend.
VERSIONS_AT = {"observe": 0, "draft": 1, "recommend": MAX_VERSIONS}


def offer_line(level: str) -> str:
    """The goal prompt's count of versions to offer at a Shape goals level."""
    most = VERSIONS_AT.get(level, MAX_VERSIONS)
    if most == 0:
        return "Offer no measurable version."
    if most == 1:
        return "Offer one measurable version, for a named person to edit and own."
    return f"Offer up to {most} measurable versions."


MARK, END = "<<<CHANGES>>>", "<<<END>>>"


class InterviewIn(BaseModel):
    # The starter's pick: only the people in it read it.
    private: bool = False


class GoalInterviewOut(BaseModel):
    discussion_id: uuid.UUID
    # False: an open interview on the goal was there already.
    created: bool


class InterviewsIn(BaseModel):
    # None: every vague goal.
    entity_ids: list[uuid.UUID] | None = Field(default=None, max_length=100)


class InterviewRow(GoalInterviewOut):
    entity_id: uuid.UUID


class InterviewsOut(BaseModel):
    discussions: list[InterviewRow]


class VagueGoalOut(BaseModel):
    entity: EntityOut
    missing: list[str]
    # The open interview on it the caller can read.
    discussion_id: uuid.UUID | None = None


class GoalMeasureAct(BaseModel):
    # A person's Edit of the version (may carry owner_id and weight); None: as stored.
    payload: dict[str, Any] | None = None
    # Keep the target after Oracle's pushback.
    keep: bool = False


class GoalMeasurePushback(BaseModel):
    detail: str
    pushback: Literal[True] = True


def _now() -> datetime:
    return datetime.now(UTC)


async def _check(db: AsyncSession, e: Entity) -> dict[str, Any]:
    on, horizons = await goals.company_today(db), await goals.company_horizons(db)
    return goals.goal_check(e.attrs or {}, status=e.status, on=on, horizons=horizons)


async def vague_goals(db: AsyncSession) -> list[tuple[Entity, dict[str, Any]]]:
    """The confirmed and proposed goals that are not measurable, oldest first, with
    their check."""
    rows = await db.scalars(
        select(Entity)
        .where(Entity.type == "goal", Entity.status.in_(OFFERED))
        .order_by(Entity.created_at, Entity.id)
    )
    on, horizons = await goals.company_today(db), await goals.company_horizons(db)
    out = []
    for e in rows:
        check = goals.goal_check(e.attrs or {}, status=e.status, on=on, horizons=horizons)
        if not check["measurable"]:
            out.append((e, check))
    return out


async def vague_count(db: AsyncSession) -> int:
    """How many goals are not measurable: the after-review line (runs' ``vague_goals``)."""
    return len(await vague_goals(db))


async def goal_of(db: AsyncSession, d: Discussion) -> Entity | None:
    """The goal a discussion is on, or None (G2 then replies without the goal prompt)."""
    if d.subject_kind != "entity":
        return None
    e = await db.get(Entity, uuid.UUID(d.subject["entity_id"]))
    return e if e is not None and e.type == "goal" else None


async def open_interview(
    db: AsyncSession, principal: Principal, entity_id: uuid.UUID
) -> Discussion | None:
    """The open discussion on the goal the caller can read, the earliest first."""
    rows = await db.scalars(
        select(Discussion)
        .where(Discussion.subject_key == f"entity:{entity_id}", Discussion.status == "open")
        .order_by(Discussion.created_at, Discussion.id)
    )
    for d in list(rows):
        try:
            await discussions.readable(db, principal, d.id)
        except discussions.DiscussionError:
            continue
        return d
    return None


async def _owner(db: AsyncSession, e: Entity) -> uuid.UUID | None:
    """The goal's owner while an active member."""
    try:
        owner = uuid.UUID(str((e.attrs or {}).get("owner")))
    except ValueError:
        return None
    user = await db.get(User, owner)
    return owner if user is not None and user.disabled_at is None else None


async def interview(
    db: AsyncSession, principal: Principal, entity_id: uuid.UUID, private: bool = False
) -> tuple[Discussion, bool]:
    """The open interview on the goal, or a new one with Oracle's opening turn pending;
    whether it is new."""
    e = await db.get(Entity, entity_id)
    if e is None:
        raise HTTPException(404, "Entity not found")
    if e.type != "goal":
        raise HTTPException(422, ONLY_GOALS)
    if (await _check(db, e))["measurable"]:
        raise HTTPException(422, MEASURABLE)
    if await autonomy.level(db, "goals") == "observe":
        raise HTTPException(409, OBSERVING)
    found = await open_interview(db, principal, e.id)
    if found is not None:
        return found, False
    owner = await _owner(db, e)
    body = DiscussionCreate(
        subject_kind="entity",
        subject={"entity_id": str(e.id), "interview": True},
        title=f"Make “{e.title[: MAX_TITLE - 20]}” measurable",
        visibility="private" if private else "open",
        participants=[owner] if owner is not None and owner != principal.user_id else [],
    )
    try:
        d, _ = await discussions.start(db, principal, body)
    except discussions.DiscussionError as exc:
        raise HTTPException(exc.status, exc.detail) from exc
    try:
        await replies.opening(db, d, discussions._person(principal), discussions._via(principal))
    except replies.ReplyLimited:
        log.info("goal interview %s: no opening turn, the reply limit is reached", d.id)
    return d, True


# --- Oracle's versions ------------------------------------------------------------------


def visible(text: str) -> str:
    """A reply as people read it while it streams: up to its change block, holding back
    a tail that may be the block's start."""
    at = text.find(MARK)
    if at != -1:
        return text[:at]
    for n in range(min(len(MARK) - 1, len(text)), 0, -1):
        if text.endswith(MARK[:n]):
            return text[:-n]
    return text


def take_changes(text: str) -> tuple[str, list[Any]]:
    """The reply without its change block, and the block's items (none when it is not
    a JSON array). Plain ``str.find``: the text is the model's (oracle.jobs.prompting)."""
    at = text.find(MARK)
    if at == -1:
        return text, []
    end = text.find(END, at)
    raw = text[at + len(MARK) : end if end != -1 else len(text)].strip()
    rest = text[end + len(END) :].strip() if end != -1 else ""
    body = text[:at].rstrip() + (f"\n\n{rest}" if rest else "")
    raw = raw.removeprefix("```json").removeprefix("```").removesuffix("```").strip()
    try:
        found = json.loads(raw)
    except ValueError:
        log.info("goal interview: a change block that is not JSON was dropped")
        return body, []
    return body, found if isinstance(found, list) else []


def _sources(item: dict[str, Any], entries: dict[int, dict[str, Any]]) -> list[dict[str, Any]]:
    out = []
    for n in item.get("sources") or []:
        if isinstance(n, int) and not isinstance(n, bool) and n in entries:
            out.append({"n": n, "kind": entries[n]["kind"], "ref": entries[n]["ref"]})
    return out


async def store_versions(
    db: AsyncSession,
    d: Discussion,
    goal: Entity,
    reply_id: uuid.UUID,
    found: list[Any],
    entries: dict[int, dict[str, Any]],
    most: int = MAX_VERSIONS,
) -> list[DiscussionChange]:
    """Up to ``most`` (3) of Oracle's versions as ``goal_measure`` changes; one that fails
    the kind's model or B5's checks is skipped and logged."""
    kept: list[DiscussionChange] = []
    at = datetime.now(UTC)
    for item in found:
        if len(kept) == most:
            log.info("goal interview %s: versions past the %s kept were dropped", d.id, most)
            break
        if not (
            isinstance(item, dict)
            and item.get("kind") == "goal_measure"
            and isinstance(item.get("payload"), dict)
        ):
            log.info("goal interview %s: a change that is not a goal_measure was skipped", d.id)
            continue
        try:
            payload = kinds.goal_measure({**item["payload"], "entity_id": str(goal.id)}, "oracle")
        except goals.GoalFieldsError as e:
            codes = [p["code"] for p in e.problems]
            log.warning("goal interview %s: a version was skipped: %s", d.id, codes)
            continue
        except ValidationError as e:
            where = [".".join(str(p) for p in err["loc"]) for err in e.errors()]
            log.warning("goal interview %s: a version was skipped: %s", d.id, where)
            continue
        rationale = item.get("rationale")
        if isinstance(rationale, str):
            rationale = rationale.strip()[:MAX_RATIONALE] or None
        row = DiscussionChange(
            # One transaction's now() is shared: the versions keep Oracle's order.
            created_at=at + timedelta(microseconds=len(kept)),
            discussion_id=d.id,
            kind="goal_measure",
            target={"entity_id": str(goal.id), "title": goal.title},
            payload=payload,
            rationale=rationale if isinstance(rationale, str) else None,
            basis=_sources(item, entries),
            proposed_by_kind="oracle",
            from_message_id=reply_id,
        )
        db.add(row)
        kept.append(row)
    await db.flush()
    return kept


async def keep_versions(
    tenant_id: uuid.UUID,
    reply_id: uuid.UUID,
    found: list[Any],
    entries: dict[int, dict[str, Any]],
) -> None:
    """After Oracle's completed reply in a goal discussion: its versions (G2's hook), as
    many as Shape goals' level allows when the reply completes (none at Observe, one at
    Draft)."""
    if not found:
        return
    async with tenant_session(tenant_id) as db:
        reply = await db.get(DiscussionMessage, reply_id)
        d = await db.get(Discussion, reply.discussion_id) if reply is not None else None
        goal = await goal_of(db, d) if d is not None else None
        if d is None or goal is None:
            return
        most = VERSIONS_AT.get(await autonomy.level(db, "goals"), MAX_VERSIONS)
        if most == 0:
            log.info("goal interview %s: Shape goals is at Observe, no version kept", d.id)
            return
        await store_versions(db, d, goal, reply_id, found, entries, most)
        await db.commit()


# --- acting on a version ----------------------------------------------------------------


async def _oracle_line(
    db: AsyncSession, d: Discussion, body: str, pushback: dict[str, Any] | None = None
) -> DiscussionMessage:
    line = DiscussionMessage(
        created_at=_now(), discussion_id=d.id, author_kind="oracle", body=body,
        status="complete", pushback=pushback,
    )  # fmt: skip
    db.add(line)
    await db.flush()
    await discussions._touch_thread(db, d, line.created_at)
    return line


def _met(attrs: dict[str, Any]) -> tuple[str, float] | None:
    """The start or current value that already meets the target, if one does."""
    target, comparison = attrs.get("target"), attrs.get("comparison")
    if not isinstance(target, int | float) or comparison not in goals.COMPARISONS:
        return None
    for key in ("start", "current"):
        v = attrs.get(key)
        if isinstance(v, int | float) and not isinstance(v, bool):
            if goals.meets(v, comparison, target):
                return key, v
    return None


def _note_in_summary(d: Discussion, line: str) -> None:
    text = f"{d.summary}\n{line}" if d.summary else line
    d.summary = text[-MAX_SUMMARY:]
    d.summary_status, d.summary_at = "draft", _now()


async def propose_version(
    db: AsyncSession,
    principal: Principal,
    c: DiscussionChange,
    d: Discussion,
    body: GoalMeasureAct,
    reason: str | None = None,
) -> DiscussionChange | GoalMeasurePushback:
    """The one path a goal version takes to a baseline proposal, from G3's Propose
    (``oracle.discussions.changes.propose``; B6's own route is gone), the caller having
    checked who may act on ``c``: B5's checks, Oracle's pushback once when the target is
    already met (the kept target logged as the override), and the typed values clearing
    their ``*_text``.
    The goal is the change's target. ``reason``: the proposal's, "From discussion <title>"
    when None."""
    goal_id = (c.target or {}).get("entity_id")
    goal = await db.get(Entity, uuid.UUID(str(goal_id))) if goal_id else None
    if goal is None or goal.type != "goal":
        raise HTTPException(404, "Goal not found")
    raw = dict(body.payload if body.payload is not None else (c.edited_payload or c.payload))
    raw["entity_id"] = str(goal.id)
    before = dict(goal.attrs or {})
    merged = service.merge_attrs(before, kinds.goal_attrs(raw))
    await service.check_goal_attrs(db, merged, before)
    try:
        payload = kinds.validate_payload("goal_measure", raw)
    except ValidationError as exc:
        err = exc.errors()[0]
        where = ".".join(str(p) for p in err["loc"]) or "payload"
        raise HTTPException(422, f"Invalid version: {where}: {err['msg']}") from exc
    if body.payload is not None:
        c.edited_payload = payload
    attrs = kinds.goal_attrs(payload)
    after = service.merge_attrs(before, attrs)
    met = _met(after)
    if met is not None:
        which, value = met
        target = float(after["target"])
        if c.pushback is None and not body.keep:
            sentence = (
                f"The {which} value {value:g} already meets the target {target:g}; a target "
                "that is already met does not measure progress."
            )
            c.pushback = {"reason": sentence}
            await _oracle_line(
                db, d, f"Pushback: {sentence}", pushback={"reason": sentence, "sources": []}
            )
            return GoalMeasurePushback(detail=sentence)
        c.override_reason = (
            f"Kept target {target:g} although the {which} value {value:g} already meets it."
        )
        _note_in_summary(d, c.override_reason)
    # The typed value replaces the text it was read from (as Fill from text does).
    fields = {**attrs, **{f"{k}_text": None for k in attrs if f"{k}_text" in before}}
    writer = service.Writer(principal, "agent", reason=reason or f"From discussion {d.title}")
    proposal = await service.submit_proposal(
        db, writer, op="update", kind="entity", fields={"attrs": fields},
        entity_id=goal.id, edge_id=None,
    )  # fmt: skip
    now = _now()
    c.status, c.result_ref = "done", {"proposal_id": str(proposal.id)}
    c.suggested_by, c.suggested_at = principal.user_id, now
    c.decided_by, c.decided_at = principal.user_id, now
    await audit.record(
        db, principal, "discussion.change_propose", discussions.ENTITY, d.id,
        {"change_id": str(c.id), "proposal_id": str(proposal.id)},
    )  # fmt: skip
    await db.flush()
    return c


async def on_proposal_accepted(db: AsyncSession, proposal: Proposal, principal: Principal) -> None:
    """``decide_proposal``'s hook: when the accepted proposal came from a goals interview
    and leaves its goal measurable, Oracle says so and the discussion is closed."""
    c = await db.scalar(
        select(DiscussionChange)
        .where(
            DiscussionChange.kind == "goal_measure",
            DiscussionChange.result_ref["proposal_id"].astext == str(proposal.id),
        )
        .limit(1)
    )
    if c is None or proposal.entity_id is None:
        return
    goal = await db.get(Entity, proposal.entity_id)
    d = await db.get(Discussion, c.discussion_id)
    if goal is None or d is None or d.status != "open":
        return
    if not (await _check(db, goal))["measurable"]:
        return
    await _oracle_line(db, d, f"“{goal.title}” is measurable now")
    d.status, d.closed_by, d.closed_at = "closed", principal.user_id, _now()
    await audit.record(
        db, principal, "discussion.close", discussions.ENTITY, d.id, {"goal_measurable": True}
    )
    await db.flush()


# --- routes -------------------------------------------------------------------------------


def _created(d: Discussion, created: bool) -> JSONResponse:
    body = GoalInterviewOut(discussion_id=d.id, created=created).model_dump(mode="json")
    return JSONResponse(body, status.HTTP_201_CREATED if created else status.HTTP_200_OK)


@router.post(
    "/entities/{goal_id}/interview",
    response_model=GoalInterviewOut,
    status_code=status.HTTP_201_CREATED,
    responses={
        200: {"model": GoalInterviewOut, "description": "An open interview on this goal exists"},
        404: {"description": "Entity not found"},
        409: {"description": "Shape goals is at Observe: Oracle opens no interview"},
        422: {"description": "Only goals can be interviewed | This goal is already measurable"},
    },
)
async def start_goal_interview(
    goal_id: uuid.UUID, principal: Commenter, db: TenantDB, body: InterviewIn | None = None
) -> JSONResponse:
    """Start a goals interview on a vague goal (B6): a discussion on the goal with its
    owner in it, Oracle's opening turn pending (stream it from G2's
    ``GET /v1/discussions/{id}/messages/{reply_id}/stream``). An open interview on the
    goal is returned instead (200, ``created`` false)."""
    d, created = await interview(db, principal, goal_id, body.private if body else False)
    await db.commit()
    return _created(d, created)


@router.post(
    "/goals/interview",
    response_model=InterviewsOut,
    responses={409: {"description": "Shape goals is at Observe: Oracle opens no interview"}},
)
async def start_goal_interviews(
    body: InterviewsIn, principal: Commenter, db: TenantDB
) -> InterviewsOut:
    """Start (or reopen) a goals interview per goal, in the order given; ``entity_ids``
    omitted: every vague goal. Each discussion's opening turn costs a model call, so the
    web asks for one goal at a time as its stepper reaches it."""
    ids = body.entity_ids
    if ids is None:
        ids = [e.id for e, _check in await vague_goals(db)]
    out = []
    for entity_id in dict.fromkeys(ids):
        d, created = await interview(db, principal, entity_id)
        out.append(InterviewRow(entity_id=entity_id, discussion_id=d.id, created=created))
    await db.commit()
    return InterviewsOut(discussions=out)


@router.get("/goals/vague", response_model=list[VagueGoalOut])
async def list_vague_goals(principal: Reader, db: TenantDB) -> list[VagueGoalOut]:
    """The confirmed and proposed goals that are not measurable, with what each misses
    and the open interview on it (the Goals panel's Interview vague goals)."""
    from oracle.baseline.router import _entities_out

    found = await vague_goals(db)
    entities = await _entities_out(db, [e for e, _check in found], principal)
    out = []
    for (e, check), entity in zip(found, entities, strict=True):
        d = await open_interview(db, principal, e.id)
        out.append(
            VagueGoalOut(entity=entity, missing=check["missing"], discussion_id=d.id if d else None)
        )
    return out


# #187 b6-goal-only-slice: Propose and Dismiss on a goal version are G3's generic change
# actions. B6's own routes answer 410 with the pointer for one release, outside the OpenAPI
# document (so no MCP tool lists them), and then go.
GONE = (
    "This route is gone. Use POST /v1/discussion-changes/{{change_id}}/{verb} with the "
    "change's lock_version."
)


@router.post("/goal-measures/{change_id}/{verb}", include_in_schema=False)
async def goal_measure_gone(change_id: uuid.UUID, verb: Literal["propose", "dismiss"]) -> None:
    """Gone: ``POST /v1/discussion-changes/{change_id}/propose`` or ``…/dismiss``."""
    raise HTTPException(status.HTTP_410_GONE, GONE.format(verb=verb))
