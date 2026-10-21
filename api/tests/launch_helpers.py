"""Shared setup for the H6 launches and changelog tests: an accepted PRD, its track,
a roadmap built from it and approved (which plans the launches of its Now items)."""

import uuid
from datetime import UTC, datetime

from sqlalchemy import select, update

from oracle.baseline.models import Entity
from oracle.docs.models import Document
from oracle.roadmap.models import RoadmapItem
from oracle.swarm import Outcome
from oracle.tenancy import tenant_session
from tests.test_roadmap import (
    ITEMS,
    PRD,
    ROADMAP,
    ROADMAP_MD,
    approved_prd,
    create,
    get,
    start,
    tick,
)

# Two items in Now (payment-step, shipping-step) and one in Next (order-tracking).
ITEMS_3 = (
    ITEMS.replace("    horizon: next\n", "    horizon: now\n")
    + """  - id: order-tracking
    title: Order tracking
    outcome: Buyers know where their order is
    horizon: next
    milestone: Tracking page
    depends_on: [payment-step]
    priority: {score: 2.0, rank: 3, explanation: "activation weight 3 x contribution 1"}
    confidence: low
    prd_section: metrics
"""
)


async def build_roadmap(client, auth, runtime, items: str = ITEMS_3) -> None:
    runtime.script["roadmap_items"] = [Outcome(artifacts={"roadmap_items.yaml": items})]
    runtime.script["roadmap_draft"] = [Outcome(artifacts={"roadmap.md": ROADMAP_MD})]
    off = {"roadmap_items": False, "roadmap_review": False}
    run = await start(
        client, auth, await create(client, auth, source=PRD, knobs={"checkpoints": off})
    )
    await tick(client, auth)
    await tick(client, auth)
    assert (await get(client, auth, run["id"]))["status"] == "succeeded"


async def approve_roadmap(client, auth) -> None:
    resp = await client.post(f"/v1/documents/{ROADMAP}/versions/1/approve", headers=auth)
    assert resp.status_code == 200, resp.text


async def trace_features(tenant_id: uuid.UUID) -> None:
    """Point each roadmap item at its feature entity (the trace lane does this from
    section links; the tests set it so the tier rule has its input)."""
    async with tenant_session(tenant_id) as s:
        for item in await s.scalars(select(RoadmapItem)):
            feature = await s.scalar(
                select(Entity.id).where(Entity.type == "feature", Entity.key == item.item_key)
            )
            item.feature_id = feature
        await s.commit()


async def feature_before_prd(tenant_id: uuid.UUID, key: str) -> None:
    """Make a feature older than the PRD: an improvement, not a new feature."""
    async with tenant_session(tenant_id) as s:
        prd = await s.scalar(select(Document).where(Document.slug == PRD))
        await s.execute(
            update(Entity)
            .where(Entity.type == "feature", Entity.key == key)
            .values(created_at=prd.created_at.replace(year=prd.created_at.year - 1))
        )
        await s.commit()


async def launched_world(client, auth, runtime, tenant_id) -> dict:
    """The PRD approved, its baseline (features created for it), the roadmap built
    and approved: the planned launches of payment-step and shipping-step."""
    from tests.test_roadmap import seed_baseline

    await approved_prd(client, auth)
    await seed_baseline(tenant_id)
    await build_roadmap(client, auth, runtime)
    await trace_features(tenant_id)
    await approve_roadmap(client, auth)
    launches = (await client.get("/v1/launches", headers=auth)).json()
    by_item = {launch["item_keys"][0]: launch for launch in launches}
    return by_item


async def tracker_done(client, auth, track_id: str, item_key: str, *refs: str, state="done"):
    records = [
        {
            "external_ref": ref,
            "state": state,
            "track_id": track_id,
            "item_key": item_key,
            "observed_at": datetime.now(UTC).isoformat(),
        }
        for ref in refs
    ]
    resp = await client.post(
        "/v1/tracker/records", json={"tracker": "github", "records": records}, headers=auth
    )
    assert resp.status_code == 200, resp.text


async def ticker_pass(tenant_id: uuid.UUID) -> None:
    """One company's turn of the scheduled ticker (oracle.ticker.router): its runs,
    its tracks' monitoring and its launches' Ready detection."""
    from oracle.ticker import router as ticker

    out = ticker.TickerOut()
    failures = ticker._Failures(out)
    await ticker._tick_company(tenant_id, out, failures)
    assert out.companies.failed == 0


async def member_asked(tenant_id: uuid.UUID, name: str, section_key: str, text: str) -> uuid.UUID:
    """A member who asked for an item: their comment on the PRD section the item came
    from, addressed in the PRD version that has it (version 1)."""
    from oracle.auth.models import User
    from oracle.docs.models import DocumentVersion
    from oracle.review.models import Comment, FeedbackItem

    async with tenant_session(tenant_id) as s:
        user = User(
            email=f"{name.lower().replace(' ', '.')}@example.com",
            password_hash="x",
            role="commenter",
        )
        s.add(user)
        await s.flush()
        prd = await s.scalar(select(Document).where(Document.slug == PRD))
        version = await s.scalar(
            select(DocumentVersion).where(
                DocumentVersion.document_id == prd.id, DocumentVersion.number == 1
            )
        )
        comment = Comment(
            version_id=version.id, section_key=section_key, body=text, author_id=user.id,
            anchor={"exact": "saved cards"},
        )  # fmt: skip
        s.add(comment)
        await s.flush()
        s.add(
            FeedbackItem(
                document_id=prd.id, raised_on_version=1, kind="comment", comment_id=comment.id,
                section_key=section_key, summary=text, status="addressed",
                addressed_in_version=1,
            )
        )  # fmt: skip
        await s.commit()
        return user.id
