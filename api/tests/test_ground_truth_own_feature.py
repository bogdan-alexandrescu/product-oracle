"""Its own feature (the owner, Nov 13): a roadmap item Oracle matched to a proposed Ground
Truth feature can join the Ground Truth as its own feature instead, with its own code
(``POST /v1/baseline/roadmap-items/{item_id}/own-feature``, approvers and owners), declining the
proposed match so it is not offered again. Two items sharing one proposed feature are each
confirmed apart: confirming it from one item's flag (``POST .../confirm?item_id=``) leaves the
other flagged until it is in the Ground Truth itself. An add never makes a second entry of a
name the Ground Truth has. Against Postgres. Invented data only.

Test cards (protects / fails_when / no_claim):

- test_an_item_joins_as_its_own_feature: protects=Chat alerts (section f-41) on the shared
  proposed Community alerts joins as F-41 Chat alerts, linked at once, its flag gone; Forum
  alerts (no code) joins with the next free code; the shared proposal stays proposed; an audit
  event names the item; fails_when=the item keeps the proposed match, no code is given, or the
  proposal is confirmed.
- test_a_declined_match_is_not_offered_again: protects=an item linked again to the proposal it
  declined by a later run offers Add to Ground Truth, never Confirm it; fails_when=the declined
  match comes back.
- test_a_person_may_link_the_declined_match_again: protects=a person who links an item back to
  the match it declined (now in the Ground Truth) has it linked, its flag gone; fails_when=the
  decline overrides the person's own link.
- test_a_shared_proposal_keeps_the_other_item_flagged: protects=confirming the shared proposal
  from Chat alerts' flag clears Chat alerts only; Forum alerts stays flagged with Confirm it
  until it is confirmed from its own flag; fails_when=Forum alerts leaves the list while it is
  not in the Ground Truth.
- test_an_add_reuses_an_entry_of_the_same_name: protects=an item named as a confirmed entry is
  linked to it, and one named as a proposed entry confirms that one with the item's code: never
  a second entry of the same name; fails_when=two features read the same name.
- test_a_shared_proposal_of_the_items_name_keeps_the_other_item_flagged: protects=Its own
  feature on Chat alerts, whose shared proposal is named Chat alerts, confirms it for Chat alerts
  only; Forum alerts stays flagged with Confirm it; fails_when=Forum alerts leaves the list.
- test_who_may_add_it: protects=viewers and commenters are refused (403), an unknown item is 404;
  fails_when=a reader changes the Ground Truth.
"""

import uuid

from sqlalchemy import func, select

from oracle.audit import AuditEvent
from oracle.baseline.models import Entity
from oracle.docs.models import DocumentVersion
from oracle.simple.models import SimpleDraft
from oracle.tenancy import tenant_session
from tests.test_ground_truth_check import (
    _check,
    _fixes,
    _of,
    clock,  # noqa: F401  (the fixture)
    world,
)
from tests.test_simple_roadmap_api import Seed


def own(item: str) -> str:
    return f"/v1/baseline/roadmap-items/{item}/own-feature"


async def shared(w: dict, *also: str) -> dict:
    """``world`` plus Community alerts, a run's proposal shared by Chat alerts (its PRD section
    f-41) and Forum alerts (no code); ``also``: confirmed features of these names."""
    async with tenant_session(w["ctx"].tenant_id) as s:
        seed = Seed(s)
        _, pv_id, rv_id = w["seed"]
        rv, pv = await s.get(DocumentVersion, rv_id), await s.get(DocumentVersion, pv_id)
        p = await seed.add(Entity(type="feature", key="community-alerts", title="Community alerts",
                                  status="proposed", origin="agent"))  # fmt: skip
        chat = await seed.item(rv, pv, "chat-alerts", title="Chat alerts", position=5,
                               feature_id=p.id, prd_section_key="f-41")  # fmt: skip
        forum = await seed.item(rv, pv, "forum-alerts", title="Forum alerts", position=6,
                                feature_id=p.id)  # fmt: skip
        for name in also:
            await seed.add(Entity(type="feature", key=name.lower().replace(" ", "-"), title=name,
                                  status="confirmed", origin="user"))  # fmt: skip
        out = {"proposal": str(p.id), "chat": str(chat.id), "forum": str(forum.id)}
        await s.commit()
        return out


def _flag(out: dict, item: str) -> dict | None:
    return next((f for f in _of(out, "unlinked_item") if f["item"]["id"] == item), None)


async def _named(w: dict, title: str) -> list[Entity]:
    async with tenant_session(w["ctx"].tenant_id) as s:
        return list(await s.scalars(select(Entity).where(Entity.type == "feature",
                                                         Entity.title == title)))  # fmt: skip


async def test_an_item_joins_as_its_own_feature(client):
    w = await world()
    x = await shared(w)
    before = _flag(await _check(client, w["ctx"]), x["chat"])
    assert _fixes(before)[0] == ("confirm_feature", x["proposal"])

    r = await client.post(own(x["chat"]), headers=w["ctx"].as_("approver"))
    assert r.status_code == 200, r.text
    got = r.json()
    assert got["status"] == "done" and got["code"] == "F-41"
    assert got["feature"]["name"] == "Chat alerts" and got["feature"]["code"] == "F-41"
    out = await _check(client, w["ctx"])
    assert _flag(out, x["chat"]) is None
    # Forum alerts still waits on the shared proposal, which no one confirmed.
    assert _fixes(_flag(out, x["forum"]))[0] == ("confirm_feature", x["proposal"])

    r = await client.post(own(x["forum"]), headers=w["ctx"].as_("owner"))
    assert r.status_code == 200, r.text
    code = r.json()["code"]
    assert code and code.startswith("F-") and code != "F-41"
    assert _flag(await _check(client, w["ctx"]), x["forum"]) is None
    async with tenant_session(w["ctx"].tenant_id) as s:
        assert (await s.get(Entity, uuid.UUID(x["proposal"]))).status == "proposed"
        events = {e.entity_id for e in await s.scalars(select(AuditEvent).where(
            AuditEvent.action == "baseline.item.own_feature"))}  # fmt: skip
    assert events == {uuid.UUID(x["chat"]), uuid.UUID(x["forum"])}


async def test_a_declined_match_is_not_offered_again(client):
    w = await world()
    x = await shared(w)
    r = await client.post(own(x["forum"]), headers=w["ctx"].as_("owner"))
    assert r.status_code == 200, r.text
    # Forum alerts has no code of its own, so only its link counts. A later run matches it to the
    # proposal it declined again (the run writes the item's feature, no person's change).
    async with tenant_session(w["ctx"].tenant_id) as s:
        d = await s.scalar(select(SimpleDraft).where(SimpleDraft.overlay.has_key(x["forum"])))
        overlay = dict(d.overlay)
        overlay[x["forum"]] = {**overlay[x["forum"]], "feature_id": x["proposal"]}
        d.overlay = overlay
        await s.commit()
    flag = _flag(await _check(client, w["ctx"]), x["forum"])
    assert flag is not None and flag["feature"] is None
    assert _fixes(flag)[0] == ("add_to_ground_truth", x["forum"])


async def test_a_person_may_link_the_declined_match_again(client):
    w = await world()
    x = await shared(w)
    r = await client.post(own(x["forum"]), headers=w["ctx"].as_("owner"))
    assert r.status_code == 200, r.text
    confirm = f"/v1/baseline/entities/{x['proposal']}/confirm"
    c = await client.post(confirm, params={"item_id": x["chat"]}, headers=w["ctx"].as_("approver"))
    assert c.status_code == 200, c.text
    # A person links Forum alerts back to the proposal it declined, now in the Ground Truth.
    body = {"op": "set_feature", "target": {"item_id": x["forum"]},
            "before": {"feature_id": r.json()["feature"]["id"]},
            "after": {"feature_id": x["proposal"]}}  # fmt: skip
    c = await client.post("/v1/simple/changes", json=body, headers=w["ctx"].as_("owner"))
    assert c.status_code in (200, 201), c.text
    assert _flag(await _check(client, w["ctx"]), x["forum"]) is None


async def test_a_shared_proposal_keeps_the_other_item_flagged(client):
    w = await world()
    x = await shared(w)
    confirm = f"/v1/baseline/entities/{x['proposal']}/confirm"
    r = await client.post(confirm, params={"item_id": x["chat"]}, headers=w["ctx"].as_("approver"))
    assert r.status_code == 200, r.text
    out = await _check(client, w["ctx"])
    assert _flag(out, x["chat"]) is None
    forum = _flag(out, x["forum"])
    assert forum is not None, "Forum alerts left the list though no one confirmed it"
    assert _fixes(forum) == [("confirm_feature", x["proposal"]), ("link_to_feature", x["forum"])]
    assert forum["feature"]["id"] == x["proposal"]
    assert out["counts"]["unlinked_item"] == len(_of(out, "unlinked_item"))
    # Confirmed from its own flag, it is in the Ground Truth too.
    r = await client.post(confirm, params={"item_id": x["forum"]}, headers=w["ctx"].as_("approver"))
    assert r.status_code == 200, r.text
    assert _flag(await _check(client, w["ctx"]), x["forum"]) is None


async def test_an_add_reuses_an_entry_of_the_same_name(client):
    w = await world()
    x = await shared(w, "Forum alerts")
    [kept] = await _named(w, "Forum alerts")
    r = await client.post(own(x["forum"]), headers=w["ctx"].as_("owner"))
    assert r.status_code == 200, r.text
    assert r.json()["feature"]["id"] == str(kept.id)
    assert len(await _named(w, "Forum alerts")) == 1
    assert _flag(await _check(client, w["ctx"]), x["forum"]) is None

    # A proposal named as the item (a run's, beside the shared one) is confirmed with its code.
    async with tenant_session(w["ctx"].tenant_id) as s:
        twin = await Seed(s).add(Entity(type="feature", key="chat-alerts-2", title="Chat alerts",
                                        status="proposed", origin="agent"))  # fmt: skip
        twin_id = twin.id
        await s.commit()
    r = await client.post(own(x["chat"]), headers=w["ctx"].as_("approver"))
    assert r.status_code == 200, r.text
    assert r.json()["feature"]["id"] == str(twin_id) and r.json()["code"] == "F-41"
    async with tenant_session(w["ctx"].tenant_id) as s:
        n = await s.scalar(select(func.count()).select_from(Entity).where(
            Entity.type == "feature", Entity.title == "Chat alerts"))  # fmt: skip
        assert n == 1
        assert (await s.get(Entity, twin_id)).status == "confirmed"


async def test_who_may_add_it(client):
    w = await world()
    x = await shared(w)
    for who in ("viewer", "commenter"):
        r = await client.post(own(x["chat"]), headers=w["ctx"].as_(who))
        assert r.status_code == 403, (who, r.text)
    r = await client.post(own(str(uuid.uuid4())), headers=w["ctx"].as_("approver"))
    assert r.status_code == 404, r.text
    assert _flag(await _check(client, w["ctx"]), x["chat"]) is not None


async def test_a_shared_proposal_of_the_items_name_keeps_the_other_item_flagged(client):
    w = await world()
    async with tenant_session(w["ctx"].tenant_id) as s:
        seed = Seed(s)
        _, pv_id, rv_id = w["seed"]
        rv, pv = await s.get(DocumentVersion, rv_id), await s.get(DocumentVersion, pv_id)
        p = await seed.add(Entity(type="feature", key="chat-alerts", title="Chat alerts",
                                  status="proposed", origin="agent"))  # fmt: skip
        chat = await seed.item(rv, pv, "chat-alerts", title="Chat alerts", position=5,
                               feature_id=p.id)  # fmt: skip
        forum = await seed.item(rv, pv, "forum-alerts", title="Forum alerts", position=6,
                                feature_id=p.id)  # fmt: skip
        x = {"proposal": str(p.id), "chat": str(chat.id), "forum": str(forum.id)}
        await s.commit()
    r = await client.post(own(x["chat"]), headers=w["ctx"].as_("approver"))
    assert r.status_code == 200, r.text
    assert r.json()["feature"]["id"] == x["proposal"]
    out = await _check(client, w["ctx"])
    assert _flag(out, x["chat"]) is None
    forum = _flag(out, x["forum"])
    assert forum is not None, "Forum alerts left the list though no one confirmed it"
    assert _fixes(forum) == [("confirm_feature", x["proposal"]), ("link_to_feature", x["forum"])]
