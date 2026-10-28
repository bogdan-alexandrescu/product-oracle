"""C3 Interviews, lane 1: customer interviews through a private one-time link.

Members create an interview, Oracle drafts its guide (queued ``interview_guide``), a
member approves it and creates the link; the customer answers on ``/i/<token>`` (public
routes, no member credential) and Oracle's snapshot turns their needs into New,
unverified, interview-channel requests.

Each test's card is one line: protects / fails_when / no_claim. Synthetic placeholders
only. The interview cookie is ``Secure``; the test client talks plain http, so it never
sends it on its own: a test passes it as a header where a browser would.
"""

import asyncio
import time
import uuid
from datetime import UTC, datetime, timedelta

import pytest
from sqlalchemy import select, update

from oracle.baseline.models import Entity
from oracle.interviews import public, turns
from oracle.interviews.models import Interview, InterviewMessage
from oracle.jobs import worker
from oracle.jobs.models import LlmJob
from oracle.llm import gateway
from oracle.models import AuditEvent
from oracle.requests.models import ProductRequest
from oracle.tenancy import tenant_session
from oracle.v2.models import KnowledgeGap, ProductIntake, StakeholderAnswer
from tests.baseline_helpers import Ctx, make_ctx
from tests.claude_account_helpers import add_account, window
from tests.test_llm_jobs import FakeClaude

GUIDE = {
    "intro": "Thanks for making time; we want to learn how you reorder supplies.",
    "questions": [
        {"prompt": "Tell me about the last time you reordered supplies.", "purpose": "Flow"},
        {"prompt": "What did you do when an order arrived late?", "purpose": "Pain"},
        {"prompt": "Tell me about a time you compared suppliers.", "purpose": "Alternatives"},
    ],
}
LONG = "Last Tuesday I reordered gloves for the clinic and had to retype the address twice."


@pytest.fixture
async def ctx() -> Ctx:
    return await make_ctx()


@pytest.fixture
async def fake(ctx):
    claude = FakeClaude()
    previous = gateway.set_transports(gateway.Transports(plan=claude, api_key=claude))
    await add_account(ctx.tenant_id, "personal", windows={"five_hour": window(0.2)})
    yield claude
    gateway.set_transports(previous)


@pytest.fixture
def no_wait(monkeypatch):
    monkeypatch.setattr(public, "MIN_INTERVAL_SECONDS", 0.0)


async def create(client, ctx: Ctx, who: str = "commenter", expect: int = 201, **body) -> dict:
    body.setdefault("kind", "customer")
    body.setdefault("interviewee_name", "Ana Lima")
    body.setdefault("interviewee_company", "Northwind Clinics")
    body.setdefault("subject", {"topic": "How clinics reorder supplies"})
    resp = await client.post("/v1/interviews", json=body, headers=ctx.as_(who))
    assert resp.status_code == expect, resp.text
    return resp.json()


async def get(client, ctx: Ctx, iid: str, who: str = "viewer") -> dict:
    resp = await client.get(f"/v1/interviews/{iid}", headers=ctx.as_(who))
    assert resp.status_code == 200, resp.text
    return resp.json()


async def run_guide(ctx: Ctx, fake: FakeClaude, guide: dict | None = None) -> None:
    fake.script["interview_guide"].append(guide or GUIDE)
    await worker.run_pending(ctx.tenant_id)


async def invited(client, ctx: Ctx, fake: FakeClaude, **body) -> tuple[dict, str]:
    """A customer interview with the approved guide and its link: (interview, token)."""
    iv = await create(client, ctx, **body)
    await run_guide(ctx, fake)
    resp = await client.post(f"/v1/interviews/{iv['id']}/link", headers=ctx.as_("commenter"))
    assert resp.status_code == 201, resp.text
    return iv, resp.json()["url"].rsplit("/i/", 1)[1]


async def open_link(client, token: str) -> tuple[dict, dict[str, str]]:
    """First open: the page and the cookie header a browser would send from then on."""
    client.cookies.clear()
    resp = await client.get(f"/v1/public/interviews/{token}")
    assert resp.status_code == 200, resp.text
    raw = resp.headers["set-cookie"]
    name_value = raw.split(";", 1)[0]
    return resp.json(), {"cookie": name_value}


def ask(fake: FakeClaude, ack: str = "Thanks, that helps.", follow_up: str | None = None):
    fake.script["interview_turn"].append({"ack": ack, "follow_up": follow_up})


async def say(client, token: str, cookie: dict, body: str, expect: int = 200) -> dict:
    resp = await client.post(
        f"/v1/public/interviews/{token}/messages", json={"body": body}, headers=cookie
    )
    assert resp.status_code == expect, resp.text
    return resp.json()


# --- unit -----------------------------------------------------------------------------


def test_token_is_256_bits_url_safe_and_only_its_hash_is_kept():
    """protects=token guessing is hopeless and a database read reveals no live link;
    fails_when=the token is short, not URL-safe or stored raw; no_claim=the load
    balancer's path rule."""
    raw, digest = public.new_token()
    assert len(raw) >= 43 and all(c.isalnum() or c in "-_" for c in raw)
    assert digest == public.hash_value(raw) and raw not in digest and len(digest) == 64


def test_output_checks_refuse_links_markup_and_long_text():
    """protects=rule 5: only plain, short text reaches the customer; fails_when=a link,
    markup or an over-long ack or follow-up passes; no_claim=what the model would say."""
    assert turns.checked("Thanks, that helps.", 120) == "Thanks, that helps."
    for bad in (
        "See https://example.com for more",
        "Visit www.example.com",
        "Look at example.com/offer",
        "<b>Thanks</b>",
        "[click](here)",
        "x" * 121,
        "",
    ):
        assert turns.checked(bad, 120) is None, bad


def test_quotes_must_be_exact_substrings_of_the_customers_messages():
    """protects=rule 6: a snapshot quote is the customer's own words; fails_when=a
    paraphrase or invented quote is kept; no_claim=snapshot quality."""
    said = [LONG, "We switched suppliers in May."]
    assert turns.is_quote("retype the address twice", said)
    assert turns.is_quote("We switched suppliers in May.", said)
    assert not turns.is_quote("retyped the address", said)
    assert not turns.is_quote("twice. We switched", said)
    assert not turns.is_quote("", said)


# --- members' routes -------------------------------------------------------------------


async def test_a_commenter_creates_a_draft_and_queues_the_guide(client, ctx):
    """protects=criterion 1: Create makes a Draft customer interview with a queued
    interview_guide job, a viewer cannot; fails_when=no job, wrong status or a viewer
    creates one; no_claim=the guide's quality."""
    await create(client, ctx, who="viewer", expect=403)
    iv = await create(client, ctx)
    assert iv["status"] == "draft" and iv["kind"] == "customer"
    assert iv["interviewee_name"] == "Ana Lima" and iv["topic"] == "How clinics reorder supplies"
    assert iv["guide_job"]["status"] == "queued" and iv["guide"] == []
    async with tenant_session(ctx.tenant_id) as s:
        job = await s.get(LlmJob, uuid.UUID(iv["guide_job"]["id"]))
        assert job.kind == "interview_guide" and str(job.interview_id) == iv["id"]
    listed = await client.get("/v1/interviews?status=draft", headers=ctx.as_("viewer"))
    assert [i["id"] for i in listed.json()] == [iv["id"]]
    two = await create(
        client, ctx, expect=422, subject={"topic": "a", "theme_id": str(uuid.uuid4())}
    )
    assert "subject" in str(two)
    await create(client, ctx, expect=422, interviewee_name="x" * 121)


async def test_guide_job_reads_only_the_shared_intake_and_writes_the_guide(client, ctx, fake):
    """protects=criterion 2 (decision S6): the guide job sees the intake's title, brief and
    open shared gaps of the customer categories, nothing else; fails_when=a private
    finding, another category's gap, a source text or a goal reaches the model, or the
    guide is not written; no_claim=what the real model drafts."""
    async with tenant_session(ctx.tenant_id) as s:
        s.add(
            Entity(
                type="goal",
                key="g-secret",
                title="Secret goal Z9",
                status="confirmed",
                origin="user",
            )
        )
        private_id = uuid.uuid4()
        intake = ProductIntake(
            title="Saved addresses",
            brief="Returning buyers retype their address.",
            author_id=ctx.users["commenter"].id,
            analysis={
                "findings": {
                    str(private_id): {
                        "kind": "gap", "origin": "model", "category": "pain_evidence",
                        "source_item_ids": [], "summary": "From the author's sources",
                        "sharing": "private", "gap_id": str(private_id),
                    }
                }
            },
        )  # fmt: skip
        s.add(intake)
        await s.flush()
        gap = dict(intake_id=intake.id, impact=[], importance="high", knowledge_state="unknown")
        s.add_all(
            [
                KnowledgeGap(id=private_id, category="pain_evidence", status="unknown",
                             statement="Private finding P7 from a call", **gap),
                KnowledgeGap(category="customer_user", status="unknown", rule_key="customer_user",
                             statement="Who is the primary buyer?", **gap),
                KnowledgeGap(category="security_privacy", status="unknown",
                             rule_key="security_privacy", statement="Security gap S3", **gap),
                KnowledgeGap(category="alternatives", status="answered", rule_key="alternatives",
                             statement="Answered gap A1", **gap),
            ]
        )  # fmt: skip
        await s.commit()
        intake_id = str(intake.id)
    iv = await create(client, ctx, subject={"intake_id": intake_id})
    assert iv["intake_id"] == intake_id and iv["title"] == "Saved addresses"
    await run_guide(ctx, fake)

    kind, payload = fake.calls[0]
    assert kind == "interview_guide"
    text = str(payload)
    assert "Saved addresses" in text and "Returning buyers retype their address." in text
    assert "Who is the primary buyer?" in text
    for leaked in ("Private finding P7", "Security gap S3", "Answered gap A1", "Secret goal Z9"):
        assert leaked not in text
    got = await get(client, ctx, iv["id"])
    assert got["guide_job"]["status"] == "succeeded"
    assert got["intro"] == GUIDE["intro"]
    assert [q["prompt"] for q in got["guide"]] == [q["prompt"] for q in GUIDE["questions"]]
    assert all(q["id"] for q in got["guide"])


async def test_only_the_creator_or_an_approver_edits_a_draft_guide(client, ctx, fake):
    """protects=step 3: the creator or an approver edits, reorders and caps the guide
    while Draft; fails_when=another commenter edits, a 9th or over-long question is kept,
    or an invited guide changes; no_claim=the dialog's UI."""
    async with tenant_session(ctx.tenant_id) as s:
        from oracle.auth.models import User

        s.add(User(email="other@example.com", password_hash="x", role="commenter"))
        await s.commit()
    iv = await create(client, ctx)
    await run_guide(ctx, fake)
    got = await get(client, ctx, iv["id"])
    first, second = got["guide"][0], got["guide"][1]
    edit = {
        "lock_version": got["lock_version"],
        "intro": "Short intro",
        "guide": [
            {"id": second["id"], "prompt": "Tell me about the last late order."},
            {"id": first["id"], "prompt": first["prompt"], "purpose": first["purpose"]},
            {"prompt": "Tell me about your last stock count."},
        ],
    }
    resp = await client.patch(f"/v1/interviews/{iv['id']}", json=edit, headers=ctx.as_("viewer"))
    assert resp.status_code == 403
    resp = await client.patch(f"/v1/interviews/{iv['id']}", json=edit, headers=ctx.as_("approver"))
    assert resp.status_code == 200, resp.text
    out = resp.json()
    assert [q["prompt"] for q in out["guide"]][0] == "Tell me about the last late order."
    assert out["guide"][0]["id"] == second["id"] and out["guide"][2]["id"]
    too_many = {"lock_version": out["lock_version"], "guide": [{"prompt": "Q?"}] * 9}
    resp = await client.patch(
        f"/v1/interviews/{iv['id']}", json=too_many, headers=ctx.as_("commenter")
    )
    assert resp.status_code == 422
    stale = await client.patch(
        f"/v1/interviews/{iv['id']}", json=edit, headers=ctx.as_("commenter")
    )
    assert stale.status_code == 409
    await client.post(f"/v1/interviews/{iv['id']}/link", headers=ctx.as_("commenter"))
    late = {"lock_version": (await get(client, ctx, iv["id"]))["lock_version"], "intro": "x"}
    resp = await client.patch(f"/v1/interviews/{iv['id']}", json=late, headers=ctx.as_("approver"))
    assert resp.status_code == 409


async def test_the_link_is_shown_once_and_only_its_hash_is_stored(client, ctx, fake):
    """protects=criterion 3: the URL is returned once, the row holds only the token's
    sha256, a second call is refused; fails_when=the raw token is stored or a second link
    is minted while one exists; no_claim=the host name in the URL."""
    iv = await create(client, ctx)
    early = await client.post(f"/v1/interviews/{iv['id']}/link", headers=ctx.as_("commenter"))
    assert early.status_code == 409  # no approved guide yet
    await run_guide(ctx, fake)
    resp = await client.post(f"/v1/interviews/{iv['id']}/link", headers=ctx.as_("commenter"))
    assert resp.status_code == 201, resp.text
    link = resp.json()
    token = link["url"].rsplit("/i/", 1)[1]
    expires = datetime.fromisoformat(link["expires_at"])
    assert timedelta(days=6, hours=23) < expires - datetime.now(UTC) <= timedelta(days=7)
    async with tenant_session(ctx.tenant_id) as s:
        row = await s.get(Interview, uuid.UUID(iv["id"]))
        assert row.link_token_hash == public.hash_value(token)
        assert token not in str({c.name: getattr(row, c.name) for c in row.__table__.columns})
    again = await client.post(f"/v1/interviews/{iv['id']}/link", headers=ctx.as_("approver"))
    assert again.status_code == 409 and again.json()["detail"] == "A link exists; withdraw it first"
    got = await get(client, ctx, iv["id"])
    assert got["status"] == "invited" and token not in str(got)


# --- public routes ---------------------------------------------------------------------


async def test_link_single_use(client, ctx, fake, no_wait):
    """protects=decision V2e single use and 7-day expiry (criterion 4); fails_when=a second
    browser continues, an expired or withdrawn link works, or an unknown token answers
    differently from an expired one; no_claim=the load-balancer path rule (ops check)."""
    iv, token = await invited(client, ctx, fake)
    page, cookie = await open_link(client, token)
    assert page["company"] == "Example Co" and page["interviewee_name"] == "Ana Lima"
    assert page["intro"] == GUIDE["intro"] and page["status"] == "in_progress"
    assert page["messages"] == [
        {"role": "oracle", "body": GUIDE["questions"][0]["prompt"], "at": page["messages"][0]["at"]}
    ]
    assert page["progress"] == {"asked": 1, "total": 3}
    async with tenant_session(ctx.tenant_id) as s:
        row = await s.get(Interview, uuid.UUID(iv["id"]))
        assert row.link_opened_at is not None and row.session_hash
        events = list(await s.scalars(select(AuditEvent).where(AuditEvent.entity == "interview")))
        assert events and all(token not in str(e.data) for e in events)
    raw = (await client.get(f"/v1/public/interviews/{token}")).headers
    assert "set-cookie" not in raw

    for path, method in (("", "get"), ("/messages", "post"), ("/skip", "post")):
        client.cookies.clear()
        kwargs = {"json": {"body": "hi"}} if path == "/messages" else {}
        resp = await getattr(client, method)(f"/v1/public/interviews/{token}{path}", **kwargs)
        assert resp.status_code == 410 and resp.json() == {"reason": "used"}, path
    again = await client.get(f"/v1/public/interviews/{token}", headers=cookie)
    assert again.status_code == 200 and again.json()["messages"] == page["messages"]

    async with tenant_session(ctx.tenant_id) as s:
        await s.execute(
            update(Interview)
            .where(Interview.id == uuid.UUID(iv["id"]))
            .values(link_expires_at=datetime.now(UTC) - timedelta(seconds=1))
        )
        await s.commit()
    expired = await client.get(f"/v1/public/interviews/{token}", headers=cookie)
    assert expired.status_code == 410 and expired.json() == {"reason": "expired"}
    unknown = await client.get(f"/v1/public/interviews/{public.new_token()[0]}")
    assert unknown.status_code == 404 and unknown.json() == expired.json()

    iv2, token2 = await invited(client, ctx, fake, interviewee_name="Ben Ode")
    _, cookie2 = await open_link(client, token2)
    resp = await client.post(f"/v1/interviews/{iv2['id']}/revoke", headers=ctx.as_("viewer"))
    assert resp.status_code == 403
    resp = await client.post(f"/v1/interviews/{iv2['id']}/revoke", headers=ctx.as_("approver"))
    assert resp.status_code == 200 and resp.json()["status"] == "revoked"
    gone = await client.get(f"/v1/public/interviews/{token2}", headers=cookie2)
    assert gone.status_code == 410 and gone.json() == {"reason": "withdrawn"}


async def test_customer_turn_isolation(client, ctx, fake, no_wait):
    """protects=rule 4 (criterion 5): a customer-facing call holds only the rules, the
    approved intro and questions and this conversation; at most one follow-up per
    question; fails_when=any baseline, source, goal or other interview text is in the
    request, or a second follow-up is posted; no_claim=what the real model would say."""
    async with tenant_session(ctx.tenant_id) as s:
        s.add(
            Entity(
                type="goal",
                key="g-hidden",
                title="Hidden goal H4",
                status="confirmed",
                origin="user",
            )
        )
        await s.commit()
    other, _ = await invited(client, ctx, fake, interviewee_name="Other Person O2")
    iv, token = await invited(client, ctx, fake)
    _, cookie = await open_link(client, token)

    ask(fake, "Thanks.", "Which supplier was it?")
    turn = await say(client, token, cookie, "Gloves.")
    assert [m["role"] for m in turn["messages"]] == ["customer", "oracle", "oracle"]
    assert [m["body"] for m in turn["messages"][1:]] == ["Thanks.", "Which supplier was it?"]
    assert turn["progress"] == {"asked": 1, "total": 3} and turn["done"] is False

    kind, payload = fake.calls[-1]
    assert kind == "interview_turn"
    assert set(payload) == {"intro", "questions", "current_question", "conversation",
                            "may_follow_up"}  # fmt: skip
    assert payload["intro"] == GUIDE["intro"]
    assert [q["prompt"] for q in payload["questions"]] == [q["prompt"] for q in GUIDE["questions"]]
    assert payload["conversation"][-1] == {"role": "customer", "body": "Gloves."}
    text = str(payload)
    for leaked in ("Hidden goal H4", "Other Person O2", "Example Co", "Northwind", "Ana Lima"):
        assert leaked not in text

    ask(fake, "Got it.", "And how often?")
    turn = await say(client, token, cookie, "Acme Gloves, again.")
    assert [m["body"] for m in turn["messages"][1:]] == ["Got it.", GUIDE["questions"][1]["prompt"]]
    assert fake.calls[-1][1]["may_follow_up"] is False
    assert turn["progress"] == {"asked": 2, "total": 3}
    async with tenant_session(ctx.tenant_id) as s:
        oracle_rows = list(
            await s.scalars(
                select(InterviewMessage).where(
                    InterviewMessage.interview_id == uuid.UUID(iv["id"]),
                    InterviewMessage.kind == "ack",
                )
            )
        )
        assert oracle_rows and all(r.model and r.cost_usd is not None for r in oracle_rows)
    assert other["id"] != iv["id"]


async def test_a_reply_with_a_link_or_too_long_is_replaced_by_the_next_question(
    client, ctx, fake, no_wait
):
    """protects=rule 5 (criterion 6): a model reply that fails the checks never reaches the
    customer; fails_when=a URL or over-long text is posted; no_claim=every unsafe form."""
    _, token = await invited(client, ctx, fake)
    _, cookie = await open_link(client, token)
    ask(fake, "Thanks! See https://example.com/deal", None)
    turn = await say(client, token, cookie, LONG)
    assert [m["body"] for m in turn["messages"][1:]] == [GUIDE["questions"][1]["prompt"]]
    ask(fake, "Thanks.", "Why? " + "y" * 400)
    turn = await say(client, token, cookie, LONG)
    assert [m["body"] for m in turn["messages"][1:]] == [GUIDE["questions"][2]["prompt"]]
    fake.script["interview_turn"].append("not json at all")
    turn = await say(client, token, cookie, LONG)
    assert turn["messages"][-1]["body"].startswith("That was my last question")


async def test_messages_are_paced_capped_and_the_40th_finishes(client, ctx, fake, monkeypatch):
    """protects=rule 3 (criterion 7): one message every 2 s, 2000 characters, 40 at most;
    fails_when=a fast message passes, a long one is kept or a 41st is taken;
    no_claim=a clock: the last message's time is moved back by hand."""
    iv, token = await invited(client, ctx, fake)
    _, cookie = await open_link(client, token)
    await say(client, token, cookie, "x" * 2001, expect=422)
    await say(client, token, cookie, "   ", expect=422)
    await say(client, token, cookie, LONG)
    fast = await client.post(
        f"/v1/public/interviews/{token}/messages", json={"body": LONG}, headers=cookie
    )
    assert fast.status_code == 429 and fast.json()["detail"] == "Please wait a moment"

    monkeypatch.setattr(public, "MIN_INTERVAL_SECONDS", 0.0)
    async with tenant_session(ctx.tenant_id) as s:
        await s.execute(
            update(Interview)
            .where(Interview.id == uuid.UUID(iv["id"]))
            .values(customer_messages=38)
        )
        await s.commit()
    turn = await say(client, token, cookie, LONG)
    assert turn["done"] is False
    turn = await say(client, token, cookie, LONG)
    assert turn["done"] is True
    got = await get(client, ctx, iv["id"])
    assert got["status"] == "finished" and got["snapshot_job"]["status"] == "queued"
    resp = await client.post(
        f"/v1/public/interviews/{token}/messages", json={"body": LONG}, headers=cookie
    )
    assert resp.status_code == 410 and resp.json() == {"reason": "used"}


@pytest.mark.timing
async def test_a_burst_on_one_link_never_holds_the_pool_for_other_companies(client, ctx, fake):
    """protects=the shared connection pool (second review of #321): the cheap checks run
    before any lock, the model call holds no row lock or connection, and one turn per link
    runs at a time; fails_when=20 concurrent messages on one link stall a member route of
    another company, or more than one turn reaches the model; no_claim=a real model's
    latency (the fake call waits until the member route has answered)."""
    _, token = await invited(client, ctx, fake)
    _, cookie = await open_link(client, token)
    other = await make_ctx("Other Co")
    in_flight, release = asyncio.Event(), asyncio.Event()

    async def slow(kind, _payload):
        if kind == "interview_turn":
            in_flight.set()
            await release.wait()

    fake.on_call = slow
    burst = asyncio.gather(
        *(
            client.post(
                f"/v1/public/interviews/{token}/messages",
                json={"body": f"Answer {i}"},
                headers=cookie,
            )
            for i in range(20)
        )
    )
    try:
        await asyncio.wait_for(in_flight.wait(), 10)
        await asyncio.sleep(0.5)  # the rest of the burst arrives while the call runs
        started = time.monotonic()
        member = await asyncio.wait_for(
            client.get("/v1/interviews", headers=other.as_("viewer")), 5
        )
        assert member.status_code == 200, member.text
        assert time.monotonic() - started < 2
    finally:
        release.set()
        replies = await burst
    codes = sorted(r.status_code for r in replies)
    assert codes == [200] + [429] * 19, codes
    assert sum(1 for kind, _ in fake.calls if kind == "interview_turn") == 1


async def test_one_turn_per_link_is_kept_in_the_database(client, ctx, fake, no_wait):
    """protects=the one-turn-per-link limit holds across API instances (fifth review of
    #380): the running turn is claimed on the interview row, not in one process's
    memory; fails_when=a message is taken while another instance's turn runs, or a
    claim left by a crashed instance blocks the link for good; no_claim=a second
    process (its claim is written to the row as that instance would)."""
    iv, token = await invited(client, ctx, fake)
    _, cookie = await open_link(client, token)

    async def claim(at):
        async with tenant_session(ctx.tenant_id) as s:
            await s.execute(
                update(Interview)
                .where(Interview.id == uuid.UUID(iv["id"]))
                .values(turn_started_at=at)
            )
            await s.commit()

    await claim(datetime.now(UTC))
    busy = await client.post(
        f"/v1/public/interviews/{token}/messages", json={"body": LONG}, headers=cookie
    )
    assert busy.status_code == 429 and busy.json()["detail"] == "Please wait a moment"
    assert not [k for k, _ in fake.calls if k == "interview_turn"]
    # A claim older than the model call's deadline is from an instance that stopped.
    await claim(datetime.now(UTC) - timedelta(seconds=turns.DEADLINE_SECONDS + 10))
    ask(fake)
    await say(client, token, cookie, LONG)
    async with tenant_session(ctx.tenant_id) as s:
        row = await s.get(Interview, uuid.UUID(iv["id"]))
        assert row.turn_started_at is None


async def test_refused_requests_are_audited_up_to_a_limit(client, ctx, fake):
    """protects=the audit log against a flood of refused requests on a known link
    (fifth review of #380); fails_when=every refused request writes an audit row, or
    none is audited; no_claim=the one-minute window's exact edge."""
    iv, token = await invited(client, ctx, fake)
    await open_link(client, token)
    client.cookies.clear()
    for _ in range(public.REFUSED_AUDITS + 10):
        resp = await client.get(f"/v1/public/interviews/{token}")
        assert resp.status_code == 410 and resp.json() == {"reason": "used"}
    async with tenant_session(ctx.tenant_id) as s:
        refused = [
            e
            for e in await s.scalars(
                select(AuditEvent).where(AuditEvent.entity_id == uuid.UUID(iv["id"]))
            )
            if "refused" in (e.data or {})
        ]
    assert len(refused) == public.REFUSED_AUDITS


async def test_snapshot_needs_to_requests(client, ctx, fake, no_wait):
    """protects=rule 6-7 (criterion 8): Finish queues the snapshot, invented quotes are
    dropped, each need becomes one New, unverified, interview-channel request linked to
    the interview and its theme; nothing is written to a gap or an answer;
    fails_when=a need is lost, verified, or written to a gap; no_claim=snapshot quality."""
    theme = await client.post(
        "/v1/request-themes", json={"title": "Reordering"}, headers=ctx.as_("approver")
    )
    assert theme.status_code == 201, theme.text
    theme_id = theme.json()["id"]
    iv, token = await invited(client, ctx, fake, subject={"theme_id": theme_id})
    _, cookie = await open_link(client, token)
    ask(fake)
    await say(client, token, cookie, LONG)
    skipped = await client.post(f"/v1/public/interviews/{token}/skip", headers=cookie)
    assert skipped.status_code == 200
    assert skipped.json()["messages"][-1]["body"] == GUIDE["questions"][2]["prompt"]
    async with tenant_session(ctx.tenant_id) as s:
        gaps_before = len(list(await s.scalars(select(KnowledgeGap))))
    done = await client.post(f"/v1/public/interviews/{token}/finish", headers=cookie)
    assert done.status_code == 200 and done.json() == {"done": True}

    q1 = (await get(client, ctx, iv["id"]))["guide"][0]["id"]
    fake.script["interview_snapshot"].append(
        {
            "quick_facts": ["Reorders gloves weekly"],
            "quotes": [
                {"text": "retype the address twice", "question_id": q1},
                {"text": "I love this product", "question_id": q1},
            ],
            "needs": [
                {"title": "Keep the delivery address", "quote": "retype the address twice",
                 "question_id": q1},
                {"title": "Faster reorder", "quote": "an invented line", "question_id": q1},
            ],
            "insights": ["Address entry is the friction"],
        }
    )  # fmt: skip
    await worker.run_pending(ctx.tenant_id)
    kind, payload = fake.calls[-1]
    assert kind == "interview_snapshot" and "Example Co" not in str(payload)

    got = await get(client, ctx, iv["id"])
    assert got["status"] == "finished" and got["finished_at"]
    assert [q["text"] for q in got["snapshot"]["quotes"]] == ["retype the address twice"]
    assert len(got["request_ids"]) == 2
    async with tenant_session(ctx.tenant_id) as s:
        rows = list(
            await s.scalars(
                select(ProductRequest).where(ProductRequest.interview_id == uuid.UUID(iv["id"]))
            )
        )
        assert sorted(r.title for r in rows) == ["Faster reorder", "Keep the delivery address"]
        for r in rows:
            assert (r.state, r.verified, r.channel, r.origin) == ("new", False, "interview",
                                                                   "interview")  # fmt: skip
            assert r.requester_kind == "customer"
            assert r.requester_name == "Ana Lima (Northwind Clinics)"
            assert str(r.theme_id) == theme_id
        by_title = {r.title: r for r in rows}
        assert by_title["Keep the delivery address"].body == "retype the address twice"
        assert by_title["Faster reorder"].body is None
        assert len(list(await s.scalars(select(KnowledgeGap)))) == gaps_before
        assert not list(await s.scalars(select(StakeholderAnswer)))
    reqs = await client.get("/v1/requests?state=new", headers=ctx.as_("viewer"))
    assert {r["id"] for r in reqs.json()["items"]} >= set(got["request_ids"])


async def test_the_ticker_expires_links_and_snapshots_what_was_said(client, ctx, fake, no_wait):
    """protects=expiry by the ticker with a snapshot only when there is an answer;
    fails_when=an expired interview stays open or one without answers is snapshotted;
    no_claim=Cloud Scheduler: the sweep is called directly."""
    from oracle.interviews import service

    said, token = await invited(client, ctx, fake)
    _, cookie = await open_link(client, token)
    ask(fake)
    await say(client, token, cookie, LONG)
    silent, _ = await invited(client, ctx, fake, interviewee_name="Ben Ode")
    async with tenant_session(ctx.tenant_id) as s:
        await s.execute(
            update(Interview).values(link_expires_at=datetime.now(UTC) - timedelta(minutes=1))
        )
        await s.commit()
    async with tenant_session(ctx.tenant_id) as s:
        assert await service.expire_due(s) == 2
        await s.commit()
    one, two = await get(client, ctx, said["id"]), await get(client, ctx, silent["id"])
    assert one["status"] == two["status"] == "expired"
    assert one["snapshot_job"]["status"] == "queued" and two["snapshot_job"] is None


async def test_a_new_link_replaces_the_old_one(client, ctx, fake, no_wait):
    """protects=qa-work-43 Make a new link: a fresh link opens the same interview (its
    answers kept), only its sha256 is stored, the old link says plainly it was replaced,
    the change is audited; fails_when=the old link still works or reads as an unknown
    404, the raw token is stored, a viewer makes one, or a finished or withdrawn
    interview gets one; no_claim=delivery of the link to the customer."""
    iv, old = await invited(client, ctx, fake)
    _, cookie = await open_link(client, old)
    ask(fake)
    await say(client, old, cookie, LONG)
    path = f"/v1/interviews/{iv['id']}/new-link"
    viewer = await client.post(path, headers=ctx.as_("viewer"))
    assert viewer.status_code == 403
    resp = await client.post(path, headers=ctx.as_("commenter"))
    assert resp.status_code == 201, resp.text
    link = resp.json()
    new = link["url"].rsplit("/i/", 1)[1]
    assert new != old and set(link) >= {"url", "expires_at", "created_at"}
    expires = datetime.fromisoformat(link["expires_at"])
    assert timedelta(days=6, hours=23) < expires - datetime.now(UTC) <= timedelta(days=7)
    async with tenant_session(ctx.tenant_id) as s:
        row = await s.get(Interview, uuid.UUID(iv["id"]))
        assert row.link_token_hash == public.hash_value(new) and row.link_opened_at is None
        columns = str({c.name: getattr(row, c.name) for c in row.__table__.columns})
        assert new not in columns and old not in columns
        events = list(
            await s.scalars(
                select(AuditEvent).where(AuditEvent.action == "interview.link_replaced")
            )
        )
        assert [str(e.entity_id) for e in events] == [iv["id"]]
    got = await get(client, ctx, iv["id"])
    assert got["status"] == "in_progress" and got["link_created_at"] == link["created_at"]
    assert got["link_opened_at"] is None and new not in str(got)

    for path_, method in (("", "get"), ("/messages", "post"), ("/finish", "post")):
        kwargs = {"json": {"body": "hi"}} if path_ == "/messages" else {}
        stale = await getattr(client, method)(
            f"/v1/public/interviews/{old}{path_}", headers=cookie, **kwargs
        )
        assert stale.status_code == 410 and stale.json() == {"reason": "replaced"}, path_

    page, cookie2 = await open_link(client, new)
    assert page["status"] == "in_progress"
    bodies = [m["body"] for m in page["messages"]]
    assert bodies.count(GUIDE["questions"][0]["prompt"]) == 1 and LONG in bodies

    other, _ = await invited(client, ctx, fake, interviewee_name="Ben Ode")
    await client.post(f"/v1/interviews/{other['id']}/revoke", headers=ctx.as_("commenter"))
    closed = await client.post(
        f"/v1/interviews/{other['id']}/new-link", headers=ctx.as_("commenter")
    )
    assert closed.status_code == 409
    assert closed.json()["detail"] == "This interview was withdrawn, so it can't get a new link."
    done = await client.post(f"/v1/public/interviews/{new}/finish", headers=cookie2)
    assert done.status_code == 200, done.text
    finished = await client.post(path, headers=ctx.as_("approver"))
    assert finished.status_code == 409
    assert finished.json()["detail"] == "This interview is finished, so it can't get a new link."


async def test_public_operations_are_not_mcp_tools(client):
    """protects=criterion 11: the customer's routes are never MCP tools and are listed as
    unavailable; fails_when=a public operation is offered over MCP; no_claim=the rest of
    the tool list."""
    from oracle.main import app
    from oracle.mcp.tools import app_operations

    ops = {o.operation_id: o for o in app_operations(app)}
    for op_id in public.OPERATIONS:
        assert ops[op_id].excluded, op_id
        assert ops[op_id].path.startswith("/v1/public/interviews/")
    members = [o for o in ops.values() if o.path.startswith("/v1/interviews")]
    assert members and not any(o.excluded for o in members)
