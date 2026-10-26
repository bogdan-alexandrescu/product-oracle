"""I1 lane 1: the event registry, payload models, capture and the C2 member hooks
(spec-I1 "Events (v1)", "Payloads", "Owners-and-approvers events", "Member changes"; owner
answers Q2 and Q3). Invented data only."""

import uuid

import pytest
from pydantic import BaseModel
from sqlalchemy import select

from oracle import readiness
from oracle.docs.models import Document
from oracle.runs.models import Checkpoint, Run
from oracle.tenancy import tenant_session
from oracle.webhooks import service as webhooks
from oracle.webhooks.events import EVENT_TYPES, approvers_only
from oracle.webhooks.models import Webhook, WebhookEvent
from tests.connection_helpers import make_person
from tests.fixtures import seed_auth
from tests.review_v2_helpers import DOC, DRAFT, import_md, replace

GROUPS = {"runs", "drafts", "approvals"}
V1 = [
    "run.awaiting_approval", "run.started", "run.checkpoint_waiting",
    "run.checkpoint_decided", "run.checkpoint_voided", "run.paused_overrun", "run.resumed",
    "run.succeeded", "run.failed", "run.cancelled", "draft.version_created",
    "draft.in_review", "approval.version_approved", "approval.approvals_invalidated",
    "approval.version_published",
]  # fmt: skip
# Q3: ids, types, states, titles, names and links (and the codes the spec names).
ALLOWED_FIELDS = {
    "id", "type", "api_version", "occurred_at", "company", "name", "data", "run", "flow",
    "status", "title", "url", "checkpoint", "kind", "approver_role", "outcome", "document",
    "version", "origin", "actor", "approver", "error_kind", "reason",
}  # fmt: skip


@pytest.fixture(autouse=True)
def _only_test_checks():
    with readiness.isolated_checks():
        yield


def _fields(model: type[BaseModel], seen: set) -> set[str]:
    if model in seen:
        return set()
    seen.add(model)
    out = set(model.model_fields)
    for f in model.model_fields.values():
        for arg in _models_in(f.annotation):
            out |= _fields(arg, seen)
    return out


def _models_in(annotation) -> list[type[BaseModel]]:
    if isinstance(annotation, type) and issubclass(annotation, BaseModel):
        return [annotation]
    return [m for a in getattr(annotation, "__args__", ()) for m in _models_in(a)]


# --- the registry ---------------------------------------------------------------------------


def test_the_registry_has_the_fifteen_v1_types_each_with_a_group_check_and_model():
    """protects=spec Events (v1) and "a new type must declare how its subject is checked";
    fails_when=a type is missing, or lacks a group, a subject check or a payload model."""
    assert list(EVENT_TYPES) == V1
    for name, et in EVENT_TYPES.items():
        assert et.type == name and et.group in GROUPS and et.label
        assert callable(et.check), name
        assert issubclass(et.payload, BaseModel), name
        assert et.payload.model_fields["type"].annotation.__args__ == (name,)


@pytest.mark.parametrize("name", V1)
def test_every_payload_model_carries_only_allowlisted_fields(name):
    """protects=AC6, Q3: no document text, comments, notes, excerpts, costs, emails or user
    ids in any type's model; fails_when=a field outside the allowlist appears."""
    fields = _fields(EVENT_TYPES[name].payload, set())
    assert fields <= ALLOWED_FIELDS, fields - ALLOWED_FIELDS
    for bad in ("email", "user_id", "note", "markdown", "text", "body", "cost", "usd", "error"):
        assert bad not in fields


async def _subjects(tenant_id, visibility: str) -> dict[str, str]:
    async with tenant_session(tenant_id) as s:
        doc = Document(
            slug=f"d-{uuid.uuid4().hex[:6]}", title="Example", kind="prd", visibility=visibility
        )
        s.add(doc)
        await s.flush()
        run = Run(flow="baseline_to_prd", document_id=doc.id)
        s.add(run)
        await s.flush()
        cp = Checkpoint(
            run_id=run.id, kind="prd_review", status="pending", approver_role="approver"
        )
        s.add(cp)
        await s.commit()
        return {"document_id": str(doc.id), "run_id": str(run.id), "checkpoint_id": str(cp.id)}


@pytest.mark.parametrize("name", V1)
async def test_every_type_is_approvers_only_exactly_when_its_subject_is_hidden(tenant_id, name):
    """protects=AC7 and the registry pin: each type's check hides a subject on an
    approvers-only document and passes a company one; fails_when=a type leaks or hides
    wrongly."""
    open_ = await _subjects(tenant_id, "company")
    closed = await _subjects(tenant_id, "approvers")
    async with tenant_session(tenant_id) as s:
        assert await approvers_only(s, name, open_) is False
        assert await approvers_only(s, name, closed) is True


async def test_update_flows_and_review_kinds_are_approvers_only(tenant_id):
    """protects=spec rule (a run of update_draft or pricing_memo, a checkpoint of kind
    update_review or pricing_review); fails_when=either is sent to members' webhooks."""
    async with tenant_session(tenant_id) as s:
        run = Run(flow="update_draft")
        other = Run(flow="baseline_to_prd")
        s.add_all([run, other])
        await s.flush()
        cp = Checkpoint(
            run_id=other.id, kind="pricing_review", status="pending", approver_role="approver"
        )
        s.add(cp)
        await s.flush()
        assert await approvers_only(s, "run.started", {"run_id": str(run.id)})
        assert not await approvers_only(s, "run.started", {"run_id": str(other.id)})
        assert await approvers_only(
            s, "run.checkpoint_waiting", {"run_id": str(other.id), "checkpoint_id": str(cp.id)}
        )


# --- capture --------------------------------------------------------------------------------


async def _hook(client, headers, types: list[str]) -> str:
    resp = await client.post(
        "/v1/webhooks",
        json={"name": "Bot", "url": "https://hooks.example.test/in", "event_types": types},
        headers=headers,
    )
    assert resp.status_code == 201, resp.text
    return resp.json()["webhook"]["id"]


async def _events(tenant_id) -> list[WebhookEvent]:
    async with tenant_session(tenant_id) as s:
        return list(await s.scalars(select(WebhookEvent).order_by(WebhookEvent.occurred_at)))


async def test_capture_writes_nothing_without_a_subscribed_active_webhook(client, tenant_id):
    """protects=spec Capture (a company without webhooks stays free of rows); fails_when=a
    row is written with no subscriber, for an unsubscribed type, or for a paused one."""
    owner = await make_person(tenant_id, "owner@example.com", "owner")
    subject = await _subjects(tenant_id, "company")
    async with tenant_session(tenant_id) as s:
        assert await webhooks.capture(s, "run.started", None, run_id=subject["run_id"]) is None
        await s.commit()
    hook = await _hook(client, owner.headers, ["run.succeeded"])
    async with tenant_session(tenant_id) as s:
        assert await webhooks.capture(s, "run.started", None, run_id=subject["run_id"]) is None
        row = await webhooks.capture(s, "run.succeeded", owner.user, run_id=subject["run_id"])
        assert row is not None and row.public_id.startswith("evt_") and len(row.public_id) == 30
        assert row.approvers_only is False and row.fanned_out_at is None
        assert row.subject["run_id"] == subject["run_id"]
        await s.commit()
    await client.patch(f"/v1/webhooks/{hook}", json={"status": "paused"}, headers=owner.headers)
    async with tenant_session(tenant_id) as s:
        assert await webhooks.capture(s, "run.succeeded", None, run_id=subject["run_id"]) is None
    assert len(await _events(tenant_id)) == 1


async def test_capture_rolls_back_with_the_change(client, tenant_id):
    """protects=AC5 (capture is transactional); fails_when=a rolled-back change leaves an
    event."""
    owner = await make_person(tenant_id, "owner@example.com", "owner")
    await _hook(client, owner.headers, ["run.started"])
    subject = await _subjects(tenant_id, "company")
    async with tenant_session(tenant_id) as s:
        assert await webhooks.capture(s, "run.started", None, run_id=subject["run_id"])
        await s.rollback()
    assert await _events(tenant_id) == []


async def test_a_draft_imported_reviewed_approved_and_published_is_captured(client):
    """protects=AC4: import, In review, approve and publish produce draft.version_created,
    draft.in_review, approval.version_approved and approval.version_published, in their
    own transactions; fails_when=one is missing or duplicated."""
    tenant_id, auth = await seed_auth()
    types = [t for t in V1 if t.startswith(("draft.", "approval."))]
    await _hook(client, auth, types)
    assert (await import_md(client, auth, DRAFT)).status_code == 201
    base = f"/v1/documents/{DOC}/versions/1"
    resp = await client.post(
        f"{base}/comments",
        json={
            "body": "Looks right",
            "section_key": "problem",
            "anchor": {"exact": "Teams miss shared deadlines."},
        },
        headers=auth,
    )
    assert resp.status_code == 201, resp.text
    assert (await client.post(f"{base}/approve", headers=auth)).status_code == 200
    resp = await client.post(f"{base}/publish", json={}, headers=auth)
    assert resp.status_code == 201, resp.text
    got = [e.type for e in await _events(tenant_id)]
    assert got == [
        "draft.version_created",
        "draft.in_review",
        "approval.version_approved",
        "approval.version_published",
    ]
    for e in await _events(tenant_id):
        assert set(e.subject) <= {"document_id", "version", "origin", "actor", "reason"}
        assert e.approvers_only is False
    # A new version of the approved document: back to In review.
    resp = await import_md(client, auth, replace(DRAFT, "Teams miss", "Teams often miss"), base=1)
    assert resp.status_code == 201, resp.text
    assert [e.type for e in await _events(tenant_id)][-2:] == [
        "draft.version_created",
        "draft.in_review",
    ]


async def test_a_demotion_lapsing_an_approval_is_captured(client):
    """protects=AC4's last sentence: a demotion that lapses an approval produces
    approval.approvals_invalidated with a reason code; fails_when=no event."""
    tenant_id, auth = await seed_auth()
    approver = await make_person(tenant_id, "approver@example.com", "approver")
    await _hook(client, auth, ["approval.approvals_invalidated"])
    assert (await import_md(client, auth, DRAFT)).status_code == 201
    base = f"/v1/documents/{DOC}/versions/1"
    assert (await client.post(f"{base}/approve", headers=approver.headers)).status_code == 200
    resp = await client.patch(
        f"/v1/members/{approver.user.id}", json={"role": "commenter"}, headers=auth
    )
    assert resp.status_code == 200, resp.text
    (event,) = await _events(tenant_id)
    assert event.type == "approval.approvals_invalidated"
    assert event.subject["reason"] == "approver_demoted" and event.subject["version"] == "1"


# --- C2: member changes pause a creator's webhooks ------------------------------------------


async def test_disabling_or_demoting_the_creator_pauses_their_webhooks(client, tenant_id):
    """protects=AC14 and spec Member changes: a disable pauses (creator_disabled), a
    restore does not resume; a demotion below approver pauses (creator_demoted); an
    owner's demotion turns approvers content off; fails_when=a webhook keeps sending."""
    owner = await make_person(tenant_id, "owner@example.com", "owner")
    second = await make_person(tenant_id, "second.owner@example.com", "owner")
    approver = await make_person(tenant_id, "approver@example.com", "approver")
    a = await _hook(client, approver.headers, ["run.started"])
    b = await _hook(client, second.headers, ["run.started"])
    resp = await client.patch(
        f"/v1/webhooks/{b}",
        json={"include_approvers_content": True, "reason": "Board bot"},
        headers=second.headers,
    )
    assert resp.status_code == 200, resp.text
    resp = await client.post(
        f"/v1/members/{approver.user.id}/disable", json={}, headers=owner.headers
    )
    assert resp.status_code == 200, resp.text
    resp = await client.post(f"/v1/members/{approver.user.id}/restore", headers=owner.headers)
    assert resp.status_code == 200, resp.text
    resp = await client.patch(
        f"/v1/members/{second.user.id}", json={"role": "approver"}, headers=owner.headers
    )
    assert resp.status_code == 200, resp.text
    async with tenant_session(tenant_id) as s:
        ha, hb = await s.get(Webhook, uuid.UUID(a)), await s.get(Webhook, uuid.UUID(b))
        assert (ha.status, ha.paused_reason) == ("paused", "creator_disabled")
        # Still an approver: not paused, but no longer an owner's, so the content goes off.
        assert hb.status == "active" and hb.include_approvers_content is False
    resp = await client.patch(
        f"/v1/members/{second.user.id}", json={"role": "commenter"}, headers=owner.headers
    )
    async with tenant_session(tenant_id) as s:
        hb = await s.get(Webhook, uuid.UUID(b))
        assert (hb.status, hb.paused_reason) == ("paused", "creator_demoted")


async def _paused_rows(client, headers) -> list[dict]:
    inbox = (await client.get("/v1/me/notifications", headers=headers)).json()
    return [n for n in inbox if n["kind"] == "webhook_paused"]


async def test_a_member_change_pausing_a_webhook_puts_a_row_on_every_owners_inbox(
    client, tenant_id
):
    """protects=lane 1 scope ("Inbox rows for member changes"; #625 review major 2): a
    disable or a demotion that pauses a webhook gives each owner, the one who made the
    change included, one Inbox row naming the webhook, with Resume and Take over;
    fails_when=the pause is only in the audit, or an owner gets none or two."""
    owner = await make_person(tenant_id, "owner@example.com", "owner")
    second = await make_person(tenant_id, "second.owner@example.com", "owner")
    approver = await make_person(tenant_id, "approver@example.com", "approver")
    other = await make_person(tenant_id, "other.approver@example.com", "approver")
    a = await _hook(client, approver.headers, ["run.started"])
    b = await _hook(client, other.headers, ["run.started"])
    resp = await client.post(
        f"/v1/members/{approver.user.id}/disable", json={}, headers=owner.headers
    )
    assert resp.status_code == 200, resp.text
    for person in (owner, second):
        (row,) = await _paused_rows(client, person.headers)
        assert row["title"] == "Webhook Bot paused: Approver was disabled"
        assert row["data"]["webhook_id"] == a
        assert row["data"]["reason"] == "creator_disabled"
        assert row["data"]["actions"] == ["resume", "take_over"]
        assert row["data"]["href"] == "/settings/webhooks"
    resp = await client.patch(
        f"/v1/members/{other.user.id}", json={"role": "commenter"}, headers=owner.headers
    )
    assert resp.status_code == 200, resp.text
    for person in (owner, second):
        rows = [
            n for n in await _paused_rows(client, person.headers) if n["data"]["webhook_id"] == b
        ]
        (row,) = rows
        assert row["title"] == "Webhook Bot paused: Other Approver is no longer an approver"
        assert row["data"]["reason"] == "creator_demoted"
        assert row["data"]["actions"] == ["resume", "take_over"]
    # A paused webhook does not pause again: a later change writes no second row.
    resp = await client.patch(
        f"/v1/members/{other.user.id}", json={"role": "viewer"}, headers=owner.headers
    )
    assert resp.status_code == 200, resp.text
    assert len(await _paused_rows(client, owner.headers)) == 2


# --- OpenAPI ----------------------------------------------------------------------------------


def test_openapi_documents_every_type_as_a_webhook_with_its_schema():
    """protects=spec Payloads (OpenAPI 3.1 webhooks: and WebhookEvent_<type> components);
    fails_when=a type is missing from either."""
    from oracle.main import app

    doc = app.openapi()
    schemas = doc["components"]["schemas"]
    for name in V1:
        assert f"WebhookEvent_{name}" in schemas, name
        body = doc["webhooks"][name]["post"]["requestBody"]["content"]["application/json"]
        assert body["schema"] == {"$ref": f"#/components/schemas/WebhookEvent_{name}"}


# --- a run's life (AC3) -----------------------------------------------------------------------


async def test_a_run_through_one_checkpoint_is_captured_once_per_change(client):
    """protects=AC3: running -> awaiting_checkpoint -> (approve) -> succeeded produces
    run.started, run.checkpoint_waiting, run.checkpoint_decided (approved) and run.succeeded,
    once each; an unsubscribed type is not captured; fails_when=one is missing, doubled, or
    carries the checkpoint note."""
    from oracle.runs import flows
    from oracle.swarm import FakeRuntime, set_runtime
    from tests.test_runs import decide, get, started, tick

    set_runtime(FakeRuntime())
    try:
        tenant_id, auth = await seed_auth()
        wanted = ["run.started", "run.checkpoint_waiting", "run.checkpoint_decided"]
        await _hook(client, auth, [*wanted, "run.succeeded"])
        # The PRD review alone: every other stop off (the Engineering dates segment, off,
        # is skipped).
        keys = list(flows.FLOWS["baseline_to_prd"].checkpoints)
        knobs = {**dict.fromkeys(keys, False), "prd_review": True}
        run = await started(client, auth, checkpoints=knobs)
        for _ in range(6):
            if run["status"] != "running":
                break
            await tick(client, auth)
            run = await get(client, auth, run["id"])
        assert run["status"] == "awaiting_checkpoint", run["status"]
        run = await decide(client, auth, run, note="Private note text")
        for _ in range(3):
            if run["status"] == "succeeded":
                break
            await tick(client, auth)
            run = await get(client, auth, run["id"])
        assert run["status"] == "succeeded"
    finally:
        set_runtime(None)
    got = await _events(tenant_id)
    assert [e.type for e in got] == [*wanted, "run.succeeded"]
    decided = got[2]
    assert decided.subject["outcome"] == "approved" and decided.subject["run_id"] == run["id"]
    assert all("Private note" not in str(e.subject) for e in got)
