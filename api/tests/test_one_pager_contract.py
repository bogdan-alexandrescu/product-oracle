"""The mock's per-PRD one-pager matches the API's quick read (contract).

web/lib/api/mock/simple-one-pager.ts (``prdOnePager``) copies oracle.simple.one_pager's
``mapping`` and ``extract`` over the fallback blocks by hand. Both read the same invented PRD,
``fixtures/one_pager_contract.md``: this test parses it as an import does, builds the API's
one-pager blocks and compares them with ``fixtures/one_pager_contract.json``;
web/e2e/one-pager-contract.spec.ts runs the mock over the same parsed sections and compares
its blocks with the same file. A change to either side that the other does not copy fails
one of the two.

After a deliberate change to the API's one-pager, rewrite the file and copy the change into
the mock:

    ORACLE_WRITE_CONTRACT=1 uv run pytest tests/test_one_pager_contract.py
"""

import json
import os
from pathlib import Path
from typing import Any

from oracle.docs.models import Section
from oracle.docs.parser import parse_draft
from oracle.simple import one_pager

FIXTURES = Path(__file__).parent / "fixtures"
PRD = FIXTURES / "one_pager_contract.md"
CONTRACT = FIXTURES / "one_pager_contract.json"


def _contract() -> dict[str, Any]:
    markdown = PRD.read_text(encoding="utf-8")
    parsed = parse_draft(markdown)
    sections = [
        {
            "section_key": s.section_key,
            "level": s.level,
            "heading": s.heading,
            "body_md": s.body_md,
            "body_text": s.body_text,
        }
        for s in parsed.sections
    ]
    rows = [
        Section(
            section_key=s.section_key,
            ordinal=s.ordinal,
            level=s.level,
            heading=s.heading,
            body_md=s.body_md,
            body_text=s.body_text,
            content_hash=s.content_hash,
            citation_keys=list(s.citation_keys),
            layer="detail",
        )
        for s in parsed.sections
    ]
    specs = one_pager.FALLBACK
    built = one_pager._numbered(one_pager.extract(specs, one_pager.mapping(specs, rows)))
    by_key = {b["key"]: b for b in built}
    blocks = [
        {
            "key": spec.key,
            "title": spec.title,
            "rules": spec.rules,
            "kind": spec.kind,
            "lines": [
                {
                    "id": line["id"],
                    "text": line["text"],
                    "source_keys": line["source_keys"],
                    "full": line.get("full"),
                    "metric": line.get("metric"),
                }
                for line in by_key[spec.key]["lines"]
            ],
        }
        for spec in specs
    ]
    return {"markdown": markdown, "sections": sections, "blocks": blocks}


def _dump(data: dict[str, Any]) -> str:
    return json.dumps(data, indent=2, ensure_ascii=False) + "\n"


def test_one_pager_contract_matches_the_committed_file() -> None:
    got = _contract()
    if os.environ.get("ORACLE_WRITE_CONTRACT") == "1":
        CONTRACT.write_text(_dump(got), encoding="utf-8")
    assert CONTRACT.exists(), "run with ORACLE_WRITE_CONTRACT=1 to write the contract file"
    assert json.loads(CONTRACT.read_text(encoding="utf-8")) == got, (
        "the API's one-pager for fixtures/one_pager_contract.md changed: rewrite the file "
        "with ORACLE_WRITE_CONTRACT=1 and copy the change into web/lib/api/mock/simple-one-pager.ts"
    )


def test_one_pager_contract_covers_every_kind_of_line() -> None:
    """The fixture keeps exercising what the mock copies: a cut problem with its whole
    text, table rows, a capped list, metrics first, a cut line, a citation resolved."""
    blocks = {b["key"]: b["lines"] for b in _contract()["blocks"]}
    assert blocks["problem"][0]["full"]
    assert any(": " in line["text"] and "brief" not in line["text"] for line in blocks["bets"])
    assert len(blocks["outcomes"]) == 4
    assert all(line["metric"] for line in blocks["outcomes"])
    assert any(line["full"] for line in blocks["risks"])
    lines = [line["text"] for b in blocks.values() for line in b]
    assert not any("[c:" in t for t in lines)
    assert all(b for b in blocks.values())
