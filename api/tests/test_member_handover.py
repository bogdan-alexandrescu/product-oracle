"""A5 Members and access, part 2: handing a member's responsibilities over (AC 16-19).

Synthetic placeholders only (example.com)."""

import pytest
from sqlalchemy import select

from oracle import readiness
from oracle.auth.models import User
from oracle.models import AuditEvent
from oracle.tenancy import tenant_session
from tests.review_v2_helpers import DOC, person, setup, states


@pytest.fixture(autouse=True)
def _only_test_checks():
    with readiness.isolated_checks():
        yield


async def _company_policy(client, ctx, **value) -> None:
    resp = await client.put("/v1/settings/review_policy", json={"value": value}, headers=ctx.auth)
    assert resp.status_code == 200, resp.text


async def _doc_policy(client, ctx, **value) -> None:
    resp = await client.put(f"/v1/documents/{DOC}/review-policy", json=value, headers=ctx.auth)
    assert resp.status_code == 200, resp.text


async def _policies(client, ctx) -> tuple[dict, dict]:
    company = await client.get("/v1/settings/review_policy", headers=ctx.auth)
    doc = await client.get(f"/v1/documents/{DOC}/review-policy", headers=ctx.auth)
    assert company.status_code == 200 and doc.status_code == 200, (company.text, doc.text)
    return company.json()["value"], doc.json()


async def _actions(ctx, *names) -> list[AuditEvent]:
    async with tenant_session(ctx.tenant_id) as s:
        return list(
            await s.scalars(
                select(AuditEvent)
                .where(AuditEvent.action.in_(names))
                .order_by(AuditEvent.created_at)
            )
        )


async def _assign(client, ctx, key: str, owner=None, reviewers=()) -> None:
    lock = (await states(client, ctx.auth, 1))[key].get("lock_version")
    resp = await client.put(
        f"/v1/documents/{DOC}/sections/{key}/assignment",
        json={"owner_id": str(owner) if owner else None,
              "reviewer_ids": [str(r) for r in reviewers], "lock_version": lock},
        headers=ctx.auth,
    )  # fmt: skip
    assert resp.status_code == 200, resp.text


async def _responsibilities(client, ctx, user_id) -> dict[str, dict]:
    resp = await client.get(f"/v1/members/{user_id}", headers=ctx.auth)
    assert resp.status_code == 200, resp.text
    return {r["kind"]: r for r in resp.json()["responsibilities"]}


async def test_disable_hands_the_decider_to_the_owner(client):
    """protects: removing a decider with a hand-over leaves both policies decided by
    the owner and the document publishable (AC 16).
    fails_when: a policy still names the removed member, the hand-over audit is
    missing, or the publish check still reports the removed decider.
    no_claim: the publish itself (its render and store)."""
    ctx = await setup(client)
    boss = await person(ctx.tenant_id, "owner", "boss")
    decider = await person(ctx.tenant_id, "approver", "decider")
    await _company_policy(client, ctx, decider_id=str(decider.user_id))
    await _doc_policy(client, ctx, decider_id=str(decider.user_id))
    held = await _responsibilities(client, ctx, decider.user_id)
    assert held["review_decider"]["count"] == 2
    assert held["review_decider"]["blocks"] == "Publishing waits until someone else decides"

    resp = await client.post(
        f"/v1/members/{decider.user_id}/disable",
        json={"hand_over": [{"kind": "review_decider", "to": str(boss.user_id)}]},
        headers=ctx.auth,
    )
    assert resp.status_code == 200, resp.text
    assert resp.json()["status"] == "disabled"
    company, doc = await _policies(client, ctx)
    assert company["decider_id"] == str(boss.user_id)
    assert doc["decider_id"] == str(boss.user_id)
    events = await _actions(
        ctx, "member.hand_over", "member.disable", "review_policy.update", "setting.update"
    )
    by = {e.action: e for e in events}
    moved = by["member.hand_over"].data
    assert moved["from"] == str(decider.user_id)
    assert moved["moves"] == [
        {"kind": "review_decider", "to": str(boss.user_id), "count": 2,
         "refs": ["review_policy:company", f"document:{DOC}"]}
    ]  # fmt: skip
    # One transaction: the hand-over and the disable share their commit time.
    assert by["member.hand_over"].created_at == by["member.disable"].created_at
    after = [e for e in events if e.created_at == by["member.disable"].created_at]
    assert {e.action for e in after} >= {"review_policy.update", "setting.update"}
    check = await client.get(ctx.v(1, "/publish-check"), headers=ctx.auth)
    assert check.status_code == 200, check.text
    assert "decider_not_current" not in [b["code"] for b in check.json()["blockers"]]
    assert await _responsibilities(client, ctx, decider.user_id) == {}


async def test_a_viewer_target_is_refused_and_nothing_changes(client):
    """protects: nobody below approver is made a decider, and a refusal moves nothing
    (AC 16).
    fails_when: the viewer becomes decider, or the member is disabled anyway.
    no_claim: the wording of other refusals."""
    ctx = await setup(client)
    viewer = await person(ctx.tenant_id, "viewer", "viewer")
    decider = await person(ctx.tenant_id, "approver", "decider")
    await _company_policy(client, ctx, decider_id=str(decider.user_id))
    resp = await client.post(
        f"/v1/members/{decider.user_id}/disable",
        json={"hand_over": [{"kind": "review_decider", "to": str(viewer.user_id)}]},
        headers=ctx.auth,
    )
    assert resp.status_code == 422, resp.text
    [refusal] = resp.json()["detail"]
    assert refusal["code"] == "hand_over_target" and refusal["kind"] == "review_decider"
    assert "needs the approver role to decide document reviews" in refusal["message"]
    company, _ = await _policies(client, ctx)
    assert company["decider_id"] == str(decider.user_id)
    async with tenant_session(ctx.tenant_id) as s:
        assert (await s.get(User, decider.user_id)).disabled_at is None
    assert await _actions(ctx, "member.hand_over", "member.disable") == []


async def test_clearing_keeping_and_handing_over_later(client):
    """protects: ``to: null`` clears, a kind left out stays, and a removed member's
    rest can be handed over later (AC 17).
    fails_when: a cleared section keeps its owner, a left-out kind moves, the later
    hand-over is refused, or an unknown kind is accepted.
    no_claim: the section's notification wording."""
    ctx = await setup(client)
    pm = await person(ctx.tenant_id, "approver", "former-pm")
    other = await person(ctx.tenant_id, "commenter", "commenter")
    keys = list(await states(client, ctx.auth, 1))
    await _assign(client, ctx, keys[0], owner=pm.user_id)
    await _assign(client, ctx, keys[1], reviewers=[pm.user_id])
    await _assign(client, ctx, keys[2], owner=pm.user_id)

    resp = await client.post(
        f"/v1/members/{pm.user_id}/hand-over",
        json={"hand_over": [{"kind": "nope", "to": None}]},
        headers=ctx.auth,
    )
    assert resp.status_code == 422, resp.text

    resp = await client.post(
        f"/v1/members/{pm.user_id}/disable",
        json={"hand_over": [{"kind": "section_owner", "to": None}]},
        headers=ctx.auth,
    )
    assert resp.status_code == 200, resp.text
    s1 = await states(client, ctx.auth, 1)
    assert s1[keys[0]]["owner_id"] is None and s1[keys[2]]["owner_id"] is None
    # Left out: the reviewer assignment still names the removed member.
    assert s1[keys[1]]["reviewer_ids"] == [str(pm.user_id)]
    held = await _responsibilities(client, ctx, pm.user_id)
    assert list(held) == ["section_reviewer"]

    resp = await client.post(
        f"/v1/members/{pm.user_id}/hand-over",
        json={"hand_over": [{"kind": "section_reviewer", "to": str(other.user_id)}]},
        headers=ctx.auth,
    )
    assert resp.status_code == 200, resp.text
    assert resp.json() == {"responsibilities": []}
    s1 = await states(client, ctx.auth, 1)
    assert s1[keys[1]]["reviewer_ids"] == [str(other.user_id)]


async def test_a_demotion_with_and_without_a_hand_over(client):
    """protects: a demotion moves the chosen responsibilities first, then changes the
    role; without them it still succeeds and the preview flagged them (AC 18).
    fails_when: the role changes but the policy keeps the demoted decider when a
    hand-over was sent, or the preview says the commenter may keep deciding.
    no_claim: what the publish check says about a demoted decider (C2's tests)."""
    ctx = await setup(client)
    boss = await person(ctx.tenant_id, "owner", "boss")
    a = await person(ctx.tenant_id, "approver", "decider-a")
    b = await person(ctx.tenant_id, "approver", "decider-b")
    await _doc_policy(
        client, ctx, decider_id=str(a.user_id), mandatory_reviewer_ids=[str(a.user_id)]
    )
    resp = await client.get(
        f"/v1/members/{a.user_id}/impact",
        params={"change": "role", "role": "commenter"},
        headers=ctx.auth,
    )
    body = resp.json()
    flagged = {r["kind"]: r["holder_ok"] for r in body["responsibilities"]}
    assert flagged == {"review_decider": False, "mandatory_reviewer": False}
    assert body["nothing"] is False
    resp = await client.patch(
        f"/v1/members/{a.user_id}",
        json={"role": "commenter", "hand_over": [
            {"kind": "review_decider", "to": str(boss.user_id)},
            {"kind": "mandatory_reviewer", "to": str(b.user_id)}]},
        headers=ctx.auth,
    )  # fmt: skip
    assert resp.status_code == 200, resp.text
    assert resp.json()["role"] == "commenter"
    _, doc = await _policies(client, ctx)
    assert doc["decider_id"] == str(boss.user_id)
    assert doc["mandatory_reviewer_ids"] == [str(b.user_id)]
    [moved] = await _actions(ctx, "member.hand_over")
    [role] = await _actions(ctx, "member.role")
    assert moved.created_at == role.created_at

    # Without a hand-over the demotion still succeeds; the policy keeps the id.
    resp = await client.patch(
        f"/v1/members/{b.user_id}", json={"role": "commenter"}, headers=ctx.auth
    )
    assert resp.status_code == 200, resp.text
    _, doc = await _policies(client, ctx)
    assert doc["mandatory_reviewer_ids"] == [str(b.user_id)]


async def test_held_lists_open_items_only(client):
    """protects: the dialog lists only what still needs the member (AC 19).
    fails_when: an answered question or a closed track is listed, or an open one is
    missing.
    no_claim: findings and blocker options (their reports and blockers are not seeded
    here; their open statuses share the same filter table)."""
    from oracle.docs.models import Document
    from oracle.roadmap.models import ProductTrack
    from oracle.v2.models import StakeholderQuestion

    ctx = await setup(client)
    pm = await person(ctx.tenant_id, "commenter", "pm")
    async with tenant_session(ctx.tenant_id) as s:
        doc_id = await s.scalar(select(Document.id).where(Document.slug == DOC))
        q = StakeholderQuestion(
            document_id=doc_id, category="general", prompt="Which market first?",
            asked_to=pm.user_id, status="answered",
        )  # fmt: skip
        track = ProductTrack(
            prd_document_id=doc_id, title="Checkout", owner_id=pm.user_id, status="closed"
        )
        s.add_all([q, track])
        await s.commit()
        q_id, track_id = q.id, track.id
    assert await _responsibilities(client, ctx, pm.user_id) == {}

    async with tenant_session(ctx.tenant_id) as s:
        (await s.get(StakeholderQuestion, q_id)).status = "asked"
        (await s.get(ProductTrack, track_id)).status = "paused"
        await s.commit()
    held = await _responsibilities(client, ctx, pm.user_id)
    assert held["questions"]["items"] == [
        {"ref": f"question:{q_id}", "title": "Which market first?"}
    ]
    assert held["open_items"]["items"] == [
        {"ref": f"product_track:{track_id}", "title": "Checkout"}
    ]
    assert held["open_items"]["needs_role"] == "viewer"
