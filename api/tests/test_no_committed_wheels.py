"""The API's dependencies come from uv.lock, never from wheel files committed beside it.

Test card: protects=no binary wheel is tracked in the repository; fails_when=a ``*.whl``
is committed (as two once were under api/); no_claim=what uv installs.
"""

import shutil
import subprocess
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]


def test_no_wheel_is_committed():
    if shutil.which("git") is None or not (ROOT / ".git").exists():
        pytest.skip("not a git checkout")
    tracked = subprocess.run(
        ["git", "ls-files", "--", "*.whl"],
        cwd=ROOT,
        capture_output=True,
        text=True,
        check=True,
    ).stdout.split()
    assert tracked == []
