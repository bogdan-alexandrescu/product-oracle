"""A fake SwarmCloud API for adapter v2 tests, served through ``httpx.MockTransport``.

It follows docs/swarmcloud-interface.md: the two switches (caller MCP, await-input) and
service answers, the MCP server registry with its egress addresses, workflow submission
with its refusals, a small step engine (agent steps finish when polled, ``await-input``
steps park until answered or expired, ``when`` gates, skipped dependants), answers with
replay and 409, artifacts by task, cancel and labels. What it cannot know about the real
service is listed in the adapter v2 report.

    swarm = FakeSwarmCloud(mcp=True, await_input=True, service_answer=True)
    runtime = swarm.runtime()
"""

import json
import re
import string
from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta
from typing import Any

import httpx

from oracle.swarm import SwarmCloudRuntime
from oracle.swarm.fake import _default_content
from oracle.swarm.swarmcloud import StaticBearer

EGRESS = ("203.0.113.7", "203.0.113.8")
AGENT_COST = 1.5
_WRITE = re.compile(r"Write these files as artifacts: ([^\n]+?)\.\n")
_NOTES = re.compile(r"Write your working notes to (\S+?\.md)")
_PRINTABLE = set(string.printable) - set("\t\n\r\x0b\x0c")


def _err(status: int, code: str, message: str = "") -> httpx.Response:
    return httpx.Response(status, json={"detail": {"code": code, "message": message or code}})


@dataclass
class Step:
    step_id: str
    profile: str
    input: dict[str, Any]
    depends_on: list[str]
    input_from: dict[str, str]
    await_input: dict[str, Any] | None
    when: dict[str, Any] | None
    task_id: str
    state: str = "PENDING"
    park_reason: str | None = None
    opened_at: datetime | None = None
    expires_at: datetime | None = None
    answer: dict[str, Any] | None = None
    answer_state: str = "not_open"
    files: dict[str, str] = field(default_factory=dict)
    staged: dict[str, str] = field(default_factory=dict)
    last_error: str | None = None
    error_code: str | None = None
    cost: float = 0.0


@dataclass
class Workflow:
    workflow_id: str
    body: dict[str, Any]
    steps: list[Step]
    submitted_at: datetime
    credential: dict[str, Any] | None
    state: str = "RUNNING"

    def step(self, step_id: str) -> Step:
        return next(s for s in self.steps if s.step_id == step_id)


class FakeSwarmCloud:
    def __init__(
        self,
        *,
        mcp: bool = False,
        await_input: bool = False,
        service_answer: bool = False,
        report_capacity: bool = True,
        egress: tuple[str, ...] = EGRESS,
    ) -> None:
        self.mcp = mcp
        self.await_input = await_input
        self.service_answer = service_answer
        self.report_capacity = report_capacity
        self.egress = list(egress)
        self.servers: dict[str, dict[str, Any]] = {}
        self.workflows: dict[str, Workflow] = {}
        self.requests: list[httpx.Request] = []
        self.answers: list[dict[str, Any]] = []
        self.now = datetime.now(UTC)
        # Faults to inject, each used once.
        self.lose_next_submit = False  # create the workflow, then lose the answer
        self.fail_next_submit: httpx.Response | None = None  # refuse without creating
        self.lose_next_lookup = False
        self.replay_as_409 = False  # answer a same-body replay with 409, not 200
        self.step_failure: dict[str, tuple[str, str]] = {}  # step_id -> (code, message)
        self._n = 0

    def runtime(self, **kw: Any) -> SwarmCloudRuntime:
        return SwarmCloudRuntime(
            "https://swarm.test", StaticBearer("sc-bearer"), transport=self.transport(), **kw
        )

    def transport(self) -> httpx.MockTransport:
        return httpx.MockTransport(self)

    def tick(self, seconds: float) -> None:
        """Move SwarmCloud's clock (expiry)."""
        self.now += timedelta(seconds=seconds)

    # ------------------------------------------------------------------ routes

    def submissions(self) -> list[dict[str, Any]]:
        return [
            json.loads(r.content)
            for r in self.requests
            if r.method == "POST" and r.url.path == "/v1/workflows"
        ]

    def __call__(self, request: httpx.Request) -> httpx.Response:
        self.requests.append(request)
        if "x-swarm-tenant" in request.headers:
            return _err(403, "tenant_forbidden", "the service tenant is the default")
        if request.headers.get("authorization") != "Bearer sc-bearer":
            return _err(401, "unauthorized")
        path, method = request.url.path, request.method
        body = json.loads(request.content) if request.content else None
        if path == "/v1/tenants/me":
            return httpx.Response(200, json={"tenant": {"tenant_id": "u-or-9a0792"}})
        if path == "/v1/capacity":
            if not self.report_capacity:
                return httpx.Response(404, json={"detail": "no route"})
            return httpx.Response(
                200,
                json={
                    "profiles": [
                        {"name": "claude-code", "available": True},
                        {"name": "await-input", "enabled": self.await_input},
                    ],
                    "features": {"service_answer": {"enabled": self.service_answer}},
                },
            )
        if path.startswith("/v1/mcp-servers"):
            return self._servers(method, path, body)
        if path == "/v1/workflows" and method == "POST":
            return self._submit(body)
        if path == "/v1/workflows" and method == "GET":
            if self.lose_next_lookup:
                self.lose_next_lookup = False
                raise httpx.ReadTimeout("lost", request=request)
            label = request.url.params.get("label")
            rows = [
                {"workflow_id": w.workflow_id, "metadata": w.body.get("metadata") or {}}
                for w in self.workflows.values()
                if (w.body.get("metadata") or {}).get("label") == label
            ]
            return httpx.Response(200, json={"workflows": rows})
        m = re.fullmatch(r"/v1/workflows/([^/]+)(/cancel|/steps/([^/]+)/input)?", path)
        if m:
            wf = self.workflows.get(m[1])
            if wf is None:
                return httpx.Response(404, json={"detail": "no such workflow"})
            if m[2] == "/cancel" and method == "POST":
                return self._cancel(wf)
            if m[3]:
                return self._input(wf, m[3], method, body)
            if method == "GET":
                self._advance(wf)
                return httpx.Response(200, json=self._view(wf))
        m = re.fullmatch(r"/v1/tasks/([^/]+)/artifacts(/raw)?", path)
        if m:
            step = self._task(m[1])
            if step is None:
                return httpx.Response(404, json={"detail": "no such task"})
            if m[2]:
                name = request.url.params["name"]
                if name not in step.files:
                    return httpx.Response(404, json={"detail": "no such artifact"})
                return httpx.Response(200, text=step.files[name])
            rows = [{"name": n, "role": None} for n in step.files]
            rows.append({"name": "agent.log", "role": "agent_stdout"})
            return httpx.Response(200, json={"artifacts": rows, "complete": True})
        return httpx.Response(404, json={"detail": "no route"})

    def _servers(self, method: str, path: str, body: Any) -> httpx.Response:
        if not self.mcp:
            return _err(503, "mcp_unavailable", "caller MCP is switched off")
        if path == "/v1/mcp-servers" and method == "GET":
            return httpx.Response(
                200, json={"servers": list(self.servers.values()), "egress_addresses": self.egress}
            )
        if path == "/v1/mcp-servers" and method == "POST":
            if body["name"] in self.servers:
                return _err(409, "conflict")
            self.servers[body["name"]] = dict(body)
            return httpx.Response(201, json={"server": body})
        name = path.rsplit("/", 1)[-1]
        server = self.servers.get(name)
        if server is None:
            return _err(404, "not_found")
        if method == "GET":
            return httpx.Response(200, json={"server": server})
        if method == "PATCH":
            server.update(body)
            return httpx.Response(200, json={"server": server})
        return httpx.Response(405)

    def _submit(self, body: dict[str, Any]) -> httpx.Response:
        if self.fail_next_submit is not None:
            resp, self.fail_next_submit = self.fail_next_submit, None
            return resp
        steps = body["steps"]
        if any(s["runner_profile"] == "await-input" for s in steps) and not self.await_input:
            return _err(422, "validation_error", "runner_profile 'await-input' is disabled")
        creds = body.get("mcp_credentials")
        named = {n for s in steps for n in (s.get("input") or {}).get("mcp_servers") or []}
        if (creds or named) and not self.mcp:
            return _err(503, "mcp_unavailable")
        for name in named:
            server = self.servers.get(name)
            if server is None:
                return _err(422, "mcp_server_unregistered", name)
            for s in steps:
                if name in ((s.get("input") or {}).get("mcp_servers") or []) and (
                    s["runner_profile"] not in server["allowed_profiles"]
                ):
                    return _err(403, "mcp_server_profile_refused", s["runner_profile"])
        for name in named:
            if name not in (creds or {}):
                return _err(422, "mcp_credential_missing", name)
        for name, cred in (creds or {}).items():
            if name not in named:
                return _err(422, "mcp_credential_unexpected", name)
            value, ttl = cred.get("value"), cred.get("expires_in")
            if (
                set(cred) != {"value", "expires_in"}
                or not isinstance(value, str)
                or not 8 <= len(value.encode()) <= 8192
                or not set(value) <= _PRINTABLE
                or not isinstance(ttl, int)
                or not 60 <= ttl <= 86400
            ):
                return _err(422, "mcp_credential_shape", name)
        ids = {s["step_id"] for s in steps}
        for s in steps:
            if s.get("when"):
                if body.get("strategy") != "collect":
                    return _err(422, "validation_error", "when needs strategy collect")
                if s["runner_profile"] == "await-input":
                    return _err(422, "validation_error", "an await-input step cannot be gated")
                if s["when"]["step"] not in ids:
                    return _err(422, "validation_error", "when names an unknown step")
            if s["runner_profile"] == "await-input":
                wait = s.get("await_input") or {}
                if not 300 <= int(wait.get("expires_after_seconds", 0)) <= 86400:
                    return _err(422, "validation_error", "expires_after_seconds 300 to 86400")
                if wait.get("on_expire") not in ("fail", "default"):
                    return _err(422, "validation_error", "on_expire")
                if wait.get("remind") != []:
                    return _err(422, "validation_error", "service tenants pass remind: []")
            for dep in [*s.get("depends_on", []), *(s.get("input_from") or {})]:
                if dep not in ids:
                    return _err(422, "validation_error", f"unknown step {dep}")
        self._n += 1
        wid = f"wf_{self._n}"
        wf = Workflow(
            workflow_id=wid,
            body=body,
            steps=[
                Step(
                    step_id=s["step_id"],
                    profile=s["runner_profile"],
                    input=s.get("input") or {},
                    depends_on=list(s.get("depends_on") or []),
                    input_from=dict(s.get("input_from") or {}),
                    await_input=s.get("await_input"),
                    when=s.get("when"),
                    task_id=f"{wid}_t{i + 1}",
                )
                for i, s in enumerate(steps)
            ],
            submitted_at=self.now,
            credential=next(iter(creds.values())) if creds else None,
        )
        self.workflows[wid] = wf
        if self.lose_next_submit:
            self.lose_next_submit = False
            raise httpx.ReadTimeout("the answer was lost")
        return httpx.Response(201, json={"workflow": {"workflow_id": wid}, "dispatch": {}})

    def _task(self, task_id: str) -> Step | None:
        for wf in self.workflows.values():
            for s in wf.steps:
                if s.task_id == task_id:
                    return s
        return None

    def _cancel(self, wf: Workflow) -> httpx.Response:
        if wf.state in ("SUCCEEDED", "FAILED", "CANCELLED"):
            return _err(409, "not_cancellable", f"workflow is {wf.state}")
        wf.state = "CANCELLED"
        for s in wf.steps:
            if s.state in ("PENDING", "RUNNING", "PARKED"):
                if s.state == "PARKED" and s.await_input:
                    s.answer_state = "cancelled"
                s.state = "CANCELLED"
        return httpx.Response(200, json={"tasks_cancelled": [s.task_id for s in wf.steps]})

    def _input(self, wf: Workflow, step_id: str, method: str, body: Any) -> httpx.Response:
        self._advance(wf)
        step = next((s for s in wf.steps if s.step_id == step_id), None)
        if step is None or step.await_input is None:
            return httpx.Response(404, json={"detail": "no such waiting step"})
        if method == "GET":
            return httpx.Response(
                200,
                json={"state": step.answer_state, "answer": step.answer},
            )
        if not self.service_answer:
            return _err(403, "person_required", "only a person may answer this step")
        if step.answer is not None:
            if (
                step.answer["answer_id"] == body["answer_id"]
                and step.answer["payload"] == (body["payload"])
            ):
                if self.replay_as_409:
                    return _err(409, "already_answered")
                return httpx.Response(200, json={"replayed": True, "state": "answered"})
            return _err(409, "already_answered")
        if step.answer_state == "expired":
            return _err(409, "expired")
        if step.answer_state != "waiting":
            return _err(409, "not_open", f"step is {step.answer_state}")
        self.answers.append({"workflow_id": wf.workflow_id, "step_id": step_id, **body})
        step.answer = {
            "answer_id": body["answer_id"],
            "payload": body["payload"],
            "answered_as": "service",
            "source": "person",
            "on_behalf_of": body.get("on_behalf_of"),
        }
        step.answer_state = "answered"
        step.files = {step.await_input["artifact"]: json.dumps(body["payload"])}
        step.state = "SUCCEEDED"
        step.park_reason = None
        self._advance(wf)
        return httpx.Response(200, json={"replayed": False, "state": "answered"})

    # ------------------------------------------------------------------ engine

    def _credential_live(self, wf: Workflow) -> bool:
        if wf.credential is None:
            return True
        return self.now < wf.submitted_at + timedelta(seconds=wf.credential["expires_in"])

    def _advance(self, wf: Workflow) -> None:
        if wf.state != "RUNNING":
            return
        changed = True
        while changed:
            changed = False
            for s in wf.steps:
                if s.state == "PARKED" and s.await_input and self.now >= s.expires_at:
                    s.state = "DEAD_LETTERED"
                    s.answer_state = "expired"
                    s.error_code = "expired"
                    s.last_error = "expired: nobody answered in time"
                    changed = True
                if s.state != "PENDING":
                    continue
                deps = [wf.step(d) for d in s.depends_on]
                if any(d.state not in ("SUCCEEDED", "SKIPPED") for d in deps):
                    continue
                changed = True
                if any(d.state == "SKIPPED" for d in deps):
                    s.state = "SKIPPED"
                    continue
                if s.when:
                    gate = wf.step(s.when["step"])
                    verdict = ((gate.answer or {}).get("payload") or {}).get("verdict")
                    if verdict not in s.when["verdict_in"]:
                        s.state = "SKIPPED"
                        continue
                s.staged = {
                    name: wf.step(up).files.get(name, "") for up, name in s.input_from.items()
                }
                if s.await_input:
                    s.state = "PARKED"
                    s.park_reason = "AWAITING_INPUT"
                    s.answer_state = "waiting"
                    s.opened_at = self.now
                    s.expires_at = self.now + timedelta(
                        seconds=s.await_input["expires_after_seconds"]
                    )
                    continue
                self._run_agent(wf, s)
            if any(s.state in ("FAILED", "DEAD_LETTERED") for s in wf.steps):
                wf.state = "FAILED"
                for s in wf.steps:
                    if s.state in ("PENDING", "PARKED"):
                        s.state = "CANCELLED"
                return
        if all(s.state in ("SUCCEEDED", "SKIPPED") for s in wf.steps):
            wf.state = "SUCCEEDED"

    def _run_agent(self, wf: Workflow, s: Step) -> None:
        servers = s.input.get("mcp_servers") or []
        if servers and any(not self.servers[n].get("enabled", True) for n in servers):
            s.state = "PARKED"
            s.park_reason = "CREDENTIAL_MISSING"
            return
        if s.step_id in self.step_failure:
            code, message = self.step_failure.pop(s.step_id)
            s.state, s.error_code, s.last_error = "FAILED", code, f"{code}: {message}"
            return
        if servers and not self._credential_live(wf):
            s.state = "FAILED"
            s.error_code = "mcp_credential_expired"
            s.last_error = "mcp_credential_expired: the workflow's credential expired"
            return
        prompt = s.input.get("prompt", "")
        segment = s.step_id.split("-", 1)[0]
        attempt = int(m[1]) + 1 if (m := re.search(r"-revise(\d+)$", s.step_id)) else 1
        names: list[str] = []
        if m2 := _WRITE.search(prompt + "\n"):
            names = [n.strip() for n in m2[1].split(",")]
        elif m3 := _NOTES.search(prompt):
            names = [m3[1]]
        s.files = {n: _default_content(n, segment, attempt) for n in names}
        s.cost = AGENT_COST
        s.state = "SUCCEEDED"

    def _view(self, wf: Workflow) -> dict[str, Any]:
        tasks = []
        for s in wf.steps:
            task: dict[str, Any] = {
                "id": s.task_id,
                "state": s.state,
                "cost_usd_total": s.cost,
                "last_error": s.last_error,
            }
            if s.error_code:
                task["error_code"] = s.error_code
            if s.park_reason:
                task["park_reason"] = s.park_reason
            if s.await_input and s.opened_at:
                task["metadata"] = {
                    "await_input": {
                        "opened_at": s.opened_at.isoformat(),
                        "expires_at": s.expires_at.isoformat() if s.expires_at else None,
                    }
                }
            tasks.append(task)
        return {
            "workflow": {
                "workflow_id": wf.workflow_id,
                "state": wf.state,
                "metadata": wf.body.get("metadata") or {},
                "steps": [
                    {"step_id": s.step_id, "task_id": s.task_id, "state": s.state} for s in wf.steps
                ],
            },
            "tasks": tasks,
        }
