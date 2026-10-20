"""SwarmCloud as an agent runtime, through its public task and workflow API.

    POST /v1/workflows                       submit (steps, metadata, strategy)
    GET  /v1/workflows/{id}                  state, step tasks with cost totals
    POST /v1/workflows/{id}/cancel
    GET  /v1/tasks/{task_id}/artifacts       a step's artifact listing
    GET  /v1/tasks/{task_id}/artifacts/raw   one artifact's bytes, by name

Auth is pluggable: a static bearer from the environment, a Google ID token minted for an
audience by the metadata server, or the service account's OAuth access token from the
metadata server (what an IAP front door with a Google-managed OAuth client accepts; the
account needs roles/iap.httpsResourceAccessor there). Tokens never reach a log line or
an exception message.

Adapter v2 (docs/swarmcloud-interface.md), each part behind SwarmCloud's switch:

    GET   /v1/mcp-servers                    SwarmCloud's egress_addresses (503
                                             mcp_unavailable: caller MCP off; reads are
                                             served while it is off, so a 200 is not "on")
    GET   /v1/mcp-servers/oracle             registration, then POST or PATCH it
    GET   /v1/capacity                       await-input and service answers, when reported
    GET   /v1/tasks?submitted_by=me&limit=50 a submission whose answer was lost, by the
                                             ``oracle_key`` in its steps' metadata
    POST  /v1/workflows/{id}/steps/{step}/input   the answer to a wait for a person
    GET   /v1/workflows/{id}/steps/{step}/input   the answer it holds (who, when, via; never
                                             the payload), the verdict being in the step's
                                             form artifact

Caller MCP counts as on only once SwarmCloud accepted a registration write (a new server,
a changed URL, or, when the registration is already current, the same URL PATCHed again to
confirm it) or a submission carrying the run token. While it is off or not confirmed, the
run token is never sent (a prompt is not a place for a credential) and every run says so
in its notes. Once it is on, the token goes only in the workflow's ``mcp_credentials``,
never in a step's input, whether the run is one workflow or one workflow per segment.

SwarmCloud's errors are ``{"code": ..., "message": ..., "detail": {"reason": ..., ...}}``:
the reason, when there is one, is what a refusal means.
"""

import asyncio
import json
import logging
import re
import time
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta
from decimal import Decimal
from email.utils import parsedate_to_datetime
from http.cookiejar import CookieJar, DefaultCookiePolicy
from typing import Any, Protocol

import httpx
import jwt

from oracle.swarm.runtime import (
    AWAIT_PROFILE,
    FEATURES,
    MCP_SERVER,
    MERGE,
    NOT_YET,
    Answer,
    Features,
    FeatureState,
    Parked,
    RecordedAnswer,
    RuntimeUnavailable,
    StepStatus,
    WorkflowSpec,
    WorkflowState,
    WorkflowStatus,
)
from oracle.swarm.settings import RuntimeSettings

log = logging.getLogger(__name__)

NO_MCP_NOTE = (
    "SwarmCloud's caller MCP (#1433) is switched off or not confirmed, so it cannot attach "
    "Oracle's MCP server or a run token to a task: agents cannot read Oracle's sources, "
    "baseline or documents and work from their prompts only."
)
# Text artifacts worth bringing back; agent streams and logs stay in SwarmCloud.
TEXT_SUFFIXES = (".md", ".yaml", ".yml", ".json", ".txt")
MAX_ARTIFACT_BYTES = 1_000_000
# A wait's form artifact (a verdict and its findings) is small; anything larger is not read.
MAX_FORM_BYTES = 256 * 1024
MAX_FINDINGS = 50
# Finding a lost submission among Oracle's own tasks: page size and how far back to look.
TASK_PAGE = 50
MAX_TASK_PAGES = 20
# A task listed this much before Oracle sent a submission is older than it, whatever the
# two clocks say: the newest-first listing has passed where the submission would be.
CLOCK_SKEW = timedelta(minutes=10)
# What Oracle reads of an error body (its envelope is small).
MAX_ERROR_BYTES = 64 * 1024
METADATA_IDENTITY_URL = (
    "http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/identity"
)
METADATA_TOKEN_URL = (
    "http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token"
)
METADATA_EMAIL_URL = (
    "http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/email"
)

_STATES: dict[str, WorkflowState] = {
    "SUCCEEDED": "succeeded",
    "FAILED": "failed",
    "DEAD_LETTERED": "failed",
    "CANCELLED": "cancelled",
}


class Auth(Protocol):
    async def header(self, client: httpx.AsyncClient) -> str:
        """The Authorization header value."""
        ...


@dataclass(frozen=True)
class StaticBearer:
    token: str

    async def header(self, client: httpx.AsyncClient) -> str:
        return f"Bearer {self.token}"

    @property
    def email(self) -> str | None:
        """The principal a JWT bearer names (its email claim); None for an opaque one."""
        return _email_claim(self.token)


@dataclass
class GoogleIdToken:
    """An ID token for ``audience`` from the metadata server, cached until near expiry."""

    audience: str
    url: str = METADATA_IDENTITY_URL
    _token: str | None = field(default=None, repr=False)
    _expires_at: float = 0.0
    # The service account the token names (its email claim): who SwarmCloud records as
    # having answered a wait for Oracle.
    email: str | None = None

    async def header(self, client: httpx.AsyncClient) -> str:
        if self._token is None or time.time() > self._expires_at - 60:
            try:
                resp = await client.get(
                    self.url,
                    params={"audience": self.audience, "format": "full"},
                    headers={"Metadata-Flavor": "Google"},
                )
            except httpx.HTTPError as exc:
                raise RuntimeUnavailable(f"cannot mint an ID token: {type(exc).__name__}") from None
            if resp.status_code != 200:
                raise RuntimeUnavailable(f"cannot mint an ID token: HTTP {resp.status_code}")
            token = resp.text.strip()
            try:
                claims = jwt.decode(token, options={"verify_signature": False})
            except jwt.PyJWTError:
                raise RuntimeUnavailable("the metadata server returned no ID token") from None
            self._token = token
            self._expires_at = float(claims.get("exp", time.time() + 300))
            if isinstance(claims.get("email"), str):
                self.email = claims["email"]
        return f"Bearer {self._token}"


@dataclass
class GoogleAccessToken:
    """The service account's OAuth access token from the metadata server, cached until near
    expiry. An IAP front door that uses a Google-managed OAuth client accepts this, not an
    ID token."""

    url: str = METADATA_TOKEN_URL
    _token: str | None = field(default=None, repr=False)
    _expires_at: float = 0.0
    # The service account the token is for, from the metadata server once asked.
    email: str | None = None
    email_url: str = METADATA_EMAIL_URL

    async def identity(self, client: httpx.AsyncClient) -> str | None:
        """The service account whose token this is (who SwarmCloud records)."""
        if self.email is None:
            try:
                resp = await client.get(self.email_url, headers={"Metadata-Flavor": "Google"})
            except httpx.HTTPError:
                return None
            text = resp.text.strip() if resp.status_code == 200 else ""
            self.email = text if "@" in text and len(text) <= 254 else None
        return self.email

    async def header(self, client: httpx.AsyncClient) -> str:
        if self._token is None or time.time() > self._expires_at - 300:
            try:
                resp = await client.get(self.url, headers={"Metadata-Flavor": "Google"})
            except httpx.HTTPError as exc:
                raise RuntimeUnavailable(
                    f"cannot get an access token: {type(exc).__name__}"
                ) from None
            if resp.status_code != 200:
                raise RuntimeUnavailable(f"cannot get an access token: HTTP {resp.status_code}")
            try:
                body = resp.json()
                token = body["access_token"]
                ttl = float(body.get("expires_in", 300))
            except (ValueError, KeyError, TypeError):
                raise RuntimeUnavailable("the metadata server returned no access token") from None
            self._token = token
            self._expires_at = time.time() + ttl
        return f"Bearer {self._token}"


def _email_claim(token: str) -> str | None:
    try:
        claims = jwt.decode(token, options={"verify_signature": False})
    except jwt.PyJWTError:
        return None
    email = claims.get("email") if isinstance(claims, dict) else None
    return email if isinstance(email, str) and email else None


def auth_from_settings(settings: RuntimeSettings) -> Auth:
    if settings.swarmcloud_auth == "google_access_token":
        return GoogleAccessToken()
    if settings.swarmcloud_auth == "google_id_token":
        if not settings.swarmcloud_audience:
            raise ValueError("ORACLE_SWARMCLOUD_AUDIENCE is required for google_id_token auth")
        return GoogleIdToken(settings.swarmcloud_audience)
    if not settings.swarmcloud_token:
        raise ValueError("ORACLE_SWARMCLOUD_TOKEN is required for bearer auth")
    return StaticBearer(settings.swarmcloud_token)


def _parse_time(value: Any) -> datetime | None:
    if not isinstance(value, str) or not value:
        return None
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None
    return parsed if parsed.tzinfo else parsed.replace(tzinfo=UTC)


def _enabled(value: Any) -> FeatureState | None:
    """on / off from a capability entry (a bool, or an object with enabled/available)."""
    if isinstance(value, bool):
        return "on" if value else "off"
    if isinstance(value, dict):
        for key in ("enabled", "available", "on"):
            if isinstance(value.get(key), bool):
                return "on" if value[key] else "off"
    if isinstance(value, str) and value.lower() in ("on", "off"):
        return value.lower()  # type: ignore[return-value]
    return None


def capacity_features(body: Any) -> dict[str, FeatureState]:
    """await_input and service_answer as SwarmCloud's capacity listing reports them, when
    it does: a ``features`` map, or an ``await-input`` entry among the profiles."""
    out: dict[str, FeatureState] = {}
    if not isinstance(body, dict):
        return out
    feats = body.get("features") if isinstance(body.get("features"), dict) else {}
    for key, names in (
        ("await_input", ("await_input", "await-input", "person_wait")),
        ("service_answer", ("service_answer", "service-answer", "answering")),
    ):
        for name in names:
            state = _enabled(feats.get(name))
            if state:
                out[key] = state
                break
    profiles = body.get("profiles")
    if "await_input" not in out and profiles is not None:
        entry: Any = None
        if isinstance(profiles, dict):
            entry = profiles.get(AWAIT_PROFILE)
        elif isinstance(profiles, list):
            entry = next(
                (
                    p
                    for p in profiles
                    if isinstance(p, dict) and (p.get("name") or p.get("profile")) == AWAIT_PROFILE
                ),
                None,
            )
            if entry is None and all(isinstance(p, dict) for p in profiles):
                entry = False  # listed profiles without it: not offered
        state = _enabled(entry)
        if state:
            out["await_input"] = state
    return out


def _never_sent(exc: httpx.HTTPError) -> bool:
    """A request that never left Oracle: no connection was made, or none was free in the
    pool (PoolTimeout). Anything later may have arrived (a lost answer)."""
    return isinstance(exc, httpx.ConnectError | httpx.ConnectTimeout | httpx.PoolTimeout)


class SwarmCloudRuntime:
    name = "swarmcloud"

    def __init__(
        self,
        base_url: str,
        auth: Auth,
        *,
        timeout: float = 30.0,
        transport: httpx.AsyncBaseTransport | None = None,
        features_ttl: float = 60.0,
        egress_refresh: float = 300.0,
        principal: str | None = None,
    ) -> None:
        if not base_url:
            raise ValueError("ORACLE_SWARMCLOUD_URL is required for the swarmcloud runtime")
        self._base_url = base_url.rstrip("/")
        self._auth = auth
        self._timeout = timeout
        self._transport = transport
        self._features_ttl = features_ttl
        self._egress_refresh = egress_refresh
        self._features: Features | None = None
        self._features_at = 0.0
        # What calls taught us (a 422 at submit, an answer refused): feature -> (state,
        # reason, until). It outlives one cached reading, not the TTL after it, except a
        # sticky one (until is infinite), kept until SwarmCloud reports the feature on.
        self._learned: dict[str, tuple[FeatureState, str, float]] = {}
        self._egress: frozenset[str] | None = None
        self._egress_until = 0.0
        self._egress_lock = asyncio.Lock()
        self._registered_url: str | None = None
        # SwarmCloud accepted a registration write or a submission with the run token:
        # caller MCP is known to work (reads alone do not show it).
        self._mcp_works = False
        # Oracle's own principal in SwarmCloud (who a service answer is recorded as):
        # ORACLE_SWARMCLOUD_PRINCIPAL, else resolved from the token (an ID token's or JWT
        # bearer's email claim, an access token's service account).
        self._principal = principal
        self._http: httpx.AsyncClient | None = None
        self._http_loop: asyncio.AbstractEventLoop | None = None

    @classmethod
    def from_settings(cls, settings: RuntimeSettings) -> "SwarmCloudRuntime":
        if not settings.swarmcloud_url:
            raise ValueError("ORACLE_SWARMCLOUD_URL is required for the swarmcloud runtime")
        return cls(
            settings.swarmcloud_url,
            auth_from_settings(settings),
            timeout=settings.swarmcloud_timeout_seconds,
            features_ttl=settings.swarmcloud_features_ttl_seconds,
            egress_refresh=settings.egress_refresh_seconds,
            principal=settings.swarmcloud_principal or None,
        )

    @property
    def principal(self) -> str | None:
        return self._principal or getattr(self._auth, "email", None)

    async def _resolve_principal(self, client: httpx.AsyncClient) -> str | None:
        """Oracle's principal, resolved from the token when no setting names it."""
        if self.principal:
            return self.principal
        await self._auth.header(client)  # an ID token's email arrives with the token
        identity = getattr(self._auth, "identity", None)
        if not self.principal and identity is not None:
            await identity(client)
        return self.principal

    # ------------------------------------------------------------------ features

    def _known(self) -> Features:
        """The last reading with what calls taught since, without calling SwarmCloud."""
        base = self._features or Features(
            mcp="unknown",
            await_input="unknown",
            service_answer="unknown",
            reasons={k: "not read from SwarmCloud yet" for k in FEATURES},
        )
        now = time.monotonic()
        states = base.as_dict()
        reasons = dict(base.reasons)
        for key, (state, reason, until) in list(self._learned.items()):
            if until < now:
                del self._learned[key]
                continue
            states[key] = state
            if reason:
                reasons[key] = reason
            else:
                reasons.pop(key, None)
        return Features(**states, reasons=reasons)

    def learn(
        self, feature: str, state: FeatureState, reason: str = "", *, sticky: bool = False
    ) -> None:
        """Record what a call showed about a feature: kept for the cache's lifetime, or,
        ``sticky``, until SwarmCloud's own reading reports the feature on."""
        until = float("inf") if sticky else time.monotonic() + max(self._features_ttl, 1)
        self._learned[feature] = (state, reason, until)
        if feature == "mcp":
            self._mcp_works = state == "on"

    @property
    def can_reach_oracle(self) -> bool:
        return self._known().mcp == "on"

    def notes(self) -> list[str]:
        return [] if self.can_reach_oracle else [NO_MCP_NOTE]

    async def features(self, *, refresh: bool = False) -> Features:
        fresh = time.monotonic() - self._features_at < self._features_ttl
        if self._features is not None and fresh and not refresh:
            return self._known()
        states: dict[str, FeatureState] = {k: "unknown" for k in FEATURES}
        reasons: dict[str, str] = {}
        try:
            async with asyncio.timeout(self._timeout):
                async with self._client() as client:
                    await self._read_mcp_feature(client, states, reasons)
                    await self._read_capacity(client, states, reasons)
        except TimeoutError:
            for k in FEATURES:
                if states[k] == "unknown":
                    reasons.setdefault(k, f"SwarmCloud did not answer within {self._timeout:g} s")
        except RuntimeUnavailable as exc:
            for k in FEATURES:
                if states[k] == "unknown":
                    reasons.setdefault(k, str(exc))
        for key, state in states.items():
            # SwarmCloud reports the feature on: what a refusal taught is over.
            learned = self._learned.get(key)
            if state == "on" and learned is not None and learned[2] == float("inf"):
                del self._learned[key]
        self._features = Features(**states, reasons=reasons)
        self._features_at = time.monotonic()
        return self._known()

    async def _read_mcp_feature(
        self, client: httpx.AsyncClient, states: dict[str, FeatureState], reasons: dict[str, str]
    ) -> None:
        try:
            resp = await self._call(client, "GET", "/v1/mcp-servers")
        except RuntimeUnavailable as exc:
            if exc.code == "mcp_unavailable" or exc.status == 404:
                states["mcp"] = "off"
                self._mcp_works = False
                reasons["mcp"] = (
                    "SwarmCloud answers 503 mcp_unavailable: caller MCP (#1433) is switched off"
                    if exc.code == "mcp_unavailable"
                    else "SwarmCloud has no /v1/mcp-servers yet"
                )
            else:
                reasons["mcp"] = str(exc)
            return
        body = _json(resp)
        self._take_egress(body)
        if self._mcp_works:
            states["mcp"] = "on"
        else:
            # SwarmCloud serves reads while caller MCP is switched off.
            reasons["mcp"] = (
                "not confirmed: SwarmCloud lists MCP servers even while caller MCP (#1433) is "
                "switched off; on once it accepts Oracle's registration or a run's token"
            )

    async def _read_capacity(
        self, client: httpx.AsyncClient, states: dict[str, FeatureState], reasons: dict[str, str]
    ) -> None:
        try:
            resp = await self._call(client, "GET", "/v1/capacity")
        except RuntimeUnavailable as exc:
            for k in ("await_input", "service_answer"):
                reasons[k] = f"not reported by SwarmCloud ({exc}); learned at submit or answer"
            return
        found = capacity_features(_json(resp))
        for k in ("await_input", "service_answer"):
            if k in found:
                states[k] = found[k]
                if found[k] == "off":
                    reasons[k] = f"SwarmCloud reports {k.replace('_', '-')} switched off"
            else:
                reasons[k] = "not reported by SwarmCloud; learned at submit or answer"

    # ------------------------------------------------------------------ MCP server

    def _take_egress(self, body: Any) -> None:
        """A 200 from ``GET /v1/mcp-servers``: its addresses, fresh for the refresh time.
        A listing without an address list is not a new list: the last one (none read yet:
        no address is SwarmCloud's) is kept but not made fresher, and read again soon, as
        after a failed read (each refused run token must not cost an upstream call)."""
        addresses = body.get("egress_addresses") if isinstance(body, dict) else None
        if isinstance(addresses, list):
            self._egress = frozenset(str(a).strip() for a in addresses if str(a).strip())
            self._egress_until = time.monotonic() + self._egress_refresh
        else:
            log.warning("SwarmCloud's MCP server listing has no egress_addresses list")
            self._egress_until = time.monotonic() + min(self._egress_refresh, 30.0)

    def _egress_fresh(self) -> bool:
        return time.monotonic() < self._egress_until

    async def egress_addresses(self) -> frozenset[str] | None:
        if not self._egress_fresh():
            async with self._egress_lock:
                if not self._egress_fresh():
                    try:
                        async with asyncio.timeout(self._timeout):
                            async with self._client() as client:
                                resp = await self._call(client, "GET", "/v1/mcp-servers")
                        self._take_egress(_json(resp))
                    except (TimeoutError, RuntimeUnavailable) as exc:
                        log.warning("cannot refresh SwarmCloud's egress addresses: %s", exc)
                        # Keep the last list and try again soon; none read yet: no address
                        # is SwarmCloud's (fail closed).
                        self._egress_until = time.monotonic() + min(self._egress_refresh, 30.0)
        return self._egress if self._egress is not None else frozenset()

    async def ensure_mcp_server(self, url: str) -> str:
        """Register Oracle's MCP server at ``url``. A registration already current is
        PATCHed with the same URL while caller MCP is not confirmed: reads are served while
        the switch is off, so only an accepted write shows that it is on."""
        if self._registered_url == url and self._mcp_works:
            return "unchanged"
        async with self._client() as client:
            try:
                resp = await self._call(client, "GET", f"/v1/mcp-servers/{MCP_SERVER}")
            except RuntimeUnavailable as exc:
                if exc.status != 404:
                    self._learn_refusal(exc)
                    raise
                await self._write(client, "POST", "/v1/mcp-servers", json=mcp_server_body(url))
                result = "created"
            else:
                current = _json(resp)
                server = current.get("server", current) if isinstance(current, dict) else {}
                if isinstance(server, dict) and server.get("url") == url:
                    result = "unchanged"
                    if not self._mcp_works:
                        await self._write(
                            client, "PATCH", f"/v1/mcp-servers/{MCP_SERVER}", json={"url": url}
                        )
                else:
                    await self._write(
                        client, "PATCH", f"/v1/mcp-servers/{MCP_SERVER}", json={"url": url}
                    )
                    result = "updated"
        self._registered_url = url
        return result

    async def _write(self, client: httpx.AsyncClient, method: str, path: str, **kw: Any) -> None:
        """A registration write: accepted only while caller MCP is on."""
        try:
            await self._call(client, method, path, **kw)
        except RuntimeUnavailable as exc:
            self._learn_refusal(exc)
            raise
        self.learn("mcp", "on")

    def _learn_refusal(self, exc: RuntimeUnavailable) -> None:
        if exc.code == "mcp_unavailable":
            self.learn("mcp", "off", "SwarmCloud answered 503 mcp_unavailable")

    def forget_registration(self) -> None:
        """SwarmCloud says the server is not registered: register again before next use."""
        self._registered_url = None

    # ------------------------------------------------------------------ calls

    @asynccontextmanager
    async def _client(self) -> AsyncIterator[httpx.AsyncClient]:
        """The one HTTP client calls share (its connection pool), made on first use in
        the running event loop; leaving the block does not close it (:meth:`aclose`)."""
        loop = asyncio.get_running_loop()
        if self._http is None or self._http.is_closed or self._http_loop is not loop:
            old, self._http = self._http, None
            if old is not None and not old.is_closed:
                # Made in another event loop: its connections are closed, not leaked.
                try:
                    await old.aclose()
                except Exception as exc:  # its loop may be gone; nothing else to free
                    log.debug("closing the HTTP client of an earlier event loop: %s", exc)
            self._http = httpx.AsyncClient(
                base_url=self._base_url,
                timeout=self._timeout,
                transport=self._transport,
                headers={"User-Agent": "product-oracle"},
                # No cookie is kept: one call's Set-Cookie is never sent on another.
                cookies=CookieJar(policy=DefaultCookiePolicy(allowed_domains=[])),
            )
            self._http_loop = loop
        yield self._http

    async def aclose(self) -> None:
        if self._http is not None:
            await self._http.aclose()
            self._http = None

    async def _call(
        self, client: httpx.AsyncClient, method: str, path: str, **kwargs: Any
    ) -> httpx.Response:
        # No X-Swarm-Tenant: Oracle's service tenant is the default, and naming it is a 403.
        headers = {"Authorization": await self._auth.header(client), **kwargs.pop("headers", {})}
        try:
            resp = await client.request(method, path, headers=headers, **kwargs)
        except httpx.HTTPError as exc:
            # A connection never made sent nothing; anything later may have arrived.
            sent = not _never_sent(exc)
            raise RuntimeUnavailable(
                f"cannot reach SwarmCloud ({method} {path}): {type(exc).__name__}", lost=sent
            ) from None
        if resp.status_code >= 400:
            raise _refusal(resp, method, path)
        return resp

    def submission_body(self, spec: WorkflowSpec) -> dict[str, Any]:
        """The ``POST /v1/workflows`` body for ``spec`` (the run token included when the
        spec attaches Oracle's MCP server).

        A workflow keeps no metadata in SwarmCloud, so the submission's key goes in every
        step's own (plain) ``metadata`` as ``oracle_key``: that is how a submission whose
        answer was lost is found again (:meth:`find_by_label`)."""
        attach = spec.mcp is not None and spec.mcp.attach
        steps = []
        for step in spec.steps:
            metadata = {"agent_role": step.role}
            if spec.label:
                metadata["oracle_key"] = spec.label
            body: dict[str, Any] = {
                "step_id": step.key,
                "runner_profile": step.profile,
                "input": {"prompt": step.prompt},
                "depends_on": list(step.depends_on),
                "input_from": dict(step.input_from),
                "metadata": metadata,
            }
            if step.await_input is not None:
                body["await_input"] = dict(step.await_input)
            elif attach:
                body["input"]["mcp_servers"] = [spec.mcp.server]  # type: ignore[union-attr]
            if step.when is not None:
                body["when"] = dict(step.when)
            steps.append(body)
        out: dict[str, Any] = {
            "steps": steps,
            "on_step_failure": "fail_workflow",
            # `when` gates need collect.
            "strategy": "collect",
        }
        if attach:
            out["mcp_credentials"] = {
                spec.mcp.server: {  # type: ignore[union-attr]
                    "value": spec.mcp.token,  # type: ignore[union-attr]
                    "expires_in": spec.mcp.expires_in,  # type: ignore[union-attr]
                }
            }
        return out

    async def submit(self, spec: WorkflowSpec) -> str:
        body = self.submission_body(spec)
        async with self._client() as client:
            try:
                resp = await self._call(client, "POST", "/v1/workflows", json=body)
            except RuntimeUnavailable as exc:
                if exc.code == "mcp_unavailable":
                    self.learn("mcp", "off", "SwarmCloud answered 503 mcp_unavailable at submit")
                elif exc.code == "await_input_disabled":
                    self.learn(
                        "await_input", "off", "SwarmCloud answered 422: await-input is disabled"
                    )
                elif exc.code == "mcp_server_unregistered":
                    self.forget_registration()
                raise
        workflow = _json(resp).get("workflow") or {}
        workflow_id = workflow.get("workflow_id")
        if not workflow_id:
            raise RuntimeUnavailable("SwarmCloud accepted the workflow but returned no id")
        if spec.mcp is not None and spec.mcp.attach:
            self.learn("mcp", "on")
        if spec.waits:
            self.learn("await_input", "on")
        return str(workflow_id)

    async def find_by_label(self, label: str, since: datetime | None = None) -> str | None:
        """The workflow whose steps carry ``oracle_key`` = ``label``, from Oracle's own
        tasks, newest first. Only ``submitted_by`` is sent: SwarmCloud applies it in the
        query, so pages are exact, while any other filter (state, runner_profile,
        workflow_id) is applied after the cursor and pages come back short.

        None when the listing ended without it, or, given ``since`` (when Oracle sent the
        submission), at the first task created before ``since`` less the skew margin: the
        listing is newest first, so the submission, had it landed, came before that. The
        margin is :data:`CLOCK_SKEW` plus how far Oracle's clock is ahead of SwarmCloud's
        (its ``Date`` header), so a task stamped by a clock behind Oracle's is never taken
        for an older one. The order is checked as the rows come: a row newer than one
        before it means the listing is not newest first, and then no row's time concludes
        anything (the search runs to its end or its page limit, and the caller's attempt
        cap applies). A search that could not finish (a repeated cursor, an odd body, more
        pages than Oracle reads without reaching an older task) raises, so that the caller
        holds the submission and looks again instead of submitting a duplicate."""
        params: dict[str, str | int] = {"submitted_by": "me", "limit": TASK_PAGE}
        seen: set[str] = set()
        cutoff: datetime | None = None
        previous: datetime | None = None
        ordered = True
        async with self._client() as client:
            for _ in range(MAX_TASK_PAGES):
                resp = await self._call(client, "GET", "/v1/tasks", params=params)
                if since is not None and cutoff is None:
                    cutoff = since - CLOCK_SKEW - _ahead(resp)
                body = _json(resp)
                rows = body.get("tasks", body.get("items"))
                if not isinstance(rows, list):
                    raise _inconclusive(label, "SwarmCloud's task listing had no rows")
                older = False
                for row in rows:
                    if not isinstance(row, dict):
                        continue
                    meta = row.get("metadata") if isinstance(row.get("metadata"), dict) else {}
                    if meta.get("oracle_key") == label and row.get("workflow_id"):
                        return str(row["workflow_id"])
                    created = _parse_time(row.get("created_at"))
                    if created is None:
                        continue
                    if previous is not None and created > previous:
                        ordered = False
                    previous = created
                    if cutoff is not None and created < cutoff:
                        older = True
                if older and ordered:
                    # Past where the submission would be: it was never created.
                    return None
                token = body.get("next_page_token") or body.get("page_token")
                if not isinstance(token, str) or not token:
                    return None
                if token in seen:
                    log.warning("SwarmCloud repeated a task listing cursor; stopped looking")
                    raise _inconclusive(label, "SwarmCloud repeated a task listing cursor")
                seen.add(token)
                params = {"submitted_by": "me", "limit": TASK_PAGE, "page_token": token}
        log.warning(
            "submission %s not among Oracle's last %d tasks", label, TASK_PAGE * MAX_TASK_PAGES
        )
        why = (
            "and the listing is not newest first, so no task's time rules it out"
            if not ordered
            else "and none of them is older than the submission"
        )
        raise _inconclusive(
            label,
            f"not among Oracle's last {TASK_PAGE * MAX_TASK_PAGES} tasks, {why}; not looked "
            "further",
        )

    async def answer(
        self,
        workflow_id: str,
        step_id: str,
        *,
        answer_id: str,
        payload: dict[str, Any],
        on_behalf_of: str | None = None,
    ) -> Answer:
        body: dict[str, Any] = {"answer_id": answer_id, "payload": payload, "via": "mcp"}
        if on_behalf_of:
            body["on_behalf_of"] = on_behalf_of[:254]
        path = f"/v1/workflows/{workflow_id}/steps/{step_id}/input"
        async with self._client() as client:
            try:
                resp = await self._call(client, "POST", path, json=body)
            except RuntimeUnavailable as exc:
                # A replay is only ever a 200: a 409 already_answered means this post was
                # not recorded (another answer, or an earlier different one of Oracle's,
                # was), whatever its answer_id.
                # Nor does it show that Oracle may answer: it is no answer of Oracle's.
                if exc.code == "person_required":
                    # Kept off until SwarmCloud reports service answers on (workflow.ADVICE).
                    self.learn(
                        "service_answer",
                        "off",
                        "SwarmCloud answered 403 person_required: Oracle's principal may not "
                        "answer yet",
                        sticky=True,
                    )
                raise
        self.learn("service_answer", "on")
        return Answer(replayed=_json(resp).get("replayed") is True)

    async def answer_record(self, workflow_id: str, step_id: str, artifact: str) -> RecordedAnswer:
        """``GET .../input`` for the wait's state and who answered, and the verdict from
        the waiting step's form ``artifact`` (the record's sha256 is over SwarmCloud's own
        re-serialised form, never Oracle's bytes, so it is not compared). Bodies of any
        shape are read defensively: an odd one gives no verdict, never an error."""
        async with self._client() as client:
            body = _json(
                await self._call(
                    client, "GET", f"/v1/workflows/{workflow_id}/steps/{step_id}/input"
                )
            )
            state = body.get("state") if isinstance(body.get("state"), str) else None
            record = body.get("answer") if isinstance(body.get("answer"), dict) else {}
            form: Any = None
            if record or state == "answered":
                task_id = _task_of(
                    _json(await self._call(client, "GET", f"/v1/workflows/{workflow_id}")),
                    step_id,
                )
                if task_id:
                    try:
                        raw = await self._read_limited(
                            client,
                            f"/v1/tasks/{task_id}/artifacts/raw",
                            {"name": artifact},
                            MAX_FORM_BYTES,
                        )
                        form = json.loads(raw) if raw is not None else None
                    except RuntimeUnavailable as exc:
                        if exc.retryable:
                            raise
                    except ValueError:
                        form = None
            principal = await self._resolve_principal(client)
        form = form if isinstance(form, dict) else {}
        verdict = form.get("verdict")
        items = form.get("findings") if isinstance(form.get("findings"), list) else []
        findings = [f for f in items if isinstance(f, str | int | float)]

        def text(key: str) -> str | None:
            value = record.get(key)
            return _redact(str(value)) if isinstance(value, str | int) and value != "" else None

        answered_by, via = text("answered_by"), text("via")
        raw_by = record.get("answered_by")
        return RecordedAnswer(
            answer_id=text("answer_id"),
            answered_by=answered_by,
            on_behalf_of=text("on_behalf_of"),
            answered_at=_parse_time(record.get("answered_at")),
            via=via,
            verdict=verdict if verdict in (MERGE, NOT_YET) else None,
            # Whole: they go to the agents as the change request (only logs are clipped).
            findings=tuple(redact_whole(str(f)) for f in findings[:MAX_FINDINGS]),
            state=_redact(state) if state else ("answered" if record else None),
            # Posted by Oracle: its own principal, through the channel it posts with.
            by_oracle=bool(principal) and answered_by == principal and via == "mcp",
            answered_by_altered=answered_by is not None and answered_by != str(raw_by),
        )

    async def _read_limited(
        self, client: httpx.AsyncClient, path: str, params: dict[str, str], limit: int
    ) -> bytes | None:
        """A GET body of at most ``limit`` bytes, streamed: None, without reading on,
        when its Content-Length or the bytes received pass the limit. A refusal is read
        first, whatever its size (at most :data:`MAX_ERROR_BYTES` of it), and raised: an
        error is never "too large to read", whatever ``limit`` is. A successful body that
        cannot be decoded (a broken gzip) is None too: SwarmCloud served it, and what it
        served cannot be read (never "lost", which would be read again forever); a
        connection lost while reading is RuntimeUnavailable."""
        headers = {"Authorization": await self._auth.header(client)}
        request = client.build_request("GET", path, params=params, headers=headers)
        try:
            resp = await client.send(request, stream=True)
        except httpx.HTTPError as exc:
            sent = not _never_sent(exc)
            raise RuntimeUnavailable(
                f"cannot reach SwarmCloud (GET {path}): {type(exc).__name__}", lost=sent
            ) from None
        failed = resp.status_code >= 400
        body = bytearray()
        try:
            declared = resp.headers.get("content-length", "")
            if not failed and declared.isdigit() and int(declared) > limit:
                return None
            async for chunk in resp.aiter_bytes():
                body += chunk
                if failed and len(body) >= MAX_ERROR_BYTES:
                    del body[MAX_ERROR_BYTES:]
                    break
                if not failed and len(body) > limit:
                    return None
        except httpx.DecodingError:
            if not failed:
                log.warning("SwarmCloud served GET %s in an encoding that does not decode", path)
                return None
            body = bytearray()  # a refusal whose body did not decode: its status says enough
        except httpx.HTTPError as exc:
            if not failed:
                raise RuntimeUnavailable(
                    f"cannot read SwarmCloud's answer (GET {path}): {type(exc).__name__}",
                    lost=True,
                ) from None
            body = bytearray()  # a refusal whose body did not read: its status says enough
        finally:
            await resp.aclose()
        if failed:
            # A refusal: read as any other call's, from the bytes received (decoded
            # already, so no Content-Encoding header goes with them).
            kept = {
                k: v
                for k, v in resp.headers.items()
                if k.lower() not in ("content-encoding", "content-length", "transfer-encoding")
            }
            raise _refusal(
                httpx.Response(resp.status_code, headers=kept, content=bytes(body)), "GET", path
            )
        return bytes(body)

    async def whoami(self) -> dict[str, str | None]:
        # One deadline for the whole check (minting the token included): httpx's timeout
        # applies to each phase separately, so a slow server could hold it much longer.
        try:
            async with asyncio.timeout(self._timeout):
                async with self._client() as client:
                    resp = await self._call(client, "GET", "/v1/tenants/me")
        except TimeoutError:
            raise RuntimeUnavailable(
                f"SwarmCloud did not answer /v1/tenants/me within {self._timeout:g} s"
            ) from None
        try:
            body = resp.json()
        except ValueError:
            raise RuntimeUnavailable("SwarmCloud answered /v1/tenants/me without JSON") from None
        if not isinstance(body, dict):
            raise RuntimeUnavailable("SwarmCloud answered /v1/tenants/me with an unexpected body")
        tenant = body.get("tenant") if isinstance(body.get("tenant"), dict) else body
        tenant_id = tenant.get("tenant_id") or tenant.get("id")
        return {"tenant_id": None if tenant_id is None else str(tenant_id)}

    async def _read(self, workflow_id: str) -> dict[str, Any]:
        async with self._client() as client:
            resp = await self._call(client, "GET", f"/v1/workflows/{workflow_id}")
        return _json(resp)

    @staticmethod
    def _cost(payload: dict[str, Any]) -> Decimal:
        total = Decimal(0)
        for task in payload.get("tasks") or []:
            value = task.get("cost_usd_total")
            if value is not None:
                total += Decimal(str(value))
        return total

    async def status(self, workflow_id: str) -> WorkflowStatus:
        payload = await self._read(workflow_id)
        raw = str((payload.get("workflow") or {}).get("state") or "").upper()
        state = _STATES.get(raw, "running")
        tasks = {str(t.get("id")): t for t in payload.get("tasks") or [] if t.get("id")}
        steps: list[StepStatus] = []
        parked: list[Parked] = []
        for row in (payload.get("workflow") or {}).get("steps") or []:
            step_id = str(row.get("step_id") or "")
            task_id = row.get("task_id")
            task = tasks.get(str(task_id)) if task_id else None
            # The task's own state; the row's (or PENDING) is only shown. A step whose
            # task is missing or has no state of its own was not read: it holds (W5).
            own = str((task or {}).get("state") or "").upper()
            task_state = own or str(row.get("state") or "PENDING").upper()
            steps.append(
                StepStatus(
                    step_id,
                    task_id,
                    task_state,
                    _redact(str(task["last_error"])) if (task or {}).get("last_error") else None,
                    str(task["park_reason"])
                    if own == "PARKED" and (task or {}).get("park_reason")
                    else None,
                    task_read=bool(own),
                    wait_opened=bool(
                        (((task or {}).get("metadata") or {}).get("await_input") or {}).get(
                            "opened_at"
                        )
                    ),
                )
            )
            if task is not None and task_state == "PARKED":
                waiting = (task.get("metadata") or {}).get("await_input") or {}
                parked.append(
                    Parked(
                        step_id=step_id,
                        task_id=str(task_id),
                        reason=str(task.get("park_reason") or ""),
                        opened_at=_parse_time(waiting.get("opened_at")),
                        expires_at=_parse_time(waiting.get("expires_at")),
                    )
                )
        error = code = None
        if state == "failed":
            failed = [
                t
                for t in tasks.values()
                if _STATES.get(str(t.get("state")).upper()) == "failed"
                and (t.get("last_error") or t.get("error_code"))
            ]
            if failed:
                raw_error = str(failed[0].get("last_error") or failed[0].get("error_code"))
                raw_code = failed[0].get("error_code")
                code = _redact(str(raw_code)) if raw_code else _known_code(raw_error)
                error = _redact(raw_error)
            else:
                error = f"workflow ended {_redact(raw)}"
        return WorkflowStatus(
            state,
            self._cost(payload),
            error,
            error_code=code,
            steps=tuple(steps),
            parked=tuple(parked),
        )

    async def cost(self, workflow_id: str) -> Decimal:
        return self._cost(await self._read(workflow_id))

    async def artifacts(
        self, workflow_id: str, steps: tuple[str, ...] | None = None
    ) -> dict[str, str]:
        payload = await self._read(workflow_id)
        rows = (payload.get("workflow") or {}).get("steps") or []
        if steps is not None:
            rows = [r for r in rows if r.get("step_id") in steps]
            task_ids = [r.get("task_id") for r in rows if r.get("task_id")]
        else:
            order = [r.get("task_id") for r in rows]
            task_ids = [t for t in order if t] or [t.get("id") for t in payload.get("tasks") or []]
        files: dict[str, str] = {}
        async with self._client() as client:
            # Step order: a later step's file of the same name wins (the revised draft).
            for task_id in task_ids:
                listing = _json(await self._call(client, "GET", f"/v1/tasks/{task_id}/artifacts"))
                for entry in listing.get("artifacts") or []:
                    name = entry.get("name") or ""
                    if entry.get("role") or not name.lower().endswith(TEXT_SUFFIXES):
                        continue
                    resp = await self._call(
                        client, "GET", f"/v1/tasks/{task_id}/artifacts/raw", params={"name": name}
                    )
                    if len(resp.content) > MAX_ARTIFACT_BYTES:
                        continue
                    files[name.rsplit("/", 1)[-1]] = resp.content.decode("utf-8", "replace")
        return files

    async def cancel(self, workflow_id: str) -> None:
        async with self._client() as client:
            await self._call(client, "POST", f"/v1/workflows/{workflow_id}/cancel")


def _refusal(resp: httpx.Response, method: str, path: str) -> RuntimeUnavailable:
    """A SwarmCloud error response as the exception every call raises."""
    # Redacted before anything keeps them: the code and the detail end up in a run's
    # workflow state, its checkpoint's payload and its notes.
    raw_code = _code(resp)
    code = _redact(raw_code) if raw_code else None
    detail = _detail(resp)
    if code and code not in detail:
        detail = f"{code}: {detail}" if detail else code
    envelope = _json(resp).get("detail")
    return RuntimeUnavailable(
        f"SwarmCloud refused {method} {path}: HTTP {resp.status_code} {detail}",
        code=code,
        status=resp.status_code,
        # A 5xx may have landed (a submit is not idempotent) unless SwarmCloud's own
        # envelope names a refusal the contract lists: those wrote nothing. A body that is
        # not that envelope (a proxy's page) proves nothing.
        lost=resp.status_code >= 500
        and not (code in DEFINITE_REFUSALS and _enveloped(resp, raw_code)),
        detail=redact(envelope) if isinstance(envelope, dict) else None,
        # Only SwarmCloud's own envelope says a thing does not exist; a bare 404 (a
        # proxy's page, a changed URL or principal) proves nothing and is retryable.
        gone=resp.status_code == 404 and raw_code == "not_found" and _enveloped(resp, raw_code),
    )


def mcp_server_body(url: str) -> dict[str, Any]:
    """Oracle's MCP server registration, exactly as the contract gives it."""
    return {
        "name": MCP_SERVER,
        "url": url,
        "transport": "streamable-http",
        "description": "Oracle knowledge",
        "auth": {"mode": "dispatch", "header": "Authorization", "scheme": "Bearer"},
        "allowed_profiles": ["claude-code"],
        "allowed_tools": [],
        "enabled": True,
        "limits": {
            "max_request_bytes": 1048576,
            "max_response_bytes": 4194304,
            "calls_per_minute": 60,
            "call_timeout_seconds": 60,
        },
    }


def _task_of(payload: dict[str, Any], step_id: str) -> str | None:
    """The task id of ``step_id`` in a ``GET /v1/workflows/{id}`` body of any shape."""
    workflow = payload.get("workflow")
    rows = workflow.get("steps") if isinstance(workflow, dict) else None
    for row in rows if isinstance(rows, list) else []:
        if isinstance(row, dict) and row.get("step_id") == step_id:
            task_id = row.get("task_id")
            return task_id if isinstance(task_id, str) and task_id else None
    return None


def _json(resp: httpx.Response) -> dict[str, Any]:
    try:
        body = resp.json()
    except ValueError:
        return {}
    return body if isinstance(body, dict) else {"items": body}


# Codes the contract names; found in an error message when no code field carries them.
KNOWN_CODES = (
    "mcp_server_unregistered",
    "mcp_server_profile_refused",
    "mcp_credential_missing",
    "mcp_credential_unexpected",
    "mcp_credential_shape",
    "mcp_credential_expired",
    "mcp_server_withheld",
    "mcp_unavailable",
    "already_answered",
    "not_open",
    "expired",
    "person_required",
)
# 5xx reasons that say nothing was written (the call is refused, not lost).
DEFINITE_REFUSALS = frozenset(
    {*KNOWN_CODES, "await_input_disabled", "membership_unavailable", "role_unavailable"}
)
# Reasons that say no more than the HTTP status: the message is read for what it means.
GENERIC_REASONS = frozenset(
    {
        "bad_request",
        "conflict",
        "error",
        "forbidden",
        "invalid_request",
        "not_found",
        "unavailable",
        "unprocessable_entity",
        "validation_error",
    }
)
_AWAIT_DISABLED = re.compile(r"(?i)await[-_ ]input'?\s+is\s+disabled")


def _known_code(text: str) -> str | None:
    if _AWAIT_DISABLED.search(text):
        return "await_input_disabled"
    for code in KNOWN_CODES:
        if re.search(rf"\b{code}\b", text):
            return code
    return None


def _code(resp: httpx.Response) -> str | None:
    """What a refusal means: ``detail.reason`` of SwarmCloud's envelope (``{"code",
    "message", "detail": {"reason", ...}}``), never overridden by message text (which may
    echo input); then, for a generic reason or none, the await-input switch named in the
    message; then a specific top-level code (``already_answered`` over a generic
    ``conflict`` reason); then the generic reason or code."""
    body = _json(resp)
    detail = body.get("detail")
    holders = (detail if isinstance(detail, dict) else {}, body)
    reason = holders[0].get("reason")
    if isinstance(reason, str) and reason and reason not in GENERIC_REASONS:
        return reason
    messages = " ".join(str(h.get("message") or "") for h in holders)
    if _AWAIT_DISABLED.search(messages):
        return "await_input_disabled"
    generic: str | None = None
    for keys in (("reason",), ("code", "error")):
        for holder in holders:
            for key in keys:
                value = holder.get(key)
                if isinstance(value, str) and value:
                    if value not in GENERIC_REASONS:
                        return value
                    generic = generic or value
    if generic:
        return generic
    text = detail if isinstance(detail, str) else (body.get("message") or resp.text[:500])
    return _known_code(str(text))


def _enveloped(resp: httpx.Response, code: str | None) -> bool:
    """Whether ``code`` came from SwarmCloud's JSON envelope (its reason or code field),
    not from text found in a body of another shape."""
    try:
        body = resp.json()
    except ValueError:
        return False
    if not isinstance(body, dict) or not code:
        return False
    detail = body.get("detail") if isinstance(body.get("detail"), dict) else {}
    return code in (detail.get("reason"), body.get("code"), body.get("error"))


def _ahead(resp: httpx.Response) -> timedelta:
    """How far Oracle's clock is ahead of SwarmCloud's, from the response's ``Date``
    header (zero when it is behind, or the header is missing or odd)."""
    try:
        theirs = parsedate_to_datetime(resp.headers.get("date", ""))
    except (TypeError, ValueError, IndexError):
        return timedelta(0)
    if theirs is None:
        return timedelta(0)
    if theirs.tzinfo is None:
        theirs = theirs.replace(tzinfo=UTC)
    return max(timedelta(0), datetime.now(UTC) - theirs)


def _inconclusive(label: str, why: str) -> RuntimeUnavailable:
    # Retryable (no HTTP status): the caller holds the submission and looks again.
    return RuntimeUnavailable(f"looking up submission {label} was inconclusive: {why}")


def _detail(resp: httpx.Response) -> str:
    try:
        body = resp.json()
    except ValueError:
        return ""
    if not isinstance(body, dict):
        return ""
    detail = body.get("detail")
    if isinstance(detail, dict):
        detail = detail.get("message") or None
    detail = detail or body.get("message")
    return _redact(str(detail)) if detail else ""


def redact(value: Any) -> Any:
    """``value`` with every string in it redacted (:func:`_redact`), however nested:
    what an upstream sends is never stored as it came."""
    if isinstance(value, str):
        return _redact(value)
    if isinstance(value, dict):
        return {_redact(str(k)): redact(v) for k, v in list(value.items())[:50]}
    if isinstance(value, list | tuple):
        return [redact(v) for v in list(value)[:50]]
    if value is None or isinstance(value, bool | int | float):
        return value
    return _redact(str(value))


def redact_whole(text: str) -> str:
    """``text`` with credential-shaped strings withheld, not clipped: for what goes on to
    the agents (a reviewer's findings), whose size the caller bounds."""
    return _TOKEN_SHAPED.sub("<withheld>", text)


def _redact(text: str) -> str:
    """Withhold credential-shaped strings from upstream text and keep 200 characters."""
    if len(text) > _DETAIL_SCAN_CHARS:
        # Scan a bounded prefix, since an upstream may send text of any size. Redaction can
        # shrink what precedes the cut into the 200 kept, so drop the word the cut lands
        # in: a token that lost its tail may no longer match the pattern.
        head = text[:_DETAIL_SCAN_CHARS].rsplit(None, 1)
        text = head[0] if len(head) == 2 else ""
    return _TOKEN_SHAPED.sub("<withheld>", text)[:200]


_DETAIL_SCAN_CHARS = 4096
# What an upstream might echo back in an error: a bearer value however it is joined to
# the word, a JWT, a Google access token, a GitHub token, a token in a git URL, or one of
# Oracle's own tokens (run, API and OAuth).
_TOKEN_SHAPED = re.compile(
    # A bearer value, after a space, ":", "=", a form-encoded "+", a quote (escaped or
    # not), a percent-escape (%20, %0A), or an escaped control character (\n, \u000a,
    # \x0a): a word with a digit or an inner symbol (sc-secret, abc123, token-xyzabc), or
    # a long one; never an ordinary word, or a hyphenated phrase of them, after "bearer"
    # (bearer token handling, bearer token-based auth, the bearer header-only scheme).
    r"(?i:bearer)"
    r"(?:[\s:=+]|\\?[\"']|%[0-9A-Fa-f]{2}|\\[nrtbf]|\\u[0-9A-Fa-f]{4}|\\x[0-9A-Fa-f]{2})+"
    r"(?!(?i:token|tokens|auth|authentication|authorization|scheme|header|credentials?)"
    r"(?:-(?i:based|only|bound|style|less|like|free|types?|formats?|values?|auth"
    r"|authentication|authorization|scheme|header|tokens?|credentials?))*"
    r"(?![A-Za-z0-9_.~+/=%-]))"
    r"(?:(?=[A-Za-z]*(?:[0-9]|[-_.~+/=%][A-Za-z0-9]))\S+|[A-Za-z]{16,}\S*)"
    r"|eyJ[A-Za-z0-9_-]{8,}(?:\.[A-Za-z0-9_-]+){0,2}"
    r"|ya29\.[A-Za-z0-9_.-]+"
    r"|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}"
    r"|(?i:x-access-token):[^@\s]+"
    # Oracle's prefixes (run, API, OAuth access, refresh and code), also when joined to a
    # word by an underscore (credential_ort_...), to digits (123ort_...), to a
    # percent-escape (Bearer%20ort_..., %3Dort_..., %2Bpo_...) or to an escaped control
    # character (\nort_..., \u000aort_..., \x0aort_..., \bort_...); never inside a
    # word (support_ticket). Its tokens are random URL-safe text, so the value has a digit
    # or a capital: an identifier made of words (max_po_lines_per_page, por_table) is not.
    r"|(?:(?<![A-Za-z])|(?<=\\[nrtbf])|(?<=\\u[0-9A-Fa-f]{4})|(?<=\\x[0-9A-Fa-f]{2})"
    r"|(?<=%[0-9A-Fa-f]{2}))"
    r"(?:ort|po|poa|por|poc)_(?=[a-z_-]*[A-Z0-9])[A-Za-z0-9_-]{8,}"
)


class UnconfiguredSwarmCloud:
    """SwarmCloud is the runtime but its settings are missing: every call says which."""

    name = "swarmcloud"

    def __init__(self, problem: str) -> None:
        self.problem = problem

    @property
    def can_reach_oracle(self) -> bool:
        return False

    def notes(self) -> list[str]:
        return [f"SwarmCloud is not configured, so runs cannot start: {self.problem}."]

    def _refuse(self) -> RuntimeUnavailable:
        return RuntimeUnavailable(f"SwarmCloud is not configured: {self.problem}")

    async def submit(self, spec: WorkflowSpec) -> str:
        raise self._refuse()

    async def whoami(self) -> dict[str, str | None]:
        raise self._refuse()

    async def status(self, workflow_id: str) -> WorkflowStatus:
        raise self._refuse()

    async def cost(self, workflow_id: str) -> Decimal:
        raise self._refuse()

    async def artifacts(
        self, workflow_id: str, steps: tuple[str, ...] | None = None
    ) -> dict[str, str]:
        raise self._refuse()

    async def cancel(self, workflow_id: str) -> None:
        raise self._refuse()

    async def features(self, *, refresh: bool = False) -> Features:
        reason = f"SwarmCloud is not configured: {self.problem}"
        return Features(reasons={k: reason for k in FEATURES})

    async def ensure_mcp_server(self, url: str) -> str:
        raise self._refuse()

    async def egress_addresses(self) -> frozenset[str] | None:
        return frozenset()

    async def find_by_label(self, label: str, since: datetime | None = None) -> str | None:
        raise self._refuse()

    async def answer(
        self,
        workflow_id: str,
        step_id: str,
        *,
        answer_id: str,
        payload: dict[str, Any],
        on_behalf_of: str | None = None,
    ) -> Answer:
        raise self._refuse()

    async def answer_record(self, workflow_id: str, step_id: str, artifact: str) -> RecordedAnswer:
        raise self._refuse()
