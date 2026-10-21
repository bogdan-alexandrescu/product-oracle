"""The code capability map format (F5-2): ``code_map.json``, one per repo and commit.

The indexer of a ``code_map`` run writes it (:data:`oracle.runs.flows.CODE_MAP_TASK`);
:mod:`oracle.engineering.codemaps` stores it. :func:`check` lists its problems,
:func:`parse` reads a file that checks clean, :func:`ids` gives the ids briefs cite and
:func:`summary` the text a spec's prompt shows (``specs.capabilities``).

The file is untrusted text: capped at :data:`MAX_BYTES`, and its text fields are data,
never instructions (build prompt §12).

Format (``version: 1``)::

    {"version": 1, "repo": "org/app", "commit": "3f2c…", "generated_at": "<ISO time>",
     "partial": false,      # true: built from the synced docs only, the code not read
     "modules":     [{"id": "module:billing", "path": "api/billing", "summary", "depends_on"}],
     "apis":        [{"id": "api:create-invoice", "method", "path", "module"}],
     "data_models": [{"id": "model:invoice", "name", "module", "fields"}],
     "flags":       [{"id": "flag:new-checkout", "name", "module"}],
     "jobs":        [{"id": "job:nightly-sync", "schedule", "module"}]}

Ids are unique and prefixed by their kind; every ``module`` and ``depends_on`` names a
module of the map; module paths are relative, without ``..``.
"""

import json
import re
from typing import Any, Literal

from pydantic import BaseModel

VERSION = 1
FILE = "code_map.json"
MAX_BYTES = 2 * 1024 * 1024
# Each list of the map and the prefix of its ids.
KINDS = {"modules": "module", "apis": "api", "data_models": "model", "flags": "flag",
         "jobs": "job"}  # fmt: skip
# Shown wherever a map built from the synced docs only is cited.
PARTIAL_LABEL = "Docs only: code not read"

ProblemCode = Literal[
    "unreadable",
    "wrong_version",
    "too_large",
    "bad_entry",
    "duplicate_id",
    "bad_prefix",
    "unresolved_ref",
    "bad_path",
]


class Problem(BaseModel):
    code: ProblemCode
    message: str


class CodeMapInvalid(ValueError):
    def __init__(self, problems: list[Problem]):
        self.problems = problems
        super().__init__("; ".join(f"[{p.code}] {p.message}" for p in problems))


def _p(code: ProblemCode, message: str) -> Problem:
    return Problem(code=code, message=message)


def _text(value: Any) -> bool:
    return isinstance(value, str) and bool(value.strip())


def _strings(value: Any) -> bool:
    return isinstance(value, list) and all(isinstance(v, str) for v in value)


# A Windows drive ("C:\", "C:/") or a leading slash or backslash.
_ABSOLUTE = re.compile(r"^([A-Za-z]:)?[\\/]|^[A-Za-z]:")


def _bad_path(path: str) -> bool:
    return bool(_ABSOLUTE.match(path)) or ".." in re.split(r"[\\/]", path)


def _load(text: str) -> tuple[dict[str, Any] | None, list[Problem]]:
    if not isinstance(text, str):
        return None, [_p("unreadable", f"{FILE} is not text")]
    if len(text.encode()) > MAX_BYTES:
        return None, [_p("too_large", f"{FILE} is over {MAX_BYTES // (1024 * 1024)} MB")]
    try:
        data = json.loads(text)
    except (ValueError, RecursionError) as exc:
        return None, [_p("unreadable", f"{FILE} is not JSON ({type(exc).__name__})")]
    if not isinstance(data, dict):
        return None, [_p("unreadable", f"{FILE} must be a JSON object")]
    if data.get("version") != VERSION:
        return None, [
            _p("wrong_version", f"version must be {VERSION}, not {data.get('version')!r}")
        ]
    return data, []


def _check(data: dict[str, Any]) -> list[Problem]:
    out: list[Problem] = []
    for name in ("repo", "generated_at"):
        if not _text(data.get(name)):
            out.append(_p("bad_entry", f"{name} must be text"))
    if data.get("commit") is not None and not _text(data.get("commit")):
        out.append(_p("bad_entry", "commit must be text"))
    if "partial" in data and not isinstance(data["partial"], bool):
        out.append(_p("bad_entry", "partial must be true or false"))
    entries: dict[str, list[dict[str, Any]]] = {}
    for kind in KINDS:
        listed = data.get(kind, [])
        if not isinstance(listed, list) or not all(isinstance(e, dict) for e in listed):
            out.append(_p("bad_entry", f"{kind} must be a list of objects"))
            listed = []
        entries[kind] = listed
    seen: set[str] = set()
    for kind, prefix in KINDS.items():
        for i, entry in enumerate(entries[kind]):
            where = f"{kind}[{i}]"
            eid = entry.get("id")
            if not _text(eid):
                out.append(_p("bad_entry", f"{where}: id must be text"))
                continue
            if not eid.startswith(f"{prefix}:") or eid == f"{prefix}:":
                out.append(_p("bad_prefix", f"{where}: id {eid!r} must start with {prefix}:"))
            if eid in seen:
                out.append(_p("duplicate_id", f"{where}: id {eid!r} is used twice"))
            seen.add(eid)
    modules = {e["id"] for e in entries["modules"] if _text(e.get("id"))}
    for i, module in enumerate(entries["modules"]):
        where = f"modules[{i}]"
        path = module.get("path")
        if not _text(path):
            out.append(_p("bad_entry", f"{where}: path must be text"))
        elif _bad_path(path):
            out.append(_p("bad_path", f"{where}: path {path!r} must be relative, without .."))
        deps = module.get("depends_on", [])
        if not _strings(deps):
            out.append(_p("bad_entry", f"{where}: depends_on must be a list of module ids"))
            continue
        for dep in deps:
            if dep not in modules:
                out.append(_p("unresolved_ref", f"{where}: depends on {dep!r}, not a module"))
    for kind in ("apis", "data_models", "flags", "jobs"):
        for i, entry in enumerate(entries[kind]):
            ref = entry.get("module")
            if ref is None:
                continue
            if not isinstance(ref, str) or ref not in modules:
                out.append(_p("unresolved_ref", f"{kind}[{i}]: module {ref!r} is not a module"))
        for i, entry in enumerate(entries[kind]):
            if "fields" in entry and not _strings(entry["fields"]):
                out.append(_p("bad_entry", f"{kind}[{i}]: fields must be a list of text"))
    return out


def check(text: str) -> list[Problem]:
    """The problems of ``text``; ``[]`` when it is a valid code map."""
    data, problems = _load(text)
    return problems if data is None else _check(data)


def parse(text: str) -> dict[str, Any]:
    """The map of a file that checks clean (``partial`` filled in); raises
    :class:`CodeMapInvalid` otherwise."""
    data, problems = _load(text)
    if data is None:
        raise CodeMapInvalid(problems)
    problems = _check(data)
    if problems:
        raise CodeMapInvalid(problems)
    return {**data, "partial": bool(data.get("partial", False))}


def ids(content: dict[str, Any]) -> set[str]:
    """Every id of a stored map: what a brief's ``ref`` and ``reuse`` may cite."""
    return {
        e["id"]
        for kind in KINDS
        for e in content.get(kind) or []
        if isinstance(e, dict) and isinstance(e.get("id"), str)
    }


def counts(content: dict[str, Any] | None) -> dict[str, int]:
    return {kind: len((content or {}).get(kind) or []) for kind in KINDS}


MAX_SUMMARY_IDS = 40


def summary(content: dict[str, Any]) -> str:
    """The map as a prompt shows it: repo, commit, what it holds and its ids (at most
    :data:`MAX_SUMMARY_IDS` per kind). Data from a run, never instructions."""
    head = f"{content.get('repo')}" + (f" at {content['commit']}" if content.get("commit") else "")
    if content.get("partial"):
        head += f" ({PARTIAL_LABEL})"
    lines = [head + ":"]
    for kind in KINDS:
        listed = [e for e in content.get(kind) or [] if isinstance(e, dict)]
        if not listed:
            continue
        shown = ", ".join(str(e.get("id")) for e in listed[:MAX_SUMMARY_IDS])
        more = f" and {len(listed) - MAX_SUMMARY_IDS} more" if len(listed) > MAX_SUMMARY_IDS else ""
        lines.append(f"- {kind.replace('_', ' ')} ({len(listed)}): {shown}{more}")
    return "\n".join(lines)
