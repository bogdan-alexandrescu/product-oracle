"""H6 Launches: planned on roadmap approval, Ready from ship signals, the tier Oracle
suggests and an approver sets, the checklist per tier, Mark launched and Cancel,
requester notes, Inbox rows, MCP and company isolation. Against Postgres with the
FakeRuntime.

Every test states its card: protects (the observable), fails_when (the wrong result
it rejects), no_claim (what green does not prove)."""

import uuid

import pytest
from sqlalchemy import select

from oracle.launches import checklist, service, tiers
from oracle.launches.models import Launch
from oracle.roadmap import shipped
from oracle.roadmap.models import TrackMilestone
from oracle.tenancy import tenant_session
from tests.launch_helpers import (
    approve_roadmap,
    build_roadmap,
    feature_before_prd,
    launched_world,
    member_asked,
    ticker_pass,
    trace_features,
    tracker_done,
)
from tests.roadmap_helpers import other_company
from tests.test_roadmap import (  # noqa: F401 - fixtures
    approved_prd,
    as_user,
    owner,
    runtime,
    seed_baseline,
)

TIER_1 = [
    "changelog_entry",
    "release_notes",
    "internal_announcement",
    "support_notes",
    "sales_briefing",
    "help_docs",
    "in_app_message",
    "customer_email",
    "positioning_check",
    "demo",
    "pre_mortem",
    "requester_notes",
]


# --------------------------------------------------------------------------- unit


@pytest.mark.parametrize(
    ("innovation", "goal", "tier"),
    [
        ("new", "top", 1),
        ("new", "other", 2),
        ("improvement", "top", 2),
        ("improvement", "other", 3),
        ("fix", "top", 3),
        ("fix", "other", 3),
    ],
)
def test_tier_matrix(innovation, goal, tier):
    """protects=the innovation x goal matrix, all 6 cells; fails_when=any cell maps to
    another tier; no_claim=how innovation and goal are read from the baseline."""
    assert tiers.matrix(innovation, goal) == tier


def test_tier_reason_in_words():
    """protects=the reason shown with a suggestion; fails_when=it does not name the kind of
    change and the goal; no_claim=the goal lookup."""
    assert tiers.reason("new", "top", "Raise activation") == (
        "New feature serving a top goal (Raise activation)"
    )
    assert tiers.reason("improvement", "other", "Cut churn") == (
        "Improvement serving another goal (Cut churn)"
    )
    assert tiers.reason("fix", "none", None) == "Fix or internal change"


def test_checklist_per_tier():
    """protects=the built-in checklist per tier, in the table's order; fails_when=a tier
    lists a task the table does not give it or misses one; no_claim=the stored rows."""
    assert [t.key for t in checklist.for_tier(1)] == TIER_1
    assert [t.key for t in checklist.for_tier(2)] == [
        "changelog_entry",
        "release_notes",
        "internal_announcement",
        "support_notes",
        "help_docs",
        "in_app_message",
        "customer_email",
        "requester_notes",
    ]
    assert [t.key for t in checklist.for_tier(3)] == [
        "changelog_entry",
        "support_notes",
        "requester_notes",
    ]
    by_key = {t.key: t for t in checklist.TASKS}
    assert by_key["release_notes"].audience == "external"
    assert by_key["positioning_check"].drafts == "no"
    assert by_key["help_docs"].drafts == "outline"
    assert by_key["in_app_message"].optional_in == (2,)


# --------------------------------------------------------------------------- integration


async def test_approving_a_roadmap_plans_a_launch_per_now_item(client, owner, runtime):  # noqa: F811
    """protects=criterion 1: approval plans one launch per Now item, owned by the approver,
    once; fails_when=a Next item gets a launch, a launch is missing, or approving again
    adds launches; no_claim=launches planned by hand (test_launch_crud_and_roles)."""
    tenant_id, auth = owner
    by_item = await launched_world(client, auth, runtime, tenant_id)
    assert set(by_item) == {"payment-step", "shipping-step"}
    for launch in by_item.values():
        assert launch["state"] == "planned"
        assert launch["owner_id"] is not None
        assert launch["track_id"] is not None
    me = (await client.get("/v1/me", headers=auth)).json()
    # The seed's token acts for its user: the approver is that person.
    assert {lnch["owner_id"] for lnch in by_item.values()} == {me["user_id"] or me["token_id"]}

    await approve_roadmap(client, auth)
    assert len((await client.get("/v1/launches", headers=auth)).json()) == 2


async def test_ready_from_tracker_records(client, owner, runtime):  # noqa: F811
    """protects=criterion 2: every matched tracker record done makes the launch Ready on
    the next ticker pass, with a counted Inbox row for its owner; fails_when=one record
    not done still makes it Ready, or no row appears; no_claim=the hourly schedule."""
    tenant_id, auth = owner
    by_item = await launched_world(client, auth, runtime, tenant_id)
    launch = by_item["payment-step"]
    track = launch["track_id"]
    await tracker_done(client, auth, track, "payment-step", "GH-1")
    await tracker_done(client, auth, track, "payment-step", "GH-2", state="in_progress")
    await ticker_pass(tenant_id)
    got = (await client.get(f"/v1/launches/{launch['id']}", headers=auth)).json()
    assert got["state"] == "planned"

    await tracker_done(client, auth, track, "payment-step", "GH-2")
    async with tenant_session(tenant_id) as s:
        assert set(await shipped.shipped_items(s, uuid.UUID(track))) == {"payment-step"}
    await ticker_pass(tenant_id)
    got = (await client.get(f"/v1/launches/{launch['id']}", headers=auth)).json()
    assert got["state"] == "ready" and got["ready_at"]
    inbox = (await client.get("/v1/inbox", headers=auth)).json()
    rows = [r for r in inbox["launches"] if r["reason"] == "ready"]
    assert [r["launch_id"] for r in rows] == [launch["id"]]
    assert rows[0]["counted"] is True and rows[0]["title"].startswith("Ready to launch")
    # The other launch is untouched.
    other = await client.get(f"/v1/launches/{by_item['shipping-step']['id']}", headers=auth)
    assert other.json()["state"] == "planned"


async def test_ready_from_milestones(client, owner, runtime):  # noqa: F811
    """protects=the milestone half of the ship-signal rule (shipped_items); fails_when=an
    item counts as shipped while a milestone listing it is still planned; no_claim=the
    tracker half (test_ready_from_tracker_records)."""
    tenant_id, auth = owner
    by_item = await launched_world(client, auth, runtime, tenant_id)
    track = uuid.UUID(by_item["shipping-step"]["track_id"])
    async with tenant_session(tenant_id) as s:
        s.add_all(
            [
                TrackMilestone(track_id=track, name="Beta", item_keys=["shipping-step"],
                               status="done"),
                TrackMilestone(track_id=track, name="GA", item_keys=["shipping-step"],
                               status="planned"),
            ]
        )  # fmt: skip
        await s.commit()
        assert await shipped.shipped_items(s, track) == {}
        ga = await s.scalar(select(TrackMilestone).where(TrackMilestone.name == "GA"))
        ga.status = "done"
        await s.commit()
        signals = await shipped.shipped_items(s, track)
        assert set(signals) == {"shipping-step"} and signals["shipping-step"][0] == "milestone"
    await ticker_pass(tenant_id)
    got = await client.get(f"/v1/launches/{by_item['shipping-step']['id']}", headers=auth)
    assert got.json()["state"] == "ready"


async def test_tier_suggestion_and_set_tier(client, owner, runtime):  # noqa: F811
    """protects=criterion 3: a new feature serving the top goal is suggested Tier 1 with
    its reason; an improvement serving a lower-weight goal Tier 3; an approver's tier is
    stored with who set it, a commenter's is refused; fails_when=the suggestion ignores
    the matrix or a commenter sets a tier; no_claim=the suggestion's wording in the UI."""
    tenant_id, auth = owner
    by_item = await launched_world(client, auth, runtime, tenant_id)
    launch = by_item["payment-step"]
    assert launch["tier"] is None
    assert launch["tier_suggestion"]["tier"] == 1
    assert launch["tier_suggestion"]["innovation"] == "new"
    assert launch["tier_suggestion"]["goal"] == "top"
    assert launch["tier_suggestion"]["reason"] == (
        "New feature serving a top goal (Raise activation)"
    )

    # An improvement (the feature predates the PRD) serving a lower-weight goal.
    from oracle.baseline.models import Edge, Entity

    async with tenant_session(tenant_id) as s:
        top = Entity(type="goal", key="retention", title="Keep buyers", status="confirmed",
                     origin="user", attrs={"weight": 3})  # fmt: skip
        s.add(top)
        await s.commit()
    await feature_before_prd(tenant_id, "shipping-step")
    async with tenant_session(tenant_id) as s:
        row = await s.get(Launch, uuid.UUID(by_item["shipping-step"]["id"]))
        suggestion = await tiers.suggest(s, row)
        assert (suggestion["tier"], suggestion["innovation"], suggestion["goal"]) == (
            3,
            "improvement",
            "other",
        )
        # A feature serving no confirmed goal at all: "none".
        await s.execute(Edge.__table__.delete())
        suggestion = await tiers.suggest(s, row)
        assert suggestion["goal"] == "none" and suggestion["tier"] == 3

    approver = await as_user(tenant_id, "approver")
    commenter = await as_user(tenant_id, "commenter")
    url = f"/v1/launches/{launch['id']}"
    body = {"tier": 2, "lock_version": launch["lock_version"]}
    assert (await client.patch(url, json=body, headers=commenter)).status_code == 403
    resp = await client.patch(url, json=body, headers=approver)
    assert resp.status_code == 200, resp.text
    assert resp.json()["tier"] == 2
    async with tenant_session(tenant_id) as s:
        assert (await s.get(Launch, uuid.UUID(launch["id"]))).tier_set_by is not None
    version = resp.json()["lock_version"]
    for bad in (0, 4):
        refused = await client.patch(url, json={"tier": bad, "lock_version": version}, headers=auth)
        assert refused.status_code == 422
    stale = await client.patch(url, json={"tier": 1, "lock_version": 1}, headers=auth)
    assert stale.status_code == 409


async def test_checklist_follows_the_tier(client, owner, runtime):  # noqa: F811
    """protects=criterion 4: tier 1 has the 12 tasks in the table's order; tier 3 keeps
    drafted and done tasks and drops untouched todo tasks it does not list; fails_when=a
    touched task is dropped or an unlisted todo task stays; no_claim=drafting the text."""
    tenant_id, auth = owner
    by_item = await launched_world(client, auth, runtime, tenant_id)
    url = f"/v1/launches/{by_item['payment-step']['id']}"
    launch = (await client.get(url, headers=auth)).json()
    launch = (
        await client.patch(url, json={"tier": 1, "lock_version": launch["lock_version"]},
                           headers=auth)
    ).json()  # fmt: skip
    assert [t["key"] for t in launch["tasks"]] == TIER_1
    assert launch["task_counts"] == {"total": 12, "closed": 0, "open": 12}
    tasks = {t["key"]: t for t in launch["tasks"]}

    # Draft the release notes, finish the demo, add a task of our own.
    resp = await client.patch(
        f"/v1/launch-tasks/{tasks['release_notes']['id']}",
        json={"body": "Saved cards pay in one tap.", "lock_version": 1},
        headers=auth,
    )
    assert resp.status_code == 200 and resp.json()["status"] == "drafted"
    resp = await client.patch(
        f"/v1/launch-tasks/{tasks['demo']['id']}",
        json={"status": "done", "lock_version": 1},
        headers=auth,
    )
    assert resp.status_code == 200 and resp.json()["status"] == "done"
    resp = await client.post(
        f"{url}/tasks", json={"title": "Partner webinar", "audience": "external"}, headers=auth
    )
    assert resp.status_code == 201 and resp.json()["key"] is None

    launch = (await client.get(url, headers=auth)).json()
    launch = (
        await client.patch(url, json={"tier": 3, "lock_version": launch["lock_version"]},
                           headers=auth)
    ).json()  # fmt: skip
    keys = [t["key"] or t["title"] for t in launch["tasks"]]
    assert keys == [
        "changelog_entry",
        "release_notes",
        "support_notes",
        "demo",
        "requester_notes",
        "Partner webinar",
    ]
    # Back to tier 1: the dropped tasks come back, in the table's order.
    launch = (
        await client.patch(url, json={"tier": 1, "lock_version": launch["lock_version"]},
                           headers=auth)
    ).json()  # fmt: skip
    assert [t["key"] for t in launch["tasks"] if t["key"]] == TIER_1


async def test_tasks_skip_needs_a_reason_and_owner_rules(client, owner, runtime):  # noqa: F811
    """protects=task states: skipped needs a reason (422), the task owner (a commenter)
    may update it, another commenter may not; fails_when=a skip without a reason is
    stored or any commenter edits any task; no_claim=the UI's skip dialog."""
    tenant_id, auth = owner
    by_item = await launched_world(client, auth, runtime, tenant_id)
    launch = (await client.get(f"/v1/launches/{by_item['payment-step']['id']}",
                               headers=auth)).json()  # fmt: skip
    task = next(t for t in launch["tasks"] if t["key"] == "support_notes")
    url = f"/v1/launch-tasks/{task['id']}"
    resp = await client.patch(url, json={"status": "skipped", "lock_version": 1}, headers=auth)
    assert resp.status_code == 422

    async with tenant_session(tenant_id) as s:
        from oracle.auth.service import create_user

        helper = await create_user(s, "support.lead@example.com", "pw")
        helper.role = "commenter"
        await s.commit()
        helper_id = helper.id
    resp = await client.patch(
        url, json={"owner_id": str(helper_id), "lock_version": 1}, headers=auth
    )
    assert resp.status_code == 200 and resp.json()["owner_id"] == str(helper_id)
    from oracle.auth.service import make_session_cookie
    from oracle.config import get_settings

    async with tenant_session(tenant_id) as s:
        from oracle.auth.models import User

        cookie = make_session_cookie(await s.get(User, helper_id))
    as_helper = {"Cookie": f"{get_settings().session_cookie_name}={cookie}"}
    other = await as_user(tenant_id, "commenter")
    body = {"status": "skipped", "skip_reason": "Covered by the FAQ", "lock_version": 2}
    assert (await client.patch(url, json=body, headers=other)).status_code == 403
    resp = await client.patch(url, json=body, headers=as_helper)
    assert resp.status_code == 200, resp.text
    assert resp.json()["status"] == "skipped" and resp.json()["skip_reason"] == "Covered by the FAQ"
    assert (await client.patch(url, json=body, headers=auth)).status_code == 409


async def test_mark_launched_and_cancel(client, owner, runtime):  # noqa: F811
    """protects=criterion 6 and the lifecycle: Mark launched by an approver sets
    launched_at, sends the launch ship signal per item, lists requesters (members from
    addressed comments); a second call is 409 "Already launched"; Cancel needs a reason
    and only from planned or ready; fails_when=a commenter launches, the signal or the
    requester is missing, or launching twice succeeds; no_claim=C1 requests (empty until
    C1 ships) and H3's own outcome records."""
    tenant_id, auth = owner
    by_item = await launched_world(client, auth, runtime, tenant_id)
    asker = await member_asked(tenant_id, "Rita", "s-5-1", "Can buyers keep their card?")
    await member_asked(tenant_id, "Sam", "s-5-2", "Shipping options earlier, please")
    signals: list[tuple[str, str]] = []

    async def h3(db, launch, item_key, kind, at):
        signals.append((item_key, kind))

    service.register_ship_signal("test.h3", h3)
    try:
        launch = by_item["payment-step"]
        url = f"/v1/launches/{launch['id']}"
        commenter = await as_user(tenant_id, "commenter")
        assert (await client.post(f"{url}/launched", json={}, headers=commenter)).status_code == 403
        resp = await client.post(f"{url}/launched", json={}, headers=auth)
        assert resp.status_code == 200, resp.text
        out = resp.json()
        assert out["state"] == "launched" and out["launched_at"]
        assert out["notes"]["total"] == 1
        assert signals == [("payment-step", "launch")]
        again = await client.post(f"{url}/launched", json={}, headers=auth)
        assert again.status_code == 409 and again.json()["detail"] == "Already launched"
    finally:
        service.unregister_ship_signal("test.h3")

    notes = (await client.get(f"{url}/notes", headers=auth)).json()
    assert [(n["requester_kind"], n["member_id"]) for n in notes] == [("member", str(asker))]
    assert notes[0]["asked"] == "Can buyers keep their card?"
    assert notes[0]["display_name"] == "rita@example.com"

    # Cancel: a reason, and only before launch.
    other = f"/v1/launches/{by_item['shipping-step']['id']}"
    assert (
        await client.post(f"{other}/cancel", json={"reason": ""}, headers=auth)
    ).status_code == 422
    resp = await client.post(f"{other}/cancel", json={"reason": "Folded into Q1"}, headers=auth)
    assert resp.status_code == 200 and resp.json()["state"] == "cancelled"
    assert (
        await client.post(f"{url}/cancel", json={"reason": "x"}, headers=auth)
    ).status_code == 409
    assert (await client.post(f"{other}/launched", json={}, headers=auth)).status_code == 409


async def test_launch_crud_and_roles(client, owner, runtime):  # noqa: F811
    """protects=Plan a launch by hand: approver only, items must be on the track's latest
    approved roadmap (422), one live launch per items (409); viewers read and filter;
    fails_when=a viewer creates one, an unknown item is accepted, or a duplicate is made;
    no_claim=grouping across tracks."""
    tenant_id, auth = owner
    by_item = await launched_world(client, auth, runtime, tenant_id)
    track = by_item["payment-step"]["track_id"]
    viewer = await as_user(tenant_id, "viewer")
    body = {"title": "Order tracking", "track_id": track, "item_keys": ["order-tracking"]}
    assert (await client.post("/v1/launches", json=body, headers=viewer)).status_code == 403
    resp = await client.post("/v1/launches", json=body, headers=auth)
    assert resp.status_code == 201, resp.text
    created = resp.json()
    assert created["state"] == "planned" and created["item_keys"] == ["order-tracking"]
    assert (await client.post("/v1/launches", json=body, headers=auth)).status_code == 409
    bad = {**body, "item_keys": ["not-an-item"]}
    resp = await client.post("/v1/launches", json=bad, headers=auth)
    assert resp.status_code == 422 and "not-an-item" in resp.json()["detail"]

    listed = (await client.get("/v1/launches", headers=viewer)).json()
    assert len(listed) == 3
    planned = await client.get("/v1/launches", params={"state": "planned"}, headers=viewer)
    assert len(planned.json()) == 3
    tier1 = (await client.get("/v1/launches", params={"tier": 1}, headers=viewer)).json()
    assert tier1 == []
    one = (await client.get(f"/v1/launches/{created['id']}", headers=viewer)).json()
    assert one["items"][0]["item_key"] == "order-tracking"
    assert one["items"][0]["title"] == "Order tracking"


async def test_requester_notes_sent_skipped_and_inbox(client, owner, runtime):  # noqa: F811
    """protects=criterion 7: sent needs a channel (422), skipped a reason (422); the
    owner's counted "Notes to send" row counts open notes and goes once all are sent or
    skipped; people added by hand get a note too; fails_when=a note is marked sent with
    no channel or the row outlives the last open note; no_claim=sending anything (Oracle
    never does)."""
    tenant_id, auth = owner
    by_item = await launched_world(client, auth, runtime, tenant_id)
    await member_asked(tenant_id, "Rita", "s-5-1", "Can buyers keep their card?")
    url = f"/v1/launches/{by_item['payment-step']['id']}"
    resp = await client.post(
        f"{url}/notes",
        json={"display_name": "Dana at a pilot customer", "contact_hint": "via the support desk",
              "asked": "Please let us save cards"},
        headers=auth,
    )  # fmt: skip
    assert resp.status_code == 201 and resp.json()["requester_kind"] == "manual"
    assert (await client.post(f"{url}/launched", json={}, headers=auth)).status_code == 200
    notes = (await client.get(f"{url}/notes", headers=auth)).json()
    assert len(notes) == 2

    def notes_row(inbox):
        return [r for r in inbox["launches"] if r["reason"] == "notes_to_send"]

    inbox = (await client.get("/v1/inbox", headers=auth)).json()
    (row,) = notes_row(inbox)
    assert row["count"] == 2 and row["counted"] is True
    assert row["title"] == "Notes to send · Payment step · 2"
    total = inbox["total"]

    manual = next(n for n in notes if n["requester_kind"] == "manual")
    member = next(n for n in notes if n["requester_kind"] == "member")
    patch = f"/v1/requester-notes/{manual['id']}"
    assert (await client.patch(patch, json={"status": "sent"}, headers=auth)).status_code == 422
    resp = await client.patch(
        patch, json={"status": "sent", "channel": "email", "sent_on": "2026-10-21"}, headers=auth
    )
    assert resp.status_code == 200 and resp.json()["status"] == "sent"
    inbox = (await client.get("/v1/inbox", headers=auth)).json()
    assert notes_row(inbox)[0]["count"] == 1 and inbox["total"] == total
    patch = f"/v1/requester-notes/{member['id']}"
    assert (await client.patch(patch, json={"status": "skipped"}, headers=auth)).status_code == 422
    resp = await client.patch(
        patch, json={"status": "skipped", "skip_reason": "Told them in person"}, headers=auth
    )
    assert resp.status_code == 200
    inbox = (await client.get("/v1/inbox", headers=auth)).json()
    assert notes_row(inbox) == [] and inbox["total"] == total - 1
    # A viewer cannot touch notes.
    viewer = await as_user(tenant_id, "viewer")
    resp = await client.patch(patch, json={"body": "x"}, headers=viewer)
    assert resp.status_code == 403


async def test_notify_members_shows_a_shipped_row(client, owner, runtime):  # noqa: F811
    """protects=criterion 8: Notify members gives each member requester one shown-only
    "Shipped" row (in neither total nor needs_me) and sets their notes to notified;
    fails_when=the row is counted, goes to another member, or the note stays drafted;
    no_claim=external requesters (people send those notes)."""
    tenant_id, auth = owner
    by_item = await launched_world(client, auth, runtime, tenant_id)
    rita = await member_asked(tenant_id, "Rita", "s-5-1", "Can buyers keep their card?")
    url = f"/v1/launches/{by_item['payment-step']['id']}"
    assert (await client.post(f"{url}/notify-members", headers=auth)).status_code == 409
    assert (await client.post(f"{url}/launched", json={}, headers=auth)).status_code == 200

    from oracle.auth.models import User
    from oracle.auth.service import make_session_cookie
    from oracle.config import get_settings

    async with tenant_session(tenant_id) as s:
        cookie = make_session_cookie(await s.get(User, rita))
    as_rita = {"Cookie": f"{get_settings().session_cookie_name}={cookie}"}
    before = (await client.get("/v1/inbox", headers=as_rita)).json()
    assert before["launches"] == []

    resp = await client.post(f"{url}/notify-members", headers=auth)
    assert resp.status_code == 200 and resp.json() == {"notified": 1}
    notes = (await client.get(f"{url}/notes", headers=auth)).json()
    assert [n["status"] for n in notes] == ["notified"]
    after = (await client.get("/v1/inbox", headers=as_rita)).json()
    (row,) = after["launches"]
    assert row["reason"] == "shipped_note" and row["counted"] is False
    assert row["title"] == "Shipped: Payment step"
    assert after["total"] == before["total"] and after["needs_me"] == before["needs_me"]
    other = await as_user(tenant_id, "commenter")
    assert (await client.get("/v1/inbox", headers=other)).json()["launches"] == []


async def test_set_tier_row_for_approvers(client, owner, runtime):  # noqa: F811
    """protects=the counted "Set tier" row: approvers see it until a tier is set,
    commenters never; fails_when=it stays after Set tier or a commenter sees it;
    no_claim=the Inbox screen."""
    tenant_id, auth = owner
    by_item = await launched_world(client, auth, runtime, tenant_id)
    approver = await as_user(tenant_id, "approver")
    commenter = await as_user(tenant_id, "commenter")
    rows = [r for r in (await client.get("/v1/inbox", headers=approver)).json()["launches"]
            if r["reason"] == "set_tier"]  # fmt: skip
    assert {r["title"] for r in rows} == {"Set tier · Payment step", "Set tier · Shipping step"}
    assert all(r["counted"] for r in rows)
    assert (await client.get("/v1/inbox", headers=commenter)).json()["launches"] == []
    launch = by_item["payment-step"]
    await client.patch(
        f"/v1/launches/{launch['id']}", json={"tier": 1, "lock_version": launch["lock_version"]},
        headers=auth,
    )  # fmt: skip
    rows = [r for r in (await client.get("/v1/inbox", headers=approver)).json()["launches"]
            if r["reason"] == "set_tier"]  # fmt: skip
    assert [r["title"] for r in rows] == ["Set tier · Shipping step"]


async def test_run_token_reads_but_never_writes(client, owner, runtime):  # noqa: F811
    """protects=criterion 10: a run token reads launches and the changelog; launched,
    publish and requester-note writes are refused, and the notes need read:sources;
    fails_when=a run token marks launched, publishes or reads notes on read:baseline
    alone; no_claim=people's MCP clients (they follow REST roles)."""
    from oracle.mcp.scopes import required_scope

    assert required_scope("GET", "/v1/launches") == "read:baseline"
    assert required_scope("GET", "/v1/launches/{launch_id}") == "read:baseline"
    assert required_scope("GET", "/v1/changelog") == "read:baseline"
    assert required_scope("GET", "/v1/launches/{launch_id}/notes") == "read:sources"
    for method, path in (
        ("POST", "/v1/launches/{launch_id}/launched"),
        ("POST", "/v1/changelog/{entry_id}/publish"),
        ("PATCH", "/v1/requester-notes/{note_id}"),
        ("POST", "/v1/launches/{launch_id}/notify-members"),
    ):
        assert required_scope(method, path) is None

    from tests.test_mcp import mcp_client, run_token, text_of, user_with_role

    tenant_id, auth = owner
    by_item = await launched_world(client, auth, runtime, tenant_id)
    launch_id = by_item["payment-step"]["id"]
    pm = await user_with_role(tenant_id, "owner")
    token = await run_token(tenant_id, ["read:baseline", "read:documents"], pm.id)
    async with mcp_client(token) as c:
        got = await c.call_tool("get_launch", {"launch_id": launch_id})
        assert not got.is_error, text_of(got)
        assert got.structured_content["id"] == launch_id
        refused = await c.call_tool("mark_launched", {"launch_id": launch_id, "body": {}})
        assert refused.is_error and "not available to run tokens" in text_of(refused)
        refused = await c.call_tool("list_requester_notes", {"launch_id": launch_id})
        assert refused.is_error and "read:sources" in text_of(refused)


async def test_another_companys_ids_are_404(client, owner, runtime):  # noqa: F811
    """protects=criterion 11: every launch, task, note and changelog route is 404 for
    another company's ids; fails_when=any of them reads or changes the other company's
    row; no_claim=database-level isolation beyond the tenant session."""
    tenant_id, auth = owner
    by_item = await launched_world(client, auth, runtime, tenant_id)
    await member_asked(tenant_id, "Rita", "s-5-1", "Can buyers keep their card?")
    launch = by_item["payment-step"]
    url = f"/v1/launches/{launch['id']}"
    await client.post(f"{url}/launched", json={}, headers=auth)
    task = (await client.get(url, headers=auth)).json()["tasks"][0]
    note = (await client.get(f"{url}/notes", headers=auth)).json()[0]
    entry = (
        await client.post(
            "/v1/changelog",
            json={"category": "added", "audience": "internal", "title": "Saved cards",
                  "body": "", "released_on": "2026-10-21"},
            headers=auth,
        )
    ).json()  # fmt: skip
    other = await other_company()
    calls = [
        ("GET", url, None),
        ("PATCH", url, {"tier": 1, "lock_version": 1}),
        ("POST", f"{url}/launched", {}),
        ("POST", f"{url}/cancel", {"reason": "x"}),
        ("POST", f"{url}/draft", None),
        ("POST", f"{url}/tasks", {"title": "x", "audience": "internal"}),
        ("GET", f"{url}/notes", None),
        ("POST", f"{url}/notes", {"display_name": "x"}),
        ("POST", f"{url}/notify-members", None),
        ("PATCH", f"/v1/launch-tasks/{task['id']}", {"status": "done", "lock_version": 1}),
        ("PATCH", f"/v1/requester-notes/{note['id']}", {"body": "x"}),
        ("PATCH", f"/v1/changelog/{entry['id']}", {"title": "x", "lock_version": 1}),
        ("POST", f"/v1/changelog/{entry['id']}/publish", None),
        ("POST", f"/v1/changelog/{entry['id']}/withdraw", None),
    ]
    for method, path, body in calls:
        resp = await client.request(method, path, json=body, headers=other)
        assert resp.status_code == 404, (method, path, resp.status_code, resp.text)
    assert (await client.get("/v1/launches", headers=other)).json() == []
    assert (await client.get("/v1/changelog", headers=other)).json() == []


async def test_a_roadmap_without_now_items_plans_nothing(client, owner, runtime):  # noqa: F811
    """protects=only Now items are planned; fails_when=Next or Later items get launches;
    no_claim=roadmaps without a track."""
    tenant_id, auth = owner
    from tests.test_roadmap import ITEMS

    await approved_prd(client, auth)
    await seed_baseline(tenant_id)
    undated = ITEMS.replace("horizon: now", "horizon: next").replace(
        "milestone: {name: Beta, date: 2026-11-30, date_source: ENG-412 estimate}",
        "milestone: Beta",
    )
    await build_roadmap(client, auth, runtime, undated)
    await trace_features(tenant_id)
    await approve_roadmap(client, auth)
    assert (await client.get("/v1/launches", headers=auth)).json() == []


async def test_act_within_limits_publishes_and_notifies_on_launch(client, owner, runtime):  # noqa: F811
    """protects=#519 item 1: with H11 Autonomy's launches set to "Act within limits"
    through PUT /v1/autonomy/launches, Mark launched has Oracle notify the member requesters
    (their note is notified, they get the "Shipped" row) and tells the launch's owner with an
    "Oracle did" record; at the default (Draft) the note stays for a person; fails_when=the
    level is read in a shape H11 never stores, so "act" never fires; no_claim=public entries
    (Oracle never publishes those)."""
    tenant_id, auth = owner
    by_item = await launched_world(client, auth, runtime, tenant_id)
    await member_asked(tenant_id, "Rita", "s-5-1", "Can buyers keep their card?")
    await member_asked(tenant_id, "Sam", "s-5-2", "Shipping options earlier, please")
    # The default: people notify.
    url = f"/v1/launches/{by_item['shipping-step']['id']}"
    assert (await client.post(f"{url}/launched", json={}, headers=auth)).status_code == 200
    notes = (await client.get(f"{url}/notes", headers=auth)).json()
    assert [n["status"] for n in notes] == ["drafted"], notes
    resp = await client.put(
        "/v1/autonomy/launches",
        json={"level": "act", "reason": "Internal launch notes are routine"},
        headers=auth,
    )
    assert resp.status_code == 200, resp.text
    url = f"/v1/launches/{by_item['payment-step']['id']}"
    assert (await client.post(f"{url}/launched", json={}, headers=auth)).status_code == 200
    notes = (await client.get(f"{url}/notes", headers=auth)).json()
    assert [n["status"] for n in notes] == ["notified"], notes
    from oracle.autonomy_models import OracleAction

    async with tenant_session(tenant_id) as s:
        actions = list(await s.scalars(select(OracleAction)))
    assert [a.responsibility for a in actions] == ["launches"]
    assert "Payment step" in actions[0].summary
