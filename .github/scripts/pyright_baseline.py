#!/usr/bin/env python3
"""#1568: fail on pyright errors that are not in the committed baseline.

  pyright --outputjson > pyright.json   (from the repo root; pyrightconfig.json there)
  python3 .github/scripts/pyright_baseline.py check pyright.json
  python3 .github/scripts/pyright_baseline.py update pyright.json   # after fixing errors
  python3 .github/scripts/pyright_baseline.py --self-test

The baseline (.github/scripts/pyright-baseline.json) counts errors by file, rule and message, with
no line numbers, so moving code does not churn it. `check` fails when any (file, rule, message)
has more errors than the baseline allows. `update` only lowers or drops counts, never adds: the
baseline burns down and never grows. To accept a new error, fix it or add a
`# pyright: ignore[rule]` comment that a reviewer reads.
"""

from __future__ import annotations

import json
import sys
from collections import Counter
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
BASELINE = Path(__file__).resolve().parent / "pyright-baseline.json"

Key = tuple[str, str, str]


def errors(report: dict, root: Path = ROOT) -> Counter[Key]:
    found: Counter[Key] = Counter()
    for d in report.get("generalDiagnostics", []):
        if d.get("severity") != "error":
            continue
        path = Path(d["file"])
        try:
            path = path.relative_to(root)
        except ValueError:
            pass
        found[(path.as_posix(), d.get("rule", ""), d["message"])] += 1
    return found


def load_baseline(path: Path = BASELINE) -> Counter[Key]:
    data = json.loads(path.read_text())
    return Counter({(e["file"], e["rule"], e["message"]): e["count"] for e in data["errors"]})


def dump_baseline(counts: Counter[Key]) -> str:
    rows = [
        {"file": f, "rule": r, "message": m, "count": n}
        for (f, r, m), n in sorted(counts.items())
        if n > 0
    ]
    # One error per line, so a burn-down diff reads as removed lines.
    body = ",\n".join("  " + json.dumps(r) for r in rows)
    return f'{{"total": {sum(counts.values())}, "errors": [\n{body}\n]}}\n'


def new_errors(found: Counter[Key], baseline: Counter[Key]) -> Counter[Key]:
    return Counter({k: n - baseline[k] for k, n in found.items() if n > baseline[k]})


def lowered(found: Counter[Key], baseline: Counter[Key]) -> Counter[Key]:
    return Counter({k: min(n, found[k]) for k, n in baseline.items() if found[k] > 0})


def check(found: Counter[Key], baseline: Counter[Key]) -> int:
    new = new_errors(found, baseline)
    fixed = sum(baseline.values()) - sum(lowered(found, baseline).values())
    print(f"pyright: {sum(found.values())} errors, baseline {sum(baseline.values())}")
    if fixed:
        print(
            f"{fixed} baseline errors are gone: run "
            "`python3 .github/scripts/pyright_baseline.py update pyright.json` and commit it."
        )
    if not new:
        return 0
    print(f"{sum(new.values())} new pyright errors (not in the baseline):")
    for (f, r, m), n in sorted(new.items()):
        print(f"  {f}: [{r}] {m}" + (f" (x{n})" if n > 1 else ""))
    return 1


def self_test() -> int:
    root = Path("/repo")

    def report(*diags: tuple[str, str, str]) -> dict:
        return {
            "generalDiagnostics": [
                {"file": f"/repo/{f}", "severity": "error", "rule": r, "message": m}
                for f, r, m in diags
            ]
            + [{"file": "/repo/a.py", "severity": "warning", "rule": "x", "message": "w"}]
        }

    a = ("api/oracle/a.py", "reportArgumentType", "bad arg")
    b = ("api/oracle/b.py", "reportOptionalMemberAccess", "None")
    base = errors(report(a, a, b), root)
    assert base == Counter({a: 2, b: 1}), base
    assert check(errors(report(a, a, b), root), base) == 0
    assert check(errors(report(a), root), base) == 0
    # A planted error fails, both as a new key and as one more of a known key.
    assert check(errors(report(a, a, b, ("api/oracle/c.py", "r", "m")), root), base) == 1
    assert check(errors(report(a, a, a, b), root), base) == 1
    # update only lowers.
    assert lowered(errors(report(a, ("api/oracle/c.py", "r", "m")), root), base) == Counter({a: 1})
    assert load_round_trip(base) == base
    print("pyright_baseline self-test: ok")
    return 0


def load_round_trip(counts: Counter[Key]) -> Counter[Key]:
    data = json.loads(dump_baseline(counts))
    return Counter({(e["file"], e["rule"], e["message"]): e["count"] for e in data["errors"]})


def main(argv: list[str]) -> int:
    if argv[1:] == ["--self-test"]:
        return self_test()
    if len(argv) != 3 or argv[1] not in ("check", "update"):
        print(__doc__)
        return 2
    found = errors(json.loads(Path(argv[2]).read_text()))
    baseline = load_baseline()
    if argv[1] == "update":
        BASELINE.write_text(dump_baseline(lowered(found, baseline)))
        print(f"baseline: {sum(lowered(found, baseline).values())} errors")
        return 0
    return check(found, baseline)


if __name__ == "__main__":
    sys.exit(main(sys.argv))
