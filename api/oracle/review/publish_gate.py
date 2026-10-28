"""The publish gate (T2 follow-up, owner 2026-10-19; C5).

Approving a PRD version publishes it, so :func:`check` runs in the approve transaction,
after the document row is locked and before anything is written: the version must be the
document's latest (C5: to publish older text, restore it as a new version first), and
the readiness verdict for purpose ``publish`` must not be blocked, and something must be
written (#254: a version whose sections all hold only the template's text is refused). A refusal is
:class:`PublishBlocked`, which the router turns into a 409 naming the blocks. Every path
that approves (the UI, REST, the MCP ``approve_version`` tool) goes through it.

A roadmap version is refused while any date its text writes rests on no verified basis
(O4 'document dates', owner 2026-10-20: marked ``unverified`` or ``date withdrawn``): the
409 lists the dates; recording a basis, or a new draft without them, resolves it. Specs
keep their own checks.
"""

import uuid

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from oracle import readiness, wording
from oracle.baseline.models import Entity
from oracle.docs import written
from oracle.docs.models import Document, DocumentVersion
from oracle.quality import criteria
from oracle.readiness import ReadinessContext
from oracle.review.schemas import PublishBlock as Block
from oracle.roadmap import doc_dates

# The blockers lane's hard check (oracle/blockers/readiness.py): its evidence ids are the
# critical blockers, one block each, as the Publish screen lists them.
BLOCKERS_CHECK = "critical_blockers"


class PublishBlocked(Exception):
    def __init__(self, message: str, blocking: list[Block], dates: list[dict] | None = None):
        self.message = message
        self.blocking = blocking
        self.dates = dates or []
        super().__init__(message)


def _title(key: str) -> str:
    info = criteria.BY_KEY.get(key)
    return info.title if info else key.replace("_", " ").capitalize()


async def _blocks(db: AsyncSession, report: readiness.ReadinessReport) -> list[Block]:
    out: list[Block] = []
    for r in report.blocking:
        titles: dict[uuid.UUID, str] = {}
        if r.key == BLOCKERS_CHECK and r.evidence_ids:
            rows = await db.execute(
                select(Entity.id, Entity.title).where(Entity.id.in_(r.evidence_ids))
            )
            titles = {i: t for i, t in rows}
        if titles:
            out.extend(
                Block(key=r.key, id=str(i), title=titles[i], rationale=r.rationale)
                for i in r.evidence_ids
                if i in titles
            )
        else:
            out.append(Block(key=r.key, id=r.key, title=_title(r.key), rationale=r.rationale))
    return out


async def check(
    db: AsyncSession, document: Document, version: DocumentVersion
) -> readiness.ReadinessReport | None:
    """Raise :class:`PublishBlocked` when this PRD version may not be published, or this
    roadmap version writes a date no verified basis supports. A PRD's passing report is
    returned (the decision log records its summary, H1)."""
    if document.kind in ("roadmap", "update"):
        # H8: an update's dates rest on verified bases as a roadmap's do.
        await check_roadmap_dates(db, version)
        return None
    if document.kind != "prd":
        return None
    latest = await db.scalar(
        select(func.max(DocumentVersion.number)).where(DocumentVersion.document_id == document.id)
    )
    if latest is not None and latest != version.number:
        raise PublishBlocked(f"v{latest} exists: only the latest version can be published", [])
    if version.approved_at is None and await written.nothing_written(db, document, version):
        # #254: a version that is still only its template's text is never published.
        raise PublishBlocked(written.NOTHING_WRITTEN, [])
    from oracle.review.publish import REVIEW_CHECK_KEY

    # The review invariants are what this approval gives (the publish check computes
    # them itself): only the other checks gate an approval.
    keys = [r.key for r in readiness.checks() if r.key != REVIEW_CHECK_KEY]
    report = await readiness.evaluate(
        ReadinessContext(db, document.id, version.id, purpose="publish"), keys=keys
    )
    if report.blocked:
        blocks = await _blocks(db, report)
        noun = "block" if len(blocks) == 1 else "blocks"
        raise PublishBlocked(f"{len(blocks)} {noun}: {', '.join(b.title for b in blocks)}", blocks)
    return report


async def check_roadmap_dates(db: AsyncSession, version: DocumentVersion) -> None:
    """Raise :class:`PublishBlocked` listing every date of this roadmap version that is
    marked (``unverified`` or ``date withdrawn``) now. An approved version is not
    re-checked (approving it again changes nothing)."""
    if version.approved_at is not None:
        return
    from oracle.docs.models import Section

    sections = list(
        await db.scalars(
            select(Section).where(Section.version_id == version.id).order_by(Section.ordinal)
        )
    )
    marks = doc_dates.flagged(await doc_dates.marks_for_version(db, version, sections))
    if not marks:
        return
    detail, blocks = dates_refusal(marks, {s.section_key: s.heading for s in sections})
    raise PublishBlocked(detail, blocks, [m.as_json() for m in marks])


def dates_refusal(marks: list[doc_dates.Mark], headings: dict[str, str]) -> tuple[str, list[Block]]:
    """The 409's detail and blocks for these marked dates, in the app's words (#396): each
    date's section by its heading; the section key and date stay in the block's ``id``."""

    def where(m: doc_dates.Mark) -> str:
        if not m.section_key:
            return "the title"
        return wording.quoted(headings.get(m.section_key), "an untitled section")

    listed = ", ".join(f"{doc_dates.shown(m)} ({where(m)}: {m.label})" for m in marks)
    noun = "date is" if len(marks) == 1 else "dates are"
    detail = (
        f"{len(marks)} {noun} not backed by a confirmed schedule: {listed}. Record a date "
        "basis for each on Plan › Dates (or ask the engineering lead to), or import a draft "
        "without them"
    )
    blocks = [
        Block(
            key="unverified_date",
            id=f"{m.section_key}:{m.text}",
            # qa-docs-2: the date as people read it ("Dec 15, 2026"); as written in ``id``.
            title=doc_dates.shown(m),
            rationale=doc_dates.problem_message(m, None, heading=headings.get(m.section_key))
            if m.status == "withdrawn"
            else f"{doc_dates.shown(m)} ({where(m)}) is not backed by a confirmed schedule",
        )
        for m in marks
    ]
    return detail, blocks
