"""CR-06 review correctness (build prompt §9, §16.10): review state per stable section id
and revision; an approval binds to the exact revision; a substantive edit or an
accepted AI patch invalidates only the affected section's approval and requests
re-review; reviewers comment in parallel; the final decider approves current versions
only, and mandatory reviewers are needed only when configured."""

import asyncio

from sqlalchemy import select

from oracle.models import AuditEvent, ChangeEvent
from oracle.review.models import Notification
from oracle.tenancy import tenant_session
from tests.review_v2_helpers import (
    DOC,
    DRAFT,
    edit,
    import_md,
    person,
    replace,
    setup,
    states,
    verdict,
)


async def test_states_start_unreviewed_with_revisions(client):
    ctx = await setup(client)
    resp = await client.get(ctx.v(1, "/section-states"), headers=ctx.auth)
    body = resp.json()
    assert body["version"] == 1 and body["latest_version"] == 1
    by_key = {s["section_key"]: s for s in body["sections"]}
    assert list(by_key) == ["title", "goal-trace", "problem", "solution", "risks", "sources"]
    assert {s["status"] for s in body["sections"]} == {"unreviewed"}
    assert body["counts"] == {"unreviewed": 6}
    version = (await client.get(ctx.v(1), headers=ctx.auth)).json()
    revisions = {s["section_key"]: s["revision"] for s in version["sections"]}
    assert all(by_key[k]["revision"] == r for k, r in revisions.items())
    # A detail section that cites nothing: its revision is its content hash; one that
    # cites evidence covers the citation entries too.
    hashes = {s["section_key"]: s["content_hash"] for s in version["sections"]}
    assert revisions["problem"] == hashes["problem"]
    assert revisions["goal-trace"] != hashes["goal-trace"]
    assert by_key["problem"]["revision_since_version"] == 1


async def test_an_approval_binds_to_its_revision_and_carries_to_unchanged_sections(client):
    ctx = await setup(client)
    approver = await person(ctx.tenant_id, "approver")
    for key in ("problem", "solution"):
        resp = await verdict(client, approver.headers, 1, key)
        assert resp.status_code == 200 and resp.json()["section_hash"]
    v2 = replace(DRAFT, "Teams miss shared deadlines.", "Teams miss shared deadlines weekly.")
    assert (await import_md(client, ctx.auth, v2)).status_code == 201

    s2 = await states(client, ctx.auth, 2)
    # The unchanged section keeps its approval from version 1, bound to its revision.
    assert s2["solution"]["status"] == "approved"
    assert s2["solution"]["approval"]["version"] == 1
    assert s2["solution"]["approval"]["reviewer_id"] == str(approver.user_id)
    assert s2["solution"]["revision_since_version"] == 1
    # The changed one does not: its approval was for the old revision.
    assert s2["problem"]["status"] == "approval_stale"
    assert s2["problem"]["invalidated"]["revision"] == s2["problem"]["approval"]["revision"]
    assert s2["problem"]["revision"] != s2["problem"]["approval"]["revision"]
    assert s2["problem"]["rereview_requested"] is True
    assert s2["problem"]["revision_since_version"] == 2
    # Version 1 still reads as it was.
    s1 = await states(client, ctx.auth, 1)
    assert s1["problem"]["status"] == "approved"


async def test_an_edit_invalidates_only_the_affected_section(client):
    ctx = await setup(client)
    approver = await person(ctx.tenant_id, "approver")
    owner = await person(ctx.tenant_id, "commenter", "owner")
    reviewer = await person(ctx.tenant_id, "commenter", "reviewer")
    for key in ("problem", "solution", "risks"):
        assert (await verdict(client, approver.headers, 1, key)).status_code == 200
    s1 = await states(client, ctx.auth, 1)
    resp = await client.put(
        f"/v1/documents/{DOC}/sections/problem/assignment",
        json={"owner_id": str(owner.user_id), "reviewer_ids": [str(reviewer.user_id)]},
        headers=approver.headers,
    )
    assert resp.status_code == 200, resp.text

    resp = await edit(
        client, approver.headers, "problem", 1, s1["problem"]["revision"], "Deadlines slip."
    )
    assert resp.status_code == 201, resp.text
    assert resp.json()["number"] == 2

    s2 = await states(client, ctx.auth, 2)
    assert s2["problem"]["status"] == "approval_stale"
    assert s2["solution"]["status"] == "approved"
    assert s2["risks"]["status"] == "approved"

    async with tenant_session(ctx.tenant_id) as s:
        events = (await s.scalars(select(ChangeEvent))).all()
        # One change, for the edited section only, handled by the review lane's handler.
        assert [(e.subject_kind, e.cause, e.data["section_key"]) for e in events] == [
            ("document_section", "section_edited", "problem")
        ]
        assert "review.invalidate_approvals" in events[0].handled_by
        audits = (
            await s.scalars(
                select(AuditEvent).where(AuditEvent.action == "section_approval.invalidate")
            )
        ).all()
        assert [a.data["section_key"] for a in audits] == ["problem"]
        notes = (
            await s.scalars(select(Notification).where(Notification.kind == "rereview_requested"))
        ).all()
        # Owner, reviewer; the approver made the edit, so is not notified of it.
        assert {n.user_id for n in notes} == {owner.user_id, reviewer.user_id}

    # A new verdict on the new revision clears the re-review request.
    assert (await verdict(client, approver.headers, 2, "problem")).status_code == 200
    s2 = await states(client, ctx.auth, 2)
    assert s2["problem"]["status"] == "approved" and s2["problem"]["rereview_requested"] is False


async def test_an_invalidated_approval_never_comes_back(client):
    """Reverting the text to the approved revision does not revive the old approval."""
    ctx = await setup(client)
    s1 = await states(client, ctx.auth, 1)
    assert (await verdict(client, ctx.auth, 1, "problem")).status_code == 200
    original = "Teams miss shared deadlines."
    resp = await edit(client, ctx.auth, "problem", 1, s1["problem"]["revision"], "Changed.")
    assert resp.status_code == 201
    s2 = await states(client, ctx.auth, 2)
    resp = await edit(client, ctx.auth, "problem", 2, s2["problem"]["revision"], original)
    assert resp.status_code == 201
    s3 = await states(client, ctx.auth, 3)
    assert s3["problem"]["revision"] == s1["problem"]["revision"]
    assert s3["problem"]["status"] == "approval_stale"


async def test_an_accepted_ai_patch_invalidates_the_section_approval(client):
    """An agent's draft that rewrote an approved section leaves a patch; accepting it is
    the AI change that invalidates (and only for that section)."""
    from oracle.auth.deps import Principal
    from oracle.docs import service as docs_service

    ctx = await setup(client)
    for key in ("problem", "solution"):
        assert (await verdict(client, ctx.auth, 1, key)).status_code == 200
    agent_draft = replace(
        replace(DRAFT, "Teams miss shared deadlines.", "Agents rewrote the problem."),
        "Calendar sync may lag.",
        "Agents rewrote the risks.",
    )
    async with tenant_session(ctx.tenant_id) as s:
        owner = await person(ctx.tenant_id, "owner")
        principal = Principal(
            tenant_id=ctx.tenant_id, kind="user", role="owner", user_id=owner.user_id
        )
        result = await docs_service.import_draft(
            s, DOC, agent_draft, principal, cause="run_draft", origin="run"
        )
    v2 = result.version
    assert [w.code for w in v2.warnings] == ["approved_section_held"]
    bodies = {sec.section_key: sec.body_md for sec in v2.sections}
    # The approved section kept its approved text; the unapproved one took the rewrite.
    assert bodies["problem"] == "Teams miss shared deadlines."
    assert bodies["risks"] == "Agents rewrote the risks."
    s2 = await states(client, ctx.auth, 2)
    assert s2["problem"]["status"] == "approved"

    patches = (
        await client.get(f"/v1/documents/{DOC}/section-patches?status=open", headers=ctx.auth)
    ).json()
    assert [(p["section_key"], p["origin"]) for p in patches] == [("problem", "run")]
    detail = (await client.get(f"/v1/section-patches/{patches[0]['id']}", headers=ctx.auth)).json()
    assert detail["rebase_needed"] is False
    assert any(w["op"] != "equal" for w in detail["words"])
    resp = await client.post(
        f"/v1/section-patches/{patches[0]['id']}/accept",
        json={"base_revision": detail["current_revision"], "lock_version": detail["lock_version"]},
        headers=ctx.auth,
    )
    assert resp.status_code == 201, resp.text
    assert resp.json()["number"] == 3
    s3 = await states(client, ctx.auth, 3)
    assert s3["problem"]["status"] == "approval_stale"
    assert s3["solution"]["status"] == "approved"
    async with tenant_session(ctx.tenant_id) as s:
        causes = [
            (e.cause, e.data["section_key"])
            for e in (await s.scalars(select(ChangeEvent).order_by(ChangeEvent.created_at)))
        ]
    assert ("patch_accepted", "problem") in causes
    assert ("patch_accepted", "solution") not in causes


async def test_two_reviewers_comment_concurrently_on_different_sections(client):
    ctx = await setup(client)
    a = await person(ctx.tenant_id, "commenter", "a")
    b = await person(ctx.tenant_id, "commenter", "b")

    async def comment(who, key, exact):
        return await client.post(
            ctx.v(1, "/comments"),
            json={"section_key": key, "anchor": {"exact": exact}, "body": f"{key}?"},
            headers=who.headers,
        )

    r1, r2 = await asyncio.gather(
        comment(a, "problem", "shared deadlines"), comment(b, "solution", "shared calendar")
    )
    assert r1.status_code == r2.status_code == 201
    listed = (await client.get(ctx.v(1, "/comments"), headers=ctx.auth)).json()
    assert sorted(c["section_key"] for c in listed) == ["problem", "solution"]


async def test_a_verdict_on_a_stale_revision_is_a_conflict(client):
    ctx = await setup(client)
    s1 = await states(client, ctx.auth, 1)
    old = s1["problem"]["revision"]
    assert (await edit(client, ctx.auth, "problem", 1, old, "New text.")).status_code == 201
    resp = await verdict(client, ctx.auth, 1, "problem", revision=old)
    assert resp.status_code == 409
    body = resp.json()
    assert body["code"] == "section_conflict" and body["latest_version"] == 2
    assert body["sections"][0]["current_body_md"] == "New text."
    # Without a revision the legacy per-version verdict still works.
    assert (await verdict(client, ctx.auth, 1, "problem")).status_code == 200
    # And with the current revision on the latest version.
    s2 = await states(client, ctx.auth, 2)
    resp = await verdict(client, ctx.auth, 2, "problem", revision=s2["problem"]["revision"])
    assert resp.status_code == 200


async def test_the_decider_approves_current_versions_only(client):
    ctx = await setup(client)
    decider = await person(ctx.tenant_id, "approver", "decider")
    other = await person(ctx.tenant_id, "approver", "other")
    resp = await client.put(
        f"/v1/documents/{DOC}/review-policy",
        json={"decider_id": str(decider.user_id)},
        headers=ctx.auth,
    )
    assert resp.status_code == 200, resp.text
    assert resp.json()["source"] == "document"

    # Other approvers review sections in parallel, but do not give the final approval.
    assert (await verdict(client, other.headers, 1, "problem")).status_code == 200
    assert (await client.post(ctx.v(1, "/approve"), headers=other.headers)).status_code == 403

    v2 = replace(DRAFT, "Calendar sync may lag.", "Calendar sync may lag by a day.")
    assert (await import_md(client, ctx.auth, v2)).status_code == 201
    # Version 1 is no longer current.
    resp = await client.post(ctx.v(1, "/approve"), headers=decider.headers)
    assert resp.status_code == 409 and "current version" in resp.json()["detail"]
    resp = await client.post(ctx.v(2, "/approve"), headers=decider.headers)
    assert resp.status_code == 200
    assert resp.json()["version"]["approved_at"]


async def test_no_unanimity_unless_mandatory_reviewers_are_configured(client):
    ctx = await setup(client)
    decider = await person(ctx.tenant_id, "approver", "decider")
    legal = await person(ctx.tenant_id, "approver", "legal")
    await client.put(
        f"/v1/documents/{DOC}/review-policy",
        json={"decider_id": str(decider.user_id), "section_approval": "none"},
        headers=ctx.auth,
    )
    assert (await client.post(ctx.v(1, "/approve"), headers=decider.headers)).status_code == 200
    check = (await client.get(ctx.v(1, "/publish-check"), headers=ctx.auth)).json()
    # One decider is enough: nobody else had to approve.
    assert check["can_publish"] is True, check["blockers"]

    policy = (await client.get(f"/v1/documents/{DOC}/review-policy", headers=ctx.auth)).json()
    resp = await client.put(
        f"/v1/documents/{DOC}/review-policy",
        json={
            "decider_id": str(decider.user_id),
            "section_approval": "none",
            "mandatory_reviewer_ids": [str(legal.user_id)],
            "lock_version": policy["lock_version"],
        },
        headers=ctx.auth,
    )
    assert resp.status_code == 200, resp.text
    check = (await client.get(ctx.v(1, "/publish-check"), headers=ctx.auth)).json()
    pending = [b for b in check["blockers"] if b["code"] == "mandatory_reviewer_pending"]
    assert pending and pending[0]["ids"] == [str(legal.user_id)]
    s1 = await states(client, ctx.auth, 1)
    assert s1["problem"]["mandatory_approvals"] == [
        {"reviewer_id": str(legal.user_id), "approved": False}
    ]
    for key in s1:
        assert (await verdict(client, legal.headers, 1, key)).status_code == 200
    check = (await client.get(ctx.v(1, "/publish-check"), headers=ctx.auth)).json()
    assert check["can_publish"] is True, check["blockers"]


async def test_policy_validation_and_company_default(client):
    ctx = await setup(client)
    commenter = await person(ctx.tenant_id, "commenter")
    resp = await client.put(
        f"/v1/documents/{DOC}/review-policy",
        json={"decider_id": str(commenter.user_id)},
        headers=ctx.auth,
    )
    assert resp.status_code == 422 and "approver" in resp.json()["detail"]
    decider = await person(ctx.tenant_id, "approver")
    resp = await client.put(
        "/v1/settings/review_policy",
        json={"value": {"decider_id": str(decider.user_id)}},
        headers=ctx.auth,
    )
    assert resp.status_code == 200, resp.text
    policy = (await client.get(f"/v1/documents/{DOC}/review-policy", headers=ctx.auth)).json()
    assert policy["source"] == "company" and policy["decider_id"] == str(decider.user_id)
    # Only an owner sets a document's policy.
    approver = await person(ctx.tenant_id, "approver")
    resp = await client.put(f"/v1/documents/{DOC}/review-policy", json={}, headers=approver.headers)
    assert resp.status_code == 403
    # A stale lock_version is a 409 a save can act on.
    resp = await client.put(f"/v1/documents/{DOC}/review-policy", json={}, headers=ctx.auth)
    assert resp.status_code == 200
    resp = await client.put(
        f"/v1/documents/{DOC}/review-policy", json={"lock_version": 7}, headers=ctx.auth
    )
    assert resp.status_code == 409
    assert resp.json()["code"] == "stale_lock_version"
    assert resp.json()["current_lock_version"] == 1


async def test_severity_classifies_change_requests(client):
    ctx = await setup(client)
    resp = await client.post(
        ctx.v(1, "/comments"),
        json={
            "section_key": "problem",
            "anchor": {"exact": "shared deadlines"},
            "body": "Which deadlines?",
            "severity": "critical",
        },
        headers=ctx.auth,
    )
    assert resp.status_code == 201
    resp = await verdict(
        client, ctx.auth, 1, "risks", "changes_requested", note="Name the lag", severity="minor"
    )
    assert resp.status_code == 200
    items = (await client.get(f"/v1/documents/{DOC}/feedback", headers=ctx.auth)).json()
    assert sorted((i["section_key"], i["severity"]) for i in items) == [
        ("problem", "critical"),
        ("risks", "minor"),
    ]
    s1 = await states(client, ctx.auth, 1)
    assert s1["problem"]["open_by_severity"] == {"critical": 1}
    resp = await client.patch(
        f"/v1/feedback/{items[0]['id']}",
        json={"severity": "major", "status": "addressed", "resolution_note": "Clarified"},
        headers=ctx.auth,
    )
    assert resp.status_code == 200 and resp.json()["severity"] == "major"
    resp = await client.patch(
        f"/v1/feedback/{items[0]['id']}", json={"severity": "huge"}, headers=ctx.auth
    )
    assert resp.status_code == 422
