"""meet-draft-items review: the other reads of ``RoadmapItem.roadmap_document_id`` that an
item on a run's draft roadmap (no roadmap document) reaches. Made-up names only.

Test cards (protects / fails_when / no_claim):

- test_effective_of_draft_items_reads_no_drafts: protects=``effective()`` of items with no
  roadmap document asks for no Simple draft; fails_when=a NULL roadmap id goes into the
  query; no_claim=what an open draft overlays on a roadmap's items.
- test_explain_drops_a_draft_item_of_a_hidden_prd: protects=a variance run's ref to an item
  on the draft roadmap of an approvers-only PRD is not readable; fails_when=a NULL roadmap
  id reads as visible; no_claim=refs to a roadmap's own items.
- test_variance_draft_citing_a_draft_item_of_a_hidden_prd_is_withheld: protects=such a
  draft is withheld from members; fails_when=the cited item reads as visible; no_claim=
  drafts that name the PRD in their text.
"""

import uuid

from oracle.docs.models import Document, DocumentVersion
from oracle.metrics import explain, service
from oracle.metrics.models import MetricVariance
from oracle.roadmap.models import DraftRoadmap, RoadmapItem
from oracle.simple import drafts
from oracle.tenancy import tenant_session
from tests.baseline_helpers import make_ctx


class _NoQueries:
    async def scalars(self, *_a, **_k):
        raise AssertionError("effective() queried the drafts")


async def test_effective_of_draft_items_reads_no_drafts():
    row = RoadmapItem(id=uuid.uuid4(), draft_roadmap_id=uuid.uuid4(), item_key="d-1",
                      position=0, title="Draft item", horizon="now")  # fmt: skip
    out = await drafts.effective(_NoQueries(), [row])
    assert out[str(row.id)].title == "Draft item"


async def _hidden_draft_item(tenant_id) -> uuid.UUID:
    """An item on the draft roadmap of an approvers-only PRD; the item names no PRD itself."""
    async with tenant_session(tenant_id) as s:
        prd = Document(slug="board-plan", title="Board plan", visibility="approvers")
        s.add(prd)
        await s.flush()
        pv = DocumentVersion(document_id=prd.id, number=1, markdown="# Plan", content_hash="h")
        s.add(pv)
        await s.flush()
        draft = DraftRoadmap(prd_document_id=prd.id, prd_version_id=pv.id, status="ready")
        s.add(draft)
        await s.flush()
        item = RoadmapItem(draft_roadmap_id=draft.id, item_key="d-1", position=0,
                           title="Draft item", horizon="now")  # fmt: skip
        s.add(item)
        await s.commit()
        return item.id


async def test_explain_drops_a_draft_item_of_a_hidden_prd():
    ctx = await make_ctx()
    item = await _hidden_draft_item(ctx.tenant_id)
    async with tenant_session(ctx.tenant_id) as s:
        assert await explain._readable(s, [("roadmap_item", item)], None) == set()


async def test_variance_draft_citing_a_draft_item_of_a_hidden_prd_is_withheld():
    ctx = await make_ctx()
    item = await _hidden_draft_item(ctx.tenant_id)
    row = MetricVariance(id=uuid.uuid4(), oracle_draft="Teams grew after the launch.",
                         oracle_refs=[{"kind": "roadmap_item", "id": str(item)}])  # fmt: skip
    async with tenant_session(ctx.tenant_id) as s:
        assert await service._withheld_drafts(s, [row], as_member=True) == {row.id}
