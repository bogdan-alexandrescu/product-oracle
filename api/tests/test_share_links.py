"""O5 lane 3: share links with a passcode (spec-O5 §3, Lanes 3; owner answers O5 Q1-Q6,
Q9, Q10, and Q5 changed: every link has a passcode).

Member routes (create, list, extend, move, rotate the passcode, revoke, revoke all, the
view log), the public routes on ``/v1/public/shares/{token}`` (nothing before the right
passcode, a short-lived signed cookie on the link's path, the same body for unknown,
expired, revoked and wrong-passcode), the rate limits and lock-outs, the counts-only view
log, and revocation on a member's disable or demotion and on a trash. Invented data only
("Example Labs").
"""

import re
import uuid
from datetime import UTC, datetime, timedelta

import pytest
from sqlalchemy import func, select, text

from oracle.docs.models import Document
from oracle.models import AuditEvent
from oracle.shares import public as share_public
from oracle.shares import service as share_service
from oracle.shares.models import ShareLink, ShareLinkView
from oracle.tenancy import tenant_session
from tests.baseline_helpers import make_ctx
from tests.coverage_helpers import run_headers
from tests.test_export_audience import OWNER_MARK, REVENUE_MARK, SLUG, _text, seed_roadmap
from tests.test_public_texts import MARKERS, approve_both
from tests.test_public_texts import seed as seed_public

LINKS = f"/v1/documents/{SLUG}/share-links"
PUBLIC = "/v1/public/shares"
ROLES = ["viewer", "commenter", "approver", "owner", "token", "run"]
PASSCODE = "violet-harbour-42"


@pytest.fixture
async def ctx():
    share_public.reset_limits()
    return await make_ctx("Example Labs")


async def _headers(ctx, who: str) -> dict[str, str]:
    if who == "run":
        return await run_headers(ctx, "owner")
    return ctx.as_(who)


async def _publication_id(ctx, number: int = 1) -> str:
    async with tenant_session(ctx.tenant_id) as s:
        row = (
            await s.execute(
                text(
                    "SELECT p.id FROM document_publications p JOIN documents d "
                    "ON d.id = p.document_id WHERE d.slug = :slug AND p.number = :n"
                ),
                {"slug": SLUG, "n": number},
            )
        ).first()
    return str(row[0])


def body(publication_id: str, **over) -> dict:
    return {
        "publication_id": publication_id,
        "audience": "board",
        "label": "Board, October meeting",
        "expires_in": "14d",
        "allow_download": True,
        "passcode": PASSCODE,
        **over,
    }


async def create(client, ctx, who: str = "approver", **over):
    pub = await _publication_id(ctx)
    return await client.post(LINKS, json=body(pub, **over), headers=await _headers(ctx, who))


def token_of(created: dict) -> str:
    return created["url"].rsplit("/s/", 1)[1]


async def unlock(client, token: str, passcode: str = PASSCODE, **headers):
    return await client.post(
        f"{PUBLIC}/{token}/unlock", data={"passcode": passcode}, headers=headers
    )


def cookie_of(resp) -> str:
    raw = resp.headers["set-cookie"]
    return raw.split(";", 1)[0]


async def opened(client, token: str, passcode: str = PASSCODE) -> dict[str, str]:
    resp = await unlock(client, token, passcode)
    assert resp.status_code == 303, resp.text
    return {"Cookie": cookie_of(resp)}


# --- unit ------------------------------------------------------------------------------


def test_tokens_and_passcodes_are_random_and_only_hashes_are_kept():
    """protects=Q5 and the token rule: 32 random bytes, sha256 kept; a generated passcode
    is long enough and only its slow (argon2) hash is kept; fails_when=a raw value or a
    fast hash of a passcode is stored; no_claim=routes."""
    raw, digest = share_service.new_token()
    assert len(raw) >= 43 and digest == share_service.hash_token(raw) and raw not in digest
    passcode = share_service.generate_passcode()
    assert len(passcode.replace("-", "")) >= 12
    assert share_service.generate_passcode() != passcode
    stored = share_service.hash_passcode(passcode)
    assert stored.startswith("$argon2") and passcode not in stored
    assert share_service.verify_passcode(stored, passcode)
    assert not share_service.verify_passcode(stored, passcode + "x")


def test_expiry_choices_are_24h_to_90d_and_14d_is_the_default():
    """protects=Q3: required, 14 days preselected, 90 days at most; fails_when=a longer or
    open-ended choice exists; no_claim=extension."""
    assert share_service.EXPIRY_CHOICES == {
        "24h": timedelta(hours=24),
        "7d": timedelta(days=7),
        "14d": timedelta(days=14),
        "30d": timedelta(days=30),
        "90d": timedelta(days=90),
    }
    assert share_service.DEFAULT_EXPIRY == "14d"


def test_the_browser_key_is_per_link_and_reveals_no_cookie_id():
    """protects=Q4: a distinct-browser count, never an identity; fails_when=the cookie id
    is stored or two links share a key; no_claim=storage."""
    a = share_service.browser_key("a" * 64, "browser-1")
    assert a == share_service.browser_key("a" * 64, "browser-1")
    assert a != share_service.browser_key("b" * 64, "browser-1")
    assert "browser-1" not in a
    assert share_service.browser_family("Mozilla/5.0 (X11) Chrome/120.0 Safari/537.36") == "Chrome"
    assert share_service.browser_family("Mozilla/5.0 (Macintosh) Version/17 Safari/605") == "Safari"
    assert share_service.browser_family("curl/8.0") == "Other"


# --- who may create ---------------------------------------------------------------------


@pytest.mark.parametrize(
    "who,code",
    [("viewer", 403), ("commenter", 403), ("approver", 201), ("owner", 201), ("token", 201),
     ("run", 403)],
)  # fmt: skip
async def test_who_may_create_a_board_link(client, ctx, who, code):
    """protects=Q1 and criterion 6: approvers and owners (and their API tokens) create
    Board, Team and Engineering links; a run token never (a person's act); fails_when=a
    viewer, commenter or run creates one; no_claim=Public links."""
    await seed_roadmap(ctx, publish=True)
    resp = await create(client, ctx, who)
    assert resp.status_code == code, resp.text
    if who == "run":
        assert "person's act" in resp.text


@pytest.mark.parametrize("who", ROLES)
async def test_every_member_route_checks_its_role(client, ctx, who):
    """protects=the role of every new member route, for each kind of caller; fails_when=a
    viewer, commenter or run token lists, extends, rotates or revokes; no_claim=public."""
    await seed_roadmap(ctx, publish=True)
    made = (await create(client, ctx, "owner")).json()
    link_id = made["link"]["id"]
    headers = await _headers(ctx, who)
    allowed = who in ("approver", "owner", "token")
    calls = [
        ("GET", LINKS, None),
        ("GET", f"/v1/share-links/{link_id}/views", None),
        ("PATCH", f"/v1/share-links/{link_id}", {"expires_in": "30d"}),
        ("POST", f"/v1/share-links/{link_id}/passcode", {}),
    ]
    for method, url, payload in calls:
        resp = await client.request(method, url, json=payload, headers=headers)
        # An approver did not create the owner's link: extend and rotate are the
        # creator's or an owner's.
        want = allowed and not (who == "approver" and method != "GET")
        assert (resp.status_code < 300) == want, (method, url, resp.status_code, resp.text)
    resp = await client.post(f"{LINKS}/revoke-all", json={"reason": "x"}, headers=headers)
    assert (resp.status_code == 200) == (who in ("owner", "token")), resp.text
    resp = await client.post(f"/v1/share-links/{link_id}/revoke", json={}, headers=headers)
    assert (resp.status_code < 300) == allowed or resp.status_code == 409, resp.text


async def test_refusals_on_create(client, ctx):
    """protects=criterion 6: unpublished 409 not_published; Public by an approver 403; by
    an owner without a public check 409 no_public_check; over 90 days 422; a short
    passcode 422; an approvers-only document 403; fails_when=any of them makes a link;
    no_claim=the public page."""
    await seed_roadmap(ctx, publish=True)
    resp = await create(client, ctx, "approver", audience="public")
    assert resp.status_code == 403, resp.text
    resp = await create(client, ctx, "owner", audience="public")
    assert resp.status_code == 409 and resp.json()["detail"]["code"] == "no_public_check"
    resp = await create(client, ctx, "owner", expires_in="120d")
    assert resp.status_code == 422, resp.text
    resp = await create(client, ctx, "owner", passcode="short")
    assert resp.status_code == 422, resp.text
    resp = await client.post(
        LINKS, json=body(str(uuid.uuid4())), headers=ctx.as_("owner")
    )
    assert resp.status_code == 409 and resp.json()["detail"]["code"] == "not_published"
    async with tenant_session(ctx.tenant_id) as s:
        doc = await s.scalar(select(Document).where(Document.slug == SLUG))
        doc.visibility = "approvers"
        await s.commit()
    resp = await create(client, ctx, "owner")
    assert resp.status_code == 403, resp.text


async def test_a_prd_cannot_be_shared(client, ctx):
    await seed_roadmap(ctx, publish=True)
    resp = await client.post(
        "/v1/documents/example-labs-prd/share-links",
        json=body(str(uuid.uuid4())),
        headers=ctx.as_("owner"),
    )
    assert resp.status_code == 422, resp.text


# --- the token and the passcode are shown once ----------------------------------------


async def test_the_token_and_passcode_are_shown_once_and_only_hashes_are_stored(client, ctx):
    """protects=criterion 7 and Q5: the creation response holds the URL and the passcode
    once; the database keeps the token's sha256 and the passcode's argon2 hash; no read
    returns either; a generated passcode when none is set; fails_when=a list or read
    returns the token, URL or passcode; no_claim=the page."""
    await seed_roadmap(ctx, publish=True)
    resp = await create(client, ctx, "owner")
    assert resp.status_code == 201, resp.text
    made = resp.json()
    token = token_of(made)
    assert made["passcode"] == PASSCODE and made["passcode_generated"] is False
    assert made["link"]["state"] == "active" and made["link"]["views"] == 0
    expires = datetime.fromisoformat(made["expires_at"])
    assert timedelta(days=13, hours=23) < expires - datetime.now(UTC) <= timedelta(days=14)
    generated = (await create(client, ctx, "owner", passcode=None)).json()
    assert generated["passcode_generated"] is True and len(generated["passcode"]) >= 12
    listed = await client.get(LINKS, headers=ctx.as_("owner"))
    assert listed.status_code == 200
    raw = listed.text
    for secret in (token, PASSCODE, generated["passcode"], "/s/"):
        assert secret not in raw
    rows = listed.json()
    assert {r["label"] for r in rows} == {"Board, October meeting"}
    assert rows[0]["created_by_name"] and rows[0]["version_number"] == 1
    async with tenant_session(ctx.tenant_id) as s:
        link = await s.get(ShareLink, uuid.UUID(made["link"]["id"]))
        assert link.token_hash == share_service.hash_token(token)
        assert link.passcode_hash.startswith("$argon2")
        audits = list(
            await s.scalars(select(AuditEvent).where(AuditEvent.action == "share_link.created"))
        )
    assert len(audits) == 2
    assert all(token not in str(a.data) and PASSCODE not in str(a.data) for a in audits)


# --- the public routes -----------------------------------------------------------------


async def test_nothing_is_served_before_the_right_passcode(client, ctx):
    """protects=Q5: the page, PDF and status serve nothing about the link before the
    passcode; unknown, expired, revoked and wrong-passcode answer the same; fails_when=a
    response before the passcode names the company, the roadmap or tells a real link from
    a guess; no_claim=lock-out."""
    await seed_roadmap(ctx, publish=True)
    made = (await create(client, ctx, "owner")).json()
    token = token_of(made)
    unknown = "x" * 43
    locked = await client.get(f"{PUBLIC}/{token}")
    guess = await client.get(f"{PUBLIC}/{unknown}")
    assert locked.status_code == guess.status_code == 401
    assert locked.text == guess.text
    assert "passcode" in locked.text.lower()
    for word in ("Example Labs", SLUG, "Board", "October"):
        assert word not in locked.text
    for path in ("/pdf", "/status"):
        a = await client.get(f"{PUBLIC}/{token}{path}")
        b = await client.get(f"{PUBLIC}/{unknown}{path}")
        assert (a.status_code, a.text) == (b.status_code, b.text), path
    wrong = await unlock(client, token, "not-the-passcode")
    nobody = await unlock(client, unknown, PASSCODE)
    assert wrong.status_code == nobody.status_code == 404
    assert wrong.text == nobody.text and "set-cookie" not in wrong.headers
    for page in (locked, wrong):
        assert page.headers["cache-control"] == "no-store"
        assert page.headers["x-robots-tag"] == "noindex, nofollow"


async def test_the_right_passcode_opens_the_page_with_a_cookie_on_the_links_path(client, ctx):
    """protects=Q5 and criterion 8: the passcode sets a short-lived, signed, HttpOnly,
    Secure, SameSite=Strict cookie scoped to the link's path; the page then serves the
    Board render with the page headers and nothing internal it hides; fails_when=the
    cookie is long-lived, unscoped, or the page holds an owner or revenue marker or a
    citation marker; no_claim=the web /s page (lane 5)."""
    await seed_roadmap(ctx, publish=True)
    token = token_of((await create(client, ctx, "owner")).json())
    resp = await unlock(client, token)
    assert resp.status_code == 303
    assert resp.headers["location"] == f"{PUBLIC}/{token}"
    raw = resp.headers["set-cookie"]
    assert raw.startswith(f"{share_public.COOKIE}=")
    for part in ("HttpOnly", "Secure", "SameSite=strict", f"Path={PUBLIC}/{token}"):
        assert part.lower() in raw.lower(), raw
    age = int(re.search(r"Max-Age=(\d+)", raw).group(1))
    assert 0 < age <= share_public.COOKIE_SECONDS <= 12 * 3600
    page = await client.get(f"{PUBLIC}/{token}", headers={"Cookie": cookie_of(resp)})
    assert page.status_code == 200, page.text
    assert page.headers["content-security-policy"].startswith("default-src 'none'")
    assert page.headers["referrer-policy"] == "no-referrer"
    assert page.headers["cache-control"] == "no-store"
    assert page.headers["x-robots-tag"] == "noindex, nofollow"
    body_text = _text(page.text)
    assert "Bulk import" in body_text
    assert OWNER_MARK not in page.text and REVENUE_MARK not in page.text
    assert "[c:" not in page.text and "<script" not in page.text.lower()
    assert "<!--" not in page.text
    assert "expires" in body_text.lower()
    status = await client.get(f"{PUBLIC}/{token}/status", headers={"Cookie": cookie_of(resp)})
    assert status.json() == {"state": "active"}
    # Another link's cookie opens nothing here.
    other = token_of((await create(client, ctx, "owner", passcode="other-passcode-9")).json())
    resp = await client.get(f"{PUBLIC}/{other}", headers={"Cookie": cookie_of(resp)})
    assert resp.status_code == 401


async def test_rotating_the_passcode_keeps_the_link_and_ends_open_cookies(client, ctx):
    """protects=Q5: a rotation returns the new passcode once, keeps the token, and every
    cookie issued before it stops working; fails_when=an old cookie or the old passcode
    still opens; no_claim=lock-out."""
    await seed_roadmap(ctx, publish=True)
    made = (await create(client, ctx, "owner")).json()
    token = token_of(made)
    cookie = await opened(client, token)
    resp = await client.post(
        f"/v1/share-links/{made['link']['id']}/passcode", json={}, headers=ctx.as_("owner")
    )
    assert resp.status_code == 200, resp.text
    new = resp.json()["passcode"]
    assert new and new != PASSCODE
    assert (await client.get(f"{PUBLIC}/{token}", headers=cookie)).status_code == 401
    assert (await unlock(client, token, PASSCODE)).status_code == 404
    assert (await client.get(f"{PUBLIC}/{token}", headers=await opened(client, token, new))
            ).status_code == 200  # fmt: skip


async def test_guessing_is_locked_out_per_link_and_per_client(client, ctx):
    """protects=Q5: wrong passcodes lock the link for a while (even the right one is then
    refused) and a client that guesses across links is refused; fails_when=guessing goes
    on unbounded; no_claim=the time a lock lasts."""
    await seed_roadmap(ctx, publish=True)
    token = token_of((await create(client, ctx, "owner")).json())
    for _ in range(share_public.PASSCODE_TRIES):
        assert (await unlock(client, token, "wrong-guess-000")).status_code == 404
    resp = await unlock(client, token, PASSCODE)
    assert resp.status_code == 429 and int(resp.headers["retry-after"]) > 0
    async with tenant_session(ctx.tenant_id) as s:
        refused = await s.scalar(
            select(func.count()).select_from(AuditEvent).where(
                AuditEvent.action == "share_link.passcode_locked"
            )
        )
    assert refused >= 1
    share_public.reset_limits()
    for i in range(share_public.CLIENT_PASSCODE_TRIES):
        await unlock(client, f"guess{i:040d}", "wrong-guess-000")
    resp = await unlock(client, "y" * 43, "wrong-guess-000")
    assert resp.status_code == 429


async def test_unknown_expired_and_revoked_answer_the_same_before_the_passcode(client, ctx):
    """protects=criterion 9 with Q5: an ended link and a guess are told apart by nobody
    who lacks the passcode; a holder of an open cookie sees "This link has ended" (410);
    after revoke the very next request is refused; fails_when=a revoked link still serves
    or a wrong passcode on an ended link differs from a guess; no_claim=the web page."""
    await seed_roadmap(ctx, publish=True)
    made = (await create(client, ctx, "owner")).json()
    token = token_of(made)
    cookie = await opened(client, token)
    assert (await client.get(f"{PUBLIC}/{token}", headers=cookie)).status_code == 200
    resp = await client.post(
        f"/v1/share-links/{made['link']['id']}/revoke", json={"reason": "sent to the wrong list"},
        headers=ctx.as_("owner"),
    )  # fmt: skip
    assert resp.status_code == 200 and resp.json()["state"] == "revoked"
    ended = await client.get(f"{PUBLIC}/{token}", headers=cookie)
    assert ended.status_code == 410
    assert "This link has ended. Ask the person who sent it for a new one." in ended.text
    assert "Example Labs" not in ended.text
    status = await client.get(f"{PUBLIC}/{token}/status", headers=cookie)
    assert status.json() == {"state": "ended"}
    guess = await unlock(client, "z" * 43, PASSCODE)
    right_on_revoked = await unlock(client, token, PASSCODE)
    assert (right_on_revoked.status_code, right_on_revoked.text) == (guess.status_code, guess.text)
    # Expired: the same as revoked for a cookie holder, the same as a guess for others.
    made = (await create(client, ctx, "owner")).json()
    token = token_of(made)
    cookie = await opened(client, token)
    async with tenant_session(ctx.tenant_id) as s:
        link = await s.get(ShareLink, uuid.UUID(made["link"]["id"]))
        link.expires_at = datetime.now(UTC) - timedelta(minutes=1)
        await s.commit()
    assert (await client.get(f"{PUBLIC}/{token}", headers=cookie)).status_code == 410
    resp = await unlock(client, token, PASSCODE)
    assert (resp.status_code, resp.text) == (guess.status_code, guess.text)
    rows = (await client.get(LINKS, headers=ctx.as_("owner"))).json()
    assert {r["state"] for r in rows} == {"revoked", "expired"}


async def test_the_page_rate_limit_and_capped_refusal_audits(client, ctx):
    """protects=criterion 10: the 61st page request in a minute on one link is 429 with
    Retry-After; refused requests write at most 20 audit rows a minute per link;
    fails_when=a link serves unbounded or a flood fills the audit log; no_claim=across
    API instances (held in memory per instance)."""
    await seed_roadmap(ctx, publish=True)
    made = (await create(client, ctx, "owner")).json()
    token = token_of(made)
    cookie = await opened(client, token)
    for _ in range(share_public.PAGES_PER_MINUTE):
        assert (await client.get(f"{PUBLIC}/{token}", headers=cookie)).status_code == 200
    for _ in range(25):
        resp = await client.get(f"{PUBLIC}/{token}", headers=cookie)
        assert resp.status_code == 429 and int(resp.headers["retry-after"]) > 0
    async with tenant_session(ctx.tenant_id) as s:
        refused = await s.scalar(
            select(func.count()).select_from(AuditEvent).where(
                AuditEvent.action == "share_link.refused"
            )
        )
    assert refused == share_public.REFUSED_AUDITS == 20


async def test_the_pdf_follows_allow_download(client, ctx, monkeypatch):
    """protects=Q9: the PDF is served with the passcode's cookie when the link allows it
    (10 an hour), and is 404 when it does not; fails_when=a no-download link serves a PDF;
    no_claim=the PDF's look."""
    from oracle.shares import render as share_render

    monkeypatch.setattr(share_render, "html_to_pdf", lambda html: b"%PDF-1.7 " + html[:40].encode())
    await seed_roadmap(ctx, publish=True)
    token = token_of((await create(client, ctx, "owner")).json())
    cookie = await opened(client, token)
    resp = await client.get(f"{PUBLIC}/{token}/pdf", headers=cookie)
    assert resp.status_code == 200, resp.text
    assert resp.headers["content-type"] == "application/pdf"
    assert resp.headers["cache-control"] == "no-store"
    for _ in range(share_public.DOWNLOADS_PER_HOUR - 1):
        assert (await client.get(f"{PUBLIC}/{token}/pdf", headers=cookie)).status_code == 200
    assert (await client.get(f"{PUBLIC}/{token}/pdf", headers=cookie)).status_code == 429
    token = token_of((await create(client, ctx, "owner", allow_download=False)).json())
    cookie = await opened(client, token)
    assert (await client.get(f"{PUBLIC}/{token}/pdf", headers=cookie)).status_code == 404


async def test_the_view_log_counts_browsers_never_people(client, ctx):
    """protects=criterion 12 and Q4: each page view writes one row with a browser key and
    family and no address; two views from one browser count once; the first view is
    audited; fails_when=an IP, a user agent string or an identity is stored, or one
    browser counts twice; no_claim=country (only when the load balancer gives one)."""
    await seed_roadmap(ctx, publish=True)
    made = (await create(client, ctx, "owner")).json()
    token, link_id = token_of(made), made["link"]["id"]
    ua = {"User-Agent": "Mozilla/5.0 (X11; Linux) Chrome/120.0 Safari/537.36",
          "X-Client-Region": "DE", "X-Forwarded-For": "203.0.113.7"}  # fmt: skip
    first = await opened(client, token)
    second = await opened(client, token)
    for cookie in (first, first, second):
        assert (await client.get(f"{PUBLIC}/{token}", headers={**cookie, **ua})).status_code == 200
    resp = await client.get(f"/v1/share-links/{link_id}/views", headers=ctx.as_("approver"))
    assert resp.status_code == 200, resp.text
    log = resp.json()
    assert log["views"] == 3 and log["distinct_browsers"] == 2
    assert {v["kind"] for v in log["entries"]} == {"page"}
    assert {v["browser_family"] for v in log["entries"]} == {"Chrome"}
    assert {v["country"] for v in log["entries"]} == {"DE"}
    assert sum(d["views"] for d in log["days"]) == 3
    assert "203.0.113.7" not in resp.text
    async with tenant_session(ctx.tenant_id) as s:
        rows = list(await s.scalars(select(ShareLinkView)))
        columns = set(ShareLinkView.__table__.columns.keys())
        firsts = await s.scalar(
            select(func.count()).select_from(AuditEvent).where(
                AuditEvent.action == "share_link.viewed_first"
            )
        )
        link = await s.get(ShareLink, uuid.UUID(link_id))
    assert len(rows) == 3 and firsts == 1 and link.views == 3
    assert not columns & {"ip", "address", "user_agent", "user_id", "email"}
    assert all("203.0.113.7" not in str(r.__dict__) for r in rows)
    listed = (await client.get(LINKS, headers=ctx.as_("owner"))).json()
    assert listed[0]["views"] == 3 and listed[0]["distinct_browsers"] == 2


async def test_extend_and_move_keep_the_token(client, ctx):
    """protects=Q3 and Q6: extending is up to 90 days from now, audited; moving to a
    newer publication keeps the token; fails_when=an extension past 90 days or a move to
    another document's publication passes; no_claim=the web row."""
    await seed_roadmap(ctx, publish=True)
    made = (await create(client, ctx, "approver")).json()
    link_id = made["link"]["id"]
    resp = await client.patch(
        f"/v1/share-links/{link_id}", json={"expires_in": "90d"}, headers=ctx.as_("approver")
    )
    assert resp.status_code == 200, resp.text
    assert resp.json()["expires_at"] > made["expires_at"]
    resp = await client.patch(
        f"/v1/share-links/{link_id}", json={"expires_in": "365d"}, headers=ctx.as_("approver")
    )
    assert resp.status_code == 422
    resp = await client.patch(
        f"/v1/share-links/{link_id}", json={"publication_id": str(uuid.uuid4())},
        headers=ctx.as_("owner"),
    )  # fmt: skip
    assert resp.status_code == 404
    async with tenant_session(ctx.tenant_id) as s:
        actions = set(await s.scalars(select(AuditEvent.action)))
    assert "share_link.extended" in actions


# --- the Public audience ---------------------------------------------------------------


async def test_a_public_link_needs_the_check_and_shows_only_the_public_page(client, ctx):
    """protects=criteria 4-6 and 13 on a link: an owner makes a Public link once the
    publication is checked; its page is the Public version with none of the internal
    markers; a later edit shows "This page is being updated"; fails_when=an internal
    marker reaches the page or a lapsed check still serves it; no_claim=the web page."""
    await seed_public(ctx)
    await approve_both(client, ctx)
    resp = await client.post(
        f"/v1/roadmaps/{SLUG}/publications/1/public-check", headers=ctx.as_("approver")
    )
    assert resp.status_code == 201, resp.text
    resp = await create(client, ctx, "owner", audience="public", label="Customers, launch")
    assert resp.status_code == 201, resp.text
    token = token_of(resp.json())
    cookie = await opened(client, token)
    page = await client.get(f"{PUBLIC}/{token}", headers=cookie)
    assert page.status_code == 200, page.text
    assert "Import your accounts in one go" in page.text
    for marker in MARKERS:
        assert marker not in page.text, marker
    assert "expires" in page.text
    resp = await client.put(
        f"/v1/roadmaps/{SLUG}/public-texts/csv-parser",
        json={"title": "Every spreadsheet column, understood", "description": "Changed.",
              "stage": "planned", "state": "approved", "checked_warnings": []},
        headers=ctx.as_("approver"),
    )  # fmt: skip
    assert resp.status_code == 200, resp.text
    page = await client.get(f"{PUBLIC}/{token}", headers=cookie)
    assert page.status_code == 200
    assert "This page is being updated" in page.text
    assert "Import your accounts in one go" not in page.text


async def test_render_share_never_calls_a_principal_scoped_loader(client, ctx, monkeypatch):
    """protects=criterion 16: the share render reads through its own ShareContext, never a
    member's document loaders; fails_when=the page calls them; no_claim=other routes."""
    from oracle.docs import service as docs_service

    await seed_roadmap(ctx, publish=True)
    token = token_of((await create(client, ctx, "owner")).json())
    cookie = await opened(client, token)

    def boom(*a, **k):
        raise AssertionError("render_share reached a principal-scoped loader")

    for name in ("get_document_or_404", "find_document", "read_document"):
        monkeypatch.setattr(docs_service, name, boom)
    assert (await client.get(f"{PUBLIC}/{token}", headers=cookie)).status_code == 200


# --- revocation on people leaving and document changes ----------------------------------


async def test_disabling_the_creator_revokes_their_links_for_the_owners_inbox(client, ctx):
    """protects=criterion 11 and Q10: a disable revokes the links the member created
    (reason "creator removed") and the owners' Inbox lists them with Re-share; a
    demotion below approver revokes them too ("creator's role changed"); Dismiss clears
    the row; fails_when=a removed member's link keeps working or the row is missing;
    no_claim=the web Inbox (lane 5)."""
    await seed_roadmap(ctx, publish=True)
    first = (await create(client, ctx, "approver")).json()
    await create(client, ctx, "approver", label="Board, November meeting")
    kept = (await create(client, ctx, "owner", label="Team weekly")).json()
    cookie = await opened(client, token_of(first))
    resp = await client.post(
        f"/v1/members/{ctx.users['approver'].id}/disable",
        headers={**ctx.as_("owner"), "Origin": "http://test"},
    )
    assert resp.status_code == 200, resp.text
    rows = {r["label"]: r for r in (await client.get(LINKS, headers=ctx.as_("owner"))).json()}
    assert rows["Board, October meeting"]["state"] == "revoked"
    assert rows["Board, October meeting"]["revoked_reason"] == "creator removed"
    assert rows["Board, November meeting"]["state"] == "revoked"
    assert rows["Team weekly"]["state"] == "active"
    assert (await client.get(f"{PUBLIC}/{token_of(first)}", headers=cookie)).status_code == 410
    inbox = (await client.get("/v1/inbox", headers=ctx.as_("owner"))).json()
    row = inbox["share_revocations"][0]
    assert row["reason"] == "creator removed" and len(row["links"]) == 2
    assert row["title"].endswith("· 2 links") and row["links"][0]["document"] == SLUG
    assert row["links"][0]["audience"] == "board"
    assert (await client.get("/v1/inbox", headers=ctx.as_("viewer"))).json()[
        "share_revocations"
    ] == []
    resp = await client.post(
        "/v1/share-links/dismiss", json={"ids": [x["id"] for x in row["links"]]},
        headers=ctx.as_("owner"),
    )  # fmt: skip
    assert resp.status_code == 200, resp.text
    assert (await client.get("/v1/inbox", headers=ctx.as_("owner"))).json()[
        "share_revocations"
    ] == []
    assert kept["link"]["state"] == "active"


async def test_a_demotion_below_approver_revokes_the_creators_links(client, ctx):
    await seed_roadmap(ctx, publish=True)
    await create(client, ctx, "approver")
    resp = await client.patch(
        f"/v1/members/{ctx.users['approver'].id}", json={"role": "commenter"},
        headers=ctx.as_("owner"),
    )  # fmt: skip
    assert resp.status_code == 200, resp.text
    rows = (await client.get(LINKS, headers=ctx.as_("owner"))).json()
    assert rows[0]["state"] == "revoked"
    assert rows[0]["revoked_reason"] == "creator's role changed"
    inbox = (await client.get("/v1/inbox", headers=ctx.as_("owner"))).json()
    assert inbox["share_revocations"][0]["reason"] == "creator's role changed"


async def test_trashing_the_document_revokes_every_link_and_restore_does_not(client, ctx):
    """protects=criterion 11: a trash revokes every link on the document; a restore
    brings none back; fails_when=a trashed roadmap's link still serves; no_claim=purge."""
    await seed_roadmap(ctx, publish=True)
    token = token_of((await create(client, ctx, "owner")).json())
    await create(client, ctx, "approver", label="Team weekly")
    cookie = await opened(client, token)
    origin = {**ctx.as_("owner"), "Origin": "http://test"}
    resp = await client.request(
        "DELETE", f"/v1/documents/{SLUG}", headers=origin, params={"confirm_published": True}
    )
    assert resp.status_code == 200, resp.text
    assert (await client.get(f"{PUBLIC}/{token}", headers=cookie)).status_code == 410
    resp = await client.post(f"/v1/documents/{SLUG}/restore", headers=origin)
    assert resp.status_code == 200, resp.text
    rows = (await client.get(LINKS, headers=ctx.as_("owner"))).json()
    assert {r["state"] for r in rows} == {"revoked"}
    assert {r["revoked_reason"] for r in rows} == {"document moved to Trash"}


async def test_revoke_all_is_owners_only_and_counts(client, ctx):
    await seed_roadmap(ctx, publish=True)
    await create(client, ctx, "owner")
    await create(client, ctx, "approver", label="Team weekly")
    resp = await client.post(f"{LINKS}/revoke-all", json={"reason": "x"}, headers=ctx.as_("approver"))
    assert resp.status_code == 403
    resp = await client.post(f"{LINKS}/revoke-all", json={"reason": "plan changed"},
                             headers=ctx.as_("owner"))  # fmt: skip
    assert resp.status_code == 200 and resp.json() == {"revoked": 2}


# --- MCP ---------------------------------------------------------------------------------


def test_the_public_routes_are_never_mcp_tools_and_members_routes_are():
    """protects=spec-O5 §3 MCP: the three public routes are PUBLIC_OPERATIONS; the
    members' share routes are generated tools; fails_when=a link holder's route becomes a
    tool; no_claim=the tools' behaviour."""
    from oracle.main import app
    from oracle.mcp import tools

    assert set(share_public.OPERATIONS) <= tools.PUBLIC_OPERATIONS
    names = {t.operation_id for t in tools.operations_from_openapi(app.openapi())}
    assert not names & set(share_public.OPERATIONS)
    assert {"create_share_link", "revoke_share_link", "list_share_links"} <= names
