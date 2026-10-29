"""The company's current plan, first in Oracle's Ask on Simple's pages (the owner's
production walk, 2026-10-27).

Asked "what is M2 about and when does it run?" on Simple's Home, Ask had nothing of the
plan in its context and went to a meeting-notes search instead. On a Simple page the
reply's context now opens with the plan, before anything else (:func:`add`):

- each approved PRD's brief, from its latest approved version: the sections a one-pager
  is made of (summary and problem, goals and targets, milestones with dates, outcomes,
  features per milestone, not doing, risks, open decisions) and nothing else (the review:
  the block goes with every turn, so the PRD's detail stays out), within ``PRD_CHARS`` per
  PRD and ``PLAN_CHARS`` in all;
- the roadmap (oracle.simple.service's read: every roadmap's published items with their
  dates, horizon, status and PRD, and the tracks' milestones);
- the open decisions (proposed, newest last).

Read permissions are the session's (oracle.docs.visibility): the reply's session reads as
a commenter would whenever more than approvers may be in the discussion
(context.member_view), so a document hidden from commenters and viewers, and the roadmap
items and decisions hanging off it, are never in it. The sources (live reads) come after,
only when the plan does not answer (:data:`PLAN_FIRST`, the reply's system line).
"""

import re
from typing import Any

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from oracle.intake import sharing

PLAN_CHARS = 24_000
PRD_CHARS = 8_000
SECTION_CHARS = 2_000
MAX_ITEMS = 80
MAX_DECISIONS = 20
# The brief's sections, by heading: what a one-pager is made of.
BRIEF = re.compile(
    r"summary|overview|problem|goal|target|metric|success|milestone|timeline|phase|"
    r"outcome|feature|scope|bet|not doing|non-goal|out of scope|risk|open decision|"
    r"open question|decision",
    re.I,
)
PLAN_FIRST = (
    "The data opens with the company's plan (approved PRDs, the roadmap and the open "
    "decisions). Answer questions about the plan, its milestones, dates, outcomes and "
    "features from it first, citing it. Read a live source only when the plan does not "
    'answer. If a live source fails, say only: "Meeting notes could not be searched just '
    "now.\" Never show an error code, an HTTP status or a connector's name in an error. "
    # The Ask panel draws this shape (the owner's pick C, ask-panel fidelity, 2026-10-28):
    # the name as its title, the when line, short labelled lists, the sources under it.
    "Asked what a milestone or an item is about, answer in this shape: its name in bold on "
    "the first line; one line with when it runs (and its effort when the plan says it); "
    "then short sections, each a '### ' heading (such as Done when, Targets, Builds) over a "
    "short bullet list, citing the plan."
)
SOURCE_DOWN = "Meeting notes could not be searched just now."


def simple_page(d: Any) -> bool:
    """A panel chat started on one of Simple's pages."""
    path = str((d.subject or {}).get("path") or "") if d.subject_kind == "screen" else ""
    return path == "/simple" or path.startswith("/simple/")


async def _prds(db: AsyncSession, ctx: Any, start: int) -> None:
    from oracle.docs.models import Document, DocumentVersion, Section

    approved = (
        select(DocumentVersion.document_id, func.max(DocumentVersion.number).label("n"))
        .where(DocumentVersion.approved_at.is_not(None))
        .group_by(DocumentVersion.document_id)
        .subquery()
    )
    rows = (
        await db.execute(
            select(Document, DocumentVersion)
            .join(approved, approved.c.document_id == Document.id)
            .join(
                DocumentVersion,
                (DocumentVersion.document_id == Document.id)
                & (DocumentVersion.number == approved.c.n),
            )
            .where(Document.kind == "prd")
            .order_by(Document.title)
        )
    ).all()
    for doc, version in rows:
        sections = list(
            await db.scalars(
                select(Section).where(Section.version_id == version.id).order_by(Section.ordinal)
            )
        )
        # The brief alone, in reading order.
        sections = [s for s in sections if s.layer == "brief" or BRIEF.search(s.heading or "")]
        ctx.note(f"PRD: {doc.title} (approved version {version.number})")
        used = 0
        for sec in sections:
            text = sharing.one_line(sec.body_text or "", SECTION_CHARS)
            if not text:
                continue
            if used + len(text) > PRD_CHARS or ctx.size - start + len(text) > PLAN_CHARS:
                ctx.note("The rest of this PRD is not shown.")
                break
            if ctx.add("section", f"{doc.id}:{sec.section_key}", f"{doc.title}: {sec.heading}",
                       text, url=f"/documents/{doc.slug}") is None:  # fmt: skip
                return
            used += len(text)


def _when(e: Any) -> str:
    start, end = e.resolved.start.date, e.resolved.end.date
    if e.resolved.estimated:
        return f"estimated {start} to {end} (no dates set)"
    return f"{start} to {end}"


async def _roadmap(db: AsyncSession, ctx: Any) -> None:
    from oracle.simple import service

    read = await service.load(db)
    for e in read.entries[:MAX_ITEMS]:
        parts = [f"roadmap {e.roadmap.title}", f"horizon {e.row.horizon}", _when(e),
                 f"status {e.status}"]  # fmt: skip
        if e.prd is not None:
            parts.append(f"PRD {e.prd.title}")
        if e.track is not None:
            parts.append(f"track {e.track.title}")
        if e.milestone is not None and e.milestone.name:
            on = f" on {e.milestone.date}" if e.milestone.date else ""
            parts.append(f"milestone {e.milestone.name}{on}")
        if e.row.outcome:
            parts.append(f"outcome {sharing.one_line(e.row.outcome, 300)}")
        ctx.add("roadmap_item", str(e.row.id), f"Roadmap item: {e.row.title}", "; ".join(parts),
                url="/simple/roadmap")  # fmt: skip
    for m in read.milestones:
        when = f"target {m.target_date}" if m.target_date else f"horizon {m.horizon}"
        ctx.add("milestone", str(m.id), f"Milestone: {m.name}", f"{when}; status {m.status}",
                url="/simple/roadmap")  # fmt: skip


async def _decisions(db: AsyncSession, ctx: Any) -> None:
    from oracle.decisions.models import Decision

    rows = await db.scalars(
        select(Decision)
        .where(Decision.status == "proposed")
        .order_by(Decision.number.desc())
        .limit(MAX_DECISIONS)
    )
    for d in reversed(list(rows)):
        ctx.add("decision", str(d.id), f"Open decision D-{d.number}", sharing.one_line(
                    d.title + (f" ({d.question})" if d.question else ""), 400),
                url="/simple/decisions")  # fmt: skip


async def add(db: AsyncSession, ctx: Any) -> None:
    """The plan, first in ``ctx`` (a discussions.context.Context), within ``PLAN_CHARS``."""
    start = ctx.size
    ctx.note("The company's current plan (read it first):")
    await _prds(db, ctx, start)
    await _roadmap(db, ctx)
    await _decisions(db, ctx)
    ctx.plan = True


# A tool's failure, as a model repeats it: an HTTP code, or a search or read that failed.
# Plan content naming a tool ("the Slack pilot failed its target") is not one (the review).
_RAW = re.compile(
    r"[^.!?\n]*(?:\bHTTP\s*\d{3}\b|\b(?:search|read|lookup|query|request|call)(?:es|s)?\s+"
    r"(?:failed|errored|returned an error|did not answer|timed out)\b)[^.!?\n]*[.!?]?",
    re.I,
)


def plain_failures(body: str) -> str:
    """A reply never shows a source's failure raw (no HTTP codes, no connector's name in an
    error): each such sentence becomes the one plain line, said once. The caller runs it
    only on a Simple reply whose live read failed (oracle.discussions.replies)."""
    said = False

    def one(m: re.Match) -> str:
        nonlocal said
        if said:
            return ""
        said = True
        lead = m.group(0)[: len(m.group(0)) - len(m.group(0).lstrip())]
        return lead + SOURCE_DOWN

    out = _RAW.sub(one, body)
    return re.sub(r"[ \t]{2,}", " ", out).strip() if said else body
