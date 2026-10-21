"""C1 Requests, lane 1 (API): every feature request in one queue, classified, merged,
linked to goals and qualified with a reason.

Each test's card is one line: protects / fails_when / no_claim. Synthetic placeholders
only.
"""

import uuid
from datetime import UTC, datetime

import pytest
from sqlalchemy import select, update

from oracle.models import AuditEvent
from oracle.requests import service as requests_service
from oracle.requests.models import ProductRequest
from oracle.runs.models import Run
from oracle.runtokens import mint_run_token
from oracle.sources.models import SourceItem
from oracle.tenancy import tenant_session
from tests.baseline_helpers import Ctx, confirm, entity, make_ctx, make_item
from tests.test_mcp import mcp_client, text_of


async def goal(client, ctx: Ctx, key: str = "activation", *, confirmed: bool = True) -> dict:
    ent = await entity(client, ctx, type="goal", key=key)
    if confirmed and ent["status"] != "confirmed":
        ent = (await confirm(client, ctx, ent))["entity"]
    return ent


async def add(client, ctx: Ctx, who: str = "commenter", expect: int = 201, **body) -> dict:
    body.setdefault("title", "Keep the delivery address between orders")
    body.setdefault("body", "Asked on two calls")
    body.setdefault("channel", "sales")
    resp = await client.post("/v1/requests", json=body, headers=ctx.as_(who))
    assert resp.status_code == expect, resp.text
    return resp.json()


async def get(client, ctx: Ctx, rid: str, who: str = "viewer") -> dict:
    resp = await client.get(f"/v1/requests/{rid}", headers=ctx.as_(who))
    assert resp.status_code == 200, resp.text
    return resp.json()


async def act(client, ctx: Ctx, rid: str, verb: str, who: str = "approver", **body):
    if "lock_version" not in body:
        body["lock_version"] = (await get(client, ctx, rid))["lock_version"]
    return await client.post(f"/v1/requests/{rid}/{verb}", json=body, headers=ctx.as_(who))


async def audits(ctx: Ctx, action: str) -> list[AuditEvent]:
    async with tenant_session(ctx.tenant_id) as s:
        return list(await s.scalars(select(AuditEvent).where(AuditEvent.action == action)))


async def suggest(ctx: Ctx, rid: str, **suggestion) -> None:
    """Writes a suggestion as the triage run's applier will (lane 3): data only."""
    suggestion.setdefault("confidence", 0.72)
    suggestion.setdefault("rationale", "Same need: retyping the address at every order")
    suggestion.setdefault("at", datetime.now(UTC).isoformat())
    async with tenant_session(ctx.tenant_id) as s:
        await s.execute(
            update(ProductRequest)
            .where(ProductRequest.id == uuid.UUID(rid))
            .values(suggestion=suggestion)
        )
        await s.commit()


@pytest.fixture
async def ctx() -> Ctx:
    return await make_ctx()


# --- adding and reading -------------------------------------------------------------


async def test_commenter_adds_a_new_request_and_viewer_cannot(client, ctx):
    """protects=rule 1 (commenter+ adds, viewers read); fails_when=a viewer adds one or a
    commenter's request is not New with its filer; no_claim=the Add request dialog."""
    out = await add(client, ctx, requester_name="A buyer at a retail customer",
                    requester_kind="customer")
    assert out["state"] == "new"
    assert out["origin"] == "person"
    assert out["verified"] is True
    assert out["mentions"] == 1
    assert out["filed_by"] == str(ctx.users["commenter"].id)
    assert out["requester_kind"] == "customer"
    assert out["source"] is None and out["theme"] is None and out["document"] is None
    assert out["suggestion"] is None
    assert out["lock_version"] == 1
    await add(client, ctx, who="viewer", expect=403)
    assert len(await audits(ctx, "request.created")) == 1

    got = await get(client, ctx, out["id"], who="viewer")
    assert got["merged"] == [] and got["title"] == out["title"]


async def test_add_refuses_interview_channel_and_bad_links(client, ctx):
    """protects=rule 10 and the 422s on unknown goal/theme; fails_when=a person files an
    Interview request or links an unconfirmed goal; no_claim=pick C3 Interviews."""
    resp = await client.post(
        "/v1/requests",
        json={"title": "Faster export", "channel": "interview"},
        headers=ctx.as_("commenter"),
    )
    assert resp.status_code == 422
    assert resp.json()["detail"] == "Interview requests come from interviews"

    proposed = await goal(client, ctx, "retention", confirmed=False)
    if proposed["status"] != "confirmed":
        resp = await client.post(
            "/v1/requests",
            json={"title": "x", "channel": "support", "goal_ids": [proposed["id"]]},
            headers=ctx.as_("commenter"),
        )
        assert resp.status_code == 422
    for field in ("goal_ids", "theme_id"):
        value = [str(uuid.uuid4())] if field == "goal_ids" else str(uuid.uuid4())
        resp = await client.post(
            "/v1/requests",
            json={"title": "x", "channel": "support", field: value},
            headers=ctx.as_("commenter"),
        )
        assert resp.status_code == 422, field
    resp = await client.post(
        "/v1/requests", json={"title": "x" * 201, "channel": "support"},
        headers=ctx.as_("commenter"),
    )
    assert resp.status_code == 422


async def test_list_counts_match_rows_for_a_seeded_company(client, ctx):
    """protects=criterion 2 (tab counts and channel facets); fails_when=a count disagrees
    with the rows per state or per channel; no_claim=the facets' layout."""
    g = await goal(client, ctx)
    channels = ["support"] * 5 + ["sales"] * 4 + ["slack"] * 2 + ["meeting"]
    rows = [await add(client, ctx, title=f"Request {i}", channel=c) for i, c in enumerate(channels)]
    for r in rows[:4]:
        assert (await act(client, ctx, r["id"], "qualify", goal_ids=[g["id"]])).status_code == 200
    for r in rows[4:6]:
        assert (await act(client, ctx, r["id"], "merge", into_id=rows[0]["id"])).status_code == 200
    resp = await act(client, ctx, rows[6]["id"], "disqualify", reason="out_of_scope")
    assert resp.status_code == 200

    resp = await client.get("/v1/requests", headers=ctx.as_("viewer"))
    assert resp.status_code == 200
    out = resp.json()
    assert out["total"] == 12 and len(out["items"]) == 12
    assert out["counts"] == {"all": 12, "new": 5, "qualified": 4, "merged": 2, "disqualified": 1}
    assert out["by_channel"] == {"support": 5, "sales": 4, "slack": 2, "meeting": 1}
    assert out["new_this_week"] == 12

    new = (await client.get("/v1/requests?state=new", headers=ctx.as_("viewer"))).json()
    assert new["total"] == 5 and {i["state"] for i in new["items"]} == {"new"}
    # Tabs keep their counts under a state filter; the other filters narrow them.
    assert new["counts"]["all"] == 12
    sales = (await client.get("/v1/requests?channel=sales", headers=ctx.as_("viewer"))).json()
    assert sales["total"] == 4 and sales["counts"]["all"] == 4
    by_goal = (await client.get(f"/v1/requests?goal_id={g['id']}", headers=ctx.as_("viewer")))
    assert by_goal.json()["total"] == 4
    found = (await client.get("/v1/requests?q=request%2011", headers=ctx.as_("viewer"))).json()
    assert [i["title"] for i in found["items"]] == ["Request 11"]
    page = (await client.get("/v1/requests?limit=5&offset=10", headers=ctx.as_("viewer"))).json()
    assert len(page["items"]) == 2 and page["total"] == 12
    assert (await client.get("/v1/requests?limit=201", headers=ctx.as_("viewer"))).status_code == 422


# --- qualify ------------------------------------------------------------------------


async def test_qualify_needs_goal(client, ctx):
    """protects=decision F3b Sharpest pain (goal trace) at qualify; fails_when=a request
    without a confirmed goal becomes qualified; no_claim=goal confirmation itself
    (baseline routes)."""
    r = await add(client, ctx)
    resp = await act(client, ctx, r["id"], "qualify")
    assert resp.status_code == 422
    assert resp.json()["detail"] == "Link a confirmed goal first, or disqualify it as 'No goal'"
    assert (await get(client, ctx, r["id"]))["state"] == "new"

    g = await goal(client, ctx)
    resp = await act(client, ctx, r["id"], "qualify", goal_ids=[g["id"]], note="Seen twice")
    assert resp.status_code == 200, resp.text
    out = resp.json()
    assert out["state"] == "qualified"
    assert out["goal_ids"] == [g["id"]]
    assert out["decided_by"] == str(ctx.users["approver"].id)
    assert out["decided_at"] is not None
    assert out["decision_note"] == "Seen twice"
    [event] = await audits(ctx, "request.qualified")
    assert event.entity_id == uuid.UUID(r["id"])
    # Qualifying again is not a state change from qualified.
    assert (await act(client, ctx, r["id"], "qualify")).status_code == 409


async def test_qualify_refuses_a_goal_that_is_no_longer_confirmed(client, ctx):
    """protects=F3b at qualify time, not at link time; fails_when=a goal linked earlier and
    since rejected still qualifies; no_claim=how goals get rejected."""
    g = await goal(client, ctx)
    r = await add(client, ctx, goal_ids=[g["id"]])
    async with tenant_session(ctx.tenant_id) as s:
        from oracle.baseline.models import Entity

        await s.execute(
            update(Entity).where(Entity.id == uuid.UUID(g["id"])).values(status="rejected")
        )
        await s.commit()
    resp = await act(client, ctx, r["id"], "qualify")
    assert resp.status_code == 422


# --- merge --------------------------------------------------------------------------


async def test_merge_resolves_root_and_refuses_cycle(client, ctx):
    """protects=one root per merged chain; fails_when=a merge points at a merged row or
    loops; no_claim=UI unmerge."""
    a, b, c = [await add(client, ctx, title=t) for t in ("A", "B", "C")]
    assert (await act(client, ctx, b["id"], "merge", into_id=c["id"])).status_code == 200
    resp = await act(client, ctx, a["id"], "merge", into_id=b["id"])
    assert resp.status_code == 200, resp.text
    assert resp.json()["merged_into_id"] == c["id"]
    assert resp.json()["state"] == "merged"
    # A merged request keeps its own text and channel.
    assert resp.json()["title"] == "A" and resp.json()["channel"] == "sales"

    resp = await act(client, ctx, c["id"], "merge", into_id=a["id"])
    assert resp.status_code == 409
    assert (await get(client, ctx, c["id"]))["state"] == "new"
    resp = await act(client, ctx, c["id"], "merge", into_id=c["id"])
    assert resp.status_code == 409

    root = await get(client, ctx, c["id"])
    assert root["mentions"] == 3
    assert {m["id"] for m in root["merged"]} == {a["id"], b["id"]}
    assert len(await audits(ctx, "request.merged")) == 2
    # Unknown or another company's target is 404.
    resp = await act(client, ctx, c["id"], "merge", into_id=str(uuid.uuid4()))
    assert resp.status_code == 404


async def test_mentions_count_through_chains_after_reopen(client, ctx):
    """protects=mentions = 1 + every request merged in, through chains; fails_when=a
    chain's grandchild is not counted, or an unmerged one still is; no_claim=the table."""
    a, b, c = [await add(client, ctx, title=t) for t in ("A", "B", "C")]
    await act(client, ctx, a["id"], "merge", into_id=b["id"])
    # B is New (a root) when A merges into it; then B merges into C: A -> B -> C.
    await act(client, ctx, b["id"], "merge", into_id=c["id"])
    assert (await get(client, ctx, c["id"]))["mentions"] == 3
    assert (await get(client, ctx, b["id"]))["mentions"] == 2
    listed = (await client.get("/v1/requests", headers=ctx.as_("viewer"))).json()
    assert {i["title"]: i["mentions"] for i in listed["items"]} == {"A": 1, "B": 2, "C": 3}

    resp = await act(client, ctx, b["id"], "reopen")
    assert resp.status_code == 200 and resp.json()["state"] == "new"
    assert resp.json()["merged_into_id"] is None
    assert (await get(client, ctx, c["id"]))["mentions"] == 1
    assert (await get(client, ctx, b["id"]))["mentions"] == 2
    assert len(await audits(ctx, "request.reopened")) == 1


def test_merge_root_and_mentions_units():
    """protects=the pure root walk and count; fails_when=a chain resolves to a merged row,
    a loop hangs, or a descendant is missed; no_claim=the database rows."""
    parent = {"a": "b", "b": "c", "c": None, "d": None}
    assert requests_service.root_of("a", parent) == "c"
    assert requests_service.root_of("d", parent) == "d"
    with pytest.raises(requests_service.MergeCycle):
        requests_service.root_of("x", {"x": "y", "y": "x"})
    assert requests_service.mention_counts(parent) == {"a": 1, "b": 2, "c": 3, "d": 1}


# --- disqualify, reopen, conflicts ---------------------------------------------------


async def test_disqualify_reasons_and_reopen(client, ctx):
    """protects=rule 5 (reasons, Other needs a note); fails_when=Other passes without a
    note or a disqualified request keeps its reason after reopen; no_claim=the select."""
    r = await add(client, ctx)
    resp = await act(client, ctx, r["id"], "disqualify", reason="other")
    assert resp.status_code == 422
    resp = await act(client, ctx, r["id"], "disqualify", reason="other", note="   ")
    assert resp.status_code == 422
    resp = await act(client, ctx, r["id"], "disqualify", reason="maybe_later")
    assert resp.status_code == 422
    resp = await act(client, ctx, r["id"], "disqualify", reason="wont_do", note="Not this year")
    assert resp.status_code == 200, resp.text
    assert resp.json()["state"] == "disqualified"
    assert resp.json()["disqualify_reason"] == "wont_do"
    assert resp.json()["decision_note"] == "Not this year"
    assert (await act(client, ctx, r["id"], "disqualify", reason="no_goal")).status_code == 409
    assert (await act(client, ctx, r["id"], "merge", into_id=r["id"])).status_code == 409

    resp = await act(client, ctx, r["id"], "reopen")
    assert resp.status_code == 200
    out = resp.json()
    assert out["state"] == "new" and out["disqualify_reason"] is None
    assert (await act(client, ctx, r["id"], "reopen")).status_code == 409
    assert len(await audits(ctx, "request.disqualified")) == 1


async def test_stale_lock_version_changes_nothing(client, ctx):
    """protects=optimistic concurrency on every state change; fails_when=a stale write
    lands; no_claim=the UI's reload prompt."""
    g = await goal(client, ctx)
    r = await add(client, ctx, goal_ids=[g["id"]])
    other = await add(client, ctx, title="Other")
    stale = r["lock_version"] - 1
    calls = [
        ("qualify", {}),
        ("merge", {"into_id": other["id"]}),
        ("disqualify", {"reason": "no_goal"}),
        ("suggestion/accept", {"parts": ["goals"]}),
    ]
    for verb, body in calls:
        resp = await act(client, ctx, r["id"], verb, lock_version=stale, **body)
        assert resp.status_code == 409, verb
    resp = await client.patch(
        f"/v1/requests/{r['id']}", json={"lock_version": stale, "title": "New title"},
        headers=ctx.as_("commenter"),
    )
    assert resp.status_code == 409
    after = await get(client, ctx, r["id"])
    assert after["state"] == "new" and after["title"] == r["title"]
    assert after["lock_version"] == r["lock_version"]


async def test_commenter_cannot_decide(client, ctx):
    """protects=rule 2 (approvers decide); fails_when=a commenter qualifies, merges,
    disqualifies, reopens or accepts a suggestion; no_claim=which buttons the UI shows."""
    g = await goal(client, ctx)
    r = await add(client, ctx, goal_ids=[g["id"]])
    other = await add(client, ctx, title="Other")
    await suggest(ctx, r["id"], goal_ids=[g["id"]])
    for verb, body in [
        ("qualify", {}),
        ("merge", {"into_id": other["id"]}),
        ("disqualify", {"reason": "no_goal"}),
        ("reopen", {}),
        ("suggestion/accept", {"parts": ["goals"]}),
    ]:
        resp = await act(client, ctx, r["id"], verb, who="commenter", **body)
        assert resp.status_code == 403, verb
    assert (await get(client, ctx, r["id"]))["state"] == "new"


# --- patch --------------------------------------------------------------------------


async def test_patch_filer_edits_text_while_new_and_approver_sets_links(client, ctx):
    """protects=rule 6 and the approver-only links; fails_when=someone other than the
    filer edits the text, the text changes after New, or a commenter sets a goal;
    no_claim=interview requests' own filing (pick C3)."""
    g = await goal(client, ctx)
    feature = await entity(client, ctx, type="feature", key="saved-addresses")
    r = await add(client, ctx)
    url = f"/v1/requests/{r['id']}"

    resp = await client.patch(
        url, json={"lock_version": 1, "title": "Saved addresses"}, headers=ctx.as_("approver")
    )
    assert resp.status_code == 403
    resp = await client.patch(
        url, json={"lock_version": 1, "goal_ids": [g["id"]]}, headers=ctx.as_("commenter")
    )
    assert resp.status_code == 403
    resp = await client.patch(
        url, json={"lock_version": 1, "title": "Saved addresses", "body": "Two calls"},
        headers=ctx.as_("commenter"),
    )
    assert resp.status_code == 200, resp.text
    assert resp.json()["title"] == "Saved addresses" and resp.json()["lock_version"] == 2

    resp = await client.patch(
        url,
        json={"lock_version": 2, "goal_ids": [g["id"]], "feature_id": feature["id"]},
        headers=ctx.as_("approver"),
    )
    assert resp.status_code == 200, resp.text
    assert resp.json()["goal_ids"] == [g["id"]]
    assert resp.json()["feature_id"] == feature["id"]
    resp = await client.patch(
        url, json={"lock_version": 3, "feature_id": str(uuid.uuid4())},
        headers=ctx.as_("approver"),
    )
    assert resp.status_code == 422

    await act(client, ctx, r["id"], "qualify")
    resp = await client.patch(
        url, json={"lock_version": 4, "title": "Late edit"}, headers=ctx.as_("commenter")
    )
    assert resp.status_code == 409
    assert len(await audits(ctx, "request.updated")) == 2


async def test_interview_requests_keep_their_words(client, ctx):
    """protects=rule 6 (nobody edits an interview's text); fails_when=the filer edits it;
    no_claim=how interviews file them (pick C3)."""
    r = await add(client, ctx)
    async with tenant_session(ctx.tenant_id) as s:
        await s.execute(
            update(ProductRequest)
            .where(ProductRequest.id == uuid.UUID(r["id"]))
            .values(origin="interview", channel="interview", verified=False)
        )
        await s.commit()
    resp = await client.patch(
        f"/v1/requests/{r['id']}", json={"lock_version": 1, "title": "Edited"},
        headers=ctx.as_("commenter"),
    )
    assert resp.status_code == 403
    out = await get(client, ctx, r["id"])
    assert out["verified"] is False and out["title"] == r["title"]


async def test_linked_prd_shows_review_progress(client, ctx):
    """protects=rule 7 (one PRD, set by an approver) and the inspector's Linked PRD;
    fails_when=the detail lacks the PRD's version or section progress or an unknown
    document links; no_claim=Start a PRD (lane 2, pick C4)."""
    from tests.v2_helpers import seed_v2

    seeded = await seed_v2(ctx.tenant_id)
    r = await add(client, ctx)
    resp = await client.patch(
        f"/v1/requests/{r['id']}",
        json={"lock_version": 1, "document_id": str(uuid.uuid4())},
        headers=ctx.as_("approver"),
    )
    assert resp.status_code == 422
    resp = await client.patch(
        f"/v1/requests/{r['id']}",
        json={"lock_version": 1, "document_id": str(seeded.document_id)},
        headers=ctx.as_("approver"),
    )
    assert resp.status_code == 200, resp.text
    assert resp.json()["document"]["slug"] == "checkout-redesign"
    detail = await get(client, ctx, r["id"])
    doc = detail["document"]
    assert doc["id"] == str(seeded.document_id)
    assert doc["latest_version"] >= 1
    assert doc["sections"] >= 1 and 0 <= doc["reviewed_sections"] <= doc["sections"]


# --- suggestions --------------------------------------------------------------------


async def test_accept_suggestion_parts(client, ctx):
    """protects=criterion 7 and rule 8 (a suggestion changes nothing until accepted);
    fails_when=accepting goals/theme changes the state, or duplicate does not merge;
    no_claim=the triage that writes suggestions (lane 3)."""
    g = await goal(client, ctx)
    target = await add(client, ctx, title="Saved addresses")
    r = await add(client, ctx, title="Keep my address")
    await suggest(ctx, r["id"], theme_title="Faster check-out", goal_ids=[g["id"]],
                  duplicate_of=target["id"], feature_id=None)
    out = await get(client, ctx, r["id"])
    assert out["suggestion"]["theme_title"] == "Faster check-out"
    assert out["goal_ids"] == [] and out["theme"] is None

    resp = await act(client, ctx, r["id"], "suggestion/accept", parts=["goals", "theme"])
    assert resp.status_code == 200, resp.text
    out = resp.json()
    assert out["state"] == "new"
    assert out["goal_ids"] == [g["id"]]
    assert out["theme"]["title"] == "Faster check-out"
    themes = (await client.get("/v1/request-themes", headers=ctx.as_("viewer"))).json()
    assert [(t["title"], t["origin"]) for t in themes] == [("Faster check-out", "oracle")]
    assert sorted(out["suggestion"]["accepted"]) == ["goals", "theme"]

    resp = await act(client, ctx, r["id"], "suggestion/accept", parts=["feature"])
    assert resp.status_code == 422

    resp = await act(client, ctx, r["id"], "suggestion/accept", parts=["duplicate"])
    assert resp.status_code == 200, resp.text
    assert resp.json()["state"] == "merged"
    assert resp.json()["merged_into_id"] == target["id"]
    assert (await get(client, ctx, target["id"]))["mentions"] == 2
    assert len(await audits(ctx, "request.suggestion_accepted")) == 2
    # Only New requests take suggestions.
    resp = await act(client, ctx, r["id"], "suggestion/accept", parts=["goals"])
    assert resp.status_code == 409


async def test_accept_without_suggestion_is_refused(client, ctx):
    """protects=accept needs something to accept; fails_when=it changes a request with
    no suggestion; no_claim=lane 3's applier."""
    r = await add(client, ctx)
    resp = await act(client, ctx, r["id"], "suggestion/accept", parts=["goals"])
    assert resp.status_code == 422
    resp = await act(client, ctx, r["id"], "suggestion/accept", parts=[])
    assert resp.status_code == 422


# --- themes -------------------------------------------------------------------------


async def test_themes_roles_titles_and_archive(client, ctx):
    """protects=rule 2 for themes and one live theme per title; fails_when=a commenter
    creates one, two live themes share a title, or an archived one still filters;
    no_claim=the facet list's look."""
    g = await goal(client, ctx)
    body = {"title": "Faster check-out", "goal_ids": [g["id"]]}
    resp = await client.post("/v1/request-themes", json=body, headers=ctx.as_("commenter"))
    assert resp.status_code == 403
    resp = await client.post("/v1/request-themes", json=body, headers=ctx.as_("approver"))
    assert resp.status_code == 201, resp.text
    theme = resp.json()
    assert theme["origin"] == "person" and theme["goal_ids"] == [g["id"]]
    assert theme["request_count"] == 0 and theme["archived"] is False
    dup = {"title": "faster CHECK-OUT", "goal_ids": []}
    resp = await client.post("/v1/request-themes", json=dup, headers=ctx.as_("approver"))
    assert resp.status_code == 409
    resp = await client.post(
        "/v1/request-themes", json={"title": "Bad", "goal_ids": [str(uuid.uuid4())]},
        headers=ctx.as_("approver"),
    )
    assert resp.status_code == 422

    r = await add(client, ctx, theme_id=theme["id"])
    assert r["theme"] == {"id": theme["id"], "title": "Faster check-out"}
    themed = (await client.get(f"/v1/requests?theme_id={theme['id']}",
                               headers=ctx.as_("viewer"))).json()
    assert themed["total"] == 1
    await add(client, ctx, title="Unthemed")
    none = (await client.get("/v1/requests?theme_id=none", headers=ctx.as_("viewer"))).json()
    assert [i["title"] for i in none["items"]] == ["Unthemed"]
    listed = (await client.get("/v1/request-themes", headers=ctx.as_("viewer"))).json()
    assert listed[0]["request_count"] == 1

    url = f"/v1/request-themes/{theme['id']}"
    resp = await client.patch(url, json={"lock_version": 1, "archived": True},
                              headers=ctx.as_("commenter"))
    assert resp.status_code == 403
    resp = await client.patch(url, json={"lock_version": 1, "archived": True},
                              headers=ctx.as_("approver"))
    assert resp.status_code == 200 and resp.json()["archived"] is True
    assert (await client.get("/v1/request-themes", headers=ctx.as_("viewer"))).json() == []
    every = await client.get("/v1/request-themes?include_archived=true", headers=ctx.as_("viewer"))
    assert len(every.json()) == 1
    # An archived theme takes no new requests; its title is free again.
    await add(client, ctx, theme_id=theme["id"], expect=422)
    resp = await client.post("/v1/request-themes", json=dup, headers=ctx.as_("approver"))
    assert resp.status_code == 201
    resp = await client.patch(url, json={"lock_version": 1, "archived": False},
                              headers=ctx.as_("approver"))
    assert resp.status_code == 409  # stale
    resp = await client.patch(url, json={"lock_version": 2, "archived": False},
                              headers=ctx.as_("approver"))
    assert resp.status_code == 409  # its title is taken by a live theme now
    assert {e.action for e in await audits(ctx, "request_theme.created")} == {
        "request_theme.created"
    }
    assert len(await audits(ctx, "request_theme.updated")) == 1


# --- sources --------------------------------------------------------------------------


async def test_filing_from_own_item_copies_title_link_and_excerpt(client, ctx):
    """protects=rule 9 for a person's own item (shared in full: text, title, link and a
    400-character excerpt, nothing more); fails_when=another person's item is accepted,
    the excerpt is longer, or the copy goes when the item does; no_claim=candidates
    (lane 3)."""
    content = "Keep my address between orders. " * 40
    mine = await make_item(ctx, "commenter", content=content, title="#support thread")
    theirs = await make_item(ctx, "approver")
    await add(client, ctx, source_item_id=str(theirs), expect=422)

    r = await add(client, ctx, source_item_id=str(mine))
    src = r["source"]
    assert src["item_id"] == str(mine)
    assert src["title"] == "#support thread"
    assert src["url"] == "https://chat.example.com/archives/C1/p1"
    assert src["kind"] == "slack"
    assert src["removed"] is False
    assert 0 < len(src["excerpt"]) <= 400 and content.startswith(src["excerpt"].rstrip(". …"))
    [event] = await audits(ctx, "request.created")
    assert event.data["shared"] == "full" and event.data["source_item_id"] == str(mine)

    # Others read the copy, though the item itself is the filer's alone.
    seen = await get(client, ctx, r["id"], who="viewer")
    assert seen["source"] == src
    resp = await client.get(f"/v1/source-items/{mine}", headers=ctx.as_("viewer"))
    assert resp.status_code == 404

    async with tenant_session(ctx.tenant_id) as s:
        item = await s.get(SourceItem, mine)
        await s.delete(item)
        await s.commit()
    gone = (await get(client, ctx, r["id"]))["source"]
    assert gone["removed"] is True and gone["item_id"] is None
    assert gone["title"] == "#support thread" and gone["excerpt"] == src["excerpt"]


# --- run tokens -----------------------------------------------------------------------


async def _run_token(ctx: Ctx, scopes: list[str]) -> str:
    async with tenant_session(ctx.tenant_id) as s:
        run = Run(flow="baseline_to_prd", created_by=ctx.users["approver"].id)
        s.add(run)
        await s.flush()
        raw = await mint_run_token(s, run.id, scopes, ttl_seconds=600)
        await s.commit()
    return raw


@pytest.fixture
def local_runtime():
    from oracle.swarm import FakeRuntime, set_runtime

    set_runtime(FakeRuntime())
    yield
    set_runtime(None)


async def test_run_token_reads_requests_and_themes_but_never_writes(client, ctx, local_runtime):
    """protects=criterion 12 (a triage run lists requests and themes under
    read:baseline); fails_when=it is refused the reads or allowed to add a request;
    no_claim=the triage flow itself (lane 3)."""
    await add(client, ctx, title="Saved addresses")
    token = await _run_token(ctx, ["read:sources", "read:baseline"])
    async with mcp_client(token) as c:
        names = {t.name for t in (await c.list_tools()).tools}
        assert {"list_requests", "get_request", "list_request_themes"} <= names
        assert "create_request" not in names
        listed = await c.call_tool("list_requests", {})
        assert not listed.is_error, text_of(listed)
        assert listed.structured_content["total"] == 1
        themes = await c.call_tool("list_request_themes", {})
        assert not themes.is_error, text_of(themes)
        refused = await c.call_tool(
            "create_request", {"body": {"title": "From a run", "channel": "other"}}
        )
        assert refused.is_error
    async with tenant_session(ctx.tenant_id) as s:
        assert len(list(await s.scalars(select(ProductRequest)))) == 1


async def test_run_token_without_read_baseline_is_refused(ctx, local_runtime):
    """protects=the scope map; fails_when=a token with only read:documents lists
    requests; no_claim=other areas' scopes."""
    token = await _run_token(ctx, ["read:documents"])
    async with mcp_client(token) as c:
        names = {t.name for t in (await c.list_tools()).tools}
        assert "list_requests" not in names


def test_scope_map_for_requests():
    """protects=requests and themes under read:baseline, candidates under none;
    fails_when=a run token could reach a person's found items; no_claim=the routes."""
    from oracle.mcp.scopes import required_scope

    assert required_scope("GET", "/v1/requests") == "read:baseline"
    assert required_scope("GET", "/v1/requests/{request_id}") == "read:baseline"
    assert required_scope("GET", "/v1/request-themes") == "read:baseline"
    assert required_scope("GET", "/v1/request-candidates") is None
    assert required_scope("POST", "/v1/requests") is None


# --- tenancy ------------------------------------------------------------------------


async def test_another_companys_request_is_404(client, ctx):
    """protects=company scoping; fails_when=one company reads or acts on another's
    request; no_claim=the tenancy layer's own tests."""
    r = await add(client, ctx)
    other = await make_ctx("Other Co")
    resp = await client.get(f"/v1/requests/{r['id']}", headers=other.as_("owner"))
    assert resp.status_code == 404
    resp = await act(client, other, r["id"], "reopen", lock_version=1, who="owner")
    assert resp.status_code == 404
    listed = (await client.get("/v1/requests", headers=other.as_("owner"))).json()
    assert listed["total"] == 0
