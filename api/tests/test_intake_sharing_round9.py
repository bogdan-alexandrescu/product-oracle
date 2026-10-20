"""Security review, round 9 (S6, owner decision of 2026-10-20: links).

(1) An item's link freezes with its title and text when shared: a Notion link carries
    the page title, so a rename upstream must never reach anyone through the link.
    The link is stored on the version (like the title) and served from the version
    released wherever that version is served: ``item_out`` (search, the source-item
    route, source and snapshot lists), intake evidence refs, and baseline evidence.

Minors: a run never reads a frozen item it may no longer read through ``attach``;
another user's item is scored by the version released, not by when it changed
upstream; another user's item carries no current scalar acl field.

Synthetic placeholders only.
"""

import uuid
from datetime import UTC, datetime

from oracle.sources import store
from oracle.sources.base import ItemUpsert
from oracle.sources.models import Source, SourceItem, SourceItemVersion
from oracle.tenancy import tenant_session
from tests.test_intake_sharing import TITLE_A, share_all
from tests.test_intake_sharing_round5 import world
from tests.test_intake_sharing_round6 import (
    RUNS,
    as_run_of,
    evidence_hits,
    fake,  # noqa: F401 (fixture)
)
from tests.test_intake_sharing_round7 import EDITED_A, _search

PAGE_ID = "1f2e3d4c-5b6a-4987-8a1b-2c3d4e5f6a7b"
PAGE_HEX = PAGE_ID.replace("-", "")
OLD_LINK = f"https://www.notion.so/Saved-addresses-{PAGE_HEX}"
NEW_SLUG = "Acquisition-of-Example-Corp"
NEW_LINK = f"https://www.notion.so/{NEW_SLUG}-{PAGE_HEX}"
NEW_TITLE = "Acquisition of Example Corp"


async def _as_notion_page(ctx, item_id: uuid.UUID) -> None:
    """Make ``item_id`` a Notion page whose link carries its (shared) title."""
    async with tenant_session(ctx.tenant_id) as s:
        item = await s.get(SourceItem, item_id)
        source = await s.get(Source, item.source_id)
        source.kind = "notion"
        item.external_id = PAGE_ID
        item.url = OLD_LINK
        version = await s.get(SourceItemVersion, item.current_version_id)
        version.url = OLD_LINK
        await s.commit()


async def _rename_page(ctx, item_id: uuid.UUID, *, content: str | None = None) -> None:
    """Rename the page upstream (its slug changes): alone, or with an edit."""
    async with tenant_session(ctx.tenant_id) as s:
        item = await s.get(SourceItem, item_id)
        source = await s.get(Source, item.source_id)
        current = await s.get(SourceItemVersion, item.current_version_id)
        event = ItemUpsert(
            external_id=item.external_id, kind=item.kind, title=NEW_TITLE, url=NEW_LINK,
            author=None, content=content or current.content,
            source_updated_at=datetime.now(UTC),
        )  # fmt: skip
        await store.upsert_item(s, source, event)
        await s.commit()


async def _run_links(client, ctx, who: str, intake_id: str, item_id) -> dict[str, str | None]:
    """The link of ``item_id`` on every route ``who``'s run reads it through."""
    h = as_run_of(ctx, who)
    out: dict[str, str | None] = {}
    resp = await client.get(f"/v1/source-items/{item_id}", headers=h)
    assert resp.status_code == 200, resp.text
    assert resp.json()["title"] == TITLE_A
    out["source-item"] = resp.json()["url"]
    hits = {x["item"]["id"]: x for x in await _search(client, ctx, who, "buyers")}
    out["search"] = hits[str(item_id)]["item"]["url"]
    hits = {x["source_item_id"]: x for x in await evidence_hits(client, ctx, intake_id, who)}
    out["intake-evidence"] = hits[str(item_id)]["url"]
    if who == "author":
        source_id = resp.json()["source_id"]
        resp = await client.get(f"/v1/sources/{source_id}/items", headers=h)
        assert resp.status_code == 200, resp.text
        out["source-list"] = {x["id"]: x for x in resp.json()}[str(item_id)]["url"]
        resp = await client.post("/v1/snapshots", json={"label": "probe"}, headers=h)
        assert resp.status_code == 201, resp.text
        resp = await client.get(f"/v1/snapshots/{resp.json()['id']}/items", headers=h)
        out["snapshot"] = {x["id"]: x for x in resp.json()}[str(item_id)]["url"]
    return out


# --- item 1: links freeze with the title and text ------------------------------------------


async def test_a_run_sees_the_link_as_shared_after_an_upstream_rename(client, fake):  # noqa: F811
    """The reviewer's probe: a shared Notion page renamed upstream (alone, then with an
    edit); every route a run reads it through gives the link as shared, never the new."""
    ctx, intake_id, items = await world(client, fake, hidden=False)
    await _as_notion_page(ctx, items["a"])
    await share_all(client, ctx, intake_id, "full")
    for content in (None, EDITED_A):
        await _rename_page(ctx, items["a"], content=content)
        for who in RUNS:
            links = await _run_links(client, ctx, who, intake_id, items["a"])
            assert set(links.values()) == {OLD_LINK}, (who, content, links)


async def test_people_never_see_the_renamed_link_of_a_shared_item(client, fake):  # noqa: F811
    """The intake summary, question batch and evidence route others read: the link as
    shared (refs of a finding shared in full), never the slug of the new title."""
    ctx, intake_id, items = await world(client, fake, hidden=False)
    await _as_notion_page(ctx, items["a"])
    await share_all(client, ctx, intake_id, "full")
    await _rename_page(ctx, items["a"], content=EDITED_A)
    h = ctx.as_("approver")
    seen = ""
    for path in ("summary", "question-batch", "findings"):
        resp = await client.get(f"/v1/intakes/{intake_id}/{path}", headers=h)
        assert resp.status_code in (200, 404), resp.text
        assert NEW_SLUG not in resp.text, path
        seen += resp.text
    assert OLD_LINK in seen


async def test_attach_stores_the_link_as_shared(client, fake):  # noqa: F811
    from tests.baseline_helpers import entity

    ctx, intake_id, items = await world(client, fake, hidden=False, role="approver")
    await _as_notion_page(ctx, items["a"])
    await share_all(client, ctx, intake_id, "full")
    feat = await entity(client, ctx, type="feature", key="saved-addresses")
    url = f"/v1/baseline/entities/{feat['id']}/evidence"
    for content in (None, EDITED_A):
        await _rename_page(ctx, items["a"], content=content)
        resp = await client.post(
            url, json={"source_item_id": str(items["a"])}, headers=as_run_of(ctx, "author")
        )
        assert resp.status_code == 201, resp.text
        assert resp.json()["url"] == OLD_LINK, content
    for headers in (as_run_of(ctx, "author"), ctx.as_("approver")):
        resp = await client.get(f"/v1/baseline/entities/{feat['id']}", headers=headers)
        assert resp.status_code == 200, resp.text
        assert NEW_SLUG not in resp.text
        assert [e["url"] for e in resp.json()["evidence"]] == [OLD_LINK, OLD_LINK]
    # The run reading the evidence sees its item at the version released, link included.
    resp = await client.get(f"/v1/baseline/entities/{feat['id']}", headers=as_run_of(ctx, "author"))
    assert {e["source_item"]["url"] for e in resp.json()["evidence"]} == {OLD_LINK}


async def test_a_version_keeps_the_link_it_was_written_with(client):
    """``upsert_item`` copies the link onto the version it writes; a rename alone writes
    no version, so the version keeps the link it had."""
    from tests.baseline_helpers import make_item
    from tests.intake_helpers import company
    from tests.test_intake_sharing import add_author

    ctx = await company()
    await add_author(ctx)
    item_id = await make_item(ctx, "author", kind="notion", url=OLD_LINK)
    async with tenant_session(ctx.tenant_id) as s:
        item = await s.get(SourceItem, item_id)
        source = await s.get(Source, item.source_id)
        event = ItemUpsert(
            external_id=item.external_id, kind=item.kind, title="v2", url=OLD_LINK,
            author=None, content="A new version.", source_updated_at=datetime.now(UTC),
        )  # fmt: skip
        _, written = await store.upsert_item(s, source, event)
        assert written
        version_id = item.current_version_id
        await s.commit()
    await _rename_page(ctx, item_id)
    async with tenant_session(ctx.tenant_id) as s:
        item = await s.get(SourceItem, item_id)
        assert item.current_version_id == version_id
        assert item.url == NEW_LINK
        assert (await s.get(SourceItemVersion, version_id)).url == OLD_LINK


# --- minors ------------------------------------------------------------------------------------


async def test_attach_refuses_a_frozen_item_no_longer_released(client, fake):  # noqa: F811
    """An item a share froze whose release reads nothing now (here: the release names
    another item's version) is missing to the run's attach, like ``get_source_item``;
    it never falls back to the current version."""
    from sqlalchemy import select

    from oracle.intake.models import IntakeSharedItem
    from tests.baseline_helpers import entity

    ctx, intake_id, items = await world(client, fake, hidden=False, role="approver")
    await share_all(client, ctx, intake_id, "full")
    async with tenant_session(ctx.tenant_id) as s:
        b = await s.get(SourceItem, items["b"])
        for row in await s.scalars(
            select(IntakeSharedItem).where(IntakeSharedItem.item_id == items["a"])
        ):
            row.version_id = b.current_version_id
        await s.commit()
    h = as_run_of(ctx, "author")
    assert (await client.get(f"/v1/source-items/{items['a']}", headers=h)).status_code == 404
    feat = await entity(client, ctx, type="feature", key="saved-addresses")
    resp = await client.post(
        f"/v1/baseline/entities/{feat['id']}/evidence",
        json={"source_item_id": str(items["a"])},
        headers=h,
    )
    assert resp.status_code == 404, resp.text


async def test_another_users_item_scores_by_the_version_released(client, fake):  # noqa: F811
    """Freshness of another user's released item comes from the version released, not
    from when it changed upstream since (which would leak that it changed)."""
    ctx, intake_id, items = await world(client, fake, hidden=False)
    await share_all(client, ctx, intake_id, "full")
    h = as_run_of(ctx, "approver")
    before = (await client.get(f"/v1/source-items/{items['a']}", headers=h)).json()
    async with tenant_session(ctx.tenant_id) as s:
        item = await s.get(SourceItem, items["a"])
        item.source_updated_at = datetime(2001, 1, 1, tzinfo=UTC)
        item.occurred_at = datetime(2001, 1, 1, tzinfo=UTC)
        await s.commit()
    after = (await client.get(f"/v1/source-items/{items['a']}", headers=h)).json()
    assert after["confidence"] == before["confidence"]


async def test_another_users_item_carries_no_current_acl_field(client, fake):  # noqa: F811
    """Channel or repository names and sharing flags are current, not frozen: another
    user's released item carries none of them."""
    ctx, intake_id, items = await world(client, fake, hidden=False)
    await share_all(client, ctx, intake_id, "full")
    async with tenant_session(ctx.tenant_id) as s:
        item = await s.get(SourceItem, items["a"])
        item.acl = {"visibility": "private", "channel_name": "#acquisition-example-corp",
                    "repo": "example/acquisition", "shared": True}  # fmt: skip
        await s.commit()
    h = as_run_of(ctx, "approver")
    resp = await client.get(f"/v1/source-items/{items['a']}", headers=h)
    hits = {x["item"]["id"]: x["item"] for x in await _search(client, ctx, "approver", "buyers")}
    for out in (resp.json(), hits[str(items["a"])]):
        assert "acquisition" not in str(out["acl"])
        assert "shared" not in out["acl"]
