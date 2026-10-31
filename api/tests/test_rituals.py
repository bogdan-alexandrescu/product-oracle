# ruff: noqa: F811 - the ritual fixtures are imported
"""H2 Cadence engine API: rituals and their occurrences (``/v1/rituals``,
``/v1/ritual-occurrences``), the pre-read, Inbox rows, summaries and their estimate.
Oracle's ritual clock is set by the tests; made-up people and goals only.

Each test's card: protects=<the observable>; fails_when=<the wrong result it rejects>;
no_claim=<what green does not prove>.
"""

import re
from datetime import timedelta

import pytest
from sqlalchemy import select

from oracle.models import AuditEvent
from oracle.rituals import service as rituals
from oracle.runs.models import Run
from oracle.swarm import FakeRuntime, Outcome, set_runtime
from oracle.tenancy import tenant_session
from tests.baseline_helpers import make_ctx
from tests.ritual_helpers import (  # noqa: F401 - fixtures
    at,
    ctx,
    only,
    ready_occurrence,
    rituals_of,
    tick,
)
from tests.test_mcp import mcp_client, run_token, text_of

CUSTOM = {
    "kind": "custom",
    "title": "Pricing sync",
    "schedule": {"freq": "weekly", "weekday": 2, "time": "11:00", "timezone": "Europe/Berlin"},
    "duration_min": 30,
    "prep_hours": 12,
}


async def create(client, ctx, who="owner", **over):
    body = {**CUSTOM, "owner_id": str(ctx.users["owner"].id), **over}
    return await client.post("/v1/rituals", json=body, headers=ctx.as_(who))


async def test_owners_create_and_edit_others_read(client, ctx, at):
    """protects=criterion 8: owners create and edit rituals, approvers get 403, viewers
    read; a stale lock_version is 409; fails_when=an approver edits or a stale write
    lands; no_claim=MCP clients (same routes)."""
    resp = await create(client, ctx)
    assert resp.status_code == 201, resp.text
    r = resp.json()
    assert r["kind"] == "custom" and r["builtin"] is False and r["status"] == "active"
    assert r["next_due_at"] is not None
    assert (await create(client, ctx, "approver")).status_code == 403
    listed = await client.get("/v1/rituals", headers=ctx.as_("viewer"))
    assert [x["id"] for x in listed.json()] == [r["id"]]
    patch = {"lock_version": r["lock_version"], "duration_min": 45}
    resp = await client.patch(f"/v1/rituals/{r['id']}", json=patch, headers=ctx.as_("approver"))
    assert resp.status_code == 403
    resp = await client.patch(f"/v1/rituals/{r['id']}", json=patch, headers=ctx.as_("owner"))
    assert resp.status_code == 200 and resp.json()["duration_min"] == 45
    resp = await client.patch(f"/v1/rituals/{r['id']}", json=patch, headers=ctx.as_("owner"))
    assert resp.status_code == 409


async def test_a_new_schedule_moves_next_due(client, ctx, at):
    """protects=criterion 12a's API: changing the schedule recomputes next_due_at in the
    Company time zone; fails_when=next_due_at keeps the old schedule; no_claim=the screen."""
    r = (await create(client, ctx)).json()
    schedule = {"freq": "monthly", "week_of_month": -1, "weekday": 4, "time": "16:00"}
    resp = await client.patch(
        f"/v1/rituals/{r['id']}",
        json={"lock_version": r["lock_version"], "schedule": schedule},
        headers=ctx.as_("owner"),
    )
    assert resp.status_code == 200, resp.text
    # The last Friday of October, 16:00 in Los Angeles (PDT): 23:00 UTC.
    assert resp.json()["next_due_at"] == "2026-10-30T23:00:00Z"


async def test_a_ritual_has_no_time_zone_of_its_own(client, ctx, at):
    """protects=owner decision 2026-10-22, one zone: a ritual is always in the Company
    time zone; a zone in a create or edit body (another one, or none that exists) is not
    the ritual's, and the API's schedule input has no time zone field; fails_when=a ritual
    is stored or scheduled in Berlin, or the input still offers a zone; no_claim=the
    screen (rituals.spec.ts)."""
    resp = await create(client, ctx)  # the body names Europe/Berlin
    assert resp.status_code == 201, resp.text
    r = resp.json()
    assert r["schedule"]["timezone"] == "America/Los_Angeles"
    # Wednesday 11:00 in Los Angeles (PDT): 18:00 UTC.
    assert r["next_due_at"] == "2026-10-21T18:00:00Z"
    schedule = {**CUSTOM["schedule"], "timezone": "Nowhere/Land"}
    resp = await client.patch(
        f"/v1/rituals/{r['id']}",
        json={"lock_version": r["lock_version"], "schedule": schedule},
        headers=ctx.as_("owner"),
    )
    assert resp.status_code == 200, resp.text
    assert resp.json()["schedule"]["timezone"] == "America/Los_Angeles"
    from oracle.main import app

    schemas = app.openapi()["components"]["schemas"]
    for name in ("RitualCreate", "RitualPatch"):
        ref = schemas[name]["properties"]["schedule"]["anyOf"][0]["$ref"].rsplit("/", 1)[1]
        assert "timezone" not in schemas[ref]["properties"], name


@pytest.mark.parametrize(
    ("over", "field"),
    [
        ({"schedule": {**CUSTOM["schedule"], "time": "25:00"}}, "time"),
        ({"duration_min": 4}, "duration_min"),
        ({"prep_hours": 169}, "prep_hours"),
    ],
)
async def test_invalid_values_are_422_naming_the_field(client, ctx, at, over, field):
    """protects=criterion 8: a time of day, a length or lead time out of range is
    422 naming the field; fails_when=it is stored, or the error names nothing;
    no_claim=every schedule rule (test_rituals_schedule.py)."""
    resp = await create(client, ctx, **over)
    assert resp.status_code == 422
    assert field in resp.text


async def test_attendees_must_be_members(client, ctx, at):
    """protects=attendees who are not members are 422; fails_when=a stranger's id is
    stored; no_claim=disabled members."""
    other = await make_ctx("Other Co")
    resp = await create(client, ctx, attendee_ids=[str(other.users["viewer"].id)])
    assert resp.status_code == 422


async def test_built_ins_pause_and_are_not_deleted(client, ctx, at):
    """protects=criterion 8: DELETE on a built-in is 409 with Oracle's wording, a custom
    one is deleted, pause and resume flip the state; fails_when=a built-in is deleted;
    no_claim=the cascade to occurrences (the foreign key's)."""
    await tick(ctx.tenant_id)
    builtin = (await rituals_of(ctx.tenant_id))["goals_checkin"]
    resp = await client.delete(f"/v1/rituals/{builtin.id}", headers=ctx.as_("owner"))
    assert resp.status_code == 409
    assert resp.json()["detail"] == "Built-in rituals pause; they are not deleted"
    resp = await client.post(f"/v1/rituals/{builtin.id}/pause", headers=ctx.as_("owner"))
    assert resp.status_code == 200 and resp.json()["status"] == "paused"
    resp = await client.post(f"/v1/rituals/{builtin.id}/resume", headers=ctx.as_("owner"))
    assert resp.json()["status"] == "active"
    custom = (await create(client, ctx)).json()
    resp = await client.delete(f"/v1/rituals/{custom['id']}", headers=ctx.as_("owner"))
    assert resp.status_code == 204
    resp = await client.get(f"/v1/rituals/{custom['id']}", headers=ctx.as_("owner"))
    assert resp.status_code == 404


async def test_the_pre_read_has_the_kinds_blocks_and_markdown(client, ctx, at):
    """protects=the roadmap refresh's pre-read lists its blocks in the kind's order, each
    with rows and a data-as-of time, and the markdown export carries them; fails_when=a
    block is missing or out of order, or the markdown is empty; no_claim=every row's
    figures against the roadmap screens."""
    occ = await ready_occurrence(client, ctx, at)
    keys = [b["key"] for b in occ["pre_read"]["blocks"]]
    assert keys == ["tracks", "slips", "stale_items", "done_items", "priority_changes",
                    "new_requests", "suggested_next"]  # fmt: skip
    assert occ["pre_read"]["built_at"] and occ["period"]["to"] == occ["due_at"]
    md = await client.get(f"/v1/ritual-occurrences/{occ['id']}/pre-read.md",
                          headers=ctx.as_("viewer"))  # fmt: skip
    assert md.status_code == 200 and md.headers["content-type"].startswith("text/markdown")
    assert "# Monthly roadmap refresh" in md.text and "## Date slips" in md.text
    # Due in the Company time zone (America/Los_Angeles by default), labelled (#463).
    due = r"^Due [A-Z][a-z]{2} \d{1,2}, \d{4}, \d{1,2}:\d\d [AP]M P[DS]T$"
    assert re.search(due, md.text, re.M), md.text


async def test_the_feature_gated_kinds_have_their_blocks(client, ctx, at):
    """protects=criterion 2: the kinds gated on H1, H4, H6 and H8 fire with their own
    blocks on today's data: decisions due for review and made in the window, the open
    strategy findings and the approved strategy's age, the changelog drafts, the latest
    update draft; fails_when=a kind is not listed, or a block is missing or empty with
    data present; no_claim=starting the update draft run (not built yet)."""
    from datetime import UTC, date, datetime

    from oracle.decisions.models import Decision
    from oracle.launches.models import ChangelogEntry
    from oracle.strategy.models import StrategyFinding

    owner = ctx.users["owner"].id
    async with tenant_session(ctx.tenant_id) as db:
        db.add(
            Decision(
                number=1,
                title="Price the starter plan monthly",
                status="decided",
                approver_id=owner,
                driver="Ada Example",
                origin="manual",
                chosen_option="a",
                rationale="Simpler",
                decided_at=datetime(2026, 10, 20, tzinfo=UTC),
                review_at=date(2026, 10, 21),
            )
        )
        db.add(
            StrategyFinding(
                kind="goal_without_strategy",
                severity="warning",
                subject_kind="entity",
                subject_ref="goal:activation",
            )
        )
        db.add(
            ChangelogEntry(
                category="added",
                audience="public",
                title="Bulk export",
                released_on=date(2026, 10, 20),
                created_actor="oracle",
            )
        )
        await db.commit()  # fmt: skip
    await tick(ctx.tenant_id)
    listed = {
        r["kind"] for r in (await client.get("/v1/rituals", headers=ctx.as_("viewer"))).json()
    }
    assert {"decision_review", "strategy_review", "changelog", "investor_update",
            "board_meeting"} <= listed  # fmt: skip

    def rows(occ: dict) -> dict[str, list]:
        return {b["key"]: b["rows"] for b in occ["pre_read"]["blocks"]}

    occ = await ready_occurrence(client, ctx, at, "decision_review")
    got = rows(occ)
    assert list(got) == ["decisions_due", "decisions_made"]
    assert [r["title"] for r in got["decisions_due"]] == ["Price the starter plan monthly"]
    assert [r["title"] for r in got["decisions_made"]] == ["Price the starter plan monthly"]
    assert got["decisions_due"][0]["href"] == "/company/decisions?d=1"

    occ = await ready_occurrence(client, ctx, at, "changelog")
    assert [r["title"] for r in rows(occ)["changelog_drafts"]] == ["Bulk export"]

    occ = await ready_occurrence(client, ctx, at, "strategy_review")
    got = rows(occ)
    assert list(got) == ["strategy_drift", "strategy_age"]
    assert [r["subject_ref"] for r in got["strategy_drift"]] == ["goal:activation"]
    assert got["strategy_age"][0]["text"] == "No approved strategy yet"

    # Investor update is off by default; Prepare now builds its pre-read all the same.
    ritual = (await rituals_of(ctx.tenant_id))["investor_update"]
    resp = await client.post(f"/v1/rituals/{ritual.id}/prepare", headers=ctx.as_("owner"))
    assert resp.status_code == 200, resp.text
    assert list(rows(resp.json())) == ["update_draft"]
    assert rows(resp.json())["update_draft"][0]["text"] == "No update draft yet"


async def test_new_requests_and_blockers_since_last_time(client, ctx, at):
    """protects=the monthly refresh's new_requests block (C1 requests filed in the
    window, not merged) and since_last's blockers opened and resolved in the window;
    fails_when=either is missing, a request outside the window or merged is listed, or a
    blocker opened earlier is counted; no_claim=the requests screen's own filters."""
    from datetime import UTC, datetime

    from oracle.baseline.models import Entity
    from oracle.requests.models import ProductRequest
    from oracle.v2.models import BlockerResolutionEvent

    inside = datetime(2026, 10, 21, 10, tzinfo=UTC)
    before = datetime(2026, 9, 1, 10, tzinfo=UTC)
    async with tenant_session(ctx.tenant_id) as db:
        db.add(
            ProductRequest(
                title="Export to spreadsheet", channel="support", origin="person", created_at=inside
            )
        )
        db.add(
            ProductRequest(title="Dark mode", channel="sales", origin="person", created_at=before)
        )
        opened = Entity(
            type="constraint",
            key="vendor-limit",
            title="Vendor rate limit",
            attrs={"blocker": {"type": "hard"}},
            status="confirmed",
            origin="user",
            created_at=inside,
        )
        old = Entity(
            type="constraint",
            key="legal-review",
            title="Legal review",
            attrs={"blocker": {"type": "soft"}},
            status="confirmed",
            origin="user",
            created_at=before,
        )
        db.add_all([opened, old])
        await db.flush()
        db.add(
            BlockerResolutionEvent(
                blocker_id=old.id,
                kind="status_changed",
                from_status="open",
                to_status="resolved",
                actor="user:test",
                created_at=inside,
            )
        )
        await db.commit()  # fmt: skip

    occ = await ready_occurrence(client, ctx, at, "goals_checkin")
    rows = {r["label"]: r for b in occ["pre_read"]["blocks"] if b["key"] == "since_last"
            for r in b["rows"]}  # fmt: skip
    assert rows["Blockers opened"]["count"] == 1
    assert rows["Blockers resolved"]["count"] == 1

    occ = await ready_occurrence(client, ctx, at, "roadmap_refresh")
    got = {b["key"]: b["rows"] for b in occ["pre_read"]["blocks"]}
    keys = list(got)
    assert keys.index("new_requests") == keys.index("priority_changes") + 1
    assert [r["title"] for r in got["new_requests"]] == ["Export to spreadsheet"]
    assert got["new_requests"][0]["href"].startswith("/requests")


async def test_the_goals_block_shows_homes_distance(client, ctx, at):
    """protects=criterion 5: goals_checkin's goals block reports "7 pts to go" for a
    confirmed goal at 38% against 45%; goals without a value say so; fails_when=another
    number, or proposed goals are listed; no_claim=change since last."""
    from oracle.baseline.models import Entity

    async with tenant_session(ctx.tenant_id) as db:
        db.add(Entity(type="goal", key="activation", title="Raise activation",
                      attrs={"metric": "Activation", "target_text": "45%", "current_text": "38%"},
                      status="confirmed", origin="user"))  # fmt: skip
        db.add(Entity(type="goal", key="nps", title="Lift NPS", attrs={"target": 50},
                      status="confirmed", origin="user"))  # fmt: skip
        db.add(Entity(type="goal", key="draft", title="Draft goal", attrs={},
                      status="proposed", origin="user"))  # fmt: skip
        await db.commit()
    occ = await ready_occurrence(client, ctx, at, "goals_checkin")
    goals = next(b for b in occ["pre_read"]["blocks"] if b["key"] == "goals")
    by_title = {r["title"]: r for r in goals["rows"]}
    assert set(by_title) == {"Raise activation", "Lift NPS"}
    assert by_title["Raise activation"]["distance"] == "7 pts to go"
    assert by_title["Lift NPS"]["distance"] == "No current value yet"


async def test_the_goals_block_writes_values_as_home_does(client, ctx, at):
    """protects=qa-company-6: a typed goal (9.4 of 12, unit %) reads "9.4% of 12% · 2.6 pts
    to go" in the pre-read, as Home shows it; fails_when="No current value", or the units
    are dropped; no_claim=goals still on text (the test above)."""
    from oracle.baseline.models import Entity

    async with tenant_session(ctx.tenant_id) as db:
        db.add(Entity(type="goal", key="paid", title="Grow paid conversion",
                      attrs={"metric": "Trial to paid rate", "unit": "%", "comparison": "at_least",
                             "target": 12, "current": 9.4},
                      status="confirmed", origin="user"))  # fmt: skip
        await db.commit()
    occ = await ready_occurrence(client, ctx, at, "goals_checkin")
    goals = next(b for b in occ["pre_read"]["blocks"] if b["key"] == "goals")
    (row,) = [r for r in goals["rows"] if r["title"] == "Grow paid conversion"]
    assert row["distance"] == "2.6 pts to go"
    assert row["text"] == "Grow paid conversion: 9.4% of 12% · 2.6 pts to go"


async def test_prepare_now_keeps_the_meeting_next_until_it_is_held(client, ctx, at):
    """protects=qa-company-7: Prepare now on the weekly check-in keeps its meeting as Next
    (with its ready pre-read) and does not call it the Last pre-read before its time; once
    the meeting time comes it is the Last and Next moves on; fails_when=Next jumps a week or
    Last names a meeting not yet held; no_claim=the screen (Playwright)."""
    await tick(ctx.tenant_id)
    ritual = (await rituals_of(ctx.tenant_id))["goals_checkin"]
    due = ritual.next_due_at
    resp = await client.post(f"/v1/rituals/{ritual.id}/prepare", headers=ctx.as_("owner"))
    assert resp.status_code == 200, resp.text
    occ = resp.json()
    assert rituals.parse_time(occ["due_at"]) == due

    def listed(rows):
        return next(r for r in rows if r["id"] == str(ritual.id))

    r = listed((await client.get("/v1/rituals", headers=ctx.as_("viewer"))).json())
    assert rituals.parse_time(r["next_due_at"]) == due
    assert r["next_pre_read"]["id"] == occ["id"]
    assert r["last_pre_read"] is None

    at(due + timedelta(minutes=1))
    r = listed((await client.get("/v1/rituals", headers=ctx.as_("viewer"))).json())
    assert r["last_pre_read"]["id"] == occ["id"]
    assert r["next_pre_read"] is None
    # A week on (an hour off across the change from summer time).
    assert rituals.parse_time(r["next_due_at"]) - due >= timedelta(days=6, hours=23)


async def test_prepare_now_on_a_paused_ritual_is_its_last_pre_read(client, ctx, at):
    """protects=qa-company-2: Prepare now on a paused ritual (no Next) makes the new
    pre-read its Last pre-read; and qa-company-1: prepare_usd says what Prepare now would
    spend (a summary once summaries are on Every pre-read); fails_when=Last stays empty
    while the occurrence is ready, or no cost is given; no_claim=the screen (Playwright)."""
    await tick(ctx.tenant_id)
    ritual = (await rituals_of(ctx.tenant_id))["goals_checkin"]
    resp = await client.post(f"/v1/rituals/{ritual.id}/pause", headers=ctx.as_("owner"))
    assert resp.status_code == 200, resp.text
    resp = await client.post(f"/v1/rituals/{ritual.id}/prepare", headers=ctx.as_("owner"))
    assert resp.status_code == 200, resp.text
    occ = resp.json()

    def listed(rows):
        return next(r for r in rows if r["id"] == str(ritual.id))

    r = listed((await client.get("/v1/rituals", headers=ctx.as_("viewer"))).json())
    assert r["next_pre_read"] is None
    assert r["last_pre_read"]["id"] == occ["id"]
    assert r["prepare_usd"] is None
    resp = await client.put(
        "/v1/rituals/summaries", json={"mode": "always"}, headers=ctx.as_("owner")
    )
    assert resp.status_code == 200, resp.text
    r = listed((await client.get("/v1/rituals", headers=ctx.as_("viewer"))).json())
    assert r["prepare_usd"] == 3.0


async def test_a_pre_read_ahead_is_never_the_last_of_an_active_ritual(client, ctx, at):
    """protects=review minor: with no Next pre-read (the stored next meeting moved before
    the one prepared early), an active ritual's pre-read still ahead is not its Last;
    fails_when=Last names a meeting not yet held; no_claim=the screen (Playwright)."""
    from oracle.rituals.models import Ritual

    await tick(ctx.tenant_id)
    ritual = (await rituals_of(ctx.tenant_id))["goals_checkin"]
    due = ritual.next_due_at
    resp = await client.post(f"/v1/rituals/{ritual.id}/prepare", headers=ctx.as_("owner"))
    assert resp.status_code == 200, resp.text
    async with tenant_session(ctx.tenant_id) as db:
        row = await db.get(Ritual, ritual.id)
        row.next_due_at = due - timedelta(days=1)
        await db.commit()
    rows = (await client.get("/v1/rituals", headers=ctx.as_("viewer"))).json()
    r = next(r for r in rows if r["id"] == str(ritual.id))
    assert r["next_pre_read"] is None
    assert r["last_pre_read"] is None


async def test_the_ritual_list_reads_the_summary_settings_once(client, ctx, at, monkeypatch):
    """protects=review minor: GET /v1/rituals reads the summaries setting and the Run
    rituals autonomy once for the list, not again for each ritual's prepare_usd;
    fails_when=each ritual re-reads them; no_claim=the costs (the tests above)."""
    from oracle import autonomy
    from oracle.rituals import summaries

    await tick(ctx.tenant_id)
    calls = {"mode": 0, "allows": 0}
    mode, allows = summaries.mode, autonomy.allows

    async def counted_mode(db):
        calls["mode"] += 1
        return await mode(db)

    async def counted_allows(db, key, *a, **k):
        calls["allows"] += key == "rituals"
        return await allows(db, key, *a, **k)

    monkeypatch.setattr(summaries, "mode", counted_mode)
    monkeypatch.setattr(autonomy, "allows", counted_allows)
    rows = (await client.get("/v1/rituals", headers=ctx.as_("viewer"))).json()
    assert len(rows) > 2
    assert calls["mode"] == 1
    assert calls["allows"] == 1


async def test_pre_read_and_record_notes_rows_in_the_inbox(client, ctx, at):
    """protects=criterion 6: an attendee has a counted pre_read row while ready and
    unread; reading it turns it done and lowers needs_me by 1; after the end the owner
    has a counted record_notes row until held; fails_when=a row is missing, uncounted,
    or stays after held; no_claim=the web Inbox (Playwright)."""
    occ = await ready_occurrence(client, ctx, at)
    inbox = (await client.get("/v1/inbox", headers=ctx.as_("approver"))).json()
    (row,) = [r for r in inbox["rituals"] if r["occurrence_id"] == occ["id"]]
    assert row["reason"] == "pre_read" and row["counts"] is True and row["state"] == "new"
    before = inbox["needs_me"]
    viewer = (await client.get("/v1/inbox", headers=ctx.as_("viewer"))).json()
    assert viewer["rituals"] == []
    resp = await client.post(f"/v1/ritual-occurrences/{occ['id']}/read",
                             headers=ctx.as_("approver"))  # fmt: skip
    assert resp.status_code == 204
    inbox = (await client.get("/v1/inbox", headers=ctx.as_("approver"))).json()
    (row,) = [r for r in inbox["rituals"] if r["occurrence_id"] == occ["id"]]
    assert row["state"] == "done" and row["counts"] is False
    assert inbox["needs_me"] == before - 1
    got = await client.get(f"/v1/ritual-occurrences/{occ['id']}", headers=ctx.as_("approver"))
    assert got.json()["read_by_me"] is True

    at(rituals.parse_time(occ["ends_at"]) + timedelta(minutes=1))
    inbox = (await client.get("/v1/inbox", headers=ctx.as_("owner"))).json()
    reasons = [r["reason"] for r in inbox["rituals"] if r["occurrence_id"] == occ["id"]]
    assert reasons == ["record_notes"]
    resp = await client.post(f"/v1/ritual-occurrences/{occ['id']}/held",
                             json={"notes": "Agreed to cut scope."},
                             headers=ctx.as_("approver"))  # fmt: skip
    assert resp.status_code == 403
    resp = await client.post(f"/v1/ritual-occurrences/{occ['id']}/held",
                             json={"notes": "Agreed to cut scope."},
                             headers=ctx.as_("owner"))  # fmt: skip
    assert resp.status_code == 200 and resp.json()["status"] == "held"
    assert resp.json()["notes"] == "Agreed to cut scope."
    inbox = (await client.get("/v1/inbox", headers=ctx.as_("owner"))).json()
    assert not any(r["occurrence_id"] == occ["id"] for r in inbox["rituals"])


async def test_skip_needs_a_reason(client, ctx, at):
    """protects=Skip needs a reason and is the owner's; fails_when=an empty reason
    skips; no_claim=the screen's wording."""
    occ = await ready_occurrence(client, ctx, at)
    url = f"/v1/ritual-occurrences/{occ['id']}/skip"
    assert (
        await client.post(url, json={"reason": ""}, headers=ctx.as_("owner"))
    ).status_code == 422
    resp = await client.post(url, json={"reason": "Team offsite"}, headers=ctx.as_("owner"))
    assert resp.status_code == 200 and resp.json()["status"] == "skipped"


async def test_summarize_with_oracle_starts_one_quick_run(client, ctx, at):
    """protects=criterion 9: POST …/summary creates one ritual_summary run estimated at
    $3.00 (quick depth) and links it (running); a second call while it runs is 409; a
    commenter gets 403; the finished run's summary is attached; fails_when=another
    estimate, two runs, or a commenter starts one; no_claim=the summary's quality."""
    set_runtime(FakeRuntime({"summary": [Outcome(artifacts={"summary.md": "Two slips."})]}))
    try:
        occ = await ready_occurrence(client, ctx, at)
        url = f"/v1/ritual-occurrences/{occ['id']}/summary"
        assert (await client.post(url, headers=ctx.as_("commenter"))).status_code == 403
        resp = await client.post(url, headers=ctx.as_("approver"))
        assert resp.status_code == 201, resp.text
        run_id = resp.json()["id"]
        async with tenant_session(ctx.tenant_id) as db:
            run = await db.get(Run, run_id)
            assert run.flow == "ritual_summary" and float(run.estimate_usd) == 3.0
        got = (await client.get(f"/v1/ritual-occurrences/{occ['id']}",
                                headers=ctx.as_("owner"))).json()  # fmt: skip
        assert got["summary_state"] == "running" and got["summary_run_id"] == run_id
        assert (await client.post(url, headers=ctx.as_("approver"))).status_code == 409
        for _ in range(3):
            await client.post("/v1/internal/tick", headers=ctx.as_("owner"))
        got = (await client.get(f"/v1/ritual-occurrences/{occ['id']}",
                                headers=ctx.as_("owner"))).json()  # fmt: skip
        assert got["summary_state"] == "ready" and got["summary"] == "Two slips."
    finally:
        set_runtime(None)


async def test_summary_settings_and_estimate(client, ctx, at):
    """protects=criterion 9a: a new company is on_demand, with only the three first
    built-ins active (an owner paused the others) they come to 5.66 runs and $16.98 a
    month, pausing the weekly check-in drops it to 1.33 and
    $3.99; owners switch to always (audited), approvers get 403, other values 422;
    fails_when=another figure, an approver changes it, or no audit event; no_claim=the
    screen's rounding (Playwright)."""
    await only(client, ctx, "goals_checkin", "roadmap_refresh", "goals_review")
    got = (await client.get("/v1/rituals/summaries", headers=ctx.as_("viewer"))).json()
    assert got["mode"] == "on_demand"
    assert got["estimate"]["runs_per_month"] == 5.66
    assert got["estimate"]["usd_per_month"] == 16.98
    assert got["estimate"]["per_summary_usd"] == 3.0
    assert len(got["estimate"]["rituals"]) == 3
    weekly = (await rituals_of(ctx.tenant_id))["goals_checkin"]
    await client.post(f"/v1/rituals/{weekly.id}/pause", headers=ctx.as_("owner"))
    got = (await client.get("/v1/rituals/summaries", headers=ctx.as_("viewer"))).json()
    assert got["estimate"]["runs_per_month"] == 1.33
    assert got["estimate"]["usd_per_month"] == 3.99
    url = "/v1/rituals/summaries"
    resp = await client.put(url, json={"mode": "always"}, headers=ctx.as_("approver"))
    assert resp.status_code == 403
    resp = await client.put(url, json={"mode": "sometimes"}, headers=ctx.as_("owner"))
    assert resp.status_code == 422
    resp = await client.put(url, json={"mode": "always"}, headers=ctx.as_("owner"))
    assert resp.status_code == 200
    assert resp.json()["mode"] == "always" and resp.json()["estimate"]["usd_per_month"] == 3.99
    async with tenant_session(ctx.tenant_id) as db:
        actions = list(await db.scalars(select(AuditEvent.action)))
    assert "ritual_summaries.changed" in actions


async def test_company_timezone_setting(client, ctx, at):
    """protects=company_timezone is validated with zoneinfo and new rituals take it;
    fails_when=an unknown zone is stored or seeding ignores it; no_claim=the setup
    checklist step."""
    url = "/v1/settings/company_timezone"
    resp = await client.put(url, json={"value": "Mars/Base"}, headers=ctx.as_("owner"))
    assert resp.status_code == 422
    resp = await client.put(url, json={"value": "Europe/Paris"}, headers=ctx.as_("owner"))
    assert resp.status_code == 200, resp.text
    await tick(ctx.tenant_id)
    assert (await rituals_of(ctx.tenant_id))["goals_checkin"].schedule["timezone"] == "Europe/Paris"


async def test_a_run_token_reads_the_pre_read_and_cannot_write(client, ctx, at):
    """protects=criterion 10: a run token with read:baseline reads pre-read.md; writes are
    403; fails_when=the read is refused or a write lands; no_claim=MCP tool listing."""
    occ = await ready_occurrence(client, ctx, at)
    # The local runtime: run tokens from any address (test_mcp's local_runtime).
    set_runtime(FakeRuntime())
    try:
        raw = await run_token(ctx.tenant_id, ["read:baseline"], ctx.users["owner"].id)
        async with mcp_client(raw) as c:
            names = {t.name for t in (await c.list_tools()).tools}
            assert "get_ritual_occurrence_pre_read" in names
            got = await c.call_tool("get_ritual_occurrence_pre_read", {"occurrence_id": occ["id"]})
            assert not got.is_error and "# Monthly roadmap refresh" in text_of(got)
            refused = await c.call_tool("read_ritual_occurrence", {"occurrence_id": occ["id"]})
            assert refused.is_error
    finally:
        set_runtime(None)


async def test_the_summary_prompt_names_its_tool(client, ctx, at):
    """protects=the ritual_summary segment's prompt tells the writer to read the pre-read
    with get_ritual_occurrence_pre_read and gives the occurrence id to call it with;
    fails_when=the task says the pre-read is "below" and the occurrence is named only by
    an HTTP path the agent cannot call; no_claim=the run's content."""
    from types import SimpleNamespace

    from oracle.rituals import summaries
    from oracle.runs import flows

    occ = await ready_occurrence(client, ctx, at)
    run = SimpleNamespace(knobs={"ritual_occurrence_id": occ["id"]})
    async with tenant_session(ctx.tenant_id) as db:
        lines = await summaries.prompt_lines(db, run)
    flow = flows.FLOWS["ritual_summary"]
    (sdef,) = flow.segments
    pctx = flows.PromptContext(
        run_id="r-1", document=None, snapshot_as_of=None, low_confidence=0.5, extra_lines=lines
    )
    prompt = flows.step_prompt(flow, sdef, "writer", last=True, ctx=pctx)
    (task,) = [line for line in prompt.splitlines() if line.startswith("Task: ")]
    assert "get_ritual_occurrence_pre_read" in task and "below" not in task
    call = f'get_ritual_occurrence_pre_read(occurrence_id="{occ["id"]}")'
    assert call in prompt
    assert "/pre-read.md" not in prompt
    assert (
        f"- get_ritual_occurrence_pre_read: {flows.MCP_TOOLS['get_ritual_occurrence_pre_read']}"
        in prompt
    )


async def test_another_companys_ids_are_404(client, ctx, at):
    """protects=criterion 11: every route answers 404 for another company's ritual or
    occurrence; fails_when=one leaks or acts; no_claim=list endpoints (tenant-filtered)."""
    occ = await ready_occurrence(client, ctx, at)
    other = await make_ctx("Other Co")
    h = other.as_("owner")
    rid, oid = occ["ritual_id"], occ["id"]
    calls = [
        ("GET", f"/v1/rituals/{rid}", None),
        ("PATCH", f"/v1/rituals/{rid}", {"lock_version": 1, "duration_min": 40}),
        ("POST", f"/v1/rituals/{rid}/pause", None),
        ("POST", f"/v1/rituals/{rid}/resume", None),
        ("POST", f"/v1/rituals/{rid}/prepare", None),
        ("DELETE", f"/v1/rituals/{rid}", None),
        ("GET", f"/v1/rituals/{rid}/occurrences", None),
        ("GET", f"/v1/ritual-occurrences/{oid}", None),
        ("GET", f"/v1/ritual-occurrences/{oid}/pre-read.md", None),
        ("POST", f"/v1/ritual-occurrences/{oid}/read", None),
        ("POST", f"/v1/ritual-occurrences/{oid}/held", {"notes": "x"}),
        ("POST", f"/v1/ritual-occurrences/{oid}/skip", {"reason": "x"}),
        ("POST", f"/v1/ritual-occurrences/{oid}/summary", None),
    ]
    for method, url, body in calls:
        resp = await client.request(method, url, json=body, headers=h)
        assert resp.status_code == 404, (method, url, resp.status_code)


async def _decision(tenant_id, approver_id, number: int, title: str, subjects=()) -> str:
    from datetime import UTC, date, datetime

    from oracle.decisions.models import Decision

    async with tenant_session(tenant_id) as db:
        d = Decision(
            number=number, title=title, status="decided", approver_id=approver_id,
            driver="Ada Example", origin="manual", chosen_option="a", rationale="Simpler",
            decided_at=datetime(2026, 10, 20, tzinfo=UTC), review_at=date(2027, 1, 20),
            subjects=list(subjects),
        )  # fmt: skip
        db.add(d)
        await db.commit()
        return str(d.id)


async def test_a_held_occurrence_lists_the_decisions_recorded_with_it(client, ctx, at):
    """protects=H2 review (major): "Held occurrences list the decisions recorded with
    them": a decision recorded from the occurrence (Record decision: its subject is the
    occurrence) and one named on Mark held are both listed, each with its number, title
    and a link to it on Company › Decisions; fails_when=the occurrence lists none, or
    a link opens no page; no_claim=the web page (web/e2e/rituals.spec.ts)."""
    occ = await ready_occurrence(client, ctx, at)
    owner = ctx.users["owner"].id
    subject = {"kind": "ritual_occurrence", "id": occ["id"], "ref": occ["title"]}
    recorded = await _decision(ctx.tenant_id, owner, 1, "Ship the importer first", [subject])
    named = await _decision(ctx.tenant_id, owner, 2, "Drop the legacy export")
    await _decision(ctx.tenant_id, owner, 3, "Unrelated decision")
    at(rituals.parse_time(occ["ends_at"]) + timedelta(minutes=1))
    url = f"/v1/ritual-occurrences/{occ['id']}/held"
    stranger = {"notes": "", "decision_ids": [str(rituals.uuid.uuid4())]}
    assert (await client.post(url, json=stranger, headers=ctx.as_("owner"))).status_code == 422
    resp = await client.post(url, json={"notes": "Done", "decision_ids": [named]},
                             headers=ctx.as_("owner"))  # fmt: skip
    assert resp.status_code == 200, resp.text
    assert sorted(resp.json()["decision_ids"]) == sorted([recorded, named])
    got = await client.get(f"/v1/ritual-occurrences/{occ['id']}", headers=ctx.as_("viewer"))
    assert got.json()["decisions"] == [
        {"id": recorded, "number": 1, "title": "Ship the importer first",
         "href": "/company/decisions?d=1"},
        {"id": named, "number": 2, "title": "Drop the legacy export",
         "href": "/company/decisions?d=2"},
    ]  # fmt: skip


def test_every_pre_read_link_opens_a_web_page():
    """protects=H2 review (major): every figure's link in a pre-read
    (oracle/rituals/blocks.py) opens a page the web app has (a ``page.tsx`` route, or the
    ``/roadmap`` redirect to ``/plan``); ``/v1/`` hrefs are the suggested_next buttons'
    API calls; fails_when=a link points at a page that does not exist, such as
    /company/decisions/<n>, /baseline/outcomes or /plan/changelog; no_claim=that the
    page opens the linked row (the query string is not checked)."""
    import re
    from pathlib import Path

    root = Path(__file__).parents[2]
    source = (root / "api/oracle/rituals/blocks.py").read_text()
    hrefs = re.findall(r'"href": f?"(/[^"?]*)', source)
    assert len(hrefs) > 15
    app = root / "web/app"
    redirects = {"/roadmap": "/plan"}

    def page_exists(path: str) -> bool:
        path = redirects.get(path, path)
        here = app
        for part in [p for p in path.split("/") if p]:
            if "{" in part:
                dynamic = [d for d in here.iterdir() if d.name.startswith("[")]
                if not dynamic:
                    return False
                here = dynamic[0]
            elif (here / part).is_dir():
                here = here / part
            else:
                return False
        return (here / "page.tsx").exists()

    missing = sorted({h for h in hrefs if not h.startswith("/v1/") and not page_exists(h)})
    assert missing == []
