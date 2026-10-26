"""S4 Freshness: "N new items since draft k, refresh?" on a PRD draft.

A draft was written from its author's sources as they stood at one moment: the snapshot
its run pinned (``runs.snapshot_id``, the run found through the review checkpoint whose
import made the version, ``oracle.runs.review_link.checkpoint_for``), or, for a version
imported by hand, the moment of the import. The author is the person the run acted for
(``runs.created_by``) or who imported it; an API token stands for the member it belongs
to. Their items new, changed or deleted since then are counted as an intake counts them
since its pin (``oracle.intake.evidence.changed_since``). Only the author sees the number:
a source is visible to its owner only (S5), and a run token never does (S6)."""

import uuid

from sqlalchemy.ext.asyncio import AsyncSession

from oracle.auth.deps import Principal
from oracle.auth.models import ApiToken
from oracle.docs.models import Document, DocumentVersion
from oracle.docs.schemas import DraftNewItems
from oracle.intake.evidence import changed_since
from oracle.runs import review_link
from oracle.runs.models import Run
from oracle.sources.models import Snapshot


async def _person(db: AsyncSession, actor: uuid.UUID | None) -> uuid.UUID | None:
    """The member behind ``actor``: a user id as it is, an API token's member."""
    if actor is None:
        return None
    token = await db.get(ApiToken, actor)
    return token.user_id if token is not None else actor


async def new_items(
    db: AsyncSession, principal: Principal, document: Document, version: DocumentVersion
) -> DraftNewItems:
    cp = await review_link.checkpoint_for(db, document.id, version.number)
    run = await db.get(Run, cp.run_id) if cp is not None else None
    author = await _person(db, run.created_by if run is not None else version.imported_by)
    hidden = DraftNewItems(version=version.number)
    if (
        author is None
        or principal.is_run
        or principal.kind != "user"
        or principal.user_id != author
    ):
        return hidden
    snapshot = await db.get(Snapshot, run.snapshot_id) if run and run.snapshot_id else None
    if snapshot is not None:
        as_of, txn = snapshot.as_of, snapshot.txn_snapshot
    else:
        as_of, txn = version.created_at, None
    found = await changed_since(db, author, [], as_of, txn)
    return DraftNewItems(version=version.number, as_of=as_of, count=len(found), visible=True)
