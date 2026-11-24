"""CI's cancel-superseded job (#1564): a newer main run contains every older commit, so the
older runs still in progress are cancelled, except one whose deploy has started."""

import importlib.util
import urllib.error
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


def _run(
    run_id: int,
    number: int,
    status: str = "in_progress",
    branch: str = "main",
    event: str = "push",
) -> dict:
    return {
        "id": run_id,
        "run_number": number,
        "status": status,
        "head_branch": branch,
        "event": event,
        "head_sha": f"{run_id:040d}",
    }


def _job(name: str, status: str, conclusion: str | None = None, started: bool = True) -> dict:
    return {
        "name": name,
        "status": status,
        "conclusion": conclusion,
        "started_at": "2026-11-19T10:00:00Z" if started else None,
    }


CURRENT = _run(500, 50)


def test_older_runs_in_progress_or_queued_are_cancelled():
    """Older in-progress or queued runs on main are cancelled once superseded."""
    runs = [_run(400, 40), _run(410, 41, "queued"), CURRENT]
    jobs = {400: [_job("api", "in_progress")], 410: []}
    assert _script().superseded(CURRENT, runs, jobs.__getitem__) == [400, 410]


def test_the_current_run_and_newer_runs_are_never_cancelled():
    """The current run and any newer run are never cancelled as superseded."""
    runs = [CURRENT, _run(510, 51)]
    assert _script().superseded(CURRENT, runs, lambda run_id: []) == []


def test_a_run_whose_deploy_has_started_is_kept():
    """A run whose deploy job has already started is kept, not cancelled."""
    runs = [_run(400, 40), _run(410, 41), _run(420, 42)]
    jobs = {
        400: [_job("api", "completed", "success"), _job("Deploy api", "in_progress")],
        410: [_job("deploy", "completed", "success")],
        420: [_job("api", "in_progress")],
    }
    assert _script().superseded(CURRENT, runs, jobs.__getitem__) == [420]


def test_a_deploy_that_has_not_started_does_not_keep_a_run():
    """A deploy job that has not started does not protect its run from cancellation."""
    runs = [_run(400, 40), _run(410, 41)]
    jobs = {
        400: [_job("deploy", "queued", started=False)],
        410: [_job("deploy", "completed", "skipped")],
    }
    assert _script().superseded(CURRENT, runs, jobs.__getitem__) == [400, 410]


def test_finished_runs_and_other_branches_are_left_alone():
    """Completed runs and runs on other branches are left alone by the cancel job."""
    runs = [_run(400, 40, "completed"), _run(410, 41, branch="feature")]
    assert _script().superseded(CURRENT, runs, lambda run_id: []) == []


def test_only_push_runs_are_cancelled_by_a_push_run():
    """A push to main never cancels a manually dispatched or scheduled run on main (#1608)."""
    runs = [
        _run(400, 40, event="workflow_dispatch"),
        _run(410, 41, event="schedule"),
        _run(420, 42),
    ]
    assert _script().superseded(CURRENT, runs, lambda run_id: []) == [420]


def test_a_run_that_is_not_a_push_cancels_nothing():
    """A dispatched run is not a newer push, so it supersedes nothing (#1608)."""
    current = _run(500, 50, event="workflow_dispatch")
    assert _script().superseded(current, [_run(400, 40)], lambda run_id: []) == []


@pytest.mark.parametrize(
    "error",
    [
        urllib.error.HTTPError("https://api.example.com", 502, "Bad Gateway", {}, None),
        urllib.error.URLError("connection reset"),
        TimeoutError("timed out"),
    ],
)
@pytest.mark.parametrize("failing", ["/runs/500", "status=", "/jobs"])
def test_a_failed_read_keeps_every_run_and_exits_0(monkeypatch, capsys, error, failing):
    """When a list or jobs read fails, nothing is cancelled and the job stays green (#1608)."""
    module = _script()
    posts: list[str] = []

    def api(method: str, path: str) -> dict:
        if method == "POST":
            posts.append(path)
            return {}
        if failing in path:
            raise error
        if path.endswith("/runs/500"):
            return {**CURRENT, "workflow_id": 7}
        if "/jobs" in path:
            return {"jobs": []}
        return {"workflow_runs": [_run(400, 40)]}

    monkeypatch.setattr(module, "_api", api)
    for name, value in {
        "GITHUB_REPOSITORY": "example/repo",
        "GITHUB_RUN_ID": "500",
        "GITHUB_TOKEN": "x",
    }.items():
        monkeypatch.setenv(name, value)
    module.main()  # does not raise: the job exits 0
    assert posts == []
    assert "kept every run" in capsys.readouterr().out


def test_a_failed_cancel_is_reported_and_the_rest_still_go(monkeypatch, capsys):
    """A cancel POST that fails on the network is reported; the job still exits 0 (#1608)."""
    module = _script()
    posts: list[str] = []

    def api(method: str, path: str) -> dict:
        if method == "POST":
            posts.append(path)
            if "/400/" in path:
                raise urllib.error.URLError("connection reset")
            return {}
        if path.endswith("/runs/500"):
            return {**CURRENT, "workflow_id": 7}
        if "/jobs" in path:
            return {"jobs": []}
        return {"workflow_runs": [_run(400, 40), _run(410, 41)]}

    monkeypatch.setattr(module, "_api", api)
    for name, value in {
        "GITHUB_REPOSITORY": "example/repo",
        "GITHUB_RUN_ID": "500",
        "GITHUB_TOKEN": "x",
    }.items():
        monkeypatch.setenv(name, value)
    module.main()
    assert [p.split("/")[-2] for p in posts] == ["400", "410"]
    assert "Run 40 not cancelled" in capsys.readouterr().out
