"""Security review, round 10 (S6: freeze at sharing, titles and links; after the merge
of main's evidence inspector and blockers).

M1. The evidence inspector (``GET /v1/documents/{doc}/versions/{n}/evidence``, also an
    MCP tool) read a linked source item's *current* title and link for its owner's
    runs: a run now gets a withheld, deleted or frozen-but-unreleased item restricted
    and a released one at the title and link released; a run links none of the three
    (``create_section_links``). The blockers appendix never falls back to an item's
    current link.

Minors: (1) a run reads its user's own frozen items as at release (acl, upstream time,
confidence); (2) a run's own deleted item is missing from baseline evidence; (3) a
run's YAML import never links its deleted or frozen-but-unreleased items; (4, 5) the
link backfill repairs versions an old image wrote, writing only rows it gives a link;
(6) another user's hidden item, and baseline evidence, never score by when the item
changed upstream; (7) owners see their item's current title and link.

Synthetic placeholders only.
"""

import uuid
from datetime import UTC, datetime

from sqlalchemy import select, text

from oracle.auth.deps import Principal
from oracle.baseline.models import Evidence
from oracle.intake.models import IntakeSharedItem
from oracle.sources.models import SourceItem, SourceItemVersion
from oracle.tenancy import tenant_session
from tests.baseline_helpers import entity, make_item
from tests.test_intake import _document
from tests.test_intake_sharing import TITLE_A, share_all
from tests.test_intake_sharing_round5 import world
from tests.test_intake_sharing_round6 import (
    as_run_of,
    fake,  # noqa: F401 (fixture)
)
from tests.test_intake_sharing_round7 import _delete, _search
from tests.test_intake_sharing_round9 import (
    NEW_LINK,
    NEW_SLUG,
    NEW_TITLE,
    OLD_LINK,
    _as_notion_page,
    _rename_page,
)

SECTION = "problem"


async def _link(client, ctx, slug: str, item_id, headers) -> int:
    resp = await client.post(
        f"/v1/documents/{slug}/versions/1/section-links",
        json={
            "links": [{"section_key": SECTION, "kind": "evidences", "source_item_id": str(item_id)}]
        },
        headers=headers,
    )
    return resp.status_code


async def _inspected(client, slug: str, headers) -> dict[str, dict]:
    """Source item id -> the inspector's target for it, as ``headers`` reads it."""
    resp = await client.get(f"/v1/documents/{slug}/versions/1/evidence", headers=headers)
    assert resp.status_code == 200, resp.text
    return {
        lk["target"]["id"]: lk["target"]
        for section in resp.json()["sections"]
        for lk in section["links"]
        if lk["target"]["type"] == "source_item"
    }


async def _unrelease(ctx, item_id) -> None:
    """The release of ``item_id`` names another item's version: it reads nothing now."""
    async with tenant_session(ctx.tenant_id) as s:
        other = await s.scalar(
            select(SourceItem.current_version_id).where(SourceItem.id != item_id).limit(1)
        )
        for row in await s.scalars(
            select(IntakeSharedItem).where(IntakeSharedItem.item_id == item_id)
        ):
            row.version_id = other
        await s.commit()


# --- M1: the evidence inspector -----------------------------------------------------------


async def test_the_inspector_restricts_what_the_authors_run_may_not_read(client, fake):  # noqa: F811
    """(a) A withheld item (its intake's findings are private), a deleted one and a
    frozen one with no release readable now: restricted to the author's run, no title
    or link; the author still sees their own items."""
    ctx, intake_id, items = await world(client, fake, hidden=False, role="approver")
    slug = await _document(client, ctx)
    for key in ("a", "b", "old"):
        assert await _link(client, ctx, slug, items[key], ctx.as_("author")) == 201
    run = as_run_of(ctx, "author")
    # Withheld: every finding is private, so the intake withholds what it read.
    seen = await _inspected(client, slug, run)
    for key in ("a", "b", "old"):
        target = seen[str(items[key])]
        assert target["restricted"] and target["title"] is None and target["url"] is None
    assert TITLE_A not in str(seen)
    # Shared in full: released; then a's release reads nothing and old is deleted.
    await share_all(client, ctx, intake_id, "full")
    assert not (await _inspected(client, slug, run))[str(items["a"])]["restricted"]
    await _unrelease(ctx, items["a"])
    await _delete(ctx, items["old"])
    seen = await _inspected(client, slug, run)
    for key in ("a", "old"):
        target = seen[str(items[key])]
        assert target["restricted"] and target["title"] is None and target["url"] is None, key
    assert seen[str(items["b"])]["title"] == "#finance numbers"
    mine = await _inspected(client, slug, ctx.as_("author"))
    assert mine[str(items["a"])]["title"] == TITLE_A


async def test_the_inspector_shows_a_shared_item_as_shared(client, fake):  # noqa: F811
    """(b) A shared Notion page renamed upstream (alone, then with an edit): runs read
    the title and link released; only the owner sees the new ones (minor 7)."""
    from tests.test_intake_sharing_round7 import EDITED_A

    ctx, intake_id, items = await world(client, fake, hidden=False, role="approver")
    slug = await _document(client, ctx)
    await _as_notion_page(ctx, items["a"])
    await share_all(client, ctx, intake_id, "full")
    assert await _link(client, ctx, slug, items["a"], ctx.as_("author")) == 201
    for content in (None, EDITED_A):
        await _rename_page(ctx, items["a"], content=content)
        for who in ("author", "approver"):
            resp = await client.get(
                f"/v1/documents/{slug}/versions/1/evidence", headers=as_run_of(ctx, who)
            )
            assert NEW_SLUG not in resp.text and NEW_TITLE not in resp.text, (who, content)
            target = (await _inspected(client, slug, as_run_of(ctx, who)))[str(items["a"])]
            if who == "author":
                assert (target["title"], target["url"]) == (TITLE_A, OLD_LINK), content
        owner = (await _inspected(client, slug, ctx.as_("author")))[str(items["a"])]
        assert (owner["title"], owner["url"]) == (NEW_TITLE, NEW_LINK)
        # Other people never read another user's item here (AUD-9).
        other = (await _inspected(client, slug, ctx.as_("approver")))[str(items["a"])]
        assert other["restricted"] and other["url"] is None


async def test_a_run_never_links_an_item_it_may_not_read(client, fake):  # noqa: F811
    """(c) The author's run links neither a withheld item, nor a deleted one, nor a
    frozen one with no release; the author may, and so may the run once released."""
    ctx, intake_id, items = await world(client, fake, hidden=False, role="approver")
    slug = await _document(client, ctx)
    run = as_run_of(ctx, "author")
    assert await _link(client, ctx, slug, items["a"], run) == 422  # withheld
    await share_all(client, ctx, intake_id, "full")
    assert await _link(client, ctx, slug, items["b"], run) == 201  # released
    await _unrelease(ctx, items["a"])
    assert await _link(client, ctx, slug, items["a"], run) == 422  # frozen, no release
    fresh = await make_item(ctx, "author", content="Unrelated note.", title="#notes")
    await _delete(ctx, fresh)
    assert await _link(client, ctx, slug, fresh, run) == 422  # deleted
    assert await _link(client, ctx, slug, items["a"], ctx.as_("author")) == 201


async def test_the_blockers_appendix_never_serves_an_items_current_link(client):
    """Evidence stored with a ref only renders its ref, and with neither link nor ref
    nothing, never the item's link as it is now (a Notion link carries the page's
    current title)."""
    from oracle.blockers.views import _evidence_refs
    from tests.intake_helpers import company
    from tests.test_intake_sharing import add_author

    ctx = await company()
    await add_author(ctx, "approver")
    item_id = await make_item(ctx, "author", kind="notion", url=NEW_LINK)
    feat = await entity(client, ctx, type="feature", key="saved-addresses")
    async with tenant_session(ctx.tenant_id) as s:
        with_ref, bare = (
            Evidence(entity_id=uuid.UUID(feat["id"]), source_item_id=item_id, ref=ref)
            for ref in ("Saved addresses", None)
        )
        bare.excerpt = "Buyers keep two addresses."
        s.add_all([with_ref, bare])
        await s.commit()
        refs = await _evidence_refs(s, {with_ref.id, bare.id})
    assert refs[with_ref.id].ref == "Saved addresses"
    assert refs[bare.id].ref is None
    assert NEW_SLUG not in str(refs)


# --- minors ---------------------------------------------------------------------------------


async def test_a_runs_own_frozen_item_reads_as_at_release(client, fake):  # noqa: F811
    """(1) The author's run reads its own frozen item like another user's released one:
    acl reduced to its scalar flags, no upstream time, confidence from the version
    released, on the source-item route, search, the source list and a snapshot."""
    ctx, intake_id, items = await world(client, fake, hidden=False)
    async with tenant_session(ctx.tenant_id) as s:
        item = await s.get(SourceItem, items["a"])
        item.acl = {"visibility": "private", "participants": ["Ada"], "channel_name": "#x"}
        await s.commit()
    await share_all(client, ctx, intake_id, "full")
    run = as_run_of(ctx, "author")

    async def reads() -> list[dict]:
        one = (await client.get(f"/v1/source-items/{items['a']}", headers=run)).json()
        hits = {x["item"]["id"]: x["item"] for x in await _search(client, ctx, "author", "buyers")}
        listed = await client.get(f"/v1/sources/{one['source_id']}/items", headers=run)
        snap = await client.post("/v1/snapshots", json={"label": "probe"}, headers=run)
        pinned = await client.get(f"/v1/snapshots/{snap.json()['id']}/items", headers=run)
        by_id = lambda r: {x["id"]: x for x in r.json()}[str(items["a"])]  # noqa: E731
        return [one, hits[str(items["a"])], by_id(listed), by_id(pinned)]

    before = await reads()
    async with tenant_session(ctx.tenant_id) as s:
        item = await s.get(SourceItem, items["a"])
        item.source_updated_at = datetime(2001, 1, 1, tzinfo=UTC)
        item.occurred_at = datetime(2001, 1, 1, tzinfo=UTC)
        await s.commit()
    for out, earlier in zip(await reads(), before, strict=True):
        assert out["acl"] == {"visibility": "private"}
        assert out["source_updated_at"] is None
        assert out["confidence"] == earlier["confidence"]
    # The author reads it as it is.
    own = (await client.get(f"/v1/source-items/{items['a']}", headers=ctx.as_("author"))).json()
    assert own["acl"]["participants"] == ["Ada"]


async def test_a_runs_own_deleted_item_is_missing_from_evidence(client, fake):  # noqa: F811
    """(2) Baseline evidence from the author's item never frozen: once deleted upstream,
    the author's run gets no item ref (no last link), as for an item it may not read."""
    ctx, _, _ = await world(client, fake, hidden=False, role="approver")
    item_id = await make_item(ctx, "author", content="Buyers keep two addresses.")
    feat = await entity(client, ctx, type="feature", key="saved-addresses")
    url = f"/v1/baseline/entities/{feat['id']}/evidence"
    resp = await client.post(url, json={"source_item_id": str(item_id)}, headers=ctx.as_("author"))
    assert resp.status_code == 201, resp.text
    run = as_run_of(ctx, "author")
    [before] = (await client.get(f"/v1/baseline/entities/{feat['id']}", headers=run)).json()[
        "evidence"
    ]
    assert before["source_item"]["id"] == str(item_id)
    await _delete(ctx, item_id)
    [after] = (await client.get(f"/v1/baseline/entities/{feat['id']}", headers=run)).json()[
        "evidence"
    ]
    assert after["source_item"] is None and after["source_item_private"]
    # The author still sees their own item.
    [own] = (
        await client.get(f"/v1/baseline/entities/{feat['id']}", headers=ctx.as_("author"))
    ).json()["evidence"]
    assert own["source_item"]["id"] == str(item_id)


async def test_a_runs_yaml_import_never_links_what_it_may_not_read(client, fake):  # noqa: F811
    """(3) A run's YAML import links evidence to its user's items only where the run may
    read them: never one deleted upstream or frozen with no release readable now."""
    ctx, intake_id, items = await world(client, fake, hidden=False, role="approver")
    await share_all(client, ctx, intake_id, "full")
    await _unrelease(ctx, items["a"])
    fresh = await make_item(ctx, "author", content="Unrelated note.", title="#notes")
    await _delete(ctx, fresh)
    body = (
        "version: 1\nentities:\n"
        "  - type: feature\n    key: saved-addresses\n    title: Saved addresses\n"
        "    evidence:\n"
        f"      - ref: frozen\n        source_item: {items['a']}\n"
        f"      - ref: deleted\n        source_item: {fresh}\n"
        f"      - ref: released\n        source_item: {items['b']}\n"
    )
    resp = await client.post(
        "/v1/baseline/yaml",
        content=body.encode(),
        headers={**as_run_of(ctx, "author"), "Content-Type": "application/yaml"},
    )
    assert resp.status_code == 200, resp.text
    async with tenant_session(ctx.tenant_id) as s:
        linked = dict((await s.execute(select(Evidence.ref, Evidence.source_item_id))).all())
    assert linked == {"frozen": None, "deleted": None, "released": items["b"]}


async def test_the_link_repair_fills_old_image_versions_only_where_it_has_a_link(client):
    """(4, 5) Versions an old image wrote without a link get the one 0014_intake gives
    (a Notion page's id-only link); a version whose link would stay NULL is not written;
    a second run changes nothing."""
    from oracle.sources.repair import repair_version_urls
    from tests.intake_helpers import company
    from tests.test_intake_sharing import add_author
    from tests.test_intake_sharing_round9 import PAGE_HEX, PAGE_ID

    ctx = await company()
    await add_author(ctx)
    page = await make_item(ctx, "author", kind="notion", url=NEW_LINK)
    chat = await make_item(ctx, "author")
    upload = await make_item(ctx, "author", kind="upload", url=None)
    async with tenant_session(ctx.tenant_id) as s:
        (await s.get(SourceItem, page)).external_id = PAGE_ID
        for item_id in (page, chat, upload):
            item = await s.get(SourceItem, item_id)
            (await s.get(SourceItemVersion, item.current_version_id)).url = None
        await s.commit()

    async def state() -> dict:
        async with tenant_session(ctx.tenant_id) as s:
            rows = await s.execute(
                text(
                    "SELECT v.item_id, v.url, v.xmin::text FROM source_item_versions v "
                    "WHERE v.item_id IN (:a, :b, :c)"
                ).bindparams(a=page, b=chat, c=upload)
            )
            return {i: (url, xmin) for i, url, xmin in rows.all()}

    before = await state()
    assert await repair_version_urls() == 2
    after = await state()
    assert after[page][0] == f"https://www.notion.so/{PAGE_HEX}"
    assert after[chat][0] == "https://chat.example.com/archives/C1/p1"
    assert after[upload] == before[upload]  # not written at all
    assert await repair_version_urls() == 0


async def test_hidden_items_and_baseline_evidence_never_score_by_upstream_changes(client, fake):  # noqa: F811
    """(6) Intake refs another person reads with nothing released (an item they may not
    see) score neutral, never by the item's current upstream time; baseline evidence
    scores by the version it was taken from."""
    from oracle.baseline import scoring
    from oracle.intake import evidence as ev

    ctx, _, items = await world(client, fake, hidden=False, role="approver")
    async with tenant_session(ctx.tenant_id) as s:
        approver = ctx.users["approver"]
        reader = Principal(
            tenant_id=ctx.tenant_id, kind="user", role="approver", user_id=approver.id
        )
        before = await ev.refs(s, [items["a"]], reader, None)
    feat = await entity(client, ctx, type="feature", key="saved-addresses")
    url = f"/v1/baseline/entities/{feat['id']}/evidence"
    resp = await client.post(
        url, json={"source_item_id": str(items["old"])}, headers=ctx.as_("author")
    )
    assert resp.status_code == 201, resp.text
    scored = resp.json()["confidence"]
    async with tenant_session(ctx.tenant_id) as s:
        for key in ("a", "old"):
            item = await s.get(SourceItem, items[key])
            item.source_updated_at = datetime.now(UTC)
        await s.commit()
    async with tenant_session(ctx.tenant_id) as s:
        after = await ev.refs(s, [items["a"]], reader, None)
        await scoring.rescore_targets(s, entity_ids=[uuid.UUID(feat["id"])])
        await s.commit()
    assert not after[items["a"]].visible
    assert after[items["a"]].confidence == before[items["a"]].confidence
    [row] = (
        await client.get(f"/v1/baseline/entities/{feat['id']}", headers=ctx.as_("viewer"))
    ).json()["evidence"]
    assert row["confidence"] == scored


async def test_owners_see_their_items_current_title_and_link(client, fake):  # noqa: F811
    """(7) A rename with no content change writes no version: the owner (a person, never
    frozen) reads the item's current title and link; the run reads them as shared."""
    from tests.test_intake_sharing_round9 import _run_links

    ctx, intake_id, items = await world(client, fake, hidden=False, role="approver")
    await _as_notion_page(ctx, items["a"])
    await share_all(client, ctx, intake_id, "full")
    feat = await entity(client, ctx, type="feature", key="saved-addresses")
    resp = await client.post(
        f"/v1/baseline/entities/{feat['id']}/evidence",
        json={"source_item_id": str(items["a"])},
        headers=ctx.as_("author"),
    )
    assert resp.status_code == 201, resp.text
    await _rename_page(ctx, items["a"])
    own = (await client.get(f"/v1/source-items/{items['a']}", headers=ctx.as_("author"))).json()
    assert (own["title"], own["url"]) == (NEW_TITLE, NEW_LINK)
    entity_out = await client.get(f"/v1/baseline/entities/{feat['id']}", headers=ctx.as_("author"))
    assert entity_out.json()["evidence"][0]["source_item"]["url"] == NEW_LINK
    assert set((await _run_links(client, ctx, "author", intake_id, items["a"])).values()) == {
        OLD_LINK
    }
