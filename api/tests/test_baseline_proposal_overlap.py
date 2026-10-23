"""Proposals that would overwrite a field changed since they were written (#268)."""

import pytest

from tests.baseline_helpers import entity, make_ctx

B = "/v1/baseline"


@pytest.fixture
async def ctx():
    return await make_ctx()


async def _feature(client, ctx) -> dict:
    return await entity(client, ctx, type="feature", key="saved-carts", title="Saved carts",
                        attrs={"milestone": "M1", "effort": "M"})  # fmt: skip


async def _propose(client, ctx, feat: dict, attrs: dict) -> dict:
    resp = await client.post(
        f"{B}/proposals",
        json={
            "op": "update",
            "kind": "entity",
            "entity_id": feat["id"],
            "fields": {"attrs": attrs},
        },
        headers=ctx.as_("token"),
    )
    assert resp.status_code == 201, resp.text
    return resp.json()


async def _open(client, ctx) -> dict[str, dict]:
    resp = await client.get(f"{B}/proposals", params={"status": "open"}, headers=ctx.as_("viewer"))
    assert resp.status_code == 200, resp.text
    return {p["id"]: p for p in resp.json()}


async def _accept(client, ctx, proposal: dict, **body):
    return await client.post(
        f"{B}/proposals/{proposal['id']}/accept", json=body or None, headers=ctx.as_("approver")
    )


async def test_a_sibling_accepted_since_marks_the_overlap(client, ctx):
    """protects: an open proposal names each field another accepted proposal changed since
    it was written, with the value now and the one it proposes.
    fails_when: overlaps is missing, names an untouched field, or says it was an edit."""
    feat = await _feature(client, ctx)
    first = await _propose(client, ctx, feat, {"milestone": "M2"})
    second = await _propose(client, ctx, feat, {"milestone": "Later", "effort": "L"})
    assert (await _open(client, ctx))[second["id"]]["overlaps"] == []

    assert (await _accept(client, ctx, first)).status_code == 200
    [overlap] = (await _open(client, ctx))[second["id"]]["overlaps"]
    assert overlap["field"] == "attrs.milestone"
    assert overlap["current"] == "M2"
    assert overlap["proposed"] == "Later"
    assert overlap["by"] == "proposal"
    assert overlap["changed_at"]


async def test_a_persons_edit_since_is_a_later_edit(client, ctx):
    """protects: an edit by a person since the proposal was written counts too.
    fails_when: it is not flagged, or is named as an accepted proposal."""
    feat = await _feature(client, ctx)
    proposal = await _propose(client, ctx, feat, {"milestone": "Later"})
    resp = await client.patch(
        f"{B}/entities/{feat['id']}", json={"attrs": {"milestone": "M3"}}, headers=ctx.as_("owner")
    )
    assert resp.status_code == 200, resp.text
    [overlap] = (await _open(client, ctx))[proposal["id"]]["overlaps"]
    assert (overlap["field"], overlap["current"], overlap["by"]) == (
        "attrs.milestone",
        "M3",
        "edit",
    )


async def test_no_overlap_when_the_value_is_back_or_already_the_proposed_one(client, ctx):
    """fails_when: a field changed and changed back, or already set to the proposed value,
    is flagged."""
    feat = await _feature(client, ctx)
    proposal = await _propose(client, ctx, feat, {"milestone": "Later", "effort": "L"})
    for attrs in ({"milestone": "M3"}, {"milestone": "M1"}, {"effort": "L"}):
        resp = await client.patch(
            f"{B}/entities/{feat['id']}", json={"attrs": attrs}, headers=ctx.as_("owner")
        )
        assert resp.status_code == 200, resp.text
    assert (await _open(client, ctx))[proposal["id"]]["overlaps"] == []


async def test_accept_with_skip_fields_applies_the_rest_and_records_them(client, ctx):
    """protects: Skip <field>, apply the rest.
    fails_when: a skipped field is applied, another is not, or the decision does not
    record which fields were skipped."""
    feat = await _feature(client, ctx)
    first = await _propose(client, ctx, feat, {"milestone": "M2"})
    second = await _propose(client, ctx, feat, {"milestone": "Later", "effort": "L"})
    assert (await _accept(client, ctx, first)).status_code == 200

    resp = await _accept(client, ctx, second, skip_fields=["milestone"])
    assert resp.status_code == 200, resp.text
    decided = resp.json()
    assert decided["status"] == "accepted"
    assert decided["payload"]["skipped_fields"] == ["attrs.milestone"]
    assert decided["payload"]["fields"] == {"attrs": {"milestone": "Later", "effort": "L"}}
    got = (await client.get(f"{B}/entities/{feat['id']}", headers=ctx.as_("viewer"))).json()
    assert got["attrs"] == {"milestone": "M2", "effort": "L"}


async def test_accept_without_skip_applies_anyway(client, ctx):
    feat = await _feature(client, ctx)
    first = await _propose(client, ctx, feat, {"milestone": "M2"})
    second = await _propose(client, ctx, feat, {"milestone": "Later"})
    assert (await _accept(client, ctx, first)).status_code == 200
    resp = await _accept(client, ctx, second)
    assert resp.status_code == 200, resp.text
    assert "skipped_fields" not in resp.json()["payload"]
    got = (await client.get(f"{B}/entities/{feat['id']}", headers=ctx.as_("viewer"))).json()
    assert got["attrs"]["milestone"] == "Later"


async def test_skipping_a_field_the_proposal_does_not_change_is_refused(client, ctx):
    feat = await _feature(client, ctx)
    proposal = await _propose(client, ctx, feat, {"milestone": "Later"})
    resp = await _accept(client, ctx, proposal, skip_fields=["title"])
    assert resp.status_code == 422, resp.text
    assert (await _open(client, ctx))[proposal["id"]]["status"] == "open"
