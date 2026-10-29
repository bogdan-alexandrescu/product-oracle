"""Simple S4 (#723, lane 1): what the roadmap's floating card reads from
``GET /v1/simple/roadmap``: each item's owner, whether the caller's change applies
(``can_decide``), its top reasons and its open decisions; each goal's metric (the goal
counters). Against Postgres, with the S2 test's seeds.

Test cards (protects / fails_when / no_claim):

- test_card_fields_owner_reasons_and_decisions: protects=an item carries its track
  owner's name, up to 3 one-line reasons (the priority's rationale, the goal it serves,
  the PRD section it came from), the open (proposed) decisions naming it as a subject,
  and its goal's metric; a decided decision is not listed; fails_when=a field is missing,
  a decided decision shows, or more than 3 reasons come back; no_claim=the reasons'
  wording beyond their sources.
- test_can_decide_per_role: protects=an owner's and the track owner's (an approver)
  changes apply (can_decide), a commenter's and another approver's are proposals;
  fails_when=can_decide disagrees with the change engine's own rule (service.can_decide);
  no_claim=the web's use of it (web/e2e/simple-roadmap.spec.ts).
- test_card_fields_keep_the_read_bulk: protects=500 items with owners, reasons and
  decisions still read in under 300 ms; fails_when=the new fields read per item;
  no_claim=production hardware.
"""

import time
from datetime import UTC, datetime

import pytest

from oracle.auth.models import User
from oracle.decisions.models import Decision
from oracle.tenancy import tenant_session
from tests.baseline_helpers import make_ctx
from tests.test_simple_roadmap_api import (  # noqa: F401  (the autouse clock)
    URL,
    Seed,
    by_key,
    clock,
    get,
    seed_many,
)


def decision(number: int, title: str, item_id, approver_id, status: str = "proposed") -> Decision:
    kw = {}
    if status == "decided":
        kw = {
            "chosen_option": "a",
            "rationale": "Chosen.",
            "decided_at": datetime(2026, 10, 30, tzinfo=UTC),
            "review_at": datetime(2027, 1, 30, tzinfo=UTC).date(),
        }
    return Decision(
        number=number,
        title=title,
        status=status,
        approver_id=approver_id,
        driver="oracle",
        origin="manual",
        subjects=[{"kind": "roadmap_item", "id": str(item_id), "ref": None}],
        **kw,
    )


async def test_card_fields_owner_reasons_and_decisions(client):
    ctx = await make_ctx()
    async with tenant_session(ctx.tenant_id) as s:
        seed = Seed(s)
        prd, pv, rm, rv = await seed.roadmap("alerts")
        goal = await seed.entity("goal", "activation", metric="Weekly active teams")
        feature = await seed.entity("feature", "digest")
        await seed.supports(feature, goal)
        approver = await s.get(User, ctx.users["approver"].id)
        approver.name = "Avery Lane"
        await seed.track(pv, rm, "Alerts", owner_id=approver.id)
        item = await seed.item(
            rv,
            pv,
            "digest",
            feature_id=feature.id,
            prd_section_key="bets",
            priority={"rank": 1, "rationale": "Most asked for by admins."},
        )
        bare = await seed.item(rv, None, "bare", position=1)
        s.add(decision(1, "Ship the digest weekly or daily?", item.id, approver.id))
        s.add(decision(2, "Name of the digest", item.id, approver.id, status="decided"))
        await s.commit()
    body = await get(client, ctx, "viewer")
    i = by_key(body)["digest"]
    assert i["owner"] == {"id": str(ctx.users["approver"].id), "name": "Avery Lane"}
    assert i["reasons"] == [
        "Most asked for by admins.",
        "Serves the goal Activation.",
        "From Alerts Prd (draft 1): Digest.",
    ]
    assert [d["title"] for d in i["open_decisions"]] == ["Ship the digest weekly or daily?"]
    assert i["open_decisions"][0]["number"] == 1
    assert i["goal"]["metric"] == "Weekly active teams"
    b = by_key(body)["bare"]
    assert b["reasons"] == [] and b["open_decisions"] == []
    assert b["owner"] is None  # no PRD, so no track
    assert str(bare.id) == b["id"]


async def test_can_decide_per_role(client):
    ctx = await make_ctx()
    async with tenant_session(ctx.tenant_id) as s:
        seed = Seed(s)
        prd, pv, rm, rv = await seed.roadmap("alerts")
        await seed.track(pv, rm, "Alerts", owner_id=ctx.users["approver"].id)
        await seed.item(rv, pv, "owned")
        _, pv2, rm2, rv2 = await seed.roadmap("billing")
        await seed.item(rv2, pv2, "unowned")
        await s.commit()
    seen = {
        role: {k: v["can_decide"] for k, v in by_key(await get(client, ctx, role)).items()}
        for role in ("owner", "approver", "commenter", "viewer")
    }
    assert seen["owner"] == {"owned": True, "unowned": True}
    assert seen["approver"] == {"owned": True, "unowned": False}
    assert seen["commenter"] == {"owned": False, "unowned": False}
    assert seen["viewer"] == {"owned": False, "unowned": False}


@pytest.mark.timing
async def test_card_fields_keep_the_read_bulk(client):
    ctx = await make_ctx()
    await seed_many(ctx)
    headers = ctx.as_("owner")
    r = await client.get(URL, headers=headers)
    assert r.status_code == 200 and len(r.json()["items"]) == 500
    assert all("reasons" in i and "open_decisions" in i for i in r.json()["items"])
    times = []
    for _ in range(3):
        t0 = time.perf_counter()
        r = await client.get(URL, headers=headers)
        times.append(time.perf_counter() - t0)
    assert min(times) < 0.3, times
