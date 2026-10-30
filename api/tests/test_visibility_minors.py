# ruff: noqa: F811 - the fixtures are imported
"""#541 security minors: a plan item's stale reason and a run's pricing-review stop, read
by each role with the rule in oracle.docs.visibility (approvers-only pricing decisions
and documents are hidden from commenters and viewers).

Each test's card: protects=<the observable>; fails_when=<the wrong result it rejects>;
no_claim=<what green does not prove>.
"""

import pytest
from sqlalchemy import select, update

from oracle.decisions.models import Decision
from oracle.rituals import service as rituals
from oracle.rituals.models import Ritual
from oracle.roadmap.models import RoadmapItem, TrackAlert
from oracle.tenancy import tenant_session
from tests.baseline_helpers import make_ctx
from tests.decision_helpers import clock, today  # noqa: F401
from tests.pricing_helpers import drafted_by_run, memo_md
from tests.roadmap_helpers import seed_trace
from tests.test_pricing_baseline_visibility import _decided
from tests.test_roadmap import (
    ROADMAP,
    approved_prd,
    built_roadmap,
    runtime,  # noqa: F401
    seed_baseline,
)
from tests.test_track_alerts import alerts_of
from tests.test_tracks import track_of
from tests.update_helpers import import_md

ROLES = [("owner", True), ("approver", True), ("commenter", False), ("viewer", False)]
IMPORTED = "team-plan-pricing-import"


@pytest.fixture
async def ctx():
    return await make_ctx()


async def _stale_by_hidden_decision(client, ctx, runtime) -> tuple[str, dict]:
    """A built roadmap whose shipping-step item is stale because a hidden pricing decision
    changed, and because a company requirement did; (the decision's key, the track)."""
    owner = ctx.as_("owner")
    await approved_prd(client, owner)
    await seed_baseline(ctx.tenant_id)
    await seed_trace(ctx.tenant_id)
    await built_roadmap(client, owner, runtime)
    entity_id = await _decided(client, ctx)
    entities = (await client.get("/v1/baseline/entities?type=decision", headers=owner)).json()
    (key,) = [e["key"] for e in entities if e["id"] == entity_id]
    async with tenant_session(ctx.tenant_id) as s:
        await s.execute(
            update(RoadmapItem)
            .where(RoadmapItem.item_key == "shipping-step")
            .values(
                freshness="potentially_stale",
                stale_reasons=[f"decision:{key} changed", "requirement:saved-cards changed"],
            )
        )
        await s.commit()
    track = await track_of(client, owner)
    assert (await client.post(f"/v1/tracks/{track['id']}/monitor", headers=owner)).status_code
    return key, track


@pytest.mark.parametrize(("who", "sees"), ROLES)
async def test_a_stale_reason_names_a_hidden_decision_only_to_who_may_see_it(
    client, ctx, runtime, who, sees
):
    """protects=#541 plan staleness: the roadmap items' stale_reasons name the pricing
    decision's key to an owner and an approver; a commenter and a viewer read the same item
    stale, with the company reason kept and the hidden one worded without the key. The
    stale track alert's detail is put into words for everyone (prod-6, no refs), after
    hiding: an owner reads "A decision and a requirement changed", a commenter "a linked
    baseline item changed; a requirement changed"; fails_when=a commenter or viewer reads
    "decision:d-n", or learns from the alert that a decision changed; no_claim=how the
    reason was first recorded (staleness' own tests)."""
    key, track = await _stale_by_hidden_decision(client, ctx, runtime)
    me = ctx.as_(who)
    resp = await client.get(f"/v1/roadmaps/{ROADMAP}/items", headers=me)
    assert resp.status_code == 200, resp.text
    (item,) = [i for i in resp.json()["items"] if i["item_key"] == "shipping-step"]
    assert item["freshness"] == "potentially_stale"
    assert "requirement:saved-cards changed" in item["stale_reasons"]
    assert (f"decision:{key}" in resp.text) is sees, who
    if not sees:
        assert "a linked baseline item changed" in item["stale_reasons"]
    stale = [a for a in await alerts_of(client, me) if a["kind"] == "stale"]
    assert len(stale) == 1
    detail = stale[0]["detail"]
    assert "saved-cards" not in detail and f"decision:{key}" not in detail, detail
    if sees:
        assert detail == "A decision and a requirement changed", (who, detail)
    else:
        assert detail == "a linked baseline item changed; a requirement changed", (who, detail)
    overview = await client.get(f"/v1/tracks/{track['id']}", headers=me)
    assert overview.status_code == 200
    # The track's alerts read in words for everyone; only who may see it learns a decision changed.
    assert f"decision:{key}" not in overview.text, who
    assert ("A decision and a requirement changed" in overview.text) is sees, who


# cld-4: a hidden decision whose title holds the old separator.
SPLIT_TITLE = "Pricing; enterprise tier"


async def _stale_by_split_title(client, ctx, runtime) -> dict:
    """A built roadmap whose shipping-step item is stale because the hidden pricing
    decision, retitled SPLIT_TITLE, changed (a reason naming it by title), and because a
    company requirement did; the track."""
    owner = ctx.as_("owner")
    await approved_prd(client, owner)
    await seed_baseline(ctx.tenant_id)
    await seed_trace(ctx.tenant_id)
    await built_roadmap(client, owner, runtime)
    entity_id = await _decided(client, ctx)
    async with tenant_session(ctx.tenant_id) as s:
        await s.execute(
            update(Decision).where(Decision.entity_id == entity_id).values(title=SPLIT_TITLE)
        )
        await s.execute(
            update(RoadmapItem)
            .where(RoadmapItem.item_key == "shipping-step")
            .values(
                freshness="potentially_stale",
                stale_reasons=[f"{SPLIT_TITLE} changed", "requirement:saved-cards changed"],
            )
        )
        await s.commit()
    track = await track_of(client, owner)
    assert (await client.post(f"/v1/tracks/{track['id']}/monitor", headers=owner)).status_code
    return track


async def _stale_detail(client, me) -> str:
    stale = [a for a in await alerts_of(client, me) if a["kind"] == "stale"]
    assert len(stale) == 1
    return stale[0]["detail"]


@pytest.mark.parametrize(("who", "sees"), ROLES)
async def test_a_stale_alert_never_splits_a_hidden_title(client, ctx, runtime, who, sees):
    """protects=cld-4: a stale reason naming a hidden decision whose title holds "; " is
    one reason in the alert's detail: an owner and an approver read the title whole, a
    commenter and a viewer read neither half of it, on the alert, in the Inbox and on the
    track; fails_when=the stored line is cut on the title's "; " and each half, holding
    no whole title, is shown; no_claim=a title named in other words (Hidden.names)."""
    track = await _stale_by_split_title(client, ctx, runtime)
    me = ctx.as_(who)
    detail = await _stale_detail(client, me)
    if sees:
        assert f"{SPLIT_TITLE} changed" in detail, (who, detail)
    else:
        assert detail == "a linked baseline item changed; a requirement changed", (who, detail)
    inbox = await client.get("/v1/inbox", headers=me)
    overview = await client.get(f"/v1/tracks/{track['id']}", headers=me)
    assert inbox.status_code == 200 and overview.status_code == 200
    for body in (detail, inbox.text, overview.text):
        assert sees or "enterprise tier" not in body, (who, body)


@pytest.mark.parametrize(("who", "sees"), ROLES)
async def test_an_old_stale_alert_line_reads_as_before(client, ctx, runtime, who, sees):
    """protects=cld-4: a stale alert stored before the fix, its reasons joined by "; ",
    reads as it did: each part hidden or put into words; and when the whole line names a
    hidden title that no part does (cut on the title's "; "), a commenter and a viewer
    read only "a linked baseline item changed"; fails_when=an old line is read as one
    reason, or either half of a hidden title is shown; no_claim=new lines (above)."""
    key, _ = await _stale_by_hidden_decision(client, ctx, runtime)
    me = ctx.as_(who)
    async with tenant_session(ctx.tenant_id) as s:
        old = f"decision:{key} changed; requirement:saved-cards changed"
        await s.execute(update(TrackAlert).where(TrackAlert.kind == "stale").values(detail=old))
        await s.commit()
    detail = await _stale_detail(client, me)
    if sees:
        assert detail == "A decision and a requirement changed", (who, detail)
    else:
        assert detail == "a linked baseline item changed; a requirement changed", (who, detail)
    async with tenant_session(ctx.tenant_id) as s:
        await s.execute(
            update(Decision)
            .where(Decision.number == int(key.split("-")[1]))
            .values(title=SPLIT_TITLE)
        )
        old = f"{SPLIT_TITLE} changed"
        await s.execute(update(TrackAlert).where(TrackAlert.kind == "stale").values(detail=old))
        await s.commit()
    detail = await _stale_detail(client, me)
    if sees:
        assert detail == "Pricing; enterprise tier changed", (who, detail)
    else:
        assert detail == "a linked baseline item changed", (who, detail)


async def _stopped_for_pricing_review(client, ctx, runtime) -> str:
    """An approvers-only pricing memo with a pricing_memo run at its pricing_review stop,
    then an owner's Prepare now of the weekly goals check-in (needs_decision); the
    occurrence's id."""
    resp = await import_md(client, ctx.as_("approver"), IMPORTED, memo_md(IMPORTED))
    assert resp.status_code == 201, resp.text
    await drafted_by_run(client, ctx, runtime, IMPORTED, memo_md(IMPORTED))
    async with tenant_session(ctx.tenant_id) as db:
        await rituals.tick_due(db)
        ritual = await db.scalar(select(Ritual).where(Ritual.kind == "goals_checkin"))
    resp = await client.post(f"/v1/rituals/{ritual.id}/prepare", headers=ctx.as_("owner"))
    assert resp.status_code == 200, resp.text
    return resp.json()["id"]


@pytest.mark.parametrize(("who", "sees"), ROLES)
async def test_a_pricing_review_stop_row_follows_the_pricing_decision(
    client, ctx, runtime, who, sees
):
    """protects=#541 run stops: the needs_decision row "Run stop: pricing review" (linking
    /runs/<id>) of a run on an approvers-only memo is in an owner's and an approver's
    occurrence and pre-read.md, and in neither for a commenter or a viewer; fails_when=a
    commenter or viewer reads the stop or its run link; no_claim=the Inbox (pricing stops
    are owner-only there already)."""
    occ_id = await _stopped_for_pricing_review(client, ctx, runtime)
    me = ctx.as_(who)
    one = await client.get(f"/v1/ritual-occurrences/{occ_id}", headers=me)
    md = await client.get(f"/v1/ritual-occurrences/{occ_id}/pre-read.md", headers=me)
    assert one.status_code == 200 and md.status_code == 200, one.text + md.text
    rows = [r for b in one.json()["pre_read"]["blocks"] for r in b["rows"]]
    stops = [r for r in rows if r.get("kind") == "checkpoint"]
    assert bool(stops) is sees, who
    assert ("Run stop: pricing review" in one.text) is sees, who
    assert ("Run stop: pricing review" in md.text) is sees, who
    if sees:
        assert stops[0]["href"].startswith("/runs/")
    else:
        assert "/runs/" not in one.text
