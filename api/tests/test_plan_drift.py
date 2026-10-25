"""H4 §5 Drift checks on Plan items: each item's "Outside the strategy" and "Stopped in the
strategy" findings, for owners and approvers (who sees it, the spec's table).

Each test's card: protects=<the observable>; fails_when=<the wrong result it rejects>;
no_claim=<what green does not prove>.
"""

import pytest
from sqlalchemy import select

from oracle.docs.models import Document, DocumentVersion
from oracle.roadmap.models import RoadmapItem
from oracle.tenancy import tenant_session
from tests.baseline_helpers import make_ctx
from tests.strategy_helpers import ROADMAP_MD, imported
from tests.test_strategy_drift import _world


@pytest.fixture
async def ctx():
    return await make_ctx()


async def _plan(client, ctx, who: str = "owner", scope: str = "all") -> dict[str, dict]:
    resp = await client.get("/v1/plan", params={"scope": scope}, headers=ctx.as_(who))
    assert resp.status_code == 200, resp.text
    return {i["key"]: i for i in resp.json()["items"]}


async def test_approved_items_carry_their_stored_findings(client, ctx):
    """protects=an approved item shows its open finding with the finding's id, words and
    severity; a waived one shows waived with its reason; fails_when=a finding is missing,
    the id is not the stored one, or a waiver is lost; no_claim=the drift rules
    (test_strategy_drift)."""
    await _world(client, ctx)
    items = await _plan(client, ctx)
    (stopped,) = items["item-f"]["drift"]
    assert stopped["kind"] == "stopped_but_planned" and stopped["severity"] == "high"
    assert stopped["label"] == "Stopped in the strategy" and stopped["status"] == "open"
    assert stopped["text"] == "The product strategy stops Sso, and this item is in Now."
    assert stopped["finding_id"] is not None
    (outside,) = items["item-h"]["drift"]
    assert outside["kind"] == "outside_strategy" and outside["label"] == "Outside the strategy"
    assert outside["text"] == "C is under no focus choice of the product strategy."

    resp = await client.post(f"/v1/strategy/findings/{outside['finding_id']}/waive",
                             json={"reason": "A bet we keep"}, headers=ctx.as_("approver"))  # fmt: skip
    assert resp.status_code == 200, resp.text
    (waived,) = (await _plan(client, ctx, "approver"))["item-h"]["drift"]
    assert (waived["status"], waived["waive_reason"]) == ("waived", "A bet we keep")


async def test_commenters_and_viewers_see_no_drift(client, ctx):
    """protects=drift on Plan is for owners and approvers; fails_when=a viewer or a
    commenter reads a finding; no_claim=the Company › Strategy page's own reads."""
    await _world(client, ctx)
    for who in ("viewer", "commenter"):
        items = await _plan(client, ctx, who)
        assert all(i["drift"] == [] for i in items.values())


async def test_a_draft_item_is_measured_live(client, ctx):
    """protects=an item of the roadmap's draft version is measured against the strategy
    when the Plan is read, with no stored finding to waive; fails_when=a draft item has no
    drift, or claims a finding id; no_claim=E1 per-draft roadmaps beyond the latest draft."""
    ids = await _world(client, ctx)
    await imported(client, ctx.as_("owner"), "example-roadmap",
                   ROADMAP_MD.format(slug="example-roadmap") + "\nA draft.\n")  # fmt: skip
    async with tenant_session(ctx.tenant_id) as s:
        doc = await s.scalar(select(Document).where(Document.slug == "example-roadmap"))
        v2 = await s.scalar(
            select(DocumentVersion).where(
                DocumentVersion.document_id == doc.id, DocumentVersion.number == 2
            )
        )
        for position, (key, horizon, feature) in enumerate(
            [("item-f", "later", ids["f"]), ("item-g", "next", ids["f"])]
        ):
            s.add(RoadmapItem(roadmap_document_id=doc.id, roadmap_version_id=v2.id,
                              item_key=key, position=position, title=key.title(),
                              horizon=horizon, feature_id=feature))  # fmt: skip
        await s.commit()
    items = await _plan(client, ctx)
    assert items["item-f"]["origin"] == "draft" and items["item-f"]["drift"] == []
    (live,) = items["item-g"]["drift"]
    assert live["kind"] == "stopped_but_planned" and live["finding_id"] is None
    assert live["text"] == "The product strategy stops Sso, and this item is in Next."
