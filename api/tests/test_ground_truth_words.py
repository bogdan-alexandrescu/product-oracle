"""Owner's decision (Nov 5): Oracle's cited graph is the Ground Truth in every word a person
reads; its two Detailed tabs are "Ground Truth" and "Running today". No person-facing string
under oracle/ says "Desired state" or "Current state", or "baseline" for the graph.

The check reads every string literal in oracle/ (docstrings aside: those are for the code's
readers, save the API's, which the OpenAPI scan reads), every job prompt Oracle runs with
now and the OpenAPI document's summaries and descriptions (a field's title is its id). What
may still say baseline:

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

#: "Desired state", "Current state", or "baseline" as a word of its own (not part of an id;
#: a full stop ends a sentence unless a word or a "{}" follows it: "baseline.yaml").
OLD = re.compile(r"desired state|current state|(?<![\w/.:\-])baseline(?![\w/:\-]|\.[\w{])", re.I)

#: What may still say baseline, in the starting-value sense or as a name of the old word.
ALLOWED = re.compile(
    "|".join(
        (
            # A key result's or goal measure's starting value.
            r"baseline value",
            r"baseline or target",
            # A value above or below its baseline (a prediction's or a measure's).
            r"(?:above|below) (?:its|a|the) baseline\b",
            # "from/with its baseline" or "a baseline" only beside the measure's target or
            # value, or as a metric's: "from the baseline." alone names the graph.
            r"(?:from|with) (?:its|a|the) baseline\b(?=,? (?:a |and |or )?(?:a )?"
            r"(?:target|value|number|time frame))",
            r"(?:metric|measure|key result|KR) (?:from|with) (?:its|a|the) baseline\b",
            r"(?:the KR's|the metric's|the measure's|goal's|key result's) baseline\b"
            r"(?! (?:item|feature|graph|page|build|rebuild|proposal|change))",
            r"metric, baseline, target",
            r"prediction must be \{\} its baseline",
            r"between the baseline and",
            r"baseline, target and horizon",
            r"Success metric and baseline",
            r"baseline \(starting value\)",
            r"\bbaseline\|goal\b",
            r"\|baseline\|",
            # Stored reasons written before the rename, still read and merged.
            r"\(\\d\+\) baseline items\?",
            r"\\d\+ baseline items\?",
            r"\(\?:Ground Truth\|baseline\) items\?",
            r"\\d\+\) baseline \(items\?\)",
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


#: A lone internal id or key: lowercase, joined by "_" ("baseline", "baseline_confirm").
ID = re.compile(r"[a-z][a-z0-9_]*")
#: A regular expression in the code (it holds a character class such as "\\s").
PATTERN = re.compile(r"\\[sdwSDWb]|\(\?P<")


def _said(value: str) -> list[str]:
    """The old words a literal ``value`` says, unless its shape is an id or a pattern."""
    word = value.strip()
    if ID.fullmatch(word) or PATTERN.search(word):
        return []
    return _left(value)


def _strings(tree: ast.AST):
    """Every string literal in ``tree`` with its line, an f-string as one text ("{}" for
    each value it fills in), docstrings aside."""
    docs = _docstrings(tree)
    parts: set[int] = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.JoinedStr):
            text = ""
            for value in node.values:
                parts.add(id(value))
                is_text = isinstance(value, ast.Constant) and isinstance(value.value, str)
                text += value.value if is_text else "{}"
            yield node.lineno, text
    for node in ast.walk(tree):
        if (
            isinstance(node, ast.Constant)
            and isinstance(node.value, str)
            and id(node) not in docs
            and id(node) not in parts
        ):
            yield node.lineno, node.value


def test_no_person_facing_string_in_oracle_says_an_old_name():
    found = []
    for path in sorted(ORACLE.rglob("*.py")):
        for line, value in _strings(ast.parse(path.read_text())):
            if _said(value):
                found.append(f"{path.relative_to(ORACLE.parent)}:{line}: {value[:120]!r}")
    assert not found, "\n".join(found)


def _yaml_strings(node):
    if isinstance(node, str):
        yield node
    elif isinstance(node, dict):
        for key, value in node.items():
            yield from _yaml_strings(key)
            yield from _yaml_strings(value)
    elif isinstance(node, list):
        for value in node:
            yield from _yaml_strings(value)


def test_no_yaml_under_oracle_says_an_old_name():
    """Module and pack labels, descriptions and briefs: every string in each YAML file."""
    import yaml

    found = []
    for path in sorted(ORACLE.rglob("*.yaml")):
        for doc in yaml.safe_load_all(path.read_text()):
            for value in _yaml_strings(doc):
                if _said(value):
                    found.append(f"{path.relative_to(ORACLE.parent)}: {value[:120]!r}")
    assert not found, "\n".join(found)


def test_no_template_says_an_old_name():
    """A template's briefs and comments are what a run writes from: each line of each one."""
    found = []
    for path in sorted((ORACLE / "templates").rglob("*.md")):
        for n, line in enumerate(path.read_text().splitlines(), 1):
            if _left(line):
                found.append(f"{path.relative_to(ORACLE.parent)}:{n}: {line}")
    assert not found, "\n".join(found)


#: A Jinja tag, expression or comment: code, not words a person reads.
JINJA = re.compile(r"\{\{.*?\}\}|\{%.*?%\}|\{#.*?#\}", re.S)


def _markup_old_names(root: Path) -> list[str]:
    """Every line of every Jinja and HTML template under ``root`` (the PDF, deck and public
    roadmap exports, the members' invite emails) that says an old name, its tags aside."""
    found = []
    for path in sorted(root.rglob("*")):
        if path.suffix not in (".j2", ".html"):
            continue
        # A tag over several lines keeps its line breaks, so each line keeps its number.
        text = JINJA.sub(lambda m: "{}" + "\n" * m.group(0).count("\n"), path.read_text())
        for n, line in enumerate(text.splitlines(), 1):
            if _left(line):
                found.append(f"{path.relative_to(root.parent)}:{n}: {line.strip()[:120]}")
    return found


def test_no_export_or_email_template_says_an_old_name():
    assert not _markup_old_names(ORACLE), "\n".join(_markup_old_names(ORACLE))


def test_the_template_check_reads_every_j2_and_html(tmp_path):
    """fails_when=the check skips the exports' or the emails' templates."""
    root = tmp_path / "oracle"
    (root / "export" / "templates").mkdir(parents=True)
    (root / "members").mkdir()
    (root / "export" / "templates" / "deck.html.j2").write_text(
        "<h1>{{ title }}</h1>\n<p>Read from the Baseline.</p>\n<p>{{ item.baseline }}</p>\n"
    )
    (root / "members" / "invite-email.html").write_text(
        '<p>Change it in Baseline</p>\n<p class="baseline-row">{# the baseline #}</p>\n'
    )
    found = _markup_old_names(root)
    assert [f.split(": ", 1)[0] for f in found] == [
        "oracle/export/templates/deck.html.j2:2",
        "oracle/members/invite-email.html:1",
    ], found


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
                if key in ("summary", "description") and isinstance(value, str) and _left(value):
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
        "Approve a baseline",
        "Change it in Baseline",
        "the feature is in its baseline now",
        "Oracle reads the goal groups from the baseline.",
        "It is read from the baseline",
        "reachable from the baseline (a blocker)",
        "Confirm the baseline.",
    ):
        assert _left(said), said
    for label in ("Baseline", "Current state", "Desired state"):
        assert _said(label), label
    for kept in (
        "GET /v1/baseline/graph",
        "the baseline_confirm checkpoint",
        "needs the read:baseline scope",
        "writes baseline.yaml",
        "No success metric with a baseline value and a target is agreed.",
        "The success metrics have no baseline or target number",
        "Measurable outcomes with a baseline, a target and a time frame.",
        "each with a metric, baseline, target and time frame",
        "an {} prediction must be {} its baseline",
        "an increase prediction must be above its baseline",
        "a metric with a baseline).",
        "Measurable outcomes with a baseline and a target.",
    ):
        assert not _left(kept), kept
    for kept in ("baseline", "baseline_confirm", r"^\s*baseline\s+(?P<type>[a-z_]+)"):
        assert not _said(kept), kept
