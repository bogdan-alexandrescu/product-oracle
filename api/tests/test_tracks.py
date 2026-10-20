"""Product tracks (V2b), milestones with verified dates only (O4), read-only tracker
alignment (E1) and track monitoring through oracle.changes. Against Postgres with the
FakeRuntime."""

import uuid
from datetime import date, timedelta

from sqlalchemy import delete, select

from oracle import changes
from oracle.config import get_settings
from oracle.roadmap import views
from oracle.roadmap.models import ProductTrack
from oracle.tenancy import tenant_session
from oracle.v2.models import ChangeEvent
from tests.roadmap_helpers import basis, other_company, seed_trace
from tests.test_roadmap import (  # noqa: F401 - fixtures
    PRD,
    ROADMAP,
    approved_prd,
    as_user,
    built_roadmap,
    owner,
    runtime,
    seed_baseline,
)

TODAY = date.today()


async def track_of(client, auth) -> dict:
    tracks = (await client.get("/v1/tracks", headers=auth)).json()
    assert len(tracks) == 1, tracks
    return (await client.get(f"/v1/tracks/{tracks[0]['id']}", headers=auth)).json()


async def test_an_accepted_prd_starts_a_track(client, owner, runtime):  # noqa: F811
    tenant_id, auth = owner
    await approved_prd(client, auth, approve=False)
    # A draft PRD cannot start a track.
    resp = await client.post("/v1/tracks", json={"prd": PRD}, headers=auth)
    assert resp.status_code == 422 and "no approved version" in resp.json()["detail"]
    assert (
        await client.post(f"/v1/documents/{PRD}/versions/1/approve", headers=auth)
    ).status_code == 200

    # Approving the PRD version (= publishing it, T2) started its track.
    (started,) = (await client.get("/v1/tracks", headers=auth)).json()
    assert started["prd"]["slug"] == PRD and started["started_version"] == 1
    # A PRD approved before tracks existed has none: a person starts it.
    async with tenant_session(tenant_id) as s:
        await s.execute(delete(ProductTrack))
        await s.commit()

    approver = await as_user(tenant_id, "approver")
    viewer = await as_user(tenant_id, "viewer")
    assert (await client.post("/v1/tracks", json={"prd": PRD}, headers=viewer)).status_code == 403
    resp = await client.post("/v1/tracks", json={"prd": PRD}, headers=approver)
    assert resp.status_code == 201, resp.text
    track = resp.json()
    assert track["prd"]["slug"] == PRD and track["started_version"] == 1
    assert track["current_version"] == 1 and track["latest_approved_version"] == 1
    assert track["status"] == "active" and track["health"] == "no_roadmap"
    assert track["headline"].startswith("No roadmap items yet")
    assert (await client.post("/v1/tracks", json={"prd": PRD}, headers=auth)).status_code == 409

    # Its roadmap follows: a run from the track drafts a prd_to_roadmap run (SwarmCloud).
    resp = await client.post(f"/v1/tracks/{track['id']}/roadmap-run", headers=auth)
    assert resp.status_code == 201, resp.text
    run = resp.json()
    assert run["flow"] == "prd_to_roadmap" and run["status"] == "draft"
    assert run["source"]["slug"] == PRD

    await built_roadmap(client, auth, runtime)
    overview = (await client.get(f"/v1/tracks/{track['id']}", headers=viewer)).json()
    assert overview["roadmap"]["slug"] == ROADMAP
    assert overview["counts"]["items"] == 2
    assert overview["health"] == "on_track", overview
    assert overview["next_milestone"]["name"] == "Beta"
    assert overview["next_milestone"]["target_date"] == "2026-11-30"
    assert overview["engineering_known"] is False


async def test_the_publish_hook_starts_a_track(client, owner):  # noqa: F811
    """The review lane's publish transaction records document_version 'published'."""
    tenant_id, auth = owner
    await approved_prd(client, auth)
    async with tenant_session(tenant_id) as s:
        from oracle.docs.models import Document, DocumentVersion

        version = await s.scalar(select(DocumentVersion).join(Document).where(Document.slug == PRD))
        await changes.record_change(
            s, "document_version", cause="published", actor="user:x",
            subject_id=version.id, document_id=version.document_id,
        )  # fmt: skip
        await s.commit()
        track = await s.scalar(select(ProductTrack))
        assert track is not None and track.started_version_id == version.id


async def test_milestone_dates_need_verified_bases(client, owner, runtime):  # noqa: F811
    tenant_id, auth = owner
    await approved_prd(client, auth)
    await built_roadmap(client, auth, runtime)
    track = await track_of(client, auth)
    url = f"/v1/tracks/{track['id']}/milestones"
    day = TODAY + timedelta(days=40)

    # Undated is the default (Now/Next/Later).
    resp = await client.post(url, json={"name": "GA", "horizon": "next"}, headers=auth)
    assert resp.status_code == 201 and resp.json()["target_date"] is None
    # A date without a basis is refused: Oracle never invents dates.
    resp = await client.post(
        url, json={"name": "Beta", "target_date": day.isoformat()}, headers=auth
    )
    assert resp.status_code == 422 and "never invents dates" in resp.json()["detail"]
    ok = await basis(tenant_id, "ENG-500", day)
    other_day = await basis(tenant_id, "ENG-501", day + timedelta(days=1))
    withdrawn = await basis(tenant_id, "ENG-502", day, status="withdrawn")
    for ids, words in (
        ([str(other_day)], "supports"),
        ([str(withdrawn)], "withdrawn"),
        ([str(uuid.uuid4())], "unknown"),
    ):
        resp = await client.post(
            url, json={"name": "Beta", "target_date": day.isoformat(), "basis_ids": ids},
            headers=auth,
        )  # fmt: skip
        assert resp.status_code == 422 and words in resp.json()["detail"], resp.text
    # Only in Now.
    resp = await client.post(
        url,
        json={"name": "Beta", "horizon": "next", "target_date": day.isoformat(),
              "basis_ids": [str(ok)]},
        headers=auth,
    )  # fmt: skip
    assert resp.status_code == 422 and "only in now" in resp.json()["detail"]
    resp = await client.post(
        url,
        json={"name": "Beta", "target_date": day.isoformat(), "basis_ids": [str(ok)],
              "item_keys": ["payment-step"]},
        headers=auth,
    )  # fmt: skip
    assert resp.status_code == 201, resp.text
    beta = resp.json()
    assert beta["target_date"] == day.isoformat() and beta["basis_ids"] == [str(ok)]

    overview = (await client.get(f"/v1/tracks/{track['id']}", headers=auth)).json()
    nxt = overview["next_milestone"]
    assert nxt["name"] == "Beta" and nxt["dated"] and nxt["bases"][0]["reference"] == "ENG-500"

    # Moving the date needs a basis for the new date.
    patch = f"/v1/milestones/{beta['id']}"
    resp = await client.patch(
        patch,
        json={"lock_version": beta["lock_version"],
              "target_date": (day + timedelta(days=1)).isoformat()},
        headers=auth,
    )  # fmt: skip
    assert resp.status_code == 422
    resp = await client.patch(patch, json={"lock_version": 99, "name": "x"}, headers=auth)
    assert resp.status_code == 409

    # Withdrawing the only basis takes the date away, and says so.
    resp = await client.post(
        f"/v1/schedule-bases/{ok}/withdraw", json={"reason": "Estimate re-opened"}, headers=auth
    )
    assert resp.status_code == 200, resp.text
    assert resp.json()["undated_milestones"] == [beta["id"]]
    assert resp.json()["basis"]["status"] == "withdrawn"
    milestones = (await client.get(url, headers=auth)).json()
    assert {m["name"]: m["target_date"] for m in milestones} == {"Beta": None, "GA": None}
    resp = await client.post(
        f"/v1/schedule-bases/{ok}/withdraw", json={"reason": "again"}, headers=auth
    )
    assert resp.status_code == 409


async def test_schedule_bases(client, owner):  # noqa: F811
    tenant_id, auth = owner
    await approved_prd(client, auth)
    day = (TODAY + timedelta(days=10)).isoformat()
    body = {"kind": "commitment", "reference": "Q1 launch", "supports_date": day, "prd": PRD}
    viewer = await as_user(tenant_id, "viewer")
    assert (await client.post("/v1/schedule-bases", json=body, headers=viewer)).status_code == 403
    resp = await client.post("/v1/schedule-bases", json=body, headers=auth)
    assert resp.status_code == 201, resp.text
    row = resp.json()
    assert row["status"] == "verified" and row["verified_by"] and row["prd_document_id"]
    listed = (await client.get("/v1/schedule-bases", params={"prd": PRD}, headers=viewer)).json()
    # Every basis belongs to a PRD: approved_prd recorded ENG-412 for this one.
    assert [b["reference"] for b in listed] == ["Q1 launch", "ENG-412"]

    # From a tracker record: the record's own target date must agree, and the record
    # must be this PRD's (on its track; round 3: a track-less record is refused).
    track = await track_of(client, auth)
    resp = await client.post(
        "/v1/tracker/records",
        json={"tracker": "linear", "records": [{"external_ref": "ENG-9", "state": "in_progress",
                                                "target_date": day, "track_id": track["id"]}]},
        headers=auth,
    )  # fmt: skip
    record_id = resp.json()["records"][0]["id"]
    wrong = {**body, "tracker_record_id": record_id, "supports_date": "2030-01-01"}
    resp = await client.post("/v1/schedule-bases", json=wrong, headers=auth)
    assert resp.status_code == 422 and "targets" in resp.json()["detail"]
    resp = await client.post(
        "/v1/schedule-bases", json={**body, "tracker_record_id": record_id}, headers=auth
    )
    assert resp.status_code == 201


async def test_read_only_alignment_and_drift(client, owner, runtime):  # noqa: F811
    tenant_id, auth = owner
    await approved_prd(client, auth)
    await built_roadmap(client, auth, runtime)
    track = await track_of(client, auth)
    past = TODAY - timedelta(days=3)
    eng1 = await basis(tenant_id, "ENG-1", past)
    resp = await client.post(
        f"/v1/tracks/{track['id']}/milestones",
        json={"name": "Alpha", "target_date": past.isoformat(), "basis_ids": [str(eng1)],
              "item_keys": ["payment-step"]},
        headers=auth,
    )  # fmt: skip
    assert resp.status_code == 201, resp.text

    records = [
        # Payment (now, Beta 2026-11-30 from ENG-412): the tracker says later than that.
        {"external_ref": "ENG-412", "state": "in_progress", "target_date": "2026-12-20",
         "track_id": track["id"], "item_key": "payment-step"},
        # Shipping is in next, but engineering already started: drift the other way.
        {"external_ref": "ENG-413", "state": "in_progress", "track_id": track["id"],
         "item_key": "shipping-step"},
        # Work no roadmap item names.
        {"external_ref": "ENG-777", "title": "Refactor cart", "state": "todo",
         "track_id": track["id"]},
    ]  # fmt: skip
    viewer = await as_user(tenant_id, "viewer")
    body = {"tracker": "jira", "records": records}
    assert (await client.post("/v1/tracker/records", json=body, headers=viewer)).status_code == 403
    resp = await client.post("/v1/tracker/records", json=body, headers=auth)
    assert resp.status_code == 200, resp.text
    assert (resp.json()["created"], resp.json()["updated"]) == (3, 0)

    report = (await client.get(f"/v1/roadmaps/{ROADMAP}/alignment", headers=viewer)).json()
    assert report["mode"] == "read_only" and report["connector"]["writes_allowed"] is False
    by = {i["item_key"]: i for i in report["items"]}
    pay_kinds = {d["kind"] for d in by["payment-step"]["drift"]}
    assert pay_kinds == {"date_slip", "overdue"}, by["payment-step"]
    assert by["payment-step"]["alignment"] == "drift"
    assert [d["kind"] for d in by["shipping-step"]["drift"]] == ["ahead"]
    assert [u["tracker_ref"] for u in report["unplanned"]] == ["ENG-777"]
    assert report["counts"] == {"items": 2, "aligned": 0, "drift": 2, "untracked": 0,
                                "done": 0, "unplanned": 1}  # fmt: skip

    overview = (await client.get(f"/v1/tracks/{track['id']}", headers=auth)).json()
    assert overview["health"] == "off_track", overview["headline"]
    assert overview["engineering_known"] is True
    at_risk = {i["item_key"]: {r["kind"] for r in i["reasons"]} for i in overview["at_risk"]}
    assert at_risk == {"payment-step": {"slipping"}}
    assert overview["counts"]["slipping"] == 1
    assert overview["headline"].startswith("Off track: 1 of 2 items need attention")

    # Updating a record (latest state per issue): done clears the slip.
    resp = await client.post(
        "/v1/tracker/records",
        json={"tracker": "jira", "records": [{**records[0], "state": "done"}]},
        headers=auth,
    )
    assert (resp.json()["created"], resp.json()["updated"]) == (0, 1)
    report = (await client.get(f"/v1/roadmaps/{ROADMAP}/alignment", headers=auth)).json()
    assert {i["item_key"]: i["alignment"] for i in report["items"]}["payment-step"] == "done"

    # Unknown tracks are refused.
    resp = await client.post(
        "/v1/tracker/records",
        json={"tracker": "jira", "records": [{"external_ref": "X-1", "state": "todo",
                                              "track_id": str(uuid.uuid4())}]},
        headers=auth,
    )  # fmt: skip
    assert resp.status_code == 422


async def test_blocked_and_stale_items_put_a_track_at_risk(client, owner, runtime):  # noqa: F811
    tenant_id, auth = owner
    await approved_prd(client, auth)
    await seed_baseline(tenant_id)
    ids = await seed_trace(tenant_id)
    await built_roadmap(client, auth, runtime)
    track = await track_of(client, auth)
    # The critical hard blocker sits on a Now item: off track.
    assert track["health"] == "off_track"
    assert track["at_risk"][0]["reasons"][0]["kind"] == "blocked"
    # Resolving the blocker lifts the block.
    resp = await client.post(
        f"/v1/blockers/{ids['blocker']}/status", json={"status": "resolved", "reason": "Raised"},
        headers=auth,
    )  # fmt: skip
    assert resp.status_code == 200, resp.text
    track = await track_of(client, auth)
    # No longer blocked, but the change made the item potentially stale, and the item
    # that depends on it (shipping depends on payment, downstream in the graph).
    assert track["health"] == "at_risk"
    reasons = {i["item_key"]: [r["kind"] for r in i["reasons"]] for i in track["at_risk"]}
    assert reasons == {"payment-step": ["stale"], "shipping-step": ["stale"]}
    assert track["counts"]["stale"] == 2 and track["counts"]["blocked"] == 0


async def test_monitoring_records_change_events_only_on_change(client, owner, runtime):  # noqa: F811
    tenant_id, auth = owner
    await approved_prd(client, auth)
    await built_roadmap(client, auth, runtime)
    track = await track_of(client, auth)
    url = f"/v1/tracks/{track['id']}/monitor"
    first = (await client.post(url, headers=auth)).json()
    assert first["change_event_id"] and first["changed"] == [
        "health", "at_risk", "next_milestone", "prd_moved",
    ]  # fmt: skip
    again = (await client.post(url, headers=auth)).json()
    assert again["change_event_id"] is None and again["changed"] == []

    # A new approved PRD version moves the PRD on: at risk, recorded once.
    text = (await client.get(f"/v1/documents/{PRD}/versions/1/markdown", headers=auth)).text
    from tests.fixtures import import_draft

    resp = await import_draft(client, auth, text.replace("Payment step", "Payment step (cards)", 1))
    assert resp.status_code == 201, resp.text
    assert (
        await client.post(f"/v1/documents/{PRD}/versions/2/approve", headers=auth)
    ).status_code == 200
    moved = (await client.post(url, headers=auth)).json()
    assert moved["overview"]["prd_moved"] is True
    assert moved["overview"]["health"] == "at_risk"
    assert "health" in moved["changed"] and "prd_moved" in moved["changed"]
    events = (await client.get(f"/v1/tracks/{track['id']}/changes", headers=auth)).json()
    assert len(events) == 2 and events[0]["data"]["after"]["health"] == "at_risk"
    assert events[0]["cause"] == "track_monitored"

    # The ticker monitors due tracks (hourly), without a model call.
    async with tenant_session(tenant_id) as s:
        assert await views.monitor_due(s) == 0
        row = await s.get(ProductTrack, uuid.UUID(track["id"]))
        row.monitored_at = None
        await s.commit()
        assert await views.monitor_due(s) == 1
        await s.commit()
        count = len((await s.scalars(select(ChangeEvent).where(
            ChangeEvent.subject_kind == "product_track"))).all())  # fmt: skip
        assert count == 2  # nothing changed since the last check


async def test_tracker_writes_stay_behind_a_disabled_gate(client, owner, runtime, monkeypatch):  # noqa: F811
    tenant_id, auth = owner
    await approved_prd(client, auth)
    await seed_baseline(tenant_id)
    await seed_trace(tenant_id)
    await built_roadmap(client, auth, runtime)
    track = await track_of(client, auth)
    gate = (await client.get("/v1/tracker/connector", headers=auth)).json()
    assert gate == {
        "two_way_enabled": False,
        "writes_allowed": False,
        "read_only_alignment": True,
        "reason": gate["reason"],
    }
    resp = await client.post(f"/v1/tracks/{track['id']}/tracker-push", headers=auth)
    assert resp.status_code == 409 and "no tracker writes" in resp.json()["detail"]
    monkeypatch.setattr(get_settings(), "tracker_two_way_enabled", True)
    resp = await client.post(f"/v1/tracks/{track['id']}/tracker-push", headers=auth)
    assert resp.status_code == 501
    assert (await client.get("/v1/tracker/connector", headers=auth)).json()[
        "writes_allowed"
    ] is False

    plan = (await client.get(f"/v1/tracks/{track['id']}/tracker-plan", headers=auth)).json()
    assert plan["would_write"] is False
    assert [e["item_key"] for e in plan["epics"]] == ["payment-step", "shipping-step"]
    assert plan["epics"][0]["issues"] == [
        {"title": "Saved cards", "requirement_key": "saved-cards"}
    ]
    assert plan["epics"][0]["prd_link"] == f"/documents/{PRD}/v/1#s-5-1"


async def test_track_patch_and_roles(client, owner, runtime):  # noqa: F811
    tenant_id, auth = owner
    await approved_prd(client, auth)
    await built_roadmap(client, auth, runtime)
    track = await track_of(client, auth)
    url = f"/v1/tracks/{track['id']}"
    commenter = await as_user(tenant_id, "commenter")
    resp = await client.patch(url, json={"lock_version": 1, "status": "paused"}, headers=commenter)
    assert resp.status_code == 403
    assert (await client.post(f"{url}/monitor", headers=commenter)).status_code == 403
    resp = await client.patch(url, json={"lock_version": 1, "status": "paused"}, headers=auth)
    assert resp.status_code == 200, resp.text
    assert resp.json()["health"] == "paused" and resp.json()["lock_version"] == 2
    # Monitoring does not make a person's copy stale.
    await client.post(f"{url}/monitor", headers=auth)
    resp = await client.patch(url, json={"lock_version": 2, "title": "Checkout"}, headers=auth)
    assert resp.status_code == 200 and resp.json()["title"] == "Checkout"
    resp = await client.patch(url, json={"lock_version": 2, "title": "Stale"}, headers=auth)
    assert resp.status_code == 409
    paused = (await client.get("/v1/tracks", params={"status": "paused"}, headers=auth)).json()
    assert [t["id"] for t in paused] == [track["id"]]


async def test_track_routes_are_company_scoped(client, owner, runtime):  # noqa: F811
    tenant_id, auth = owner
    await approved_prd(client, auth)
    await built_roadmap(client, auth, runtime)
    track = await track_of(client, auth)
    milestone = (
        await client.post(f"/v1/tracks/{track['id']}/milestones", json={"name": "GA"}, headers=auth)
    ).json()
    day = (TODAY + timedelta(days=5)).isoformat()
    b = (
        await client.post(
            "/v1/schedule-bases",
            json={"kind": "estimate", "reference": "ENG-1", "supports_date": day, "prd": PRD},
            headers=auth,
        )
    ).json()
    other = await other_company()
    t = track["id"]
    for method, url, body in (
        ("get", f"/v1/tracks/{t}", None),
        ("patch", f"/v1/tracks/{t}", {"lock_version": 1}),
        ("post", f"/v1/tracks/{t}/monitor", None),
        ("get", f"/v1/tracks/{t}/changes", None),
        ("post", f"/v1/tracks/{t}/roadmap-run", None),
        ("get", f"/v1/tracks/{t}/tracker-plan", None),
        ("post", f"/v1/tracks/{t}/tracker-push", None),
        ("get", f"/v1/tracks/{t}/milestones", None),
        ("post", f"/v1/tracks/{t}/milestones", {"name": "x"}),
        ("patch", f"/v1/milestones/{milestone['id']}", {"lock_version": 1}),
        ("post", f"/v1/schedule-bases/{b['id']}/withdraw", {"reason": "x"}),
        ("post", "/v1/tracks", {"prd": PRD}),
        ("get", f"/v1/schedule-bases?prd={PRD}", None),
    ):
        resp = await client.request(method, url, json=body, headers=other)
        assert resp.status_code == 404, (method, url, resp.status_code, resp.text)
    # Lists show nothing of ours.
    assert (await client.get("/v1/tracks", headers=other)).json() == []
    assert (await client.get("/v1/schedule-bases", headers=other)).json() == []
    resp = await client.post(
        "/v1/tracker/records",
        json={"tracker": "jira", "records": [{"external_ref": "X-1", "state": "todo",
                                              "track_id": t}]},
        headers=other,
    )  # fmt: skip
    assert resp.status_code == 422
    assert (await client.get("/v1/tracker/records", headers=other)).json() == []


async def test_patches_refuse_nulls_and_duplicate_names(client, owner, runtime):  # noqa: F811
    _, auth = owner
    await approved_prd(client, auth)
    await built_roadmap(client, auth, runtime)
    track = await track_of(client, auth)
    url = f"/v1/tracks/{track['id']}"
    for field in ("status", "title"):
        resp = await client.patch(url, json={"lock_version": 1, field: None}, headers=auth)
        assert resp.status_code == 422, resp.text
    ms = f"{url}/milestones"
    ga = (await client.post(ms, json={"name": "GA", "horizon": "later"}, headers=auth)).json()
    await client.post(ms, json={"name": "Beta"}, headers=auth)
    patch = f"/v1/milestones/{ga['id']}"
    for field in ("horizon", "name", "status"):
        resp = await client.patch(patch, json={"lock_version": 1, field: None}, headers=auth)
        assert resp.status_code == 422, (field, resp.text)
    resp = await client.patch(patch, json={"lock_version": 1, "name": "Beta"}, headers=auth)
    assert resp.status_code == 409
