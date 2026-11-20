"""Splits the suite into shards by file for CI (#1563), balanced by measured durations.

``--num-shards=N --shard-id=K`` (K from 1) keeps the tests of the files in shard K and
deselects the rest. Files are placed longest first, each on the shard with the least time
so far, using the per-file seconds in ``shard_durations.json``; a file with no measured
time counts as the median. Every shard (and every xdist worker) computes the same split
from the same collection, so the shards together run each test once.

Refresh the durations from the shards' junit output (CI uploads it as ``api-junit-K``):

    uv run python -m tests._shard refresh junit/*.xml
"""

import heapq
import json
import statistics
import sys
import xml.etree.ElementTree as ET
from collections.abc import Iterable
from pathlib import Path

import pytest

DURATIONS = Path(__file__).with_name("shard_durations.json")


def duration_of(path: str, durations: dict[str, float]) -> float:
    if path in durations:
        return durations[path]
    return statistics.median(durations.values()) if durations else 1.0


def assign(files: Iterable[str], durations: dict[str, float], num_shards: int) -> list[list[str]]:
    shards: list[list[str]] = [[] for _ in range(num_shards)]
    loads = [(0.0, k) for k in range(num_shards)]
    for path in sorted(set(files), key=lambda f: (-duration_of(f, durations), f)):
        load, k = heapq.heappop(loads)
        shards[k].append(path)
        heapq.heappush(loads, (load + duration_of(path, durations), k))
    return shards


def _file_of(case: ET.Element) -> str:
    if case.get("file"):
        return case.get("file", "").replace("\\", "/")
    # xunit2 has no file attribute: tests.pkg.test_mod[.TestClass] -> tests/pkg/test_mod.py
    parts = case.get("classname", "").split(".")
    modules = [i for i, part in enumerate(parts) if part.startswith("test_")]
    return "/".join(parts[: modules[-1] + 1 if modules else len(parts)]) + ".py"


def durations_from_junit(paths: Iterable[Path]) -> dict[str, float]:
    totals: dict[str, float] = {}
    for path in paths:
        for case in ET.parse(path).iter("testcase"):
            file = _file_of(case)
            totals[file] = totals.get(file, 0.0) + float(case.get("time") or 0)
    return {file: round(max(seconds, 0.01), 2) for file, seconds in sorted(totals.items())}


def pytest_addoption(parser: pytest.Parser) -> None:
    group = parser.getgroup("shard", "CI shards, balanced by tests/shard_durations.json")
    group.addoption("--num-shards", type=int, default=0, help="split the run into N shards")
    group.addoption("--shard-id", type=int, default=0, help="run shard K of N (from 1)")


@pytest.hookimpl(trylast=True)
def pytest_collection_modifyitems(config: pytest.Config, items: list[pytest.Item]) -> None:
    num_shards = config.getoption("num_shards")
    if not num_shards:
        return
    shard_id = config.getoption("shard_id")
    if not 1 <= shard_id <= num_shards:
        raise pytest.UsageError(f"--shard-id must be 1 to {num_shards}, not {shard_id}")
    durations = json.loads(DURATIONS.read_text()) if DURATIONS.exists() else {}

    def file_of(item: pytest.Item) -> str:
        return item.path.relative_to(config.rootpath).as_posix()

    mine = set(assign({file_of(item) for item in items}, durations, num_shards)[shard_id - 1])
    keep = [item for item in items if file_of(item) in mine]
    deselected = [item for item in items if file_of(item) not in mine]
    if deselected:
        config.hook.pytest_deselected(items=deselected)
        items[:] = keep


def main(argv: list[str]) -> None:
    if len(argv) < 2 or argv[0] != "refresh":
        sys.exit("usage: python -m tests._shard refresh JUNIT.xml [...]")
    measured = durations_from_junit(Path(p) for p in argv[1:])
    # A file the junit missed (a timing-only file, a shard that did not finish) keeps its old
    # time while it exists; a deleted file drops out.
    old = json.loads(DURATIONS.read_text()) if DURATIONS.exists() else {}
    api = DURATIONS.parents[1]
    kept = {f: s for f, s in old.items() if f not in measured and (api / f).exists()}
    durations = dict(sorted((measured | kept).items()))
    DURATIONS.write_text(json.dumps(durations, indent=1, sort_keys=True) + "\n")
    print(f"{DURATIONS.name}: {len(durations)} files, {sum(durations.values()) / 60:.0f} min")


if __name__ == "__main__":
    main(sys.argv[1:])
