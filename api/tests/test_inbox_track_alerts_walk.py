"""Inbox track alerts, from the stale-marks walk (Nov 6, 2026): a person reconciled 'May be
stale' roadmap items and the Inbox did not follow. On ONE company roadmap fed by two area
PRDs (Scale, Conversion), each with its own track:

1. reconciling an item resolves its stale alert at once: it leaves its track group and the
   counts, with no monitor run by hand;
2. each track group counts and lists its own items only (never the roadmap-wide count, never
   another PRD's item);
3. names, never keys: an alert names its item; a stale reason names the PRD section by its
   heading, once (the latest version), and a lone Ground Truth item by its name; a roadmap
   item names a dependency outside its version;
4. Review and Still valid refuse in plain words;
5. the re-check after Review or Still valid runs only for the tracks that own the changed
   items, each on its own, so one broken track never undoes the action; and a dependency's
   name never comes from a roadmap the reader may not see.

Against Postgres. Invented data only.

Each test's card: protects=what it guards; fails_when=what breaks it; no_claim=what it does
not prove.
"""

import hashlib
from datetime import UTC, datetime

from sqlalchemy import select

from oracle.baseline.models import Entity
from oracle.docs.models import Document, DocumentVersion, Section
from oracle.roadmap import views
from oracle.roadmap.models import ProductTrack, RoadmapItem
from oracle.tenancy import tenant_session
from tests.baseline_helpers import Ctx, make_ctx

ROADMAP = "product-roadmap"
SCALE_KEY = "feature-read-replicas-1a2b3c"
GOAL = "kr-3-4-every-client-fit-scored"


def _hash(text: str) -> str:
    return hashlib.sha256(text.encode()).hexdigest()


async def _add(s, row):
    s.add(row)
    await s.flush()
    return row


async def _prd(s, slug: str, title: str, sections: dict[str, str]):
    doc = await _add(s, Document(slug=slug, title=title, kind="prd", status="approved",
                                 visibility="company"))  # fmt: skip
    body = f"# {title}"
    v = await _add(s, DocumentVersion(document_id=doc.id, number=1, markdown=body,
                                      content_hash=_hash(body),
                                      approved_at=datetime(2026, 10, 1, tzinfo=UTC)))  # fmt: skip
    for i, (key, heading) in enumerate(sections.items()):
        s.add(Section(version_id=v.id, section_key=key, ordinal=i, level=2, heading=heading,
                      content_hash=_hash(heading)))  # fmt: skip
    await s.flush()
    return doc, v


async def world() -> tuple[Ctx, dict]:
    """The company roadmap's approved version 1: one Scale item (stale twice over its PRD
    section) and two Conversion items (one stale over a rejected goal, one over its section,
    depending on a feature on no roadmap version). The Conversion items carry no track of
    their own, as items carried from another PRD's run can."""
    ctx = await make_ctx()
    async with tenant_session(ctx.tenant_id) as s:
        scale, sv = await _prd(s, "scale", "Scale", {SCALE_KEY: "Read replicas at scale"})
        conv, cv = await _prd(s, "conversion", "Conversion", {"s-2": "Signup nudges"})
        rm = await _add(s, Document(slug=ROADMAP, title="Product roadmap", kind="roadmap",
                                    status="approved", visibility="company"))  # fmt: skip
        top = "# Product roadmap"
        v1 = await _add(s, DocumentVersion(document_id=rm.id, number=1, markdown=top,
                                           content_hash=_hash(top), source_version_id=sv.id,
                                           approved_at=datetime(2026, 10, 3,
                                                                tzinfo=UTC)))  # fmt: skip
        scale_track = await _add(s, ProductTrack(prd_document_id=scale.id, title="Scale",
                                                 roadmap_document_id=rm.id,
                                                 started_version_id=sv.id,
                                                 current_version_id=sv.id))  # fmt: skip
        conv_track = await _add(s, ProductTrack(prd_document_id=conv.id, title="Conversion",
                                                roadmap_document_id=rm.id,
                                                started_version_id=cv.id,
                                                current_version_id=cv.id))  # fmt: skip
        s.add(Entity(type="goal", key=GOAL, title="Every client fit scored", status="rejected",
                     origin="user"))  # fmt: skip
        s.add(Entity(type="feature", key="keys-out-of-checkpoints",
                     title="Keys out of checkpoints", status="confirmed",
                     origin="user"))  # fmt: skip
        stale = {"freshness": "potentially_stale", "stale_since": datetime(2026, 11, 5, tzinfo=UTC)}
        s.add(RoadmapItem(roadmap_document_id=rm.id, roadmap_version_id=v1.id,
                          track_id=scale_track.id, item_key="read-replicas",
                          title="Read replicas", horizon="now", position=0,
                          prd_document_id=scale.id, prd_version_id=sv.id,
                          prd_section_key=SCALE_KEY, prd_section_hash="old",
                          stale_reasons=[f"PRD section {SCALE_KEY} changed in version 4",
                                         f"PRD section {SCALE_KEY} changed in version 5"],
                          **stale))  # fmt: skip
        s.add(RoadmapItem(roadmap_document_id=rm.id, roadmap_version_id=v1.id,
                          item_key="checkout-tips", title="Checkout tips", horizon="now",
                          position=1, prd_document_id=conv.id, prd_version_id=cv.id,
                          stale_reasons=[f"goal:{GOAL} was rejected"], **stale))  # fmt: skip
        s.add(RoadmapItem(roadmap_document_id=rm.id, roadmap_version_id=v1.id,
                          item_key="signup-nudge", title="Signup nudge", horizon="next",
                          position=2, prd_document_id=conv.id, prd_version_id=cv.id,
                          prd_section_key="s-2", prd_section_hash="old",
                          depends_on=["keys-out-of-checkpoints"],
                          stale_reasons=["PRD section s-2 changed (section_updated)"],
                          **stale))  # fmt: skip
        await s.commit()
        return ctx, {"scale": str(scale_track.id), "conversion": str(conv_track.id)}


async def monitored(client) -> tuple[Ctx, dict]:
    ctx, tracks = await world()
    for track_id in tracks.values():
        r = await client.post(f"/v1/tracks/{track_id}/monitor", headers=ctx.as_("owner"))
        assert r.status_code == 200, r.text
    return ctx, tracks


async def inbox_tracks(client, ctx: Ctx) -> dict[str, dict]:
    r = await client.get("/v1/inbox", headers=ctx.as_("owner"))
    assert r.status_code == 200, r.text
    return {t["track_id"]: t for t in r.json()["tracks"]}


def need(row: dict) -> int:
    return row["counts"]["new"] + row["counts"]["open"]


def stale_keys(row: dict) -> set[str]:
    return {a["item_key"] for a in row["alerts"] if a["kind"] == "stale"}


async def test_each_track_group_counts_and_lists_its_own_items(client):
    """protects=bug 2 (each item under its own track only); fails_when=a track group counts
    the whole roadmap or lists another PRD's item; no_claim=the web rows."""
    ctx, tracks = await monitored(client)
    rows = await inbox_tracks(client, ctx)
    assert stale_keys(rows[tracks["scale"]]) == {"read-replicas"}
    assert need(rows[tracks["scale"]]) == 1
    assert stale_keys(rows[tracks["conversion"]]) == {"checkout-tips", "signup-nudge"}
    assert need(rows[tracks["conversion"]]) == 2


async def test_reconciling_an_item_takes_its_alert_out_of_the_inbox_at_once(client):
    """protects=bug 1 (acting updates every count at once); fails_when=the stale alert stays
    open until the hourly monitor; no_claim=the web refresh."""
    ctx, tracks = await monitored(client)
    r = await client.post(
        f"/v1/roadmaps/{ROADMAP}/items/staleness",
        json={"action": "reconcile", "version": 1, "item_keys": ["checkout-tips"],
              "reason": "The goal moved, the tips still hold"},
        headers=ctx.as_("owner"),
    )  # fmt: skip
    assert r.status_code == 200, r.text
    rows = await inbox_tracks(client, ctx)
    conv = rows[tracks["conversion"]]
    assert stale_keys(conv) == {"signup-nudge"}
    assert need(conv) == 1
    assert [a["item_key"] for a in conv["done"]] == ["checkout-tips"]
    # Under review is still open: it stays.
    r = await client.post(
        f"/v1/roadmaps/{ROADMAP}/items/staleness",
        json={"action": "review", "version": 1, "item_keys": ["signup-nudge"]},
        headers=ctx.as_("owner"),
    )
    assert r.status_code == 200, r.text
    assert stale_keys((await inbox_tracks(client, ctx))[tracks["conversion"]]) == {"signup-nudge"}


async def test_still_valid_with_no_version_settles_the_version_the_tracks_follow(client):
    """protects=bug 1 from the Plan item panel, which names no version: with a newer version
    not yet approved, Still valid settles the approved row the alert is about; fails_when=the
    newer version's row is settled and the alert stays in the Inbox; no_claim=a version named
    by the Items tab (settles that version's row, as before)."""
    ctx, tracks = await monitored(client)
    async with tenant_session(ctx.tenant_id) as s:
        rm = await s.scalar(select(Document).where(Document.slug == ROADMAP))
        v1 = await s.scalar(
            select(DocumentVersion).where(
                DocumentVersion.document_id == rm.id, DocumentVersion.number == 1
            )
        )
        v2 = await _add(s, DocumentVersion(document_id=rm.id, number=2, markdown="# v2",
                                           content_hash=_hash("# v2"),
                                           source_version_id=v1.source_version_id))  # fmt: skip
        for i in list(
            await s.scalars(select(RoadmapItem).where(RoadmapItem.roadmap_version_id == v1.id))
        ):
            s.add(RoadmapItem(roadmap_document_id=rm.id, roadmap_version_id=v2.id,
                              item_key=i.item_key, title=i.title, horizon=i.horizon,
                              position=i.position, prd_document_id=i.prd_document_id,
                              prd_version_id=i.prd_version_id, freshness=i.freshness,
                              stale_reasons=list(i.stale_reasons)))  # fmt: skip
        await s.commit()
    r = await client.post(
        f"/v1/roadmaps/{ROADMAP}/items/staleness",
        json={"action": "reconcile", "item_keys": ["checkout-tips"], "reason": "Still holds"},
        headers=ctx.as_("owner"),
    )
    assert r.status_code == 200, r.text
    assert stale_keys((await inbox_tracks(client, ctx))[tracks["conversion"]]) == {"signup-nudge"}


async def test_alerts_and_items_name_things_never_keys(client):
    """protects=bug 3 (names, never keys); fails_when=an alert row falls back to the item key,
    a reason names a section key or says it once per version, a goal reads by its ref, or a
    dependency outside the version reads by its key; no_claim=the web's own fallbacks."""
    ctx, tracks = await monitored(client)
    rows = await inbox_tracks(client, ctx)
    alerts = {a["item_key"]: a for t in rows.values() for a in t["alerts"]}
    assert {k: a["item_title"] for k, a in alerts.items()} == {
        "read-replicas": "Read replicas",
        "checkout-tips": "Checkout tips",
        "signup-nudge": "Signup nudge",
    }
    assert alerts["read-replicas"]["detail"] == (
        "PRD section Read replicas at scale changed in version 5"
    )
    assert alerts["checkout-tips"]["detail"] == 'The goal "Every client fit scored" was rejected'
    assert alerts["signup-nudge"]["detail"] == "PRD section Signup nudges changed (section_updated)"

    r = await client.get(
        f"/v1/roadmaps/{ROADMAP}/items", params={"version": 1}, headers=ctx.as_("owner")
    )
    assert r.status_code == 200, r.text
    items = {i["item_key"]: i for i in r.json()["items"]}
    assert items["read-replicas"]["stale_reasons"] == [
        "PRD section Read replicas at scale changed in version 5"
    ]
    assert items["checkout-tips"]["stale_reasons"] == [
        'The goal "Every client fit scored" was rejected'
    ]
    assert items["signup-nudge"]["depends_titles"] == {
        "keys-out-of-checkpoints": "Keys out of checkpoints"
    }


async def test_review_and_still_valid_refuse_in_plain_words(client):
    """protects=bug 4 (refusals in plain words); fails_when=a second Review reads "nothing to
    review: under_review"; no_claim=the Plan panel's form."""
    ctx, _ = await world()
    act = f"/v1/roadmaps/{ROADMAP}/items/staleness"
    review = {"action": "review", "version": 1, "item_keys": ["checkout-tips"]}
    assert (await client.post(act, json=review, headers=ctx.as_("owner"))).status_code == 200
    r = await client.post(act, json=review, headers=ctx.as_("owner"))
    assert r.status_code == 409
    assert r.json()["detail"] == "Nothing to review: this item is already under review"
    still = {**review, "action": "reconcile", "reason": "Still holds"}
    assert (await client.post(act, json=still, headers=ctx.as_("owner"))).status_code == 200
    r = await client.post(act, json=still, headers=ctx.as_("owner"))
    assert r.status_code == 409
    assert r.json()["detail"] == (
        "Nothing to mark still valid: this item is already marked still valid"
    )
    r = await client.post(act, json=review, headers=ctx.as_("owner"))
    assert r.json()["detail"] == "Nothing to review: this item is already marked still valid"


ACT = f"/v1/roadmaps/{ROADMAP}/items/staleness"


async def test_the_recheck_touches_only_the_tracks_that_own_the_changed_items(client, monkeypatch):
    """protects=the re-check after Still valid is bounded: only the track that owns each changed
    item (its PRD's track, else its own, else the first) is re-checked; fails_when=every
    active track on the roadmap is monitored for a one-item action; no_claim=the hourly pass."""
    ctx, tracks = await monitored(client)
    real, calls = views.monitor, []

    async def spy(db, track, actor, **kw):
        calls.append(str(track.id))
        return await real(db, track, actor, **kw)

    monkeypatch.setattr(views, "monitor", spy)
    still = {"action": "reconcile", "version": 1, "reason": "Still holds"}
    r = await client.post(ACT, json={**still, "item_keys": ["checkout-tips"]},
                          headers=ctx.as_("owner"))  # fmt: skip
    assert r.status_code == 200, r.text
    assert calls == [tracks["conversion"]]
    r = await client.post(ACT, json={**still, "item_keys": ["read-replicas"]},
                          headers=ctx.as_("owner"))  # fmt: skip
    assert r.status_code == 200, r.text
    assert calls == [tracks["conversion"], tracks["scale"]]


async def test_a_track_whose_recheck_fails_leaves_the_still_valid_applied(client, monkeypatch):
    """protects=failure isolation: a track whose re-check raises is rolled back alone; the
    Still valid stands for every item and the other track's alert closes; fails_when=the
    request turns into a 500 and the action is rolled back; no_claim=the log line."""
    ctx, tracks = await monitored(client)
    real = views.monitor

    async def broken(db, track, actor, **kw):
        out = await real(db, track, actor, **kw)
        if str(track.id) == tracks["scale"]:
            raise RuntimeError("an example failure after the alerts were written")
        return out

    monkeypatch.setattr(views, "monitor", broken)
    r = await client.post(
        ACT,
        json={"action": "reconcile", "version": 1, "reason": "Both still hold",
              "item_keys": ["read-replicas", "checkout-tips"]},
        headers=ctx.as_("owner"),
    )  # fmt: skip
    assert r.status_code == 200, r.text
    fresh = {i["item_key"]: i["freshness"] for i in r.json()["items"]}
    assert fresh["read-replicas"] == fresh["checkout-tips"] == "reconciled"
    rows = await inbox_tracks(client, ctx)
    assert stale_keys(rows[tracks["conversion"]]) == {"signup-nudge"}
    # The broken track's re-check rolled back alone: its alert waits for the next pass.
    assert stale_keys(rows[tracks["scale"]]) == {"read-replicas"}
    async with tenant_session(ctx.tenant_id) as s:
        item = await s.scalar(select(RoadmapItem).where(RoadmapItem.item_key == "read-replicas"))
        assert item.freshness == "reconciled"


async def test_a_dependency_on_a_roadmap_the_reader_may_not_see_has_no_name(client):
    """protects=a dependency's name comes only from what the reader may see: an item of an
    owners-and-approvers roadmap names a dependency for an approver, not for a commenter;
    fails_when=a commenter reads the hidden roadmap's item title; no_claim=the web fallback."""
    ctx, _ = await world()
    async with tenant_session(ctx.tenant_id) as s:
        hidden = await _add(s, Document(slug="pricing-roadmap", title="Pricing roadmap",
                                        kind="roadmap", status="approved",
                                        visibility="approvers"))  # fmt: skip
        top = "# Pricing roadmap"
        hv = await _add(s, DocumentVersion(document_id=hidden.id, number=1, markdown=top,
                                           content_hash=_hash(top)))  # fmt: skip
        s.add(RoadmapItem(roadmap_document_id=hidden.id, roadmap_version_id=hv.id,
                          item_key="example-price-tier", title="Example price tier",
                          horizon="now", position=0))  # fmt: skip
        nudge = await s.scalar(select(RoadmapItem).where(RoadmapItem.item_key == "signup-nudge"))
        nudge.depends_on = [*nudge.depends_on, "example-price-tier"]
        await s.commit()

    async def titles(role: str) -> dict[str, str]:
        r = await client.get(
            f"/v1/roadmaps/{ROADMAP}/items", params={"version": 1}, headers=ctx.as_(role)
        )
        assert r.status_code == 200, r.text
        return {i["item_key"]: i for i in r.json()["items"]}["signup-nudge"]["depends_titles"]

    assert await titles("approver") == {
        "keys-out-of-checkpoints": "Keys out of checkpoints",
        "example-price-tier": "Example price tier",
    }
    assert await titles("commenter") == {"keys-out-of-checkpoints": "Keys out of checkpoints"}
