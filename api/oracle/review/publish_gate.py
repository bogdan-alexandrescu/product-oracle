"""The publish gate (T2 follow-up, owner 2026-10-19; C5).

Approving a PRD version publishes it, so :func:`check` runs in the approve transaction,
after the document row is locked and before anything is written: the version must be the
document's latest (C5: to publish older text, restore it as a new version first), and
the readiness verdict for purpose ``publish`` must not be blocked. A refusal is
:class:`PublishBlocked`, which the router turns into a 409 naming the blocks. Every path
that approves (the UI, REST, the MCP ``approve_version`` tool) goes through it.

Documents of other kinds (roadmap, spec) keep their own checks.
"""

import uuid

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from oracle import readiness
from oracle.baseline.models import Entity
from oracle.docs.models import Document, DocumentVersion
from oracle.quality import criteria
from oracle.readiness import ReadinessContext
from oracle.review.schemas import PublishBlock as Block

# The blockers lane's hard check (oracle/blockers/readiness.py): its evidence ids are the
# critical blockers, one block each, as the Publish screen lists them.
BLOCKERS_CHECK = "critical_blockers"


class PublishBlocked(Exception):
    def __init__(self, message: str, blocking: list[Block]):
        self.message = message
        self.blocking = blocking
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


async def check(db: AsyncSession, document: Document, version: DocumentVersion) -> None:
    """Raise :class:`PublishBlocked` when this PRD version may not be published."""
    if document.kind != "prd":
        return
    latest = await db.scalar(
        select(func.max(DocumentVersion.number)).where(DocumentVersion.document_id == document.id)
    )
    if latest is not None and latest != version.number:
        raise PublishBlocked(f"v{latest} exists: only the latest version can be published", [])
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
