"""Lane 3 `oracle` CLI: push / pull against a mocked API (httpx.MockTransport)."""

import io
import json
import uuid
from datetime import UTC, datetime

import httpx
import pytest

from oracle.cli.oracle_cli import main

DRAFT = """---
document: checkout-redesign
title: Checkout redesign PRD
citations:
  - id: c1
    source: slack
    ref: https://example.slack.com/archives/C123/p1700000000
---

# Checkout redesign PRD {#title}

## 1. Goal trace {#goal-trace}
Serves G1 (activation) [c:c1]
"""

NOW = datetime(2026, 10, 17, 9, 0, tzinfo=UTC).isoformat()


def _version(number: int, warnings=()) -> dict:
    return {
        "id": str(uuid.uuid4()),
        "document_id": str(uuid.uuid4()),
        "number": number,
        "content_hash": "abc",
        "warnings": list(warnings),
        "created_at": NOW,
        "sections": [],
        "citations": [],
    }


@pytest.fixture(autouse=True)
def _env(monkeypatch):
    monkeypatch.setenv("ORACLE_URL", "http://oracle.test:8000/")
    monkeypatch.setenv("ORACLE_API_TOKEN", "po_secret")


@pytest.fixture
def draft(tmp_path):
    path = tmp_path / "draft.md"
    path.write_text(DRAFT, encoding="utf-8")
    return path


def run(argv, handler):
    requests: list[httpx.Request] = []

    def record(request: httpx.Request) -> httpx.Response:
        requests.append(request)
        return handler(request)

    out, err = io.StringIO(), io.StringIO()
    code = main(argv, transport=httpx.MockTransport(record), out=out, err=err)
    return code, out.getvalue(), err.getvalue(), requests


# --- push -------------------------------------------------------------------------


def test_push_imports_draft_and_prints_version(draft):
    code, out, err, reqs = run(
        ["push", str(draft)], lambda r: httpx.Response(201, json=_version(3))
    )
    assert code == 0, err
    (req,) = reqs
    assert req.method == "POST"
    assert str(req.url) == "http://oracle.test:8000/v1/documents/checkout-redesign/versions"
    assert req.headers["authorization"] == "Bearer po_secret"
    assert req.headers["content-type"].startswith("text/markdown")
    assert req.content.decode() == DRAFT  # sent verbatim
    assert "Imported checkout-redesign version 3" in out
    assert "No warnings" in out


def test_push_prints_warnings(draft):
    warning = {
        "code": "locked_section_changed",
        "message": "Approved sections changed",
        "section_keys": ["goal-trace", "s-5-2"],
    }
    code, out, _, _ = run(
        ["push", str(draft)], lambda r: httpx.Response(201, json=_version(2, [warning]))
    )
    assert code == 0
    assert "Imported checkout-redesign version 2" in out
    assert "warning [locked_section_changed]: Approved sections changed (goal-trace, s-5-2)" in out


def test_push_same_content_reports_existing_version(draft):
    code, out, _, _ = run(["push", str(draft)], lambda r: httpx.Response(200, json=_version(1)))
    assert code == 0
    assert "Unchanged: checkout-redesign version 1" in out


def test_push_doc_flag_overrides_front_matter(draft, monkeypatch):
    code, _, _, reqs = run(
        ["push", str(draft), "--doc", "other doc", "--url", "http://flag.test"],
        lambda r: httpx.Response(201, json=_version(1)),
    )
    assert code == 0
    assert str(reqs[0].url) == "http://flag.test/v1/documents/other%20doc/versions"


def test_push_rejected_draft_lists_errors(draft):
    body = {
        "detail": "Draft rejected",
        "errors": [
            {"code": "unknown_citation", "message": "Unknown citation", "cite_key": "c9"},
            {"code": "missing_section_id", "message": "Heading has no id", "line": 12},
        ],
    }
    code, out, err, _ = run(["push", str(draft)], lambda r: httpx.Response(422, json=body))
    assert code == 1
    assert out == ""
    assert "error 422: Draft rejected" in err
    assert "[unknown_citation] Unknown citation (c9)" in err
    assert "[missing_section_id] Heading has no id line 12" in err


def test_push_bad_token(draft):
    code, _, err, _ = run(
        ["push", str(draft)], lambda r: httpx.Response(401, json={"detail": "Not authenticated"})
    )
    assert code == 1
    assert "ORACLE_API_TOKEN" in err


def test_push_needs_token_and_slug(draft, tmp_path, monkeypatch):
    def unreachable(r):
        raise AssertionError("no request expected")

    monkeypatch.delenv("ORACLE_API_TOKEN")
    code, _, err, _ = run(["push", str(draft)], unreachable)
    assert code == 2 and "ORACLE_API_TOKEN is not set" in err

    monkeypatch.setenv("ORACLE_API_TOKEN", "po_secret")
    bare = tmp_path / "bare.md"
    bare.write_text("# T {#t}\n")
    code, _, err, _ = run(["push", str(bare)], unreachable)
    assert code == 2 and "--doc" in err

    code, _, err, _ = run(["push", str(tmp_path / "missing.md")], unreachable)
    assert code == 2 and "cannot read" in err


def test_push_connection_error(draft):
    def boom(r):
        raise httpx.ConnectError("connection refused")

    code, _, err, _ = run(["push", str(draft)], boom)
    assert code == 1 and "cannot reach http://oracle.test:8000" in err


# --- pull -------------------------------------------------------------------------


def _package() -> dict:
    item = {
        "id": str(uuid.uuid4()),
        "document_id": str(uuid.uuid4()),
        "raised_on_version": 2,
        "kind": "comment",
        "section_key": "goal-trace",
        "summary": "Which goal is this — G1 or G2?",
        "anchor": {"exact": "Serves G1", "prefix": "", "suffix": " (activation)"},
        "status": "open",
        "created_at": NOW,
        "updated_at": NOW,
    }
    return {
        "document_id": item["document_id"],
        "slug": "checkout-redesign",
        "title": "Checkout redesign PRD",
        "version": 2,
        "markdown": DRAFT,
        "open_items": [item],
        "locked_section_keys": ["title", "s-5-2"],
        "generated_at": NOW,
    }


def test_pull_writes_feedback_package(tmp_path):
    package = _package()
    out_dir = tmp_path / "feedback" / "v2"
    code, out, err, reqs = run(
        ["pull", "checkout-redesign", "--version", "2", "--out", str(out_dir)],
        lambda r: httpx.Response(200, json=package),
    )
    assert code == 0, err
    (req,) = reqs
    assert req.method == "GET"
    assert str(req.url) == (
        "http://oracle.test:8000/v1/documents/checkout-redesign/versions/2/feedback-package"
    )
    assert req.headers["authorization"] == "Bearer po_secret"

    stem = out_dir / "checkout-redesign-v2"
    assert (out_dir / "checkout-redesign-v2.md").read_text(encoding="utf-8") == DRAFT
    items = json.loads(stem.with_suffix(".open-items.json").read_text(encoding="utf-8"))
    assert items == package["open_items"]
    assert items[0]["summary"] == "Which goal is this — G1 or G2?"  # UTF-8, not escaped
    locked = json.loads(stem.with_suffix(".locked.json").read_text(encoding="utf-8"))
    assert locked == ["title", "s-5-2"]
    full = json.loads(stem.with_suffix(".feedback-package.json").read_text(encoding="utf-8"))
    assert full == package

    assert "Pulled checkout-redesign-v2: 1 open item(s), 2 locked section(s)" in out
    assert "(title, s-5-2)" in out


def test_pull_defaults_to_current_directory(tmp_path, monkeypatch):
    monkeypatch.chdir(tmp_path)
    code, _, _, _ = run(
        ["pull", "checkout-redesign", "--version", "2"],
        lambda r: httpx.Response(200, json=_package()),
    )
    assert code == 0
    assert sorted(p.name for p in tmp_path.iterdir()) == [
        "checkout-redesign-v2.feedback-package.json",
        "checkout-redesign-v2.locked.json",
        "checkout-redesign-v2.md",
        "checkout-redesign-v2.open-items.json",
    ]


def test_pull_missing_version(tmp_path):
    code, _, err, _ = run(
        ["pull", "checkout-redesign", "--version", "9", "--out", str(tmp_path / "x")],
        lambda r: httpx.Response(404, json={"detail": "Version not found"}),
    )
    assert code == 1
    assert "error 404: Version not found" in err
    assert not (tmp_path / "x").exists()


def test_pull_requires_version():
    with pytest.raises(SystemExit) as exc:
        main(["pull", "checkout-redesign"], err=io.StringIO())
    assert exc.value.code == 2


def test_console_script_is_installed():
    from importlib.metadata import entry_points

    (ep,) = [e for e in entry_points(group="console_scripts") if e.name == "oracle"]
    assert ep.value == "oracle.cli.oracle_cli:main"
