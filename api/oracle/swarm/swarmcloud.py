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

    GET   /v1/mcp-servers                    caller MCP on (503 mcp_unavailable: off), and
                                             SwarmCloud's egress_addresses
    GET   /v1/mcp-servers/oracle             registration, then POST or PATCH it
    GET   /v1/capacity                       await-input and service answers, when reported
    GET   /v1/workflows?label=...            a submission whose answer was lost
    POST  /v1/workflows/{id}/steps/{step}/input   the answer to a wait for a person

While caller MCP is off (or not confirmed), the run token is never sent (a prompt is not a
place for a credential) and every run says so in its notes. Once it is on, the token goes
only in the workflow's ``mcp_credentials``, never in a step's input.
"""

import asyncio
import logging
import re
import time
from dataclasses import dataclass, field
from datetime import UTC, datetime
from decimal import Decimal
from typing import Any, Protocol

import httpx
import jwt

from oracle.swarm.runtime import (
    AWAIT_PROFILE,
    FEATURES,
    MCP_SERVER,
    Answer,
    Features,
    FeatureState,
    Parked,
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
METADATA_IDENTITY_URL = (
    "http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/identity"
)
METADATA_TOKEN_URL = (
    "http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token"
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


@dataclass
class GoogleIdToken:
    """An ID token for ``audience`` from the metadata server, cached until near expiry."""

    audience: str
    url: str = METADATA_IDENTITY_URL
    _token: str | None = field(default=None, repr=False)
    _expires_at: float = 0.0

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
        return f"Bearer {self._token}"


@dataclass
class GoogleAccessToken:
    """The service account's OAuth access token from the metadata server, cached until near
    expiry. An IAP front door that uses a Google-managed OAuth client accepts this, not an
    ID token."""

    url: str = METADATA_TOKEN_URL
    _token: str | None = field(default=None, repr=False)
    _expires_at: float = 0.0

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
        # reason, until). It outlives one cached reading, not the TTL after it.
        self._learned: dict[str, tuple[FeatureState, str, float]] = {}
        self._egress: frozenset[str] | None = None
        self._egress_until = 0.0
        self._egress_lock = asyncio.Lock()
        self._registered_url: str | None = None

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
        )

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

    def learn(self, feature: str, state: FeatureState, reason: str = "") -> None:
        """Record what a call showed about a feature (kept for the cache's lifetime)."""
        self._learned[feature] = (state, reason, time.monotonic() + max(self._features_ttl, 1))

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
                reasons["mcp"] = (
                    "SwarmCloud answers 503 mcp_unavailable: caller MCP (#1433) is switched off"
                    if exc.code == "mcp_unavailable"
                    else "SwarmCloud has no /v1/mcp-servers yet"
                )
            else:
                reasons["mcp"] = str(exc)
            return
        states["mcp"] = "on"
        self._take_egress(_json(resp))

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
        addresses = body.get("egress_addresses") if isinstance(body, dict) else None
        if isinstance(addresses, list):
            self._egress = frozenset(str(a).strip() for a in addresses if str(a).strip())
            self._egress_until = time.monotonic() + self._egress_refresh

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
        if self._registered_url == url:
            return "unchanged"
        async with self._client() as client:
            try:
                resp = await self._call(client, "GET", f"/v1/mcp-servers/{MCP_SERVER}")
            except RuntimeUnavailable as exc:
                if exc.status != 404:
                    raise
                await self._call(client, "POST", "/v1/mcp-servers", json=mcp_server_body(url))
                result = "created"
            else:
                current = _json(resp)
                server = current.get("server", current) if isinstance(current, dict) else {}
                if isinstance(server, dict) and server.get("url") == url:
                    result = "unchanged"
                else:
                    await self._call(
                        client, "PATCH", f"/v1/mcp-servers/{MCP_SERVER}", json={"url": url}
                    )
                    result = "updated"
        self._registered_url = url
        return result

    def forget_registration(self) -> None:
        """SwarmCloud says the server is not registered: register again before next use."""
        self._registered_url = None

    # ------------------------------------------------------------------ calls

    def _client(self) -> httpx.AsyncClient:
        return httpx.AsyncClient(
            base_url=self._base_url,
            timeout=self._timeout,
            transport=self._transport,
            headers={"User-Agent": "product-oracle"},
        )

    async def _call(
        self, client: httpx.AsyncClient, method: str, path: str, **kwargs: Any
    ) -> httpx.Response:
        # No X-Swarm-Tenant: Oracle's service tenant is the default, and naming it is a 403.
        headers = {"Authorization": await self._auth.header(client), **kwargs.pop("headers", {})}
        try:
            resp = await client.request(method, path, headers=headers, **kwargs)
        except httpx.HTTPError as exc:
            # A connection never made sent nothing; anything later may have arrived.
            sent = not isinstance(exc, httpx.ConnectError | httpx.ConnectTimeout)
            raise RuntimeUnavailable(
                f"cannot reach SwarmCloud ({method} {path}): {type(exc).__name__}", lost=sent
            ) from None
        if resp.status_code >= 400:
            code = _code(resp)
            detail = _detail(resp)
            if code and code not in detail:
                detail = f"{code}: {detail}" if detail else code
            raise RuntimeUnavailable(
                f"SwarmCloud refused {method} {path}: HTTP {resp.status_code} {detail}",
                code=code,
                status=resp.status_code,
                lost=resp.status_code >= 500 and code is None,
            )
        return resp

    def submission_body(self, spec: WorkflowSpec) -> dict[str, Any]:
        """The ``POST /v1/workflows`` body for ``spec`` (the run token included when the
        spec attaches Oracle's MCP server)."""
        attach = spec.mcp is not None and spec.mcp.attach
        steps = []
        for step in spec.steps:
            body: dict[str, Any] = {
                "step_id": step.key,
                "runner_profile": step.profile,
                "input": {"prompt": step.prompt},
                "depends_on": list(step.depends_on),
                "input_from": dict(step.input_from),
                "metadata": {"agent_role": step.role},
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
            "metadata": {
                "client": "product-oracle",
                "workflow": spec.name,
                **spec.labels,
                **({"label": spec.label} if spec.label else {}),
            },
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

    async def find_by_label(self, label: str) -> str | None:
        async with self._client() as client:
            resp = await self._call(client, "GET", "/v1/workflows", params={"label": label})
        body = _json(resp)
        rows = body.get("workflows") if isinstance(body, dict) else body
        for row in rows if isinstance(rows, list) else []:
            wf = row.get("workflow", row) if isinstance(row, dict) else {}
            if not isinstance(wf, dict):
                continue
            # Matched here too: a SwarmCloud that ignores the filter lists everything.
            if (wf.get("metadata") or {}).get("label") == label and wf.get("workflow_id"):
                return str(wf["workflow_id"])
        return None

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
                if exc.code == "person_required":
                    self.learn(
                        "service_answer",
                        "off",
                        "SwarmCloud answered person_required: Oracle's principal may not "
                        "answer yet",
                    )
                if exc.status == 409 and await self._is_replay(client, path, answer_id, payload):
                    self.learn("service_answer", "on")
                    return Answer(replayed=True)
                raise
        self.learn("service_answer", "on")
        return Answer(replayed=bool(_json(resp).get("replayed")))

    async def _is_replay(
        self, client: httpx.AsyncClient, path: str, answer_id: str, payload: dict[str, Any]
    ) -> bool:
        """Whether a 409 is our own answer already recorded (same id, same payload)."""
        try:
            resp = await self._call(client, "GET", path)
        except RuntimeUnavailable:
            return False
        body = _json(resp)
        answer = body.get("answer") if isinstance(body.get("answer"), dict) else body
        return answer.get("answer_id") == answer_id and answer.get("payload") in (None, payload)

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
            task_state = str((task or {}).get("state") or row.get("state") or "PENDING").upper()
            steps.append(
                StepStatus(
                    step_id,
                    task_id,
                    task_state,
                    _redact(str(task["last_error"])) if (task or {}).get("last_error") else None,
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
                code = failed[0].get("error_code") or _known_code(raw_error)
                error = _redact(raw_error)
            else:
                error = f"workflow ended {raw}"
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
_AWAIT_DISABLED = re.compile(r"(?i)await[-_ ]input'?\s+is\s+disabled")


def _known_code(text: str) -> str | None:
    if _AWAIT_DISABLED.search(text):
        return "await_input_disabled"
    for code in KNOWN_CODES:
        if re.search(rf"\b{code}\b", text):
            return code
    return None


def _code(resp: httpx.Response) -> str | None:
    body = _json(resp)
    detail = body.get("detail")
    for holder in (detail if isinstance(detail, dict) else {}, body):
        for key in ("code", "error"):
            value = holder.get(key)
            if isinstance(value, str) and value:
                if _AWAIT_DISABLED.search(str(holder.get("message") or "")):
                    return "await_input_disabled"
                return value
    text = detail if isinstance(detail, str) else (body.get("message") or resp.text[:500])
    return _known_code(str(text))


def _detail(resp: httpx.Response) -> str:
    try:
        body = resp.json()
    except ValueError:
        return ""
    detail = body.get("detail") if isinstance(body, dict) else None
    if isinstance(detail, dict):
        detail = detail.get("message") or detail.get("code")
    return _redact(str(detail)) if detail else ""


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
    r"(?i)bearer[\s:=]+\S+"
    r"|eyJ[A-Za-z0-9_-]{8,}(?:\.[A-Za-z0-9_-]+){0,2}"
    r"|ya29\.[A-Za-z0-9_.-]+"
    r"|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}"
    r"|x-access-token:[^@\s]+"
    r"|\b(?:ort|po|poa)_[A-Za-z0-9_-]{8,}"
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

    async def find_by_label(self, label: str) -> str | None:
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
