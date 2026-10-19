"""Curated tools for agents: thin wrappers over REST operations with agent guidance.

Each wrapper finds its operation in the live route table (by operationId, then by
path), so it appears once the lane that owns the route has merged and stays hidden
before that. Calls go through :func:`oracle.mcp.tools.call_operation`, so roles and
run-token scopes apply exactly as for the generated tools.
"""

import copy
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from typing import Any

import mcp_types as types
from fastapi import FastAPI
from sqlalchemy import select

from oracle import confidence
from oracle.mcp.auth import McpCaller
from oracle.mcp.tools import Operation, ToolError, call_operation, to_result
from oracle.tenancy import tenant_session
from oracle.tenant_settings import TenantSetting

CONFIDENCE_GUIDANCE = (
    "Every piece of evidence carries a confidence from 0 to 1 (source kind, freshness, "
    "independent mentions, goal impact). Weigh evidence by its confidence. Items below "
    "the company's low threshold come back with low_confidence: true; when a claim rests "
    "on them, flag it as low confidence instead of stating it as fact."
)


def _by(
    method: str,
    op_ids: tuple[str, ...] = (),
    path: Callable[[str], bool] | None = None,
) -> Callable[[list[Operation]], Operation | None]:
    def find(ops: list[Operation]) -> Operation | None:
        for op in ops:
            if op.method == method and op.operation_id in op_ids and not op.excluded:
                return op
        if path is not None:
            for op in ops:
                if op.method == method and path(op.path) and not op.excluded:
                    return op
        return None

    return find


@dataclass(frozen=True)
class Curated:
    name: str
    description: str
    # Operations this tool needs, by role; the tool is listed only when all exist.
    needs: dict[str, Callable[[list[Operation]], Operation | None]]
    schema: Callable[[dict[str, Operation]], dict[str, Any]]
    run: Callable[
        [FastAPI, McpCaller, dict[str, Operation], dict[str, Any]],
        Awaitable[types.CallToolResult],
    ]
    # Offered to run tokens only, for their own run: listed whatever the token's scopes.
    own_run: bool = False

    def offered_to(self, caller: McpCaller) -> bool | None:
        """True or False for an own-run tool; None: the operations' scopes decide."""
        if not self.own_run:
            return None
        return caller.kind == "run" and caller.run_id is not None

    def resolve(self, ops: list[Operation]) -> dict[str, Operation] | None:
        found = {role: find(ops) for role, find in self.needs.items()}
        if any(op is None for op in found.values()):
            return None
        return found  # type: ignore[return-value]


async def low_threshold(caller: McpCaller) -> float:
    async with tenant_session(caller.tenant_id) as s:
        value = await s.scalar(
            select(TenantSetting.value).where(TenantSetting.key == "confidence_weights")
        )
    return float(confidence.merged(value if isinstance(value, dict) else None)["low"])


def flag_low_confidence(value: Any, low: float) -> Any:
    """Copy of ``value`` where every object with a numeric ``confidence`` gets
    ``low_confidence``: true below ``low``, false otherwise."""
    if isinstance(value, list):
        return [flag_low_confidence(v, low) for v in value]
    if isinstance(value, dict):
        out = {k: flag_low_confidence(v, low) for k, v in value.items()}
        c = value.get("confidence")
        if isinstance(c, int | float) and not isinstance(c, bool):
            out["low_confidence"] = c < low
        return out
    return value


def _same_schema(ops: dict[str, Operation]) -> dict[str, Any]:
    return ops["op"].input_schema()


async def _passthrough_flagged(app, caller, ops, args) -> types.CallToolResult:
    resp = await call_operation(app, caller, ops["op"], args)
    if not resp.ok or not resp.is_json:
        return to_result(resp)
    data = flag_low_confidence(resp.json(), await low_threshold(caller))
    return to_result(resp, data)


def search_hits_with_confidence(data: Any) -> Any:
    """Lift each source search hit's confidence (B1: ``item.confidence``, an object with
    the value, its factor breakdown and the company's ``low`` verdict) to the hit:
    ``confidence`` (0-1), ``low_confidence`` and ``confidence_factors``, next to the
    relevance and the relevance x confidence ``score`` the hits are ranked by."""
    if not isinstance(data, dict) or not isinstance(data.get("hits"), list):
        return data
    hits = []
    for hit in data["hits"]:
        conf = (hit.get("item") or {}).get("confidence") if isinstance(hit, dict) else None
        if isinstance(conf, dict) and isinstance(conf.get("value"), int | float):
            hit = {
                **hit,
                "confidence": conf["value"],
                "low_confidence": bool(conf.get("low")),
                "confidence_factors": conf.get("breakdown") or {},
            }
        hits.append(hit)
    return {**data, "hits": hits}


async def _search(app, caller, ops, args) -> types.CallToolResult:
    resp = await call_operation(app, caller, ops["op"], args)
    if not resp.ok or not resp.is_json:
        return to_result(resp)
    # Numeric confidences get the company's low flag; source hits keep B1's own verdict.
    data = flag_low_confidence(resp.json(), await low_threshold(caller))
    return to_result(resp, search_hits_with_confidence(data))


async def _passthrough(app, caller, ops, args) -> types.CallToolResult:
    return to_result(await call_operation(app, caller, ops["op"], args))


def _without(schema: dict[str, Any], *names: str) -> dict[str, Any]:
    schema = copy.deepcopy(schema)
    for n in names:
        schema["properties"].pop(n, None)
        if n in schema.get("required", []):
            schema["required"].remove(n)
    if not schema.get("required"):
        schema.pop("required", None)
    return schema


async def _open_feedback(app, caller, ops, args) -> types.CallToolResult:
    args = {k: v for k, v in args.items() if k != "status"}
    return to_result(await call_operation(app, caller, ops["op"], {**args, "status": "open"}))


_DOC_MARKDOWN_SCHEMA = {
    "type": "object",
    "properties": {
        "doc": {"type": "string", "description": "Document key or id"},
        "version": {
            "type": "integer",
            "minimum": 1,
            "description": "Version number; the latest version when omitted",
        },
    },
    "required": ["doc"],
}


async def _document_markdown(app, caller, ops, args) -> types.CallToolResult:
    doc, version = args.get("doc"), args.get("version")
    if not doc:
        raise ToolError("Missing required argument(s): doc")
    if version is None:
        resp = await call_operation(app, caller, ops["document"], {"doc": doc})
        if not resp.ok:
            return to_result(resp)
        version = resp.json().get("latest_version")
        if version is None:
            raise ToolError(f"Document {doc} has no versions yet.")
    return to_result(await call_operation(app, caller, ops["markdown"], {"doc": doc, "n": version}))


_PUSH_DRAFT_SCHEMA = {
    "type": "object",
    "properties": {
        "doc": {"type": "string", "description": "Document key; created on first import"},
        "markdown": {
            "type": "string",
            "description": "The full draft: YAML front matter, then the markdown body",
        },
    },
    "required": ["doc", "markdown"],
}


async def _push_draft(app, caller, ops, args) -> types.CallToolResult:
    op = ops["op"]
    missing = [k for k in ("doc", "markdown") if not args.get(k)]
    if missing:
        raise ToolError(f"Missing required argument(s): {', '.join(missing)}")
    return to_result(
        await call_operation(app, caller, op, {"doc": args["doc"], op.body_key: args["markdown"]})
    )


_RUN_OUTPUT_SCHEMA = {
    "type": "object",
    "properties": {
        "seq": {
            "type": "integer",
            "minimum": 1,
            "description": "The segment's number in this run (1 is the first)",
        },
        "name": {"type": "string", "description": "The file name, e.g. baseline.yaml"},
    },
    "required": ["seq", "name"],
}


async def _run_output(app, caller, ops, args) -> types.CallToolResult:
    """A file an earlier segment of the caller's run wrote: the run is the token's own."""
    if caller.kind != "run" or caller.run_id is None:
        raise ToolError("get_run_output is for a run's own agents (a run token).")
    missing = [k for k in ("seq", "name") if args.get(k) in (None, "")]
    if missing:
        raise ToolError(f"Missing required argument(s): {', '.join(missing)}")
    call = {"run_id": str(caller.run_id), "seq": args["seq"], "name": args["name"]}
    return to_result(await call_operation(app, caller, ops["op"], call, check_scopes=False))


def _is_baseline(path: str) -> bool:
    return path.startswith("/v1/baseline")


CURATED: tuple[Curated, ...] = (
    Curated(
        name="search",
        description=(
            "Search the sources you can see (your own connected tools and uploads), "
            "ranked by relevance times confidence. " + CONFIDENCE_GUIDANCE
        ),
        needs={
            "op": _by(
                "GET",
                ("search", "search_sources", "search_items"),
                lambda p: p in ("/v1/search", "/v1/sources/search"),
            )
        },
        schema=_same_schema,
        run=_search,
    ),
    Curated(
        name="get_baseline",
        description=(
            "Read the shared product baseline: goals, products, features, requirements, "
            "constraints, decisions and people, with the edges between them and the "
            "evidence behind each. " + CONFIDENCE_GUIDANCE
        ),
        needs={
            "op": _by(
                "GET",
                ("get_baseline", "read_baseline", "export_baseline", "get_graph"),
                lambda p: p in ("/v1/baseline", "/v1/baseline/graph"),
            )
        },
        schema=_same_schema,
        run=_passthrough_flagged,
    ),
    Curated(
        name="trace_feature",
        description=(
            "Trace features to the goals they serve (the traceability report); features "
            "that serve no confirmed goal are flagged. " + CONFIDENCE_GUIDANCE
        ),
        needs={
            "op": _by(
                "GET",
                (
                    "trace_feature",
                    "get_traceability",
                    "traceability",
                    "traceability_report",
                    "get_traceability_report",
                ),
                lambda p: _is_baseline(p) and "trace" in p,
            )
        },
        schema=_same_schema,
        run=_passthrough_flagged,
    ),
    Curated(
        name="list_open_feedback",
        description=(
            "List the open feedback on a document (comments and section reviews not yet "
            "addressed or declined), optionally for one version. Address each item in the "
            "next draft or say why not."
        ),
        needs={"op": _by("GET", ("list_feedback",))},
        schema=lambda ops: _without(ops["op"].input_schema(), "status"),
        run=_open_feedback,
    ),
    Curated(
        name="get_document_markdown",
        description=(
            "Read a document version as markdown (the latest version unless one is given). "
            "Sections approved in review should not be changed in a new draft."
        ),
        needs={
            "document": _by("GET", ("get_document",)),
            "markdown": _by("GET", ("get_version_markdown",)),
        },
        schema=lambda ops: copy.deepcopy(_DOC_MARKDOWN_SCHEMA),
        run=_document_markdown,
    ),
    Curated(
        name="propose_change",
        description=(
            "Propose a change to the baseline. Proposals wait for a person to accept or "
            "reject them; locked items only change this way. Cite evidence for the change, "
            "and say when that evidence is low confidence. " + CONFIDENCE_GUIDANCE
        ),
        needs={
            "op": _by(
                "POST",
                ("create_proposal", "propose_change", "create_baseline_proposal"),
                lambda p: _is_baseline(p) and p.endswith("/proposals"),
            )
        },
        schema=_same_schema,
        run=_passthrough,
    ),
    Curated(
        name="push_draft",
        description=(
            "Import a draft as the next version of a document (markdown with YAML front "
            "matter); creates the document on first import. Keep the template's final "
            "Sources and data points section, with each data point's confidence, and flag "
            "claims that rest only on low-confidence evidence."
        ),
        needs={"op": _by("POST", ("import_version",))},
        schema=lambda ops: copy.deepcopy(_PUSH_DRAFT_SCHEMA),
        run=_push_draft,
    ),
    Curated(
        name="get_run_output",
        description=(
            "Read a file an earlier segment of this run wrote (by segment number and file "
            "name), e.g. the baseline proposal or the feature set a later step builds on. "
            "Only the run's own files."
        ),
        needs={"op": _by("GET", ("get_run_artifact",))},
        schema=lambda ops: copy.deepcopy(_RUN_OUTPUT_SCHEMA),
        run=_run_output,
        own_run=True,
    ),
)

CURATED_NAMES = frozenset(c.name for c in CURATED)
