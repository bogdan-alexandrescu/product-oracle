"""Cancels this workflow's older main runs still in progress (#1564).

CI runs on every merge to main, each in its own concurrency group, so an older train's run
goes on even once a newer run (which contains its commits) has started. This cancels those
older runs, except one whose deploy job has started: a deploy is never cut off midway.

Standard library only. Needs GITHUB_TOKEN with actions: write; GITHUB_REPOSITORY,
GITHUB_RUN_ID and GITHUB_API_URL come from the Actions runner. DEPLOY_JOB_PATTERN (default
"deploy") is matched, case-insensitively, against job names.
"""

import json
import os
import urllib.error
import urllib.request
from collections.abc import Callable

ACTIVE = {"queued", "in_progress", "waiting", "requested", "pending"}


def deploy_started(jobs: list[dict], pattern: str = "deploy") -> bool:
    return any(
        pattern.lower() in job["name"].lower()
        and job.get("started_at")
        and job["status"] not in {"queued", "waiting", "pending"}
        and job.get("conclusion") != "skipped"
        for job in jobs
    )


def superseded(
    current: dict, runs: list[dict], jobs_of: Callable[[int], list[dict]], pattern: str = "deploy"
) -> list[int]:
    """The ids of the runs to cancel: older active runs of the current run's branch."""
    return [
        run["id"]
        for run in sorted(runs, key=lambda r: r["run_number"])
        if run["run_number"] < current["run_number"]
        and run["head_branch"] == current["head_branch"]
        and run["status"] in ACTIVE
        and not deploy_started(jobs_of(run["id"]), pattern)
    ]


def _api(method: str, path: str) -> dict:
    url = f"{os.environ.get('GITHUB_API_URL', 'https://api.github.com')}{path}"
    request = urllib.request.Request(url, method=method)
    request.add_header("Authorization", f"Bearer {os.environ['GITHUB_TOKEN']}")
    request.add_header("Accept", "application/vnd.github+json")
    request.add_header("X-GitHub-Api-Version", "2022-11-28")
    with urllib.request.urlopen(request, timeout=30) as response:
        body = response.read()
    return json.loads(body) if body else {}


def main() -> None:
    repo = os.environ["GITHUB_REPOSITORY"]
    pattern = os.environ.get("DEPLOY_JOB_PATTERN") or "deploy"
    current = _api("GET", f"/repos/{repo}/actions/runs/{os.environ['GITHUB_RUN_ID']}")
    runs: dict[int, dict] = {}
    for status in sorted(ACTIVE):
        listed = _api(
            "GET",
            f"/repos/{repo}/actions/workflows/{current['workflow_id']}/runs"
            f"?branch={current['head_branch']}&status={status}&per_page=100",
        )
        runs |= {run["id"]: run for run in listed["workflow_runs"]}

    def jobs_of(run_id: int) -> list[dict]:
        return _api("GET", f"/repos/{repo}/actions/runs/{run_id}/jobs?per_page=100")["jobs"]

    for run in sorted(runs.values(), key=lambda r: r["run_number"]):
        if run["id"] not in superseded(current, [run], jobs_of, pattern):
            continue
        try:
            _api("POST", f"/repos/{repo}/actions/runs/{run['id']}/cancel")
            print(f"Cancelled run {run['run_number']} ({run['head_sha'][:7]}): superseded")
        except urllib.error.HTTPError as error:  # it finished meanwhile (409)
            print(f"Run {run['run_number']} not cancelled: {error.code}")


if __name__ == "__main__":
    main()
