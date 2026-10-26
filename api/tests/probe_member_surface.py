"""Probe (not collected by default): walk a commenter's and a viewer's whole read surface
for a hidden pricing decision, security fixes for #541.

Setup: a decided-then-reversed pricing decision from an approved pricing memo with a
prepared Decisions due occurrence (tests.test_pricing_ritual_visibility._prepared), an
imported pricing memo and a pricing_memo run at its checkpoint. Then, as a viewer and a
commenter (session cookie and API token): every GET route of the OpenAPI document, every
read-only MCP tool, and every tool of each member-visible run flow through a run token.
Every response, with the values the caller sent removed, is searched for the secrets.

Run:
  cd api && PYTEST_XDIST_WORKER=probe uv run pytest -q tests/probe_member_surface.py \
      -p no:cacheprovider -s

Writes $SWARM_ARTIFACTS_DIR/probe-result.json. Never fails on a leak or a 500: it reports.
"""

import asyncio
import json
import os
import re
import time
import uuid
from collections import Counter
from pathlib import Path

import pytest
from sqlalchemy import select

from oracle.baseline.models import Entity
from oracle.decisions.models import Decision
from oracle.docs.models import Document, DocumentVersion
from oracle.rituals.models import Ritual, RitualOccurrence
from oracle.runs.flows import FLOWS
from oracle.runs.models import Checkpoint, Run
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
# The task's run creator (owner) and a commenter, to tell a creator-role read from a leak.
RUN_CREATORS = ("owner", "commenter")
MEMBER_FLOWS = (
    "ritual_summary",
    "metrics_variance",
    "competitive_digest",
    "request_triage",
    "code_map",
)
READ_PREFIXES = ("get_", "list_", "search", "read_", "trace_", "export_", "find_")
TIMEOUT = 20
MAX_VARIANTS = 16
MINOR_MARKERS = ("needs_decision", "Run stop: pricing review")
ARTIFACTS = Path(
    os.environ.get("SWARM_ARTIFACTS_DIR", "/workspace/att_5b10af6ca70045869738/artifacts")
)


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
        member_runs = {}
        for flow in MEMBER_FLOWS:
            for who in RUN_CREATORS:
                run = Run(
                    flow=flow,
                    created_by=ctx.users[who].id,
                    knobs={"ritual_occurrence_id": occ_id},
                )
                db.add(run)
                await db.flush()
                member_runs[(flow, who)] = str(run.id)
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
    }


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
    }


def _record(result: dict, caller: str, where: str, found, sent_status) -> None:
    for label, snippet, minor in found:
        row = {"caller": caller, "route_or_tool": where, "secret": label, "snippet": snippet}
        (result["minor"] if minor else result["leaks"]).append(row)
    result["statuses"].setdefault(caller, Counter())[str(sent_status)] += 1


async def _walk_routes(client, callers: dict, values, sec: Secrets, result: dict) -> None:
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
                result["routes_walked"][caller] += 1
                where = f"GET {url}" + (f" {query}" if query else "")
                if status == 500 or (isinstance(status, str)):
                    result["errors"].append({"caller": caller, "route": where, "status": status})
                found = sec.find(body, sent) if body else []
                if caller.startswith("owner"):
                    result["owner_sees"] += bool(found)
                    result["statuses"].setdefault(caller, Counter())[str(status)] += 1
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
            result["tools_called"][caller] += 1
            where = f"{tool.name} {json.dumps(args, default=str)}"
            if status in ("timeout", "error:500") or status.startswith("exception"):
                result["errors"].append({"caller": caller, "tool": where, "status": status})
            _record(result, caller, where, sec.find(body, _sent(args)), status)


async def test_probe_member_surface(client, runtime):
    started = time.monotonic()
    ctx = await make_ctx()
    s = await _setup(client, ctx, runtime)
    sec = _secrets(s)
    values = _values(s)
    print("\nsetup decisions:", s["decisions"])
    print("setup runs:", s["runs"])
    print("setup docs:", s["docs"], "notes:", s["notes"])
    result: dict = {
        "routes_walked": Counter(),
        "tools_called": Counter(),
        "statuses": {},
        "leaks": [],
        "minor": [],
        "errors": [],
        "skipped_tools": {},
        "owner_sees": 0,
        "setup": {k: s[k] for k in ("decisions", "runs", "docs", "notes", "entity_ids")},
    }

    # 1. Every GET route, as cookie and API token callers (and an owner, as the control
    # that proves the secrets are findable).
    tokens = {r: await api_token(ctx.tenant_id, r) for r in ("viewer", "commenter")}
    callers = {
        "owner-cookie": ctx.as_("owner"),
        "viewer-cookie": ctx.as_("viewer"),
        "commenter-cookie": ctx.as_("commenter"),
        "viewer-token": {"Authorization": f"Bearer {tokens['viewer']}"},
        "commenter-token": {"Authorization": f"Bearer {tokens['commenter']}"},
    }
    await _walk_routes(client, callers, values, sec, result)
    print(f"routes done in {time.monotonic() - started:.0f}s")

    # 2. Every read-only MCP tool with each API token.
    for role, raw in tokens.items():
        caller = f"{role}-token-mcp"
        async with mcp_client(raw) as c:
            tools = (await c.list_tools()).tools
            reads, skipped = [], []
            for t in tools:
                ro = bool(t.annotations and t.annotations.read_only_hint)
                (reads if ro or t.name.startswith(READ_PREFIXES) else skipped).append(t)
            result["skipped_tools"][caller] = sorted(t.name for t in skipped)
            result.setdefault("tools_listed", {})[caller] = len(tools)
            await _call_tools(c, caller, reads, values, sec, result)
    print(f"mcp done in {time.monotonic() - started:.0f}s")

    # 3. Each member-visible run flow's tools through its own run token.
    for (flow, who), run_id in s["member_runs"].items():
        for seg in FLOWS[flow].segments:
            names = set(seg.tools)
            for extra in seg.role_tools.values():
                names |= set(extra)
            async with tenant_session(ctx.tenant_id) as db:
                raw = await mint_run_token(db, run_id, seg.scopes, ttl_seconds=3600)
                await db.commit()
            caller = f"run:{flow}/{seg.name} (created by {who})"
            async with mcp_client(raw) as c:
                tools = (await c.list_tools()).tools
                listed = {t.name for t in tools}
                missing = sorted(names - listed)
                if missing:
                    result.setdefault("run_tools_not_listed", {})[caller] = missing
                await _call_tools(c, caller, tools, values, sec, result, only=names)
    elapsed = time.monotonic() - started

    out = {
        "runtime_seconds": round(elapsed, 1),
        "routes_walked": dict(result["routes_walked"]),
        "tools_called": dict(result["tools_called"]),
        "tools_listed": result.get("tools_listed", {}),
        "statuses": {k: dict(v) for k, v in result["statuses"].items()},
        "owner_responses_with_a_secret": result["owner_sees"],
        "leak_count": len(result["leaks"]),
        "leaks": result["leaks"],
        "known_minor_count": len(result["minor"]),
        "known_minor": result["minor"],
        "errors": result["errors"],
        "skipped_tools": result["skipped_tools"],
        "run_tools_not_listed": result.get("run_tools_not_listed", {}),
        "setup": result["setup"],
    }
    ARTIFACTS.mkdir(parents=True, exist_ok=True)
    (ARTIFACTS / "probe-result.json").write_text(json.dumps(out, indent=2, default=str))
    print(f"\n=== probe done in {elapsed:.0f}s ===")
    print("routes walked:", out["routes_walked"])
    print("tools called:", out["tools_called"])
    print("statuses:", out["statuses"])
    print("owner responses with a secret (control):", out["owner_responses_with_a_secret"])
    print("errors (500/timeout):", len(out["errors"]))
    for e in out["errors"][:30]:
        print("  ", e)
    print("LEAKS:", out["leak_count"])
    for leak in out["leaks"]:
        print("  ", leak["caller"], "|", leak["route_or_tool"][:120], "|", leak["secret"])
        print("      ", leak["snippet"].replace("\n", " ")[:300])
    print("known minor (checkpoint rows):", out["known_minor_count"])
    for m in out["known_minor"][:20]:
        print("  ", m["caller"], "|", m["route_or_tool"][:120], "|", m["secret"])
    print("written:", ARTIFACTS / "probe-result.json")
