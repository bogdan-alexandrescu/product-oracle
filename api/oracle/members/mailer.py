"""The invite email (#242): one message to the invitee naming the company's Oracle, the
role, who invited them and the sign-in link; since #203, template B (owner decisions,
2026-10-23): a designed HTML part with the Oracle mark inline (cid) beside a plain-text
part saying the same, the owner's note when there is one, and Reply-To the inviter.

Sent through a small :class:`Mailer`, its provider set by configuration; only from the
background send (``oracle.members.delivery``), never on a request. The one provider is
the Gmail API sending as one company mailbox (ORACLE_MAIL_SENDER) through domain-wide
delegation (owner decision, 2026-10-21): Cloud Run's service account has no private key,
so the delegated token's JWT is signed by the IAM Credentials API (``signJwt`` on the
service account itself), then exchanged at Google's token endpoint. With no provider or
no sender, :func:`get_mailer` is None and nothing is sent.
"""

import base64
import html
import json
import re
import time
from dataclasses import dataclass
from datetime import datetime
from email.message import EmailMessage
from pathlib import Path
from string import Template
from typing import Protocol

import httpx

from oracle.company_time import DEFAULT_ZONE, in_words
from oracle.config import get_settings
from oracle.members.iap_access import google_refusal
from oracle.members.schemas import plain_address
from oracle.swarm.swarmcloud import GoogleAccessToken

TOKEN_URL = "https://oauth2.googleapis.com/token"
IAM_API_BASE = "https://iamcredentials.googleapis.com/v1"
GMAIL_SEND_URL = "https://gmail.googleapis.com/gmail/v1/users/me/messages/send"
GMAIL_SCOPE = "https://www.googleapis.com/auth/gmail.send"
JWT_BEARER = "urn:ietf:params:oauth:grant-type:jwt-bearer"
TIMEOUT = httpx.Timeout(15.0)
# A delegated token is used until this many seconds before it expires.
EXPIRY_MARGIN = 300


class MailError(Exception):
    """A send that failed; its message says why (recorded on the invite)."""


@dataclass(frozen=True)
class InviteEmail:
    to: str
    subject: str
    text: str
    html: str
    # The inviter's own address (#203): replies reach them; None when they have none.
    reply_to: str | None = None


class Mailer(Protocol):
    async def send(self, http: httpx.AsyncClient, message: InviteEmail) -> None: ...


ROLE_NAMES = {
    "owner": "Owner",
    "approver": "Approver",
    "commenter": "Commenter",
    "viewer": "Viewer",
}

# The Oracle mark (web/app/apple-icon.png), attached inline: Oracle's host is behind IAP,
# so a hosted image would not load in a mail client.
MARK_PNG = Path(__file__).with_name("oracle-mark.png")
MARK_CID = "oracle-mark@product-oracle"
# A company name this short keeps its words on one line in the heading.
NOWRAP_COMPANY = 24

_FONT = "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif"

# Template B (owner decision, 2026-10-23), beside this file. ``$`` fields are filled in
# escaped; the note and the expiry line are whole fragments, or empty.
_PAGE = Template(Path(__file__).with_name("invite-email.html").read_text("utf-8"))

_NOTE = Template(Path(__file__).with_name("invite-note.html").read_text("utf-8"))

_EXPIRY = Template(
    """<br>
      <span class="t2"><strong class="t1" style="color:#0d1724;">Expires $when</strong></span>"""
)


def _first_name(inviter: str | None) -> str:
    """Who the note is from: the first word of the inviter's name, or their address."""
    if inviter is None:
        return "the owner"
    return inviter if "@" in inviter else (inviter.split() or [inviter])[0]


def _reply_address(value: str | None) -> str | None:
    """The inviter's address as one plain address, or None (never a list or a header)."""
    try:
        return plain_address(value) if value else None
    except ValueError:
        return None


def invite_email(
    *,
    to: str,
    company: str,
    role: str,
    inviter: str | None,
    link: str,
    reply_to: str | None = None,
    message: str | None = None,
    expires_at: datetime | None = None,
    zone: str = DEFAULT_ZONE,
) -> InviteEmail:
    """The invite, template B (#203): the company, the inviter (their name, else their
    address; None for no person), the role's name, the sign-in link, the address to sign
    in with, the expiry in the Company time zone when there is one, and the owner's note
    when there is one. The note is plain text: escaped, its line breaks kept. Replies go
    to ``reply_to`` (the inviter's address), when it is one plain address."""
    role_name = ROLE_NAMES.get(role, role)
    reply_to = _reply_address(reply_to)
    note = (message or "").replace("\r\n", "\n").replace("\r", "\n").strip()
    when = in_words(expires_at, zone) if expires_at is not None else None
    who = inviter or "An owner"
    first = _first_name(inviter)
    owner = f"an owner of Product Oracle at {company}"
    because = f"{inviter}, {owner}," if inviter else owner

    e = html.escape
    company_heading = e(company)
    if len(company) <= NOWRAP_COMPANY:
        company_heading = company_heading.replace(" ", "&nbsp;")
    preheader = f"{who} invited you to join {company} on Product Oracle as {role_name}."
    if when:
        preheader += f" Expires {when}."
    page = _PAGE.substitute(
        font=_FONT,
        cid=MARK_CID,
        company=e(company),
        company_heading=company_heading,
        preheader=e(preheader),
        inviter=e(who),
        role=e(role_name),
        note=_NOTE.substitute(font=_FONT, first=e(first), message=e(note).replace("\n", "<br>"))
        if note
        else "",
        link=e(link),
        to=e(to),
        expiry=_EXPIRY.substitute(when=e(when)) if when else "",
        because=e(because),
        questions=f"Questions? Reply to this email and it reaches {e(first)}. " if reply_to else "",
    )

    lines = [f"{who} invited you to join {company} on Product Oracle as {role_name}.", ""]
    if note:
        lines += [f"Message from {first}:", f'"{note}"', ""]
    lines += [f"Open Oracle: {link}", f"Sign in with Google using {to}."]
    if when:
        lines.append(f"Expires {when} ({company} time).")
    lines += [
        "",
        f"You got this email because {because}",
        f"invited {to}."
        + (f" Questions? Reply to this email and it reaches {first}." if reply_to else ""),
        "Not expecting it? Ignore this email: nothing happens unless you sign in.",
    ]
    return InviteEmail(
        to=to,
        subject=f"You're invited to join {company} on Product Oracle as {role_name}",
        text="\n".join(lines) + "\n",
        html=page,
        reply_to=reply_to,
    )


def delegation_claims(service_account: str, sender: str, *, now: int | None = None) -> dict:
    """The JWT the service account signs to act as ``sender`` with the gmail.send scope."""
    iat = int(time.time()) if now is None else now
    return {
        "iss": service_account,
        "sub": sender,
        "scope": GMAIL_SCOPE,
        "aud": TOKEN_URL,
        "iat": iat,
        "exp": iat + 3600,
    }


class ServiceAccountAuth(Protocol):
    async def header(self, client: httpx.AsyncClient) -> str: ...

    async def identity(self, client: httpx.AsyncClient) -> str | None: ...


class DelegatedTokenMinter:
    """An access token acting as ``sender`` (domain-wide delegation), minted with no key:
    ``signJwt`` on Oracle's own service account, then the jwt-bearer exchange. Cached
    until shortly before it expires."""

    def __init__(self, sender: str, auth: ServiceAccountAuth | None = None) -> None:
        self.sender = sender
        self.auth = auth or GoogleAccessToken()
        self._token: str | None = None
        self._expires_at = 0.0

    async def token(self, http: httpx.AsyncClient) -> str:
        if self._token is not None and time.time() < self._expires_at - EXPIRY_MARGIN:
            return self._token
        try:
            account = await self.auth.identity(http)
            if not account:
                raise MailError("Oracle's service account is not known (no metadata server)")
            signed = await http.post(
                f"{IAM_API_BASE}/projects/-/serviceAccounts/{account}:signJwt",
                json={"payload": json.dumps(delegation_claims(account, self.sender))},
                headers={"Authorization": await self.auth.header(http)},
                timeout=TIMEOUT,
            )
            if signed.status_code != 200:
                raise MailError(google_refusal(signed.status_code, signed.text))
            exchanged = await http.post(
                TOKEN_URL,
                data={"grant_type": JWT_BEARER, "assertion": signed.json()["signedJwt"]},
                timeout=TIMEOUT,
            )
            if exchanged.status_code != 200:
                raise MailError(google_refusal(exchanged.status_code, exchanged.text))
            body = exchanged.json()
            token, ttl = body["access_token"], float(body.get("expires_in", 3600))
        except MailError:
            raise
        except httpx.HTTPError as exc:
            raise MailError(f"Google could not be reached: {type(exc).__name__}") from None
        except (ValueError, KeyError, TypeError):
            raise MailError("Google answered with no token") from None
        except Exception:  # the service account's own token (metadata server)
            raise MailError("Oracle has no access token for its service account") from None
        self._token, self._expires_at = token, time.time() + ttl
        return token


class TokenMinter(Protocol):
    async def token(self, http: httpx.AsyncClient) -> str: ...


class GmailApiMailer:
    """Sends as ``sender`` through the Gmail API (``users.messages.send``)."""

    def __init__(self, sender: str, minter: TokenMinter | None = None) -> None:
        self.sender = sender
        self.minter = minter or DelegatedTokenMinter(sender)

    def _raw(self, message: InviteEmail) -> str:
        try:
            to = plain_address(message.to)
        except ValueError:
            raise MailError("not one plain email address") from None
        reply_to = _reply_address(message.reply_to)
        msg = EmailMessage()
        msg["From"] = self.sender
        msg["To"] = to
        if reply_to:
            # Replies reach the inviter (#203); From stays the company mailbox.
            msg["Reply-To"] = reply_to
        msg["Subject"] = message.subject
        msg.set_content(message.text)
        msg.add_alternative(message.html, subtype="html")
        # The HTML and the Oracle mark it shows by cid: multipart/related.
        msg.get_payload()[1].add_related(
            MARK_PNG.read_bytes(),
            "image",
            "png",
            cid=f"<{MARK_CID}>",
            disposition="inline",
            filename="oracle-mark.png",
        )
        raw = msg.as_bytes()
        # The header policy parses and re-renders what it is given (an RFC 2047 word
        # becomes the address it encodes): send only if the To line is ``to`` itself,
        # and the Reply-To line the inviter's address itself.
        head = re.sub(rb"\r?\n[ \t]+", b" ", raw.split(b"\n\n", 1)[0]).splitlines()
        if [line for line in head if line[:3].lower() == b"to:"] != [f"To: {to}".encode()]:
            raise MailError("not one plain email address")
        replies = [line for line in head if line[:9].lower() == b"reply-to:"]
        if replies != ([f"Reply-To: {reply_to}".encode()] if reply_to else []):
            raise MailError("not one plain reply address")
        return base64.urlsafe_b64encode(raw).decode()

    async def send(self, http: httpx.AsyncClient, message: InviteEmail) -> None:
        raw = self._raw(message)
        token = await self.minter.token(http)
        try:
            resp = await http.post(
                GMAIL_SEND_URL,
                json={"raw": raw},
                headers={"Authorization": f"Bearer {token}"},
                timeout=TIMEOUT,
            )
        except httpx.HTTPError as exc:
            raise MailError(f"Google could not be reached ({type(exc).__name__})") from None
        if resp.status_code != 200:
            raise MailError(google_refusal(resp.status_code, resp.text))


_mailers: dict[str, GmailApiMailer] = {}


def get_mailer() -> Mailer | None:
    """The configured mailer (kept per sender, so its token is cached); None when
    ORACLE_MAIL_PROVIDER or ORACLE_MAIL_SENDER is unset."""
    settings = get_settings()
    sender = settings.mail_sender.strip()
    if settings.mail_provider != "gmail_api" or not sender:
        return None
    if sender not in _mailers:
        _mailers[sender] = GmailApiMailer(sender)
    return _mailers[sender]
