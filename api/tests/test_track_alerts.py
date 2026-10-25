"""F2 Track health: track alerts (open, keep, resolve), tracker history, accepting a
slipped date in one transaction, the Inbox's track rows, scoping and the ticker. Against
Postgres with the FakeRuntime.

Each test's card: protects=what it guards; fails_when=what breaks it; no_claim=what it
does not prove.
"""

import uuid
from datetime import UTC, date, datetime, timedelta

import pytest
from sqlalchemy import select, update

from oracle.audit import AuditEvent
from oracle.auth.deps import RUN_TOKEN_HEADER
from oracle.auth.models import User
from oracle.docs.models import Document
from oracle.mcp import scopes
from oracle.roadmap import alerts, views
from oracle.roadmap.models import (
    ProductTrack,
    RoadmapItem,
    TrackAlert,
    TrackerRecord,
)
from oracle.runs.models import Run
from oracle.runtokens import mint_run_token
from oracle.tenancy import tenant_session
from tests.day_helpers import company_today
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
from tests.test_tracks import track_of

TODAY = company_today()
BETA = "2026-11-30"
SLIPPED = "2026-12-09"


def record(track_id: str, target: str | None = SLIPPED, **kw) -> dict:
    return {"external_ref": "ENG-405", "state": "in_progress", "target_date": target,
            "track_id": track_id, "item_key": "payment-step", **kw}  # fmt: skip


async def importing(client, auth, *records: dict) -> dict:
    resp = await client.post(
        "/v1/tracker/records", json={"tracker": "jira", "records": list(records)}, headers=auth
    )
    assert resp.status_code == 200, resp.text
    return resp.json()


async def alerts_of(client, auth, state: str = "open", **params) -> list[dict]:
    resp = await client.get("/v1/track-alerts", params={"state": state, **params}, headers=auth)
    assert resp.status_code == 200, resp.text
    return resp.json()


async def eng_412(client, auth) -> str:
    bases = (await client.get("/v1/schedule-bases", headers=auth)).json()
    return next(b["id"] for b in bases if b["reference"] == "ENG-412")


async def tracked(client, auth, runtime, *, milestone: bool = True) -> dict:  # noqa: F811
    """The PRD, its roadmap and its track; the payment step's Beta date (2026-11-30)
    rests on ENG-412, and a planned Now track milestone lists it at that date."""
    await approved_prd(client, auth)
    await built_roadmap(client, auth, runtime)
    track = await track_of(client, auth)
    if milestone:
        resp = await client.post(
            f"/v1/tracks/{track['id']}/milestones",
            json={"name": "Launch", "target_date": BETA, "basis_ids": [await eng_412(client, auth)],
                  "item_keys": ["payment-step"]},
            headers=auth,
        )  # fmt: skip
        assert resp.status_code == 201, resp.text
    return track


async def slipped(client, auth, runtime) -> tuple[dict, dict]:  # noqa: F811
    track = await tracked(client, auth, runtime)
    await importing(client, auth, record(track["id"], BETA))
    await importing(client, auth, record(track["id"]))
    (alert,) = [a for a in await alerts_of(client, auth) if a["kind"] == "date_slip"]
    return track, alert


# --- sync: open, keep, resolve -------------------------------------------------------------


async def test_a_slip_opens_one_alert_and_resolves_when_the_date_comes_back(
    client,
    owner,  # noqa: F811
    runtime,  # noqa: F811
):
    """protects=criteria 1, 2 and 7; fails_when=an identical import opens a second alert,
    an import back to the date leaves the alert open, or history rows are written for
    unchanged fields; no_claim=the Inbox rows."""
    tenant_id, auth = owner
    track = await tracked(client, auth, runtime)
    first = await importing(client, auth, record(track["id"], BETA))
    record_id = first["records"][0]["id"]
    assert [a for a in await alerts_of(client, auth) if a["kind"] == "date_slip"] == []
    # No history for a new record, nor for an unchanged one.
    await importing(client, auth, record(track["id"], BETA))
    events = f"/v1/tracker/records/{record_id}/events"
    assert (await client.get(events, headers=auth)).json() == []

    await importing(client, auth, record(track["id"], raw_status="In Progress"))
    (slip,) = [a for a in await alerts_of(client, auth) if a["kind"] == "date_slip"]
    assert slip["detail"] == f"ENG-405 moved to {SLIPPED}; Beta rests on {BETA}"
    assert slip["item_key"] == "payment-step" and slip["item_title"] == "Payment step"
    assert slip["prd"]["slug"] == PRD and slip["state"] == "open"
    assert slip["data"]["slip_days"] == 9 and slip["data"]["previous_tracker_date"] == BETA
    assert set(slip["actions"]) == {"accept_date", "replan", "ask", "discuss", "keep"}
    got = (await client.get(events, headers=auth)).json()
    assert sorted((e["field"], e["before"], e["after"]) for e in got) == [
        ("raw_status", None, "In Progress"),
        ("target_date", BETA, SLIPPED),
    ]
    # A second identical import opens nothing new and writes no history.
    await importing(client, auth, record(track["id"], raw_status="In Progress"))
    assert [a["id"] for a in await alerts_of(client, auth) if a["kind"] == "date_slip"] == [
        slip["id"]
    ]
    assert len((await client.get(events, headers=auth)).json()) == 2

    # Back to the milestone date: resolved on that same request.
    await importing(client, auth, record(track["id"], BETA, raw_status="In Progress"))
    (gone,) = [a for a in await alerts_of(client, auth, "resolved") if a["id"] == slip["id"]]
    assert gone["state"] == "resolved" and gone["resolved_at"]


async def test_a_kept_alert_waits_until_the_facts_change(client, owner, runtime):  # noqa: F811
    """protects=criterion 3 and keep/reopen's 409s; fails_when=a kept alert shows as open,
    or a new date does not open a new alert and resolve the kept one; no_claim=audience."""
    tenant_id, auth = owner
    track, slip = await slipped(client, auth, runtime)
    url = f"/v1/track-alerts/{slip['id']}"
    assert (await client.post(f"{url}/reopen", headers=auth)).status_code == 409
    resp = await client.post(f"{url}/keep", json={"note": "Lead says one week"}, headers=auth)
    assert resp.status_code == 200, resp.text
    kept = resp.json()
    assert kept["state"] == "kept" and kept["note"] == "Lead says one week"
    assert kept["kept_by_name"] and kept["actions"] == ["replan", "ask", "discuss", "reopen"]
    assert (await client.post(f"{url}/keep", json={}, headers=auth)).status_code == 409
    assert slip["id"] not in [a["id"] for a in await alerts_of(client, auth)]
    # Monitoring again with the same facts: still kept.
    await client.post(f"/v1/tracks/{track['id']}/monitor", headers=auth)
    assert [a["state"] for a in await alerts_of(client, auth, "all") if a["id"] == slip["id"]] == [
        "kept"
    ]
    # Moved again: a new alert opens, the kept one resolves.
    await importing(client, auth, record(track["id"], "2026-12-20"))
    states = {a["id"]: a["state"] for a in await alerts_of(client, auth, "all")
              if a["kind"] == "date_slip"}  # fmt: skip
    assert states.pop(slip["id"]) == "resolved"
    assert list(states.values()) == ["open"]
    async with tenant_session(tenant_id) as s:
        actions = list(await s.scalars(select(AuditEvent.action).where(
            AuditEvent.action.like("track_alert.%"))))  # fmt: skip
    assert actions == ["track_alert.kept"]


async def test_reopen_puts_a_kept_alert_back(client, owner, runtime):  # noqa: F811
    """protects=Reopen; fails_when=a reopened alert stays out of state=open;
    no_claim=the Plan card."""
    _, auth = owner
    _, slip = await slipped(client, auth, runtime)
    url = f"/v1/track-alerts/{slip['id']}"
    assert (await client.post(f"{url}/keep", headers=auth)).status_code == 200
    resp = await client.post(f"{url}/reopen", headers=auth)
    assert resp.status_code == 200 and resp.json()["state"] == "open"
    assert slip["id"] in [a["id"] for a in await alerts_of(client, auth)]


async def test_ask_and_discuss_reach_commenters_on_the_kinds_they_fit(client, owner, runtime):  # noqa: F811
    """protects=F2 §3's Ask (date_slip, overdue, ahead) and Discuss (every kind) for
    commenters and above; fails_when=a commenter gets neither, a viewer gets either, or Ask
    is offered on a kind it does not fit; no_claim=the Plan card's buttons."""
    tenant_id, auth = owner
    track, slip = await slipped(client, auth, runtime)
    await importing(
        client, auth,
        {"external_ref": "ENG-777", "title": "Refactor cart", "state": "todo",
         "track_id": track["id"]},
    )  # fmt: skip
    by = {a["kind"]: a for a in await alerts_of(client, auth)}
    assert by["date_slip"]["actions"] == ["accept_date", "replan", "ask", "discuss", "keep"]
    assert "ask" not in by["unplanned"]["actions"]
    assert "discuss" in by["unplanned"]["actions"]
    commenter = await as_user(tenant_id, "commenter")
    by = {a["kind"]: a for a in await alerts_of(client, commenter)}
    assert by["date_slip"]["actions"] == ["ask", "discuss"]
    assert by["unplanned"]["actions"] == ["discuss"]
    viewer = await as_user(tenant_id, "viewer")
    assert all(a["actions"] == [] for a in await alerts_of(client, viewer))
    # A resolved alert offers neither.
    await importing(client, auth, record(track["id"], BETA))
    (gone,) = [a for a in await alerts_of(client, auth, "resolved") if a["id"] == slip["id"]]
    assert gone["actions"] == []


async def test_the_item_history_lists_its_tracker_events(client, owner, runtime):  # noqa: F811
    """protects=F1 §8 and F2 §2: the Plan item's history carries the tracker history of its
    issues, oldest first, with the issue's key; fails_when=tracker_events stays empty, or
    another item's issue shows; no_claim=the Plan's words for them."""
    tenant_id, auth = owner
    track, _ = await slipped(client, auth, runtime)
    await importing(
        client, auth,
        {"external_ref": "ENG-413", "state": "todo", "track_id": track["id"],
         "item_key": "shipping-step", "target_date": BETA},
    )  # fmt: skip
    await importing(
        client, auth,
        {"external_ref": "ENG-413", "state": "in_progress", "track_id": track["id"],
         "item_key": "shipping-step", "target_date": BETA},
    )  # fmt: skip
    resp = await client.get(
        "/v1/plan/items/history",
        params={"roadmap": ROADMAP, "item": "payment-step"},
        headers=await as_user(tenant_id, "viewer"),
    )
    assert resp.status_code == 200, resp.text
    events = resp.json()["tracker_events"]
    assert [(e["external_ref"], e["field"], e["before"], e["after"]) for e in events] == [
        ("ENG-405", "target_date", BETA, SLIPPED)
    ]
    assert events[0]["record_id"] and events[0]["observed_at"]
    other = await client.get(
        "/v1/plan/items/history",
        params={"roadmap": ROADMAP, "item": "shipping-step"},
        headers=auth,
    )
    assert [(e["external_ref"], e["field"]) for e in other.json()["tracker_events"]] == [
        ("ENG-413", "state")
    ]


async def test_ask_about_a_roadmap_item(client, owner, runtime):  # noqa: F811
    """protects=C2 Ask from a Plan item (F2 §3 Ask): a commenter asks a named person about a
    roadmap item, and the Inbox row opens the Plan on it; fails_when=the subject is refused,
    or names another page; no_claim=who the Plan suggests asking."""
    tenant_id, auth = owner
    await slipped(client, auth, runtime)
    approver_auth = await as_user(tenant_id, "approver")
    async with tenant_session(tenant_id) as s:
        prd_id = await s.scalar(select(Document.id).where(Document.slug == PRD))
        approver = await s.scalar(select(User.id).where(User.role == "approver"))
    commenter = await as_user(tenant_id, "commenter")
    subject = {"kind": "roadmap_item", "document_id": str(prd_id), "item_key": "payment-step"}
    resp = await client.post(
        "/v1/questions",
        json={"prompt": "Can ENG-405 still make Beta?", "asked_to": str(approver),
              "subject": subject},
        headers=commenter,
    )  # fmt: skip
    assert resp.status_code == 201, resp.text
    assert resp.json()["item_ref"] == "payment-step"
    rows = (await client.get("/v1/inbox/questions", headers=approver_auth)).json()
    (row,) = [r for r in rows if r["question"]["id"] == resp.json()["id"]]
    assert row["subject"]["kind"] == "roadmap_item"
    assert row["subject"]["title"].endswith(" · Payment step")
    assert row["subject"]["href"] == "/plan?item=payment-step"
    missing = {**subject, "item_key": "no-such-item"}
    resp = await client.post(
        "/v1/questions",
        json={"prompt": "Who?", "asked_to": str(approver), "subject": missing},
        headers=commenter,
    )
    assert resp.status_code == 422, resp.text


# --- each kind (§1) ---------------------------------------------------------------------------


async def test_drift_kinds_open_alerts_with_their_detail(client, owner, runtime):  # noqa: F811
    """protects=criterion 4 for overdue, cancelled, ahead and unplanned; fails_when=a kind's
    situation opens no alert or another detail; no_claim=the monitoring rules themselves."""
    tenant_id, auth = owner
    track = await tracked(client, auth, runtime, milestone=False)
    past = TODAY - timedelta(days=3)
    eng1 = await basis(tenant_id, "ENG-1", past)
    resp = await client.post(
        f"/v1/tracks/{track['id']}/milestones",
        json={"name": "Alpha", "target_date": past.isoformat(), "basis_ids": [str(eng1)],
              "item_keys": ["payment-step"]},
        headers=auth,
    )  # fmt: skip
    assert resp.status_code == 201, resp.text
    await importing(
        client,
        auth,
        {"external_ref": "ENG-413", "state": "in_progress", "track_id": track["id"],
         "item_key": "shipping-step"},
        {"external_ref": "ENG-777", "title": "Refactor cart", "state": "todo",
         "track_id": track["id"]},
    )  # fmt: skip
    by = {a["kind"]: a for a in await alerts_of(client, auth, track_id=track["id"])}
    assert by["overdue"]["detail"] == (
        f"The {past.isoformat()} date has passed and the work is not done"
    )
    assert by["ahead"]["detail"] == "Engineering started work planned for Next"
    assert by["ahead"]["item_key"] == "shipping-step"
    assert by["unplanned"]["detail"] == "ENG-777 (Refactor cart) is not on the roadmap"
    assert by["unplanned"]["item_key"] is None

    await importing(
        client, auth,
        {"external_ref": "ENG-413", "state": "cancelled", "track_id": track["id"],
         "item_key": "shipping-step"},
    )  # fmt: skip
    by = {a["kind"]: a for a in await alerts_of(client, auth, track_id=track["id"])}
    assert by["cancelled"]["detail"] == "Every issue for this item is cancelled"
    assert "ahead" not in by


async def test_blocked_stale_and_prd_moved_open_alerts(client, owner, runtime):  # noqa: F811
    """protects=criterion 4 for blocked, stale and prd_moved; fails_when=one of them opens no
    alert or another detail; no_claim=Review and Reconcile themselves."""
    tenant_id, auth = owner
    await approved_prd(client, auth)
    await seed_baseline(tenant_id)
    await seed_trace(tenant_id)
    await built_roadmap(client, auth, runtime)
    track = await track_of(client, auth)
    await client.post(f"/v1/tracks/{track['id']}/monitor", headers=auth)
    by = {a["kind"]: a for a in await alerts_of(client, auth)}
    assert by["blocked"]["detail"] == "Payment provider rate limit (open)"
    assert {"open_blocker", "keep"} <= set(by["blocked"]["actions"])

    async with tenant_session(tenant_id) as s:
        await s.execute(
            update(RoadmapItem)
            .where(RoadmapItem.item_key == "shipping-step")
            .values(freshness="potentially_stale", stale_reasons=["PRD section 5.2 changed"])
        )
        await s.commit()
    await client.post(f"/v1/tracks/{track['id']}/monitor", headers=auth)
    stale = [a for a in await alerts_of(client, auth) if a["kind"] == "stale"]
    assert [a["detail"] for a in stale] == ["PRD section 5.2 changed"]
    assert {"review", "reconcile"} <= set(stale[0]["actions"])

    text = (await client.get(f"/v1/documents/{PRD}/versions/1/markdown", headers=auth)).text
    from tests.fixtures import import_draft

    resp = await import_draft(client, auth, text.replace("Payment step", "Payment step (cards)", 1))
    assert resp.status_code == 201, resp.text
    assert (
        await client.post(f"/v1/documents/{PRD}/versions/2/approve", headers=auth)
    ).status_code == 200
    await client.post(f"/v1/tracks/{track['id']}/monitor", headers=auth)
    (moved,) = [a for a in await alerts_of(client, auth) if a["kind"] == "prd_moved"]
    assert moved["detail"] == "The PRD has a newer approved version (v2)"
    assert moved["item_key"] is None


# --- accept a new date ---------------------------------------------------------------------


async def test_accepting_a_slip_moves_the_date_on_a_new_basis(client, owner, runtime):  # noqa: F811
    """protects=criterion 5; fails_when=no verified basis for the new date, the old basis
    stays verified, the milestone keeps the old date, the alert stays open or no audit
    event; no_claim=the Plan's Engineering cell."""
    tenant_id, auth = owner
    track, slip = await slipped(client, auth, runtime)
    old = await eng_412(client, auth)
    resp = await client.post(
        f"/v1/track-alerts/{slip['id']}/accept-date", json={"reason": "Scope grew"}, headers=auth
    )
    assert resp.status_code == 200, resp.text
    out = resp.json()
    assert out["alert"]["state"] == "resolved"
    assert out["basis"]["reference"] == "ENG-405" and out["basis"]["status"] == "verified"
    assert out["basis"]["supports_date"] == SLIPPED and out["basis"]["tracker_record_id"]
    assert out["withdrawn_basis_ids"] == [old]
    (moved,) = out["milestones_moved"]
    assert (moved["from"], moved["to"]) == (BETA, SLIPPED)
    bases = {b["id"]: b for b in (await client.get("/v1/schedule-bases", headers=auth)).json()}
    assert bases[old]["status"] == "withdrawn"
    milestones = (await client.get(f"/v1/tracks/{track['id']}/milestones", headers=auth)).json()
    launch = next(m for m in milestones if m["name"] == "Launch")
    assert launch["target_date"] == SLIPPED and launch["basis_ids"] == [out["basis"]["id"]]
    assert not [a for a in await alerts_of(client, auth) if a["kind"] == "date_slip"]
    async with tenant_session(tenant_id) as s:
        actions = list(await s.scalars(select(AuditEvent.action).order_by(AuditEvent.created_at)))
    assert actions.count("track_alert.date_accepted") == 1
    assert {"schedule_basis.verified", "schedule_basis.withdrawn", "milestone.updated"} <= set(
        actions
    )
    # Accepted already: not an open slip any more.
    again = await client.post(f"/v1/track-alerts/{slip['id']}/accept-date", headers=auth)
    assert again.status_code == 409


async def test_accepting_is_one_transaction(client, owner, runtime, monkeypatch):  # noqa: F811
    """protects=criterion 5's single transaction; fails_when=a failure after the withdraw
    leaves the old basis withdrawn or the milestone moved; no_claim=other failure points."""
    _, auth = owner
    track, slip = await slipped(client, auth, runtime)
    old = await eng_412(client, auth)

    async def boom(*a, **kw):
        raise RuntimeError("injected after the withdraw")

    monkeypatch.setattr(views, "monitor", boom)
    with pytest.raises(RuntimeError):
        await client.post(f"/v1/track-alerts/{slip['id']}/accept-date", headers=auth)
    monkeypatch.undo()
    bases = {b["id"]: b for b in (await client.get("/v1/schedule-bases", headers=auth)).json()}
    assert bases[old]["status"] == "verified" and len(bases) == 1
    milestones = (await client.get(f"/v1/tracks/{track['id']}/milestones", headers=auth)).json()
    assert next(m for m in milestones if m["name"] == "Launch")["target_date"] == BETA
    assert [a["state"] for a in await alerts_of(client, auth, "all") if a["id"] == slip["id"]] == [
        "open"
    ]


async def test_accept_refuses_a_moved_record_and_the_wrong_people(client, owner, runtime):  # noqa: F811
    """protects=criterion 6; fails_when=a stale alert is accepted, a commenter or an
    approver while a lead is named may accept, or an approver with no lead may not;
    no_claim=the UI hides the button."""
    tenant_id, auth = owner
    track, slip = await slipped(client, auth, runtime)
    url = f"/v1/track-alerts/{slip['id']}/accept-date"
    commenter = await as_user(tenant_id, "commenter")
    assert (await client.post(url, headers=commenter)).status_code == 403
    async with tenant_session(tenant_id) as s:
        lead = await s.scalar(select(User).where(User.role == "commenter"))
        lead.engineering_lead = True
        await s.commit()
    approver = await as_user(tenant_id, "approver")
    assert (await client.post(url, headers=approver)).status_code == 403
    listed = (await alerts_of(client, approver))[0]
    assert "accept_date" not in listed["actions"]
    async with tenant_session(tenant_id) as s:
        await s.execute(update(User).values(engineering_lead=False))
        await s.commit()

    # The tracker moved again under the alert (written without a re-check): 409, re-synced.
    async with tenant_session(tenant_id) as s:
        await s.execute(
            update(TrackerRecord)
            .where(TrackerRecord.external_ref == "ENG-405")
            .values(target_date=date(2026, 12, 15))
        )
        await s.commit()
    resp = await client.post(url, headers=approver)
    assert resp.status_code == 409 and "changed" in resp.json()["detail"]
    (fresh,) = [a for a in await alerts_of(client, auth) if a["kind"] == "date_slip"]
    assert fresh["id"] != slip["id"] and fresh["data"]["tracker_date"] == "2026-12-15"
    # With no lead named, an approver's accept succeeds.
    resp = await client.post(f"/v1/track-alerts/{fresh['id']}/accept-date", headers=approver)
    assert resp.status_code == 200, resp.text


# --- Inbox -------------------------------------------------------------------------------------


async def test_the_inbox_carries_the_track_row_to_its_audience(client, owner, runtime):  # noqa: F811
    """protects=criterion 8; fails_when=the owner's total leaves the alerts out, an approver
    who is not the owner sees the row, or the lead sees other kinds; no_claim=the web rows."""
    tenant_id, auth = owner
    track, slip = await slipped(client, auth, runtime)
    await importing(
        client, auth,
        {"external_ref": "ENG-777", "title": "Refactor cart", "state": "todo",
         "track_id": track["id"]},
    )  # fmt: skip
    inbox = (await client.get("/v1/inbox", headers=auth)).json()
    (row,) = inbox["tracks"]
    assert row["track_id"] == track["id"] and row["prd"]["slug"] == PRD
    assert row["counts"]["new"] + row["counts"]["open"] == 2
    assert {a["kind"] for a in row["alerts"]} == {"date_slip", "unplanned"}
    assert all(a["inbox_state"] == "new" for a in row["alerts"])
    # The track is one row in the total, however many of its alerts are open (#514).
    without = inbox["total"] - 1
    approver = await as_user(tenant_id, "approver")
    assert (await client.get("/v1/inbox", headers=approver)).json()["tracks"] == []
    lead = await as_user(tenant_id, "commenter")
    async with tenant_session(tenant_id) as s:
        await s.execute(update(User).where(User.role == "commenter").values(engineering_lead=True))
        await s.commit()
    (lead_row,) = (await client.get("/v1/inbox", headers=lead)).json()["tracks"]
    assert [a["kind"] for a in lead_row["alerts"]] == ["date_slip"]

    # Kept: out of the track's count, in Done with its note; the track still has one open.
    await client.post(
        f"/v1/track-alerts/{slip['id']}/keep", json={"note": "Watching"}, headers=auth
    )
    inbox = (await client.get("/v1/inbox", headers=auth)).json()
    (row,) = inbox["tracks"]
    assert inbox["total"] == without + 1 and row["counts"]["kept"] == 1
    assert [(a["state"], a["note"]) for a in row["done"]] == [("kept", "Watching")]


# --- scoping -----------------------------------------------------------------------------------


async def test_another_company_and_run_tokens_are_refused(client, owner, runtime):  # noqa: F811
    """protects=criterion 9; fails_when=another company reads or acts on an alert, or a run
    token reaches the routes; no_claim=MCP's tool listing."""
    tenant_id, auth = owner
    track, slip = await slipped(client, auth, runtime)
    other = await other_company()
    assert await alerts_of(client, other, "all") == []
    for path in ("keep", "reopen", "accept-date"):
        resp = await client.post(f"/v1/track-alerts/{slip['id']}/{path}", headers=other)
        assert resp.status_code == 404, (path, resp.text)
    record_id = slip["data"]["record_id"]
    resp = await client.get(f"/v1/tracker/records/{record_id}/events", headers=other)
    assert resp.status_code == 404
    resp = await client.get("/v1/track-alerts", params={"track_id": track["id"]}, headers=other)
    assert resp.status_code == 404

    person = await as_user(tenant_id, "owner")
    async with tenant_session(tenant_id) as s:
        me = await s.scalar(select(User.id).where(User.email.like("owner-%")))
        run = Run(flow="baseline_to_prd", status="running", created_by=me)
        s.add(run)
        await s.flush()
        raw = await mint_run_token(s, run.id, ["read:documents", "read:baseline"], 600)
        await s.commit()
    run_headers = {**person, RUN_TOKEN_HEADER: raw}
    assert (await client.get("/v1/track-alerts", headers=run_headers)).status_code == 403
    resp = await client.post(f"/v1/track-alerts/{slip['id']}/keep", headers=run_headers)
    assert resp.status_code == 403
    assert scopes.required_scope("GET", "/v1/track-alerts") is None
    from oracle.main import app

    ops = {op["operationId"] for p in app.openapi()["paths"].values() for op in p.values()}
    assert {"list_track_alerts", "keep_track_alert", "reopen_track_alert",
            "accept_track_alert_date", "list_tracker_record_events"} <= ops  # fmt: skip


# --- the ticker ---------------------------------------------------------------------------------


async def test_the_hourly_pass_syncs_twenty_tracks_with_no_model_call(owner, monkeypatch):  # noqa: F811
    """protects=criterion 10; fails_when=monitor_due skips alert sync or calls a model;
    no_claim=the ticker's other duties."""
    from oracle.llm import gateway

    async def no_model(*a, **kw):
        raise AssertionError("track monitoring made a model call")

    monkeypatch.setattr(gateway, "complete", no_model)
    monkeypatch.setattr(gateway, "stream", no_model)
    tenant_id, _ = owner
    async with tenant_session(tenant_id) as s:
        for n in range(20):
            prd = Document(slug=f"prd-{n}", title=f"PRD {n}", kind="prd")
            s.add(prd)
            await s.flush()
            track = ProductTrack(prd_document_id=prd.id, title=f"Track {n}")
            s.add(track)
            await s.flush()
            s.add(
                TrackerRecord(
                    tracker="linear", external_ref=f"ENG-{900 + n}", title="Cleanup",
                    state="todo", track_id=track.id, observed_at=datetime.now(UTC),
                )
            )  # fmt: skip
        await s.commit()
    async with tenant_session(tenant_id) as s:
        assert await views.monitor_due(s, limit=20) == 20
        await s.commit()
    async with tenant_session(tenant_id) as s:
        rows = list(await s.scalars(select(TrackAlert)))
    assert len(rows) == 20 and {a.kind for a in rows} == {"unplanned"}
    assert {a.item_key for a in rows} == {""}


# --- unit: who may ------------------------------------------------------------------------------


def _principal(role: str, user_id: uuid.UUID | None = None):
    from oracle.auth.deps import Principal

    return Principal(tenant_id=uuid.uuid4(), kind="user", role=role, user_id=user_id)


def test_who_may_accept_a_date():
    """protects=F3 "Who verifies"; fails_when=approvers accept while a lead is named, or a
    lead cannot; no_claim=the write-time re-check."""
    lead = uuid.uuid4()
    assert alerts.may_accept(_principal("approver"), frozenset())
    assert not alerts.may_accept(_principal("commenter"), frozenset())
    assert not alerts.may_accept(_principal("approver"), frozenset({lead}))
    assert alerts.may_accept(_principal("owner"), frozenset({lead}))
    assert alerts.may_accept(_principal("commenter", lead), frozenset({lead}))
    assert not alerts.may_accept(_principal("viewer", lead), frozenset({lead}))


def test_the_audience():
    """protects=§4 audience; fails_when=an owner sees another person's track, or a lead sees
    kinds other than slips and overdue; no_claim=the Inbox query."""
    me, lead = uuid.uuid4(), uuid.uuid4()
    owned = ProductTrack(owner_id=me)
    unowned = ProductTrack(owner_id=None)
    assert alerts.in_audience(_principal("approver", me), owned, "stale", frozenset())
    assert not alerts.in_audience(_principal("owner", uuid.uuid4()), owned, "stale", frozenset())
    assert alerts.in_audience(_principal("owner", uuid.uuid4()), unowned, "stale", frozenset())
    assert not alerts.in_audience(_principal("approver", uuid.uuid4()), unowned, "stale",
                                  frozenset())  # fmt: skip
    for kind, sees in (("date_slip", True), ("overdue", True), ("blocked", False)):
        assert alerts.in_audience(_principal("commenter", lead), owned, kind,
                                  frozenset({lead})) is sees  # fmt: skip
