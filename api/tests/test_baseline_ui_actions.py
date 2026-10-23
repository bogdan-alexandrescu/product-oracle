"""#337: the Baseline screen's Add item, Confirm, Reject and Archive, as the UI calls them."""

import pytest

from tests.baseline_helpers import make_ctx

B = "/v1/baseline"


@pytest.fixture
async def ctx():
    return await make_ctx()


async def _add(client, ctx, role="approver", **body):
    return await client.post(f"{B}/entities", json=body, headers=ctx.as_(role))


async def test_add_risk_then_archive_it_with_a_reason(client, ctx):
    resp = await _add(client, ctx, type="risk", key="card-fees-1a2b3c", title="Card fees rise")
    assert resp.status_code == 201, resp.text
    risk = resp.json()["entity"]
    assert risk["status"] == "confirmed" and risk["locked"] is True

    # Archive: a confirmed item is rejected, with the reason kept in its history.
    resp = await client.post(
        f"{B}/entities/{risk['id']}/reject",
        json={"note": "Fees were fixed for three years."},
        headers=ctx.as_("approver"),
    )
    assert resp.status_code == 200, resp.text
    assert resp.json()["status"] == "rejected"
    revs = await client.get(f"{B}/entities/{risk['id']}/revisions", headers=ctx.as_("viewer"))
    revs = revs.json()
    assert revs[0]["after"]["status"] == "rejected"
    assert revs[0]["reason"] == "Fees were fixed for three years."
    listed = (
        await client.get(f"{B}/entities", params={"type": "risk"}, headers=ctx.as_("viewer"))
    ).json()
    assert [e["status"] for e in listed] == ["rejected"]


async def test_add_feature_with_its_product_and_goals(client, ctx):
    product = (await _add(client, ctx, type="product", key="shop", title="Shop")).json()["entity"]
    goal = (await _add(client, ctx, type="goal", key="activation", title="Activation")).json()
    assert goal["entity"]["status"] == "proposed"  # goals start proposed
    feature = (await _add(client, ctx, type="feature", key="gift-cards", title="Gift cards")).json()
    feature = feature["entity"]
    for body in (
        {"src_id": feature["id"], "dst_id": product["id"], "type": "part_of"},
        {
            "src_id": feature["id"],
            "dst_id": goal["entity"]["id"],
            "type": "supports",
            "attrs": {"contribution": 3},
        },
    ):
        resp = await client.post(f"{B}/edges", json=body, headers=ctx.as_("approver"))
        assert resp.status_code == 201, resp.text
    detail = (await client.get(f"{B}/entities/{feature['id']}", headers=ctx.as_("viewer"))).json()
    assert sorted(e["type"] for e in detail["edges_out"]) == ["part_of", "supports"]


async def test_add_validates_as_the_form_expects(client, ctx):
    resp = await _add(client, ctx, type="risk", key="dup", title="One")
    assert resp.status_code == 201
    assert (await _add(client, ctx, type="risk", key="dup", title="Two")).status_code == 409
    assert (await _add(client, ctx, type="risk", key="Bad Key", title="X")).status_code == 422
    assert (await _add(client, ctx, type="risk", key="empty", title="")).status_code == 422


async def test_viewers_and_commenters_cannot_add_confirm_or_reject(client, ctx):
    item = (await _add(client, ctx, type="assumption", key="phones", title="Phones")).json()
    for role in ("viewer", "commenter"):
        resp = await _add(client, ctx, role, type="risk", key=f"r-{role}", title="R")
        assert resp.status_code == 403
        for action in ("confirm", "reject"):
            resp = await client.post(
                f"{B}/entities/{item['entity']['id']}/{action}", headers=ctx.as_(role)
            )
            assert resp.status_code == 403
