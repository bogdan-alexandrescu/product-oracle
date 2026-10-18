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

Until SwarmCloud #1433 lands, a dispatch cannot attach an MCP server or a credential,
so agents cannot reach Oracle's data: the run token is never sent (a prompt is not a
place for a credential) and every run says so in its notes.
"""

import time
from dataclasses import dataclass, field
from decimal import Decimal
from typing import Any, Protocol

import httpx
import jwt

from oracle.swarm.runtime import (
    RuntimeUnavailable,
    WorkflowSpec,
    WorkflowState,
    WorkflowStatus,
)
from oracle.swarm.settings import RuntimeSettings

NO_MCP_NOTE = (
    "SwarmCloud cannot attach Oracle's MCP server or a run token to a task yet "
    "(SwarmCloud #1433), so agents cannot read Oracle's sources, baseline or documents: "
    "they work from their prompts only."
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


class SwarmCloudRuntime:
    name = "swarmcloud"

    def __init__(
        self,
        base_url: str,
        auth: Auth,
        *,
        timeout: float = 30.0,
        transport: httpx.AsyncBaseTransport | None = None,
    ) -> None:
        if not base_url:
            raise ValueError("ORACLE_SWARMCLOUD_URL is required for the swarmcloud runtime")
        self._base_url = base_url.rstrip("/")
        self._auth = auth
        self._timeout = timeout
        self._transport = transport

    @classmethod
    def from_settings(cls, settings: RuntimeSettings) -> "SwarmCloudRuntime":
        if not settings.swarmcloud_url:
            raise ValueError("ORACLE_SWARMCLOUD_URL is required for the swarmcloud runtime")
        return cls(
            settings.swarmcloud_url,
            auth_from_settings(settings),
            timeout=settings.swarmcloud_timeout_seconds,
        )

    @property
    def can_reach_oracle(self) -> bool:
        return False

    def notes(self) -> list[str]:
        return [NO_MCP_NOTE]

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
        headers = {"Authorization": await self._auth.header(client), **kwargs.pop("headers", {})}
        try:
            resp = await client.request(method, path, headers=headers, **kwargs)
        except httpx.HTTPError as exc:
            raise RuntimeUnavailable(
                f"cannot reach SwarmCloud ({method} {path}): {type(exc).__name__}"
            ) from None
        if resp.status_code >= 400:
            raise RuntimeUnavailable(
                f"SwarmCloud refused {method} {path}: HTTP {resp.status_code} {_detail(resp)}"
            )
        return resp

    async def submit(self, spec: WorkflowSpec) -> str:
        body = {
            "steps": [
                {
                    "step_id": step.key,
                    "runner_profile": step.profile,
                    "input": {"prompt": step.prompt},
                    "depends_on": list(step.depends_on),
                    "input_from": dict(step.input_from),
                    "metadata": {"agent_role": step.role},
                }
                for step in spec.steps
            ],
            "on_step_failure": "fail_workflow",
            "strategy": "collect",
            "metadata": {"client": "product-oracle", "workflow": spec.name, **spec.labels},
        }
        # spec.mcp is deliberately not sent: see NO_MCP_NOTE.
        async with self._client() as client:
            resp = await self._call(client, "POST", "/v1/workflows", json=body)
        workflow = resp.json().get("workflow") or {}
        workflow_id = workflow.get("workflow_id")
        if not workflow_id:
            raise RuntimeUnavailable("SwarmCloud accepted the workflow but returned no id")
        return str(workflow_id)

    async def _read(self, workflow_id: str) -> dict[str, Any]:
        async with self._client() as client:
            resp = await self._call(client, "GET", f"/v1/workflows/{workflow_id}")
        return resp.json()

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
        error = None
        if state == "failed":
            errors = [
                t.get("last_error")
                for t in payload.get("tasks") or []
                if t.get("last_error") and _STATES.get(str(t.get("state")).upper()) == "failed"
            ]
            error = errors[0] if errors else f"workflow ended {raw}"
        return WorkflowStatus(state, self._cost(payload), error)

    async def cost(self, workflow_id: str) -> Decimal:
        return self._cost(await self._read(workflow_id))

    async def artifacts(self, workflow_id: str) -> dict[str, str]:
        payload = await self._read(workflow_id)
        order = [s.get("task_id") for s in (payload.get("workflow") or {}).get("steps") or []]
        task_ids = [t for t in order if t] or [t.get("id") for t in payload.get("tasks") or []]
        files: dict[str, str] = {}
        async with self._client() as client:
            # Step order: a later step's file of the same name wins (the revised draft).
            for task_id in task_ids:
                listing = (await self._call(client, "GET", f"/v1/tasks/{task_id}/artifacts")).json()
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


def _detail(resp: httpx.Response) -> str:
    try:
        body = resp.json()
    except ValueError:
        return ""
    detail = body.get("detail") if isinstance(body, dict) else None
    if isinstance(detail, dict):
        detail = detail.get("message") or detail.get("code")
    return str(detail)[:200] if detail else ""


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

    async def status(self, workflow_id: str) -> WorkflowStatus:
        raise self._refuse()

    async def cost(self, workflow_id: str) -> Decimal:
        raise self._refuse()

    async def artifacts(self, workflow_id: str) -> dict[str, str]:
        raise self._refuse()

    async def cancel(self, workflow_id: str) -> None:
        raise self._refuse()
