"""Startup data repair: links of source item versions written without one.

Migration 0014_intake gives ``source_item_versions`` a ``url`` and backfills it, but
an API or worker still running the previous image during a rollout keeps writing
versions without one until it stops. Those read as having no link (fail closed), and
this repair gives them the link the migration would have: their item's, or for a
Notion page the id-only page link (its usual link's slug carries the page's *current*
title, S6, links). Rows whose link would still be NULL are left alone, so nothing is
rewritten needlessly and a second run changes nothing.

It runs at API startup and once more ``LATE_RUN_SECONDS`` later (after a rolling
deploy, old replicas have stopped by then), and by hand with
``python -m oracle.sources.repair``. A version the current image writes with no link
had an item with no link then; if that item gains one later, this gives the version
that link, which never carries a title (only a Notion link does, and a Notion page
gets the id-only one).
"""

import asyncio
import logging

from sqlalchemy import text

from oracle.tenancy import unscoped_session

log = logging.getLogger(__name__)

LATE_RUN_SECONDS = 900
NOTION_ID = "'^[0-9a-f]{32}$'"
# The link 0014_intake's backfill gives a version (kept in step with it).
VERSION_URL = (
    """CASE
    WHEN so.kind <> 'notion' THEN si.url
    WHEN lower(replace(si.external_id, '-', '')) ~ """
    + NOTION_ID
    + """
        THEN 'https://www.notion.so/' || lower(replace(si.external_id, '-', ''))
    END"""
)
REPAIR = f"""
UPDATE source_item_versions v
SET url = {VERSION_URL}
FROM source_items si
JOIN sources so ON so.id = si.source_id
WHERE si.id = v.item_id AND v.url IS NULL AND ({VERSION_URL}) IS NOT NULL
"""


async def repair_version_urls() -> int:
    """Give versions written without a link the one 0014_intake would have; the count."""
    async with unscoped_session() as s:
        result = await s.execute(text(REPAIR))
        await s.commit()
    return result.rowcount or 0


async def run_at_startup(late_seconds: float = LATE_RUN_SECONDS) -> None:
    """Repair now and once more ``late_seconds`` later; a failure is logged, never fatal."""
    for delay in (0, late_seconds):
        await asyncio.sleep(delay)
        try:
            if repaired := await repair_version_urls():
                log.info("gave %d source item versions their link", repaired)
        except Exception:
            log.exception("repairing source item version links failed")


if __name__ == "__main__":
    print(asyncio.run(repair_version_urls()))
