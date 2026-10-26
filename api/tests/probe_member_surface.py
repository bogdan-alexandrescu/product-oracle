"""Probe (not collected by default): walk a commenter's and a viewer's whole read surface
for a hidden pricing decision, security fixes for #541.

Setup: a decided-then-reversed pricing decision from an approved pricing memo with a
prepared Decisions due occurrence (tests.test_pricing_ritual_visibility._prepared), an
imported pricing memo, a pricing_memo run at its checkpoint and a launch. Then, as a
viewer and a commenter (session cookie and API token): every GET route of the OpenAPI
document, every read-only MCP tool, and every tool of each member-view run flow (the
member_output flows and, with a company-wide target, the company_draft flows: #541
part 5) through a run token of a run started by an owner, an approver and Oracle. Every
response, with the values the caller sent removed, is searched for the secrets.

One part per process (PROBE_PART), so memory stays small; each finding, error and the
part's counts are appended to $SWARM_ARTIFACTS_DIR/probe/<part>.jsonl as they come, no
response is kept:

  routes:<owner|viewer|commenter>-<cookie|token>   mcp:<viewer|commenter>
  run:<flow>:<owner|approver|oracle>
  files:<owner|viewer|commenter>-<cookie|token|mcp>   files:member-run   files:own

#562 review: every member-view run (the kit's and the draft runs' included) wrote real
files naming the hidden decision, as one written before #541 part 4/5 would, and the
launch's ``kit_run_id`` is the owner's kit run. A ``files:`` part fetches every file every
run of the setup wrote (GET /v1/runs/{id}/segments/{seq}/artifacts/{name}, the MCP tool
get_run_artifact; ``member-run``: a ritual summary run's token with its starter's cookie
and over MCP; ``own``: each member-view run's own get_run_output).

  cd api && PROBE_PART=mcp:viewer PYTEST_XDIST_WORKER=probe uv run pytest -q \
      tests/probe_member_surface.py -p no:cacheprovider -s

tests/probe_summary.py adds the files up. Never fails on a leak or a 500: it reports.
"""

import asyncio
import json
import os
import re
import time
import uuid
from collections import Counter
from datetime import UTC, datetime
from pathlib import Path

import pytest
from sqlalchemy import select

from oracle import audit
from oracle.auth.deps import RUN_TOKEN_HEADER
from oracle.baseline.models import Entity
from oracle.decisions.models import Decision
from oracle.docs.models import Document, DocumentVersion
from oracle.launches.models import ChangelogEntry, Launch, LaunchTask, RequesterNote
from oracle.rituals.models import Ritual, RitualOccurrence
from oracle.runs import service as runs_service
from oracle.runs.flows import FLOWS
from oracle.runs.models import Checkpoint, Run, RunSegment
from oracle.runs.schemas import KnobsIn, RunCreate
from oracle.runtokens import mint_run_token
from oracle.swarm import FakeRuntime, set_runtime
from oracle.tenancy import tenant_session
from tests.baseline_helpers import make_ctx
from tests.day_helpers import company_today
from tests.decision_helpers import clock, today  # noqa: F401
from tests.pricing_helpers import QUESTION, drafted_by_run, memo_md
from tests.test_mcp import api_token, mcp_client, text_of
from tests.test_pricing_ritual_visibility import CONTROL, RATIONALE, _prepared
from tests.update_helpers import import_md

WORD = "per-seat"
IMPORTED = "team-plan-pricing-import"
# Who starts each member-view run: an owner, an approver, Oracle (for the owner).
RUN_CREATORS = ("owner", "approver", "oracle")
MEMBER_FLOWS = tuple(k for k, f in FLOWS.items() if f.member_output)
DRAFT_FLOWS = tuple(k for k, f in FLOWS.items() if f.company_draft)
TARGET_KIND = {"feedback_loop": "prd", "strategy_draft": "strategy"}
READ_PREFIXES = ("get_", "list_", "search", "read_", "trace_", "export_", "find_")
TIMEOUT = 20
MAX_VARIANTS = 16
MINOR_MARKERS = ("needs_decision", "Run stop: pricing review")
ARTIFACTS = Path(os.environ.get("SWARM_ARTIFACTS_DIR", "/tmp/probe-artifacts"))
PART = os.environ.get("PROBE_PART", "")


@pytest.fixture
def runtime():
    rt = FakeRuntime()
    set_runtime(rt)
    yield rt
    set_runtime(None)


class Secrets:
    """Labelled patterns; ``minor`` ones (checkpoint decisions) are reported apart."""

    def __init__(self) -> None:
        self.items: list[tuple[str, re.Pattern, str, bool]] = []  # label, re, raw, minor

    def text(self, label: str, value: str, minor: bool = False) -> None:
        self.items.append((label, re.compile(re.escape(value)), value, minor))

    def number(self, label: str, n: int, minor: bool = False) -> None:
        self.items.append((f"{label} D-{n}", re.compile(rf"\bD-{n}(?!\d)"), f"D-{n}", minor))
        self.items.append(
            (f"{label} d={n}", re.compile(rf"(?<![\w-])d={n}(?!\d)"), f"d={n}", minor)
        )

    def find(self, body: str, sent: list[str]) -> list[tuple[str, str, bool]]:
        # Remove what the caller sent (an echoed path or query value is not a leak).
        for v in sorted({s for s in sent if s}, key=len, reverse=True):
            if any(raw in v for _, _, raw, _ in self.items):
                body = body.replace(v, "<SENT>")
        out = []
        for label, pat, _raw, minor in self.items:
            m = pat.search(body)
            if m:
                lo, hi = max(0, m.start() - 160), min(len(body), m.end() + 160)
                snippet = body[lo:hi]
                if any(k in body[max(0, m.start() - 600) : m.end() + 600] for k in MINOR_MARKERS):
                    minor = True
                out.append((label, snippet, minor))
        return out


def _variants(names: list[str], values: dict[str, list[str]]) -> list[dict[str, str]]:
    """The first candidate of each name, then one name varied at a time."""
    pick = {n: (values.get(n) or [str(uuid.uuid4())]) for n in names}
    base = {n: v[0] for n, v in pick.items()}
    out = [base]
    for n, cands in pick.items():
        for c in cands[1:]:
            out.append({**base, n: c})
    return out[:MAX_VARIANTS]


def _query_value(name: str, schema: dict, values: dict[str, list[str]]) -> str | None:
    if name in values:
        return values[name][0]
    t = schema.get("type") or next(
        (s.get("type") for s in schema.get("anyOf", []) if s.get("type") != "null"), "string"
    )
    fmt = schema.get("format") or next(
        (s.get("format") for s in schema.get("anyOf", []) if s.get("format")), None
    )
    if schema.get("enum"):
        return str(schema["enum"][0])
    if fmt == "uuid":
        return str(uuid.uuid4())
    if fmt == "date":
        return company_today().isoformat()
    if t == "integer" or t == "number":
        return "1"
    if t == "boolean":
        return "true"
    return WORD


async def _setup(client, ctx, runtime) -> dict:
    occ_id, dec_id, number = await _prepared(client, ctx, reverse=True)
    resp = await import_md(client, ctx.as_("approver"), IMPORTED, memo_md(IMPORTED))
    assert resp.status_code == 201, resp.text
    notes = []
    try:
        await drafted_by_run(client, ctx, runtime, IMPORTED, memo_md(IMPORTED))
    except AssertionError as e:  # the probe runs on; the run is extra coverage
        notes.append(f"pricing_memo run not created: {str(e)[:200]}")
    owner = ctx.as_("owner")
    entities = (await client.get("/v1/baseline/entities?type=decision", headers=owner)).json()
    entity_ids = [e["id"] for e in entities if e["key"] == f"d-{number}"]
    async with tenant_session(ctx.tenant_id) as db:
        launch = Launch(title="Saved cards", item_keys=["payment-step"], state="launched",
                        owner_id=ctx.users["owner"].id)  # fmt: skip
        db.add(launch)
        await db.flush()
        # Kit output written before #541 part 5, by an owner's run: it names the decision.
        secret = f"D-{number}: {QUESTION}"
        db.add(
            LaunchTask(
                launch_id=launch.id,
                key="release_notes",
                title="Release notes",
                position=1,
                audience="external",
                status="drafted",
                body=secret,
            )
        )
        db.add(
            ChangelogEntry(
                launch_id=launch.id,
                category="changed",
                audience="public",
                title="Team plan pricing",
                body=secret,
                released_on=company_today(),
                created_actor=audit.ORACLE,
            )
        )
        db.add(RequesterNote(launch_id=launch.id, requester_kind="member", body=secret,
                             member_id=ctx.users["commenter"].id, display_name="Commenter",
                             status="notified", notified_at=datetime.now(UTC)))  # fmt: skip
        member_runs = {}
        for flow in (*MEMBER_FLOWS, *DRAFT_FLOWS):
            target = None
            if flow in DRAFT_FLOWS:
                kind = TARGET_KIND.get(flow) or FLOWS[flow].target_kind or "prd"
                target = Document(slug=f"probe-{flow.replace('_', '-')}", kind=kind,
                                  title=f"Probe {kind}", visibility="company")  # fmt: skip
                db.add(target)
                await db.flush()
            for who in RUN_CREATORS:
                knobs = {"ritual_occurrence_id": occ_id, "launch_id": str(launch.id)}
                creator = ctx.users["owner" if who == "oracle" else who].id
                if who == "oracle" and flow == "launch_kit":
                    body = RunCreate(flow=flow, knobs=KnobsIn(depth="quick"))  # type: ignore[arg-type]
                    run_id = await runs_service.create_run(
                        db, audit.ORACLE, body, oracle_knobs={"launch_id": str(launch.id)},
                        commit=False, created_by=creator,
                    )  # fmt: skip
                else:
                    run = Run(flow=flow, created_by=creator, knobs=knobs,
                              document_id=target.id if target else None)  # fmt: skip
                    db.add(run)
                    await db.flush()
                    run_id = run.id
                member_runs[(flow, who)] = str(run_id)
                # #562 review: the files such a run wrote before part 4/5 (named the decision).
                # An Oracle-started run has its segments already (create_run).
                fdef = FLOWS[flow]
                made = {
                    x.seq: x
                    for x in await db.scalars(select(RunSegment).where(RunSegment.run_id == run_id))
                }
                for seq, sdef in enumerate(fdef.segments, start=1):
                    names = list(sdef.outputs_for(fdef.target_kind or "prd")) or ["notes.md"]
                    files = {n: _old_file(n, launch.id, number) for n in names}
                    art = {"files": files, "attempts": [{"attempt": 1}], "notes": []}
                    if seq in made:
                        made[seq].artifacts = art
                    else:
                        db.add(RunSegment(run_id=run_id, seq=seq, name=sdef.name,
                                          status="succeeded", artifacts=art))  # fmt: skip
        launch.kit_run_id = uuid.UUID(member_runs[("launch_kit", "owner")])
        launch_id = str(launch.id)
        await db.commit()
        docs = (await db.scalars(select(Document).where(Document.kind == "pricing"))).all()
        versions = (
            await db.scalars(
                select(DocumentVersion).where(DocumentVersion.document_id.in_([d.id for d in docs]))
            )
        ).all()
        decisions = (await db.scalars(select(Decision))).all()
        runs = (await db.scalars(select(Run))).all()
        checkpoints = (await db.scalars(select(Checkpoint))).all()
        rituals_ = (await db.scalars(select(Ritual))).all()
        occs = (await db.scalars(select(RitualOccurrence))).all()
        all_entities = (await db.scalars(select(Entity))).all()
        run_files = [
            (str(seg.run_id), seg.seq, name)
            for seg in await db.scalars(select(RunSegment))
            for name in ((seg.artifacts or {}).get("files") or {})
        ]
    return {
        "occ_id": occ_id,
        "dec_id": dec_id,
        "number": number,
        "entity_ids": entity_ids,
        "docs": [(d.slug, str(d.id)) for d in docs],
        "versions": [str(v.id) for v in versions],
        "decisions": [
            (str(d.id), d.number, d.title, d.origin, d.class_, str(d.entity_id or ""))
            for d in decisions
        ],
        "runs": [(str(r.id), r.flow) for r in runs],
        "member_runs": member_runs,
        "checkpoints": [(str(c.id), str(c.run_id), c.kind) for c in checkpoints],
        "rituals": [str(r.id) for r in rituals_],
        "occs": [str(o.id) for o in occs],
        "entity_keys": {str(e.id): e.key for e in all_entities},
        "notes": notes,
        "launch_id": launch_id,
        "run_files": run_files,
    }


def _old_file(name: str, launch_id: uuid.UUID, number: int) -> str:
    """A file a run wrote before #541 part 4/5: it names the hidden decision."""
    said = f"Pricing follows D-{number}: {QUESTION}"
    if name == "launch.yaml":
        return f'version: 1\nlaunch: {launch_id}\ntasks:\n  release_notes: "{said}"\n'
    return f"# {name}\n\n{said}\n"


def _secrets(s: dict) -> Secrets:
    sec = Secrets()
    sec.text("QUESTION", QUESTION)
    sec.text("RATIONALE", RATIONALE)
    sec.text("Team plan pricing", "Team plan pricing")
    sec.text(WORD, WORD)
    sec.text("pricing decision id", s["dec_id"])
    sec.number("pricing decision", s["number"])
    for eid in s["entity_ids"]:
        sec.text("decision entity id", eid)
    for slug, doc_id in s["docs"]:
        sec.text(f"memo slug {slug}", slug)
        sec.text(f"memo doc id {slug}", doc_id)
    for did, n, title, origin, _cls, eid in s["decisions"]:
        if did == s["dec_id"] or title == CONTROL:
            continue
        # Another decision of the setup: the memo's approval or a run stop.
        minor = origin == "checkpoint"
        sec.text(f"decision {title[:40]!r} id", did, minor)
        sec.number(f"decision {title[:40]!r}", n, minor)
        if eid:
            sec.text(f"decision {title[:40]!r} entity id", eid, minor)
    return sec


def _values(s: dict) -> dict[str, list[str]]:
    run_ids = [r for r, _ in s["runs"]]
    pricing_runs = [r for r, f in s["runs"] if f == "pricing_memo"]
    slugs = [slug for slug, _ in s["docs"]]
    doc_ids = [d for _, d in s["docs"]]
    others = [(d, n) for d, n, t, *_ in s["decisions"] if d != s["dec_id"] and t != CONTROL]
    decisions = [str(s["number"]), s["dec_id"]] + [v for d, n in others for v in (str(n), d)]
    return {
        # A slug that never existed: the control for a hidden one's status.
        "doc": slugs + doc_ids + ["no-such-memo"],
        "decision": decisions,
        "entity_id": s["entity_ids"] or [str(uuid.uuid4())],
        "occurrence_id": [s["occ_id"]] + [o for o in s["occs"] if o != s["occ_id"]],
        "ritual_id": s["rituals"],
        "run_id": pricing_runs + [r for r in run_ids if r not in pricing_runs],
        "checkpoint_id": [c for c, _, _ in s["checkpoints"]] or [str(uuid.uuid4())],
        "version_id": s["versions"] or [str(uuid.uuid4())],
        "n": ["2", "1", "3"],
        "p": ["1"],
        "seq": ["1", "0"],
        "name": ["pricing.md"],
        "key": ["pricing-options-memo", "pricing", f"d-{s['number']}"],
        "q": [WORD, "Team plan"],
        "query": [WORD, "Team plan"],
        "document": [*slugs, "no-such-memo"],
        "decision_id": [s["dec_id"]],
        "decision_number": [str(s["number"])],
        "number": [str(s["number"])],
        "slug": slugs,
        "class": ["checkpoint", "judgement"],
        "kind": ["pricing"],
        "type": ["decision"],
        "launch_id": [s["launch_id"]],
    }


class Out:
    """The part's JSONL file: one line per finding or error as it comes, and counts."""

    def __init__(self, part: str) -> None:
        d = ARTIFACTS / "probe"
        d.mkdir(parents=True, exist_ok=True)
        self.path = d / (re.sub(r"[^\w.-]+", "_", part) + ".jsonl")
        self.path.write_text("")
        self.counts: Counter = Counter()
        self.statuses: Counter = Counter()

    def line(self, row: dict) -> None:
        with self.path.open("a") as f:
            f.write(json.dumps(row, default=str) + "\n")


def _record(out: Out, caller: str, where: str, found, sent_status) -> None:
    for label, snippet, minor in found:
        out.line({"type": "minor" if minor else "leak", "caller": caller,
                  "route_or_tool": where, "secret": label, "snippet": snippet})  # fmt: skip
    out.statuses[str(sent_status)] += 1


async def _walk_routes(client, callers: dict, values, sec: Secrets, result: Out) -> None:
    from oracle.main import app

    paths = app.openapi()["paths"]
    for path, ops in paths.items():
        if "get" not in ops:
            continue
        op = ops["get"]
        names = re.findall(r"{(\w+)}", path)
        query = {}
        for p in op.get("parameters", []):
            if p.get("in") != "query":
                continue
            if p.get("required") or p["name"] in values:
                v = _query_value(p["name"], p.get("schema", {}), values)
                if v is not None:
                    query[p["name"]] = v
        if path.endswith("/diff"):
            query.update({"from": "1", "to": "2"})
        queries = [query]
        for k in query:
            queries += [{**query, k: v} for v in values.get(k, [])[1:]]
        for variant, query in [(v, q) for v in _variants(names, values) for q in queries]:
            url = re.sub(r"{(\w+)}", lambda m, v=variant: v[m.group(1)], path)
            sent = list(variant.values()) + list(query.values())
            for caller, headers in callers.items():
                try:
                    resp = await asyncio.wait_for(
                        client.get(url, params=query, headers=headers), TIMEOUT
                    )
                    status, body = resp.status_code, resp.text
                except TimeoutError:
                    status, body = "timeout", ""
                except Exception as e:  # noqa: BLE001
                    status, body = f"error:{type(e).__name__}", ""
                result.counts["routes_walked"] += 1
                where = f"GET {url}" + (f" {query}" if query else "")
                if status == 500 or (isinstance(status, str)):
                    result.line({"type": "error", "caller": caller, "route": where,
                                 "status": status})  # fmt: skip
                found = sec.find(body, sent) if body else []
                del body
                if caller.startswith("owner"):
                    result.counts["owner_responses_with_a_secret"] += bool(found)
                    result.statuses[str(status)] += 1
                    continue
                _record(result, caller, where, found, status)


def _tool_args(schema: dict, values: dict[str, list[str]]) -> list[dict]:
    props = schema.get("properties", {})
    required = set(schema.get("required", []))
    idlike = [
        n
        for n in props
        if n in values or n.endswith("_id") or n in required or n in ("doc", "decision")
    ]
    fixed = {}
    varying = []
    for n in idlike:
        if n in values or n.endswith("_id"):
            varying.append(n)
        else:
            v = _query_value(n, props[n], values)
            if props[n].get("type") == "object":
                fixed[n] = {}
            elif props[n].get("type") == "integer":
                fixed[n] = int(v)
            elif props[n].get("type") == "boolean":
                fixed[n] = True
            else:
                fixed[n] = v
    out = []
    for variant in _variants(varying, values):
        args = dict(fixed)
        for n, v in variant.items():
            args[n] = int(v) if props[n].get("type") == "integer" and v.isdigit() else v
        out.append(args)
    return out


def _sent(args: dict) -> list[str]:
    return [str(v) for v in args.values() if not isinstance(v, dict)]


async def _call_tools(c, caller, tools, values, sec, result, only=None) -> None:
    for tool in tools:
        if only is not None and tool.name not in only:
            continue
        for args in _tool_args(tool.input_schema or {}, values):
            try:
                got = await asyncio.wait_for(c.call_tool(tool.name, args), TIMEOUT)
                body = text_of(got)
                status = "error" if got.is_error else "ok"
                if got.is_error:
                    m = re.search(r"HTTP (\d{3})", body)
                    status = f"error:{m.group(1)}" if m else "error"
            except TimeoutError:
                body, status = "", "timeout"
            except Exception as e:  # noqa: BLE001
                body, status = "", f"exception:{type(e).__name__}"
            result.counts["tools_called"] += 1
            where = f"{tool.name} {json.dumps(args, default=str)}"
            if status in ("timeout", "error:500") or status.startswith("exception"):
                result.line({"type": "error", "caller": caller, "tool": where, "status": status})
            _record(result, caller, where, sec.find(body, _sent(args)), status)
            del body


async def _fetch_files(client, ctx, s: dict, who: str, sec: Secrets, out: Out) -> None:
    """#562 review: every file every run of the setup wrote, as ``who``."""
    files = s["run_files"]
    out.line({"type": "files", "caller": who, "files": len(files)})

    async def rest(caller: str, headers: dict) -> None:
        for rid, seq, name in files:
            url = f"/v1/runs/{rid}/segments/{seq}/artifacts/{name}"
            try:
                resp = await asyncio.wait_for(client.get(url, headers=headers), TIMEOUT)
                status, body = resp.status_code, resp.text
            except TimeoutError:
                status, body = "timeout", ""
            out.counts["files_fetched"] += 1
            if status == 500 or isinstance(status, str):
                out.line({"type": "error", "caller": caller, "route": url, "status": status})
            found = sec.find(body, [rid, str(seq), name]) if body else []
            if caller.startswith("owner"):
                out.counts["owner_responses_with_a_secret"] += bool(found)
                out.statuses[str(status)] += 1
                continue
            _record(out, caller, f"GET {url}", found, status)

    async def mcp(caller: str, raw: str, tool: str, own: str | None = None) -> None:
        async with mcp_client(raw) as c:
            if tool not in {t.name for t in (await c.list_tools()).tools}:
                out.line({"type": "not_listed", "caller": caller, "tools": [tool]})
                return
            for rid, seq, name in files:
                if own is not None and rid != own:
                    continue
                args = {"seq": seq, "name": name}
                if own is None:
                    args["run_id"] = rid
                try:
                    got = await asyncio.wait_for(c.call_tool(tool, args), TIMEOUT)
                    body, status = text_of(got), "error" if got.is_error else "ok"
                except TimeoutError:
                    body, status = "", "timeout"
                out.counts["files_fetched"] += 1
                _record(out, caller, f"{tool} {json.dumps(args)}", sec.find(body, _sent(args)),
                        status)  # fmt: skip

    role, _, how = who.partition("-")
    if role == "member" and how == "run":
        # A run that reads as a member (a ritual summary an owner started).
        rid = s["member_runs"][("ritual_summary", "owner")]
        async with tenant_session(ctx.tenant_id) as db:
            scopes = sorted({x for seg in FLOWS["ritual_summary"].segments for x in seg.scopes})
            raw = await mint_run_token(db, rid, scopes, ttl_seconds=3600)
            await db.commit()
        await rest("member-run-rest", {**ctx.as_("owner"), RUN_TOKEN_HEADER: raw})
        await mcp("member-run-mcp", raw, "get_run_artifact")
    elif role == "own":
        for (flow, starter), rid in s["member_runs"].items():
            scopes = sorted({x for seg in FLOWS[flow].segments for x in seg.scopes})
            async with tenant_session(ctx.tenant_id) as db:
                raw = await mint_run_token(db, rid, scopes, ttl_seconds=3600)
                await db.commit()
            await mcp(f"own:{flow} (started by {starter})", raw, "get_run_output", own=rid)
    elif how == "mcp":
        await mcp(f"{role}-token-mcp", await api_token(ctx.tenant_id, role), "get_run_artifact")
    elif how == "token":
        raw = await api_token(ctx.tenant_id, role)
        await rest(f"{role}-token", {"Authorization": f"Bearer {raw}"})
    else:
        await rest(f"{role}-cookie", ctx.as_(role))


async def test_probe_member_surface(client, runtime):
    started = time.monotonic()
    part = PART
    assert part, "set PROBE_PART (see the module docstring)"
    out = Out(part)
    ctx = await make_ctx()
    s = await _setup(client, ctx, runtime)
    sec = _secrets(s)
    values = _values(s)
    out.line({"type": "setup", "part": part, "notes": s["notes"], "runs": len(s["runs"]),
              "docs": s["docs"], "decisions": len(s["decisions"])})  # fmt: skip
    kind, _, rest = part.partition(":")
    if kind == "routes":
        # 1. Every GET route as one caller (an owner: the control that proves the secrets
        # are findable).
        role, _, how = rest.partition("-")
        if how == "token":
            headers = {"Authorization": f"Bearer {await api_token(ctx.tenant_id, role)}"}
        else:
            headers = ctx.as_(role)
        await _walk_routes(client, {rest: headers}, values, sec, out)
    elif kind == "mcp":
        # 2. Every read-only MCP tool with the role's API token.
        raw = await api_token(ctx.tenant_id, rest)
        caller = f"{rest}-token-mcp"
        async with mcp_client(raw) as c:
            tools = (await c.list_tools()).tools
            reads, skipped = [], []
            for t in tools:
                ro = bool(t.annotations and t.annotations.read_only_hint)
                (reads if ro or t.name.startswith(READ_PREFIXES) else skipped).append(t)
            out.line({"type": "tools", "caller": caller, "listed": len(tools),
                      "skipped": sorted(t.name for t in skipped)})  # fmt: skip
            await _call_tools(c, caller, reads, values, sec, out)
    elif kind == "run":
        # 3. Every tool of one member-view flow's segments through its run token.
        flow, _, who = rest.partition(":")
        run_id = s["member_runs"][(flow, who)]
        for seg in FLOWS[flow].segments:
            names = set(seg.tools)
            for extra in seg.role_tools.values():
                names |= set(extra)
            async with tenant_session(ctx.tenant_id) as db:
                raw = await mint_run_token(db, run_id, seg.scopes, ttl_seconds=3600)
                await db.commit()
            caller = f"run:{flow}/{seg.name} (started by {who})"
            async with mcp_client(raw) as c:
                listed = {t.name for t in (await c.list_tools()).tools}
                tools = [t for t in (await c.list_tools()).tools if t.name in names]
                missing = sorted(names - listed)
                if missing:
                    out.line({"type": "not_listed", "caller": caller, "tools": missing})
                await _call_tools(c, caller, tools, values, sec, out)
    elif kind == "files":
        await _fetch_files(client, ctx, s, rest, sec, out)
    else:
        raise AssertionError(f"unknown PROBE_PART {part!r}")
    out.line({"type": "counts", "part": part, **out.counts, "statuses": dict(out.statuses),
              "seconds": round(time.monotonic() - started, 1)})  # fmt: skip
    print(f"\n{part}: {dict(out.counts)} in {time.monotonic() - started:.0f}s -> {out.path}")
