"""CI's cancel-superseded job (#1564): a newer main run contains every older commit, so the
older runs still in progress are cancelled, except one whose deploy has started."""

import importlib.util
from pathlib import Path

import pytest

# The code under test is CI's own script, not a value another tree publishes (#1570).
pytestmark = pytest.mark.foreign_read(".github/scripts/cancel_superseded_runs.py")

SCRIPT = Path(__file__).resolve().parents[2] / ".github" / "scripts" / "cancel_superseded_runs.py"


def _script():
    spec = importlib.util.spec_from_file_location("cancel_superseded_runs", SCRIPT)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def _run(run_id: int, number: int, status: str = "in_progress", branch: str = "main") -> dict:
    return {"id": run_id, "run_number": number, "status": status, "head_branch": branch}


def _job(name: str, status: str, conclusion: str | None = None, started: bool = True) -> dict:
    return {
        "name": name,
        "status": status,
        "conclusion": conclusion,
        "started_at": "2026-11-19T10:00:00Z" if started else None,
    }


CURRENT = _run(500, 50)


def test_older_runs_in_progress_or_queued_are_cancelled():
    runs = [_run(400, 40), _run(410, 41, "queued"), CURRENT]
    jobs = {400: [_job("api", "in_progress")], 410: []}
    assert _script().superseded(CURRENT, runs, jobs.__getitem__) == [400, 410]


def test_the_current_run_and_newer_runs_are_never_cancelled():
    runs = [CURRENT, _run(510, 51)]
    assert _script().superseded(CURRENT, runs, lambda run_id: []) == []


def test_a_run_whose_deploy_has_started_is_kept():
    runs = [_run(400, 40), _run(410, 41), _run(420, 42)]
    jobs = {
        400: [_job("api", "completed", "success"), _job("Deploy api", "in_progress")],
        410: [_job("deploy", "completed", "success")],
        420: [_job("api", "in_progress")],
    }
    assert _script().superseded(CURRENT, runs, jobs.__getitem__) == [420]


def test_a_deploy_that_has_not_started_does_not_keep_a_run():
    runs = [_run(400, 40), _run(410, 41)]
    jobs = {
        400: [_job("deploy", "queued", started=False)],
        410: [_job("deploy", "completed", "skipped")],
    }
    assert _script().superseded(CURRENT, runs, jobs.__getitem__) == [400, 410]


def test_finished_runs_and_other_branches_are_left_alone():
    runs = [_run(400, 40, "completed"), _run(410, 41, branch="feature")]
    assert _script().superseded(CURRENT, runs, lambda run_id: []) == []
