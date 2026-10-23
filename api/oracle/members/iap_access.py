"""Google IAP access per invite (#242): Oracle's backend services admit only the accounts
holding ``roles/iap.httpsResourceAccessor`` on them, so an invite grants its invitee
that role, and revoking the invite (or removing the member) takes it away.

Through IAP's ``getIamPolicy``/``setIamPolicy`` REST API, with Oracle's own service
account (the metadata server's access token in Cloud Run), never a person's
credentials. Each change is a read-modify-write with the policy's ``etag``; a 409 (the
policy changed between the read and the write) is retried once. All of it is async
(httpx): nothing blocks the event loop.
"""

import copy
import json
import re
from typing import Protocol

import httpx

from oracle.config import get_settings
from oracle.members.schemas import PLAIN_ADDRESS, plain_address
from oracle.swarm.swarmcloud import GoogleAccessToken

ROLE = "roles/iap.httpsResourceAccessor"
IAP_API = "https://iap.googleapis.com/v1"
TIMEOUT = httpx.Timeout(10.0)
# What an error from Google is recorded as: its status, a short generic reason and
# Google's own message (#330: "User ... does not exist" says what went wrong), capped and
# with anything shaped like a credential taken out; never the rest of its body.
MESSAGE_CAP = 200
_TOKENS = re.compile(
    r"(?i:bearer\s+)?(?:ya29\.[\w.-]+|eyJ[\w-]*\.[\w-]+\.[\w-]*|(?:po|ort|poa|por)_[\w-]+"
    r"|1//[\w-]+|AIza[\w-]{20,}|[A-Za-z0-9_-]{40,})"
)
REASONS = {
    400: "bad request",
    401: "not authenticated",
    403: "permission denied",
    404: "not found",
    409: "conflict",
    429: "rate limited",
}


def google_message(body: str | None) -> str | None:
    """Google's own message in an error ``body`` (``{"error": {"message"}}``, or OAuth's
    ``error_description``), capped at MESSAGE_CAP, with no tokens; None without one."""
    try:
        parsed = json.loads(body or "")
    except ValueError:
        return None
    if not isinstance(parsed, dict):
        return None
    error = parsed.get("error")
    message = error.get("message") if isinstance(error, dict) else parsed.get("error_description")
    if not isinstance(message, str):
        return None
    message = _TOKENS.sub("[token removed]", " ".join(message.split()))
    if not message:
        return None
    if len(message) > MESSAGE_CAP:
        message = message[: MESSAGE_CAP - 1].rstrip() + "…"
    return message


def google_refusal(code: int, body: str | None = None) -> str:
    """``Google returned 400 (bad request): User ... does not exist.``: what Oracle
    records of a refusal, Google's own message (if its ``body`` has one) after the status."""
    reason = REASONS.get(code)
    if reason is None:
        if code in (502, 503, 504):
            reason = "unavailable"
        else:
            reason = "server error" if code >= 500 else "refused"
    said = f"Google returned {code} ({reason})"
    message = google_message(body)
    return f"{said}: {message}" if message else said


class IapError(Exception):
    """A policy read or write that failed; its message says why (recorded on the invite)."""


class EtagConflict(IapError):
    """The policy changed between the read and the write (HTTP 409)."""


class Auth(Protocol):
    async def header(self, client: httpx.AsyncClient) -> str: ...


class IapPolicyClient(Protocol):
    async def get_policy(self, http: httpx.AsyncClient, backend: str) -> dict: ...

    async def set_policy(self, http: httpx.AsyncClient, backend: str, policy: dict) -> dict: ...


class GoogleIapClient:
    """IAP's IAM policy of a backend service in ``project``, read and written as Oracle's
    own service account (ADC)."""

    def __init__(self, project: str, auth: Auth | None = None) -> None:
        self.project = project
        self.auth = auth or GoogleAccessToken()

    def _url(self, backend: str, method: str) -> str:
        return f"{IAP_API}/projects/{self.project}/iap_web/compute/services/{backend}:{method}"

    async def _post(self, http: httpx.AsyncClient, url: str, body: dict) -> dict:
        try:
            headers = {"Authorization": await self.auth.header(http)}
            resp = await http.post(url, json=body, headers=headers, timeout=TIMEOUT)
        except httpx.HTTPError as exc:
            raise IapError(f"Google could not be reached ({type(exc).__name__})") from None
        except Exception:  # the token: RuntimeUnavailable from the metadata server
            raise IapError("Oracle has no access token for Google") from None
        if resp.status_code == 409:
            raise EtagConflict("Google returned 409 (the policy's etag changed)")
        if resp.status_code != 200:
            raise IapError(google_refusal(resp.status_code, resp.text))
        try:
            return resp.json()
        except ValueError:
            raise IapError("Google answered with no policy") from None

    async def get_policy(self, http: httpx.AsyncClient, backend: str) -> dict:
        return await self._post(http, self._url(backend, "getIamPolicy"), {})

    async def set_policy(self, http: httpx.AsyncClient, backend: str, policy: dict) -> dict:
        return await self._post(http, self._url(backend, "setIamPolicy"), {"policy": policy})


_clients: dict[str, GoogleIapClient] = {}


def get_client() -> IapPolicyClient | None:
    """Oracle's IAP policy client for ORACLE_GCP_PROJECT; None without a project. Kept per
    project, so its access token is cached across calls."""
    project = get_settings().gcp_project
    if not project:
        return None
    if project not in _clients:
        _clients[project] = GoogleIapClient(project)
    return _clients[project]


def _with(policy: dict, member: str) -> dict | None:
    """``policy`` with ``member`` in the accessor role; None when it already is."""
    bindings = policy.setdefault("bindings", [])
    for binding in bindings:
        # A conditional binding is someone else's rule: never merged into.
        if binding.get("role") == ROLE and "condition" not in binding:
            if member in binding.get("members", []):
                return None
            binding.setdefault("members", []).append(member)
            return policy
    bindings.append({"role": ROLE, "members": [member]})
    return policy


def _without(policy: dict, member: str) -> dict | None:
    """``policy`` without ``member`` in the accessor role; None when it was not there."""
    changed = False
    kept = []
    for binding in policy.get("bindings", []):
        if binding.get("role") == ROLE and "condition" not in binding:
            members = binding.get("members", [])
            if member in members:
                changed = True
                members = [m for m in members if m != member]
                if not members:
                    continue
                binding = {**binding, "members": members}
        kept.append(binding)
    if not changed:
        return None
    policy["bindings"] = kept
    return policy


async def _change(client: IapPolicyClient, http: httpx.AsyncClient, backend: str, edit) -> None:
    for attempt in (1, 2):
        policy = await client.get_policy(http, backend)
        changed = edit(copy.deepcopy(policy))
        if changed is None:
            return
        try:
            await client.set_policy(http, backend, changed)
            return
        except EtagConflict:
            if attempt == 2:
                raise


def _member(email: str) -> str:
    """The IAM member of ``email``: ``user:`` and one plain address, or IapError."""
    try:
        member = f"user:{plain_address(email)}"
    except ValueError:
        raise IapError("not one plain email address") from None
    if PLAIN_ADDRESS.fullmatch(member.removeprefix("user:")) is None:
        raise IapError("not one plain email address")
    return member


async def grant(client: IapPolicyClient, backends: list[str], email: str) -> None:
    """Give ``user:<email>`` the accessor role on each backend; already there is fine.
    Raises :class:`IapError` naming the backend that failed."""
    member = _member(email)
    async with httpx.AsyncClient() as http:
        for backend in backends:
            try:
                await _change(client, http, backend, lambda p: _with(p, member))
            except IapError as exc:
                raise type(exc)(f"{backend}: {exc}") from None


async def revoke(client: IapPolicyClient, backends: list[str], email: str) -> None:
    """Take ``user:<email>``'s accessor role away on each backend; not there is fine."""
    member = _member(email)
    async with httpx.AsyncClient() as http:
        for backend in backends:
            try:
                await _change(client, http, backend, lambda p: _without(p, member))
            except IapError as exc:
                raise type(exc)(f"{backend}: {exc}") from None
