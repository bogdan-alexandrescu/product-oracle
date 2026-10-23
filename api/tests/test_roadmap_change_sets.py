"""Edit the approved plan as a change set and propose it as a new roadmap version (#346):
change-set CRUD with its audit trail, the proposed version's items are the base's plus
the changes, only the document's decider approves it (and approving it makes it the live
plan), a stale base is refused with a clear message, and roles. Against Postgres with
the FakeRuntime."""

import uuid

from sqlalchemy import select

from oracle.auth.service import create_user, make_session_cookie
from oracle.baseline.models import Entity
from oracle.config import get_settings
from oracle.models import AuditEvent
from oracle.tenancy import tenant_session
from tests.fixtures import import_draft
from tests.roadmap_helpers import other_company
from tests.test_roadmap import (  # noqa: F401 - fixtures
    ROADMAP,
    ROADMAP_MD,
    approved_prd,
    as_user,
    built_roadmap,
    owner,
    runtime,
    seed_baseline,
)

SETS = f"/v1/roadmaps/{ROADMAP}/change-sets"


async def approved_roadmap(client, auth, runtime) -> None:  # noqa: F811
    """Checkout roadmap v1 (Payment step in Now, Shipping step in Next), approved."""
    await approved_prd(client, auth)
    await built_roadmap(client, auth, runtime)
    resp = await client.post(f"/v1/documents/{ROADMAP}/versions/1/approve", headers=auth)
    assert resp.status_code == 200, resp.text


async def member(tenant_id: uuid.UUID, role: str) -> tuple[uuid.UUID, dict[str, str]]:
    async with tenant_session(tenant_id) as s:
        user = await create_user(s, f"{role}-{uuid.uuid4().hex[:6]}@example.com", "pw")
        user.role = role
        await s.commit()
    cookie = f"{get_settings().session_cookie_name}={make_session_cookie(user)}"
    return user.id, {"Cookie": cookie}


async def patch(client, auth, out: dict, changes: list[dict]):
    return await client.patch(
        f"{SETS}/{out['id']}",
        json={"changes": changes, "lock_version": out["lock_version"]},
        headers=auth,
    )


CHANGES = [
    {"op": "move", "key": "payment-step", "horizon": "next"},
    {"op": "cut", "key": "shipping-step", "reason": "Shipping moves to the carrier's app"},
    {"op": "add", "title": "Gift cards", "horizon": "next"},
    {"op": "reorder", "key": "gift-cards", "position": 0},
]


async def test_change_set_crud_and_audit(client, owner, runtime):  # noqa: F811
    tenant_id, auth = owner
    await approved_roadmap(client, auth, runtime)

    resp = await client.post(SETS, headers=auth)
    assert resp.status_code == 201, resp.text
    out = resp.json()
    assert out["status"] == "draft" and out["base_version"] == 1 and out["changes"] == []
    assert [(i["key"], i["horizon"]) for i in out["items"]] == [
        ("payment-step", "now"),
        ("shipping-step", "next"),
    ]
    # Edit plan again: the same draft (one per roadmap).
    again = await client.post(SETS, headers=auth)
    assert again.status_code == 200 and again.json()["id"] == out["id"]

    resp = await patch(client, auth, out, CHANGES)
    assert resp.status_code == 200, resp.text
    edited = resp.json()
    assert edited["lock_version"] == out["lock_version"] + 1
    assert [c["op"] for c in edited["changes"]] == ["move", "cut", "add", "reorder"]
    assert edited["changes"][2]["key"] == "gift-cards"
    assert [(i["key"], i["horizon"], i["new"]) for i in edited["items"]] == [
        ("gift-cards", "next", True),
        ("payment-step", "next", False),
    ]
    assert edited["cut"] == [
        {"key": "shipping-step", "title": "Shipping step", "horizon": "next",
         "reason": "Shipping moves to the carrier's app"}
    ]  # fmt: skip
    diff = {d["key"]: d for d in edited["diff"]}
    assert diff["payment-step"]["status"] == "moved"
    assert (diff["payment-step"]["from_horizon"], diff["payment-step"]["to_horizon"]) == (
        "now",
        "next",
    )
    assert diff["shipping-step"]["status"] == "dropped"
    assert diff["shipping-step"]["reason"] == "Shipping moves to the carrier's app"
    assert diff["gift-cards"]["status"] == "added"
    got = (await client.get(f"{SETS}/{out['id']}", headers=auth)).json()
    assert got["changes"] == edited["changes"] and got["items"] == edited["items"]

    # A copy loaded before the edit is refused; so is a change that does not apply.
    stale = await patch(client, auth, out, [])
    assert stale.status_code == 409 and "changed since it was loaded" in stale.json()["detail"]
    unknown = await patch(client, auth, edited, [{"op": "move", "key": "nope", "horizon": "now"}])
    assert unknown.status_code == 422 and "nope is not an item" in unknown.json()["detail"]
    no_reason = await patch(client, auth, edited, [{"op": "cut", "key": "payment-step"}])
    assert no_reason.status_code == 422
    twice = await patch(
        client, auth, edited, [{"op": "add", "title": "Payment step", "horizon": "later"}]
    )
    assert twice.status_code == 422 and "has an item payment-step" in twice.json()["detail"]

    # A Baseline feature takes its key.
    await seed_baseline(tenant_id)
    async with tenant_session(tenant_id) as s:
        feature = await s.scalar(
            select(Entity).where(Entity.type == "feature", Entity.key == "shipping-step")
        )
    resp = await patch(
        client, auth, edited,
        [{"op": "add", "title": feature.title, "horizon": "later", "feature_id": str(feature.id)}],
    )  # fmt: skip
    assert resp.status_code == 422 and "has an item shipping-step" in resp.json()["detail"]

    resp = await client.delete(f"{SETS}/{out['id']}", headers=auth)
    assert resp.status_code == 200 and resp.json()["status"] == "discarded"
    after = await patch(client, auth, resp.json(), [])
    assert after.status_code == 409 and "discarded" in after.json()["detail"]
    fresh = await client.post(SETS, headers=auth)
    assert fresh.status_code == 201 and fresh.json()["id"] != out["id"]

    async with tenant_session(tenant_id) as s:
        actions = [
            e.action
            for e in await s.scalars(
                select(AuditEvent)
                .where(AuditEvent.entity == "roadmap_change_set")
                .order_by(AuditEvent.created_at)
            )
        ]
    assert actions == [
        "roadmap.change_set_opened",
        "roadmap.change_set_updated",
        "roadmap.change_set_discarded",
        "roadmap.change_set_opened",
    ]


async def test_proposed_version_is_the_base_plus_the_changes(client, owner, runtime):  # noqa: F811
    tenant_id, auth = owner
    await approved_roadmap(client, auth, runtime)
    out = (await client.post(SETS, headers=auth)).json()
    edited = (await patch(client, auth, out, CHANGES)).json()

    resp = await client.post(f"{SETS}/{out['id']}/propose", headers=auth)
    assert resp.status_code == 200, resp.text
    proposed = resp.json()
    assert proposed["status"] == "proposed" and proposed["proposed_version"] == 2
    assert proposed["diff"] == edited["diff"]

    items = (
        await client.get(f"/v1/roadmaps/{ROADMAP}/items", params={"version": 2}, headers=auth)
    ).json()["items"]
    assert [(i["item_key"], i["horizon"], i["title"]) for i in items] == [
        (i["key"], i["horizon"], i["title"]) for i in edited["items"]
    ]
    pay = next(i for i in items if i["item_key"] == "payment-step")
    # Copied with its trace; out of Now, its date is dropped (O4).
    assert pay["prd"]["section_key"] == "s-5-1" and pay["milestone"]["date"] is None
    # The approved version is untouched, and the new one waits for approval.
    base = (
        await client.get(f"/v1/roadmaps/{ROADMAP}/items", params={"version": 1}, headers=auth)
    ).json()["items"]
    assert [(i["item_key"], i["horizon"]) for i in base] == [
        ("payment-step", "now"),
        ("shipping-step", "next"),
    ]
    v2 = (await client.get(f"/v1/documents/{ROADMAP}/versions/2", headers=auth)).json()
    assert v2["approved_at"] is None
    section = next(s for s in v2["sections"] if s["section_key"] == "plan-changes")
    assert "Cut Shipping step: Shipping moves to the carrier's app" in section["body_md"]
    assert "Moved Payment step to Next" in section["body_md"]

    # Proposed: no more edits, and no second proposal.
    assert (await patch(client, auth, proposed, [])).status_code == 409
    again = await client.post(f"{SETS}/{out['id']}/propose", headers=auth)
    assert again.status_code == 409
    # Nothing to propose.
    empty = (await client.post(SETS, headers=auth)).json()
    resp = await client.post(f"{SETS}/{empty['id']}/propose", headers=auth)
    assert resp.status_code == 422 and "Nothing to propose" in resp.json()["detail"]


async def test_only_the_decider_approves_and_it_becomes_the_plan(client, owner, runtime):  # noqa: F811
    tenant_id, auth = owner
    await approved_roadmap(client, auth, runtime)
    decider_id, decider = await member(tenant_id, "approver")
    resp = await client.put(
        f"/v1/documents/{ROADMAP}/review-policy",
        json={"decider_id": str(decider_id), "section_approval": "none"},
        headers=auth,
    )
    assert resp.status_code == 200, resp.text
    out = (await client.post(SETS, headers=auth)).json()
    assert out["decider_id"] == str(decider_id)
    await patch(client, auth, out, CHANGES)
    assert (await client.post(f"{SETS}/{out['id']}/propose", headers=auth)).status_code == 200

    refused = await client.post(f"/v1/documents/{ROADMAP}/versions/2/approve", headers=auth)
    assert refused.status_code == 403
    assert "designated decider" in refused.json()["detail"]
    plan = (await client.get("/v1/plan", params={"scope": "approved"}, headers=auth)).json()
    assert {i["roadmap"]["version"] for i in plan["items"]} == {1}

    ok = await client.post(f"/v1/documents/{ROADMAP}/versions/2/approve", headers=decider)
    assert ok.status_code == 200, ok.text
    plan = (await client.get("/v1/plan", params={"scope": "approved"}, headers=auth)).json()
    assert [(i["key"], i["horizon"], i["roadmap"]["version"]) for i in plan["items"]] == [
        ("gift-cards", "next", 2),
        ("payment-step", "next", 2),
    ]


async def test_a_stale_base_is_refused(client, owner, runtime):  # noqa: F811
    tenant_id, auth = owner
    await approved_roadmap(client, auth, runtime)
    out = (await client.post(SETS, headers=auth)).json()
    edited = (await patch(client, auth, out, CHANGES[:1])).json()
    # Meanwhile a new roadmap version is imported and approved.
    md = ROADMAP_MD.replace("payment first, then shipping", "payment first")
    assert (await import_draft(client, auth, md, doc=ROADMAP)).status_code == 201
    resp = await client.post(f"/v1/documents/{ROADMAP}/versions/2/approve", headers=auth)
    assert resp.status_code == 200, resp.text

    for resp in (
        await patch(client, auth, edited, CHANGES),
        await client.post(f"{SETS}/{out['id']}/propose", headers=auth),
    ):
        assert resp.status_code == 409
        assert resp.json()["detail"] == (
            "The approved plan changed: these changes were made on version 1 and version 2 "
            "is approved now. Discard them and edit the plan again."
        )
    # Discarded, the plan is edited again on version 2.
    assert (await client.delete(f"{SETS}/{out['id']}", headers=auth)).status_code == 200
    fresh = (await client.post(SETS, headers=auth)).json()
    assert fresh["base_version"] == 2


async def test_roles_and_companies(client, owner, runtime):  # noqa: F811
    tenant_id, auth = owner
    await approved_roadmap(client, auth, runtime)
    out = (await client.post(SETS, headers=auth)).json()
    for role in ("viewer", "commenter"):
        headers = await as_user(tenant_id, role)
        assert (await client.post(SETS, headers=headers)).status_code == 403
        assert (await patch(client, headers, out, CHANGES)).status_code == 403
        propose = await client.post(f"{SETS}/{out['id']}/propose", headers=headers)
        assert propose.status_code == 403
        assert (await client.delete(f"{SETS}/{out['id']}", headers=headers)).status_code == 403
        # Everyone reads.
        assert (await client.get(f"{SETS}/{out['id']}", headers=headers)).status_code == 200
    other = await other_company()
    assert (await client.get(f"{SETS}/{out['id']}", headers=other)).status_code == 404
    assert (await client.post(SETS, headers=other)).status_code == 404
