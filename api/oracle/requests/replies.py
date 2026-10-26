"""H10 Reasoned no: the decision behind a no, the replies to the people who asked, the
``why_not_reply`` job that drafts them, the template drafts and the promise check.

A *no* is a disqualification for a reason that answers the asker: every reason but
Duplicate and Not a request, and Won't do only when it has a note (decided 2026-10-23,
``h10-wont-do-note-optional``). Each no is a decided decision in the log
(``capture.request_declined``) and one reply per person who asked: the request's own
asker and the asker of every request merged into it.

Oracle drafts replies (H11 ``external_messages``, ceiling Draft); a person sends them.
Oracle never sends outside the company: Mark sent records what a person did, and Tell
them in Oracle is a shown-only Inbox row for a member who asked. A reply never promises
"later" or a date (Q4 "Reply terms"): :func:`promise_warnings` flags one, Oracle's or a
person's, without blocking.

Who acts on replies (decided 2026-10-23, ``h10-reply-senders``): approvers and owners,
and the member who filed the request. Run tokens never send, mark or edit replies.
"""

import re
import uuid
from datetime import UTC, datetime
from typing import Any

from sqlalchemy import func, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from oracle import audit, autonomy
from oracle.auth.deps import Principal
from oracle.auth.models import User
from oracle.authz import has_role
from oracle.baseline.models import Edge, Entity
from oracle.decisions.models import Decision
from oracle.jobs.models import LlmJob
from oracle.members.names import display_name
from oracle.requests.models import ProductRequest, RequestReply, RequestTheme

# --- reasons and their basis -----------------------------------------------------------------

LABELS = {
    "no_goal": "Serves no goal",
    "out_of_scope": "Outside what the product does",
    "strategy_stop": "On the stop list",
    "already_exists": "Already possible",
    "few_customers": "Too few would use it",
    "wont_do": "Won't do",
    "other": "Other",
    "duplicate": "Duplicate",
    "not_a_request": "Not a request",
}
# Reasons that answer the asker; Won't do only with a note.
ANSWERING = ("no_goal", "out_of_scope", "strategy_stop", "already_exists", "few_customers", "other")
HOUSEKEEPING = ("duplicate", "not_a_request")
# The basis kinds each reason takes ("none" always fits a reason that needs none).
BASIS_KINDS: dict[str, tuple[str, ...]] = {
    "no_goal": ("goal", "none"),
    "out_of_scope": ("strategy_choice", "none"),
    "strategy_stop": ("strategy_choice",),
    "already_exists": ("feature",),
    "few_customers": ("none",),
    "wont_do": ("none",),
    "other": ("none",),
    "duplicate": ("none",),
    "not_a_request": ("none",),
}
BASIS_NEEDED = {"strategy_stop": "Pick the stop choice", "already_exists": "Pick the feature"}
UNNAMED = "Unnamed asker"
WORDS_MAX = 160
BODY_MAX = 2000
PROMISE = "sounds_like_a_promise"
OPEN = "drafted"
DONE = ("sent", "notified", "skipped", "withdrawn")


def is_no(reason: str, note: str | None) -> bool:
    """Whether a decline answers the asker: a logged decision and replies."""
    if reason in ANSWERING:
        return True
    return reason == "wont_do" and bool((note or "").strip())


def no_reply_reason(row: ProductRequest) -> str | None:
    """Why a disqualified request has no decision and no replies: ``no_note`` for Won't
    do without a note, ``housekeeping`` for Duplicate and Not a request."""
    if row.state != "disqualified" or row.disqualify_reason is None:
        return None
    if row.disqualify_reason in HOUSEKEEPING:
        return "housekeeping"
    if not is_no(row.disqualify_reason, row.decision_note):
        return "no_note"
    return None


class ReplyError(Exception):
    def __init__(self, status: int, message: str) -> None:
        super().__init__(message)
        self.status = status


async def check_basis(
    db: AsyncSession, reason: str, basis: dict[str, Any] | None
) -> tuple[dict[str, Any], Entity | None]:
    """The basis to store for ``reason`` and its entity; 422 when the reason needs one
    and has none, or the basis is of the wrong kind or not a live record."""
    kind = (basis or {}).get("kind") or "none"
    bid = (basis or {}).get("id")
    if reason in BASIS_NEEDED and (kind == "none" or bid is None):
        raise ReplyError(422, BASIS_NEEDED[reason])
    if kind not in BASIS_KINDS[reason]:
        raise ReplyError(422, f"A basis of kind {kind} does not fit {LABELS[reason]}")
    if kind == "none":
        return ({"kind": "none"} if basis else {}), None
    if bid is None:
        raise ReplyError(422, f"Pick the {kind.replace('_', ' ')}")
    entity = await db.get(Entity, uuid.UUID(str(bid)))
    wanted = {"goal": "goal", "feature": "feature", "strategy_choice": "strategy_choice"}[kind]
    if entity is None or entity.type != wanted or entity.status == "rejected":
        raise ReplyError(422, f"Unknown {kind.replace('_', ' ')}: {bid}")
    if kind == "goal" and entity.status != "confirmed":
        raise ReplyError(422, f"Unknown goal: {bid} is not a confirmed goal")
    if reason == "strategy_stop" and (
        entity.status != "confirmed" or (entity.attrs or {}).get("stance") != "stop"
    ):
        raise ReplyError(422, "Pick a confirmed stop choice")
    return {"kind": kind, "id": str(entity.id)}, entity


async def suggested_basis(db: AsyncSession, row: ProductRequest) -> dict[str, dict[str, Any]]:
    """What the Disqualify form preselects: the request's feature for Already possible,
    and the confirmed stop choice that ``affects`` it for On the stop list."""
    out: dict[str, dict[str, Any]] = {}
    if row.feature_id is None:
        return out
    feature = await db.get(Entity, row.feature_id)
    if feature is not None:
        out["already_exists"] = {"kind": "feature", "id": str(feature.id), "title": feature.title}
    stop = await db.scalar(
        select(Entity)
        .join(Edge, Edge.src_id == Entity.id)
        .where(
            Edge.dst_id == row.feature_id,
            Edge.type == "affects",
            Edge.status == "confirmed",
            Entity.type == "strategy_choice",
            Entity.status == "confirmed",
            Entity.attrs["stance"].astext == "stop",
        )
        .order_by(Entity.title)
        .limit(1)
    )
    if stop is not None:
        out["strategy_stop"] = {"kind": "strategy_choice", "id": str(stop.id), "title": stop.title}
    return out


async def basis_title(db: AsyncSession, basis: dict[str, Any] | None) -> str | None:
    if not basis or not basis.get("id"):
        return None
    entity = await db.get(Entity, uuid.UUID(str(basis["id"])))
    return entity.title if entity else None


# --- the promise check -------------------------------------------------------------------------

_MONTH = (
    r"(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?"
    r"|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)"
)
# Linear patterns only: no nested quantifiers (oracle.jobs.prompting's rule).
# Whole words: a hyphen or slash joins a word ("later-stage" is not a promise); a day
# without a year is a month and a day ("24/7" is not a date).
_PROMISES = re.compile(
    r"(?<![\w/-])(?:"
    r"later|soon|someday|eventually|next (?:week|month|quarter|year|release|sprint)"
    r"|on (?:the|our) roadmap|in the (?:near )?future|coming (?:weeks|months)"
    r"|q[1-4]|h[12] 20\d\d|20\d\d-\d\d-\d\d|\d{1,2}/\d{1,2}/\d{2,4}"
    r"|(?:0?[1-9]|1[0-2])/(?:0?[1-9]|[12]\d|3[01])"
    rf"|{_MONTH}\.? \d{{1,2}}(?:st|nd|rd|th)?|\d{{1,2}}(?:st|nd|rd|th)? {_MONTH}"
    rf"|(?:by|in|until) {_MONTH}"
    r")(?![\w/-])",
    re.IGNORECASE,
)


# A quoted span, straight or curly quotes: the asker's words when they asked them.
_QUOTED = re.compile(r'"([^"\n]{1,2000})"|\u201c([^\u201d\n]{1,2000})\u201d')


def _plain(text: str) -> str:
    return " ".join(text.split()).casefold()


def promise_warnings(body: str | None, asked: str | None = None) -> list[str]:
    """``["sounds_like_a_promise"]`` when a reply names a date or says "later", "soon",
    "next quarter" or "on the roadmap" (Q4 "Reply terms"); never blocks. Whole words only,
    and the asker's own words quoted back (``asked``) are theirs, not a promise."""
    if not body:
        return []
    said = _plain(asked or "")

    def theirs(m: re.Match[str]) -> str:
        quote = _plain(m.group(1) or m.group(2)).rstrip("…").strip()
        return " " if said and quote and quote in said else m.group(0)

    if _PROMISES.search(_QUOTED.sub(theirs, body)):
        return [PROMISE]
    return []


# --- template drafts ---------------------------------------------------------------------------


def their_words(row: ProductRequest) -> str:
    words = " ".join((row.title or "").split())
    if len(words) > WORDS_MAX:
        words = words[: WORDS_MAX - 1].rstrip() + "…"
    return words


def _reason_sentence(
    reason: str, *, basis: str | None, goals: list[str], note: str | None, mentions: int
) -> str:
    if reason == "no_goal":
        if goals:
            return (
                f"the company is focused on {', '.join(goals[:3])} now, and this does not move it"
            )
        return "it does not serve what the company is focused on now"
    if reason == "out_of_scope":
        if basis:
            return f"the product focuses on {basis}, and this sits outside it"
        return "it sits outside what the product does"
    if reason == "strategy_stop":
        return f"the company has chosen to stop work on {basis or 'this kind of work'}"
    if reason == "already_exists":
        return "you can already do this today"
    if reason == "few_customers":
        people = "person has" if mentions == 1 else "people have"
        return f"so far {mentions} {people} asked for it, too few for us to build it well"
    text = " ".join((note or "").split()).rstrip(".")
    return text[:1].lower() + text[1:] if text else "it is not something we will build"


def template(
    row: ProductRequest,
    reason: str,
    *,
    asker_words: str,
    basis: str | None,
    basis_kind: str | None,
    goals: list[str],
    note: str | None,
    mentions: int,
    kind: str = "no",
) -> str:
    """The reason's free draft, filled from the request and its basis."""
    if kind == "reopened":
        return (
            f'Thanks again for asking for "{asker_words}". We are looking at it again. '
            "We will let you know what we decide."
        )
    sentence = _reason_sentence(reason, basis=basis, goals=goals, note=note, mentions=mentions)
    text = f'Thanks for asking for "{asker_words}". We\'ve decided not to build it: {sentence}.'
    if basis_kind == "feature" and basis:
        text += f" You can already do this with {basis}."
    return text


# --- reading -----------------------------------------------------------------------------------


async def live_decision(db: AsyncSession, request_id: uuid.UUID) -> Decision | None:
    """The newest decision recorded from declining the request (any status)."""
    return await db.scalar(
        select(Decision)
        .where(
            Decision.origin == "request_decline",
            Decision.subjects.contains([{"kind": "request", "id": str(request_id)}]),
        )
        .order_by(Decision.number.desc())
        .limit(1)
    )


async def decisions_for(db: AsyncSession, ids: list[uuid.UUID]) -> dict[uuid.UUID, Decision]:
    """Each request's standing no: its newest ``request_decline`` decision, when that one is
    still decided. A no reversed on Reopen is not shown beside a later decline."""
    if not ids:
        return {}
    wanted = {str(i) for i in ids}
    out: dict[uuid.UUID, Decision] = {}
    rows = await db.scalars(
        select(Decision)
        .where(
            Decision.origin == "request_decline",
            Decision.source_kind == "product_request",
            or_(*[Decision.subjects.contains([{"kind": "request", "id": i}]) for i in wanted]),
        )
        .order_by(Decision.number)
    )
    for d in rows:
        for s in d.subjects or []:
            if s.get("kind") == "request" and s.get("id") in wanted:
                out[uuid.UUID(s["id"])] = d
    return {rid: d for rid, d in out.items() if d.status == "decided"}


async def reply_counts(db: AsyncSession, ids: list[uuid.UUID]) -> dict[uuid.UUID, tuple[int, int]]:
    """(total, open) replies per decided request; withdrawn ones do not count."""
    if not ids:
        return {}
    rows = await db.execute(
        select(
            RequestReply.root_request_id,
            func.count(RequestReply.id),
            func.count(RequestReply.id).filter(RequestReply.status == OPEN),
        )
        .where(RequestReply.root_request_id.in_(ids), RequestReply.status != "withdrawn")
        .group_by(RequestReply.root_request_id)
    )
    return {rid: (total, open_) for rid, total, open_ in rows.all()}


def asked_again(root: ProductRequest, merged: list[ProductRequest]) -> int:
    """Requests merged into ``root`` (through chains) after its ``asked_again_since``."""
    since = root.asked_again_since
    if root.state != "disqualified" or since is None:
        return 0
    return sum(1 for m in merged if m.decided_at is not None and m.decided_at > since)


async def _names(db: AsyncSession, ids: set[uuid.UUID]) -> dict[uuid.UUID, str]:
    if not ids:
        return {}
    rows = await db.execute(select(User.id, User.email).where(User.id.in_(ids)))
    return {uid: display_name(email) for uid, email in rows.all()}


async def replies_out(db: AsyncSession, rows: list[RequestReply]) -> list[dict[str, Any]]:
    """ReplyOut dicts (oracle.requests.schemas.ReplyOut)."""
    decisions = {
        d.id: d
        for d in await db.scalars(
            select(Decision).where(Decision.id.in_({r.decision_id for r in rows if r.decision_id}))
        )
    }
    requests = {
        r.id: r
        for r in await db.scalars(
            select(ProductRequest).where(ProductRequest.id.in_({r.request_id for r in rows}))
        )
    }
    names = await _names(
        db, {r.sent_by for r in rows if r.sent_by} | {r.member_id for r in rows if r.member_id}
    )
    # Drafting while the reply's job runs, also on Draft again over words already there; a
    # person's own words the job leaves alone.
    job_ids = {r.job_id for r in rows if r.job_id}
    running = (
        set(
            await db.scalars(
                select(LlmJob.id).where(
                    LlmJob.id.in_(job_ids), LlmJob.status.in_(("queued", "running"))
                )
            )
        )
        if job_ids
        else set()
    )
    out = []
    for r in rows:
        d = decisions.get(r.decision_id) if r.decision_id else None
        asked_in = requests.get(r.request_id)
        out.append(
            {
                "id": r.id,
                "request_id": r.request_id,
                "root_request_id": r.root_request_id,
                "kind": r.kind,
                "decision_number": d.number if d else None,
                "asker": (names.get(r.member_id) if r.member_id else None) or r.asker or UNNAMED,
                "asker_kind": r.asker_kind,
                "member_id": r.member_id,
                "channel_asked": asked_in.channel if asked_in else None,
                "asked": r.asked,
                "body": r.body,
                "draft_source": r.draft_source,
                "warnings": list(r.warnings or []),
                "status": r.status,
                "channel": r.channel,
                "sent_on": r.sent_on,
                "sent_by_name": names.get(r.sent_by) if r.sent_by else None,
                "skip_reason": r.skip_reason,
                "notified_at": r.notified_at,
                "opened_at": r.opened_at,
                "drafting": r.job_id in running and r.status == OPEN and r.draft_source != "person",
                "lock_version": r.lock_version,
            }
        )
    return out


async def list_for(db: AsyncSession, request_id: uuid.UUID) -> list[RequestReply]:
    return list(
        await db.scalars(
            select(RequestReply)
            .where(RequestReply.root_request_id == request_id)
            .order_by(RequestReply.created_at, RequestReply.id)
        )
    )


# --- writing -----------------------------------------------------------------------------------


def _member_of(row: ProductRequest, names: dict[uuid.UUID, str]) -> uuid.UUID | None:
    """The member who asked: an in-app request filed in their own name (an owner may file
    one in someone else's)."""
    if row.channel != "in_app" or row.filed_by is None:
        return None
    mine = names.get(row.filed_by)
    return row.filed_by if mine is not None and row.requester_name == mine else None


async def create_replies(
    db: AsyncSession,
    root: ProductRequest,
    askers: list[ProductRequest],
    *,
    kind: str,
    decision: Decision | None,
) -> list[RequestReply]:
    """One reply per asker (their own request); none twice for the same decision."""
    have = set(
        await db.scalars(
            select(RequestReply.request_id).where(
                RequestReply.request_id.in_([a.id for a in askers]),
                RequestReply.kind == kind,
                RequestReply.decision_id == (decision.id if decision else None),
            )
        )
    )
    filers = await _names(db, {a.filed_by for a in askers if a.channel == "in_app" and a.filed_by})
    made = []
    for a in askers:
        if a.id in have:
            continue
        reply = RequestReply(
            request_id=a.id,
            root_request_id=root.id,
            kind=kind,
            decision_id=decision.id if decision else None,
            asker=a.requester_name,
            asker_kind=a.requester_kind,
            member_id=_member_of(a, filers),
            asked="\n\n".join(p for p in (a.title, a.body) if p),
        )
        db.add(reply)
        made.append(reply)
    if made:
        root.loop_closed_on = None
    await db.flush()
    return made


async def drafts_allowed(db: AsyncSession) -> bool:
    """H11 ``external_messages`` at Draft (default and ceiling): Oracle drafts replies.
    At Observe it writes none ("Write a reply")."""
    return await autonomy.allows(db, "external_messages", "draft")


async def running_job(db: AsyncSession, request_id: uuid.UUID) -> LlmJob | None:
    return await db.scalar(
        select(LlmJob).where(
            LlmJob.request_id == request_id,
            LlmJob.kind == "why_not_reply",
            LlmJob.status.in_(("queued", "running")),
        )
    )


async def queue_job(
    db: AsyncSession,
    principal: Principal | None,
    root: ProductRequest,
    replies: list[RequestReply],
    *,
    instruction: str | None = None,
) -> LlmJob | None:
    """One ``why_not_reply`` job for these replies, at Draft; None at Observe."""
    if not replies or not await drafts_allowed(db):
        return None
    job = LlmJob(
        kind="why_not_reply",
        request_id=root.id,
        status="queued",
        input={
            "reply_ids": [str(r.id) for r in replies],
            **({"instruction": instruction} if instruction else {}),
        },
        requested_by=principal.id if principal else None,
        attempts=0,
    )
    db.add(job)
    await db.flush()
    for r in replies:
        r.job_id = job.id
    await audit.record(
        db,
        principal if principal is not None else audit.ORACLE,
        "llm_job.queue",
        "llm_job",
        job.id,
        {"kind": "why_not_reply", "request_id": str(root.id), "replies": len(replies)},
    )
    return job


async def update_loop(db: AsyncSession, root: ProductRequest) -> None:
    """Loop closed: every reply Sent, Told in Oracle, Skipped or Withdrawn."""
    statuses = list(
        await db.scalars(select(RequestReply.status).where(RequestReply.root_request_id == root.id))
    )
    live = [s for s in statuses if s != "withdrawn"]
    if live and all(s in DONE for s in live):
        if root.loop_closed_on is None:
            from oracle.decisions.service import company_today

            root.loop_closed_on = await company_today(db)
    else:
        root.loop_closed_on = None


# --- the job -----------------------------------------------------------------------------------

REOPENED = "Say we are looking at it again; promise nothing."


async def _context(s: AsyncSession, root: ProductRequest) -> dict[str, Any]:
    """The decline as the prompt and the templates read it."""
    decision = await live_decision(s, root.id)
    basis = root.basis or {}
    entity = await s.get(Entity, uuid.UUID(basis["id"])) if basis.get("id") else None
    goals = [
        t
        for (t,) in (
            await s.execute(
                select(Entity.title)
                .where(Entity.type == "goal", Entity.status == "confirmed")
                .order_by(Entity.title)
                .limit(10)
            )
        ).all()
    ]
    theme = await s.get(RequestTheme, root.theme_id) if root.theme_id else None
    problem = None
    if theme is not None and theme.problem_state == "confirmed":
        problem = {
            "problem": theme.problem,
            "success": theme.success,
            "constraints": theme.constraints,
        }
    merged = await s.scalar(
        select(func.count(ProductRequest.id)).where(ProductRequest.merged_into_id == root.id)
    )
    return {
        "reason": root.disqualify_reason,
        "reason_label": LABELS.get(root.disqualify_reason or "", root.disqualify_reason),
        "note": root.decision_note,
        "basis": {
            "kind": basis.get("kind") or "none",
            "title": entity.title if entity else None,
            "text": (entity.body or "")[:2000] if entity else None,
        },
        "goals": goals,
        "problem": problem,
        "mentions": 1 + (merged or 0),
        "decision": decision.number if decision else None,
        "entity": entity,
    }


def _template_for(
    root: ProductRequest, reply: RequestReply, asked_in: ProductRequest | None, ctx: dict
) -> str:
    return template(
        root,
        root.disqualify_reason or "other",
        asker_words=their_words(asked_in or root),
        basis=ctx["basis"]["title"],
        basis_kind=ctx["basis"]["kind"],
        goals=ctx["goals"] if root.disqualify_reason == "no_goal" else [],
        note=root.decision_note,
        mentions=ctx["mentions"],
        kind=reply.kind,
    )


async def _job_replies(s: AsyncSession, job: LlmJob, *, lock: bool = False) -> list[RequestReply]:
    """The job's replies still Drafted. Locked only to write: never through a model call,
    so a person's edit never waits for one."""
    ids = [uuid.UUID(i) for i in (job.input or {}).get("reply_ids") or []]
    if not ids:
        return []
    stmt = (
        select(RequestReply)
        .where(RequestReply.id.in_(ids), RequestReply.status == OPEN)
        .order_by(RequestReply.created_at, RequestReply.id)
    )
    if lock:
        stmt = stmt.with_for_update().execution_options(populate_existing=True)
    return list(await s.scalars(stmt))


async def run_job(s: AsyncSession, job: LlmJob, ask: Any) -> dict[str, Any]:
    """Drafts each reply of the job in its own call, from that asker's words and the shared
    decision only, so one asker's text cannot shape another's reply (#541). Everything
    given is data."""
    root = await s.get(ProductRequest, job.request_id)
    replies = await _job_replies(s, job)
    if root is None or not replies:
        return {"replies": 0}
    ctx = await _context(s, root)
    shared = {
        "reason": ctx["reason_label"],
        "note": ctx["note"],
        "basis": ctx["basis"],
        "goals": ctx["goals"],
        "problem": ctx["problem"],
        "mentions": ctx["mentions"],
        "instruction": (job.input or {}).get("instruction"),
        "rule": (
            "Never promise later or a date. The decision is reviewed inside the company in 90 "
            "days, and the people who asked hear again only if it changes."
        ),
    }
    payloads = [
        {
            **shared,
            "replies": [
                {
                    "id": str(r.id),
                    "kind": r.kind,
                    "asker": r.asker or UNNAMED,
                    "asker_kind": r.asker_kind,
                    "asked": r.asked,
                }
            ],
        }
        for r in replies
    ]
    # The read (nothing written yet) ends before the calls: no lock while the model answers.
    job_id = job.id
    await s.rollback()
    drafted: dict[str, str] = {}
    for payload in payloads:
        mine = payload["replies"][0]["id"]
        answer = await ask("why_not_reply", payload)
        for x in answer.get("replies") or []:
            # Only the id this call was given: an answer cannot write another asker's reply.
            if isinstance(x, dict) and str(x.get("id")) == mine:
                drafted[mine] = str(x.get("body") or "").strip()
    oracle = template_n = 0
    # Re-read under lock: a person's edit made meanwhile is theirs to keep.
    job = await s.get(LlmJob, job_id, populate_existing=True)
    if job is None:
        return {"replies": 0}
    root = await s.get(ProductRequest, job.request_id, populate_existing=True)
    replies = [r for r in await _job_replies(s, job, lock=True) if r.draft_source != "person"]
    if root is None or not replies:
        return {"replies": 0}
    asked = {
        r.id: r
        for r in await s.scalars(
            select(ProductRequest)
            .where(ProductRequest.id.in_([x.request_id for x in replies]))
            .execution_options(populate_existing=True)
        )
    }
    for r in replies:
        body = drafted.get(str(r.id))
        if body:
            r.body, r.draft_source = body[:BODY_MAX], "oracle"
            oracle += 1
        elif r.body is None:
            r.body, r.draft_source = (
                _template_for(root, r, asked.get(r.request_id), ctx),
                "template",
            )
            template_n += 1
        r.warnings = promise_warnings(r.body, r.asked)
    return {"replies": len(replies), "oracle": oracle, "template": template_n}


async def fill_templates(
    s: AsyncSession, root: ProductRequest, replies: list[RequestReply]
) -> None:
    """The reason's template for each reply that has no draft yet."""
    empty = [r for r in replies if r.body is None and r.status == OPEN]
    if not empty:
        return
    ctx = await _context(s, root)
    asked = {
        r.id: r
        for r in await s.scalars(
            select(ProductRequest).where(ProductRequest.id.in_([x.request_id for x in empty]))
        )
    }
    for r in empty:
        r.body = _template_for(root, r, asked.get(r.request_id), ctx)
        r.draft_source = "template"
        r.warnings = promise_warnings(r.body, r.asked)


async def job_failed(s: AsyncSession, job: LlmJob) -> None:
    root = await s.get(ProductRequest, job.request_id) if job.request_id else None
    if root is None:
        return
    await fill_templates(s, root, await _job_replies(s, job, lock=True))


# --- people's actions ----------------------------------------------------------------------


def may_act(principal: Principal, root: ProductRequest) -> bool:
    """Approvers and owners, and the member who filed the request; never a run token."""
    if principal.is_run or principal.run_token_id is not None:
        return False
    return has_role(principal.role, "approver") or (
        root.filed_by is not None and root.filed_by == principal.id
    )


def now() -> datetime:
    return datetime.now(UTC)
