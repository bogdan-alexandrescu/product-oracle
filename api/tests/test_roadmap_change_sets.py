"""Edit the approved plan as a change set and propose it as a new roadmap version (#346):
change-set CRUD with its audit trail, the proposed version's items are the base's plus
the changes, only the document's decider approves it (and approving it makes it the live
plan), a stale base is refused with a clear message, and roles. Against Postgres with
the FakeRuntime."""

import uuid

from sqlalchemy import select

from oracle.auth.service import create_user, make_session_cookie
from oracle.baseline.models import Entity
from oracle.config import get_settings
from oracle.models import AuditEvent
from oracle.roadmap.models import RoadmapItem
from oracle.tenancy import tenant_session
from tests.fixtures import import_draft
from tests.roadmap_helpers import other_company
from tests.test_roadmap import (  # noqa: F401 - fixtures
    ROADMAP,
    ROADMAP_MD,
    approved_prd,
    as_user,
    built_roadmap,
    owner,
    runtime,
    seed_baseline,
)

SETS = f"/v1/roadmaps/{ROADMAP}/change-sets"
# Statements one propose runs (test_proposing_a_plan_of_many_coded_items_reads_each_item_once).
MAX_PROPOSE_STATEMENTS = 90


async def approved_roadmap(client, auth, runtime) -> None:  # noqa: F811
    """Checkout roadmap v1 (Payment step in Now, Shipping step in Next), approved."""
    await approved_prd(client, auth)
    await built_roadmap(client, auth, runtime)
    resp = await client.post(f"/v1/documents/{ROADMAP}/versions/1/approve", headers=auth)
    assert resp.status_code == 200, resp.text


async def member(tenant_id: uuid.UUID, role: str) -> tuple[uuid.UUID, dict[str, str]]:
    async with tenant_session(tenant_id) as s:
        user = await create_user(s, f"{role}-{uuid.uuid4().hex[:6]}@example.com", "pw")
        user.role = role
        await s.commit()
    cookie = f"{get_settings().session_cookie_name}={make_session_cookie(user)}"
    return user.id, {"Cookie": cookie}


async def patch(client, auth, out: dict, changes: list[dict]):
    return await client.patch(
        f"{SETS}/{out['id']}",
        json={"changes": changes, "lock_version": out["lock_version"]},
        headers=auth,
    )


CHANGES = [
    {"op": "move", "key": "payment-step", "horizon": "next"},
    {"op": "cut", "key": "shipping-step", "reason": "Shipping moves to the carrier's app"},
    {"op": "add", "title": "Gift cards", "horizon": "next"},
    {"op": "reorder", "key": "gift-cards", "position": 0},
]


async def test_change_set_crud_and_audit(client, owner, runtime):  # noqa: F811
    tenant_id, auth = owner
    await approved_roadmap(client, auth, runtime)

    resp = await client.post(SETS, headers=auth)
    assert resp.status_code == 201, resp.text
    out = resp.json()
    assert out["status"] == "draft" and out["base_version"] == 1 and out["changes"] == []
    assert [(i["key"], i["horizon"]) for i in out["items"]] == [
        ("payment-step", "now"),
        ("shipping-step", "next"),
    ]
    # Edit plan again: the same draft (one per roadmap).
    again = await client.post(SETS, headers=auth)
    assert again.status_code == 200 and again.json()["id"] == out["id"]

    resp = await patch(client, auth, out, CHANGES)
    assert resp.status_code == 200, resp.text
    edited = resp.json()
    assert edited["lock_version"] == out["lock_version"] + 1
    assert [c["op"] for c in edited["changes"]] == ["move", "cut", "add", "reorder"]
    assert edited["changes"][2]["key"] == "gift-cards"
    assert [(i["key"], i["horizon"], i["new"]) for i in edited["items"]] == [
        ("gift-cards", "next", True),
        ("payment-step", "next", False),
    ]
    assert edited["cut"] == [
        {"key": "shipping-step", "title": "Shipping step", "horizon": "next",
         "reason": "Shipping moves to the carrier's app"}
    ]  # fmt: skip
    diff = {d["key"]: d for d in edited["diff"]}
    assert diff["payment-step"]["status"] == "moved"
    assert (diff["payment-step"]["from_horizon"], diff["payment-step"]["to_horizon"]) == (
        "now",
        "next",
    )
    assert diff["shipping-step"]["status"] == "dropped"
    assert diff["shipping-step"]["reason"] == "Shipping moves to the carrier's app"
    assert diff["gift-cards"]["status"] == "added"
    got = (await client.get(f"{SETS}/{out['id']}", headers=auth)).json()
    assert got["changes"] == edited["changes"] and got["items"] == edited["items"]

    # A copy loaded before the edit is refused; so is a change that does not apply.
    stale = await patch(client, auth, out, [])
    assert stale.status_code == 409 and "changed since it was loaded" in stale.json()["detail"]
    unknown = await patch(client, auth, edited, [{"op": "move", "key": "nope", "horizon": "now"}])
    assert unknown.status_code == 422 and "nope is not an item" in unknown.json()["detail"]
    no_reason = await patch(client, auth, edited, [{"op": "cut", "key": "payment-step"}])
    assert no_reason.status_code == 422
    twice = await patch(
        client, auth, edited, [{"op": "add", "title": "Payment step", "horizon": "later"}]
    )
    assert twice.status_code == 422 and "has an item payment-step" in twice.json()["detail"]

    # A Baseline feature takes its key.
    await seed_baseline(tenant_id)
    async with tenant_session(tenant_id) as s:
        feature = await s.scalar(
            select(Entity).where(Entity.type == "feature", Entity.key == "shipping-step")
        )
    resp = await patch(
        client, auth, edited,
        [{"op": "add", "title": feature.title, "horizon": "later", "feature_id": str(feature.id)}],
    )  # fmt: skip
    assert resp.status_code == 422 and "has an item shipping-step" in resp.json()["detail"]

    resp = await client.delete(f"{SETS}/{out['id']}", headers=auth)
    assert resp.status_code == 200 and resp.json()["status"] == "discarded"
    after = await patch(client, auth, resp.json(), [])
    assert after.status_code == 409 and "discarded" in after.json()["detail"]
    fresh = await client.post(SETS, headers=auth)
    assert fresh.status_code == 201 and fresh.json()["id"] != out["id"]

    async with tenant_session(tenant_id) as s:
        actions = [
            e.action
            for e in await s.scalars(
                select(AuditEvent)
                .where(AuditEvent.entity == "roadmap_change_set")
                .order_by(AuditEvent.created_at)
            )
        ]
    assert actions == [
        "roadmap.change_set_opened",
        "roadmap.change_set_updated",
        "roadmap.change_set_discarded",
        "roadmap.change_set_opened",
    ]


async def test_proposed_version_is_the_base_plus_the_changes(client, owner, runtime):  # noqa: F811
    tenant_id, auth = owner
    await approved_roadmap(client, auth, runtime)
    out = (await client.post(SETS, headers=auth)).json()
    edited = (await patch(client, auth, out, CHANGES)).json()

    resp = await client.post(f"{SETS}/{out['id']}/propose", headers=auth)
    assert resp.status_code == 200, resp.text
    proposed = resp.json()
    assert proposed["status"] == "proposed" and proposed["proposed_version"] == 2
    assert proposed["diff"] == edited["diff"]

    items = (
        await client.get(f"/v1/roadmaps/{ROADMAP}/items", params={"version": 2}, headers=auth)
    ).json()["items"]
    assert [(i["item_key"], i["horizon"], i["title"]) for i in items] == [
        (i["key"], i["horizon"], i["title"]) for i in edited["items"]
    ]
    pay = next(i for i in items if i["item_key"] == "payment-step")
    # Copied with its trace; out of Now, its date is dropped (O4).
    assert pay["prd"]["section_key"] == "s-5-1" and pay["milestone"]["date"] is None
    # The approved version is untouched, and the new one waits for approval.
    base = (
        await client.get(f"/v1/roadmaps/{ROADMAP}/items", params={"version": 1}, headers=auth)
    ).json()["items"]
    assert [(i["item_key"], i["horizon"]) for i in base] == [
        ("payment-step", "now"),
        ("shipping-step", "next"),
    ]
    v2 = (await client.get(f"/v1/documents/{ROADMAP}/versions/2", headers=auth)).json()
    assert v2["approved_at"] is None
    section = next(s for s in v2["sections"] if s["section_key"] == "plan-changes")
    assert "Cut Shipping step: Shipping moves to the carrier's app" in section["body_md"]
    assert "Moved Payment step to Next" in section["body_md"]

    # Proposed: no more edits, and no second proposal.
    assert (await patch(client, auth, proposed, [])).status_code == 409
    again = await client.post(f"{SETS}/{out['id']}/propose", headers=auth)
    assert again.status_code == 409
    # Nothing to propose.
    empty = (await client.post(SETS, headers=auth)).json()
    resp = await client.post(f"{SETS}/{empty['id']}/propose", headers=auth)
    assert resp.status_code == 422 and "Nothing to propose" in resp.json()["detail"]


async def test_only_the_decider_approves_and_it_becomes_the_plan(client, owner, runtime):  # noqa: F811
    tenant_id, auth = owner
    await approved_roadmap(client, auth, runtime)
    decider_id, decider = await member(tenant_id, "approver")
    resp = await client.put(
        f"/v1/documents/{ROADMAP}/review-policy",
        json={"decider_id": str(decider_id), "section_approval": "none"},
        headers=auth,
    )
    assert resp.status_code == 200, resp.text
    out = (await client.post(SETS, headers=auth)).json()
    assert out["decider_id"] == str(decider_id)
    await patch(client, auth, out, CHANGES)
    assert (await client.post(f"{SETS}/{out['id']}/propose", headers=auth)).status_code == 200

    refused = await client.post(f"/v1/documents/{ROADMAP}/versions/2/approve", headers=auth)
    assert refused.status_code == 403
    assert "designated decider" in refused.json()["detail"]
    plan = (await client.get("/v1/plan", params={"scope": "approved"}, headers=auth)).json()
    assert {i["roadmap"]["version"] for i in plan["items"]} == {1}

    # The decider finds the proposal waiting.
    (waiting,) = (await client.get(SETS, params={"status": "proposed"}, headers=decider)).json()
    assert waiting["id"] == out["id"] and waiting["approved"] is False
    ok = await client.post(f"/v1/documents/{ROADMAP}/versions/2/approve", headers=decider)
    assert ok.status_code == 200, ok.text
    assert (await client.get(f"{SETS}/{out['id']}", headers=auth)).json()["approved"] is True
    plan = (await client.get("/v1/plan", params={"scope": "approved"}, headers=auth)).json()
    assert [(i["key"], i["horizon"], i["roadmap"]["version"]) for i in plan["items"]] == [
        ("gift-cards", "next", 2),
        ("payment-step", "next", 2),
    ]


async def test_a_stale_base_is_refused(client, owner, runtime):  # noqa: F811
    tenant_id, auth = owner
    await approved_roadmap(client, auth, runtime)
    out = (await client.post(SETS, headers=auth)).json()
    edited = (await patch(client, auth, out, CHANGES[:1])).json()
    # Meanwhile a new roadmap version is imported and approved.
    md = ROADMAP_MD.replace("payment first, then shipping", "payment first")
    assert (await import_draft(client, auth, md, doc=ROADMAP)).status_code == 201
    resp = await client.post(f"/v1/documents/{ROADMAP}/versions/2/approve", headers=auth)
    assert resp.status_code == 200, resp.text

    for resp in (
        await patch(client, auth, edited, CHANGES),
        await client.post(f"{SETS}/{out['id']}/propose", headers=auth),
    ):
        assert resp.status_code == 409
        assert resp.json()["detail"] == (
            "The approved plan changed: these changes were made on version 1 and version 2 "
            "is approved now. Discard them and edit the plan again."
        )
    # Discarded, the plan is edited again on version 2.
    assert (await client.delete(f"{SETS}/{out['id']}", headers=auth)).status_code == 200
    fresh = (await client.post(SETS, headers=auth)).json()
    assert fresh["base_version"] == 2


async def test_roles_and_companies(client, owner, runtime):  # noqa: F811
    tenant_id, auth = owner
    await approved_roadmap(client, auth, runtime)
    out = (await client.post(SETS, headers=auth)).json()
    for role in ("viewer", "commenter"):
        headers = await as_user(tenant_id, role)
        assert (await client.post(SETS, headers=headers)).status_code == 403
        assert (await patch(client, headers, out, CHANGES)).status_code == 403
        propose = await client.post(f"{SETS}/{out['id']}/propose", headers=headers)
        assert propose.status_code == 403
        assert (await client.delete(f"{SETS}/{out['id']}", headers=headers)).status_code == 403
        # Everyone reads.
        assert (await client.get(f"{SETS}/{out['id']}", headers=headers)).status_code == 200
    other = await other_company()
    assert (await client.get(f"{SETS}/{out['id']}", headers=other)).status_code == 404
    assert (await client.post(SETS, headers=other)).status_code == 404


SUPERSEDED = (
    "Version 2 was superseded by version 3, a later proposal of plan changes: it can't be "
    "approved. Approve version 3 instead."
)


async def test_a_later_proposal_supersedes_the_waiting_one(client, owner, runtime):  # noqa: F811
    """protects=proposing a second change set while version 2 waits marks the first
    ``superseded`` (by version 3, audited), it leaves the waiting list, and approving version
    2 is a 409 saying it was superseded; version 3 is approved and is the plan;
    fails_when=version 2 still reads as waiting, or its approval fails with a message that
    does not say why; no_claim=the Plan's UI (e2e/plan-edit.spec.ts)."""
    tenant_id, auth = owner
    await approved_roadmap(client, auth, runtime)
    first = (await client.post(SETS, headers=auth)).json()
    await patch(client, auth, first, CHANGES[:1])
    assert (await client.post(f"{SETS}/{first['id']}/propose", headers=auth)).status_code == 200
    # Version 2 waits; the plan is edited again on version 1 and proposed as version 3.
    second = await client.post(SETS, headers=auth)
    assert second.status_code == 201, second.text
    second = second.json()
    assert second["base_version"] == 1
    await patch(client, auth, second, CHANGES[1:2])
    resp = await client.post(f"{SETS}/{second['id']}/propose", headers=auth)
    assert resp.status_code == 200 and resp.json()["proposed_version"] == 3

    old = (await client.get(f"{SETS}/{first['id']}", headers=auth)).json()
    assert (old["status"], old["proposed_version"], old["superseded_by_version"]) == (
        "superseded",
        2,
        3,
    )
    assert old["approved"] is False
    waiting = (await client.get(SETS, params={"status": "proposed"}, headers=auth)).json()
    assert [s["id"] for s in waiting] == [second["id"]]
    assert waiting[0]["superseded_by_version"] is None
    listed = (await client.get(SETS, params={"status": "superseded"}, headers=auth)).json()
    assert [s["id"] for s in listed] == [first["id"]]

    refused = await client.post(f"/v1/documents/{ROADMAP}/versions/2/approve", headers=auth)
    assert refused.status_code == 409
    assert refused.json()["detail"] == SUPERSEDED
    ok = await client.post(f"/v1/documents/{ROADMAP}/versions/3/approve", headers=auth)
    assert ok.status_code == 200, ok.text
    plan = (await client.get("/v1/plan", params={"scope": "approved"}, headers=auth)).json()
    assert {i["roadmap"]["version"] for i in plan["items"]} == {3}
    # Superseded is final: it is not edited, proposed or discarded.
    assert (await client.post(f"{SETS}/{first['id']}/propose", headers=auth)).status_code == 409
    assert (await client.delete(f"{SETS}/{first['id']}", headers=auth)).status_code == 409

    async with tenant_session(tenant_id) as s:
        event = await s.scalar(
            select(AuditEvent).where(AuditEvent.action == "roadmap.change_set_superseded")
        )
    assert event is not None and event.entity_id == uuid.UUID(first["id"])
    assert (event.data["version"], event.data["superseded_by_version"]) == (2, 3)


async def test_a_failed_proposal_leaves_no_version(client, owner, runtime, monkeypatch):  # noqa: F811
    """protects=propose is one transaction: a failure after the new version is imported
    (its items written, as the waiting proposals are superseded) leaves no version 2, the
    document as it was and the change set a draft, and proposing again then works;
    fails_when=the import commits the version on its own, so the failure leaves a version
    with no items; no_claim=the UI."""
    from oracle.docs.models import Document, DocumentVersion
    from oracle.roadmap import changeset

    tenant_id, auth = owner
    await approved_roadmap(client, auth, runtime)
    out = (await client.post(SETS, headers=auth)).json()
    await patch(client, auth, out, CHANGES)

    async def fail(*args, **kwargs):
        raise changeset.ChangeSetError("injected failure after the version was created")

    monkeypatch.setattr(changeset, "_supersede", fail)
    resp = await client.post(f"{SETS}/{out['id']}/propose", headers=auth)
    assert resp.status_code == 422 and "injected failure" in resp.json()["detail"]

    async with tenant_session(tenant_id) as s:
        document = await s.scalar(select(Document).where(Document.slug == ROADMAP))
        numbers = list(
            await s.scalars(
                select(DocumentVersion.number).where(DocumentVersion.document_id == document.id)
            )
        )
        assert numbers == [1]
        assert document.status == "approved"
        proposed = await s.scalar(
            select(AuditEvent).where(AuditEvent.action == "roadmap.change_set_proposed")
        )
        assert proposed is None
    got = (await client.get(f"{SETS}/{out['id']}", headers=auth)).json()
    assert (got["status"], got["proposed_version"]) == ("draft", None)

    monkeypatch.undo()
    resp = await client.post(f"{SETS}/{out['id']}/propose", headers=auth)
    assert resp.status_code == 200, resp.text
    assert resp.json()["proposed_version"] == 2
    items = (
        await client.get(f"/v1/roadmaps/{ROADMAP}/items", params={"version": 2}, headers=auth)
    ).json()["items"]
    assert [i["item_key"] for i in items] == ["gift-cards", "payment-step"]


async def test_a_hidden_roadmaps_change_sets_are_hidden(client, owner, runtime):  # noqa: F811
    """protects=a real change set (a draft and a proposal) of a roadmap open to owners and
    approvers only is absent for a commenter or viewer: the list, the set by id (by slug
    and by the document's id) and every write are 404 and never name it, while an
    approver reads it; fails_when=a change-set read or write reaches the set without the
    document's visibility rule; no_claim=the UI."""
    from oracle.docs.models import Document

    tenant_id, auth = owner
    await approved_roadmap(client, auth, runtime)
    proposal = (await client.post(SETS, headers=auth)).json()
    await patch(client, auth, proposal, CHANGES)
    assert (await client.post(f"{SETS}/{proposal['id']}/propose", headers=auth)).status_code == 200
    draft_set = (await client.post(SETS, headers=auth)).json()
    async with tenant_session(tenant_id) as s:
        document = await s.scalar(select(Document).where(Document.slug == ROADMAP))
        document.visibility = "approvers"
        doc_id = document.id
        await s.commit()

    approver = await as_user(tenant_id, "approver")
    listed = await client.get(SETS, headers=approver)
    assert listed.status_code == 200
    assert {s["id"] for s in listed.json()} == {proposal["id"], draft_set["id"]}
    for role in ("commenter", "viewer"):
        headers = await as_user(tenant_id, role)
        for base in (SETS, f"/v1/roadmaps/{doc_id}/change-sets"):
            resp = await client.get(base, headers=headers)
            assert resp.status_code == 404, (role, resp.text)
            for set_id in (proposal["id"], draft_set["id"]):
                resp = await client.get(f"{base}/{set_id}", headers=headers)
                assert resp.status_code == 404, (role, resp.text)
                assert set_id not in resp.text and "Gift cards" not in resp.text
        # The writes the role may not make anyway are as absent as the reads.
        assert (await client.post(SETS, headers=headers)).status_code in (403, 404)
    assert (await client.get(f"{SETS}/{draft_set['id']}", headers=approver)).status_code == 200


async def test_the_change_set_list_pages(client, owner, runtime):  # noqa: F811
    """protects=the change-set list pages with ``limit`` and ``offset`` like the other
    lists, newest first, so a roadmap with more than one page of change sets reaches
    them all; fails_when=the list ignores the paging and stops at a fixed 50 rows;
    no_claim=the UI."""
    tenant_id, auth = owner
    await approved_roadmap(client, auth, runtime)
    made = []
    for _ in range(3):
        out = (await client.post(SETS, headers=auth)).json()
        made.append(out["id"])
        if len(made) < 3:
            assert (await client.delete(f"{SETS}/{out['id']}", headers=auth)).status_code == 200
    newest_first = list(reversed(made))

    first = await client.get(SETS, params={"limit": 2}, headers=auth)
    assert first.status_code == 200, first.text
    assert [s["id"] for s in first.json()] == newest_first[:2]
    rest = await client.get(SETS, params={"limit": 2, "offset": 2}, headers=auth)
    assert [s["id"] for s in rest.json()] == newest_first[2:]
    assert [s["id"] for s in (await client.get(SETS, headers=auth)).json()] == newest_first
    assert (await client.get(SETS, params={"limit": 0}, headers=auth)).status_code == 422
    assert (await client.get(SETS, params={"limit": 101}, headers=auth)).status_code == 422


async def test_an_added_item_never_takes_a_code_another_item_has(client, owner, runtime):  # noqa: F811
    """protects=(every-field) Edit plan's Add an item never gives a code to a second item: a
    title leading with a live item's code, or a picked Ground Truth feature whose code is a
    live item's title code, is refused when added (422) in set_code's words; one taken after it
    was added is refused at propose (409) and no version is made; fails_when=the proposed
    version holds two items reading F-31; no_claim=Simple's own add (its own test)."""
    tenant_id, auth = owner
    await approved_roadmap(client, auth, runtime)
    async with tenant_session(tenant_id) as s:
        row = await s.scalar(select(RoadmapItem).where(RoadmapItem.item_key == "shipping-step"))
        row.title = "F-31 Alert routing by team"
        feature = Entity(type="feature", key="F-31", title="Launch flow", status="confirmed",
                         origin="user", attrs={})  # fmt: skip
        s.add(feature)
        await s.flush()
        fid = str(feature.id)
        await s.commit()
    out = (await client.post(SETS, headers=auth)).json()
    taken = "F-31 is already the code of F-31 Alert routing by team"
    r = await patch(
        client, auth, out, [{"op": "add", "title": "F-31 Launch flow", "horizon": "next"}]
    )
    assert r.status_code == 422, r.text
    assert r.json()["detail"] == taken
    r = await patch(client, auth, out, [{"op": "add", "title": "Launch flow", "horizon": "next",
                                         "feature_id": fid}])  # fmt: skip
    assert r.status_code == 422, r.text
    assert r.json()["detail"] == taken
    two = [
        {"op": "add", "title": t, "horizon": "next"}
        for t in ("F-33 Night digest", "F-33 Launch flow")
    ]
    r = await patch(client, auth, out, two)
    assert r.status_code == 422, r.text
    assert r.json()["detail"] == "F-33 is already the code of F-33 Night digest"
    r = await patch(
        client, auth, out, [{"op": "add", "title": "F-32 Launch flow", "horizon": "next"}]
    )
    assert r.status_code == 200, r.text
    async with tenant_session(tenant_id) as s:
        row = await s.scalar(select(RoadmapItem).where(RoadmapItem.item_key == "shipping-step"))
        row.title = "F-32 Alert routing by team"
        await s.commit()
    r = await client.post(f"{SETS}/{out['id']}/propose", headers=auth)
    assert r.status_code == 409, r.text
    assert r.json()["detail"] == "F-32 is already the code of F-32 Alert routing by team"
    r = await client.get(f"/v1/documents/{ROADMAP}/versions/2", headers=auth)
    assert r.status_code == 404, r.text


async def _feature(tenant_id, key: str = "F-31") -> str:
    async with tenant_session(tenant_id) as s:
        feature = Entity(type="feature", key=key, title="Launch flow", status="confirmed",
                         origin="user", attrs={})  # fmt: skip
        s.add(feature)
        await s.flush()
        fid = str(feature.id)
        await s.commit()
    return fid


async def test_an_added_item_never_takes_the_code_another_item_shows(client, owner, runtime):  # noqa: F811
    """protects=(every-field) the code a person sees on an item is its feature's (it wins over
    its title's), then its PRD section's, then its title's: Edit plan's Add an item that would
    show a code a live item shows by its feature is refused (422), whether the code is in the
    added title or comes from the added item's picked feature (which wins over its title's);
    one linked after it was added is refused at propose (409); fails_when=two items show F-31;
    no_claim=the Simple paths (their own tests)."""
    tenant_id, auth = owner
    await approved_roadmap(client, auth, runtime)
    fid = await _feature(tenant_id)
    async with tenant_session(tenant_id) as s:
        row = await s.scalar(select(RoadmapItem).where(RoadmapItem.item_key == "shipping-step"))
        row.feature_id = uuid.UUID(fid)
        await s.commit()
    out = (await client.post(SETS, headers=auth)).json()
    taken = "F-31 is already the code of F-31 Shipping step"
    r = await patch(
        client, auth, out, [{"op": "add", "title": "F-31 Night digest", "horizon": "next"}]
    )
    assert r.status_code == 422, r.text
    assert r.json()["detail"] == taken
    # The picked feature's code is the one it shows, not its title's F-99.
    async with tenant_session(tenant_id) as s:
        row = await s.scalar(select(RoadmapItem).where(RoadmapItem.item_key == "shipping-step"))
        row.feature_id = None
        row.title = "F-31 Shipping step"
        await s.commit()
    r = await patch(client, auth, out, [{"op": "add", "title": "F-99 Launch flow",
                                         "horizon": "next", "feature_id": fid}])  # fmt: skip
    assert r.status_code == 422, r.text
    assert r.json()["detail"] == taken
    r = await patch(
        client, auth, out, [{"op": "add", "title": "F-32 Night digest", "horizon": "next"}]
    )
    assert r.status_code == 200, r.text
    f32 = await _feature(tenant_id, "F-32")
    async with tenant_session(tenant_id) as s:
        row = await s.scalar(select(RoadmapItem).where(RoadmapItem.item_key == "payment-step"))
        row.feature_id = uuid.UUID(f32)
        await s.commit()
    r = await client.post(f"{SETS}/{out['id']}/propose", headers=auth)
    assert r.status_code == 409, r.text
    assert r.json()["detail"] == "F-32 is already the code of F-32 Payment step"


async def test_a_write_never_gives_an_item_the_code_another_item_shows(client, owner, runtime):  # noqa: F811
    """protects=(every-field) the check on every roadmap item write compares the code each item
    shows: a title leading with the code another item shows by its feature is refused (409);
    fails_when=the write is stored and two items show F-31."""
    from oracle.roadmap.codes import CodeTaken

    tenant_id, auth = owner
    await approved_roadmap(client, auth, runtime)
    fid = await _feature(tenant_id)
    async with tenant_session(tenant_id) as s:
        row = await s.scalar(select(RoadmapItem).where(RoadmapItem.item_key == "shipping-step"))
        row.feature_id = uuid.UUID(fid)
        await s.commit()
    async with tenant_session(tenant_id) as s:
        row = await s.scalar(select(RoadmapItem).where(RoadmapItem.item_key == "payment-step"))
        row.title = "F-31 Payment step"
        try:
            await s.flush()
        except CodeTaken as e:
            assert e.detail == "F-31 is already the code of F-31 Shipping step"
        else:
            raise AssertionError("a second item was given F-31")


async def _two_f31(tenant_id) -> None:
    """Version 1 holds two items showing F-31 (stored before the one-code check) and a third,
    Gift cards, with no code."""
    from sqlalchemy import update

    async with tenant_session(tenant_id) as s:
        ship = await s.scalar(select(RoadmapItem).where(RoadmapItem.item_key == "shipping-step"))
        skip = ("id", "created_at", "updated_at")
        cols = [c.key for c in RoadmapItem.__mapper__.column_attrs if c.key not in skip]
        third = RoadmapItem(**{c: getattr(ship, c) for c in cols})
        third.item_key, third.title, third.position = "gift-cards", "Gift cards", 9
        s.add(third)
        await s.flush()
        await s.execute(update(RoadmapItem).where(RoadmapItem.item_key == "shipping-step")
                        .values(title="F-31 Shipping step"))  # fmt: skip
        await s.execute(update(RoadmapItem).where(RoadmapItem.item_key == "payment-step")
                        .values(title="F-31 Payment step"))  # fmt: skip
        await s.commit()


async def test_a_version_holding_a_code_twice_can_still_be_changed(client, owner, runtime):  # noqa: F811
    """protects=(every-field) only a code a write newly gives is refused: a version that holds
    two items showing F-31 already is proposed with a change set that moves a third item (the
    copies are no new claim), and a new claim of F-31 is still refused; fails_when=propose
    answers 409 for a move."""
    tenant_id, auth = owner
    await approved_roadmap(client, auth, runtime)
    await _two_f31(tenant_id)
    out = (await client.post(SETS, headers=auth)).json()
    r = await patch(client, auth, out, [{"op": "add", "title": "F-31 Night digest",
                                         "horizon": "next"}])  # fmt: skip
    assert r.status_code == 422, r.text
    r = await patch(client, auth, out, [{"op": "move", "key": "gift-cards", "horizon": "later"}])
    assert r.status_code == 200, r.text
    r = await client.post(f"{SETS}/{out['id']}/propose", headers=auth)
    assert r.status_code == 200, r.text
    async with tenant_session(tenant_id) as s:
        row = await s.scalar(
            select(RoadmapItem).where(
                RoadmapItem.item_key == "gift-cards", RoadmapItem.horizon == "later"
            )  # fmt: skip
        )
        assert row is not None
        # A rename that newly gives the code is still refused.
        from oracle.roadmap.codes import CodeTaken

        row.title = "F-31 Gift cards"
        try:
            await s.flush()
        except CodeTaken:
            pass
        else:
            raise AssertionError("a third item was given F-31")


async def test_a_run_imports_a_version_holding_a_code_twice(client, owner, runtime):  # noqa: F811
    """protects=(every-field) a run's import of a roadmap version copies its items even when
    the version before holds two items showing one code (a copy is no new claim);
    fails_when=the import stores no items for the new version."""
    from oracle.docs.models import Document, DocumentVersion
    from oracle.review.models import FeedbackItem
    from tests.test_roadmap import get, start, tick

    tenant_id, auth = owner
    await approved_roadmap(client, auth, runtime)
    await _two_f31(tenant_id)
    async with tenant_session(tenant_id) as s:
        doc = await s.scalar(select(Document).where(Document.slug == ROADMAP))
        s.add(FeedbackItem(document_id=doc.id, raised_on_version=1, kind="general",
                           summary="Move shipping into now"))  # fmt: skip
        await s.commit()
    run = (await client.post("/v1/runs", json={"flow": "feedback_loop", "document": ROADMAP},
                             headers=auth)).json()  # fmt: skip
    run = await start(client, auth, run)
    await tick(client, auth)
    run = await get(client, auth, run["id"])
    assert run["segments"][0]["draft_import"]["version"] == 2, run
    async with tenant_session(tenant_id) as s:
        v2 = await s.scalar(
            select(DocumentVersion).where(
                DocumentVersion.document_id == doc.id, DocumentVersion.number == 2
            )  # fmt: skip
        )
        keys = set(await s.scalars(select(RoadmapItem.item_key).where(
            RoadmapItem.roadmap_version_id == v2.id)))  # fmt: skip
    assert {"payment-step", "shipping-step"} <= keys, keys


async def _coded_items(tenant_id, n: int) -> None:
    """Version 1 gets ``n`` more items, each showing its own code (F-101 Item 1, ...)."""
    async with tenant_session(tenant_id) as s:
        ship = await s.scalar(select(RoadmapItem).where(RoadmapItem.item_key == "shipping-step"))
        cols = [c.key for c in RoadmapItem.__mapper__.column_attrs
                if c.key not in ("id", "created_at", "updated_at")]  # fmt: skip
        for i in range(1, n + 1):
            row = RoadmapItem(**{c: getattr(ship, c) for c in cols})
            row.item_key, row.title, row.position = f"item-{i}", f"F-{100 + i} Item {i}", 10 + i
            row.feature_id = None
            s.add(row)
        await s.commit()


async def test_proposing_a_plan_of_many_coded_items_reads_each_item_once(client, owner, runtime):  # noqa: F811
    """protects=(every-field) the one-code check reads the items a new version copies once per
    roadmap, not once per item: proposing a plan of 40 coded items runs a fixed number of
    statements; fails_when=each copied item that shows a code costs a read of its own."""
    from sqlalchemy import event

    from oracle.db import get_engine

    tenant_id, auth = owner
    await approved_roadmap(client, auth, runtime)
    await _coded_items(tenant_id, 40)
    out = (await client.post(SETS, headers=auth)).json()
    r = await patch(client, auth, out, [{"op": "move", "key": "item-1", "horizon": "later"}])
    assert r.status_code == 200, r.text
    statements: list[str] = []

    def count(conn, cursor, statement, parameters, *args):
        if "SAVEPOINT" not in statement:
            statements.append(statement)

    engine = get_engine().sync_engine
    event.listen(engine, "before_cursor_execute", count)
    try:
        r = await client.post(f"{SETS}/{out['id']}/propose", headers=auth)
    finally:
        event.remove(engine, "before_cursor_execute", count)
    assert r.status_code == 200, r.text
    # Measured after the fix; it was over 40 when each coded item read its own rows.
    assert len(statements) <= MAX_PROPOSE_STATEMENTS, len(statements)


async def test_a_copy_never_takes_back_a_code_its_item_gave_up(client, owner, runtime):  # noqa: F811
    """protects=(every-field) a copy keeps a code only when its item shows it on the row it is
    copied from (its latest one): Shipping step showed F-31 in version 1, gave it up in version
    2 where Payment step took it, so a version 3 copy of Shipping step showing F-31 is refused;
    fails_when=any older version of the item that showed F-31 lets the copy take it back."""
    from oracle.docs.models import Document, DocumentVersion
    from oracle.roadmap.codes import CodeTaken

    tenant_id, auth = owner
    await approved_roadmap(client, auth, runtime)
    cols = [c.key for c in RoadmapItem.__mapper__.column_attrs
            if c.key not in ("id", "created_at", "updated_at", "roadmap_version_id")]  # fmt: skip

    async def version(number: int, titles: dict[str, str]) -> None:
        async with tenant_session(tenant_id) as s:
            doc = await s.scalar(select(Document).where(Document.slug == ROADMAP))
            v = DocumentVersion(document_id=doc.id, number=number, markdown=f"v{number}",
                                content_hash=f"example-{number}")  # fmt: skip
            s.add(v)
            await s.flush()
            v1 = await s.scalar(select(DocumentVersion.id).where(
                DocumentVersion.document_id == doc.id, DocumentVersion.number == 1))  # fmt: skip
            for row in list(await s.scalars(select(RoadmapItem).where(
                    RoadmapItem.roadmap_version_id == v1))):  # fmt: skip
                copy = RoadmapItem(**{c: getattr(row, c) for c in cols}, roadmap_version_id=v.id)
                copy.title = titles[row.item_key]
                s.add(copy)
            await s.commit()

    from sqlalchemy import update

    async with tenant_session(tenant_id) as s:
        await s.execute(update(RoadmapItem).where(RoadmapItem.item_key == "shipping-step")
                        .values(title="F-31 Shipping step"))  # fmt: skip
        await s.commit()
    await version(2, {"shipping-step": "Shipping step", "payment-step": "F-31 Payment step"})
    try:
        await version(3, {"shipping-step": "F-31 Shipping step",
                          "payment-step": "F-31 Payment step"})  # fmt: skip
    except CodeTaken as e:
        assert e.detail == "F-31 is already the code of F-31 Payment step"
    else:
        raise AssertionError("Shipping step took F-31 back from Payment step")
