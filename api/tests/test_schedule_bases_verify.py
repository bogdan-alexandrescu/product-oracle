"""F3 Date bases: who records, verifies, rejects and withdraws a schedule basis.

The owner's rule (2026-10-21, F3 "Who verifies"): engineering leads and owners verify; an
approver can still record a basis, but it waits as Proposed until a lead (or an owner)
verifies it, and no date rests on it meanwhile; while no lead is named, approvers verify
and withdraw as today (O4). Withdrawal keeps its reason on the row; ``impact`` previews
what a withdrawal changes, writing nothing. Proposed bases are in the lead's Inbox.

Every test states its card: protects / fails_when / no_claim. Against Postgres with the
FakeRuntime. Synthetic placeholders only.
"""

import uuid

import pytest
from sqlalchemy import select

from oracle.auth.deps import Principal
from oracle.auth.models import User
from oracle.members.leads import date_rights
from oracle.models import AuditEvent
from oracle.roadmap.models import ScheduleBasis
from oracle.runs.models import Run
from oracle.runtokens import mint_run_token
from oracle.swarm import Outcome
from oracle.tenancy import tenant_session
from tests.review_v2_helpers import person
from tests.roadmap_helpers import other_company
from tests.test_mcp import mcp_client
from tests.test_roadmap import (  # noqa: F401 - fixtures
    ITEMS,
    PRD,
    ROADMAP,
    ROADMAP_MD,
    approved_prd,
    create,
    get,
    owner,
    runtime,
    start,
    tick,
)
from tests.test_roadmap_doc_dates import with_line

ITEMS_URL = f"/v1/roadmaps/{ROADMAP}/items"
VERSION_URL = f"/v1/documents/{ROADMAP}/versions/1"
GA = "GA on 2026-12-15."

# --- date_rights: the §1 table ----------------------------------------------------------------

LEAD = uuid.uuid4()


def _p(role: str, user_id: uuid.UUID | None = None, kind: str = "user") -> Principal:
    if kind == "token":
        return Principal(tenant_id=uuid.uuid4(), kind="token", role=role, token_id=uuid.uuid4())
    return Principal(
        tenant_id=uuid.uuid4(), kind="user", role=role, user_id=user_id or uuid.uuid4()
    )


WHO = {
    "owner": _p("owner"),
    "approver": _p("approver"),
    "commenter": _p("commenter"),
    "viewer": _p("viewer"),
    "lead_commenter": _p("commenter", LEAD),
    "lead_approver": _p("approver", LEAD),
    # The lead through a read-only token acts as a viewer: no rights.
    "lead_read_only": _p("viewer", LEAD),
    # An API token acting for no member is never a lead.
    "service_approver": _p("approver", kind="token"),
}


@pytest.mark.parametrize(
    ("named", "expected"),
    [
        (
            True,
            {
                "owner": "verify", "approver": "propose", "commenter": None, "viewer": None,
                "lead_commenter": "verify", "lead_approver": "verify", "lead_read_only": None,
                "service_approver": "propose",
            },
        ),
        (
            False,
            {
                "owner": "verify", "approver": "verify", "commenter": None, "viewer": None,
                "lead_commenter": None, "lead_approver": "verify", "lead_read_only": None,
                "service_approver": "verify",
            },
        ),
    ],
)  # fmt: skip
def test_date_rights_table(named, expected):
    # protects=§1 Who does what, the one rights function; fails_when=an approver verifies
    # while a lead is named, a lead or owner only proposes, a commenter or viewer gets any
    # right, or approvers lose today's rights with no lead named; no_claim=the routes.
    leads = frozenset({LEAD}) if named else frozenset()
    assert {who: date_rights(p, leads) for who, p in WHO.items()} == expected


# --- helpers ------------------------------------------------------------------------------------


async def _flag(client, auth, user_id) -> None:
    resp = await client.patch(
        f"/v1/members/{user_id}", json={"engineering_lead": True}, headers=auth
    )
    assert resp.status_code == 200, resp.text


async def _post(client, headers, reference: str, day: str, **scope):
    return await client.post(
        "/v1/schedule-bases",
        json={"kind": "estimate", "reference": reference, "supports_date": day, "prd": PRD,
              **scope},
        headers=headers,
    )  # fmt: skip


async def _record(client, headers, reference: str, day: str, **scope) -> dict:
    resp = await _post(client, headers, reference, day, **scope)
    assert resp.status_code == 201, resp.text
    return resp.json()


async def _eng_412(client, auth) -> dict:
    (eng,) = [
        b
        for b in (await client.get("/v1/schedule-bases", headers=auth)).json()
        if b["reference"] == "ENG-412" and b["status"] == "verified"
    ]
    return eng


async def _roadmap(client, auth, runtime) -> None:  # noqa: F811
    """An approved PRD (ENG-412 verified for 2026-11-30, the Beta date of payment-step) and
    a roadmap built by a run whose text also says GA on 2026-12-15, a date no basis
    supports (marked unverified)."""
    await approved_prd(client, auth)
    runtime.script["roadmap_items"] = [Outcome(artifacts={"roadmap_items.yaml": ITEMS})]
    runtime.script["roadmap_draft"] = [Outcome(artifacts={"roadmap.md": with_line(GA)})]
    off = {"roadmap_items": False, "roadmap_review": False}
    run = await start(
        client, auth, await create(client, auth, source=PRD, knobs={"checkpoints": off})
    )
    await tick(client, auth)
    await tick(client, auth)
    assert (await get(client, auth, run["id"]))["status"] == "succeeded"


async def _marks(client, auth) -> dict[str, str]:
    version = (await client.get(VERSION_URL, headers=auth)).json()
    return {m["text"]: m["status"] for m in version["date_marks"]}


async def _payment(client, auth) -> dict:
    items = (await client.get(ITEMS_URL, headers=auth)).json()["items"]
    return next(i for i in items if i["item_key"] == "payment-step")["milestone"]


async def _withdraw(client, headers, basis_id: str, reason: str = "Re-estimated"):
    return await client.post(
        f"/v1/schedule-bases/{basis_id}/withdraw", json={"reason": reason}, headers=headers
    )


async def _verify(client, headers, basis_id: str, note: str | None = None):
    return await client.post(
        f"/v1/schedule-bases/{basis_id}/verify", json={"note": note}, headers=headers
    )


async def _reject(client, headers, basis_id: str, reason: str = "Not our estimate"):
    return await client.post(
        f"/v1/schedule-bases/{basis_id}/reject", json={"reason": reason}, headers=headers
    )


async def _actions(tenant_id, basis_id: str) -> list[str]:
    async with tenant_session(tenant_id) as s:
        rows = await s.scalars(
            select(AuditEvent.action)
            .where(AuditEvent.entity_id == uuid.UUID(basis_id))
            .order_by(AuditEvent.created_at)
        )
        return list(rows)


# --- AC1, AC2: a proposed basis supports nothing until a lead verifies it -----------------------


async def test_a_proposed_basis_supports_nothing_until_the_lead_verifies(client, owner, runtime):  # noqa: F811
    # protects=AC1 and AC2; fails_when=an approver's basis supports a date while a lead is
    # named, or the lead's verify leaves the item's date refused or the document's mark
    # unverified; no_claim=the UI.
    tenant_id, auth = owner
    await _roadmap(client, auth, runtime)
    assert await _marks(client, auth) == {"2026-11-30": "verified", "2026-12-15": "unverified"}
    assert (await _withdraw(client, auth, (await _eng_412(client, auth))["id"])).status_code == 200
    lead = await person(tenant_id, "commenter", "lead")
    approver = await person(tenant_id, "approver")
    await _flag(client, auth, lead.user_id)

    beta = await _record(client, approver.headers, "ENG-412", "2026-11-30")
    ga = await _record(client, approver.headers, "ENG-500", "2026-12-15")
    for b in (beta, ga):
        assert b["status"] == "proposed", b
        assert b["proposed_by"] == str(approver.user_id) and b["proposed_at"]
        assert b["verified_by"] is None and b["verified_at"] is None
    milestone = await _payment(client, auth)
    assert milestone["date"] is None and milestone["refused_date"] == "2026-11-30"
    assert await _marks(client, auth) == {"2026-11-30": "withdrawn", "2026-12-15": "unverified"}
    listed = (await client.get("/v1/schedule-bases?status=proposed", headers=auth)).json()
    assert sorted(b["reference"] for b in listed) == ["ENG-412", "ENG-500"]

    for b in (beta, ga):
        resp = await _verify(client, lead.headers, b["id"], note="Checked with the team")
        assert resp.status_code == 200, resp.text
        out = resp.json()
        assert out["status"] == "verified" and out["verified_by"] == str(lead.user_id)
        assert out["verified_at"] and out["note"] == "Checked with the team"
    milestone = await _payment(client, auth)
    assert milestone["date"] == "2026-11-30" and milestone["basis_ids"] == [beta["id"]]
    assert await _marks(client, auth) == {"2026-11-30": "verified", "2026-12-15": "verified"}
    assert await _actions(tenant_id, beta["id"]) == [
        "schedule_basis.proposed",
        "schedule_basis.verified",
    ]


# --- AC3: reject, and a second decision is a conflict --------------------------------------------


async def test_reject_and_a_second_decision_is_409(client, owner):  # noqa: F811
    # protects=AC3; fails_when=reject does not store its reason, or a decided basis can be
    # verified or rejected again; no_claim=dates (a rejected basis is not verified, which
    # verified_bases already filters).
    tenant_id, auth = owner
    await approved_prd(client, auth, approve=False)
    lead = await person(tenant_id, "approver", "lead")
    approver = await person(tenant_id, "approver")
    await _flag(client, auth, lead.user_id)
    b = await _record(client, approver.headers, "ENG-7", "2026-11-30")
    resp = await _reject(client, lead.headers, b["id"], "Not our estimate")
    assert resp.status_code == 200, resp.text
    out = resp.json()
    assert out["status"] == "rejected" and out["rejected_reason"] == "Not our estimate"
    assert out["rejected_by"] == str(lead.user_id) and out["rejected_at"]
    assert (await _verify(client, lead.headers, b["id"])).status_code == 409
    assert (await _reject(client, lead.headers, b["id"])).status_code == 409
    # A verified basis is not proposed either.
    eng = await _eng_412(client, auth)
    assert (await _verify(client, auth, eng["id"])).status_code == 409
    assert (await _reject(client, auth, eng["id"])).status_code == 409
    # Reject needs a reason.
    c = await _record(client, approver.headers, "ENG-8", "2026-11-30")
    resp = await client.post(
        f"/v1/schedule-bases/{c['id']}/reject", json={"reason": ""}, headers=lead.headers
    )
    assert resp.status_code == 422
    assert "schedule_basis.rejected" in await _actions(tenant_id, b["id"])
    rejected = (await client.get("/v1/schedule-bases?status=rejected", headers=auth)).json()
    assert [r["id"] for r in rejected] == [b["id"]]


# --- AC4, AC5: who withdraws and verifies ------------------------------------------------------


async def test_with_a_lead_named_approvers_neither_verify_nor_withdraw(client, owner):  # noqa: F811
    # protects=AC4; fails_when=an approver verifies or withdraws while a lead is named, or
    # an owner is refused; no_claim=commenters (date_rights_table).
    tenant_id, auth = owner
    await approved_prd(client, auth, approve=False)
    lead = await person(tenant_id, "commenter", "lead")
    approver = await person(tenant_id, "approver")
    commenter = await person(tenant_id, "commenter")
    await _flag(client, auth, lead.user_id)
    proposed = await _record(client, approver.headers, "ENG-9", "2026-11-30")
    eng = await _eng_412(client, auth)

    assert (await _verify(client, approver.headers, proposed["id"])).status_code == 403
    assert (await _reject(client, approver.headers, proposed["id"])).status_code == 403
    assert (await _withdraw(client, approver.headers, eng["id"])).status_code == 403
    assert (await _post(client, commenter.headers, "ENG-10", "2026-11-30")).status_code == 403
    assert (await _verify(client, auth, proposed["id"])).status_code == 200
    assert (await _withdraw(client, auth, eng["id"])).status_code == 200
    # The owner's and the lead's own bases are verified at once.
    assert (await _record(client, auth, "ENG-11", "2026-11-30"))["status"] == "verified"
    mine = await _record(client, lead.headers, "ENG-12", "2026-11-30")
    assert mine["status"] == "verified" and mine["verified_by"] == str(lead.user_id)
    assert (await _withdraw(client, lead.headers, mine["id"])).status_code == 200


async def test_with_no_lead_named_approvers_keep_todays_rights(client, owner):  # noqa: F811
    # protects=AC5, O4 while no lead is named; fails_when=an approver's basis waits as
    # proposed or its withdrawal is refused; no_claim=leads.
    tenant_id, auth = owner
    await approved_prd(client, auth, approve=False)
    approver = await person(tenant_id, "approver")
    b = await _record(client, approver.headers, "ENG-13", "2026-11-30")
    assert b["status"] == "verified" and b["verified_by"] == str(approver.user_id)
    assert (await _withdraw(client, approver.headers, b["id"])).status_code == 200


# --- AC6: the reason is stored ----------------------------------------------------------------


async def test_withdraw_stores_the_reason(client, owner):  # noqa: F811
    # protects=AC6 (API half; the backfill is test_basis_verification_migration);
    # fails_when=the reason only reaches the audit log; no_claim=the UI.
    tenant_id, auth = owner
    await approved_prd(client, auth, approve=False)
    eng = await _eng_412(client, auth)
    resp = await _withdraw(client, auth, eng["id"], "The team re-estimated")
    assert resp.status_code == 200, resp.text
    assert resp.json()["basis"]["withdrawn_reason"] == "The team re-estimated"
    (row,) = (await client.get("/v1/schedule-bases?status=withdrawn", headers=auth)).json()
    assert row["withdrawn_reason"] == "The team re-estimated" and row["withdrawn_by"]


# --- AC7: the impact preview is what withdraw changes ---------------------------------------


async def test_impact_matches_what_withdraw_changes(client, owner, runtime):  # noqa: F811
    # protects=AC7; fails_when=the preview names a milestone, item or document mark the
    # withdrawal does not change (or misses one), or the preview writes anything;
    # no_claim=the sentence the UI builds from it.
    tenant_id, auth = owner
    await _roadmap(client, auth, runtime)
    eng = await _eng_412(client, auth)
    track = (await client.get("/v1/tracks", headers=auth)).json()[0]
    resp = await client.post(
        f"/v1/tracks/{track['id']}/milestones",
        json={"name": "Beta launch", "horizon": "now", "target_date": "2026-11-30",
              "basis_ids": [eng["id"]]},
        headers=auth,
    )  # fmt: skip
    assert resp.status_code in (200, 201), resp.text
    milestone_id = resp.json()["id"]

    viewer = await person(tenant_id, "viewer")
    resp = await client.get(f"/v1/schedule-bases/{eng['id']}/impact", headers=viewer.headers)
    assert resp.status_code == 200, resp.text
    impact = resp.json()
    assert impact["basis_id"] == eng["id"]
    assert [
        (m["id"], m["name"], m["target_date"], m["keeps_date"]) for m in impact["milestones"]
    ] == [(milestone_id, "Beta launch", "2026-11-30", False)]
    assert [(i["roadmap"], i["version"], i["item_key"]) for i in impact["items"]] == [
        (ROADMAP, 1, "payment-step")
    ]
    assert impact["documents"] == [{"slug": ROADMAP, "version": 1, "marks": 1}]
    # Nothing written.
    assert (await _eng_412(client, auth))["status"] == "verified"
    assert await _marks(client, auth) == {"2026-11-30": "verified", "2026-12-15": "unverified"}

    resp = await _withdraw(client, auth, eng["id"])
    assert resp.status_code == 200, resp.text
    out = resp.json()
    assert out["undated_milestones"] == [
        m["id"] for m in impact["milestones"] if not m["keeps_date"]
    ]
    assert out["stale_items"] == [i["id"] for i in impact["items"]]
    marks = await _marks(client, auth)
    assert sum(1 for s in marks.values() if s == "withdrawn") == impact["documents"][0]["marks"]


# --- AC8: the Inbox ----------------------------------------------------------------------------


async def test_the_lead_s_inbox_lists_proposed_bases(client, owner):  # noqa: F811
    # protects=AC8; fails_when=a proposed basis is missing, listed twice or not counted in
    # the lead's total, or shows in an approver's Inbox; no_claim=the Inbox UI.
    tenant_id, auth = owner
    await approved_prd(client, auth, approve=False)
    lead = await person(tenant_id, "commenter", "lead")
    approver = await person(tenant_id, "approver")
    await _flag(client, auth, lead.user_id)
    a = await _record(client, approver.headers, "ENG-20", "2026-11-30")
    b = await _record(client, approver.headers, "ENG-21", "2026-12-15")

    inbox = (await client.get("/v1/inbox", headers=lead.headers)).json()
    assert sorted(d["id"] for d in inbox["dates"]) == sorted([a["id"], b["id"]])
    assert {d["prd"]["slug"] for d in inbox["dates"]} == {PRD}
    before = inbox["total"]
    assert before >= 2
    assert (await client.get("/v1/inbox", headers=approver.headers)).json()["dates"] == []
    # A named lead: owners verify from the Dates tab, the Inbox row is the lead's.
    assert (await client.get("/v1/inbox", headers=auth)).json()["dates"] == []

    assert (await _verify(client, lead.headers, a["id"])).status_code == 200
    inbox = (await client.get("/v1/inbox", headers=lead.headers)).json()
    assert [d["id"] for d in inbox["dates"]] == [b["id"]]
    assert inbox["total"] == before - 1


# --- AC9: another company, run tokens ---------------------------------------------------------


async def test_another_company_gets_404_and_run_tokens_are_refused(client, owner, runtime):  # noqa: F811
    # protects=AC9; fails_when=another company reads or acts on a basis, or a run token
    # reaches a basis tool; no_claim=the tenancy layer itself.
    tenant_id, auth = owner
    await approved_prd(client, auth, approve=False)
    approver = await person(tenant_id, "approver")
    lead = await person(tenant_id, "commenter", "lead")
    await _flag(client, auth, lead.user_id)
    proposed = await _record(client, approver.headers, "ENG-30", "2026-11-30")
    eng = await _eng_412(client, auth)
    other = await other_company()
    for basis_id in (proposed["id"], eng["id"]):
        assert (
            await client.get(f"/v1/schedule-bases/{basis_id}/impact", headers=other)
        ).status_code == 404
        assert (await _verify(client, other, basis_id)).status_code == 404
        assert (await _reject(client, other, basis_id)).status_code == 404
        assert (await _withdraw(client, other, basis_id)).status_code == 404
    assert (await client.get("/v1/schedule-bases", headers=other)).json() == []

    async with tenant_session(tenant_id) as s:
        admin = await s.scalar(select(User.id).where(User.email == "admin@example.com"))
        run = Run(flow="baseline_to_prd", created_by=admin)
        s.add(run)
        await s.flush()
        raw = await mint_run_token(s, run.id, ["read:documents", "write:drafts"], ttl_seconds=600)
        await s.commit()
    async with mcp_client(raw) as c:
        names = {t.name for t in (await c.list_tools()).tools}
        tools = {"verify_schedule_basis", "reject_schedule_basis", "get_schedule_basis_impact"}
        assert names.isdisjoint(tools)
        for tool, args in [
            ("verify_schedule_basis", {"basis_id": proposed["id"], "body": {"note": None}}),
            ("reject_schedule_basis", {"basis_id": proposed["id"], "body": {"reason": "x"}}),
            ("get_schedule_basis_impact", {"basis_id": eng["id"]}),
        ]:
            assert (await c.call_tool(tool, args)).is_error, tool
    async with tenant_session(tenant_id) as s:
        row = await s.get(ScheduleBasis, uuid.UUID(proposed["id"]))
        assert row.status == "proposed"
