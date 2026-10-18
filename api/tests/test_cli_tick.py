"""`oracle tick` against a mocked API."""

import io

import httpx

from oracle.cli.oracle_cli import main

RESULT = {
    "runs_checked": 2,
    "segments_finished": 1,
    "runs_advanced": 1,
    "runs_paused": 0,
    "errors": ["run x: SwarmCloud refused"],
}


def _run(argv, handler):
    requests: list[httpx.Request] = []

    def record(request: httpx.Request) -> httpx.Response:
        requests.append(request)
        return handler(request)

    out, err = io.StringIO(), io.StringIO()
    code = main(argv, transport=httpx.MockTransport(record), out=out, err=err)
    return code, out.getvalue(), err.getvalue(), requests


def test_tick_posts_and_prints_a_summary(monkeypatch):
    monkeypatch.setenv("ORACLE_URL", "http://oracle.test:8000")
    monkeypatch.setenv("ORACLE_API_TOKEN", "po_secret")
    code, out, err, reqs = _run(["tick"], lambda r: httpx.Response(200, json=RESULT))
    assert code == 0, err
    (req,) = reqs
    assert (req.method, str(req.url)) == ("POST", "http://oracle.test:8000/v1/internal/tick")
    assert req.headers["authorization"] == "Bearer po_secret"
    assert "Checked 2 run(s): 1 segment(s) finished, 1 advanced, 0 paused" in out
    assert "error: run x: SwarmCloud refused" in out


def test_tick_refused(monkeypatch):
    monkeypatch.setenv("ORACLE_API_TOKEN", "po_secret")
    code, _, err, _ = _run(
        ["tick"], lambda r: httpx.Response(403, json={"detail": "Requires the owner role"})
    )
    assert code == 1
    assert "error 403: Requires the owner role" in err


def test_tick_needs_a_token(monkeypatch):
    monkeypatch.delenv("ORACLE_API_TOKEN", raising=False)
    code, _, err, _ = _run(["tick"], lambda r: httpx.Response(200, json=RESULT))
    assert code == 2 and "ORACLE_API_TOKEN" in err


def test_tick_prints_the_built_in_jobs(monkeypatch):
    monkeypatch.setenv("ORACLE_URL", "http://oracle.test:8000")
    monkeypatch.setenv("ORACLE_API_TOKEN", "po_secret")
    result = {
        **RESULT,
        "errors": [],
        "llm_jobs": {
            "ran": 3,
            "succeeded": 1,
            "failed": 1,
            "retried": 1,
            "errors": ["job j1: No Claude account can take this call: the pool is paused"],
        },
    }
    code, out, err, _ = _run(["tick"], lambda r: httpx.Response(200, json=result))
    assert code == 0, err
    assert "Built-in jobs: 3 ran, 1 succeeded, 1 failed, 1 retried" in out
    assert "  error: job j1: No Claude account can take this call" in out
