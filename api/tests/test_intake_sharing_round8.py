"""Security review, round 8 (S6, owner decisions of 2026-10-19: freeze at sharing and
titles).

(1) An item a finding shared in full released and that was later deleted upstream is
    never found by a run's ``/v1/search``, whatever ``as_of`` it asks for: an item ever
    frozen is read only through the shared path, never as the run's user's own item;
(2) an item's title freezes with its text: runs see the title as it was when shared on
    every route, and baseline evidence attached from it carries that title.

Synthetic placeholders only.
"""

import uuid
from datetime import UTC, datetime

from oracle.sources import store
from oracle.sources.base import ItemUpsert
from oracle.sources.models import Source, SourceItem
from oracle.tenancy import tenant_session
from tests.test_intake_sharing import EXCERPT_A, TITLE_A, share_all
from tests.test_intake_sharing_round5 import world
from tests.test_intake_sharing_round6 import (
    RUNS,
    as_run_of,
    evidence_hits,
    fake,  # noqa: F401 (fixture)
)
from tests.test_intake_sharing_round7 import EDIT_WORD, EDITED_A, _delete, _search, _sync

RENAMED = "#renamed-after-sharing"


async def _rename(ctx, item_id: uuid.UUID, *, content: str | None = None) -> None:
    """Rename the item upstream: alone (no new version), or with ``content`` (a new one)."""
    async with tenant_session(ctx.tenant_id) as s:
        item = await s.get(SourceItem, item_id)
        source = await s.get(Source, item.source_id)
        current = await s.get(store.SourceItemVersion, item.current_version_id)
        event = ItemUpsert(
            external_id=item.external_id, kind=item.kind, title=RENAMED, url=item.url,
            author=None, content=content or current.content,
            source_updated_at=datetime.now(UTC),
        )  # fmt: skip
        await store.upsert_item(s, source, event)
        await s.commit()


# --- item 1: deleted shared items and as_of -------------------------------------------------


async def test_as_of_never_finds_a_shared_item_deleted_upstream(client, fake):  # noqa: F811
    """The reviewer's probe: shared in full (frozen at v1), edited upstream (v2), then
    deleted; a run searching with ``as_of`` between edit and delete finds nothing of it."""
    ctx, intake_id, items = await world(client, fake, hidden=False)
    await share_all(client, ctx, intake_id, "full")
    await _sync(ctx, items["a"], EDITED_A)
    between = datetime.now(UTC).isoformat()
    await _delete(ctx, items["a"])
    for who in RUNS:
        assert await _search(client, ctx, who, EDIT_WORD, as_of=between) == [], who
        for q in ("buyers", "address"):
            for as_of in (between, None):
                params = {"as_of": as_of} if as_of else {}
                hits = await _search(client, ctx, who, q, **params)
                assert str(items["a"]) not in {h["item"]["id"] for h in hits}, (who, q)


async def test_search_and_source_items_agree_for_runs(client, fake):  # noqa: F811
    """Whatever a run's search finds, at any ``as_of``, ``/v1/source-items/{id}`` reads at
    the same version; what it 404s, search never finds."""
    ctx, intake_id, items = await world(client, fake, hidden=False)
    await share_all(client, ctx, intake_id, "full")
    await _sync(ctx, items["a"], EDITED_A)
    between = datetime.now(UTC).isoformat()
    await _delete(ctx, items["b"])
    for who in RUNS:
        h = as_run_of(ctx, who)
        for params in ({}, {"as_of": between}, {"as_of": "2001-01-01T00:00:00Z"}):
            for q in ("buyers", "address", "finance", EDIT_WORD):
                for hit in await _search(client, ctx, who, q, **params):
                    resp = await client.get(f"/v1/source-items/{hit['item']['id']}", headers=h)
                    assert resp.status_code == 200, (who, q, params)
                    assert resp.json()["version_id"] == hit["item"]["version_id"], (who, q)
        for item_id in items.values():
            status = (await client.get(f"/v1/source-items/{item_id}", headers=h)).status_code
            if status == 404:
                for params in ({}, {"as_of": between}):
                    for q in ("buyers", "address", "finance"):
                        found = {
                            x["item"]["id"] for x in await _search(client, ctx, who, q, **params)
                        }
                        assert str(item_id) not in found, (who, item_id, q, params)


# --- item 2: titles freeze with the text ------------------------------------------------------


async def _run_titles(client, ctx, who: str, intake_id: str, item_id) -> dict[str, str | None]:
    """The title of ``item_id`` on every route ``who``'s run reads it through."""
    h = as_run_of(ctx, who)
    out: dict[str, str | None] = {}
    resp = await client.get(f"/v1/source-items/{item_id}", headers=h)
    assert resp.status_code == 200, resp.text
    out["source-item"] = resp.json()["title"]
    hits = {x["item"]["id"]: x for x in await _search(client, ctx, who, "buyers")}
    out["search"] = hits[str(item_id)]["item"]["title"]
    hits = {x["source_item_id"]: x for x in await evidence_hits(client, ctx, intake_id, who)}
    out["intake-evidence"] = hits[str(item_id)]["title"]
    if who == "author":
        source_id = resp.json()["source_id"]
        for deleted in ("false", "true"):
            resp = await client.get(
                f"/v1/sources/{source_id}/items", params={"include_deleted": deleted}, headers=h
            )
            assert resp.status_code == 200, resp.text
            listed = {x["id"]: x for x in resp.json()}
            out[f"source-list-{deleted}"] = listed[str(item_id)]["title"]
        resp = await client.post("/v1/snapshots", json={"label": "probe"}, headers=h)
        assert resp.status_code == 201, resp.text
        resp = await client.get(f"/v1/snapshots/{resp.json()['id']}/items", headers=h)
        assert resp.status_code == 200, resp.text
        out["snapshot"] = {x["id"]: x for x in resp.json()}[str(item_id)]["title"]
    return out


async def test_a_run_sees_the_title_as_shared_after_an_upstream_rename(client, fake):  # noqa: F811
    ctx, intake_id, items = await world(client, fake, hidden=False)
    await share_all(client, ctx, intake_id, "full")
    await _rename(ctx, items["a"], content=EDITED_A)
    for who in RUNS:
        titles = await _run_titles(client, ctx, who, intake_id, items["a"])
        assert set(titles.values()) == {TITLE_A}, (who, titles)


async def test_a_run_never_lists_deleted_items(client, fake):  # noqa: F811
    """``include_deleted`` is ignored for runs, on every list."""
    ctx, intake_id, items = await world(client, fake, hidden=False)
    await share_all(client, ctx, intake_id, "full")
    h = as_run_of(ctx, "author")
    source_id = (await client.get(f"/v1/source-items/{items['a']}", headers=h)).json()["source_id"]
    await _delete(ctx, items["a"])
    resp = await client.get(
        f"/v1/sources/{source_id}/items", params={"include_deleted": "true"}, headers=h
    )
    assert resp.status_code == 200, resp.text
    assert str(items["a"]) not in {x["id"] for x in resp.json()}
    # The author, as themselves, still lists it.
    resp = await client.get(
        f"/v1/sources/{source_id}/items", params={"include_deleted": "true"},
        headers=ctx.as_("author"),
    )  # fmt: skip
    assert str(items["a"]) in {x["id"] for x in resp.json()}


async def test_a_snapshot_a_run_opens_serves_shared_items_frozen(client, fake):  # noqa: F811
    """A snapshot taken after the edit: the run still reads the shared item at the
    version (and title) released, and never an item deleted since."""
    ctx, intake_id, items = await world(client, fake, hidden=False)
    await share_all(client, ctx, intake_id, "full")
    h = as_run_of(ctx, "author")
    frozen = (await client.get(f"/v1/source-items/{items['a']}", headers=h)).json()["version_id"]
    await _rename(ctx, items["a"], content=EDITED_A)
    resp = await client.post("/v1/snapshots", json={"label": "after"}, headers=h)
    snapshot = resp.json()["id"]
    await _delete(ctx, items["b"])
    listed = {
        x["id"]: x for x in (await client.get(f"/v1/snapshots/{snapshot}/items", headers=h)).json()
    }
    assert listed[str(items["a"])]["version_id"] == frozen
    assert listed[str(items["a"])]["title"] == TITLE_A
    assert str(items["b"]) not in listed


async def test_attach_without_ref_stores_the_frozen_title(client, fake):  # noqa: F811
    from tests.baseline_helpers import entity

    ctx, intake_id, items = await world(client, fake, hidden=False, role="approver")
    await share_all(client, ctx, intake_id, "full")
    feat = await entity(client, ctx, type="feature", key="saved-addresses")
    url = f"/v1/baseline/entities/{feat['id']}/evidence"
    # A rename alone writes no version: the item row's title changes all the same.
    await _rename(ctx, items["a"])
    resp = await client.post(
        url, json={"source_item_id": str(items["a"])}, headers=as_run_of(ctx, "author")
    )
    assert resp.status_code == 201, resp.text
    assert resp.json()["ref"] == TITLE_A
    # A rename with an edit: still the title as shared.
    await _rename(ctx, items["a"], content=EDITED_A)
    resp = await client.post(
        url, json={"source_item_id": str(items["a"])}, headers=as_run_of(ctx, "author")
    )
    assert resp.status_code == 201, resp.text
    assert resp.json()["ref"] == TITLE_A
    assert resp.json()["excerpt"] == EXCERPT_A[:500]
    # Whoever reads the evidence, the author's run included, sees the title as shared.
    for headers in (as_run_of(ctx, "author"), ctx.as_("approver")):
        resp = await client.get(url, headers=headers)
        assert resp.status_code == 200, resp.text
        assert RENAMED not in resp.text
