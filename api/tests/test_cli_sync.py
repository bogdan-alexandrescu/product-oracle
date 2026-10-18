"""`oracle sync` against a mocked API (httpx.MockTransport)."""

import io
import uuid

import httpx
import pytest

from oracle.cli.oracle_cli import main

A, B, UP, PAUSED = (str(uuid.uuid4()) for _ in range(4))
SOURCES = [
    {"id": A, "name": "Product chat", "kind": "slack", "status": "active"},
    {"id": B, "name": "Repo", "kind": "github", "status": "error"},
    {"id": UP, "name": "Files", "kind": "upload", "status": "active"},
    {"id": PAUSED, "name": "Docs", "kind": "notion", "status": "paused"},
]


@pytest.fixture(autouse=True)
def _env(monkeypatch):
    monkeypatch.setenv("ORACLE_URL", "http://oracle.test:8000/")
    monkeypatch.setenv("ORACLE_API_TOKEN", "po_secret")


def _result(source_id, outcome="completed", **kw):
    name = next(s["name"] for s in SOURCES if s["id"] == source_id)
    return {
        "source_id": source_id,
        "outcome": outcome,
        "upserted": 3,
        "versions_written": 2,
        "deleted": 1,
        "checkpoints": 1,
        "retry_after": kw.get("retry_after"),
        "error": kw.get("error"),
        "source": {"id": source_id, "name": name},
    }


def run(argv, handler):
    requests: list[httpx.Request] = []

    def record(request: httpx.Request) -> httpx.Response:
        requests.append(request)
        return handler(request)

    out, err = io.StringIO(), io.StringIO()
    code = main(argv, transport=httpx.MockTransport(record), out=out, err=err)
    return code, out.getvalue(), err.getvalue(), requests


def test_sync_one_source():
    code, out, err, reqs = run(
        ["sync", "--source", A], lambda r: httpx.Response(200, json=_result(A))
    )
    assert code == 0, err
    (req,) = reqs
    assert req.method == "POST" and req.url.path == f"/v1/sources/{A}/sync"
    assert req.headers["authorization"] == "Bearer po_secret"
    assert out == "Product chat: synced (3 item(s) seen, 2 new version(s), 1 deleted)\n"


def test_sync_all_skips_uploads_and_paused_and_reports_each():
    def handler(r: httpx.Request) -> httpx.Response:
        if r.method == "GET":
            return httpx.Response(200, json=SOURCES)
        if A in r.url.path:
            return httpx.Response(200, json=_result(A, "rate_limited", retry_after=30))
        return httpx.Response(200, json=_result(B, "error", error="The connection was rejected"))

    code, out, _, reqs = run(["sync"], handler)
    assert [r.url.path for r in reqs] == [
        "/v1/sources",
        f"/v1/sources/{A}/sync",
        f"/v1/sources/{B}/sync",
    ]
    assert "Product chat: rate limited, resumes from the saved position" in out
    assert "retry after 30s" in out
    assert "Repo: error: The connection was rejected" in out
    assert code == 1


def test_sync_nothing_to_do():
    code, out, _, _ = run(["sync"], lambda r: httpx.Response(200, json=[SOURCES[2]]))
    assert code == 0 and out == "No sources to sync\n"


def test_sync_refused_source():
    code, _, err, _ = run(
        ["sync", "--source", UP],
        lambda r: httpx.Response(409, json={"detail": "Upload sources have nothing to sync"}),
    )
    assert code == 1
    assert "error 409: Upload sources have nothing to sync" in err
