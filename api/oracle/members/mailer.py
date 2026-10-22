"""The invite email (#242): one plain message to the invitee naming the company's Oracle,
the role, who invited them and the sign-in link.

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
import time
from dataclasses import dataclass
from email.message import EmailMessage
from typing import Protocol

import httpx

from oracle.config import get_settings
from oracle.swarm.swarmcloud import GoogleAccessToken

TOKEN_URL = "https://oauth2.googleapis.com/token"
IAM_API_BASE = "https://iamcredentials.googleapis.com/v1"
GMAIL_SEND_URL = "https://gmail.googleapis.com/gmail/v1/users/me/messages/send"
GMAIL_SCOPE = "https://www.googleapis.com/auth/gmail.send"
JWT_BEARER = "urn:ietf:params:oauth:grant-type:jwt-bearer"
TIMEOUT = httpx.Timeout(15.0)
# A delegated token is used until this many seconds before it expires.
EXPIRY_MARGIN = 300
MAX_ERROR_CHARS = 300


class MailError(Exception):
    """A send that failed; its message says why (recorded on the invite)."""


@dataclass(frozen=True)
class InviteEmail:
    to: str
    subject: str
    text: str
    html: str


class Mailer(Protocol):
    async def send(self, http: httpx.AsyncClient, message: InviteEmail) -> None: ...


ROLE_NAMES = {
    "owner": "Owner",
    "approver": "Approver",
    "commenter": "Commenter",
    "viewer": "Viewer",
}


def invite_email(*, to: str, company: str, role: str, inviter: str, link: str) -> InviteEmail:
    """The invite: only what the owner typed (the address and role), the company's name,
    the inviter and the sign-in link."""
    role_name = ROLE_NAMES.get(role, role)
    oracle = f"{company} Product Oracle"
    lines = [
        f"{inviter} invited you to {oracle} as {role_name}.",
        "",
        f"Sign in here: {link}",
        f"Sign in with Google using {to}.",
    ]
    e = html.escape
    body = (
        f"<p>{e(inviter)} invited you to {e(oracle)} as {e(role_name)}.</p>"
        f'<p><a href="{e(link)}">Sign in here: {e(link)}</a></p>'
        f"<p>Sign in with Google using {e(to)}.</p>"
    )
    return InviteEmail(
        to=to,
        subject=f"You're invited to {oracle} as {role_name}",
        text="\n".join(lines) + "\n",
        html=f"<html><body>{body}</body></html>",
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
                raise MailError(f"signJwt answered {signed.status_code}: {_short(signed)}")
            exchanged = await http.post(
                TOKEN_URL,
                data={"grant_type": JWT_BEARER, "assertion": signed.json()["signedJwt"]},
                timeout=TIMEOUT,
            )
            if exchanged.status_code != 200:
                code = exchanged.status_code
                raise MailError(f"the token exchange answered {code}: {_short(exchanged)}")
            body = exchanged.json()
            token, ttl = body["access_token"], float(body.get("expires_in", 3600))
        except MailError:
            raise
        except httpx.HTTPError as exc:
            raise MailError(f"Google could not be reached: {type(exc).__name__}") from None
        except (ValueError, KeyError, TypeError):
            raise MailError("Google answered with no token") from None
        except Exception as exc:  # the service account's own token (metadata server)
            raise MailError(f"no access token for Oracle's service account: {exc}") from None
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
        msg = EmailMessage()
        msg["From"] = self.sender
        msg["To"] = message.to
        msg["Subject"] = message.subject
        msg.set_content(message.text)
        msg.add_alternative(message.html, subtype="html")
        return base64.urlsafe_b64encode(msg.as_bytes()).decode()

    async def send(self, http: httpx.AsyncClient, message: InviteEmail) -> None:
        token = await self.minter.token(http)
        try:
            resp = await http.post(
                GMAIL_SEND_URL,
                json={"raw": self._raw(message)},
                headers={"Authorization": f"Bearer {token}"},
                timeout=TIMEOUT,
            )
        except httpx.HTTPError as exc:
            raise MailError(f"the Gmail API could not be reached: {type(exc).__name__}") from None
        if resp.status_code != 200:
            raise MailError(f"the Gmail API answered {resp.status_code}: {_short(resp)}")


def _short(resp: httpx.Response) -> str:
    return resp.text[:MAX_ERROR_CHARS]


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
