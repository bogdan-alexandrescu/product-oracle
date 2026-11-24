#!/usr/bin/env python3
"""#1567: fail when the api suite's total line coverage drops below the committed floor.

  python3 .github/scripts/coverage_floor.py check api/coverage.json
  python3 .github/scripts/coverage_floor.py update api/coverage.json   # raise the floor
  python3 .github/scripts/coverage_floor.py --self-test

coverage.json is `coverage json` over the combined data of every api shard. The floor
(api/coverage-floor.json, a percentage with one decimal) ratchets: `update` raises it to the
measured total rounded down to 0.1 and never lowers it. `check` fails when the total is more
than STALE points above the floor (#1711): the floor follows the total, so a drop cannot hide
in the gap. CI uploads coverage.json, so `update` can run on the downloaded copy.
"""

from __future__ import annotations

import json
import math
import os
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
FLOOR = ROOT / "api" / "coverage-floor.json"
STALE = 1.0


def total(report: dict) -> float:
    return float(report["totals"]["percent_covered"])


def rounded_down(percent: float) -> float:
    return math.floor(percent * 10 + 1e-9) / 10


def raised(floor: float, percent: float) -> float:
    return max(floor, rounded_down(percent))


def check(percent: float, floor: float) -> int:
    print(f"api coverage: {percent:.2f}% (floor {floor:.1f}%)")
    summary = os.environ.get("GITHUB_STEP_SUMMARY")
    if summary:
        with open(summary, "a") as f:
            f.write(f"api coverage: {percent:.2f}% (floor {floor:.1f}%)\n")
    if percent < floor:
        print(
            f"Coverage fell below the floor by {floor - percent:.2f} points: "
            "add tests for the new code, or restore the tests that were removed."
        )
        return 1
    if raised(floor, percent) > floor:
        print(
            f"The floor can rise to {raised(floor, percent):.1f}%: run "
            "`python3 .github/scripts/coverage_floor.py update api/coverage.json` and commit it."
        )
    if percent - floor > STALE + 1e-9:
        print(f"The floor is more than {STALE:.0f} point under the total: raise it (above).")
        return 1
    return 0


def self_test() -> int:
    assert total({"totals": {"percent_covered": 71.237}}) == 71.237
    assert rounded_down(71.29) == 71.2
    assert rounded_down(71.3) == 71.3
    assert check(71.3, 71.2) == 0
    assert check(71.2, 71.2) == 0
    # A planted drop fails.
    assert check(71.19, 71.2) == 1
    # A floor more than 1 point under the total is stale and fails (#1711).
    assert check(72.2, 71.2) == 0
    assert check(72.21, 71.2) == 1
    assert check(79.22, 46.9) == 1
    # The floor never goes down.
    assert raised(71.2, 60.0) == 71.2
    assert raised(71.2, 75.55) == 75.5
    print("coverage_floor self-test: ok")
    return 0


def main(argv: list[str]) -> int:
    if argv[1:] == ["--self-test"]:
        return self_test()
    if len(argv) != 3 or argv[1] not in ("check", "update"):
        print(__doc__)
        return 2
    percent = total(json.loads(Path(argv[2]).read_text()))
    floor = float(json.loads(FLOOR.read_text())["floor"])
    if argv[1] == "update":
        new = raised(floor, percent)
        FLOOR.write_text(json.dumps({"floor": new}) + "\n")
        print(f"floor: {new:.1f}%")
        return 0
    return check(percent, floor)


if __name__ == "__main__":
    sys.exit(main(sys.argv))
