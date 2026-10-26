"""Follow-ups for #616 (the Composition screen), decided by the owner.

The inspector says when the company module policy was saved after the revision in force
(`policy_changed_at`), so the screen can show "Company policy changed"; and each module
says whether the caller may add or remove it (`can_change`), worked out from the
caller's role and the module's required_review_role.
"""

from datetime import datetime

from tests.modules.helpers import draft, import_md, seeded_ctx

SLUG = "placeholder-device"
OWNER_ONLY = "hardware.certification"


async def _doc(client, ctx):
    resp = await import_md(client, ctx.as_("approver"), SLUG, draft("oracle-default", SLUG))
    assert resp.status_code == 201, resp.text


async def _revise(client, ctx, base, reason, who="approver", **body):
    body = {"base_revision": base, "reason": reason, **body}
    return await client.post(
        f"/v1/documents/{SLUG}/composition/revisions", json=body, headers=ctx.as_(who)
    )


async def _inspect(client, ctx, who="approver"):
    resp = await client.get(f"/v1/documents/{SLUG}/composition", headers=ctx.as_(who))
    assert resp.status_code == 200, resp.text
    return resp.json()


async def _policy(client, ctx, **body):
    resp = await client.put("/v1/module-policy", json=body, headers=ctx.as_("owner"))
    assert resp.status_code == 200, resp.text
    return resp.json()


def _mods(part):
    return {m["key"]: m for m in part["modules"]}


async def test_policy_changed_at_is_set_only_after_the_revision_in_force(client):
    ctx = await seeded_ctx()
    await _doc(client, ctx)
    # A legacy document has no revision in force: nothing to flag.
    await _policy(client, ctx, optional=["risks.register"])
    assert (await _inspect(client, ctx))["policy_changed_at"] is None

    first = await _revise(client, ctx, None, "First")
    assert first.status_code == 201, first.text
    assert first.json()["policy_changed_at"] is None

    saved = await _policy(client, ctx, optional=[])
    seen = await _inspect(client, ctx, "viewer")
    assert seen["policy_changed_at"] is not None
    assert datetime.fromisoformat(seen["policy_changed_at"]) == datetime.fromisoformat(
        saved["updated_at"]
    )

    # Re-confirming applies the policy: the notice goes away.
    second = await _revise(client, ctx, 1, "Apply the new policy")
    assert second.status_code == 201, second.text
    assert second.json()["policy_changed_at"] is None
    assert (await _inspect(client, ctx))["policy_changed_at"] is None


async def test_a_working_draft_does_not_clear_policy_changed_at(client):
    ctx = await seeded_ctx()
    await _doc(client, ctx)
    assert (await _revise(client, ctx, None, "First")).status_code == 201
    await _policy(client, ctx, optional=["risks.register"])
    draft_ = await _revise(client, ctx, 1, "Thinking", status="working")
    assert draft_.status_code == 201, draft_.text
    assert draft_.json()["policy_changed_at"] is not None


async def test_can_change_follows_the_role_and_required_review_role(client):
    ctx = await seeded_ctx()
    await _doc(client, ctx)
    hardware = {"category": "hardware", "scope": {"capabilities": ["radio_hardware"]}}
    first = await _revise(client, ctx, None, "First", inputs=hardware, packs=["hardware.iot"])
    assert first.status_code == 201, first.text

    by_role = {who: _mods((await _inspect(client, ctx, who))["current"]) for who in
               ("viewer", "commenter", "approver", "owner")}  # fmt: skip
    assert by_role["approver"][OWNER_ONLY]["required_review_role"] == "owner"
    assert by_role["approver"][OWNER_ONLY]["can_change"] is False
    assert by_role["owner"][OWNER_ONLY]["can_change"] is True
    for key, m in by_role["approver"].items():
        if m["required_review_role"] == "approver":
            assert m["can_change"] is True, key
    for who in ("viewer", "commenter"):
        assert not any(m["can_change"] for m in by_role[who].values()), who


async def test_can_change_on_a_legacy_recommendation_and_a_preview(client):
    ctx = await seeded_ctx()
    await _doc(client, ctx)
    legacy = await _inspect(client, ctx, "approver")
    assert legacy["legacy"] is True
    assert all(m["can_change"] for m in legacy["recommendation"]["modules"])
    viewer = await _inspect(client, ctx, "viewer")
    assert not any(m["can_change"] for m in viewer["recommendation"]["modules"])

    resp = await client.post(
        "/v1/compositions/recommend",
        json={"document": SLUG, "packs": ["hardware.iot"], "inputs": {"category": "hardware"}},
        headers=ctx.as_("approver"),
    )
    assert resp.status_code == 200, resp.text
    mods = _mods(resp.json())
    assert mods[OWNER_ONLY]["can_change"] is False


async def test_can_change_is_not_stored_in_the_revision(client):
    ctx = await seeded_ctx()
    await _doc(client, ctx)
    # An owner confirms; an approver then reads: what the owner could do does not carry.
    assert (await _revise(client, ctx, None, "First", who="owner", packs=["hardware.iot"],
                          inputs={"category": "hardware"})).status_code == 201  # fmt: skip
    mods = _mods((await _inspect(client, ctx, "approver"))["current"])
    assert mods[OWNER_ONLY]["can_change"] is False
