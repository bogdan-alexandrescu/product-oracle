"""CI installs the same uv as api/Dockerfile on every setup-uv step, never "latest" (#1608),
and uploads the combined coverage.json the floor is raised from (#1711)."""

import re
from pathlib import Path

import pytest

pytestmark = pytest.mark.foreign_read(".github/workflows/ci.yml", "api/Dockerfile")

ROOT = Path(__file__).resolve().parents[2]
CI = ROOT / ".github" / "workflows" / "ci.yml"


def _dockerfile_uv() -> str:
    text = (ROOT / "api" / "Dockerfile").read_text()
    match = re.search(r"ghcr\.io/astral-sh/uv:(\d+\.\d+\.\d+)@sha256:", text)
    assert match, "api/Dockerfile no longer pins uv by version and digest"
    return match.group(1)


def _steps(uses: str) -> list[str]:
    """Each step of ci.yml that uses the action, as its own lines."""
    lines = CI.read_text().splitlines()
    steps = []
    for i, line in enumerate(lines):
        if f"uses: {uses}@" not in line:
            continue
        indent = len(line) - len(line.lstrip(" -"))
        block = [line]
        for nxt in lines[i + 1 :]:
            stripped = nxt.lstrip(" ")
            if stripped.startswith("- ") or (stripped and len(nxt) - len(stripped) < indent):
                break
            block.append(nxt)
        steps.append("\n".join(block))
    return steps


def test_every_setup_uv_step_pins_the_dockerfile_uv():
    """No setup-uv step falls back to the latest uv: each pins api/Dockerfile's version."""
    version = _dockerfile_uv()
    steps = _steps("astral-sh/setup-uv")
    assert steps
    for step in steps:
        assert re.search(rf'^\s+version: "{re.escape(version)}"', step, re.M), step


def test_coverage_json_is_uploaded_before_the_floor_check():
    """coverage-floors uploads api/coverage.json, so the floor can be raised from CI's total."""
    text = CI.read_text()
    job = text[text.index("\n  coverage-floors:") :]
    job = job[: job.index("\n  # ", 1)]
    upload = job.find("name: api-coverage-json")
    assert upload != -1
    assert "path: api/coverage.json" in job
    assert upload < job.index("coverage_floor.py check")
