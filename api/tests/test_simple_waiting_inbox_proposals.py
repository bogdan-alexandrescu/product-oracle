"""inbox-2 (#1893): Decisions' "Waiting for you" (GET /v1/simple/decisions/waiting ``items``)
lists every proposal the Inbox counts for the signed-in person (GET /v1/inbox
``simple_proposals``), by the Inbox's own rule (changes.current_route), never "Nothing waits
on you" while the Inbox holds one. Against Postgres.

Test cards (protects / fails_when / no_claim):

- test_an_owner_change_the_inbox_counts_waits_for_the_owner: protects=an owner change routed to
  the company's Owner whose item the reader's roadmap read no longer holds is in the Inbox and in
  Waiting for you, as something to open (not to accept); fails_when=the Inbox counts it and the
  waiting list leaves it out; no_claim=accepting it.
- test_an_owner_change_on_a_replaced_prds_item_waits_as_the_inbox_counts_it: protects=an owner
  change on an item of a replaced PRD, which the Inbox still counts for the Owner, is in Waiting
  for you, to open in the Inbox; fails_when=the waiting list drops it with the PRD
  (changes.visible); no_claim=its words.
- test_an_older_proposal_waits_behind_many_newer_ones: protects=a proposal for the decider stays
  in Waiting for you behind 500 newer proposals for someone else, as the Inbox counts it;
  fails_when=the waiting list reads only the newest 500 proposals; no_claim=read speed.
"""

import uuid
from datetime import timedelta

import pytest

from oracle import company_time
from oracle.simple.models import SimpleChange
from oracle.tenancy import tenant_session
from tests.baseline_helpers import make_ctx
from tests.test_simple_changes_api import World, make_people
from tests.test_simple_roadmap_api import NOW

WAITING = "/v1/simple/decisions/waiting"
INBOX = "/v1/inbox"


@pytest.fixture(autouse=True)
def clock(monkeypatch):
    monkeypatch.setattr(company_time, "now", lambda: NOW)


async def _ids(client, ctx, who: str) -> tuple[set[str], dict[str, dict]]:
    inbox = await client.get(INBOX, headers=ctx.as_(who))
    assert inbox.status_code == 200, inbox.text
    waiting = await client.get(WAITING, headers=ctx.as_(who))
    assert waiting.status_code == 200, waiting.text
    return (
        {p["id"] for p in inbox.json()["simple_proposals"]},
        {i["ref_id"]: i for i in waiting.json()["items"]},
    )


async def test_an_owner_change_the_inbox_counts_waits_for_the_owner(client):
    """An owner change the Inbox counts for the Owner waits for them on Decisions too."""
    ctx = await make_ctx()
    async with tenant_session(ctx.tenant_id) as s:
        c = SimpleChange(
            op="set_owner", target={"item_id": str(uuid.uuid4())}, before={"owner_id": None},
            after={"owner_id": str(ctx.users["approver"].id)}, status="proposed",
            by=ctx.users["commenter"].id, at=NOW - timedelta(hours=1),
            routed_to=[ctx.users["owner"].id],
        )  # fmt: skip
        s.add(c)
        await s.commit()
        cid = str(c.id)
    inbox, waiting = await _ids(client, ctx, "owner")
    assert cid in inbox
    assert cid in waiting, list(waiting.values())
    assert waiting[cid]["action"] == "Open"
    assert waiting[cid]["kind"] == "inbox"
    # It opens in Simple's Inbox, keeping Simple's shell (re-review minor).
    assert waiting[cid]["href"] == "/simple/inbox"
    # Someone it is not routed to has it in neither.
    inbox, waiting = await _ids(client, ctx, "approver")
    assert cid not in inbox and cid not in waiting


async def test_an_older_proposal_waits_behind_many_newer_ones(client):
    """A proposal for the decider still waits behind 500 newer ones for someone else."""
    ctx = await make_people()
    w = await World(ctx).build(decider=True, ops=["edit_title"])
    c = (await w.post(client, "commenter", "edit_title")).json()["change"]
    async with tenant_session(ctx.tenant_id) as s:
        s.add_all(
            SimpleChange(
                op="set_owner",
                target={"item_id": str(uuid.uuid4())},
                before={},
                after={},
                status="proposed",
                by=ctx.users["commenter"].id,
                at=NOW + timedelta(minutes=n),
                routed_to=[ctx.users["approver"].id],
            )  # fmt: skip
            for n in range(1, 501)
        )
        await s.commit()
    inbox, waiting = await _ids(client, ctx, "decider")
    assert c["id"] in inbox
    assert waiting.get(c["id"], {}).get("kind") == "proposal", list(waiting.values())[:3]
    assert waiting[c["id"]]["action"] == "Accept"


async def test_an_owner_change_on_a_replaced_prds_item_waits_as_the_inbox_counts_it(client):
    """An owner change on an item of a replaced PRD, still in the Owner's Inbox, waits for them."""
    from sqlalchemy import select

    from oracle.roadmap.models import RoadmapItem
    from tests.test_one_roadmap_many_prds_api import world as company_world

    ctx, _ = await company_world(client)
    owner = ctx.users["owner"]
    async with tenant_session(ctx.tenant_id) as s:
        item = await s.scalar(select(RoadmapItem).where(RoadmapItem.item_key == "read-replicas"))
        c = SimpleChange(
            op="set_owner", target={"item_id": str(item.id)}, before={"owner_id": None},
            after={"owner_id": str(ctx.users["approver"].id)}, status="proposed",
            by=ctx.users["commenter"].id, at=NOW, routed_to=[owner.id],
        )  # fmt: skip
        s.add(c)
        await s.commit()
        cid = str(c.id)
    r = await client.post("/v1/documents/scale/replaced-by", headers=ctx.as_("owner"),
                          json={"prds": ["user-safety"]})  # fmt: skip
    assert r.status_code == 200, r.text
    inbox, waiting = await _ids(client, ctx, "owner")
    assert cid in inbox
    assert cid in waiting, list(waiting.values())
    # The Owner may not decide it now (its PRD replaced): it opens in the Inbox (re-review minor).
    assert (waiting[cid]["kind"], waiting[cid]["action"]) == ("inbox", "Open")
