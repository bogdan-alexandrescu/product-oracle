"""O5 lane 2: the public-safe variant (spec-O5 §2, Lanes 2; owner answers O5 Q1, Q7).

Public texts per (roadmap, item key), the deterministic leak check, the ``public_text``
job (Oracle drafts, a person approves each text), ``render_public`` (built from
allowlisted fields only, never filtered from the internal text), the preview and the
public check. Invented data only ("Example Labs", "Northwind Traders").
"""

import dataclasses
import hashlib
import re
import unicodedata
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
from oracle.roadmap.models import RoadmapItem, RoadmapPublicCheck, RoadmapPublicText
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
INTERNAL_TITLE = "Example Labs internal plan marker-53"
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
    INTERNAL_TITLE,
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
        roadmap = await s.scalar(select(Document).where(Document.slug == SLUG))
        roadmap.title = INTERNAL_TITLE
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
    # A one-word slug is an ordinary word; a year range is not a phone number.
    assert leak_check.check("Import your data", _ctx(slugs=["import"])) == []
    assert leak_check.check("Our plans for 2026-2027", _ctx()) == []


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
    resp = await put_text(client, ctx, "csv-parser", state="excluded")
    assert resp.status_code == 200
    body = (await client.get(TEXTS, headers=ctx.as_("approver"))).json()
    assert body["shown"] == 1, body["rows"]
    assert body["left_out"] == {"no_approved_text": 0, "excluded": 1, "no_goal": 2}
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
        ({"changelog_url": "https://localhost:3000/changelog"}, "internal_host"),
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
                    # An invisible mark the job strips (#660 re-review).
                    "description": "Bring every acc\u034fount over.",
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
    assert rows["bulk-import"].description == "Bring every account over."
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


# --- #640 review: look-alike and invisible characters, and the page's own texts ----------


@pytest.mark.parametrize(
    ("text", "code"),
    [
        ("Built with Pri\u200bya Quill\u200bfeather", "person_name"),  # zero-width spaces
        # Fullwidth, with no plain-ASCII part left to match.
        (
            "Built with \uff31\uff55\uff49\uff4c\uff4c\uff46\uff45\uff41\uff54\uff48\uff45\uff52",
            "person_name",
        ),
        ("As North\u00adwind Traders asked", "customer_name"),  # soft hyphen
        ("As N\u03bfrthwind Traders asked", "customer_name"),  # Greek omicron
        ("As N\u043erthwind Tr\u0430ders asked", "customer_name"),  # Cyrillic o and a
        ("See \u13e2roject Bluebird acquisition", "internal_document"),  # Cherokee P
        ("Faster than \u0251cme Rival", "alternative_name"),  # Latin alpha
        ("Faster than A\u13dfme Rival", "alternative_name"),  # Cherokee C (#660 re-review)
        ("Faster than Rival\u2060Co", "alternative_name"),  # word joiner
        ("Closes ENG\u2011412", "internal_code"),  # non-breaking hyphen
        ("Closes ENG\u2212412", "internal_code"),  # minus sign
        ("Write to priya\uff20example.com", "email_or_phone"),  # fullwidth at
    ],
)
def test_look_alike_and_invisible_characters_are_still_found(text, code):
    """protects=#640 review: the leak check normalises (NFKC, casefold, format characters
    stripped, look-alike letters and dashes mapped) before matching; fails_when=a name
    spelled with invisible or look-alike characters passes; no_claim=every confusable."""
    findings = leak_check.check(text, _ctx())
    assert code in [f.code for f in findings if f.severity == "blocking"], findings


def test_a_customer_is_found_by_its_distinctive_part():
    """protects=#640 review: a customer label matches by its distinctive parts, like a
    person's surname; fails_when="Northwind" passes; no_claim=generic company words."""
    found = leak_check.check("Built for Northwind first", _ctx())
    assert [f.code for f in found] == ["customer_name"]
    assert found[0].words == ["Northwind"]
    # A generic company word ("Traders", "Inc") is not a name on its own.
    assert leak_check.check("A tool for traders", _ctx()) == []
    assert leak_check.check("For every software team", _ctx(customers=["Acme Software Inc"])) == []


def test_format_characters_are_told():
    assert leak_check.format_characters("Plain text, with a dash - and \u00e9migr\u00e9") == []
    assert leak_check.format_characters("Ja\u200bne\u00ad") == ["U+200B", "U+00AD"]


async def test_a_text_holding_format_characters_is_not_saved(client, ctx):
    """protects=#640 review: a public text, title or intro holding invisible format
    characters is refused (422 format_characters) whatever its state; fails_when=it is
    saved; no_claim=look-alike letters (the check normalises them)."""
    await seed(ctx)
    for over in ({"title": "Import\u200b fast"}, {"description": "Day\u00adone", "state": "draft"}):
        resp = await put_text(client, ctx, "bulk-import", **over)
        assert resp.status_code == 422, resp.text
        assert resp.json()["detail"]["code"] == "format_characters"
    resp = await client.put(PAGE, json={"public_intro": "Our\u2060plans"},
                            headers=ctx.as_("approver"))  # fmt: skip
    assert resp.status_code == 422 and resp.json()["detail"]["code"] == "format_characters"


async def test_a_page_title_and_intro_that_now_leak_are_dropped(client, ctx):
    """protects=#640 review: the public title and intro are re-checked at every render
    like item texts; once one names a new member it is left out of the page and the
    check no longer holds; fails_when=the name stays on the preview or the check stays
    checked; no_claim=the shared page (lane 3)."""
    await seed(ctx)
    await approve_both(client, ctx)
    resp = await client.put(
        PAGE,
        json={"public_title": "What Lumen is building", "public_intro": "Made with Quarry."},
        headers=ctx.as_("approver"),
    )
    assert resp.status_code == 200, resp.text
    assert (await client.post(CHECK, headers=ctx.as_("approver"))).status_code == 201
    text = _text((await client.get(PREVIEW, headers=ctx.as_("approver"))).text)
    assert "What Lumen is building" in text and "Made with Quarry." in text
    async with tenant_session(ctx.tenant_id) as s:
        s.add(User(email="lq@example.com", password_hash="x", role="viewer", name="Lumen Quarry"))
        await s.commit()
    text = _text((await client.get(PREVIEW, headers=ctx.as_("approver"))).text)
    assert "Lumen" not in text and "Quarry" not in text
    assert "Example Labs roadmap" in text
    body = (await client.get(TEXTS, headers=ctx.as_("approver"))).json()
    assert body["check"]["state"] != "checked"
    assert {f["code"] for f in body["page_findings"]} == {"person_name"}
    assert {"item_key": None, "reason": "page_findings"} in body["not_ready"]


# --- #660 re-review: every Default_Ignorable_Code_Point, and emoji sequences -----------

# Invisible characters outside category Cf: marks (U+034F, variation selectors, U+17B4)
# and Hangul fillers (letters).
HIDDEN = ["\u034f", "\ufe0f", "\U000e0100", "\u17b4", "\u3164", "\u115f", "\u1160", "\uffa0"]
# Ordinary emoji: a ZWJ sequence with a skin tone, a tag-sequence flag (Scotland), an
# emoji with its presentation selector and a keycap.
EMOJI = (
    "Built by \U0001f469\U0001f3fd\u200d\U0001f4bb in "
    "\U0001f3f4\U000e0067\U000e0062\U000e0073\U000e0063\U000e0074\U000e007f "
    "with \u2764\ufe0f\u200d\U0001f525 and 1\ufe0f\u20e3"
)


@pytest.mark.parametrize("hidden", HIDDEN, ids=lambda c: f"U+{ord(c):04X}")
def test_every_invisible_character_is_stripped_told_and_found(hidden):
    """protects=#660 re-review: every Default_Ignorable_Code_Point, not only category Cf,
    is stripped before matching, told by format_characters and stripped from a draft;
    fails_when="Nort\\u034fhwind" passes the check or is kept; no_claim=other look-alikes."""
    found = leak_check.check(f"As Nort{hidden}hwind Traders asked", _ctx())
    assert "customer_name" in [f.code for f in leak_check.blocking(found)], found
    found = leak_check.check(f"Built with Quill{hidden}feather", _ctx())
    assert "person_name" in [f.code for f in leak_check.blocking(found)], found
    assert leak_check.format_characters(f"Nort{hidden}hwind") == [f"U+{ord(hidden):04X}"]
    assert leak_check.strip_format(f"Nort{hidden}hwind") == "Northwind"


@pytest.mark.parametrize("hidden", HIDDEN, ids=lambda c: f"U+{ord(c):04X}")
async def test_a_text_holding_any_invisible_character_is_not_saved(client, ctx, hidden):
    """protects=#660 re-review: saving refuses every invisible character (422
    format_characters) in a text and in the page's intro; fails_when=it is saved."""
    await seed(ctx)
    resp = await put_text(client, ctx, "bulk-import", title=f"Import{hidden} fast")
    assert resp.status_code == 422, resp.text
    assert resp.json()["detail"]["characters"] == [f"U+{ord(hidden):04X}"]
    resp = await client.put(PAGE, json={"public_intro": f"Our{hidden}plans"},
                            headers=ctx.as_("approver"))  # fmt: skip
    assert resp.status_code == 422 and resp.json()["detail"]["code"] == "format_characters"


def test_emoji_sequences_are_kept_and_the_names_around_them_checked():
    """protects=#660 re-review minor: a ZWJ, a variation selector or a flag's tags inside
    an ordinary emoji sequence is not refused or stripped, while a name beside the emoji,
    joined inside a word, or spelled in a flag's tags is still caught; fails_when=a ZWJ emoji or
    the Scotland flag is refused, or a name hides in them."""
    assert leak_check.format_characters(EMOJI) == []
    assert leak_check.strip_format(EMOJI) == EMOJI
    assert leak_check.check(EMOJI, _ctx()) == []
    found = leak_check.check("\U0001f469\u200d\U0001f4bbNorthwind", _ctx())
    assert [f.code for f in found] == ["customer_name"]
    # Joiners and selectors between letters are not part of an emoji.
    assert leak_check.format_characters("Nort\u200dhwind") == ["U+200D"]
    assert leak_check.format_characters("Nort\ufe0fhwind") == ["U+FE0F"]
    assert leak_check.format_characters("\u200d\U0001f4bb") == ["U+200D"]
    # Tag letters spelling a name are no flag: refused, and the check reads them.
    tags = "".join(chr(0xE0000 + ord(c)) for c in "quillfeather")
    hidden = f"Built with \U0001f3f4{tags}\U000e007f"
    assert leak_check.format_characters(hidden)
    assert "person_name" in [f.code for f in leak_check.check(hidden, _ctx())]


async def test_a_text_with_emoji_is_saved(client, ctx):
    """protects=#660 re-review minor: a public text holding ordinary emoji is saved;
    fails_when=it is refused as format_characters."""
    await seed(ctx)
    title = "Import fast \U0001f469\u200d\U0001f4bb"
    resp = await put_text(client, ctx, "bulk-import", title=title, description=EMOJI)
    assert resp.status_code == 200, resp.text
    assert resp.json()["description"] == EMOJI


# --- #677 re-review: only real flags, blanks as spaces, and the trash filter -----------


def _flag(tags: str) -> str:
    """A black flag carrying ``tags`` as tag characters, then the cancel tag."""
    return "\U0001f3f4" + "".join(chr(0xE0000 + ord(c)) for c in tags) + "\U000e007f"


SPLIT_NAME = f"Visit {_flag('nort')}{_flag('hwin')}d soon"
SPLIT_PHONE = f"Call {_flag('555012')}{_flag('3456')} today"


def test_only_the_three_subdivision_flags_pass():
    """protects=#677 re-review major: England, Scotland and Wales are the only tag
    sequences kept; any other tag run is refused, and the check reads tag letters as the
    text a decoder sees, so a name or a phone number split across two flags is found;
    fails_when="🏴[nort]🏴[hwin]d" or "🏴[555012]🏴[3456]" is kept or passes the check;
    no_claim=two-letter (regional indicator) flags, which carry no tags."""
    for tags in ("gbeng", "gbsct", "gbwls"):
        text = f"Made in {_flag(tags)} with care"
        assert leak_check.format_characters(text) == [], tags
        assert leak_check.strip_format(text) == text
        assert leak_check.check(text, _ctx()) == []
    for tags in ("usca", "gbabc", "nort", "555012"):
        assert leak_check.format_characters(f"Made in {_flag(tags)}"), tags
    assert leak_check.format_characters(SPLIT_NAME)
    assert leak_check.strip_format(SPLIT_NAME) == "Visit \U0001f3f4\U0001f3f4d soon"
    found = leak_check.check(SPLIT_NAME, _ctx())
    assert "customer_name" in [f.code for f in leak_check.blocking(found)], found
    assert leak_check.format_characters(SPLIT_PHONE)
    found = leak_check.check(SPLIT_PHONE, _ctx())
    assert "email_or_phone" in [f.code for f in leak_check.blocking(found)], found
    # A name right beside a real flag is still read on its own.
    found = leak_check.check(f"Built for Northwind{_flag('gbsct')}", _ctx())
    assert [f.code for f in found] == ["customer_name"]


async def test_a_text_hiding_a_name_or_number_in_flags_is_not_saved(client, ctx):
    """protects=#677 re-review major: saving refuses a tag run that is not one of the
    three flags (422 format_characters); fails_when=the split name or number is saved."""
    await seed(ctx)
    for text in (SPLIT_NAME, SPLIT_PHONE):
        resp = await put_text(client, ctx, "bulk-import", description=text, state="draft")
        assert resp.status_code == 422, resp.text
        assert resp.json()["detail"]["code"] == "format_characters"
    resp = await put_text(client, ctx, "bulk-import", description=f"Made in {_flag('gbwls')}")
    assert resp.status_code == 200, resp.text


@pytest.mark.parametrize("blank", ["⠀", "\U0001d159", "　"], ids=lambda c: f"U+{ord(c):04X}")
def test_blank_characters_read_as_spaces(blank):
    """protects=#677 re-review minor: a character that renders blank but is not
    Default_Ignorable (braille blank, the null notehead, the ideographic space) reads as a
    space, so a phone number or a full name spaced with it is found; fails_when="555⠀012⠀3456"
    passes; no_claim=a word split by a visible gap (the approver sees the gap)."""
    found = leak_check.check(f"Call 555{blank}012{blank}3456", _ctx())
    assert "email_or_phone" in [f.code for f in leak_check.blocking(found)], found
    found = leak_check.check(f"Built with Priya{blank}Quillfeather", _ctx())
    assert PERSON in found[0].words, found


async def test_a_trashed_roadmap_hides_its_public_texts_and_checks(client, ctx):
    """protects=#677 re-review (CI): roadmap_public_texts and roadmap_public_checks hang off
    their roadmap, so the trash filter leaves them out while it is in Trash and restore
    brings them back; fails_when=a trashed roadmap's public text or check is read."""
    await seed(ctx)
    await approve_both(client, ctx)
    assert (await client.post(CHECK, headers=ctx.as_("approver"))).status_code == 201

    async def counts() -> tuple[int, int]:
        async with tenant_session(ctx.tenant_id) as s:
            texts = len((await s.scalars(select(RoadmapPublicText))).all())
            checks = len((await s.scalars(select(RoadmapPublicCheck))).all())
        return texts, checks

    assert await counts() == (2, 1)
    resp = await client.request(
        "DELETE",
        f"/v1/documents/{SLUG}",
        params={"confirm_published": "true"},
        headers=ctx.as_("owner"),
    )
    assert resp.status_code == 200, resp.text
    assert await counts() == (0, 0)
    resp = await client.post(f"/v1/documents/{SLUG}/restore", headers=ctx.as_("owner"))
    assert resp.status_code == 200, resp.text
    assert await counts() == (2, 1)


# --- #691 re-review: names match on their confusable skeleton --------------------------


def test_the_confusables_table_is_vendored_for_pythons_unicode_version():
    """protects=#691 re-review: names match through Unicode's own confusables.txt, pinned
    in the repository with its licence, for the Unicode version Python's unicodedata
    reports; fails_when=the file or its licence is missing, or it is another version."""
    path = leak_check.CONFUSABLES_FILE
    assert path.is_file(), path
    licence = path.parent / "LICENSE.txt"
    assert "UNICODE LICENSE V3" in licence.read_text(encoding="utf-8")
    head = path.read_text(encoding="utf-8")[:1000]
    assert f"# Version: {unicodedata.unidata_version}\n" in head
    assert len(leak_check.SKELETON_MAP) > 6000


@pytest.mark.parametrize(
    ("text", "code"),
    [
        ("As Northwi\u0307nd asked", "customer_name"),  # combining dot above on the i
        ("As NORTHW\u0130ND asked", "customer_name"),  # U+0130, i + dot when lowercased
        ("As Northw\u1ecbnd asked", "customer_name"),  # dot below
        ("As N\u00f6rthwind asked", "customer_name"),  # diaeresis
        ("As Nor\u1e6fhwind asked", "customer_name"),  # macron below
        ("As No\u0308rthwind asked", "customer_name"),  # decomposed diaeresis
        ("Built with Quill\u0336feather", "person_name"),  # a mark inside the name
        ("Built with Quill\u20ddfeather", "person_name"),  # an enclosing mark (Me)
        ("Built with Quill\u0903feather", "person_name"),  # a spacing mark (Mc)
        ("Built with Q\u057dill\u0192eather", "person_name"),  # Armenian u, f with hook
        ("Built with Quillf\u0435\u0430th\u0435r", "person_name"),  # Cyrillic e and a
        ("As N\u03bf\u0433thwind asked", "customer_name"),  # Greek omicron, Cyrillic ghe
        ("Faster than Riv\u03b1l\u0421o", "alternative_name"),  # Greek alpha, Cyrillic Es
        ("See Pr\u00f2ject Bl\u00fceb\u00efrd acquisition", "internal_document"),
        ("Because we s\u00fcnset the l\u00e9gacy importer", "decision"),
    ],
)
def test_combining_marks_and_look_alikes_never_split_or_hide_a_name(text, code):
    """protects=#691 re-review: a name is matched on its confusable skeleton (NFD, every
    combining mark and Default_Ignorable dropped, casefolded, mapped through
    confusables.txt), so a mark on or inside a name, U+0130 and mixed-script look-alikes
    are found; fails_when="Northwi\u0307nd" or "N\u00f6rthwind" passes."""
    findings = leak_check.check(text, _ctx())
    assert code in [f.code for f in leak_check.blocking(findings)], findings


def test_ordinary_accented_words_still_pass():
    """protects=#691 re-review: dropping marks only matters where a name is; ordinary
    words with accents have no finding; fails_when=caf\u00e9 or r\u00e9sum\u00e9 is
    flagged."""
    for text in (
        "A caf\u00e9 for your r\u00e9sum\u00e9, not a na\u00efve one",
        "Cafe\u0301, re\u0301sume\u0301 and nai\u0308ve, decomposed",
        "Fa\u00e7ade, d\u00e9j\u00e0 vu, pi\u00f1ata and \u00fcber-fast import",
        "\u0130stanbul, Malm\u00f6 and Z\u00fcrich teams",
    ):
        assert leak_check.check(text, _ctx()) == [], text


def _look_alikes() -> dict[str, list[str]]:
    """Each ASCII letter's look-alikes from the vendored confusables.txt (by the letter its
    prototype is), read here on its own so the test does not share the code's parser."""
    out: dict[str, list[str]] = {}
    for line in leak_check.CONFUSABLES_FILE.read_text(encoding="utf-8").splitlines():
        fields = [f.strip() for f in line.split("#", 1)[0].split(";")]
        if len(fields) < 3 or " " in fields[0] or " " in fields[1]:
            continue
        source, target = chr(int(fields[0], 16)), chr(int(fields[1], 16))
        if target.isascii() and target.isalpha() and source != target:
            # Capitals stand in for small letters too (Greek Iota, Cyrillic I for "l"):
            # names match on the strict skeleton as well.
            if source.isalpha() and unicodedata.normalize("NFKC", source) == source:
                out.setdefault(target, []).append(source)
    return out


MARKS = [
    chr(c)
    for c in range(0x300, 0x2000)
    if unicodedata.category(chr(c)) in ("Mn", "Mc", "Me") and unicodedata.combining(chr(c))
][:200] + ["\u20dd", "\u20e3", "\u0903", "\u0489"]


def test_seeded_names_with_random_marks_and_look_alikes_are_still_found():
    """protects=#691 re-review (property): every seeded name, with random combining marks
    inserted and random letters swapped for confusables.txt look-alikes, is still found;
    fails_when=any one variant passes the check."""
    import random

    rng = random.Random(691)
    alikes = _look_alikes()
    seeded = [
        ("Quillfeather", "person_name"),
        ("Northwind", "customer_name"),
        ("RivalCo", "alternative_name"),
        ("Lumen Quarry", "person_name"),
    ]
    ctx = _ctx(people=[PERSON, "Lumen Quarry"])
    missed = []
    for name, code in seeded:
        for _ in range(100):
            chars = []
            for ch in name:
                pool = alikes.get(ch, []) + (alikes.get(ch.lower(), []) if ch.isupper() else [])
                if pool and rng.random() < 0.4:
                    ch = rng.choice(pool)
                chars.append(ch)
                if ch != " " and rng.random() < 0.4:
                    chars.append(rng.choice(MARKS))
            variant = "".join(chars)
            text = f"Built for {variant} soon"
            found = leak_check.check(text, ctx)
            if code not in [f.code for f in leak_check.blocking(found)]:
                missed.append(variant)
    assert missed == [], [ascii(m) for m in missed[:10]]


def test_a_phone_number_in_keycap_emoji_is_found():
    """protects=#691 re-review (minor): a phone number written as keycap emoji reads as
    its digits; fails_when="5\ufe0f\u20e3..." passes."""
    keycaps = "".join(f"{d}\ufe0f\u20e3" for d in "4155550134")
    assert leak_check.format_characters(keycaps) == []
    found = leak_check.check(f"Call {keycaps} today", _ctx())
    assert "email_or_phone" in [f.code for f in leak_check.blocking(found)], found


async def test_an_unchanged_page_title_is_not_refused_when_the_intro_changes(client, ctx):
    """protects=#691 re-review (minor): put_public_page refuses only the texts a save
    changes; an unchanged title that now names a new member is still left out at render
    (and reported), but does not block editing the intro; fails_when=the intro edit is
    422 for the old title."""
    await seed(ctx)
    resp = await client.put(
        PAGE, json={"public_title": "What Lumen is building"}, headers=ctx.as_("approver")
    )
    assert resp.status_code == 200, resp.text
    async with tenant_session(ctx.tenant_id) as s:
        s.add(User(email="lq@example.com", password_hash="x", role="viewer", name="Lumen Quarry"))
        await s.commit()
    resp = await client.put(
        PAGE, json={"public_intro": "Plans for the year."}, headers=ctx.as_("approver")
    )
    assert resp.status_code == 200, resp.text
    assert {f["code"] for f in resp.json()["findings"]} == {"person_name"}
    resp = await client.put(
        PAGE, json={"public_title": "What Lumen ships"}, headers=ctx.as_("approver")
    )
    assert resp.status_code == 422 and resp.json()["detail"]["code"] == "leak_blocking"


# --- #695 re-review: names match on the strict Unicode skeleton too --------------------


@pytest.mark.parametrize(
    ("text", "code"),
    [
        ("Built with AIice", "person_name"),
        ("Faster than RivaICo", "alternative_name"),
        ("Built with QuiIIfeather", "person_name"),
        ("Built for Gold PIan users", "pricing"),
        ("Built with AΙice", "person_name"),  # Greek capital Iota
        ("Faster than RivaΙCo", "alternative_name"),
        ("Built with QuiΙΙfeather", "person_name"),
        ("Built for Gold PΙan users", "pricing"),
        ("Built with AІice", "person_name"),  # Cyrillic capital Byelorussian-Ukrainian I
        ("Faster than RivaІCo", "alternative_name"),
        ("Built with QuiІІfeather", "person_name"),
        ("Built for Gold PІan users", "pricing"),
    ],
)
def test_a_capital_i_in_place_of_a_small_l_is_found(text, code):
    """protects=#695 re-review: a name is found on the strict UTS #39 skeleton as well as
    the case-folded one (capital I, Greek Iota and Cyrillic I map to "l" before case is
    folded), so "RivaICo" read in a sans-serif font as "RivalCo" is found;
    fails_when="RivaICo" or "Gold PIan" passes the check."""
    ctx = _ctx(people=[PERSON, "Alice"], pricing=[PLAN, "Gold Plan"])
    findings = leak_check.check(text, ctx)
    assert code in [f.code for f in leak_check.blocking(findings)], findings


def test_ordinary_words_with_a_capital_i_still_pass():
    """protects=#695 re-review: matching on the strict skeleton too raises no finding on
    ordinary words, accented or holding a capital I; fails_when="In", "Inbox", "API" or
    "Istanbul" is flagged."""
    ctx = _ctx(people=[PERSON, "Alice"], pricing=[PLAN, "Gold Plan"])
    for text in (
        "A cafe for your resume, not a naive one",
        "In Istanbul, the Inbox and the API import every account",
        "IMPORT IN ONE GO: INBOX, API AND ISTANBUL",
        "I plan to ship it; Ian and Ida said so",
    ):
        assert leak_check.check(text, ctx) == [], text


def test_the_ogham_space_mark_is_refused_and_does_not_split_a_name():
    """protects=#695 re-review (minor): U+1680, drawn as a line or a blank, is refused when
    saved like an invisible character and never splits a name; fails_when=
    "Quill\\u1680feather" passes the check or is not told."""
    assert leak_check.format_characters("Quill feather") == ["U+1680"]
    found = leak_check.check("Built with Quill feather", _ctx())
    assert "person_name" in [f.code for f in leak_check.blocking(found)], found


def test_long_texts_are_not_kept_in_the_skeleton_cache():
    """protects=#695 re-review (minor): only short strings (names) are cached, so the cache
    cannot hold thousands of 2,000-character texts; fails_when=a long text is cached."""
    long = "word " * 400
    for fn in (leak_check.skeleton, leak_check.strict_skeleton):
        before = fn.cache.cache_info().currsize
        assert fn(long) == fn(long)
        assert fn.cache.cache_info().currsize == before
