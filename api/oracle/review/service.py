"""Review and feedback logic. Lane 2 implements; Lane 1 calls the functions below.

Contract with Lane 1 (document import), in the import transaction:

    version = DocumentVersion(...)          # flushed, so version.id exists
    locked = await locked_section_keys(db, previous_version.id)  # before writing sections
    ...
    await apply_resolutions(db, document.id, version.id, resolutions)

Neither function commits; the caller owns the transaction.
"""

import uuid
from collections.abc import Sequence

from sqlalchemy.ext.asyncio import AsyncSession

from oracle.review.models import FeedbackItem
from oracle.review.schemas import Resolution


class UnknownFeedbackItemsError(ValueError):
    """Resolutions reference feedback ids that do not exist on this document.

    Lane 1 turns this into a 422 (``code="unknown_feedback_item"``), one problem per id.
    """

    def __init__(self, feedback_ids: Sequence[uuid.UUID]):
        self.feedback_ids = list(feedback_ids)
        super().__init__(f"unknown feedback items: {', '.join(map(str, self.feedback_ids))}")


async def apply_resolutions(
    session: AsyncSession,
    document_id: uuid.UUID,
    version_id: uuid.UUID,
    resolutions: Sequence[Resolution],
) -> list[FeedbackItem]:
    """Apply a draft's front-matter ``resolutions`` to the document's feedback items.

    For each resolution: set the item's ``status`` (addressed | declined),
    ``resolution_note`` and ``addressed_in_version`` (the NUMBER of ``version_id``).
    Validates all ids first and raises :class:`UnknownFeedbackItemsError` without
    changing anything if any is unknown for ``document_id``. Returns the updated items.
    """
    raise NotImplementedError("lane 2: review.service.apply_resolutions")


async def locked_section_keys(session: AsyncSession, version_id: uuid.UUID) -> set[str]:
    """Section keys whose LATEST verdict in ``version_id`` is ``approved``.

    Lane 1 compares these against the next draft to emit ``locked_section_changed``;
    the feedback package reports them as ``locked_section_keys``.
    """
    raise NotImplementedError("lane 2: review.service.locked_section_keys")
