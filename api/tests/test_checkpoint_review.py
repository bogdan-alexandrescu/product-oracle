"""D8 Shared draft decision: each pending checkpoint has one draft on the server, a list of
per-item actions and a note to the agents, read by every member and written by role:
commenters suggest, the checkpoint's approver role or above stages, removes, edits the note
and decides. Every write bumps the draft's revision; a decision sent with an older revision
is refused (409 ``review_changed``). After the decision the draft is frozen and kept.

Unit tests check :func:`oracle.runs.actions.validate` (the roadmap items vocabulary); the
integration tests wait a ``prd_to_roadmap`` run at its Roadmap items checkpoint on the
FakeRuntime against Postgres.

Test cards (protects / fails_when / no_claim) head each test. Synthetic placeholders only.
"""

import uuid
from datetime import UTC, datetime, timedelta

import pytest
from sqlalchemy import func, select

from oracle.members.names import display_name
from oracle.models import AuditEvent
from oracle.runs import actions
from oracle.runs.models import Checkpoint, CheckpointAction
from oracle.tenancy import tenant_session
from oracle.v2.models import StakeholderQuestion
from tests.review_v2_helpers import person
from tests.test_roadmap import (  # noqa: F401 - fixtures
    approved_prd,
    owner,
    pending,
    runtime,
    seed_baseline,
)
from tests.test_roadmap_reasons import SECOND, roadmap_items_check

ITEMS = ["payment-step", "mobile-push", "gift-cards"]
VOCAB = actions.ValidationContext(
    item_keys=frozenset(ITEMS),
    prd_sections=frozenset({"s-5-1", "s-5-2"}),
    # An item of the comparison base the file dropped (a "Keep" restores it).
    dropped_keys=frozenset({"shipping-step"}),
)


# --- unit: actions.validate --------------------------------------------------------------


def body(kind: str, item_key: str = "mobile-push", **kw) -> actions.ActionIn:
    return actions.ActionIn(item_key=item_key, kind=kind, **kw)


@pytest.mark.parametrize(
    "action",
    [
        body("accept", answers=["low_confidence"]),
        body("edit", field="horizon", value="now"),
        body("edit", field="milestone_date", value=None),
        body("edit", field="milestone_name", value="GA"),
        body("edit", field="depends_on", value={"add": ["payment-step"], "remove": []}),
        body("edit", field="outcome", value="Owners hear about spikes"),
        body("edit", field="title", value="Mobile alerts"),
        body("edit", field="prd_section", value="s-5-2"),
        body("edit", field="order", value=None),
        body("edit", field="clear:confidence", value=None),
        body("drop"),
        body("restore", item_key="shipping-step"),
        body("split", value={"into": ["mobile-ios", "mobile-android"]}),
        body("merge", value={"with": ["payment-step"]}),
        body("question", value={"asked_to": str(uuid.uuid4()), "text": "Is push in scope?"}),
        body("waive", value={"reason": "Accepted risk for the beta"}),
        body("accept", item_key="*"),
    ],
)
def test_the_roadmap_items_vocabulary_accepts_its_shapes(action):
    """protects=every D2 fix and the documented shapes are storable; fails_when=a valid
    action is refused; no_claim=role checks (the routes do those)."""
    actions.validate("roadmap_items", action, VOCAB)


@pytest.mark.parametrize(
    ("action", "rule"),
    [
        (body("bless"), "unknown action kind bless"),
        (body("look_again", value={"note": "x"}), "look_again does not apply"),
        (body("add"), "add does not apply"),
        (body("edit", field="colour", value="red"), "edit cannot change colour"),
        (body("edit"), "edit cannot change"),
        (body("edit", field="horizon", value="soon"), "horizon is now, next or later"),
        (body("edit", field="milestone_date", value="2026-12-01"), "milestone_date"),
        (body("edit", field="milestone_name", value="x" * 121), "120"),
        (body("edit", field="title", value="x" * 201), "200"),
        (body("edit", field="outcome", value="x" * 501), "500"),
        (body("edit", field="depends_on", value={"add": ["x"]}), "depends_on names unknown item x"),
        (body("edit", field="depends_on", value=["payment-step"]), "depends_on"),
        (body("edit", field="prd_section", value="s-9"), "s-9 is not in the PRD version"),
        (body("edit", field="clear:colour", value=None), "clear:colour"),
        (body("waive", value={}), "waive needs a reason"),
        (body("waive", value={"reason": "  "}), "waive needs a reason"),
        (body("question", value={"text": "Who?"}), "question needs asked_to"),
        (body("question", value={"asked_to": str(uuid.uuid4()), "text": ""}), "question needs"),
        (body("merge", value={"with": ["nope"]}), "merge names unknown item nope"),
        (body("split", value={"into": []}), "split needs"),
        (body("drop", value="x"), "drop takes no value"),
        (body("accept", item_key="no-such-item"), "no-such-item is not an item"),
    ],
)
def test_invalid_actions_are_refused_naming_the_rule(action, rule):
    """protects=only the vocabulary is stored; fails_when=an invalid kind, field or value
    is accepted, or the message does not name the rule; no_claim=role checks."""
    with pytest.raises(actions.InvalidAction, match=rule):
        actions.validate("roadmap_items", action, VOCAB)


def test_a_checkpoint_kind_without_a_vocabulary_takes_no_actions():
    """protects=kinds whose spec has not registered a vocabulary store nothing;
    fails_when=a priority order action is stored; no_claim=later specs' vocabularies."""
    assert "roadmap_items" in actions.VOCABULARY
    assert "priority_order" not in actions.VOCABULARY
    with pytest.raises(actions.InvalidAction, match="takes no item actions"):
        actions.validate("priority_order", body("accept"), VOCAB)


def test_the_kinds_constraint_lists_every_backlog_kind():
    """protects=later picks add no migration for the kinds check; fails_when=a backlog
    kind is missing; no_claim=their vocabularies."""
    from oracle.runs.models import ACTION_KINDS, ACTION_STATES

    assert set(ACTION_KINDS) == {
        "accept", "edit", "drop", "restore", "split", "merge", "question", "waive",
        "look_again", "add",
    }  # fmt: skip
    assert ACTION_STATES == ("staged", "suggested")


# --- integration -------------------------------------------------------------------------


class Review:
    """A prd_to_roadmap run waiting at Roadmap items, and one member per role."""

    def __init__(self, client, tenant_id, auth, run, cp, people):
        self.client, self.tenant_id, self.auth = client, tenant_id, auth
        self.run, self.cp, self.people = run, cp, people

    @property
    def base(self) -> str:
        return f"/v1/runs/{self.run['id']}/checkpoints/{self.cp['id']}"

    def h(self, who: str) -> dict[str, str]:
        return self.auth if who == "owner" else self.people[who].headers

    def id(self, who: str) -> str:
        return str(self.people[who].user_id)

    async def get(self, who: str = "viewer", expect: int = 200) -> dict:
        resp = await self.client.get(f"{self.base}/review", headers=self.h(who))
        assert resp.status_code == expect, resp.text
        return resp.json()

    async def act(self, who: str, expect: int = 200, **action) -> dict:
        resp = await self.client.post(f"{self.base}/actions", json=action, headers=self.h(who))
        assert resp.status_code == expect, resp.text
        return resp.json()

    async def stage(self, who: str, action_id: str, expect: int = 200) -> dict:
        resp = await self.client.post(
            f"{self.base}/actions/{action_id}/stage", json={}, headers=self.h(who)
        )
        assert resp.status_code == expect, resp.text
        return resp.json()

    async def remove(self, who: str, action_id: str, expect: int = 200) -> dict:
        resp = await self.client.delete(f"{self.base}/actions/{action_id}", headers=self.h(who))
        assert resp.status_code == expect, resp.text
        return resp.json()

    async def note(self, who: str, note: str | None, expect: int = 200) -> dict:
        resp = await self.client.put(f"{self.base}/note", json={"note": note}, headers=self.h(who))
        assert resp.status_code == expect, resp.text
        return resp.json()

    async def decide(self, who: str, expect: int = 200, **body) -> dict:
        resp = await self.client.post(f"{self.base}/decide", json=body, headers=self.h(who))
        assert resp.status_code == expect, resp.text
        return resp.json()

    async def set_payload(self, **changes) -> None:
        async with tenant_session(self.tenant_id) as s:
            row = await s.get(Checkpoint, uuid.UUID(self.cp["id"]))
            row.payload = {**row.payload, **changes}
            await s.commit()


def item_of(review: dict, key: str) -> dict:
    return next(i for i in review["items"] if i["key"] == key)


def name(email_or_person) -> str:
    return display_name(email_or_person)


@pytest.fixture
async def review(client, owner, runtime) -> Review:  # noqa: F811
    tenant_id, auth = owner
    await approved_prd(client, auth)
    await seed_baseline(tenant_id)
    run, _ = await roadmap_items_check(client, auth, runtime, SECOND)
    people = {
        "viewer": await person(tenant_id, "viewer", "vera"),
        "commenter": await person(tenant_id, "commenter", "cora"),
        "commenter2": await person(tenant_id, "commenter", "colin"),
        "approver": await person(tenant_id, "approver", "abe"),
    }
    return Review(client, tenant_id, auth, run, pending(run), people)


async def emails(review: Review) -> dict[str, str]:
    from oracle.auth.models import User

    async with tenant_session(review.tenant_id) as s:
        rows = await s.scalars(select(User))
        by_id = {u.id: u.email for u in rows}
    return {who: by_id[p.user_id] for who, p in review.people.items()}


async def test_every_member_reads_the_draft_with_items_reasons_and_rights(review):
    """protects=one read route serves the file's items with their reasons, the revision and
    each reader's rights; fails_when=a viewer cannot read, or reads rights they lack;
    no_claim=the reasons' wording (D2)."""
    got = await review.get("viewer")
    assert got["checkpoint_id"] == review.cp["id"] and got["run_id"] == review.run["id"]
    assert (got["kind"], got["status"], got["approver_role"]) == (
        "roadmap_items",
        "pending",
        "approver",
    )
    assert got["revision"] == 0 and got["note"] is None and got["attempt"] == 1
    assert got["file"] == {"name": "roadmap_items.yaml", "seq": 1}
    assert [i["key"] for i in got["items"] if i["position"] is not None] == ITEMS
    gift = item_of(got, "gift-cards")
    assert gift["title"] == "Gift cards" and gift["horizon"] == "later"
    assert gift["prd_section"] == "no-such-section"
    assert "unknown_prd_section" in [r["code"] for r in gift["reasons"]]
    assert gift["state"] == "needs_you" and gift["actions"] == []
    assert got["tally"]["blocking_open"] == 1 and got["tally"]["suggested"] == 0
    assert got["tally"]["need_you"] >= 2 and got["tally"]["waiting_on"] == []
    assert (got["can_read"], got["can_suggest"], got["can_stage"], got["can_decide"]) == (
        True,
        False,
        False,
        False,
    )
    mine = await review.get("commenter")
    assert (mine["can_suggest"], mine["can_stage"], mine["can_decide"]) == (True, False, False)
    mine = await review.get("approver")
    assert (mine["can_suggest"], mine["can_stage"], mine["can_decide"]) == (True, True, True)


async def test_a_commenter_suggests_and_an_approver_stages(review):
    """protects=commenters suggest, the approver role stages (C2, c6); fails_when=a
    commenter's action counts as staged or a viewer writes; no_claim=applying actions (D7)."""
    mail = await emails(review)
    got = await review.act("commenter", item_key="mobile-push", kind="edit", field="horizon",
                           value="next", answers=["rank_vs_horizon"])  # fmt: skip
    [action] = item_of(got, "mobile-push")["actions"]
    assert action["state"] == "suggested" and action["value"] == "next"
    assert action["created_by"] == {
        "id": review.id("commenter"),
        "name": name(mail["commenter"]),
        "role": "commenter",
    }
    assert action["answers"] == ["rank_vs_horizon"] and got["revision"] == 1
    assert got["tally"]["suggested"] == 1
    got = await review.act("approver", item_key="gift-cards", kind="drop")
    [action] = item_of(got, "gift-cards")["actions"]
    assert action["state"] == "staged" and action["created_by"]["role"] == "approver"
    assert got["revision"] == 2
    # The suggestion answers nothing; the staged drop handles every reason of its item.
    assert item_of(got, "gift-cards")["state"] == "handled"
    await review.act("viewer", expect=403, item_key="gift-cards", kind="accept")
    assert (await review.get())["revision"] == 2


async def test_the_same_item_kind_and_field_is_one_action(review):
    """protects=staging again replaces (one row per item, kind and field); fails_when=two
    rows, the first value kept, or the revision not bumped once per write;
    no_claim=what the value does."""
    await review.act("approver", item_key="mobile-push", kind="edit", field="horizon", value="now")
    got = await review.act(
        "approver", item_key="mobile-push", kind="edit", field="horizon", value="next"
    )
    assert [a["value"] for a in item_of(got, "mobile-push")["actions"]] == ["next"]
    assert got["revision"] == 2
    # Another field of the same kind is its own action.
    got = await review.act(
        "approver", item_key="mobile-push", kind="edit", field="title", value="Mobile alerts"
    )
    assert len(item_of(got, "mobile-push")["actions"]) == 2 and got["revision"] == 3
    async with tenant_session(review.tenant_id) as s:
        n = await s.scalar(select(func.count()).select_from(CheckpointAction))
    assert n == 2


async def test_only_the_approver_role_stages_a_suggestion(review):
    """protects=a suggestion counts only once an approver stages it; fails_when=a
    commenter stages, or staging loses who suggested it; no_claim=voiding on demotion."""
    got = await review.act("commenter", item_key="mobile-push", kind="accept")
    [action] = item_of(got, "mobile-push")["actions"]
    await review.stage("commenter", action["id"], expect=403)
    got = await review.stage("approver", action["id"])
    [staged] = item_of(got, "mobile-push")["actions"]
    assert staged["state"] == "staged" and staged["created_by"]["id"] == review.id("commenter")
    assert staged["updated_by"]["id"] == review.id("approver") and got["revision"] == 2
    async with tenant_session(review.tenant_id) as s:
        row = await s.get(CheckpointAction, uuid.UUID(action["id"]))
        assert str(row.created_by) == review.id("commenter")
        assert str(row.updated_by) == review.id("approver")


async def test_undo_by_the_author_or_an_approver_only(review):
    """protects=one person's suggestion is not removed by another commenter;
    fails_when=another commenter removes it, or its author or an approver cannot;
    no_claim=history of removed actions (the audit trail has it)."""
    got = await review.act("commenter", item_key="mobile-push", kind="accept")
    [mine] = item_of(got, "mobile-push")["actions"]
    got = await review.act("commenter", item_key="gift-cards", kind="drop")
    [other] = item_of(got, "gift-cards")["actions"]
    await review.remove("commenter2", mine["id"], expect=403)
    got = await review.remove("commenter", mine["id"])
    assert item_of(got, "mobile-push")["actions"] == [] and got["revision"] == 3
    got = await review.remove("approver", other["id"])
    assert item_of(got, "gift-cards")["actions"] == [] and got["revision"] == 4
    await review.remove("approver", other["id"], expect=404)


async def test_the_note_is_shared_and_set_by_the_approver_role(review):
    """protects=one refresh-proof note per checkpoint, readable by all; fails_when=a
    commenter edits it or it is not read back; no_claim=the web's debounce."""
    got = await review.note("approver", "Caps ship on plan thresholds")
    assert got["note"] == "Caps ship on plan thresholds" and got["revision"] == 1
    assert (await review.get("viewer"))["note"] == "Caps ship on plan thresholds"
    await review.note("commenter", "Mine now", expect=403)
    await review.note("approver", "x" * 10_001, expect=422)
    got = await review.note("approver", None)
    assert got["note"] is None and got["revision"] == 2


async def test_a_stale_decision_is_refused_and_changes_nothing(review):
    """protects=nobody decides over changes they have not seen; fails_when=a decide with an
    older revision lands or is audited; no_claim=SwarmCloud delivery."""
    mail = await emails(review)
    await review.note("approver", "Ship it after caps")
    await review.act("commenter", item_key="mobile-push", kind="accept")
    await review.act("commenter2", item_key="gift-cards", kind="drop")
    resp = await review.client.post(
        f"{review.base}/decide",
        json={"decision": "approved", "expected_revision": 1},
        headers=review.h("approver"),
    )
    assert resp.status_code == 409, resp.text
    detail = resp.json()["detail"]
    assert detail["code"] == "review_changed" and detail["revision"] == 3
    assert detail["changes"] == 2
    assert detail["by"] == [name(mail["commenter"]), name(mail["commenter2"])]
    assert detail["message"] == (
        f"The review changed since you loaded it (2 changes by {name(mail['commenter'])} and "
        f"{name(mail['commenter2'])}): look again, then decide."
    )
    async with tenant_session(review.tenant_id) as s:
        row = await s.get(Checkpoint, uuid.UUID(review.cp["id"]))
        assert row.status == "pending" and row.decided_by is None
        approved = await s.scalar(
            select(func.count())
            .select_from(AuditEvent)
            .where(AuditEvent.action == "checkpoint.approved")
        )
    assert approved == 0
    # With the revision the decider saw: decided as today, the note from the draft.
    run = await review.decide("approver", decision="approved", expected_revision=3)
    cp = next(c for c in run["checkpoints"] if c["id"] == review.cp["id"])
    assert cp["status"] == "approved" and cp["note"] == "Ship it after caps"


async def test_a_console_confirm_goes_through_the_same_revision_check(review):
    """protects=a held console approval is confirmed against the draft the approver saw
    (D3 Console gate); fails_when=a confirm after a change lands; no_claim=the console's
    own record in SwarmCloud."""
    console = {
        "answered_by": "lead@example.com",
        "verdict": "MERGE",
        "counted": False,
        "needs": "confirm",
        "reason": "Blocking problems are open",
        "role": "approver",
    }
    await review.set_payload(wait={"console": console})
    await review.act("commenter", item_key="mobile-push", kind="accept")
    resp = await review.client.post(
        f"{review.base}/decide",
        json={"decision": "confirm", "expected_revision": 0},
        headers=review.h("approver"),
    )
    assert resp.status_code == 409 and resp.json()["detail"]["code"] == "review_changed"
    async with tenant_session(review.tenant_id) as s:
        row = await s.get(Checkpoint, uuid.UUID(review.cp["id"]))
        assert row.status == "pending" and row.payload["wait"]["console"] == console
    run = await review.decide("approver", decision="confirm", expected_revision=1)
    cp = next(c for c in run["checkpoints"] if c["id"] == review.cp["id"])
    assert cp["status"] == "approved"


async def test_after_the_decision_the_draft_is_frozen_and_kept(review):
    """protects=decided checkpoints keep their actions as history and take no writes;
    fails_when=a write lands after the decision or the actions vanish; no_claim=what the
    agents do with them."""
    got = await review.act("commenter", item_key="mobile-push", kind="accept")
    [action] = item_of(got, "mobile-push")["actions"]
    await review.decide("approver", decision="approved", expected_revision=1)
    for call in (
        review.act("approver", expect=409, item_key="gift-cards", kind="drop"),
        review.stage("approver", action["id"], expect=409),
        review.remove("approver", action["id"], expect=409),
        review.note("approver", "Too late", expect=409),
    ):
        out = await call
        assert out["detail"] == "this checkpoint is decided"
    got = await review.get("viewer")
    assert got["status"] == "approved" and got["revision"] == 1
    assert [a["id"] for a in item_of(got, "mobile-push")["actions"]] == [action["id"]]
    assert (got["can_suggest"], got["can_stage"], got["can_decide"]) == (False, False, False)


async def test_time_left_comes_from_the_wait(review):
    """protects=the approver sees how long the SwarmCloud wait has left; fails_when=an
    open wait reads ended, an ended one open, or no wait reads open; no_claim=the
    tick's own expiry handling."""
    await review.set_payload(wait={})
    assert (await review.get())["wait"] == {"state": "none", "ends_at": None, "seconds_left": None}
    ends = datetime.now(UTC) + timedelta(hours=19, minutes=1)
    await review.set_payload(wait={"workflow_id": "wf-1", "expires_at": ends.isoformat()})
    wait = (await review.get())["wait"]
    assert wait["state"] == "open" and 19 * 3600 - 5 <= wait["seconds_left"] <= 19 * 3600 + 60
    assert datetime.fromisoformat(wait["ends_at"]) == ends
    await review.set_payload(
        wait={"workflow_id": "wf-1", "expires_at": ends.isoformat(), "ended": "expired"}
    )
    wait = (await review.get())["wait"]
    assert wait["state"] == "ended" and wait["seconds_left"] is None


async def test_invalid_values_are_422_naming_the_rule(review):
    """protects=the routes store only the vocabulary, checked against the file and the PRD;
    fails_when=an unknown kind, field, item or section is stored; no_claim=D3 waiver rules."""
    cases = [
        ({"item_key": "mobile-push", "kind": "bless"}, "unknown action kind bless"),
        ({"item_key": "mobile-push", "kind": "edit", "field": "colour", "value": "red"},
         "edit cannot change colour"),
        ({"item_key": "mobile-push", "kind": "edit", "field": "depends_on",
          "value": {"add": ["x"]}}, "depends_on names unknown item x"),
        ({"item_key": "mobile-push", "kind": "edit", "field": "prd_section", "value": "s-9"},
         "s-9 is not in the PRD version"),
        ({"item_key": "mobile-push", "kind": "waive", "value": {}}, "waive needs a reason"),
        ({"item_key": "nope", "kind": "accept"}, "nope is not an item"),
    ]  # fmt: skip
    for action, rule in cases:
        out = await review.act("approver", expect=422, **action)
        assert rule in out["detail"], out
    assert (await review.get())["revision"] == 0


async def test_unknown_run_checkpoint_or_action_is_404(review):
    """protects=reads and writes name what does not exist; fails_when=a 500 or another
    run's checkpoint is served; no_claim=other companies (tenancy tests)."""
    other = f"/v1/runs/{uuid.uuid4()}/checkpoints/{review.cp['id']}/review"
    assert (await review.client.get(other, headers=review.h("viewer"))).status_code == 404
    missing = f"/v1/runs/{review.run['id']}/checkpoints/{uuid.uuid4()}/review"
    assert (await review.client.get(missing, headers=review.h("viewer"))).status_code == 404
    await review.stage("approver", str(uuid.uuid4()), expect=404)
    await review.remove("approver", str(uuid.uuid4()), expect=404)


async def test_every_write_is_audited(review):
    """protects=who changed the draft is on the audit trail; fails_when=a write is not
    recorded with its run, kind, item and action; no_claim=the audit screen."""
    got = await review.act("commenter", item_key="mobile-push", kind="accept")
    [action] = item_of(got, "mobile-push")["actions"]
    await review.stage("approver", action["id"])
    await review.act("approver", item_key="gift-cards", kind="drop")
    await review.remove("approver", action["id"])
    await review.note("approver", "Fine")
    async with tenant_session(review.tenant_id) as s:
        rows = (
            await s.scalars(
                select(AuditEvent)
                .where(AuditEvent.action.like("checkpoint.%"))
                .order_by(AuditEvent.created_at)
            )
        ).all()
    got = [(e.action, e.data.get("item_key")) for e in rows]
    assert got == [
        ("checkpoint.action_suggested", "mobile-push"),
        ("checkpoint.action_staged", "mobile-push"),
        ("checkpoint.action_staged", "gift-cards"),
        ("checkpoint.action_removed", "mobile-push"),
        ("checkpoint.note_set", None),
    ]
    for e in rows:
        assert e.entity_id == uuid.UUID(review.cp["id"])
        assert e.data["run_id"] == review.run["id"] and e.data["kind"] == "roadmap_items"
        assert "action" in e.data


async def test_a_question_action_asks_the_person_and_shows_the_answer(review):
    """protects=asking a teammate about one item goes through C2 and its answer reaches the
    item; fails_when=no question is made, it lacks its subject, or the answer does not show
    and the person stays in waiting_on; no_claim=Inbox rendering."""
    mail = await emails(review)
    got = await review.act(
        "commenter",
        item_key="mobile-push",
        kind="question",
        value={"asked_to": review.id("approver"), "text": "Is push in this release?"},
    )
    [action] = item_of(got, "mobile-push")["actions"]
    q = action["question"]
    assert q["status"] == "asked" and q["answer"] is None
    assert q["asked_to"] == {"id": review.id("approver"), "name": name(mail["approver"])}
    assert got["tally"]["waiting_on"] == [
        {"user_id": review.id("approver"), "name": name(mail["approver"]), "count": 1}
    ]
    async with tenant_session(review.tenant_id) as s:
        row = await s.get(StakeholderQuestion, uuid.UUID(q["id"]))
        assert (row.category, row.status, row.prompt) == (
            "general",
            "asked",
            "Is push in this release?",
        )
        assert str(row.asked_to) == review.id("approver")
        assert str(row.asked_by) == review.id("commenter")
        assert str(row.checkpoint_id) == review.cp["id"] and row.item_ref == "mobile-push"
        assert row.document_id is not None and row.section_key == "s-5-2"
        stored = await s.get(CheckpointAction, uuid.UUID(action["id"]))
        assert stored.question_id == row.id
    resp = await review.client.get("/v1/inbox/questions", headers=review.h("approver"))
    assert q["id"] in [r["question"]["id"] for r in resp.json()]

    resp = await review.client.post(
        f"/v1/questions/{q['id']}/answers",
        json={"kind": "answer", "body": "Yes, behind a flag"},
        headers=review.h("approver"),
    )
    assert resp.status_code == 201, resp.text
    got = await review.get("commenter")
    [action] = item_of(got, "mobile-push")["actions"]
    assert action["question"]["status"] == "answered"
    assert action["question"]["answer"] == {
        "kind": "answer",
        "body": "Yes, behind a flag",
        "answered_by": {"id": review.id("approver"), "name": name(mail["approver"])},
    }
    assert got["tally"]["waiting_on"] == []


async def test_undoing_a_question_withdraws_it_unless_answered(review):
    """protects=a withdrawn question leaves the person's Inbox, an answered one stays;
    fails_when=undo leaves it asked or withdraws an answer; no_claim=reassigning."""
    ask = {"asked_to": review.id("approver"), "text": "Is push in this release?"}
    got = await review.act("commenter", item_key="mobile-push", kind="question", value=ask)
    [first] = item_of(got, "mobile-push")["actions"]
    got = await review.remove("commenter", first["id"])
    assert got["tally"]["waiting_on"] == []
    got = await review.act("commenter", item_key="gift-cards", kind="question", value=ask)
    [second] = item_of(got, "gift-cards")["actions"]
    resp = await review.client.post(
        f"/v1/questions/{second['question']['id']}/answers",
        json={"kind": "answer", "body": "Later"},
        headers=review.h("approver"),
    )
    assert resp.status_code == 201, resp.text
    await review.remove("approver", second["id"])
    async with tenant_session(review.tenant_id) as s:
        withdrawn = await s.get(StakeholderQuestion, uuid.UUID(first["question"]["id"]))
        answered = await s.get(StakeholderQuestion, uuid.UUID(second["question"]["id"]))
    assert withdrawn.status == "withdrawn" and answered.status == "answered"
    # A viewer cannot be asked (C2): 422, nothing stored.
    out = await review.act(
        "commenter", expect=422, item_key="mobile-push", kind="question",
        value={"asked_to": review.id("viewer"), "text": "Who?"},
    )  # fmt: skip
    assert out["detail"] == "Ask someone who can answer"


async def test_the_routes_are_mcp_tools_and_run_tokens_get_none():
    """protects=MCP clients use the draft with the caller's role, run agents never write it;
    fails_when=a route is not a tool or a run token scope reaches it; no_claim=MCP
    transport (tests.test_mcp)."""
    from oracle.main import app
    from oracle.mcp import scopes

    spec = app.openapi()
    ops = {
        op["operationId"]: (method.upper(), path)
        for path, item in spec["paths"].items()
        for method, op in item.items()
    }
    names = ["get_checkpoint_draft", "create_checkpoint_action", "stage_checkpoint_action",
             "delete_checkpoint_action", "set_checkpoint_note"]  # fmt: skip
    for op in names:
        method, path = ops[op]
        assert path.startswith("/v1/runs/{run_id}/checkpoints/{checkpoint_id}/")
        assert scopes.required_scope(method, path) is None
    decision = spec["components"]["schemas"]["CheckpointDecision"]["properties"]
    assert "expected_revision" in decision


async def test_a_demoted_approvers_staged_actions_need_an_approver_again(review):
    """protects=what someone staged counts only while they hold the approver role (C2:
    demotion and disable voiding); fails_when=their actions stay staged after a demotion or
    a disable, or someone else's do; no_claim=decisions already made (members tests)."""
    got = await review.act("approver", item_key="mobile-push", kind="accept")
    got = await review.act("commenter", item_key="gift-cards", kind="drop")
    [suggestion] = item_of(got, "gift-cards")["actions"]
    got = await review.stage("approver", suggestion["id"])
    other = await person(review.tenant_id, "approver", "ada")
    resp = await review.client.post(
        f"{review.base}/actions",
        json={"item_key": "payment-step", "kind": "accept"},
        headers=other.headers,
    )
    assert resp.status_code == 200, resp.text
    revision = resp.json()["revision"]
    resp = await review.client.patch(
        f"/v1/members/{review.id('approver')}", json={"role": "commenter"}, headers=review.auth
    )
    assert resp.status_code == 200, resp.text
    got = await review.get()
    states = {k: [a["state"] for a in item_of(got, k)["actions"]] for k in ITEMS}
    assert states == {
        "mobile-push": ["suggested"],
        "gift-cards": ["suggested"],
        "payment-step": ["staged"],
    }
    assert got["revision"] == revision + 2
    # A disable does the same.
    resp = await review.client.post(
        f"/v1/members/{other.user_id}/disable", headers={**review.auth, "Origin": "http://test"}
    )
    assert resp.status_code == 200, resp.text
    got = await review.get()
    assert [a["state"] for a in item_of(got, "payment-step")["actions"]] == ["suggested"]
