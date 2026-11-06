"""Owner's decision (Nov 5): Oracle's cited graph is the Ground Truth in every word a person
reads; its two Detailed tabs are "Ground Truth" and "Running today". No person-facing string
under oracle/ says "Desired state" or "Current state", or "baseline" for the graph.

The check reads every string literal in oracle/ (docstrings aside: those are for the code's
readers, save the API's, which the OpenAPI scan reads), every job prompt Oracle runs with
now and the OpenAPI document's summaries and descriptions. What may still say baseline:

- internal ids: /v1/baseline routes, baseline_* values, read:baseline, baseline.yaml, MCP
  tool names, oracle.baseline modules (anything joined to a "_", "/", ".", ":" or "-");
- the starting value of a key result or goal measure ("baseline value", "its baseline");
- reasons stored before the rename ("N baseline items"), still read and merged;
- instructions that name the old word to forbid it (never "baseline").
"""

import ast
import json
import re
from pathlib import Path

from oracle.jobs import prompting

ORACLE = Path(__file__).resolve().parents[1] / "oracle"

#: "Desired state", "Current state", or "baseline" as a word of its own (not part of an id).
OLD = re.compile(r"desired state|current state|(?<![\w/.:\-])baseline(?![\w/.:\-])", re.I)

#: What may still say baseline, in the starting-value sense or as a name of the old word.
ALLOWED = re.compile(
    "|".join(
        (
            # A key result's or goal measure's starting value.
            r"baseline value",
            r"baseline or target",
            r"(?:its|a|the KR's|the metric's|the measure's|goal's|key result's) baseline\b"
            r"(?! (?:item|feature|graph|page|build|rebuild|proposal|change))",
            r"between the baseline and",
            r"Success metric and baseline",
            r"baseline \(starting value\)",
            r"\bbaseline\|goal\b",
            r"\|baseline\|",
            # Stored reasons written before the rename, still read and merged.
            r"\(\\d\+\) baseline items\?",
            r"\\d\+ baseline items\?",
            # An instruction that forbids the old word, or an id written in a sentence.
            r'never "baseline"',
            r'"baseline decision <key>"',
            r"`oracle baseline pull`",
        )
    ),
    re.I,
)


def _left(text: str) -> list[str]:
    """The old words ``text`` still holds once the allowed uses are out."""
    return [m.group(0) for m in OLD.finditer(ALLOWED.sub("", text))]


def _docstrings(tree: ast.AST) -> set[int]:
    out: set[int] = set()
    for node in ast.walk(tree):
        if (
            isinstance(node, (ast.Module, ast.ClassDef, ast.FunctionDef, ast.AsyncFunctionDef))
            and node.body
        ):
            first = node.body[0]
            if isinstance(first, ast.Expr) and isinstance(first.value, ast.Constant):
                out.add(id(first.value))
    return out


def test_no_person_facing_string_in_oracle_says_an_old_name():
    found = []
    for path in sorted(ORACLE.rglob("*.py")):
        tree = ast.parse(path.read_text())
        docs = _docstrings(tree)
        for node in ast.walk(tree):
            if (
                not (isinstance(node, ast.Constant) and isinstance(node.value, str))
                or id(node) in docs
            ):
                continue
            # Words a person reads have a space; a lone id or key ("baseline") does not.
            if " " in node.value.strip() and _left(node.value):
                found.append(
                    f"{path.relative_to(ORACLE.parent)}:{node.lineno}: {node.value[:120]!r}"
                )
    assert not found, "\n".join(found)


def test_no_job_prompt_oracle_runs_says_an_old_name():
    found = []
    for name in prompting.CURRENT.values():
        text = (prompting.PROMPTS / f"{name}.md").read_text()
        for n, line in enumerate(text.splitlines(), 1):
            if _left(line):
                found.append(f"{name}.md:{n}: {line}")
    assert not found, "\n".join(found)


def test_no_api_summary_or_description_says_an_old_name():
    from oracle.main import create_app

    schema = create_app().openapi()
    found = []

    def walk(node, where):
        if isinstance(node, dict):
            for key, value in node.items():
                if (
                    key in ("summary", "description", "title")
                    and isinstance(value, str)
                    and _left(value)
                ):
                    found.append(f"{where}.{key}: {value[:120]!r}")
                walk(value, f"{where}.{key}")
        elif isinstance(node, list):
            for i, value in enumerate(node):
                walk(value, f"{where}[{i}]")

    walk(schema, "openapi")
    assert not found, json.dumps(found, indent=1)


def test_the_check_catches_the_old_names_and_spares_the_ids():
    """fails_when=the check is blind: each old name is caught, each allowed use is not."""
    for said in (
        "Desired state",
        "It moves to Current state once it ships",
        "Build the baseline",
        "Baseline to PRD",
        "a linked baseline item changed",
        "Confirm the baseline",
    ):
        assert _left(said), said
    for kept in (
        "GET /v1/baseline/graph",
        "the baseline_confirm checkpoint",
        "needs the read:baseline scope",
        "writes baseline.yaml",
        "No success metric with a baseline value and a target is agreed.",
        "The success metrics have no baseline or target number",
    ):
        assert not _left(kept), kept
