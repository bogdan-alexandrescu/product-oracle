"""A3 Engineering lead: a member flag for who decides the engineering stops (the check,
eng_review, and the dates, eng_dates) and who verifies dates.

Every test states its card: protects / fails_when / no_claim. Against Postgres; the run
tests use the SwarmCloud fake (tests.swarmcloud_fake). Synthetic placeholders only.
"""

import uuid
from types import SimpleNamespace

import httpx
import pytest
from sqlalchemy import select, text
from sqlalchemy.exc import IntegrityError

from oracle.auth.deps import Principal
from oracle.auth.models import User
from oracle.auth.service import create_api_token
from oracle.members.leads import ENGINEERING_KINDS, may_decide, may_verify_dates
from oracle.members.models import Invite
from oracle.models import AuditEvent
from oracle.runs.models import Checkpoint
from oracle.tenancy import tenant_session
from tests.fixtures import draft, import_draft, seed_auth
from tests.review_v2_helpers import person
from tests.test_adapter_v2 import _decide_raw, _waiting, on
from tests.test_adapter_v2 import settings as _v2_settings
from tests.test_iap import HEADER, assertion
from tests.test_iap import fetches as fetches  # the IAP settings fixture
from tests.test_runs import get, pending, tick

# The same environment as test_adapter_v2 (Oracle's public URL, default timings).
settings = _v2_settings

LEAD_ONLY = "Only an engineering lead or an owner decides the engineering stops"
VIEWER_REFUSED = "A viewer can't be the engineering lead. Make them a commenter or above first."
DATES_REFUSED = "Requires the approver role or the engineering lead"
PRD = "checkout-redesign"
_UNAVAILABLE = {"code": "unavailable", "message": "try later", "detail": {"reason": "unavailable"}}


@pytest.fixture
async def owner():
    """(tenant_id, the seeded token's headers: it acts for admin@example.com, an owner)."""
    return await seed_auth()


async def _flag(client, auth, user_id, value: bool = True) -> httpx.Response:
    return await client.patch(
        f"/v1/members/{user_id}", json={"engineering_lead": value}, headers=auth
    )


async def _events(tenant_id, action: str) -> list[dict]:
    async with tenant_session(tenant_id) as s:
        rows = await s.scalars(
            select(AuditEvent).where(AuditEvent.action == action).order_by(AuditEvent.created_at)
        )
        return [e.data for e in rows]


async def _eng_stop(client, auth, tenant_id, swarm, kind: str = "eng_review") -> dict:
    """A run waiting on a checkpoint, made an engineering stop (no flow creates one yet:
    F4 Engineering review stop adds them to Baseline to PRD)."""
    run = await _waiting(client, auth, tenant_id, swarm)
    async with tenant_session(tenant_id) as s:
        cp = await s.get(Checkpoint, uuid.UUID(pending(run)["id"]))
        cp.kind = kind
        await s.commit()
    return await get(client, auth, run["id"])


async def _inbox_ids(client, headers) -> list[str]:
    resp = await client.get("/v1/inbox", headers=headers)
    assert resp.status_code == 200, resp.text
    return [c["id"] for c in resp.json()["checkpoints"]]


# --- may_decide / may_verify_dates: the truth table -----------------------------------------

LEAD = uuid.uuid4()
WHO = {
    "owner": Principal(tenant_id=uuid.uuid4(), kind="user", role="owner", user_id=uuid.uuid4()),
    "approver": Principal(
        tenant_id=uuid.uuid4(), kind="user", role="approver", user_id=uuid.uuid4()
    ),
    "commenter": Principal(
        tenant_id=uuid.uuid4(), kind="user", role="commenter", user_id=uuid.uuid4()
    ),
    "lead_commenter": Principal(
        tenant_id=uuid.uuid4(), kind="user", role="commenter", user_id=LEAD
    ),
    "lead_approver": Principal(tenant_id=uuid.uuid4(), kind="user", role="approver", user_id=LEAD),
    # The lead through a read-only token: acts as a viewer, decides nothing.
    "lead_read_only": Principal(tenant_id=uuid.uuid4(), kind="user", role="viewer", user_id=LEAD),
    # An API token acting for no member: never a lead.
    "service_approver": Principal(
        tenant_id=uuid.uuid4(), kind="token", role="approver", token_id=uuid.uuid4()
    ),
}
BY_ROLE = {"owner", "approver", "lead_approver", "service_approver"}
LEADS_AND_OWNERS = {"owner", "lead_commenter", "lead_approver"}


@pytest.mark.parametrize(
    ("kind", "flow", "named", "allowed"),
    [
        # The engineering stops outside prd_to_spec: leads and owners once one is named.
        ("eng_review", "baseline_to_prd", True, LEADS_AND_OWNERS),
        ("eng_dates", "baseline_to_prd", True, LEADS_AND_OWNERS),
        ("eng_review", "feedback_loop", True, LEADS_AND_OWNERS),
        # None named: by role, as every other stop.
        ("eng_review", "baseline_to_prd", False, BY_ROLE),
        ("eng_dates", "baseline_to_prd", False, BY_ROLE),
        # PR #126's prd_to_spec keeps its own rule, checked by the specs service.
        ("eng_review", "prd_to_spec", True, BY_ROLE),
        ("eng_review", "prd_to_spec", False, BY_ROLE),
        # Any other kind: by role, a lead or not.
        ("baseline_confirm", "baseline_to_prd", True, BY_ROLE),
        ("prd_review", "baseline_to_prd", False, BY_ROLE),
    ],
)
def test_may_decide_truth_table(kind, flow, named, allowed):
    # protects=C2 Multiple reviewers' routing of both engineering stops; fails_when=a
    # non-lead approver decides either stop while a lead is named, nobody can when none
    # is, or #126's spec rule changes; no_claim=the flow creates the stops (F4).
    leads = frozenset({LEAD}) if named else frozenset()
    cp = SimpleNamespace(kind=kind, approver_role="approver")
    got = {who for who, p in WHO.items() if may_decide(p, cp, flow, leads)}  # type: ignore[arg-type]
    assert got == allowed
    assert set(ENGINEERING_KINDS) == {"eng_review", "eng_dates"}


@pytest.mark.parametrize(
    ("named", "allowed"),
    [
        (True, {"owner", "approver", "lead_commenter", "lead_approver", "service_approver"}),
        (False, {"owner", "approver", "lead_approver", "service_approver"}),
    ],
)
def test_may_verify_dates(named, allowed):
    # protects=leads may verify dates and approvers keep O4's right until F3 lands;
    # fails_when=a lead is refused, a plain commenter allowed, or an approver loses the
    # right; no_claim=F3's proposed state.
    leads = frozenset({LEAD}) if named else frozenset()
    assert {who for who, p in WHO.items() if may_verify_dates(p, leads)} == allowed


# --- Members: PATCH, invites, sign-in, /me, the constraint ----------------------------------


async def test_the_owner_names_a_commenter_engineering_lead(client, owner):
    # protects=AC1, an owner names a lead, audited; fails_when=the flag is not stored,
    # listed or audited; no_claim=UI.
    tenant_id, auth = owner
    lead = await person(tenant_id, "commenter", "lead")
    resp = await _flag(client, auth, lead.user_id)
    assert resp.status_code == 200, resp.text
    assert resp.json()["engineering_lead"] is True and resp.json()["role"] == "commenter"
    assert await _events(tenant_id, "member.engineering_lead") == [{"before": False, "after": True}]
    listed = (await client.get("/v1/members", headers=auth)).json()
    flags = {m["id"]: m["engineering_lead"] for m in listed}
    assert flags[str(lead.user_id)] is True
    assert sum(flags.values()) == 1
    # Naming them again changes nothing and writes no event.
    assert (await _flag(client, auth, lead.user_id)).status_code == 200
    assert len(await _events(tenant_id, "member.engineering_lead")) == 1


async def test_a_viewer_cannot_be_named(client, owner):
    # protects=AC2, never a viewer; fails_when=the flag sticks to a viewer; no_claim=UI.
    tenant_id, auth = owner
    viewer = await person(tenant_id, "viewer")
    resp = await _flag(client, auth, viewer.user_id)
    assert resp.status_code == 422, resp.text
    assert resp.json()["detail"] == VIEWER_REFUSED
    async with tenant_session(tenant_id) as s:
        assert (await s.get(User, viewer.user_id)).engineering_lead is False
    assert await _events(tenant_id, "member.engineering_lead") == []


async def test_demoting_a_lead_to_viewer_clears_the_flag(client, owner):
    # protects=AC3, a demotion to viewer clears the flag in the same change; fails_when=a
    # viewer keeps the flag or the clearing is not audited; no_claim=UI.
    tenant_id, auth = owner
    lead = await person(tenant_id, "commenter", "lead")
    assert (await _flag(client, auth, lead.user_id)).status_code == 200
    resp = await client.patch(f"/v1/members/{lead.user_id}", json={"role": "viewer"}, headers=auth)
    assert resp.status_code == 200, resp.text
    assert resp.json()["role"] == "viewer" and resp.json()["engineering_lead"] is False
    assert await _events(tenant_id, "member.role") == [{"before": "commenter", "after": "viewer"}]
    assert await _events(tenant_id, "member.engineering_lead") == [
        {"before": False, "after": True},
        {"before": True, "after": False, "reason": "role viewer"},
    ]


async def test_a_patch_needs_a_field_and_an_owner(client, owner):
    # protects=AC4; fails_when=an empty PATCH passes or a non-owner names a lead;
    # no_claim=UI.
    tenant_id, auth = owner
    lead = await person(tenant_id, "commenter", "lead")
    resp = await client.patch(f"/v1/members/{lead.user_id}", json={}, headers=auth)
    assert resp.status_code == 422, resp.text
    assert resp.json()["detail"] == "Send role, engineering_lead or both"
    approver = await person(tenant_id, "approver")
    resp = await _flag(client, approver.headers, lead.user_id)
    assert resp.status_code == 403, resp.text
    # Both at once: role first, so a viewer made commenter can be named in one change.
    viewer = await person(tenant_id, "viewer")
    resp = await client.patch(
        f"/v1/members/{viewer.user_id}",
        json={"role": "commenter", "engineering_lead": True},
        headers=auth,
    )
    assert resp.status_code == 200, resp.text
    assert resp.json()["role"] == "commenter" and resp.json()["engineering_lead"] is True


async def test_an_invite_carries_the_flag_to_the_first_sign_in(client, fetches):  # noqa: F811
    # protects=AC5, the owner names a lead before they first sign in; fails_when=a viewer
    # invite carries it, or the flag is lost on sign-in; no_claim=UI.
    tenant_id, auth = await seed_auth()
    resp = await client.post(
        "/v1/invites",
        json={"email": "x@example.com", "role": "viewer", "engineering_lead": True},
        headers=auth,
    )
    assert resp.status_code == 422, resp.text
    assert resp.json()["detail"] == VIEWER_REFUSED
    resp = await client.post(
        "/v1/invites",
        json={"email": "x@example.com", "role": "commenter", "engineering_lead": True},
        headers=auth,
    )
    assert resp.status_code == 201, resp.text
    assert resp.json()["engineering_lead"] is True
    listed = (await client.get("/v1/invites", headers=auth)).json()
    assert [(i["email"], i["engineering_lead"]) for i in listed] == [("x@example.com", True)]
    me = await client.get("/v1/me", headers={HEADER: assertion("x@example.com")})
    assert me.status_code == 200, me.text
    assert me.json()["role"] == "commenter" and me.json()["engineering_lead"] is True
    async with tenant_session(tenant_id) as s:
        user = await s.scalar(select(User).where(User.email == "x@example.com"))
        assert user.engineering_lead is True
        provision = await s.scalar(select(AuditEvent).where(AuditEvent.action == "provision"))
        assert provision.data["engineering_lead"] is True


async def test_the_database_refuses_a_flagged_viewer(owner):
    # protects=AC6, the constraint holds whatever path writes; fails_when=a viewer row can
    # carry the flag; no_claim=the API's message.
    tenant_id, _ = owner
    viewer = await person(tenant_id, "viewer")
    async with tenant_session(tenant_id) as s:
        with pytest.raises(IntegrityError, match="ck_users_engineering_lead_role"):
            await s.execute(
                text("UPDATE users SET engineering_lead = true WHERE id = :id"),
                {"id": viewer.user_id},
            )
    async with tenant_session(tenant_id) as s:
        s.add(Invite(email="v@example.com", role="viewer", engineering_lead=True))
        with pytest.raises(IntegrityError, match="ck_invites_engineering_lead_role"):
            await s.flush()


async def test_me_says_whether_the_caller_is_a_lead(client, owner):
    # protects=AC7, any client learns whether it acts for a lead; fails_when=a lead reads
    # false, or a token acting for no member reads true; no_claim=the web's note.
    tenant_id, auth = owner
    lead = await person(tenant_id, "commenter", "lead")
    assert (await client.get("/v1/me", headers=lead.headers)).json()["engineering_lead"] is False
    assert (await _flag(client, auth, lead.user_id)).status_code == 200
    assert (await client.get("/v1/me", headers=lead.headers)).json()["engineering_lead"] is True
    async with tenant_session(tenant_id) as s:
        _, raw = await create_api_token(s, "service")
        _, personal = await create_api_token(s, "lead-agent", user_id=lead.user_id)
        await s.commit()
    me = (await client.get("/v1/me", headers={"Authorization": f"Bearer {raw}"})).json()
    assert me["kind"] == "token" and me["engineering_lead"] is False
    me = (await client.get("/v1/me", headers={"Authorization": f"Bearer {personal}"})).json()
    assert me["engineering_lead"] is True


# --- Who decides the engineering stops ---------------------------------------------------------


async def test_with_a_lead_named_leads_and_owners_decide_the_engineering_stop(client, owner):
    # protects=AC8, decide, can_decide and the Inbox agree; fails_when=one site still
    # compares roles only; no_claim=the runtime's own console UI.
    tenant_id, auth = owner
    swarm = on()
    run = await _eng_stop(client, auth, tenant_id, swarm)
    cp = pending(run)
    lead = await person(tenant_id, "commenter", "lead")
    approver = await person(tenant_id, "approver")
    assert (await _flag(client, auth, lead.user_id)).status_code == 200

    def can(r):
        return pending(r)["can_decide"]

    assert can(await get(client, approver.headers, run["id"])) is False
    assert can(await get(client, lead.headers, run["id"])) is True
    assert can(await get(client, auth, run["id"])) is True
    assert cp["id"] not in await _inbox_ids(client, approver.headers)
    assert cp["id"] in await _inbox_ids(client, lead.headers)
    assert cp["id"] in await _inbox_ids(client, auth)

    resp = await _decide_raw(client, approver.headers, run, "approved")
    assert resp.status_code == 403, resp.text
    assert resp.json()["detail"] == LEAD_ONLY
    resp = await _decide_raw(client, lead.headers, run, "approved")
    assert resp.status_code == 200, resp.text
    decided = next(c for c in resp.json()["checkpoints"] if c["id"] == cp["id"])
    assert decided["status"] == "approved" and decided["decided_by"] == str(lead.user_id)
    events = await _events(tenant_id, "checkpoint.approved")
    assert events[-1]["engineering_lead_named"] is True


async def test_an_owner_decides_the_engineering_stop_with_a_lead_named(client, owner):
    # protects=AC8, owners decide every stop; fails_when=an owner is refused once a lead is
    # named; no_claim=eng_dates in a run (F4 lane B adds the kind; the truth table covers it).
    tenant_id, auth = owner
    run = await _eng_stop(client, auth, tenant_id, on())
    lead = await person(tenant_id, "approver", "lead")
    assert (await _flag(client, auth, lead.user_id)).status_code == 200
    resp = await _decide_raw(client, auth, run, "approved")
    assert resp.status_code == 200, resp.text


async def test_with_no_lead_named_approvers_decide_it(client, owner):
    # protects=AC9, the stops never stall a company with no lead; fails_when=an approver
    # is refused, or a commenter is let through; no_claim=F4's stop placement.
    tenant_id, auth = owner
    run = await _eng_stop(client, auth, tenant_id, on())
    approver = await person(tenant_id, "approver")
    commenter = await person(tenant_id, "commenter")
    resp = await _decide_raw(client, commenter.headers, run, "approved")
    assert resp.status_code == 403, resp.text
    assert resp.json()["detail"] == "Requires the approver role"
    assert pending(await get(client, approver.headers, run["id"]))["can_decide"] is True
    resp = await _decide_raw(client, approver.headers, run, "approved")
    assert resp.status_code == 200, resp.text
    assert (await _events(tenant_id, "checkpoint.approved"))[-1]["engineering_lead_named"] is False


async def test_a_lead_unflagged_after_loading_the_run_is_refused(client, owner):
    # protects=AC10, the flag is re-read when the decision lands; fails_when=a decision by
    # an unflagged lead is recorded; no_claim=concurrency inside one transaction.
    tenant_id, auth = owner
    run = await _eng_stop(client, auth, tenant_id, on())
    lead = await person(tenant_id, "commenter", "lead")
    other = await person(tenant_id, "commenter", "other")
    assert (await _flag(client, auth, lead.user_id)).status_code == 200
    assert (await _flag(client, auth, other.user_id)).status_code == 200
    loaded = await get(client, lead.headers, run["id"])
    assert pending(loaded)["can_decide"] is True
    assert (await _flag(client, auth, lead.user_id, False)).status_code == 200
    resp = await _decide_raw(client, lead.headers, loaded, "approved")
    assert resp.status_code == 403, resp.text
    after = await get(client, auth, run["id"])
    assert after["status"] == "awaiting_checkpoint"
    assert pending(after)["decided_by"] is None


async def test_a_console_answer_by_an_approver_not_lead_is_refused(client, owner):
    # protects=AC11, the console path applies the same rule; fails_when=a non-lead
    # approver's console answer counts while a lead is named; no_claim=D3's console gate.
    tenant_id, auth = owner
    swarm = on()
    run = await _eng_stop(client, auth, tenant_id, swarm)
    cp = pending(run)
    approver = await person(tenant_id, "approver")
    lead = await person(tenant_id, "commenter", "lead")
    assert (await _flag(client, auth, lead.user_id)).status_code == 200
    async with tenant_session(tenant_id) as s:
        email = (await s.get(User, approver.user_id)).email
    swarm.console_answer("wf_1", "next_draft-review1", "MERGE", by=email)
    await tick(client, auth)
    run = await get(client, auth, run["id"])
    assert run["status"] == "awaiting_checkpoint" and pending(run)["id"] == cp["id"]
    console = pending(run)["console"]
    assert console["counted"] is False
    assert console["reason"] == f"{email} is not an engineering lead"


async def test_a_lead_decides_no_other_kind(client, owner):
    # protects=AC12, other kinds are unchanged; fails_when=the flag lets a commenter
    # decide any other stop; no_claim=every kind (the truth table covers them).
    tenant_id, auth = owner
    run = await _eng_stop(client, auth, tenant_id, on(), kind="baseline_confirm")
    lead = await person(tenant_id, "commenter", "lead")
    assert (await _flag(client, auth, lead.user_id)).status_code == 200
    resp = await _decide_raw(client, lead.headers, run, "approved")
    assert resp.status_code == 403, resp.text
    assert resp.json()["detail"] == "Requires the approver role"
    assert pending(await get(client, lead.headers, run["id"]))["can_decide"] is False


async def test_a_lead_decision_not_delivered_yet_is_delivered_by_the_tick(client, owner):
    # protects=the delivery re-check reads the lead flag too; fails_when=a commenter lead's
    # owed decision is voided as below the checkpoint's role; no_claim=the post itself.
    tenant_id, auth = owner
    swarm = on()
    run = await _eng_stop(client, auth, tenant_id, swarm)
    lead = await person(tenant_id, "commenter", "lead")
    assert (await _flag(client, auth, lead.user_id)).status_code == 200
    swarm.fail_next_answer = httpx.Response(503, json=_UNAVAILABLE)
    resp = await _decide_raw(client, lead.headers, run, "approved")
    assert resp.status_code == 503 and "recorded" in resp.text, resp.text
    await tick(client, auth)
    assert len(swarm.answers) == 1
    assert await _events(tenant_id, "checkpoint.decision_voided") == []


async def test_unflagging_a_lead_voids_their_undelivered_engineering_decisions(client, owner):
    # protects=AC15, C2's voiding on a demotion applies to the flag; fails_when=an
    # unflagged lead's owed decision is still delivered; no_claim=other kinds (no lead
    # can decide them without the role, AC12).
    tenant_id, auth = owner
    swarm = on()
    run = await _eng_stop(client, auth, tenant_id, swarm)
    lead = await person(tenant_id, "commenter", "lead")
    assert (await _flag(client, auth, lead.user_id)).status_code == 200
    swarm.fail_next_answer = httpx.Response(503, json=_UNAVAILABLE)
    resp = await _decide_raw(client, lead.headers, run, "approved")
    assert resp.status_code == 503, resp.text
    assert (await _flag(client, auth, lead.user_id, False)).status_code == 200
    await tick(client, auth)
    assert swarm.answers == []
    run = await get(client, auth, run["id"])
    assert run["status"] == "awaiting_checkpoint" and pending(run)["decided_by"] is None
    voided = await _events(tenant_id, "checkpoint.decision_voided")
    assert [v["decided_by"] for v in voided] == [str(lead.user_id)]


async def test_unflagging_an_owner_lead_voids_nothing(client, owner):
    # protects=an owner still decides every stop; fails_when=clearing an owner's flag
    # voids what they decided; no_claim=other members.
    tenant_id, auth = owner
    swarm = on()
    run = await _eng_stop(client, auth, tenant_id, swarm)
    boss = await person(tenant_id, "owner", "boss")
    assert (await _flag(client, auth, boss.user_id)).status_code == 200
    swarm.fail_next_answer = httpx.Response(503, json=_UNAVAILABLE)
    resp = await _decide_raw(client, boss.headers, run, "approved")
    assert resp.status_code == 503, resp.text
    assert (await _flag(client, auth, boss.user_id, False)).status_code == 200
    await tick(client, auth)
    assert len(swarm.answers) == 1
    assert await _events(tenant_id, "checkpoint.decision_voided") == []


# --- Date bases ---------------------------------------------------------------------------------


async def test_leads_record_and_withdraw_date_bases(client, owner):
    # protects=AC13, leads may verify dates and nothing else changes; fails_when=a lead is
    # refused or an approver loses the right before F3 lands; no_claim=the date-basis UI
    # and the proposed state (F3 applies the decided rule).
    tenant_id, auth = owner
    assert (await import_draft(client, auth, draft("prd_v1.md"))).status_code == 201
    lead = await person(tenant_id, "commenter", "lead")
    commenter = await person(tenant_id, "commenter")
    approver = await person(tenant_id, "approver")
    body = {"kind": "estimate", "reference": "ENG-1", "supports_date": "2026-11-30", "prd": PRD}

    async def record(headers):
        return await client.post("/v1/schedule-bases", json=body, headers=headers)

    resp = await record(lead.headers)
    assert resp.status_code == 403 and resp.json()["detail"] == DATES_REFUSED, resp.text
    resp = await record(approver.headers)
    assert resp.status_code == 201, resp.text  # no lead named
    assert (await _flag(client, auth, lead.user_id)).status_code == 200
    resp = await record(lead.headers)
    assert resp.status_code == 201, resp.text
    basis = resp.json()
    assert basis["verified_by"] == str(lead.user_id)
    resp = await record(commenter.headers)
    assert resp.status_code == 403 and resp.json()["detail"] == DATES_REFUSED, resp.text
    resp = await record(approver.headers)
    assert resp.status_code == 201, resp.text  # a lead named: still O4's rule until F3
    by_approver = resp.json()

    def withdraw(basis_id, headers):
        return client.post(
            f"/v1/schedule-bases/{basis_id}/withdraw", json={"reason": "Re-estimated"},
            headers=headers,
        )  # fmt: skip

    resp = await withdraw(basis["id"], commenter.headers)
    assert resp.status_code == 403 and resp.json()["detail"] == DATES_REFUSED, resp.text
    assert (await withdraw(basis["id"], lead.headers)).status_code == 200
    assert (await withdraw(by_approver["id"], approver.headers)).status_code == 200


# --- A1 hand-off: the Set up checklist's Engineering lead step ---------------------------------


async def test_the_setup_checklist_has_an_engineering_lead_step(client, owner):
    # protects=3.6, the owner's eng_lead step between domains and horizons; fails_when=it
    # is done with no lead, or counts disabled leads; no_claim=the web draws it.
    tenant_id, auth = owner
    me = await person(tenant_id, "owner", "boss")
    body = (await client.get("/v1/setup", headers=me.headers)).json()
    keys = [s["key"] for s in body["steps"]]
    assert keys.index("eng_lead") == keys.index("domains") + 1 == keys.index("horizons") - 1
    step = next(s for s in body["steps"] if s["key"] == "eng_lead")
    assert step["done"] is False and step["count"] == 0
    lead = await person(tenant_id, "commenter", "lead")
    other = await person(tenant_id, "approver", "other")
    assert (await _flag(client, auth, lead.user_id)).status_code == 200
    assert (await _flag(client, auth, other.user_id)).status_code == 200
    body = (await client.get("/v1/setup", headers=me.headers)).json()
    step = next(s for s in body["steps"] if s["key"] == "eng_lead")
    assert step["done"] is True and step["count"] == 2
    resp = await client.post(f"/v1/members/{other.user_id}/disable", headers=auth)
    assert resp.status_code == 200, resp.text
    body = (await client.get("/v1/setup", headers=me.headers)).json()
    assert next(s for s in body["steps"] if s["key"] == "eng_lead")["count"] == 1
    # Not a commenter's step.
    keys = [s["key"] for s in (await client.get("/v1/setup", headers=lead.headers)).json()["steps"]]
    assert "eng_lead" not in keys
