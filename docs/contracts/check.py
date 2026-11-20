"""The docs' published contracts (docs-*.json) say what the docs say (#1570).

    python3 docs/contracts/check.py             # fails on a drift, naming it
    python3 docs/contracts/check.py --write     # refreshes the template hashes and YAML texts

docs-wording.json: each "says" quote is in its doc; "prompts" lists every intake_analysis.vN
its doc names. docs-research-templates.json: the sha256 of each docs/research/templates file.
docs-yaml.json: every YAML file, markdown front matter and yaml block outside api/ (the
docs, the root's compose file, the agents' and the web's fixtures), which the API's
safe_yaml must parse as yaml.safe_load does (api/tests/test_safe_yaml.py).
The API's tests read these copies, never the docs (api/tests/_own_tree_only.py).
"""

import hashlib
import json
import re
import sys
from pathlib import Path

DOCS = Path(__file__).resolve().parents[1]
ROOT = DOCS.parent
HERE = DOCS / "contracts"
TEMPLATES = DOCS / "research" / "templates"
_YAML_FENCE = re.compile(r"^```ya?ml[ \t]*\n(.*?)^```", re.DOTALL | re.MULTILINE)
# Not sources (build output, packages, CI config); the API checks its own tree, api/.
_SKIP_DIRS = {
    ".git", ".github", "private", "node_modules", ".venv", "__pycache__",
    "test-results", "playwright-report",
}  # fmt: skip


def _load(name: str):
    return json.loads((HERE / f"{name}.json").read_text(encoding="utf-8"))


def template_hashes() -> dict[str, str]:
    files = sorted(TEMPLATES.rglob("*.md"))
    return {
        p.relative_to(TEMPLATES).as_posix(): hashlib.sha256(p.read_bytes()).hexdigest()
        for p in files
    }


def _front_matter(text: str) -> str | None:
    """The YAML between a leading --- and the next --- or ... (oracle.docs.parser)."""
    lines = text.split("\n")
    if lines[0].strip() != "---":
        return None
    for i in range(1, len(lines)):
        if lines[i].strip() in ("---", "..."):
            return "\n".join(lines[1:i])
    return None


def yaml_texts() -> dict[str, str]:
    out: dict[str, str] = {}
    for path in sorted(ROOT.rglob("*")):
        rel = path.relative_to(ROOT)
        skip = rel.parts[0] == "api" or _SKIP_DIRS & set(rel.parts[:-1])
        skip = skip or any(p.startswith(".next") for p in rel.parts)
        if skip or not path.is_file():
            continue
        if path.suffix in (".yaml", ".yml"):
            out[rel.as_posix()] = path.read_text(encoding="utf-8")
        elif path.suffix == ".md":
            text = path.read_text(encoding="utf-8").replace("\r\n", "\n")
            fm = _front_matter(text)
            if fm is not None:
                out[f"{rel.as_posix()} (front matter)"] = fm
            for n, m in enumerate(_YAML_FENCE.finditer(text), 1):
                out[f"{rel.as_posix()} (yaml block {n})"] = m.group(1)
    return out


def problems() -> list[str]:
    out = []
    wording = _load("docs-wording")
    for doc, quotes in wording["says"].items():
        text = (DOCS / doc).read_text(encoding="utf-8")
        out += [f"docs/{doc} no longer says {q!r}" for q in quotes if q not in text]
    for doc, named in wording["prompts"].items():
        found = sorted(
            set(re.findall(r"intake_analysis\.v\d+", (DOCS / doc).read_text(encoding="utf-8")))
        )
        if found != sorted(named):
            out.append(f"docs/{doc} names {found}, docs-wording.json {sorted(named)}")
    if _load("docs-research-templates")["sha256"] != template_hashes():
        out.append("docs/research/templates changed: run docs/contracts/check.py --write")
    if _load("docs-yaml")["texts"] != yaml_texts():
        out.append("a YAML text outside api/ changed: run docs/contracts/check.py --write")
    return out


def main(argv: list[str]) -> int:
    if "--write" in argv:
        text = json.dumps({"sha256": template_hashes()}, indent=2) + "\n"
        (HERE / "docs-research-templates.json").write_text(text, encoding="utf-8")
        text = json.dumps({"texts": yaml_texts()}, indent=2, ensure_ascii=False) + "\n"
        (HERE / "docs-yaml.json").write_text(text, encoding="utf-8")
    found = problems()
    for p in found:
        print(p, file=sys.stderr)
    return 1 if found else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
