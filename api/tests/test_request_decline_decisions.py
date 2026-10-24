"""H10 Reasoned no, lane 1 (API): asked again through merges, Keep the no, and Reopen and
a reversed review staying in step.

Each test's card is one line: protects / fails_when / no_claim. Made-up names only.
"""

import uuid

import pytest
from sqlalchemy import select

from oracle.decisions.models import Decision, DecisionReview
from oracle.models import AuditEvent
from oracle.requests.models import RequestReply
from oracle.tenancy import tenant_session
from tests.baseline_helpers import Ctx, make_ctx
from tests.test_request_replies import act, add, get, replies, rows


@pytest.fixture
async def ctx() -> Ctx:
    return await make_ctx()


async def declined(client, ctx: Ctx, **body) -> dict:
    r = await add(client, ctx, requester_name="Ops lead at a pilot customer",
                  requester_kind="customer")  # fmt: skip
    body.setdefault("reason", "no_goal")
    resp = await act(client, ctx, r["id"], "disqualify", **body)
    assert resp.status_code == 200, resp.text
    return resp.json()


async def ask_again(client, ctx: Ctx, root: dict, n: int) -> list[dict]:
    out = []
    for i in range(n):
        new = await add(client, ctx, title=f"Export boards, again {i}",
                        requester_name=f"Asker {i}", requester_kind="customer")  # fmt: skip
        resp = await act(client, ctx, new["id"], "merge", into_id=root["id"])
        assert resp.status_code == 200, resp.text
        out.append(new)
    return out


def asked_again_rows(inbox: dict) -> list[dict]:
    return [r for r in inbox["requests"] if r["reason"] == "asked_again"]


async def test_asked_again_replies_under_the_same_decision_and_counts(client, ctx):
    """protects=criterion 5 (a merge into a logged no: the new asker's reply under the same
    decision, the root stays disqualified, asked_again counts it); fails_when=no reply, a
    new decision, or no count; no_claim=the merge picker (lane 2)."""
    root = await declined(client, ctx)
    [d] = await rows(ctx, Decision)
    [new] = await ask_again(client, ctx, root, 1)
    got = await get(client, ctx, root["id"])
    assert got["state"] == "disqualified" and got["asked_again"] == 1
    mine = [r for r in await replies(client, ctx, root["id"]) if r["request_id"] == new["id"]]
    assert len(mine) == 1 and mine[0]["decision_number"] == d.number
    assert len(await rows(ctx, Decision)) == 1


async def test_asked_again_after_a_no_without_a_note_only_counts(client, ctx):
    """protects=criterion 5 (Won't do without a note: no reply, no Inbox row, the count
    only); fails_when=a reply or row appears; no_claim=the counter's look."""
    root = await declined(client, ctx, reason="wont_do")
    await ask_again(client, ctx, root, 3)
    assert (await get(client, ctx, root["id"]))["asked_again"] == 3
    assert await rows(ctx, RequestReply) == []
    for who in ("approver", "owner"):
        inbox = (await client.get("/v1/inbox", headers=ctx.as_(who))).json()
        assert asked_again_rows(inbox) == []


async def test_at_the_threshold_the_approver_hears_and_keep_the_no_clears_it(client, ctx):
    """protects=criterion 5 (the counted row at 3 for the decision's approver; Keep the no
    records a reaffirmed review and clears the row; Reopen reopens); fails_when=the row
    shows early, for someone else, survives Keep the no, or the review is missing;
    no_claim=the threshold setting's screen."""
    root = await declined(client, ctx)
    await ask_again(client, ctx, root, 2)
    inbox = (await client.get("/v1/inbox", headers=ctx.as_("approver"))).json()
    assert asked_again_rows(inbox) == []
    await ask_again(client, ctx, root, 1)
    inbox = (await client.get("/v1/inbox", headers=ctx.as_("approver"))).json()
    [row] = asked_again_rows(inbox)
    assert row["count"] == 3 and row["counts"] is True and row["request_id"] == root["id"]
    owner_inbox = (await client.get("/v1/inbox", headers=ctx.as_("owner"))).json()
    assert asked_again_rows(owner_inbox) == []

    resp = await client.post(f"/v1/requests/{root['id']}/keep-no", json={"note": "Still no"},
                             headers=ctx.as_("owner"))  # fmt: skip
    assert resp.status_code == 403  # only the decision's approver reviews it
    resp = await client.post(f"/v1/requests/{root['id']}/keep-no", json={"note": "Still no"},
                             headers=ctx.as_("approver"))  # fmt: skip
    assert resp.status_code == 200, resp.text
    assert resp.json()["asked_again"] == 0 and resp.json()["state"] == "disqualified"
    [review] = await rows(ctx, DecisionReview)
    assert review.verdict == "reaffirmed" and review.note == "Still no"
    inbox = (await client.get("/v1/inbox", headers=ctx.as_("approver"))).json()
    assert asked_again_rows(inbox) == []

    resp = await act(client, ctx, root["id"], "reopen")
    assert resp.status_code == 200 and resp.json()["state"] == "new"


async def test_threshold_is_a_company_setting(client, ctx):
    """protects=request_asked_again_threshold (1 to 20, default 3); fails_when=it is
    ignored or takes 0; no_claim=its Settings screen."""
    resp = await client.put("/v1/settings/request_asked_again_threshold", json={"value": 0},
                            headers=ctx.as_("owner"))  # fmt: skip
    assert resp.status_code == 422
    resp = await client.put("/v1/settings/request_asked_again_threshold", json={"value": 1},
                            headers=ctx.as_("owner"))  # fmt: skip
    assert resp.status_code == 200, resp.text
    root = await declined(client, ctx)
    await ask_again(client, ctx, root, 1)
    inbox = (await client.get("/v1/inbox", headers=ctx.as_("approver"))).json()
    assert len(asked_again_rows(inbox)) == 1


async def test_reopen_reverses_the_decision_and_withdraws_drafts(client, ctx):
    """protects=criterion 6 (Reopen: the decision reversed with a review by the reopener,
    Drafted replies withdrawn; Tell the people who asked drafts reopened replies for the
    ones already told); fails_when=the decision stays decided, the review is the approver's,
    a draft survives, or a reopened reply goes to someone never told; no_claim=the panel."""
    root = await declined(client, ctx)
    [new] = await ask_again(client, ctx, root, 1)
    got = {r["request_id"]: r for r in await replies(client, ctx, root["id"])}
    resp = await client.post(f"/v1/request-replies/{got[root['id']]['id']}/sent",
                             json={"channel": "email"}, headers=ctx.as_("approver"))  # fmt: skip
    assert resp.status_code == 200, resp.text

    resp = await act(client, ctx, root["id"], "reopen", who="owner", reason="A big customer asked")
    assert resp.status_code == 200, resp.text
    assert resp.json()["decision_number"] is None and resp.json()["asked_again"] == 0
    [d] = await rows(ctx, Decision)
    assert d.status == "reversed"
    [review] = await rows(ctx, DecisionReview)
    assert review.verdict == "reversed" and review.reviewed_by == ctx.users["owner"].id
    assert review.note == "Request reopened: A big customer asked"
    statuses = {r.request_id: r.status for r in await rows(ctx, RequestReply)}
    assert statuses == {uuid.UUID(root["id"]): "sent", uuid.UUID(new["id"]): "withdrawn"}

    resp = await client.post(f"/v1/requests/{root['id']}/replies/reopened",
                             headers=ctx.as_("approver"))  # fmt: skip
    assert resp.status_code == 200, resp.text
    [told] = resp.json()
    assert told["kind"] == "reopened" and told["request_id"] == root["id"]


async def test_a_reversed_review_reopens_the_request_once(client, ctx):
    """protects=criterion 6 (a reversed review on the decision reopens the request in the
    same transaction, with no loop: one review row and one audit event each);
    fails_when=the request stays disqualified, a second review is written, or events
    repeat; no_claim=the Decisions page."""
    root = await declined(client, ctx)
    [d] = await rows(ctx, Decision)
    resp = await client.post(f"/v1/decisions/{d.id}/reviews",
                             json={"verdict": "reversed", "note": "We will build it after all"},
                             headers=ctx.as_("approver"))  # fmt: skip
    assert resp.status_code == 200, resp.text
    assert (await get(client, ctx, root["id"]))["state"] == "new"
    assert len(await rows(ctx, DecisionReview)) == 1
    async with tenant_session(ctx.tenant_id) as s:
        actions = list(await s.scalars(select(AuditEvent.action)))
    assert actions.count("decision.review_reversed") == 1
    assert actions.count("request.reopened") == 1
    [d] = await rows(ctx, Decision)
    assert d.status == "reversed"


async def test_declining_again_after_a_reopen_logs_a_new_decision(client, ctx):
    """protects=one decision per no, also after a reopen; fails_when=the second no reuses
    the reversed record or fails on the unique source; no_claim=the decision log's UI."""
    root = await declined(client, ctx)
    assert (await act(client, ctx, root["id"], "reopen")).status_code == 200
    resp = await act(client, ctx, root["id"], "disqualify", reason="out_of_scope")
    assert resp.status_code == 200, resp.text
    decisions = sorted(await rows(ctx, Decision), key=lambda d: d.number)
    assert [d.status for d in decisions] == ["reversed", "decided"]
    assert resp.json()["decision_number"] == decisions[1].number
