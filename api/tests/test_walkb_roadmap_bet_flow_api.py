"""walkb-roadmap review: a roadmap item built from a PRD shows the flow its PRD's one-pager
draws for the item's bet (``/v1/simple/roadmap``'s ``item.flow``, naming the bet's line so
the card opens that drawing). Against Postgres, on the one-pager tests' invented PRD; the
drawing job runs with a fake, never a live model.

Test cards (protects / fails_when / no_claim):

- test_item_from_a_prd_shows_its_bets_flow: protects=an item built from the PRD's section
  "build", named like the bet "A setup checklist that shows the next step", carries that
  bet's drawn flow (``subject_kind`` ``one_pager_line``, the bet's subject); an item named
  like a bet with no drawing, and one named like no bet of a section several bets come
  from, carry none; fails_when=the item reads "No flow yet" while the one-pager draws its
  flow, or an item takes another bet's flow; no_claim=the card (walkb-review-5d.spec.ts).
"""

import pytest
from sqlalchemy import select

from oracle import company_time
from oracle.docs.models import Document, DocumentVersion
from oracle.tenancy import tenant_session
from tests.test_simple_line_visuals_api import ask
from tests.test_simple_one_pager_api import get as one_pager
from tests.test_simple_one_pager_api import line, world
from tests.test_simple_roadmap_api import NOW, Seed, by_key, get
from tests.test_simple_visuals_api import ANSWER, run_visual_jobs


@pytest.fixture(autouse=True)
def clock(monkeypatch):
    monkeypatch.setattr(company_time, "now", lambda: NOW)


async def test_item_from_a_prd_shows_its_bets_flow(client):
    ctx = await world(client)
    view = await one_pager(client, ctx, "decider")
    doc_id = view["document"]["id"]
    sid = line(view, "bets-1")["flow_subject"]
    assert (await ask(client, ctx, "decider", sid, doc_id)).status_code == 202
    await run_visual_jobs(ctx)
    assert line(await one_pager(client, ctx, "decider"), "bets-1")["flow"] is not None

    async with tenant_session(ctx.tenant_id) as s:
        seed = Seed(s)
        doc = await s.scalar(select(Document).where(Document.slug == "guided-setup"))
        pv = await s.scalar(select(DocumentVersion).where(DocumentVersion.document_id == doc.id))
        rm = await seed.doc("guided-setup-roadmap", "roadmap")
        rv = await seed.version(rm)
        await seed.item(rv, pv, "setup-checklist", title="Setup checklist",
                        prd_section_key="build")  # fmt: skip
        await seed.item(rv, pv, "sample-project", title="Sample project", position=1,
                        prd_section_key="build")  # fmt: skip
        await seed.item(rv, pv, "weekly-digest", title="Weekly digest", position=2,
                        prd_section_key="build")  # fmt: skip
        await s.commit()

    items = by_key(await get(client, ctx, "owner"))
    flow = items["setup-checklist"]["flow"]
    assert flow is not None, "the item reads No flow yet"
    assert flow["subject_kind"] == "one_pager_line" and flow["subject_id"] == sid
    assert flow["title"] == ANSWER["title"]
    # Its bet is not drawn yet: no other bet's flow.
    assert items["sample-project"]["flow"] is None
    # Named like no bet, from a section four bets come from: none.
    assert items["weekly-digest"]["flow"] is None
