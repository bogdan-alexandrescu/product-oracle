"""build-feature-panel review 7: each bet of a one-pager's "What we will build" names the
roadmap item it came from (``OnePagerLine.item_id``), so "Open the feature" opens that item's
panel by its id, never by matching words in the browser. Against Postgres, on the one-pager
tests' invented PRD.

Test cards (protects / fails_when / no_claim):

- test_each_bet_names_the_item_it_came_from: protects=a bet whose item was built from the
  PRD (named like the bet, from its section) carries that item's id; a bet no item comes
  from carries none; a line that is no bet never carries one; fails_when=``item_id`` is
  missing, names another bet's item, or names an item for a bet no item came from;
  no_claim=the button (feature-panel-review7.spec.ts).
"""

import pytest
from sqlalchemy import select

from oracle import company_time
from oracle.docs.models import Document, DocumentVersion
from oracle.tenancy import tenant_session
from tests.test_simple_one_pager_api import get as one_pager
from tests.test_simple_one_pager_api import line, world
from tests.test_simple_roadmap_api import NOW, Seed, by_key, get


@pytest.fixture(autouse=True)
def clock(monkeypatch):
    monkeypatch.setattr(company_time, "now", lambda: NOW)


async def test_each_bet_names_the_item_it_came_from(client):
    ctx = await world(client)
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
        await s.commit()
    items = by_key(await get(client, ctx, "owner"))

    view = await one_pager(client, ctx, "decider")
    assert line(view, "bets-1")["item_id"] == items["setup-checklist"]["id"]
    sample = next(
        x for b in view["blocks"] if b["key"] == "bets" for x in b["lines"]
        if "sample project" in x["text"].lower()
    )  # fmt: skip
    assert sample["item_id"] == items["sample-project"]["id"]
    # Invite suggestions: no item comes from it.
    assert line(view, "bets-2")["item_id"] is None
    others = [x for b in view["blocks"] if b["key"] != "bets" for x in b["lines"]]
    assert others and all(x.get("item_id") is None for x in others)
