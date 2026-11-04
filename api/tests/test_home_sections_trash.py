"""Simple Home's "Decisions waiting for you" and "Since your last visit" after Trash: every
read behind them (GET /v1/inbox, /v1/simple/decisions/waiting, /v1/decisions/{number} for
each Inbox decision that needs one, /v1/simple/changes and /v1/inbox/questions) answers
200 with nothing of a trashed PRD, roadmap or run in it. Against Postgres with the
FakeRuntime; every name, address and product is invented.

The world: an approved PRD (Checkout redesign) with its roadmap, its track, a slipped
date (an open track alert) and its schedule bases; a second roadmap run waiting at a
checkpoint; Simple changes on the roadmap (applied and proposed); decisions waiting for
me (one about the PRD, one about a roadmap item, one about nothing trashed); a second
PRD (Guided setup) whose open questions wait for me as decisions; and teammates'
questions about a roadmap item, a checkpoint item and a PRD section.

Each test's card: protects=what it guards; fails_when=what breaks it; no_claim=what it
does not prove.
"""

import hashlib
import json
import uuid
from datetime import UTC, datetime
from pathlib import Path

import pytest
from sqlalchemy import select

from oracle.auth.service import create_user, make_session_cookie
from oracle.config import get_settings
from oracle.docs.models import Document, DocumentVersion
from oracle.review.models import DocumentReviewPolicy
from oracle.roadmap.models import RoadmapItem
from oracle.swarm import Outcome
from oracle.tenancy import tenant_session
from tests.test_roadmap import (  # noqa: F401 - fixtures
    ITEMS,
    PRD,
    PRD_TITLE,
    ROADMAP,
    create,
    get,
    owner,
    runtime,
    start,
    tick,
)
from tests.test_track_alerts import slipped

QUESTIONS_PRD = "guided-setup"
QUESTIONS_TITLE = "Guided setup"
FIXTURE = (Path(__file__).parent / "fixtures" / "prd_questions_invented.md").read_text()
KEPT_DECISION = "Choose the team offsite city"
PRD_DECISION = "Pick the card partner for checkout"
ITEM_DECISION = "Keep the express lane in Beta"
NEW_TITLE = "Faster card entry"
PROPOSED_OUTCOME = "Fewer abandoned carts"


async def member(tenant_id: uuid.UUID, role: str) -> tuple[uuid.UUID, dict[str, str]]:
    async with tenant_session(tenant_id) as s:
        user = await create_user(s, f"{role}-{uuid.uuid4().hex[:6]}@example.com", "pw")
        user.role = role
        await s.commit()
    cookie = f"{get_settings().session_cookie_name}={make_session_cookie(user)}"
    return user.id, {"Cookie": cookie}


async def questions_prd(tenant_id: uuid.UUID, decider: uuid.UUID) -> uuid.UUID:
    """The invented Guided setup PRD, approved, with its open questions table and me as
    its decider: its questions wait for me."""
    async with tenant_session(tenant_id) as s:
        doc = Document(slug=QUESTIONS_PRD, title=QUESTIONS_TITLE, kind="prd", status="approved",
                       visibility="company")  # fmt: skip
        s.add(doc)
        await s.flush()
        s.add(DocumentVersion(document_id=doc.id, number=1, markdown=FIXTURE,
                              content_hash=hashlib.sha256(FIXTURE.encode()).hexdigest(),
                              approved_at=datetime(2026, 10, 21, tzinfo=UTC)))  # fmt: skip
        s.add(DocumentReviewPolicy(document_id=doc.id, decider_id=decider))
        await s.commit()
        return doc.id


class World:
    """Everything Home's two sections read, with what names each trashed thing."""

    def __init__(self) -> None:
        self.me: dict[str, str] = {}
        self.ids: dict[str, str] = {}
        self.question_titles: list[str] = []

    async def build(self, client, owner_, runtime_) -> "World":
        tenant_id, auth = owner_
        self.tenant_id, self.auth = tenant_id, auth
        me_id, self.me = await member(tenant_id, "owner")
        self.me_id = me_id
        _, approver = await member(tenant_id, "approver")
        _, commenter = await member(tenant_id, "commenter")

        track, slip = await slipped(client, auth, runtime_)
        self.ids["track"], self.ids["alert"] = track["id"], slip["id"]
        # A second roadmap run, waiting at its first checkpoint.
        runtime_.script["roadmap_items"] = [Outcome(artifacts={"roadmap_items.yaml": ITEMS})]
        run = await start(client, auth, await create(client, auth, source=PRD))
        await tick(client, auth)
        run = await get(client, auth, run["id"])
        (cp,) = [c for c in run["checkpoints"] if c["status"] == "pending"]
        self.ids["run"], self.ids["checkpoint"] = run["id"], cp["id"]

        async with tenant_session(tenant_id) as s:
            docs = {d.slug: d for d in await s.scalars(select(Document))}
            self.ids["prd"], self.ids["roadmap"] = str(docs[PRD].id), str(docs[ROADMAP].id)
            items = list(
                await s.scalars(
                    select(RoadmapItem)
                    .where(RoadmapItem.roadmap_document_id == docs[ROADMAP].id)
                    .order_by(RoadmapItem.position)
                )
            )
        first, second = items[0], items[1]
        self.ids["item"] = str(first.id)
        self.item_title = first.title

        # Simple changes on the roadmap: one applied (an owner), one proposed (an approver).
        applied = await client.post(
            "/v1/simple/changes",
            json={"op": "edit_title", "target": {"item_id": str(first.id)},
                  "before": {"title": first.title}, "after": {"title": NEW_TITLE}},
            headers=self.me,
        )  # fmt: skip
        assert applied.status_code == 201, applied.text
        assert applied.json()["change"]["status"] == "applied"
        proposed = await client.post(
            "/v1/simple/changes",
            json={"op": "edit_outcome", "target": {"item_id": str(second.id)},
                  "before": {"outcome": second.outcome}, "after": {"outcome": PROPOSED_OUTCOME}},
            headers=approver,
        )  # fmt: skip
        assert proposed.status_code == 201, proposed.text
        assert proposed.json()["change"]["status"] == "proposed"
        self.ids["applied change"] = applied.json()["change"]["id"]
        self.ids["proposed change"] = proposed.json()["change"]["id"]

        # Decisions waiting for me.
        options = [{"key": "a", "label": "Option A"}, {"key": "b", "label": "Option B"}]
        for title, subjects in (
            (PRD_DECISION, [{"kind": "document", "id": self.ids["prd"]}]),
            (ITEM_DECISION, [{"kind": "roadmap_item", "id": self.ids["item"]}]),
            (KEPT_DECISION, []),
        ):
            resp = await client.post(
                "/v1/decisions",
                json={"title": title, "approver_id": str(me_id), "options": options,
                      "subjects": subjects},
                headers=self.me,
            )  # fmt: skip
            assert resp.status_code == 201, resp.text

        # A PRD whose open questions wait for me.
        self.ids["questions prd"] = str(await questions_prd(tenant_id, me_id))
        waiting = await client.get("/v1/simple/decisions/waiting", headers=self.me)
        assert waiting.status_code == 200, waiting.text
        self.question_titles = [q["title"] for q in waiting.json()["questions"]]
        assert self.question_titles, waiting.text

        # Teammates' questions for me: a roadmap item, a checkpoint item, a PRD section.
        for subject in (
            {"kind": "roadmap_item", "document_id": self.ids["prd"], "item_key": "payment-step"},
            {"kind": "checkpoint_item", "checkpoint_id": cp["id"], "item_ref": "payment-step"},
            {"kind": "document_section", "document_id": self.ids["prd"],
             "section_key": "problem"},
        ):  # fmt: skip
            resp = await client.post(
                "/v1/questions",
                json={"prompt": f"Can we settle the {subject['kind']} by Friday?",
                      "asked_to": str(me_id), "subject": subject},
                headers=commenter,
            )  # fmt: skip
            assert resp.status_code == 201, (subject, resp.text)
        return self


async def home(client, headers) -> dict[str, str]:
    """Each read behind Home's two sections, as JSON text; every one must answer 200."""
    out = {}
    for name, path in (
        ("inbox", "/v1/inbox"),
        ("waiting", "/v1/simple/decisions/waiting"),
        ("changes", "/v1/simple/changes"),
        ("questions", "/v1/inbox/questions"),
    ):
        resp = await client.get(path, headers=headers)
        assert resp.status_code == 200, (path, resp.status_code, resp.text[:2000])
        out[name] = resp.text
    inbox = (await client.get("/v1/inbox", headers=headers)).json()
    for d in inbox["decisions"]:
        if d["reason"] != "needs_decision":
            continue
        resp = await client.get(f"/v1/decisions/{d['number']}", headers=headers)
        assert resp.status_code == 200, (d["number"], resp.status_code, resp.text[:2000])
        out[f"decision {d['number']}"] = resp.text
    return out


def leaks(reads: dict[str, str], gone: list[str], subjects: tuple[str, ...] = ()) -> list:
    """(read, where a trashed name shows in it) for each name still in a read. A decision
    of mine keeps the bare ids of its ``subjects`` (it is not in Trash; it names them by id
    only, never by title)."""
    return [(name, text[max(0, (i := text.index(g)) - 120) : i + 60])
            for name, text in reads.items() for g in gone if g in text
            and not (name.startswith("decision ") and g in subjects)]  # fmt: skip


async def cancelled(client, w: World) -> None:
    """A document with a run still working on it does not go to Trash: cancel it first,
    as the Trash dialog asks."""
    resp = await client.post(f"/v1/runs/{w.ids['run']}/cancel", headers=w.auth)
    assert resp.status_code == 200, resp.text


async def trash(client, headers, slug: str) -> None:
    resp = await client.request("DELETE", f"/v1/documents/{slug}", headers=headers)
    assert resp.status_code == 200, (slug, resp.text)


async def test_home_sections_answer_after_every_prd_and_roadmap_is_trashed(
    client,
    owner,  # noqa: F811
    runtime,  # noqa: F811
):
    """protects=Home after Trash (every PRD and roadmap); fails_when=any read behind
    "Decisions waiting for you" or "Since your last visit" answers 500, or still names a
    trashed PRD, roadmap, run, checkpoint, roadmap item, Simple change, track alert or a
    trashed PRD's open question; no_claim=the web's rendering, decisions about nothing
    trashed (they stay)."""
    w = await World().build(client, owner, runtime)
    before = await home(client, w.me)
    assert w.ids["alert"] in before["inbox"]
    assert w.ids["proposed change"] in before["changes"]
    assert w.question_titles[0] in before["inbox"]
    assert "payment-step" in before["questions"]

    await cancelled(client, w)
    documents = await client.get("/v1/documents", headers=w.auth)
    assert documents.status_code == 200, documents.text
    for kind in ("prd", "roadmap"):
        for slug in [d["slug"] for d in documents.json() if d["kind"] == kind]:
            listed = await client.get(f"/v1/documents/{slug}", headers=w.auth)
            if listed.status_code == 200:  # not gone along with its PRD
                await trash(client, w.auth, slug)
    left = await client.get("/v1/documents", headers=w.auth)
    assert [d for d in left.json() if d["kind"] in ("prd", "roadmap")] == []

    after = await home(client, w.me)
    gone = [PRD, ROADMAP, QUESTIONS_PRD, PRD_TITLE, QUESTIONS_TITLE, NEW_TITLE, PROPOSED_OUTCOME,
            *w.ids.values(), *w.question_titles]  # fmt: skip
    assert leaks(after, gone, (w.ids["prd"], w.ids["item"])) == []
    # A decision about nothing trashed still waits, and a new one takes a fresh number
    # (the trashed PRD's questions keep theirs).
    assert KEPT_DECISION in after["inbox"]
    resp = await client.post(
        "/v1/decisions",
        json={"title": "Name the launch week", "approver_id": str(w.me_id)},
        headers=w.me,
    )
    assert resp.status_code == 201, resp.text


async def test_home_sections_keep_what_is_not_trashed(
    client,
    owner,  # noqa: F811
    runtime,  # noqa: F811
):
    """protects=Home after Trash (some documents); fails_when=trashing the Guided setup PRD
    breaks a read, leaves its questions waiting, or takes the Checkout PRD's alert, changes,
    run or teammates' questions with it; no_claim=restore (tests/test_trash.py)."""
    w = await World().build(client, owner, runtime)
    await trash(client, w.auth, QUESTIONS_PRD)
    after = await home(client, w.me)
    assert leaks(after, [QUESTIONS_PRD, w.ids["questions prd"], *w.question_titles]) == []
    assert w.ids["alert"] in after["inbox"]
    assert w.ids["proposed change"] in after["changes"]
    assert w.ids["applied change"] in after["changes"]
    assert "payment-step" in after["questions"]
    assert w.ids["checkpoint"] in after["questions"]
    assert KEPT_DECISION in after["inbox"] and PRD_DECISION in after["inbox"]


async def test_home_sections_answer_after_a_run_is_trashed(
    client,
    owner,  # noqa: F811
    runtime,  # noqa: F811
):
    """protects=Home after Trash (one run); fails_when=a run moved to Trash on its own
    makes a read a 500, or its checkpoint (or a teammate's question about it) is still
    listed; no_claim=the run's documents (they stay)."""
    w = await World().build(client, owner, runtime)
    await cancelled(client, w)
    resp = await client.request("DELETE", f"/v1/runs/{w.ids['run']}", headers=w.auth)
    assert resp.status_code == 200, resp.text
    after = await home(client, w.me)
    assert leaks(after, [w.ids["run"], w.ids["checkpoint"]]) == []
    assert w.ids["alert"] in after["inbox"]


@pytest.mark.parametrize("slug", [PRD, ROADMAP])
async def test_home_sections_answer_after_one_document_is_trashed(
    client,
    slug,
    owner,  # noqa: F811
    runtime,  # noqa: F811
):
    """protects=Home after Trash (the Checkout PRD, or its roadmap alone);
    fails_when=a read answers 500, or the roadmap's items, changes or alert are still
    listed; no_claim=the Guided setup PRD's rows (they stay)."""
    w = await World().build(client, owner, runtime)
    await cancelled(client, w)
    await trash(client, w.auth, slug)
    after = await home(client, w.me)
    gone = [ROADMAP, NEW_TITLE, PROPOSED_OUTCOME, w.ids["roadmap"], w.ids["applied change"],
            w.ids["proposed change"]]  # fmt: skip
    if slug == PRD:
        gone += [PRD_TITLE, w.ids["prd"], w.ids["run"], w.ids["checkpoint"], w.ids["alert"]]
    assert leaks(after, gone, (w.ids["prd"], w.ids["item"])) == []
    # The track is its PRD's: with the roadmap alone gone, its alert is closed, not open.
    tracks = json.loads(after["inbox"])["tracks"]
    assert w.ids["alert"] not in {a["id"] for t in tracks for a in t["alerts"]}
    assert w.question_titles[0] in after["waiting"]
