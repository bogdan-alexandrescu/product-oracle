"""H11 Autonomy: how far Oracle may go per responsibility (observe, draft, recommend, act
within limits). The registry, its validation, GET / PUT /v1/autonomy, the check every
behaviour calls, and the "Oracle did" Inbox rows of :func:`oracle.autonomy.acted`.

Each test's docstring is its card: protects=...; fails_when=...; no_claim=..."""

import uuid

import pytest
from pydantic import BaseModel
from sqlalchemy import select

from oracle import autonomy
from oracle.autonomy_models import OracleAction
from oracle.models import AuditEvent
from oracle.tenancy import tenant_session
from tests.conftest import make_tenant
from tests.connection_helpers import make_person
from tests.test_mcp import mcp_client, run_token, text_of

KEYS = (
    "baseline",
    "feedback_triage",
    "next_drafts",
    "requests",
    "questions",
    "goals",
    "priorities",
    "roadmap_watch",
    "decisions",
    "rituals",
    "outcomes",
    "launches",
    "strategy",
    "vision",
    "external_messages",
)
CEILINGS = {
    "baseline": "act",
    "feedback_triage": "recommend",
    "next_drafts": "act",
    "requests": "act",
    "questions": "act",
    "goals": "recommend",
    "priorities": "act",
    "roadmap_watch": "recommend",
    "decisions": "act",
    "rituals": "act",
    "outcomes": "act",
    "launches": "act",
    "strategy": "recommend",
    "vision": "draft",
    "external_messages": "draft",
}
DEFAULTS = {
    "baseline": "act",
    "feedback_triage": "recommend",
    "next_drafts": "draft",
    "requests": "recommend",
    "questions": "recommend",
    "goals": "recommend",
    "priorities": "recommend",
    "roadmap_watch": "observe",
    "decisions": "recommend",
    "rituals": "draft",
    "outcomes": "recommend",
    "launches": "draft",
    "strategy": "recommend",
    "vision": "draft",
    "external_messages": "draft",
}
STAYS_WITH_PEOPLE = [
    "Hiring, coaching and performance",
    "Pricing",
    "Hard-to-reverse decisions",
    "Date commitments",
    "What is said to the board and investors",
    "The vision itself",
]


@pytest.fixture
def local_runtime():
    from oracle.swarm import FakeRuntime, set_runtime

    set_runtime(FakeRuntime())
    yield
    set_runtime(None)


@pytest.fixture
async def owner(tenant_id):
    return await make_person(tenant_id, "owner@example.com", "owner")


async def put(client, person, key: str, **body):
    return await client.put(f"/v1/autonomy/{key}", json=body, headers=person.headers)


# --- the registry ------------------------------------------------------------------------


def test_the_registry_lists_fifteen_responsibilities_with_their_ceilings_and_defaults():
    """protects=the 15 responsibilities, their fixed ceilings and defaults (today's
    behaviour); fails_when=a key, ceiling or default differs from the spec;
    no_claim=that the behaviours behind them exist."""
    assert tuple(autonomy.REGISTRY) == KEYS
    assert {k: r.ceiling for k, r in autonomy.REGISTRY.items()} == CEILINGS
    assert {k: r.default for k, r in autonomy.REGISTRY.items()} == DEFAULTS
    assert autonomy.ORDER == ("observe", "draft", "recommend", "act")
    assert list(autonomy.STAYS_WITH_PEOPLE) == STAYS_WITH_PEOPLE


def test_every_default_is_at_or_below_its_ceiling_and_new_work_never_starts_at_act():
    """protects=defaults sit at or under the ceiling, and only the baseline (today's
    behaviour) starts at act; fails_when=a default is above its ceiling or new work
    defaults to act; no_claim=that the ceilings are the right ones."""
    rank = autonomy.ORDER.index
    for r in autonomy.REGISTRY.values():
        assert rank(r.default) <= rank(r.ceiling), r.key
    assert [k for k, r in autonomy.REGISTRY.items() if r.default == "act"] == ["baseline"]


def test_every_allowed_level_has_one_sentence_and_none_above_the_ceiling():
    """protects=each responsibility says what Oracle does at each level it allows, and
    nothing above its ceiling; fails_when=a level is missing a sentence or a locked level
    has one; no_claim=that the sentences read well."""
    rank = autonomy.ORDER.index
    for r in autonomy.REGISTRY.values():
        allowed = [lv for lv in autonomy.ORDER if rank(lv) <= rank(r.ceiling)]
        assert list(r.levels) == allowed, r.key
        assert all(s.strip() and s.endswith(".") for s in r.levels.values()), r.key
        assert r.title and r.wired_by and r.group in autonomy.GROUPS
    assert autonomy.REGISTRY["baseline"].levels["recommend"] == (
        "Agents propose every change; a person accepts each one."
    )


def test_limits_models_exist_for_act_and_validate_their_defaults():
    """protects=every responsibility that can act has a validated limits model whose
    defaults pass, and one that cannot act has none; fails_when=an act responsibility
    lacks limits, or a default is out of its own range; no_claim=the ranges themselves
    (covered by the validation tests)."""
    for r in autonomy.REGISTRY.values():
        if r.ceiling == "act":
            assert r.limits is not None and issubclass(r.limits, BaseModel), r.key
            r.limits()  # the defaults validate
        else:
            assert r.limits is None, r.key
    p = autonomy.REGISTRY["priorities"].limits()
    assert p.model_dump() == {"within_goal": True, "max_rank_move": 3}
    d = autonomy.REGISTRY["decisions"].limits()
    assert d.model_dump() == {
        "reversible_only": True,
        "origins": ["manual", "oracle"],
        "max_cost_usd": 0,
    }


def test_validation_refuses_a_level_above_the_ceiling():
    """protects=an owner cannot raise a level past the fixed ceiling;
    fails_when=vision accepts recommend or the message does not name the ceiling;
    no_claim=the HTTP status (the API tests)."""
    with pytest.raises(autonomy.AutonomyError) as e:
        autonomy.validate_change("vision", "recommend", None, {})
    assert str(e.value) == "Draft is the highest level for Draft the vision"
    with pytest.raises(autonomy.AutonomyError) as e:
        autonomy.validate_change("feedback_triage", "act", None, {})
    assert str(e.value) == "Recommend is the highest level for Triage review feedback"
    assert autonomy.validate_change("vision", "observe", None, {}) == {"level": "observe"}


def test_validation_names_a_bad_limit():
    """protects=limits are checked against the responsibility's model;
    fails_when=max_rank_move 9 or an unknown limit is accepted, or the message does not
    name the limit; no_claim=the UI's limits editor."""
    with pytest.raises(autonomy.AutonomyError) as e:
        autonomy.validate_change("priorities", "act", {"max_rank_move": 9}, {})
    assert "max_rank_move" in str(e.value)
    with pytest.raises(autonomy.AutonomyError) as e:
        autonomy.validate_change("priorities", "act", {"places": 2}, {})
    assert "places" in str(e.value)
    with pytest.raises(autonomy.AutonomyError) as e:
        autonomy.validate_change("vision", "draft", {"anything": 1}, {})
    assert "has no limits" in str(e.value)
    ok = autonomy.validate_change("priorities", "act", {"max_rank_move": 2}, {})
    assert ok == {"level": "act", "limits": {"max_rank_move": 2}}


def test_validation_refuses_changing_a_fixed_limit():
    """protects=fixed limits (within_goal, unlocked_only, reversible_only...) cannot be
    changed; fails_when=within_goal false is accepted, or restating the fixed value is
    refused; no_claim=what the behaviours do with the limits."""
    with pytest.raises(autonomy.AutonomyError) as e:
        autonomy.validate_change("priorities", "act", {"within_goal": False}, {})
    assert str(e.value) == "This limit is fixed: within_goal"
    with pytest.raises(autonomy.AutonomyError):
        autonomy.validate_change("baseline", "act", {"unlocked_only": False}, {})
    # Restating a fixed limit's value is no change.
    ok = autonomy.validate_change(
        "priorities", "act", {"within_goal": True, "max_rank_move": 4}, {}
    )
    assert ok == {"level": "act", "limits": {"max_rank_move": 4}}


def test_validation_refuses_unknown_keys_and_keeps_earlier_limits():
    """protects=only registry keys are stored, and a level change without limits keeps
    the limits set before; fails_when=an unknown key is accepted or earlier limits are
    lost; no_claim=concurrency of two owners saving at once."""
    with pytest.raises(autonomy.UnknownResponsibility):
        autonomy.validate_change("hiring", "observe", None, {})
    before = {"level": "act", "limits": {"max_rank_move": 2}}
    assert autonomy.validate_change("priorities", "recommend", None, before) == {
        "level": "recommend",
        "limits": {"max_rank_move": 2},
    }


# --- GET / PUT /v1/autonomy ----------------------------------------------------------------


async def test_get_returns_every_default_and_a_viewer_can_read_it(client, tenant_id):
    """protects=acceptance 1: with nothing stored, 15 items at their defaults and the six
    things that stay with people, readable by a viewer; fails_when=a default differs, an
    item is missing, or a viewer is refused; no_claim=the Settings screen."""
    viewer = await make_person(tenant_id, "viewer@example.com", "viewer")
    resp = await client.get("/v1/autonomy", headers=viewer.headers)
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert [i["key"] for i in body["items"]] == list(KEYS)
    assert {i["key"]: i["level"] for i in body["items"]} == DEFAULTS
    assert {i["key"]: i["default"] for i in body["items"]} == DEFAULTS
    assert body["stays_with_people"] == STAYS_WITH_PEOPLE
    assert body["updated_at"] is None and body["updated_by"] is None
    by = {i["key"]: i for i in body["items"]}
    assert by["vision"]["allowed"] == ["observe", "draft"]
    assert by["priorities"]["allowed"] == ["observe", "draft", "recommend", "act"]
    assert by["priorities"]["limits"] == {"within_goal": True, "max_rank_move": 3}
    assert by["priorities"]["fixed_limits"] == ["within_goal"]
    assert by["priorities"]["limits_summary"] == "within one goal, up to 3 places"
    assert "max_rank_move" in by["priorities"]["limits_schema"]["properties"]
    assert by["priorities"]["wired"] is False and by["priorities"]["wired_by"] == "C9"
    assert by["priorities"]["wired_by_name"] == "C9 Priorities move and pin"
    assert by["baseline"]["wired"] is True and by["feedback_triage"]["wired"] is True
    assert by["vision"]["limits"] is None and by["vision"]["limits_schema"] is None
    assert by["vision"]["ceiling_reason"]
    assert (await client.get("/v1/autonomy")).status_code == 401


async def test_put_refuses_levels_above_the_ceiling_bad_limits_and_no_reason(client, owner):
    """protects=acceptance 2: 422 above the ceiling, for a bad limit (named), for a
    changed fixed limit and without a reason, and nothing is stored;
    fails_when=any of them saves or answers anything but 422 with that message;
    no_claim=the screen's sheet."""
    r = await put(client, owner, "vision", level="recommend", reason="More help")
    assert r.status_code == 422
    assert r.json()["detail"] == "Draft is the highest level for Draft the vision"
    r = await put(client, owner, "priorities", level="act", limits={"max_rank_move": 9}, reason="x")
    assert r.status_code == 422 and "max_rank_move" in r.json()["detail"]
    r = await put(
        client, owner, "priorities", level="act", limits={"within_goal": False}, reason="x"
    )
    assert r.status_code == 422 and "This limit is fixed" in r.json()["detail"]
    r = await put(client, owner, "priorities", level="act")
    assert r.status_code == 422
    r = await put(client, owner, "priorities", level="act", reason="   ")
    assert r.status_code == 422
    r = await put(client, owner, "nope", level="act", reason="x")
    assert r.status_code == 404
    got = (await client.get("/v1/autonomy", headers=owner.headers)).json()
    assert {i["key"]: i["level"] for i in got["items"]} == DEFAULTS


async def test_only_an_owner_changes_a_level(client, tenant_id):
    """protects=acceptance 2: approvers and below get 403 on PUT; fails_when=an approver
    can change a level; no_claim=the screen hiding the controls."""
    for role in ("approver", "commenter", "viewer"):
        person = await make_person(tenant_id, f"{role}@example.com", role)
        r = await put(client, person, "priorities", level="act", reason="Small moves")
        assert r.status_code == 403, role


async def test_a_valid_put_is_audited_and_read_on_the_next_call(client, tenant_id, owner):
    """protects=acceptance 3: a change records autonomy.changed with before, after and
    the reason, and the check reads it on the next call; fails_when=no audit event, a
    missing before/after/reason, or level() still returns the old level;
    no_claim=the H1 decision capture (H1 Decision log is not on main)."""
    r = await put(
        client,
        owner,
        "priorities",
        level="act",
        limits={"max_rank_move": 2},
        reason="Small moves are fine",
    )
    assert r.status_code == 200, r.text
    item = r.json()
    assert item["level"] == "act" and item["limits"]["max_rank_move"] == 2
    assert item["limits_summary"] == "within one goal, up to 2 places"
    async with tenant_session(tenant_id) as s:
        assert await autonomy.level(s, "priorities") == "act"
        assert await autonomy.allows(s, "priorities", "recommend")
        assert (await autonomy.limits(s, "priorities")).max_rank_move == 2
        [event] = (
            await s.scalars(select(AuditEvent).where(AuditEvent.action == "autonomy.changed"))
        ).all()
    assert event.actor == f"user:{owner.user.id}"
    assert event.data == {
        "key": "priorities",
        "before": {"level": "recommend", "limits": {"within_goal": True, "max_rank_move": 3}},
        "after": {"level": "act", "limits": {"within_goal": True, "max_rank_move": 2}},
        "reason": "Small moves are fine",
    }
    got = (await client.get("/v1/autonomy", headers=owner.headers)).json()
    assert got["updated_by"] == str(owner.user.id) and got["updated_at"]

    # Back down, limits kept; the next call follows at once.
    r = await put(client, owner, "priorities", level="observe", reason="Pause it")
    assert r.json()["limits"]["max_rank_move"] == 2
    async with tenant_session(tenant_id) as s:
        assert await autonomy.level(s, "priorities") == "observe"
        assert not await autonomy.allows(s, "priorities", "draft")


async def test_the_settings_route_only_resets_autonomy(client, tenant_id, owner):
    """protects=the autonomy setting is written only through /v1/autonomy (every change
    has a reason), while PUT /v1/settings/autonomy {value: null} still resets to the
    defaults (the fast rollback); fails_when=a raw value is stored through the settings
    route, or the reset leaves a level; no_claim=older code ignoring the key."""
    r = await client.put(
        "/v1/settings/autonomy",
        json={"value": {"vision": {"level": "act"}}},
        headers=owner.headers,
    )
    assert r.status_code == 422 and "/v1/autonomy" in r.json()["detail"]
    await put(client, owner, "baseline", level="recommend", reason="Ask first")
    r = await client.put("/v1/settings/autonomy", json={"value": None}, headers=owner.headers)
    assert r.status_code == 200 and r.json()["value"] == {}
    async with tenant_session(tenant_id) as s:
        assert await autonomy.level(s, "baseline") == "act"


async def test_a_run_token_reads_get_autonomy_and_cannot_change_it(
    client, tenant_id, owner, local_runtime
):
    """protects=acceptance 8: a run token with read:baseline sees and calls get_autonomy,
    and cannot change a level; fails_when=the tool is missing or the change goes through;
    no_claim=that agents follow it (the server enforces the baseline itself)."""
    token = await run_token(tenant_id, ["read:baseline"], owner.user.id)
    async with mcp_client(token) as c:
        names = {t.name for t in (await c.list_tools()).tools}
        assert "get_autonomy" in names and "set_autonomy" not in names
        got = await c.call_tool("get_autonomy", {})
        assert not got.is_error, text_of(got)
        assert len(got.structured_content["items"]) == 15
        refused = await c.call_tool(
            "set_autonomy",
            {"key": "baseline", "body": {"level": "observe", "reason": "x"}},
        )
        assert refused.is_error
    async with tenant_session(tenant_id) as s:
        assert await autonomy.level(s, "baseline") == "act"


async def test_each_company_reads_only_its_own_levels(client):
    """protects=acceptance 9: two companies with different levels each get their own;
    fails_when=one company's change shows in the other's GET or check;
    no_claim=row-level security beyond the tenancy layer."""
    a, b = await make_tenant("A Co"), await make_tenant("B Co")
    owner_a = await make_person(a, "owner-a@example.com", "owner")
    owner_b = await make_person(b, "owner-b@example.com", "owner")
    assert (await put(client, owner_a, "baseline", level="observe", reason="a")).is_success
    assert (await put(client, owner_b, "baseline", level="recommend", reason="b")).is_success
    for person, want in ((owner_a, "observe"), (owner_b, "recommend")):
        got = (await client.get("/v1/autonomy", headers=person.headers)).json()
        assert next(i for i in got["items"] if i["key"] == "baseline")["level"] == want
    async with tenant_session(a) as s:
        assert await autonomy.level(s, "baseline") == "observe"
    async with tenant_session(b) as s:
        assert await autonomy.level(s, "baseline") == "recommend"


# --- "Oracle did" ----------------------------------------------------------------------------


async def _acted(tenant_id, notify, undo=None) -> uuid.UUID:
    async with tenant_session(tenant_id) as s:
        action = await autonomy.acted(
            s,
            "priorities",
            summary="Moved 'Saved addresses' up 2 within Raise activation",
            subject={"kind": "feature", "key": "saved-addresses"},
            undo=undo,
            notify=notify,
        )
        await s.commit()
        return action.id


async def _inbox(client, person) -> dict:
    resp = await client.get("/v1/inbox", headers=person.headers)
    assert resp.status_code == 200, resp.text
    return resp.json()


async def test_acted_writes_one_row_and_a_counted_inbox_row_per_person(client, tenant_id, owner):
    """protects=acceptance 7: acted() writes one oracle_actions row, an audit event by
    'oracle', and a counted Inbox row for each notified person only;
    fails_when=a second row, a missing audit event, a row for someone not notified, or
    an uncounted row; no_claim=any behaviour calling acted (those picks are later)."""
    approver = await make_person(tenant_id, "approver@example.com", "approver")
    other = await make_person(tenant_id, "other@example.com", "owner")
    before = (await _inbox(client, owner))["total"]
    action_id = await _acted(tenant_id, [owner.user.id, approver.user.id])
    async with tenant_session(tenant_id) as s:
        rows = (await s.scalars(select(OracleAction))).all()
        event = await s.get(AuditEvent, rows[0].audit_event_id)
    assert [r.id for r in rows] == [action_id]
    assert event.actor == "oracle" and event.action == "autonomy.acted"
    assert event.data["responsibility"] == "priorities"
    for person in (owner, approver):
        inbox = await _inbox(client, person)
        [row] = inbox["oracle_actions"]
        assert row["summary"] == "Moved 'Saved addresses' up 2 within Raise activation"
        assert row["responsibility"] == "priorities"
        assert row["responsibility_title"] == "Order priorities"
        assert row["state"] == "open" and row["counts"] is True and row["undo"] is None
    assert (await _inbox(client, owner))["total"] == before + 1
    assert (await _inbox(client, other))["oracle_actions"] == []


async def test_opening_marks_it_done_for_that_person_only(client, tenant_id, owner):
    """protects=acceptance 7: opening an 'Oracle did' row marks it done (uncounted) for
    the opener and survives a reload, while the other person's row stays open;
    fails_when=the badge does not drop, it reopens on reload, or it closes for everyone;
    no_claim=the Inbox screen (Playwright)."""
    approver = await make_person(tenant_id, "approver@example.com", "approver")
    outsider = await make_person(tenant_id, "outsider@example.com", "owner")
    action_id = await _acted(tenant_id, [owner.user.id, approver.user.id])
    total = (await _inbox(client, owner))["total"]
    r = await client.post(f"/v1/oracle-actions/{action_id}/open", headers=owner.headers)
    assert r.status_code == 200 and r.json()["state"] == "done"
    mine = await _inbox(client, owner)
    assert mine["total"] == total - 1
    assert mine["oracle_actions"][0]["state"] == "done"
    assert mine["oracle_actions"][0]["counts"] is False
    assert (await _inbox(client, approver))["oracle_actions"][0]["state"] == "open"
    # Someone it was not for cannot open it.
    r = await client.post(f"/v1/oracle-actions/{action_id}/open", headers=outsider.headers)
    assert r.status_code == 404


async def test_undo_calls_the_stored_route_and_records_undone_by(client, tenant_id, owner):
    """protects=acceptance 7: Undo calls the stored route as the person who clicked it
    and records undone_by; a second undo is refused; fails_when=the route is not called,
    undone_by is missing, or it can be undone twice; no_claim=undo routes of the picks
    that act (each supplies its own)."""
    await put(client, owner, "priorities", level="act", reason="Small moves")
    undo = {
        "method": "PUT",
        "path": "/v1/autonomy/priorities",
        "body": {"level": "recommend", "reason": "Undo of an Oracle action"},
    }
    action_id = await _acted(tenant_id, [owner.user.id], undo=undo)
    row = (await _inbox(client, owner))["oracle_actions"][0]
    assert row["undo"] == undo
    r = await client.post(f"/v1/oracle-actions/{action_id}/undo", headers=owner.headers)
    assert r.status_code == 200, r.text
    assert r.json()["state"] == "done" and r.json()["undone_at"]
    async with tenant_session(tenant_id) as s:
        assert await autonomy.level(s, "priorities") == "recommend"
        action = await s.get(OracleAction, action_id)
        assert action.undone_by == owner.user.id and action.undone_at is not None
    r = await client.post(f"/v1/oracle-actions/{action_id}/undo", headers=owner.headers)
    assert r.status_code == 409


async def test_a_refused_undo_is_not_recorded(client, tenant_id, owner):
    """protects=an undo whose route refuses the caller leaves the action not undone;
    fails_when=undone_by is set though nothing was undone; no_claim=retries."""
    approver = await make_person(tenant_id, "approver@example.com", "approver")
    undo = {
        "method": "PUT",
        "path": "/v1/autonomy/priorities",
        "body": {"level": "recommend", "reason": "Undo"},
    }
    action_id = await _acted(tenant_id, [approver.user.id], undo=undo)
    r = await client.post(f"/v1/oracle-actions/{action_id}/undo", headers=approver.headers)
    assert r.status_code == 403
    async with tenant_session(tenant_id) as s:
        assert (await s.get(OracleAction, action_id)).undone_by is None
