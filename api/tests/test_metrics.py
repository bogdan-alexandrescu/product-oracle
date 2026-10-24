"""H5 Metrics review, lane 1: the metric catalog's API (create, edit, archive, values by
hand and by API, variances explained), roles, company isolation and the run-token read
scope. Made-up names only."""

from datetime import timedelta

import pytest

from oracle.auth.service import create_user, make_session_cookie
from oracle.config import get_settings
from oracle.tenancy import tenant_session
from tests import metrics_helpers
from tests.baseline_helpers import make_ctx
from tests.metrics_helpers import (
    LAST_WEEK,
    QUERY,
    create,
    pct_goal,
    weeks_back,
)

M = "/v1/metrics"
V = "/v1/metric-variances"


# Fixtures (assigned, so ruff does not read the test arguments as redefinitions).
clock = metrics_helpers.clock
fake_posthog = metrics_helpers.fake_posthog


@pytest.fixture
async def ctx():
    return await make_ctx()


async def _put(client, ctx, metric, week, value, who="approver"):
    return await client.put(
        f"{M}/{metric['id']}/values/{week.isoformat()}", json={"value": value},
        headers=ctx.as_(who),
    )  # fmt: skip


async def _with_variance(client, ctx, **over) -> tuple[dict, dict]:
    """A manual metric with 12 changes of +-5 on 100, then +40 last week: one variance."""
    metric = (await create(client, ctx, **over)).json()
    values = [100 + (5 if i % 2 else 0) for i in range(13)] + [140]
    for week, value in zip(weeks_back(14), values, strict=True):
        resp = await _put(client, ctx, metric, week, value)
        assert resp.status_code == 200, resp.text
    found = (await client.get(V, headers=ctx.as_("viewer"))).json()
    assert len(found) == 1, found
    return metric, found[0]


def _as(user) -> dict[str, str]:
    return {"Cookie": f"{get_settings().session_cookie_name}={make_session_cookie(user)}"}


async def _commenter(ctx, email="second.commenter@example.com"):
    async with tenant_session(ctx.tenant_id) as s:
        user = await create_user(s, email, "correct horse")
        user.role = "commenter"
        await s.commit()
    return user


# protects=create and read: an approver adds a manual metric; any member lists it with
# its owner's name (never an id alone), and get_metric returns it; fails_when=a commenter
# or viewer adds one, or owner_name is missing; no_claim=the Metrics page.
async def test_create_list_and_roles(client, ctx, clock):
    for who in ("commenter", "viewer"):
        assert (await create(client, ctx, who=who)).status_code == 403
    resp = await create(client, ctx)
    assert resp.status_code == 201, resp.text
    out = resp.json()
    assert out["status"] == "active"
    assert out["definition_version"] == 1
    assert out["owner_name"] == "Commenter"
    assert out["last_week"] is None
    listed = (await client.get(M, headers=ctx.as_("viewer"))).json()
    assert [m["id"] for m in listed] == [out["id"]]
    got = await client.get(f"{M}/{out['id']}", headers=ctx.as_("viewer"))
    assert got.status_code == 200
    assert got.json()["values"] == []


# protects=the 422s of the spec's error list; fails_when=any of them is stored;
# no_claim=the Add metric sheet's own checks.
async def test_refusals(client, ctx, clock):
    assert (await create(client, ctx, unit="furlongs/fortnight!")).status_code == 422
    assert (await create(client, ctx, kind="input")).status_code == 422
    output = (await create(client, ctx)).json()
    resp = await create(client, ctx, title="Seats", drives_metric_id=output["id"])
    assert resp.status_code == 422
    resp = await create(client, ctx, title="Invites sent", kind="input",
                        drives_metric_id=output["id"])  # fmt: skip
    assert resp.status_code == 201, resp.text
    # Inputs drive outputs only: an input driving an input (the way to a cycle) is refused.
    resp = await create(client, ctx, title="Invite clicks", kind="input",
                        drives_metric_id=resp.json()["id"])  # fmt: skip
    assert resp.status_code == 422
    assert (await create(client, ctx, title="Odd", threshold_pct=0.5)).status_code == 422
    assert (await create(client, ctx, title="Odd", threshold_pct=501)).status_code == 422
    resp = await create(client, ctx, title="Long", source="posthog", query="x" * 4001)
    assert resp.status_code == 422
    assert (await create(client, ctx, title="weekly ACTIVE teams")).status_code == 409


# protects=criterion 6 (unit): linking a teams metric to a % goal is 422 with the spec's
# message; a % metric links; fails_when=units are not compared; no_claim=goal values.
async def test_goal_link_needs_the_goals_unit(client, ctx, clock):
    goal = await pct_goal(client, ctx)
    resp = await create(client, ctx, goal_id=goal["id"])
    assert resp.status_code == 422
    assert "The metric's unit must match the goal's unit (%)" in resp.text
    resp = await create(client, ctx, unit="%", goal_id=goal["id"])
    assert resp.status_code == 201, resp.text
    assert resp.json()["goal_id"] == goal["id"]


# protects=values by hand: the metric's owner (a commenter) and approvers record a week;
# a Tuesday or a future week is 422; another commenter is 403; delete is an approver's;
# fails_when=a non-Monday or future week is stored, or a non-owner commenter records;
# no_claim=PostHog values (test_metrics_posthog.py).
async def test_values_by_hand(client, ctx, clock):
    metric = (await create(client, ctx)).json()
    resp = await _put(client, ctx, metric, LAST_WEEK, 412, who="commenter")
    assert resp.status_code == 200, resp.text
    assert resp.json()["value"] == 412
    assert resp.json()["definition_version"] == 1
    other = await _commenter(ctx)
    as_other = _as(other)
    resp = await client.put(f"{M}/{metric['id']}/values/{LAST_WEEK}", json={"value": 1},
                            headers=as_other)  # fmt: skip
    assert resp.status_code == 403
    assert (await _put(client, ctx, metric, LAST_WEEK + timedelta(days=1), 1)).status_code == 422
    assert (await _put(client, ctx, metric, LAST_WEEK + timedelta(weeks=1), 1)).status_code == 422
    got = (await client.get(f"{M}/{metric['id']}", headers=ctx.as_("viewer"))).json()
    assert got["last_week"] == {"week_start": LAST_WEEK.isoformat(), "value": 412}
    url = f"{M}/{metric['id']}/values/{LAST_WEEK}"
    assert (await client.delete(url, headers=ctx.as_("commenter"))).status_code == 403
    assert (await client.delete(url, headers=ctx.as_("approver"))).status_code == 204
    got = (await client.get(f"{M}/{metric['id']}", headers=ctx.as_("viewer"))).json()
    assert got["values"] == []


# protects=409 for a value on a PostHog metric (its values are read, never typed);
# fails_when=a person overwrites a read value; no_claim=Pull now.
async def test_no_typed_value_on_a_posthog_metric(client, ctx, clock, fake_posthog):
    from tests.metrics_helpers import connect

    assert (await connect(client, ctx)).status_code == 200
    metric = (await create(client, ctx, source="posthog", query=QUERY)).json()
    assert (await _put(client, ctx, metric, LAST_WEEK, 1)).status_code == 409


# protects=edits: a stale lock_version is 409; archive hides it from the default list and
# restore brings it back; fails_when=a stale write lands or archive deletes;
# no_claim=definition versions (test_metrics_posthog.py).
async def test_patch_archive_restore(client, ctx, clock):
    metric = (await create(client, ctx)).json()
    url = f"{M}/{metric['id']}"
    resp = await client.patch(url, json={"title": "Active teams", "lock_version": 1},
                              headers=ctx.as_("approver"))  # fmt: skip
    assert resp.status_code == 200, resp.text
    assert resp.json()["title"] == "Active teams"
    resp = await client.patch(url, json={"title": "Teams", "lock_version": 1},
                              headers=ctx.as_("approver"))  # fmt: skip
    assert resp.status_code == 409
    assert (await client.patch(url, json={"title": "Teams", "lock_version": 2},
                               headers=ctx.as_("commenter"))).status_code == 403  # fmt: skip
    resp = await client.post(f"{url}/archive", headers=ctx.as_("approver"))
    assert resp.status_code == 200 and resp.json()["status"] == "archived"
    assert (await client.get(M, headers=ctx.as_("viewer"))).json() == []
    every = (await client.get(M, params={"include_archived": "true"},
                              headers=ctx.as_("viewer"))).json()  # fmt: skip
    assert [m["id"] for m in every] == [metric["id"]]
    resp = await client.post(f"{url}/restore", headers=ctx.as_("approver"))
    assert resp.status_code == 200 and resp.json()["status"] == "active"
    assert (await client.post(f"{url}/pull", headers=ctx.as_("approver"))).status_code == 409


# protects=the variance row from values by hand: 12 small changes then +40 make one open
# Better variance with its band; MetricOut's change carries it; fails_when=no row, two
# rows, or the band is not prev +- 2 x typical; no_claim=possible causes' content.
async def test_a_jump_makes_one_open_variance(client, ctx, clock):
    metric, found = await _with_variance(client, ctx)
    assert found["metric_id"] == metric["id"]
    assert found["week_start"] == LAST_WEEK.isoformat()
    assert (found["value"], found["previous"], found["change"]) == (140, 100, 40)
    assert found["direction"] == "better"
    assert found["status"] == "open"
    assert found["band"] == {"low": 90, "high": 110}
    assert found["metric_title"] == "Weekly active teams"
    got = (await client.get(f"{M}/{metric['id']}", headers=ctx.as_("viewer"))).json()
    assert got["change"]["variance"] == "better"
    assert len(got["spark"]) == 12
    assert [v["id"] for v in got["variances"]] == [found["id"]]
    # Recording the same value again adds no second row.
    await _put(client, ctx, metric, LAST_WEEK, 140)
    assert len((await client.get(V, headers=ctx.as_("viewer"))).json()) == 1


# protects=criterion 11: the metric's owner (a commenter) explains; another commenter is
# 403; an explanation under 10 characters is 422; fails_when=a commenter who does not own
# the metric explains, or a short text is stored; no_claim=the Inbox row.
async def test_explain_roles(client, ctx, clock):
    _, var = await _with_variance(client, ctx)
    url = f"{V}/{var['id']}/explain"
    other = await _commenter(ctx)
    as_other = _as(other)
    text = "The team-invite launch doubled invites that week."
    assert (await client.post(url, json={"explanation": text}, headers=as_other)).status_code == 403
    resp = await client.post(url, json={"explanation": "short"}, headers=ctx.as_("commenter"))
    assert resp.status_code == 422
    resp = await client.post(url, json={"explanation": text}, headers=ctx.as_("commenter"))
    assert resp.status_code == 200, resp.text
    out = resp.json()
    assert (out["status"], out["explanation"]) == ("explained", text)
    assert out["explained_by_name"] == "Commenter"
    listed = (await client.get(V, params={"status": "open"}, headers=ctx.as_("viewer"))).json()
    assert listed == []


# protects=criterion 11: Don't know yet takes a day 1 to 28 days ahead (30 is 422);
# Noise is an approver's (a commenter, even the owner, is 403); fails_when=a far day is
# stored or a commenter marks noise; no_claim=the Find out Inbox row.
async def test_unknown_and_noise(client, ctx, clock):
    _, var = await _with_variance(client, ctx)
    today = clock.now.date()
    resp = await client.post(f"{V}/{var['id']}/unknown",
                             json={"find_out_by": (today + timedelta(days=30)).isoformat()},
                             headers=ctx.as_("commenter"))  # fmt: skip
    assert resp.status_code == 422
    day = (today + timedelta(days=7)).isoformat()
    resp = await client.post(f"{V}/{var['id']}/unknown", json={"find_out_by": day},
                             headers=ctx.as_("commenter"))  # fmt: skip
    assert resp.status_code == 200, resp.text
    assert (resp.json()["status"], resp.json()["find_out_by"]) == ("unknown", day)
    resp = await client.post(f"{V}/{var['id']}/noise", json={"reason": "Holiday week"},
                             headers=ctx.as_("commenter"))  # fmt: skip
    assert resp.status_code == 403
    resp = await client.post(f"{V}/{var['id']}/noise", json={"reason": "Holiday week"},
                             headers=ctx.as_("approver"))  # fmt: skip
    assert resp.status_code == 200 and resp.json()["status"] == "noise"


# protects=criterion 12: every metrics route is 404 for another company's ids;
# fails_when=any reads or changes the other company's row; no_claim=database-level
# isolation beyond the tenant session.
async def test_another_companys_ids_are_404(client, ctx, clock):
    metric, var = await _with_variance(client, ctx)
    other = await make_ctx("Other Co")
    mid, vid = metric["id"], var["id"]
    calls = [
        ("GET", f"{M}/{mid}", None),
        ("PATCH", f"{M}/{mid}", {"title": "X", "lock_version": 1}),
        ("POST", f"{M}/{mid}/archive", None),
        ("POST", f"{M}/{mid}/restore", None),
        ("POST", f"{M}/{mid}/pull", None),
        ("PUT", f"{M}/{mid}/values/{LAST_WEEK}", {"value": 1}),
        ("DELETE", f"{M}/{mid}/values/{LAST_WEEK}", None),
        ("POST", f"{V}/{vid}/explain", {"explanation": "Something happened there."}),
        ("POST", f"{V}/{vid}/unknown", {"find_out_by": "2026-10-25"}),
        ("POST", f"{V}/{vid}/noise", {"reason": "Holiday week"}),
    ]
    for method, url, json in calls:
        resp = await client.request(method, url, json=json, headers=other.as_("owner"))
        assert resp.status_code == 404, (method, url, resp.status_code)
    assert (await client.get(M, headers=other.as_("owner"))).json() == []
    assert (await client.get(V, headers=other.as_("owner"))).json() == []


# protects=criterion 12: a run token with read:baseline calls list_metrics and get_metric
# and gets 403 on every write; fails_when=a run reads nothing or writes a value;
# no_claim=people's MCP clients (they follow REST roles).
async def test_run_token_reads_but_never_writes(client, ctx, clock):
    from oracle.mcp.scopes import required_scope
    from oracle.swarm import FakeRuntime, set_runtime
    from tests.test_mcp import mcp_client, run_token, text_of

    for path in ("/v1/metrics", "/v1/metrics/{metric_id}", "/v1/metric-variances"):
        assert required_scope("GET", path) == "read:baseline"
    for method, path in (
        ("POST", "/v1/metrics"),
        ("PATCH", "/v1/metrics/{metric_id}"),
        ("PUT", "/v1/metrics/{metric_id}/values/{week_start}"),
        ("POST", "/v1/metrics/{metric_id}/pull"),
        ("POST", "/v1/metric-variances/{variance_id}/explain"),
    ):
        assert required_scope(method, path) is None
    metric, _ = await _with_variance(client, ctx)
    set_runtime(FakeRuntime())
    try:
        token = await run_token(ctx.tenant_id, ["read:baseline"], ctx.users["owner"].id)
        async with mcp_client(token) as c:
            got = await c.call_tool("list_metrics", {})
            assert not got.is_error, text_of(got)
            got = await c.call_tool("get_metric", {"metric_id": metric["id"]})
            assert not got.is_error, text_of(got)
            assert got.structured_content["id"] == metric["id"]
            refused = await c.call_tool(
                "record_metric_value",
                {"metric_id": metric["id"], "week_start": LAST_WEEK.isoformat(),
                 "body": {"value": 1}},
            )  # fmt: skip
            assert refused.is_error and "not available to run tokens" in text_of(refused)
    finally:
        set_runtime(None)


# protects=rule 2 with an owner's threshold above 10%: a metric at 20% with a short
# history going 100 -> 112 has no variance and its owner no "Explain a variance" Inbox
# row; fails_when=the fixed 10% flags it anyway; no_claim=the rule's other branches
# (test_metrics_variance.py).
async def test_an_owners_higher_threshold_flags_nothing_at_twelve_percent(client, ctx, clock):
    metric = (await create(client, ctx, threshold_pct=20)).json()
    for week, value in zip(weeks_back(4), [100, 101, 100, 112], strict=True):
        assert (await _put(client, ctx, metric, week, value)).status_code == 200
    assert (await client.get(V, headers=ctx.as_("viewer"))).json() == []
    inbox = (await client.get("/v1/inbox", headers=ctx.as_("commenter"))).json()
    assert inbox["metrics"] == []


# protects=PATCH with null for a field that cannot be empty is 422, never a 500;
# fails_when=a null title, description, unit, direction or owner reaches the service;
# no_claim=the other 422s (test_refusals).
async def test_patch_with_a_null_required_field_is_422(client, ctx, clock):
    metric = (await create(client, ctx)).json()
    for field in ("title", "description", "unit", "direction", "owner_id"):
        resp = await client.patch(f"{M}/{metric['id']}", json={field: None, "lock_version": 1},
                                  headers=ctx.as_("approver"))  # fmt: skip
        assert resp.status_code == 422, (field, resp.status_code, resp.text)
    got = (await client.get(f"{M}/{metric['id']}", headers=ctx.as_("viewer"))).json()
    assert (got["title"], got["lock_version"]) == ("Weekly active teams", 1)


# protects=an explanation is trimmed before its 10 to 1,000 characters are counted;
# fails_when=spaces pad a short text past 10 (and "short" is stored), or trailing spaces
# push a 1,000-character text over; no_claim=the words on screen.
async def test_an_explanation_is_trimmed_before_its_length_is_checked(client, ctx, clock):
    _, var = await _with_variance(client, ctx)
    url = f"{V}/{var['id']}/explain"
    padded = {"explanation": "     short      "}
    resp = await client.post(url, json=padded, headers=ctx.as_("commenter"))
    assert resp.status_code == 422, resp.text
    long = "x" * 1000
    resp = await client.post(url, json={"explanation": f"  {long}   "},
                             headers=ctx.as_("commenter"))  # fmt: skip
    assert resp.status_code == 200, resp.text
    assert resp.json()["explanation"] == long


# protects=a value recorded or deleted by hand for one week rechecks the next week's
# variance (this week is its "week before"): correcting the week before a jump removes
# the jump's open variance, restoring it brings it back, deleting it removes it again;
# fails_when=only the edited week is rechecked; no_claim=a variance a person answered
# (it stays).
async def test_a_value_by_hand_rechecks_the_next_week(client, ctx, clock):
    metric, var = await _with_variance(client, ctx)
    before = LAST_WEEK - timedelta(weeks=1)

    async def flagged() -> set[str]:
        rows = (await client.get(V, headers=ctx.as_("viewer"))).json()
        return {r["week_start"] for r in rows}

    assert (await _put(client, ctx, metric, before, 140)).status_code == 200
    assert LAST_WEEK.isoformat() not in await flagged()
    assert (await _put(client, ctx, metric, before, 100)).status_code == 200
    assert LAST_WEEK.isoformat() in await flagged()
    resp = await client.delete(f"{M}/{metric['id']}/values/{before}",
                               headers=ctx.as_("approver"))  # fmt: skip
    assert resp.status_code == 204
    assert LAST_WEEK.isoformat() not in await flagged()


# protects=the metric's owner gets their Inbox rows whatever credential they call with:
# rows match the person (user id), so a principal whose id is a token id (a token acting
# for the user) still sees them; fails_when=rows match principal.id, the token's id;
# no_claim=how each credential resolves to a principal (oracle.auth.deps).
async def test_inbox_rows_match_the_person_not_the_token(client, ctx, clock):
    import uuid

    from oracle.auth.deps import Principal
    from oracle.metrics import review

    await _with_variance(client, ctx)
    person = ctx.users["commenter"].id
    via_token = Principal(tenant_id=ctx.tenant_id, kind="token", role="commenter",
                          user_id=person, token_id=uuid.uuid4())  # fmt: skip
    assert via_token.id != person
    async with tenant_session(ctx.tenant_id) as s:
        rows = await review.inbox_rows(s, via_token)
    assert [r.reason for r in rows] == ["explain"]
