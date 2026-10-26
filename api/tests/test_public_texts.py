"""O5 lane 2: the public-safe variant (spec-O5 §2, Lanes 2; owner answers O5 Q1, Q7).

Public texts per (roadmap, item key), the deterministic leak check, the ``public_text``
job (Oracle drafts, a person approves each text), ``render_public`` (built from
allowlisted fields only, never filtered from the internal text), the preview and the
public check. Invented data only ("Example Labs", "Northwind Traders").
"""

import dataclasses
import hashlib
import re
from datetime import date

import pytest
from sqlalchemy import select

from oracle.auth.models import User
from oracle.decisions.models import Decision
from oracle.docs.models import Document
from oracle.jobs import worker
from oracle.jobs.models import LlmJob
from oracle.market.models import Competitor
from oracle.models import AuditEvent
from oracle.pricing.models import DealOutcome
from oracle.roadmap import leak_check, public
from oracle.roadmap.models import RoadmapItem, RoadmapPublicText
from oracle.tenancy import tenant_session
from tests.baseline_helpers import make_ctx
from tests.claude_account_helpers import add_account, window
from tests.coverage_helpers import run_headers
from tests.test_export_audience import SLUG, _text, seed_roadmap
from tests.test_llm_jobs import FakeClaude

TEXTS = f"/v1/roadmaps/{SLUG}/public-texts"
PREVIEW = f"/v1/roadmaps/{SLUG}/versions/1/public-preview"
CHECK = f"/v1/roadmaps/{SLUG}/publications/1/public-check"
PAGE = f"/v1/roadmaps/{SLUG}/public-page"
ROLES = ["viewer", "commenter", "approver", "owner", "token", "run"]

# Unique marker strings: none of them may ever reach a public render.
PERSON = "Priya Quillfeather"
ACCOUNT = "Northwind Traders"
PLAN = "Scale Plus Annual"
RIVAL, RIVAL_ALIAS = "Acme Rival", "RivalCo"
HIDDEN_DOC = "Project Bluebird acquisition"
DECISION = "Sunset the legacy importer"
NOTE = "vendor contract renewal blocks the importer rollout until the audit clears"
MARKERS = [
    PERSON,
    ACCOUNT,
    PLAN,
    RIVAL,
    RIVAL_ALIAS,
    HIDDEN_DOC,
    "bluebird-plan",
    DECISION,
    NOTE,
    "Dana Markerson",
    "revenue-marker-91",
    "ENG-412",
    "Example Labs roadmap",  # the internal document title
    SLUG,
    "Every column parses",  # an internal outcome
    "Serves no confirmed goal",
    "Confetti",
    "Stickers",
    "unapproved-marker-77",
]


@pytest.fixture
async def ctx():
    return await make_ctx("Example Labs")


@pytest.fixture
def fake():
    from oracle.llm import gateway

    claude = FakeClaude()
    previous = gateway.set_transports(gateway.Transports(plan=claude, api_key=claude))
    yield claude
    gateway.set_transports(previous)


async def _headers(ctx, who: str) -> dict[str, str]:
    if who == "run":
        return await run_headers(ctx, "owner")
    return ctx.as_(who)


async def seed(ctx, *, publish: bool = True) -> None:
    """The lane-1 roadmap plus what a public text must never name: a member, a win/loss
    account and plan, an alternative and its alias, an approvers-only document, a
    decision, and an internal note on an item."""
    await seed_roadmap(ctx, publish=publish)
    async with tenant_session(ctx.tenant_id) as s:
        approver = await s.get(User, ctx.users["approver"].id)
        approver.name = PERSON
        s.add(
            DealOutcome(
                result="lost",
                account=ACCOUNT,
                plan=PLAN,
                decided_on=date(2026, 9, 1),
                reason="price",
                recorded_by=ctx.users["owner"].id,
            )
        )
        s.add(Competitor(name=RIVAL, kind="direct", aliases=[RIVAL_ALIAS]))
        s.add(
            Document(
                slug="bluebird-plan", title=HIDDEN_DOC, kind="strategy", visibility="approvers"
            )
        )
        s.add(
            Decision(
                number=7,
                title=DECISION,
                approver_id=ctx.users["owner"].id,
                driver="oracle",
                origin="manual",
            )
        )
        item = await s.scalar(select(RoadmapItem).where(RoadmapItem.item_key == "bulk-import"))
        item.note = NOTE
        await s.commit()


def text_body(**over) -> dict:
    body = {
        "title": "Import your accounts in one go",
        "description": "Bring every account over on your first day, with no setup.",
        "stage": "in_progress",
        "state": "approved",
        "checked_warnings": [],
    }
    return {**body, **over}


async def put_text(client, ctx, key: str, who: str = "approver", **over):
    return await client.put(f"{TEXTS}/{key}", json=text_body(**over), headers=ctx.as_(who))


async def approve_both(client, ctx) -> None:
    for key, title in (("bulk-import", "Import your accounts in one go"),
                       ("csv-parser", "Every spreadsheet column, understood")):  # fmt: skip
        resp = await put_text(client, ctx, key, title=title)
        assert resp.status_code == 200, resp.text


# --- the leak check (unit) -------------------------------------------------------------


def _ctx(**over) -> leak_check.LeakContext:
    base = dict(
        people=[PERSON],
        emails=["priya@example.com"],
        customers=[ACCOUNT],
        alternatives=[RIVAL, RIVAL_ALIAS],
        hidden_documents=[HIDDEN_DOC, "bluebird-plan"],
        slugs=[SLUG],
        decisions=[DECISION],
        pricing=[PLAN],
        notes=[NOTE],
        hosts=["oracle.example.com"],
        company_domains=["example.com"],
    )
    return leak_check.LeakContext(**{**base, **over})


@pytest.mark.parametrize(
    ("text", "code", "word"),
    [
        (f"Built with {PERSON}", "person_name", PERSON),
        ("Write to priya@example.com", "email_or_phone", "priya@example.com"),
        ("Call +1 415 555 0134", "email_or_phone", "+1 415 555 0134"),
        (f"As {ACCOUNT} asked", "customer_name", ACCOUNT),
        (f"Faster than {RIVAL_ALIAS}", "alternative_name", RIVAL_ALIAS),
        ("Closes ENG-412", "internal_code", "ENG-412"),
        ("Serves G3", "internal_code", "G3"),
        ("After D-7", "internal_code", "D-7"),
        (f"See {SLUG}", "internal_code", SLUG),
        ("See https://oracle.example.com/documents/x", "internal_host", "oracle.example.com"),
        ("See http://localhost:3000/", "internal_host", "localhost"),
        ("See https://10.0.0.4/x", "internal_host", "10.0.0.4"),
        (f"Part of {HIDDEN_DOC}", "internal_document", HIDDEN_DOC),
        (f"Because we {DECISION.lower()}", "decision", DECISION),
        (f"Included in {PLAN}", "pricing", PLAN),
        (f"Ships once the {NOTE[:60]}", "internal_note", None),
    ],
)
def test_each_blocking_finding(text, code, word):
    """protects=each blocking leak finding of spec-O5 §2 (plus the hidden decisions,
    approvers-only documents, pricing and internal notes this lane adds) is found
    deterministically; fails_when=a public text naming one passes; no_claim=the model."""
    findings = leak_check.check(text, _ctx())
    match = [f for f in findings if f.code == code]
    assert match, findings
    assert match[0].severity == "blocking"
    if word is not None:
        assert any(word.lower() in w.lower() for w in match[0].words)


@pytest.mark.parametrize(
    ("text", "code"),
    [
        ("Cuts setup time by 40%", "money_or_metric"),
        ("Saves $1,200 a year", "money_or_metric"),
        ("Arrives on March 3", "date"),
    ],
)
def test_warnings(text, code):
    findings = leak_check.check(text, _ctx())
    assert [f.code for f in findings] == [code]
    assert findings[0].severity == "warning"


def test_a_date_inside_the_announced_quarter_is_fine_and_a_copied_title_warns():
    assert leak_check.check("Arrives in November", _ctx(), announced_quarter="2026-Q4") == []
    assert [f.code for f in leak_check.check("Arrives in March", _ctx(),
                                             announced_quarter="2026-Q4")] == ["date"]  # fmt: skip
    found = leak_check.check("Bulk import", _ctx(), internal_title="Bulk import")
    assert [f.code for f in found] == ["internal_title_copy"]


def test_plain_customer_words_have_no_finding():
    text = "Import your accounts in one go. Bring every account over on day one."
    assert leak_check.check(text, _ctx()) == []
    # A name must match as words, not inside another word.
    assert leak_check.check("Acme Rivalry board games", _ctx()) == []


def test_the_public_page_has_only_allowlisted_fields():
    """protects=render_public is built, not filtered: its input holds no slot for any
    internal field; fails_when=a field such as owner, goal or internal title is added;
    no_claim=the values put in it."""
    page = {f.name for f in dataclasses.fields(public.PublicPage)}
    assert page == {"company", "title", "intro", "disclaimer", "columns", "oracle_mark"}
    card = {f.name for f in dataclasses.fields(public.PublicCard)}
    assert card == {"title", "description", "stage", "announced_quarter", "changelog_url"}


# --- roles -----------------------------------------------------------------------------


@pytest.mark.parametrize(
    ("who", "code"),
    [("viewer", 403), ("commenter", 403), ("approver", 200), ("owner", 200), ("token", 200),
     ("run", 403)],
)  # fmt: skip
async def test_every_route_needs_an_approver_and_refuses_a_run(client, ctx, who, code):
    """protects=Q1: public texts, the preview and the check are an approver's, and agents
    get no public text (spec-O5 MCP and agents); fails_when=a viewer, commenter or run
    token reads or writes one; no_claim=share links (lane 3)."""
    await seed(ctx)
    h = await _headers(ctx, who)
    assert (await client.get(TEXTS, headers=h)).status_code == code
    resp = await client.put(f"{TEXTS}/bulk-import", json=text_body(state="draft"), headers=h)
    assert resp.status_code == code, resp.text
    assert (await client.get(PREVIEW, headers=h)).status_code == code
    resp = await client.put(PAGE, json={"public_title": "Example Labs plans"}, headers=h)
    assert resp.status_code == code, resp.text
    draft = await client.post(f"{TEXTS}/draft", headers=h)
    assert draft.status_code == (202 if code == 200 else code), draft.text
    check = await client.post(CHECK, headers=h)
    assert check.status_code == (409 if code == 200 else code), check.text


# --- public texts and the leak check through the API ---------------------------------------


async def test_the_review_list_counts_shown_and_left_out(client, ctx):
    await seed(ctx)
    resp = await client.get(TEXTS, headers=ctx.as_("approver"))
    assert resp.status_code == 200, resp.text
    body = resp.json()
    rows = {r["item_key"]: r for r in body["rows"]}
    assert set(rows) == {"csv-parser", "bulk-import", "confetti", "stickers"}
    assert rows["bulk-import"]["state"] == "missing"
    assert rows["confetti"]["left_out_reason"] == "no_goal"
    assert body["shown"] == 0
    assert body["left_out"] == {"no_approved_text": 2, "excluded": 0, "no_goal": 2}
    await approve_both(client, ctx)
    resp = await put_text(client, ctx, "stickers", state="excluded")
    assert resp.status_code == 200
    body = (await client.get(TEXTS, headers=ctx.as_("approver"))).json()
    assert body["shown"] == 2
    assert body["left_out"] == {"no_approved_text": 0, "excluded": 1, "no_goal": 1}
    assert body["removed"]["owners"] >= 0 and body["removed"]["tracker_links"] == 2


@pytest.mark.parametrize(
    ("over", "code"),
    [
        ({"title": f"Requested by {ACCOUNT}"}, "customer_name"),
        ({"description": f"Owned by {PERSON}."}, "person_name"),
        ({"description": f"Better than {RIVAL_ALIAS}."}, "alternative_name"),
        ({"description": "Closes ENG-412."}, "internal_code"),
        ({"description": f"From {HIDDEN_DOC}."}, "internal_document"),
        ({"description": f"We decided to {DECISION.lower()}."}, "decision"),
        ({"description": f"Part of {PLAN}."}, "pricing"),
        ({"description": f"Waits: {NOTE}."}, "internal_note"),
        ({"changelog_url": "http://localhost:3000/changelog"}, "internal_host"),
    ],
)
async def test_a_text_with_a_blocking_finding_cannot_be_approved(client, ctx, over, code):
    """protects=criterion 3 (422 leak_blocking naming the finding and the words), for the
    seeded members, accounts, alternatives, approvers-only documents, decisions, pricing
    and internal notes; fails_when=the text is approved; no_claim=a draft may hold it."""
    await seed(ctx)
    resp = await put_text(client, ctx, "bulk-import", **over)
    assert resp.status_code == 422, resp.text
    detail = resp.json()["detail"]
    assert detail["code"] == "leak_blocking"
    assert code in {f["code"] for f in detail["findings"]}
    # A draft may hold it: a person fixes it before approving.
    resp = await put_text(client, ctx, "bulk-import", state="draft", **over)
    assert resp.status_code == 200, resp.text
    assert code in {f["code"] for f in resp.json()["findings"]}


async def test_a_warning_needs_a_tick(client, ctx):
    await seed(ctx)
    resp = await put_text(client, ctx, "bulk-import", description="Setup takes 40% less time.")
    assert resp.status_code == 422
    assert resp.json()["detail"]["code"] == "warnings_unchecked"
    assert resp.json()["detail"]["warnings"] == ["money_or_metric"]
    resp = await put_text(client, ctx, "bulk-import", description="Setup takes 40% less time.",
                          checked_warnings=["money_or_metric"])  # fmt: skip
    assert resp.status_code == 200, resp.text
    assert resp.json()["state"] == "approved"


async def test_limits_and_unknown_items(client, ctx):
    await seed(ctx)
    assert (await put_text(client, ctx, "bulk-import", title="x" * 81)).status_code == 422
    assert (await put_text(client, ctx, "bulk-import", description="x" * 281)).status_code == 422
    assert (await put_text(client, ctx, "bulk-import", stage="soon")).status_code == 422
    bad = await put_text(client, ctx, "bulk-import", announced_quarter="2026-11")
    assert bad.status_code == 422
    assert (await put_text(client, ctx, "no-such-item")).status_code == 404
    https_only = await put_text(client, ctx, "bulk-import", changelog_url="ftp://x.example.org/")
    assert https_only.status_code == 422


async def test_every_change_is_audited(client, ctx):
    await seed(ctx)
    await put_text(client, ctx, "bulk-import", state="draft")
    await put_text(client, ctx, "bulk-import")
    await put_text(client, ctx, "csv-parser", state="excluded")
    async with tenant_session(ctx.tenant_id) as s:
        actions = [
            a.action
            for a in await s.scalars(
                select(AuditEvent)
                .where(AuditEvent.action.like("roadmap.public_text.%"))
                .order_by(AuditEvent.created_at)
            )
        ]
    assert actions == [
        "roadmap.public_text.edited",
        "roadmap.public_text.approved",
        "roadmap.public_text.excluded",
    ]


# --- render_public and the preview -------------------------------------------------------


async def test_the_preview_holds_no_internal_marker(client, ctx):
    """protects=criterion 4 and 13: the Public page holds only allowlisted fields of
    approved texts; nothing internal (owners, goals, outcomes, tracker keys, economics,
    hidden decisions, approvers-only documents, pricing, notes, unapproved texts, items
    serving no goal, the internal title and slug) reaches it; fails_when=any marker
    appears; no_claim=the PDF (lane 3 serves it from this HTML)."""
    await seed(ctx)
    await approve_both(client, ctx)
    # An unapproved draft never shows.
    async with tenant_session(ctx.tenant_id) as s:
        doc = await s.scalar(select(Document).where(Document.slug == SLUG))
        s.add(
            RoadmapPublicText(
                document_id=doc.id,
                item_key="confetti",
                title="unapproved-marker-77",
                stage="planned",
                drafted_by="oracle",
                source_hash="x",
            )
        )
        await s.commit()
    resp = await client.get(PREVIEW, headers=ctx.as_("approver"))
    assert resp.status_code == 200, resp.text
    assert resp.headers["content-type"].startswith("text/html")
    html = resp.text
    for marker in MARKERS:
        assert marker.lower() not in html.lower(), marker
    text = _text(html)
    assert "Import your accounts in one go" in text
    assert "Every spreadsheet column, understood" in text
    assert "In progress" in text and "Example Labs" in text
    assert public.DEFAULT_DISCLAIMER in text
    assert "Made with Product Oracle" in text
    # No script, no outside fetch, no comment.
    assert "<script" not in html.lower() and "<!--" not in html
    assert not re.search(r"""(src|href)=["']https?://""", html.replace(
        'href="https://changelog.example.org/', ""))  # fmt: skip
    assert resp.headers["cache-control"] == "no-store"
    assert "default-src 'none'" in resp.headers["content-security-policy"]
    assert resp.headers["x-robots-tag"] == "noindex, nofollow"


async def test_the_page_title_intro_quarter_and_changelog(client, ctx):
    await seed(ctx)
    await approve_both(client, ctx)
    resp = await put_text(client, ctx, "bulk-import", announced_quarter="2026-Q4",
                          changelog_url="https://changelog.example.org/import")  # fmt: skip
    assert resp.status_code == 200, resp.text
    resp = await client.put(
        PAGE,
        json={"public_title": "What Example Labs is building", "public_intro": "Our plans."},
        headers=ctx.as_("approver"),
    )
    assert resp.status_code == 200, resp.text
    leak = await client.put(PAGE, json={"public_intro": f"For {ACCOUNT}."},
                            headers=ctx.as_("approver"))  # fmt: skip
    assert leak.status_code == 422 and leak.json()["detail"]["code"] == "leak_blocking"
    html = (await client.get(PREVIEW, headers=ctx.as_("approver"))).text
    text = _text(html)
    assert "What Example Labs is building" in text and "Our plans." in text
    assert "Q4 2026" in text
    assert 'href="https://changelog.example.org/import"' in html
    assert 'rel="noopener noreferrer nofollow"' in html


async def test_a_changed_internal_item_drops_its_text_until_approved_again(client, ctx):
    """protects=going stale: once an item's internal title or outcome differs from the
    text's source_hash it is left out with the chip "Internal item changed";
    fails_when=a text written for another item still shows; no_claim=diffs."""
    await seed(ctx)
    await approve_both(client, ctx)
    async with tenant_session(ctx.tenant_id) as s:
        item = await s.scalar(select(RoadmapItem).where(RoadmapItem.item_key == "bulk-import"))
        item.title = "Bulk import and export"
        await s.commit()
    body = (await client.get(TEXTS, headers=ctx.as_("approver"))).json()
    row = next(r for r in body["rows"] if r["item_key"] == "bulk-import")
    assert row["state"] == "changed" and row["shown"] is False
    html = (await client.get(PREVIEW, headers=ctx.as_("approver"))).text
    assert "Import your accounts in one go" not in html
    assert (await put_text(client, ctx, "bulk-import")).status_code == 200
    html = (await client.get(PREVIEW, headers=ctx.as_("approver"))).text
    assert "Import your accounts in one go" in html


async def test_an_approved_text_that_now_leaks_is_left_out(client, ctx):
    """A name that became a member after approval blocks the text at render too."""
    await seed(ctx)
    await approve_both(client, ctx)
    async with tenant_session(ctx.tenant_id) as s:
        s.add(User(email="new@example.com", password_hash="x", role="viewer", name="Spreadsheet"))
        await s.commit()
    html = (await client.get(PREVIEW, headers=ctx.as_("approver"))).text
    assert "Every spreadsheet column, understood" not in html


# --- the public check --------------------------------------------------------------------


async def test_the_check_needs_every_shown_item_approved_then_lapses(client, ctx):
    """protects=criterion 5: 409 not_ready while an item lacks an approved text; a check
    records the shown keys and content hash; editing a text lapses it; fails_when=a
    check passes with a draft or stays current after an edit; no_claim=the shared page."""
    await seed(ctx)
    await put_text(client, ctx, "bulk-import")
    resp = await client.post(CHECK, headers=ctx.as_("approver"))
    assert resp.status_code == 409, resp.text
    detail = resp.json()["detail"]
    assert detail["code"] == "not_ready"
    assert detail["left"] == [{"item_key": "csv-parser", "reason": "missing"}]
    await approve_both(client, ctx)
    resp = await client.post(CHECK, headers=ctx.as_("approver"))
    assert resp.status_code == 201, resp.text
    check = resp.json()
    assert sorted(check["shown_item_keys"]) == ["bulk-import", "csv-parser"]
    assert check["state"] == "checked" and len(check["content_hash"]) == 64
    body = (await client.get(TEXTS, headers=ctx.as_("approver"))).json()
    assert body["check"]["state"] == "checked"
    assert public.check_state(None) == "none"
    await put_text(client, ctx, "csv-parser", description="Now with every column.")
    body = (await client.get(TEXTS, headers=ctx.as_("approver"))).json()
    assert body["check"]["state"] == "lapsed"
    async with tenant_session(ctx.tenant_id) as s:
        audited = await s.scalar(
            select(AuditEvent).where(AuditEvent.action == "roadmap.public_checked")
        )
    assert audited is not None


async def test_the_check_is_for_a_publication(client, ctx):
    await seed(ctx, publish=False)
    resp = await client.post(CHECK, headers=ctx.as_("approver"))
    assert resp.status_code == 404


# --- the public_text job ------------------------------------------------------------------


async def test_oracle_drafts_texts_and_never_approves_or_dates(client, ctx, fake):
    """protects=Q7: the public_text job writes draft rows for items without one, within
    the limits and never with an announced quarter; a person approves each;
    fails_when=a row is approved, dated, too long or overwrites a person's text;
    no_claim=the model's wording."""
    await seed(ctx)
    await put_text(client, ctx, "csv-parser", state="draft", title="A person's own words")
    resp = await client.post(f"{TEXTS}/draft", headers=ctx.as_("approver"))
    assert resp.status_code == 202, resp.text
    assert resp.json()["kind"] == "public_text"
    await add_account(ctx.tenant_id, "personal", windows={"five_hour": window(0.2)})
    fake.script["public_text"].append(
        lambda payload: {
            "texts": [
                {
                    "item_key": i["item_key"],
                    "title": "Import in one go " + "x" * 100,
                    "description": "Bring every account over.",
                    "stage": "in_progress",
                    "announced_quarter": "2026-Q4",
                }
                for i in payload["items"]
            ]
            + [{"item_key": "csv-parser", "title": "Overwritten", "stage": "planned"}]
        }
    )
    await worker.run_pending(ctx.tenant_id)
    kind, payload = fake.calls[0]
    assert kind == "public_text"
    # Items with a text already, and items serving no goal, are not asked for.
    assert [i["item_key"] for i in payload["items"]] == ["bulk-import"]
    async with tenant_session(ctx.tenant_id) as s:
        rows = {r.item_key: r for r in await s.scalars(select(RoadmapPublicText))}
        job = await s.scalar(select(LlmJob).where(LlmJob.kind == "public_text"))
    assert job.status == "succeeded", job.error
    assert rows["bulk-import"].state == "draft" and rows["bulk-import"].drafted_by == "oracle"
    assert len(rows["bulk-import"].title) <= 80
    assert rows["bulk-import"].announced_quarter is None
    assert rows["csv-parser"].title == "A person's own words"


async def test_the_job_can_be_switched_off_per_document(client, ctx):
    await seed(ctx)
    async with tenant_session(ctx.tenant_id) as s:
        doc = await s.scalar(select(Document).where(Document.slug == SLUG))
        doc.disabled_llm_jobs = ["public_text"]
        await s.commit()
    resp = await client.post(f"{TEXTS}/draft", headers=ctx.as_("approver"))
    assert resp.status_code == 409
    assert "Draft public texts" in resp.text


async def test_a_prd_has_no_public_texts(client, ctx):
    await seed(ctx)
    resp = await client.get("/v1/roadmaps/example-labs-prd/public-texts",
                            headers=ctx.as_("approver"))  # fmt: skip
    assert resp.status_code == 422


def test_source_hash_is_title_and_outcome():
    assert public.source_hash("A", "B") == hashlib.sha256(b"A\nB").hexdigest()
    assert public.source_hash("A", None) == public.source_hash("A", "")
