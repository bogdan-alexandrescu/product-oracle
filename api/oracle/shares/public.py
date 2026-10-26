"""A link holder's routes: ``/v1/public/shares/{token}`` (spec-O5 §3, owner answer O5-Q5).

No member credential, and never MCP tools (``oracle.mcp.tools.PUBLIC_OPERATIONS``).

1. **Nothing before the passcode.** Without a cookie that opens this link, the page is
   the passcode form (401), the same for every token, known or not; the PDF is 404 and
   the status ``locked``, the same for every token. A wrong passcode, an unknown token,
   and an expired or revoked link all answer the passcode with the same 404 body: telling
   them apart would help a guesser. argon2 compares in constant time, and a token that
   matches no link is verified against a dummy hash, so it takes as long.
2. **The cookie.** The right passcode on a live link sets ``po_share``: signed, HttpOnly,
   Secure, SameSite=Strict, on this link's path only, for :data:`COOKIE_SECONDS` at most
   (never past the link's expiry). It names the link and its ``passcode_version``, so a
   rotation ends every cookie signed before it; its random browser id is what the view
   log counts (HMAC'd with the link's secret, never stored as is).
3. **Ended.** A holder of an open cookie sees "This link has ended" (410) once the link
   is revoked or expired; the next request after a revoke is refused (no cache).
4. **Limits.** Per link: :data:`PAGES_PER_MINUTE` pages a minute (in memory per API
   instance) and :data:`DOWNLOADS_PER_HOUR` PDFs an hour (from the view log), 429 with
   ``Retry-After``. Per client address: :data:`CLIENT_PER_MINUTE` requests a minute across
   these routes, held in memory and never stored. Guessing: :data:`PASSCODE_TRIES` wrong
   passcodes in :data:`LOCK_SECONDS` lock the link for as long (on its row, so across
   instances); :data:`CLIENT_PASSCODE_TRIES` wrong ones from one client address lock that
   client out of every link (in memory). Each try is counted, under the row's lock and
   in the client's window, *before* the slow passcode check and taken back when right, so
   a burst of parallel guesses meets the same limits. Anyone with the address can keep a
   link locked by guessing once a window (accepted with the lock-out, O5-Q5). The
   in-memory windows drop an address or link once its window is empty.
5. **Audit.** Refused requests on a known link at most :data:`REFUSED_AUDITS` a minute
   (counted on its row); the first view and every lock-out, with the link id and never
   the token. Each view goes into ``share_link_views``, not the audit log.
"""

import asyncio
import hmac
import secrets
import time
import uuid
from collections import defaultdict, deque
from datetime import timedelta
from typing import Any

from fastapi import APIRouter, Request, Response
from fastapi.responses import JSONResponse, RedirectResponse
from itsdangerous import BadSignature, URLSafeTimedSerializer
from sqlalchemy import func, select

from oracle import audit
from oracle.config import get_settings
from oracle.roadmap.public import PAGE_HEADERS
from oracle.shares import render, service
from oracle.shares.models import ShareLink, ShareLinkView
from oracle.tenancy import tenant_session, unscoped_session
from oracle.trash.filter import INCLUDE_TRASHED

router = APIRouter(prefix="/v1/public/shares", tags=["shares"])

#: A link holder's routes; never MCP tools (oracle.mcp.tools).
OPERATIONS = ("public_share", "unlock_public_share", "public_share_pdf", "public_share_status")
COOKIE = "po_share"
COOKIE_SECONDS = 8 * 3600
ACTOR = "link_holder"
PAGES_PER_MINUTE = 60
DOWNLOADS_PER_HOUR = 10
CLIENT_PER_MINUTE = 120
PASSCODE_TRIES = 5
CLIENT_PASSCODE_TRIES = 20
LOCK_SECONDS = 15 * 60
REFUSED_AUDITS = 20
REFUSAL_WINDOW_SECONDS = 60
TOKEN_MAX = 128
PASSCODE_FORM_MAX = 256

NOT_FOUND: dict[str, Any] = {"reason": "not_found"}
FORM_TITLE = "Enter the passcode"
_FORM = (
    "<h1>Enter the passcode</h1>"
    "<p>This page is private. Enter the passcode the person who sent you this link gave "
    "you.</p>{note}"
    '<form method="post"><label for="passcode">Passcode</label><br>'
    '<input id="passcode" name="passcode" type="password" autocomplete="off" required '
    'maxlength="128" autofocus> <button type="submit">Open</button></form>'
)
LOCKED_PAGE = render.page(FORM_TITLE, _FORM.format(note=""))
WRONG_PAGE = render.page(
    FORM_TITLE,
    _FORM.format(note="<p><strong>That passcode did not open a link.</strong> Check it and "
                 "the address, or ask the person who sent it.</p>"),
)  # fmt: skip

# In memory per API instance, never stored: (client address) and (link id) windows.
_client_hits: dict[str, deque[float]] = defaultdict(deque)
_client_misses: dict[str, deque[float]] = defaultdict(deque)
_link_pages: dict[uuid.UUID, deque[float]] = defaultdict(deque)
_swept = [0.0]
SWEEP_SECONDS = 60


def reset_limits() -> None:
    """Tests: a clean slate for the in-memory windows and the render cache."""
    _client_hits.clear()
    _client_misses.clear()
    _link_pages.clear()
    _swept[0] = 0.0
    render.clear_cache()


def _window(store: dict, key: Any, seconds: float) -> deque[float]:
    hits = store[key]
    cutoff = time.monotonic() - seconds
    while hits and hits[0] <= cutoff:
        hits.popleft()
    return hits


def _sweep() -> None:
    """Drop the keys whose window has emptied (at most once a minute), so the tables
    hold only the addresses and links seen lately."""
    at = time.monotonic()
    if at - _swept[0] < SWEEP_SECONDS:
        return
    _swept[0] = at
    for store, seconds in ((_client_hits, 60), (_client_misses, LOCK_SECONDS),
                           (_link_pages, 60)):  # fmt: skip
        for key in [k for k, hits in store.items() if not hits or hits[-1] <= at - seconds]:
            del store[key]


def _drop(hits: deque[float], mark: float) -> None:
    try:
        hits.remove(mark)
    except ValueError:
        pass


def _retry_after(hits: deque[float], seconds: float) -> int:
    return max(1, int(hits[0] + seconds - time.monotonic()) + 1) if hits else 1


def _client(request: Request) -> str:
    from oracle.mcp.egress import client_address

    return client_address(request) or "unknown"


def _serializer() -> URLSafeTimedSerializer:
    return URLSafeTimedSerializer(get_settings().secret_key, salt="oracle-share-link")


def _html(content: str, status: int, **headers: str) -> Response:
    return Response(
        content, status_code=status, media_type="text/html; charset=utf-8",
        headers={**PAGE_HEADERS, **headers},
    )  # fmt: skip


def _json(body: dict, status: int, **headers: str) -> JSONResponse:
    return JSONResponse(body, status_code=status, headers={**PAGE_HEADERS, **headers})


def _too_many(retry: int, html: bool = False) -> Response:
    if html:
        return _html(render.page("Too many requests", "<p>Too many requests. Try again in a "
                                 "moment.</p>"), 429, **{"Retry-After": str(retry)})  # fmt: skip
    return _json({"detail": "Too many requests"}, 429, **{"Retry-After": str(retry)})


async def _locate(token: str) -> ShareLink | None:
    """The token's link (an unscoped lookup by hash, before the company is known)."""
    if not token or len(token) > TOKEN_MAX:
        return None
    async with unscoped_session() as s:
        link = await s.scalar(
            select(ShareLink)
            .where(ShareLink.token_hash == service.hash_token(token))
            .execution_options(**{INCLUDE_TRASHED: True})
        )
        if link is not None:
            s.expunge(link)
        return link


def _cookie(request: Request, link: ShareLink | None) -> dict | None:
    """The cookie's claims when it opens ``link`` now, else None."""
    raw = request.cookies.get(COOKIE)
    if link is None or not raw:
        return None
    try:
        claims = _serializer().loads(raw, max_age=COOKIE_SECONDS)
    except BadSignature:
        return None
    if not isinstance(claims, dict):
        return None
    if not hmac.compare_digest(str(claims.get("l", "")), str(link.id)):
        return None
    if claims.get("v") != link.passcode_version or not isinstance(claims.get("b"), str):
        return None
    return claims


def _client_allowed(request: Request) -> Response | None:
    _sweep()
    key = _client(request)
    hits = _window(_client_hits, key, 60)
    if len(hits) >= CLIENT_PER_MINUTE:
        return _too_many(_retry_after(hits, 60))
    hits.append(time.monotonic())
    return None


async def _audit_refusal(db, row: ShareLink, reason: str) -> None:
    """Audit a refusal while this minute's count on the row is under the cap."""
    at = service.now()
    start = row.refused_window_start
    if start is None or at - start >= timedelta(seconds=REFUSAL_WINDOW_SECONDS):
        row.refused_window_start, row.refused_in_window = at, 0
    if row.refused_in_window < REFUSED_AUDITS:
        row.refused_in_window += 1
        await audit.record(db, ACTOR, "share_link.refused", "share_link", row.id,
                           {"reason": reason})  # fmt: skip


async def _refused(link: ShareLink, reason: str, response: Response) -> Response:
    """``response``, audited while this minute's count on the link's row is under
    :data:`REFUSED_AUDITS`."""
    async with tenant_session(link.tenant_id) as db:
        row = await db.get(ShareLink, link.id, with_for_update=True)
        if row is not None:
            await _audit_refusal(db, row, reason)
        await db.commit()
    return response


async def _record_view(link: ShareLink, request: Request, claims: dict, kind: str) -> None:
    country = (request.headers.get("x-client-region") or "").strip().upper()
    async with tenant_session(link.tenant_id) as db:
        row = await db.get(ShareLink, link.id, with_for_update=True)
        if row is None:
            return
        db.add(
            ShareLinkView(
                share_link_id=row.id,
                kind=kind,
                browser_key=service.browser_key(row.token_hash, claims["b"]),
                browser_family=service.browser_family(request.headers.get("user-agent")),
                country=country if len(country) == 2 and country.isalpha() else None,
                viewed_at=service.now(),
            )
        )
        if row.views == 0:
            await audit.record(db, ACTOR, "share_link.viewed_first", "share_link", row.id)
        row.views += 1
        row.last_viewed_at = service.now()
        await db.commit()


async def _opened(token: str, request: Request) -> tuple[ShareLink | None, dict | None]:
    link = await _locate(token)
    return link, _cookie(request, link)


def _context(link: ShareLink) -> render.ShareContext:
    return render.ShareContext(
        tenant_id=link.tenant_id,
        link_id=link.id,
        publication_id=link.publication_id,
        audience=link.audience,
        shared_at=link.created_at,
        expires_at=link.expires_at,
    )


REFUSALS: dict[int | str, dict[str, Any]] = {
    401: {"description": "No cookie that opens this link: the passcode form (any token)"},
    410: {"description": "This link has ended (revoked or expired), for a cookie holder"},
    429: {"description": "Too many requests (Retry-After)"},
    503: {"description": "Try again in a moment (the export pool is busy)"},
}


@router.get(
    "/{token}",
    response_class=Response,
    responses={200: {"content": {"text/html": {}}}, **REFUSALS},
    name="public_share",
)
async def public_share(token: str, request: Request) -> Response:
    """The shared page, once the passcode opened it in this browser; before that, the
    passcode form, the same for every token."""
    if (busy := _client_allowed(request)) is not None:
        return busy
    link, claims = await _opened(token, request)
    if link is None or claims is None:
        return _html(LOCKED_PAGE, 401)
    if service.state(link) != "active":
        return await _refused(link, service.state(link), _html(render.ended_page(), 410))
    pages = _window(_link_pages, link.id, 60)
    if len(pages) >= PAGES_PER_MINUTE:
        return await _refused(link, "rate", _too_many(_retry_after(pages, 60), html=True))
    pages.append(time.monotonic())
    try:
        content = await render.render_share(_context(link), "html")
    except render.Unavailable:
        return _html(render.ended_page(), 410)
    except render.Busy:
        return _html(render.page("Busy", "<p>Try again in a moment.</p>"), 503,
                     **{"Retry-After": "5"})  # fmt: skip
    await _record_view(link, request, claims, "page")
    return _html(str(content), 200)


async def _passcode_of(request: Request) -> str:
    kind = request.headers.get("content-type", "")
    try:
        if kind.startswith("application/json"):
            data = await request.json()
            value = data.get("passcode") if isinstance(data, dict) else None
        else:
            value = (await request.form()).get("passcode")
    except Exception:
        value = None
    return value[:PASSCODE_FORM_MAX] if isinstance(value, str) else ""


async def _try(link: ShareLink) -> int | None:
    """Count a passcode try on the link's locked row *before* the slow check, so tries
    sent at the same time queue on the row and no more than :data:`PASSCODE_TRIES` are
    checked in a window. None: go on and check it; else the seconds the link is locked
    for (or its window is full of tries in flight)."""
    async with tenant_session(link.tenant_id) as db:
        row = await db.get(ShareLink, link.id, with_for_update=True)
        if row is None:
            return None
        at = service.now()
        if row.locked_until is not None and row.locked_until > at:
            await db.commit()
            return int((row.locked_until - at).total_seconds()) + 1
        start = row.passcode_window_start
        if start is None or at - start >= timedelta(seconds=LOCK_SECONDS):
            row.passcode_window_start, row.passcode_failures = at, 0
        if row.passcode_failures >= PASSCODE_TRIES:
            left = row.passcode_window_start + timedelta(seconds=LOCK_SECONDS) - at
            await db.commit()
            return int(left.total_seconds()) + 1
        row.passcode_failures += 1
        await db.commit()
        return None


async def _missed(link: ShareLink | None) -> None:
    """A try :func:`_try` counted was wrong: the one that fills the window locks the link
    (audited ``share_link.passcode_locked``)."""
    if link is None:
        return
    async with tenant_session(link.tenant_id) as db:
        row = await db.get(ShareLink, link.id, with_for_update=True)
        if row is None:
            return
        at = service.now()
        if row.passcode_failures >= PASSCODE_TRIES and not (
            row.locked_until is not None and row.locked_until > at
        ):
            row.locked_until = at + timedelta(seconds=LOCK_SECONDS)
            row.passcode_failures, row.passcode_window_start = 0, None
            await audit.record(
                db, ACTOR, "share_link.passcode_locked", "share_link", row.id,
                {"minutes": LOCK_SECONDS // 60},
            )  # fmt: skip
        else:
            await _audit_refusal(db, row, "passcode")
        await db.commit()


async def _right(link: ShareLink) -> None:
    """The right passcode: the window's count starts again."""
    async with tenant_session(link.tenant_id) as db:
        row = await db.get(ShareLink, link.id, with_for_update=True)
        if row is not None:
            row.passcode_failures, row.passcode_window_start = 0, None
        await db.commit()


@router.post(
    "/{token}",
    response_class=Response,
    status_code=303,
    responses={
        303: {"description": "Opened: the cookie is set, back to the page"},
        404: {"description": "Not opened: wrong passcode, unknown, expired or revoked (one body)"},
        429: {"description": "Locked out for guessing (Retry-After)"},
    },
    name="unlock_public_share",
)
async def unlock_public_share(token: str, request: Request) -> Response:
    """The passcode form's post (``passcode``, form-encoded or JSON). The right passcode
    on a live link sets the link's cookie and goes back to the page; anything else is the
    same 404, whatever the reason."""
    if (busy := _client_allowed(request)) is not None:
        return busy
    client = _client(request)
    misses = _window(_client_misses, client, LOCK_SECONDS)
    if len(misses) >= CLIENT_PASSCODE_TRIES:
        return _too_many(_retry_after(misses, LOCK_SECONDS), html=True)
    # Counted as a miss before the check (no await in between, so a burst can not pass
    # the limit), taken back when it is right.
    mark = time.monotonic()
    misses.append(mark)
    passcode = await _passcode_of(request)
    link = await _locate(token)
    if link is not None and (retry := await _try(link)) is not None:
        _drop(misses, mark)
        return _too_many(retry, html=True)
    at = service.now()
    stored = link.passcode_hash if link is not None else None
    right = bool(passcode) and await asyncio.to_thread(service.verify_or_waste, stored, passcode)
    if not right:
        # The try that locks the link answers like any wrong one; the next is 429.
        await _missed(link)
        return _html(WRONG_PAGE, 404)
    _drop(misses, mark)
    assert link is not None
    await _right(link)
    if service.state(link, at) != "active":
        return _html(WRONG_PAGE, 404)
    # The same browser keeps its id across a re-entry (it counts once in the view log).
    before = None
    raw = request.cookies.get(COOKIE)
    if raw:
        try:
            before = _serializer().loads(raw)
        except BadSignature:
            before = None
    browser = before.get("b") if isinstance(before, dict) and before.get("l") == str(link.id) \
        else None  # fmt: skip
    claims = {"l": str(link.id), "v": link.passcode_version,
              "b": browser if isinstance(browser, str) else secrets.token_urlsafe(16)}  # fmt: skip
    path = f"/v1/public/shares/{token}"
    response = RedirectResponse(path, status_code=303, headers=PAGE_HEADERS)
    left = int((link.expires_at - at).total_seconds())
    response.set_cookie(
        COOKIE,
        _serializer().dumps(claims),
        max_age=max(1, min(COOKIE_SECONDS, left)),
        path=path,
        httponly=True,
        secure=True,
        samesite="strict",
    )
    return response


@router.get(
    "/{token}/pdf",
    response_class=Response,
    responses={200: {"content": {"application/pdf": {}}}, 404: {"description": "Not open"},
               **REFUSALS},
    name="public_share_pdf",
)  # fmt: skip
async def public_share_pdf(token: str, request: Request) -> Response:
    """The page as a PDF, when the link allows downloads (O5-Q9); the same 404 as an
    unknown token before the passcode or when downloads are off."""
    if (busy := _client_allowed(request)) is not None:
        return busy
    link, claims = await _opened(token, request)
    if link is None or claims is None or not link.allow_download:
        return _json(NOT_FOUND, 404)
    if service.state(link) != "active":
        return await _refused(link, service.state(link), _html(render.ended_page(), 410))
    async with tenant_session(link.tenant_id) as db:
        since = service.now() - timedelta(hours=1)
        recent = await db.scalar(
            select(func.count())
            .select_from(ShareLinkView)
            .where(
                ShareLinkView.share_link_id == link.id,
                ShareLinkView.kind == "download",
                ShareLinkView.viewed_at > since,
            )
        )
        await db.commit()
    if (recent or 0) >= DOWNLOADS_PER_HOUR:
        return await _refused(link, "downloads", _too_many(600))
    try:
        content = await render.render_share(_context(link), "pdf")
    except render.Unavailable:
        return _html(render.ended_page(), 410)
    except render.Busy:
        return _json({"detail": "Try again in a moment"}, 503, **{"Retry-After": "5"})
    if not content:
        return _html(render.page(render.UPDATING, f"<p>{render.UPDATING}.</p>"), 409)
    await _record_view(link, request, claims, "download")
    return Response(
        content, media_type="application/pdf",
        headers={**PAGE_HEADERS, "Content-Disposition": 'attachment; filename="roadmap.pdf"'},
    )  # fmt: skip


@router.get(
    "/{token}/status",
    responses={200: {"description": "locked (no open cookie), active or ended"}, 429: {}},
    name="public_share_status",
)
async def public_share_status(token: str, request: Request) -> JSONResponse:
    """For the web page's server render: ``locked`` until the passcode opened the link
    in this browser (for every token, known or not), then ``active`` or ``ended``."""
    if (busy := _client_allowed(request)) is not None:
        return busy  # type: ignore[return-value]
    link, claims = await _opened(token, request)
    if link is None or claims is None:
        return _json({"state": "locked"}, 200)
    return _json({"state": "active" if service.state(link) == "active" else "ended"}, 200)
