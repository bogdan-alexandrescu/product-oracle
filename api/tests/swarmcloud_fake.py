"""A fake SwarmCloud API for adapter v2 tests, served through ``httpx.MockTransport``.

It follows docs/swarmcloud-interface.md and the contract SwarmCloud confirmed on
2026-10-19: the two switches (caller MCP, await-input) and service answers, the MCP server
registry with its egress addresses (reads served while caller MCP is off, writes refused),
workflow submission with its refusals, a small step engine (agent steps finish when
polled, ``await-input`` steps park until answered or expired, ``when`` gates on the
recorded verdict, skipped dependants), answers (a replay only when answer_id, payload,
on_behalf_of and files all match; any other second answer 409 already_answered, and the
workflow goes on with the first), the answer record without its payload, the verdict in
the step's form artifact, artifacts by task, cancel (and transient cancel failures), and
Oracle's tasks listed newest
first with each step's metadata. Errors use SwarmCloud's envelope
``{"code", "message", "detail": {"reason", ...}}``; a workflow has no metadata. What it
cannot know about the real service is listed in the adapter v2 report.

    swarm = FakeSwarmCloud(mcp=True, await_input=True, service_answer=True)
    runtime = swarm.runtime()
"""

import hashlib
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
# Oracle's principal, as SwarmCloud records it on a service answer.
SERVICE_PRINCIPAL = "oracle-api@saga-agents-staging.iam.gserviceaccount.com"
_CODES = {
    401: "unauthorized",
    403: "forbidden",
    404: "not_found",
    405: "method_not_allowed",
    409: "conflict",
    422: "validation_error",
    503: "unavailable",
}
_WRITE = re.compile(r"Write these files as artifacts: ([^\n]+?)\.\n")
_NOTES = re.compile(r"Write your working notes to (\S+?\.md)")
_PRINTABLE = set(string.printable) - set("\t\n\r\x0b\x0c")


def _err(status: int, reason: str, message: str = "", **detail: Any) -> httpx.Response:
    """SwarmCloud's error envelope: a generic code, the reason in ``detail``."""
    return httpx.Response(
        status,
        json={
            "code": _CODES.get(status, "error"),
            "message": message or reason,
            "detail": {"reason": reason, **detail},
        },
    )


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
    metadata: dict[str, Any] = field(default_factory=dict)
    state: str = "PENDING"
    park_reason: str | None = None
    opened_at: datetime | None = None
    expires_at: datetime | None = None
    # The answer record (what GET .../input serves) and the body that was posted.
    answer: dict[str, Any] | None = None
    answered_with: dict[str, Any] | None = None
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
        # Record the next answer, then lose the response (a timeout).
        self.lose_next_answer = False
        self.fail_next_answer: httpx.Response | None = None  # refuse without recording
        # Create the workflow, then answer with this (a 5xx that landed).
        self.fail_after_create: httpx.Response | None = None
        # Transient cancel failures (503, nothing cancelled), one per cancel call.
        self.fail_cancels = 0
        self.cancels: list[str] = []  # cancel calls, confirmed or not
        # Refuse this many reads of a wait (GET .../input) with this status.
        self.fail_input_reads = 0
        self.fail_input_status = 503
        # Refuse the next MCP server registration write without recording it.
        self.fail_next_server_write: httpx.Response | None = None
        # Agent steps run per poll (None: all that can).
        self.steps_per_poll: int | None = None
        # Other tasks of Oracle's, newer than any workflow here (for paging).
        self.other_tasks = 0
        # Other tasks of Oracle's, a day older than any workflow here (listed after them).
        self.older_tasks = 0
        # Answer every call about a workflow with a bare HTML 404 (a proxy's page, or a
        # changed URL or principal): not SwarmCloud's envelope.
        self.html_404 = False
        # Refuse this many reads of a workflow (503) once a cancel was confirmed.
        self.fail_reads_after_cancel = 0
        self._failing_reads = 0
        self.step_failure: dict[str, tuple[str, str]] = {}  # step_id -> (code, message)
        self._n = 0

    def runtime(self, **kw: Any) -> SwarmCloudRuntime:
        kw.setdefault("principal", SERVICE_PRINCIPAL)
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
                return _err(404, "not_found", "no route")
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
            # No label filter, and a workflow has no metadata.
            rows = [
                {"workflow_id": w.workflow_id, "state": w.state} for w in self.workflows.values()
            ]
            return httpx.Response(200, json={"workflows": rows})
        if path == "/v1/tasks" and method == "GET":
            if self.lose_next_lookup:
                self.lose_next_lookup = False
                raise httpx.ReadTimeout("lost", request=request)
            return self._tasks(request.url.params)
        m = re.fullmatch(r"/v1/workflows/([^/]+)(/cancel|/steps/([^/]+)/input)?", path)
        if m and self.html_404:
            return httpx.Response(404, text="<html><body>Not Found</body></html>")
        if m and not m[2] and method == "GET" and self._failing_reads > 0:
            self._failing_reads -= 1
            return _err(503, "unavailable", "try again later")
        if m:
            wf = self.workflows.get(m[1])
            if wf is None:
                return _err(404, "not_found", "no such workflow")
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
                return _err(404, "not_found", "no such task")
            if m[2]:
                name = request.url.params["name"]
                if name not in step.files:
                    return _err(404, "not_found", "no such artifact")
                return httpx.Response(200, text=step.files[name])
            rows = [{"name": n, "role": None} for n in step.files]
            rows.append({"name": "agent.log", "role": "agent_stdout"})
            return httpx.Response(200, json={"artifacts": rows, "complete": True})
        return _err(404, "not_found", "no route")

    def _servers(self, method: str, path: str, body: Any) -> httpx.Response:
        # Reads are served while caller MCP is switched off; writes are not.
        if not self.mcp and method != "GET":
            return _err(503, "mcp_unavailable", "caller MCP is switched off")
        if method != "GET" and self.fail_next_server_write is not None:
            resp, self.fail_next_server_write = self.fail_next_server_write, None
            return resp
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
        return _err(405, "method_not_allowed")

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
                    metadata=dict(s.get("metadata") or {}),
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
        if self.fail_after_create is not None:
            resp, self.fail_after_create = self.fail_after_create, None
            return resp
        return httpx.Response(201, json={"workflow": {"workflow_id": wid}, "dispatch": {}})

    def _tasks(self, params: httpx.QueryParams) -> httpx.Response:
        """Oracle's tasks, newest first. ``submitted_by`` is applied in the query, so its
        pages are exact; any other filter is applied to the page after the cursor, so
        pages come back short (as SwarmCloud does)."""
        if params.get("submitted_by") != "me":
            return _err(422, "validation_error", "submitted_by=me is required here")
        rows: list[dict[str, Any]] = [
            {
                "id": f"other_t{i}",
                "workflow_id": f"other_wf{i}",
                "state": "SUCCEEDED",
                "runner_profile": "claude-code",
                "metadata": {"oracle_key": f"oracle-other-{i}"},
                "created_at": self.now.isoformat(),
            }
            for i in range(self.other_tasks)
        ]
        for wf in reversed(list(self.workflows.values())):
            for st in reversed(wf.steps):
                rows.append(
                    {
                        "id": st.task_id,
                        "workflow_id": wf.workflow_id,
                        "state": st.state,
                        "runner_profile": st.profile,
                        "metadata": dict(st.metadata),
                        "created_at": wf.submitted_at.isoformat(),
                    },
                )
        older = self.now - timedelta(days=1)
        rows += [
            {
                "id": f"older_t{i}",
                "workflow_id": f"older_wf{i}",
                "state": "SUCCEEDED",
                "runner_profile": "claude-code",
                "metadata": {"oracle_key": f"oracle-older-{i}"},
                "created_at": (older - timedelta(seconds=i)).isoformat(),
            }
            for i in range(self.older_tasks)
        ]
        limit = int(params.get("limit", "50"))
        start = int(params.get("page_token") or 0)
        page = rows[start : start + limit]
        for key in ("state", "runner_profile", "workflow_id"):
            if key in params:
                page = [r for r in page if r[key] == params[key]]
        more = start + limit < len(rows)
        return httpx.Response(
            200, json={"tasks": page, "next_page_token": str(start + limit) if more else None}
        )

    def console_answer(
        self,
        workflow_id: str,
        step_id: str,
        verdict: str,
        findings: list[str] | None = None,
        *,
        by: str = "reviewer@example.com",
        answer_id: str | None = None,
        on_behalf_of: str | None = None,
    ) -> None:
        """A person answers in SwarmCloud's console (``answer_id``: any id they give)."""
        wf = self.workflows[workflow_id]
        self._advance(wf)
        step = wf.step(step_id)
        assert step.answer_state == "waiting", step.answer_state
        self._record(
            wf,
            step,
            {
                "answer_id": answer_id or f"console-{step.task_id}",
                "payload": {"verdict": verdict, "findings": findings or []},
                "via": "console",
                "on_behalf_of": on_behalf_of,
            },
            by=by,
        )

    def _record(self, wf: Workflow, step: Step, body: dict[str, Any], *, by: str) -> None:
        payload = body["payload"]
        # Validated, redacted and re-serialised: never the bytes that were posted.
        form = json.dumps(
            {"verdict": payload["verdict"], "findings": [str(f) for f in payload["findings"]]},
            sort_keys=True,
            separators=(",", ":"),
        )
        step.answered_with = body
        step.answer = {
            "answer_id": body["answer_id"],
            "answered_by": by,
            "on_behalf_of": body.get("on_behalf_of"),
            "answered_at": self.now.isoformat(),
            "via": body.get("via"),
            "sha256": hashlib.sha256(form.encode()).hexdigest(),
            "bytes": len(form.encode()),
            "files": list(body.get("files") or []),
        }
        step.answer_state = "answered"
        step.files = {step.await_input["artifact"]: form}  # type: ignore[index]
        step.state = "SUCCEEDED"
        step.park_reason = None
        self._advance(wf)

    def _task(self, task_id: str) -> Step | None:
        for wf in self.workflows.values():
            for s in wf.steps:
                if s.task_id == task_id:
                    return s
        return None

    def _cancel(self, wf: Workflow) -> httpx.Response:
        self.cancels.append(wf.workflow_id)
        if self.fail_cancels > 0:
            self.fail_cancels -= 1
            return _err(503, "unavailable", "try again later")
        if wf.state in ("SUCCEEDED", "FAILED", "CANCELLED"):
            return _err(409, "not_cancellable", f"workflow is {wf.state}")
        wf.state = "CANCELLED"
        self._failing_reads = self.fail_reads_after_cancel
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
            return _err(404, "not_found", "no such waiting step")
        if method == "GET" and self.fail_input_reads > 0:
            self.fail_input_reads -= 1
            reason = "unavailable" if self.fail_input_status >= 500 else "not_a_member"
            return _err(self.fail_input_status, reason, "cannot read the wait")
        if method == "GET":
            # The record only: who, when, via, the form's hash and size, never the payload.
            return httpx.Response(200, json={"state": step.answer_state, "answer": step.answer})
        if self.fail_next_answer is not None:
            resp, self.fail_next_answer = self.fail_next_answer, None
            return resp
        if not self.service_answer:
            return _err(403, "person_required", "only a person may answer this step")
        payload = body.get("payload")
        if not isinstance(payload, dict) or payload.get("verdict") not in ("MERGE", "NOT_YET"):
            return _err(422, "invalid_form", "the verdict form needs MERGE or NOT_YET")
        if step.answer is not None:
            sent = step.answered_with or {}
            same = all(
                sent.get(k) == body.get(k) for k in ("answer_id", "payload", "on_behalf_of")
            ) and list(sent.get("files") or []) == list(body.get("files") or [])
            if same:
                return httpx.Response(200, json={"replayed": True, "state": "answered"})
            return _err(
                409,
                "already_answered",
                "the step was already answered",
                answered_by=step.answer["answered_by"],
                answered_at=step.answer["answered_at"],
                via=step.answer["via"],
            )
        if step.answer_state != "waiting":
            reason = (
                step.answer_state if step.answer_state in ("expired", "cancelled") else "not_open"
            )
            return _err(409, reason, f"the step is {step.answer_state}", state=step.answer_state)
        self.answers.append({"workflow_id": wf.workflow_id, "step_id": step_id, **body})
        self._record(wf, step, body, by=SERVICE_PRINCIPAL)
        if self.lose_next_answer:
            self.lose_next_answer = False
            raise httpx.ReadTimeout("the answer's response was lost")
        return httpx.Response(200, json={"replayed": False, "state": "answered"})

    def verdict(self, workflow_id: str, step_id: str) -> str | None:
        """The verdict recorded in a waiting step's form artifact."""
        step = self.workflows[workflow_id].step(step_id)
        form = step.files.get((step.await_input or {}).get("artifact", ""))
        return json.loads(form)["verdict"] if form else None

    # ------------------------------------------------------------------ engine

    def _credential_live(self, wf: Workflow) -> bool:
        if wf.credential is None:
            return True
        return self.now < wf.submitted_at + timedelta(seconds=wf.credential["expires_in"])

    def _advance(self, wf: Workflow) -> None:
        if wf.state != "RUNNING":
            return
        ran = 0
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
                    # The recorded verdict: the first answer's, from the form artifact.
                    verdict = self.verdict(wf.workflow_id, s.when["step"])
                    if verdict not in s.when["verdict_in"]:
                        s.state = "SKIPPED"
                        continue
                if not s.await_input and self.steps_per_poll is not None:
                    if ran >= self.steps_per_poll:
                        changed = False
                        break
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
                ran += 1
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
            task["metadata"] = dict(s.metadata)
            if s.await_input and s.opened_at:
                task["metadata"]["await_input"] = {
                    "opened_at": s.opened_at.isoformat(),
                    "expires_at": s.expires_at.isoformat() if s.expires_at else None,
                }
            tasks.append(task)
        return {
            "workflow": {
                "workflow_id": wf.workflow_id,
                "state": wf.state,
                "steps": [
                    {"step_id": s.step_id, "task_id": s.task_id, "state": s.state} for s in wf.steps
                ],
            },
            "tasks": tasks,
        }
