"""CI splits the API suite into shards by file, balanced by the per-file durations committed
in tests/shard_durations.json and refreshed from the shards' junit output (#1563)."""

import json
import os
import subprocess
import sys
from pathlib import Path

from tests import _shard

API = Path(__file__).resolve().parents[1]


def test_every_file_lands_in_exactly_one_shard():
    """CI sharding assigns every test file to exactly one shard, never dropped."""
    durations = {f"tests/test_{c}.py": float(i + 1) for i, c in enumerate("abcdefghij")}
    shards = _shard.assign(list(durations), durations, 3)
    placed = [f for shard in shards for f in shard]
    assert sorted(placed) == sorted(durations)
    assert len(placed) == len(set(placed))


def test_shards_are_balanced_by_duration_not_by_count():
    """CI shards are balanced by measured duration, not by how many files they hold."""
    durations = {"tests/test_slow.py": 100.0}
    durations |= {f"tests/test_quick_{i}.py": 10.0 for i in range(10)}
    shards = _shard.assign(list(durations), durations, 2)
    loads = sorted(sum(durations[f] for f in shard) for shard in shards)
    assert loads == [100.0, 100.0]


def test_the_split_does_not_depend_on_collection_order():
    """The shard split gives the same assignment no matter the input file order."""
    durations = {f"tests/test_{i}.py": float(i % 7 + 1) for i in range(40)}
    files = list(durations)
    assert _shard.assign(files, durations, 4) == _shard.assign(files[::-1], durations, 4)


def test_a_file_with_no_measured_duration_counts_as_the_median():
    """A file with no recorded duration is estimated at the median of the rest."""
    durations = {"tests/test_a.py": 1.0, "tests/test_b.py": 5.0, "tests/test_c.py": 9.0}
    assert _shard.duration_of("tests/test_new.py", durations) == 5.0
    assert _shard.duration_of("tests/test_c.py", durations) == 9.0


def test_refresh_sums_junit_times_per_file(tmp_path):
    """Refreshing durations sums each file's junit test times across shard reports."""
    (tmp_path / "shard-1.xml").write_text(
        """<?xml version="1.0" encoding="utf-8"?>
<testsuites><testsuite name="pytest">
<testcase classname="tests.test_a" name="test_one" file="tests/test_a.py" time="1.25"/>
<testcase classname="tests.test_a.TestThing" name="test_two" file="tests/test_a.py" time="0.75"/>
<testcase classname="tests.c.test_b" name="test_three" file="tests/c/test_b.py" time="3.0"/>
</testsuite></testsuites>"""
    )
    (tmp_path / "shard-2.xml").write_text(
        """<?xml version="1.0" encoding="utf-8"?>
<testsuites><testsuite name="pytest">
<testcase classname="tests.test_c" name="test_four" time="4.5"/>
</testsuite></testsuites>"""
    )
    durations = _shard.durations_from_junit(sorted(tmp_path.glob("*.xml")))
    assert durations == {
        "tests/c/test_b.py": 3.0,
        "tests/test_a.py": 2.0,
        "tests/test_c.py": 4.5,
    }


def test_the_committed_durations_name_test_files_with_positive_seconds():
    """The committed shard durations name real test files with positive seconds."""
    durations = json.loads((API / "tests" / "shard_durations.json").read_text())
    assert len(durations) > 100
    for path, seconds in durations.items():
        assert path.startswith("tests/") and path.endswith(".py"), path
        assert seconds > 0, path


def _collected(*args: str) -> set[str]:
    env = {k: v for k, v in os.environ.items() if k != "PYTEST_XDIST_WORKER"}
    out = subprocess.run(
        [sys.executable, "-m", "pytest", "--collect-only", "-q", "-p", "no:cacheprovider", *args],
        cwd=API,
        env=env,
        capture_output=True,
        text=True,
        check=True,
    ).stdout
    return {line for line in out.splitlines() if "::" in line}


def test_the_shard_options_split_a_run_without_losing_a_test():
    """The pytest shard options split a run across shards without losing a test."""
    files = ["tests/test_ci_shards.py", "tests/test_ci_cancel_superseded.py"]
    everything = _collected(*files)
    shards = [_collected("--num-shards=2", f"--shard-id={k}", *files) for k in (1, 2)]
    assert shards[0] and shards[1]
    assert not shards[0] & shards[1]
    assert shards[0] | shards[1] == everything
