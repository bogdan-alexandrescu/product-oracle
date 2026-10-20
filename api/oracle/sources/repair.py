"""Startup data repair: links of source item versions written without one.

Migration 0014_intake gives ``source_item_versions`` a ``url`` and backfills it, but
an API or worker still running the previous image during a rollout keeps writing
versions without one until it stops. Those read as having no link (fail closed), and
this repair gives them the link the migration would have: built from their item's id
only, never the item's current link (a Notion page's or Fireflies meeting's link
carries its *current* title, a GitHub link its repository's current name; S6, links).
Rows whose link would still be NULL are left alone, so nothing is rewritten needlessly
and a second run changes nothing.

It runs at API startup and once more ``LATE_RUN_SECONDS`` later (after a rolling
deploy, old replicas have stopped by then), and by hand with
``python -m oracle.sources.repair``. A version the current image writes with no link
had an item with no link then; if that item gains one later, this gives the version
the id-only link, never one carrying a name from after the version was written.
"""

import asyncio
import logging

from sqlalchemy import text

from oracle.tenancy import unscoped_session

log = logging.getLogger(__name__)

LATE_RUN_SECONDS = 900
# The link 0014_intake's backfill gives a version (kept in step with it): from the item's
# id only, never the item's current link, which can carry a name that changed after
# sharing (a Notion page's or Fireflies meeting's title, a GitHub repository's name).
# Notion: the id-only page link; Fireflies: the transcript id; Google Docs: the file id;
# GitHub: the repository as the source names it in the item's id (issues, pull requests
# and milestones; a release or file names no link by id); Slack: the permalink, which
# carries channel and message ids only. Anything else (an upload), or an id not of the
# expected form, gets none (fail closed).
VERSION_URL = """CASE so.kind
    WHEN 'notion' THEN CASE
        WHEN lower(replace(si.external_id, '-', '')) ~ '^[0-9a-f]{32}$'
        THEN 'https://www.notion.so/' || lower(replace(si.external_id, '-', '')) END
    WHEN 'fireflies' THEN CASE
        WHEN si.external_id ~ '^[A-Za-z0-9]+$'
        THEN 'https://app.fireflies.ai/view/' || si.external_id END
    WHEN 'google_docs' THEN CASE
        WHEN si.external_id ~ '^[A-Za-z0-9_-]+$'
        THEN 'https://docs.google.com/document/d/' || si.external_id || '/edit' END
    WHEN 'github' THEN CASE
        WHEN si.external_id ~ '^[a-z0-9._-]+/[a-z0-9._-]+:(issue|pull|milestone):[0-9]+$'
        THEN 'https://github.com/' || split_part(si.external_id, ':', 1) || '/'
            || CASE split_part(si.external_id, ':', 2) WHEN 'issue' THEN 'issues'
                ELSE split_part(si.external_id, ':', 2) END
            || '/' || split_part(si.external_id, ':', 3) END
    WHEN 'slack' THEN CASE
        WHEN si.url ~ '^https://[^/?#]+/archives/[A-Z0-9]+/p[0-9]+$' THEN si.url END
END"""

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
