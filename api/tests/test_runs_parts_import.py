"""#1576: every module split out of runs/service.py imports first, in a fresh interpreter."""

import subprocess
import sys
from pathlib import Path

import pytest

API = Path(__file__).resolve().parents[1]
PARTS = sorted(
    path.stem
    for path in (API / "oracle" / "runs").glob("*.py")
    if "from oracle.runs import" in path.read_text() and "service" in path.read_text()
)


def test_the_parts_are_found():
    assert {"advance", "inbox", "reads", "tick", "submission"} <= set(PARTS)


@pytest.mark.parametrize("part", PARTS)
def test_a_part_imports_before_service(part):
    probe = (
        f"import oracle.runs.{part}\n"
        "from oracle.runs import service\n"
        "assert service.tick and service._advance and service._Refs\n"
    )
    done = subprocess.run(
        [sys.executable, "-c", probe], cwd=API, capture_output=True, text=True, timeout=120
    )
    assert done.returncode == 0, done.stderr[-2000:]
