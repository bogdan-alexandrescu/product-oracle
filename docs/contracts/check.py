"""The docs' published contracts (docs-*.json) say what the docs say (#1570).

    python3 docs/contracts/check.py             # fails on a drift, naming it
    python3 docs/contracts/check.py --write     # refreshes the template hashes

docs-wording.json: each "says" quote is in its doc; "prompts" lists every intake_analysis.vN
its doc names. docs-research-templates.json: the sha256 of each docs/research/templates file.
The API's tests read these copies, never the docs (api/tests/_own_tree_only.py).
"""

import hashlib
import json
import re
import sys
from pathlib import Path

DOCS = Path(__file__).resolve().parents[1]
HERE = DOCS / "contracts"
TEMPLATES = DOCS / "research" / "templates"


def _load(name: str):
    return json.loads((HERE / f"{name}.json").read_text(encoding="utf-8"))


def template_hashes() -> dict[str, str]:
    files = sorted(TEMPLATES.rglob("*.md"))
    return {
        p.relative_to(TEMPLATES).as_posix(): hashlib.sha256(p.read_bytes()).hexdigest()
        for p in files
    }


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
    return out


def main(argv: list[str]) -> int:
    if "--write" in argv:
        text = json.dumps({"sha256": template_hashes()}, indent=2) + "\n"
        (HERE / "docs-research-templates.json").write_text(text, encoding="utf-8")
    found = problems()
    for p in found:
        print(p, file=sys.stderr)
    return 1 if found else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
