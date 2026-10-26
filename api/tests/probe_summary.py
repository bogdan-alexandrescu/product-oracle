"""Add up the probe's JSONL files (tests.probe_member_surface, one per part) into
$SWARM_ARTIFACTS_DIR/probe-result.json and print the totals. Not a test.

  cd api && uv run python -m tests.probe_summary
"""

import json
import os
from collections import Counter
from pathlib import Path

COUNTED = ("routes_walked", "tools_called", "files_fetched", "owner_responses_with_a_secret")
ARTIFACTS = Path(os.environ.get("SWARM_ARTIFACTS_DIR", "/tmp/probe-artifacts"))


def main() -> None:
    parts, leaks, minor, errors, missing, unfinished = {}, [], [], [], [], []
    totals: Counter = Counter()
    for path in sorted((ARTIFACTS / "probe").glob("*.jsonl")):
        counts = None
        for line in path.read_text().splitlines():
            row = json.loads(line)
            kind = row.get("type")
            if kind == "counts":
                counts = row
            elif kind == "leak":
                leaks.append(row)
            elif kind == "minor":
                minor.append(row)
            elif kind == "error":
                errors.append(row)
            elif kind == "not_listed":
                missing.append(row)
        if counts is None:
            unfinished.append(path.stem)
            continue
        parts[path.stem] = counts
        for key in COUNTED:
            totals[key] += counts.get(key, 0)
    out = {
        "parts": len(parts),
        "unfinished_parts": unfinished,
        "totals": dict(totals),
        "leak_count": len(leaks),
        "leaks": leaks,
        "known_minor_count": len(minor),
        "known_minor": minor,
        "error_count": len(errors),
        "errors": errors,
        "run_tools_not_listed": missing,
        "per_part": parts,
    }
    (ARTIFACTS / "probe-result.json").write_text(json.dumps(out, indent=2, default=str))
    keys = ("parts", "unfinished_parts", "totals", "leak_count", "known_minor_count", "error_count")
    print(json.dumps({k: out[k] for k in keys}, indent=2))
    for row in leaks[:40]:
        print("LEAK", row["caller"], "|", row["route_or_tool"][:120], "|", row["secret"])
    for row in errors[:40]:
        print("ERROR", row)


if __name__ == "__main__":
    main()
