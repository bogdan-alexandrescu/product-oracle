"""`oracle accounts` and `oracle account ...` against a mocked API, mirroring SwarmCloud's
tests/unit/mcp/test_account_verbs.py and the render tests for `sc accounts`."""

import io
import json
from datetime import UTC, datetime, timedelta

import httpx
import pytest

from oracle.cli import accounts_render as render
from oracle.cli import oracle_cli
from oracle.cli.oracle_cli import main

NOW = datetime(2026, 10, 18, 12, 0, tzinfo=UTC)


def _account(label, *, state="AVAILABLE", reason="", stale=False, observed=True, **windows):
    return {
        "account_id": f"id-{label}",
        "label": label,
        "state": state,
        "reason": reason,
        "assigned": 1,
        "windows": windows,
        "observed_at": NOW.isoformat() if observed else None,
        "stale": stale,
    }


def _w(utilization, hours=2.0, reset=False):
    return {
        "utilization": utilization,
        "resets_at": (NOW + timedelta(hours=hours)).isoformat(),
        "reset": reset,
    }


PLAIN = render.Style(width=100, unicode=True)


def test_the_table_is_cs_status_columns_with_its_marks():
    rows = [
        _account("live", five_hour=_w(0.34, 1.5), seven_day=_w(0.10, 50)),
        _account("old", stale=True, five_hour=_w(0.5, 3), seven_day=_w(0.9, 30)),
        _account("never", observed=False),
        _account("held", state="PAUSED", reason="for Monday", five_hour=_w(0.0)),
    ]
    lines = render.render_accounts(rows, PLAIN, NOW)
    assert lines[0].split() == ["ACCOUNT", "5H", "USED", "7D", "USED", "CLEARS", "STATE"]
    by = {line.split()[0]: line for line in lines[1:5]}
    assert "34%" in by["live"] and "~" not in by["live"] and "1h 30m" in by["live"]
    assert "~50%" in by["old"] and "~90%" in by["old"] and "1d 06h" in by["old"]
    # Never measured: em dashes, never a zero.
    assert by["never"].count("—") == 3 and "0%" not in by["never"]
    assert "0%" in by["held"] and "paused · for Monday" in by["held"]
    assert lines[-1].strip() == "~ projected from an older reading · — not measured"


def test_no_footnote_when_every_reading_is_current_and_ascii_has_its_own_marks():
    rows = [_account("live", five_hour=_w(0.2))]
    assert not any("projected" in line for line in render.render_accounts(rows, PLAIN, NOW))
    ascii_lines = render.render_accounts(
        [_account("never", observed=False)], render.Style(width=80, unicode=False), NOW
    )
    assert "--" in ascii_lines[1] and "—" not in "".join(ascii_lines)
    assert ascii_lines[-1].strip() == "~ projected from an older reading   -- not measured"


def test_a_narrow_terminal_drops_clears_first_and_a_past_reset_says_cleared():
    rows = [_account("a-rather-long-account-label", five_hour=_w(0.97, -1), seven_day=_w(0.4))]
    narrow = render.render_accounts(rows, render.Style(width=60), NOW)
    assert "CLEARS" not in narrow[0] and "5H USED" in narrow[0]
    wide = render.render_accounts(rows, render.Style(width=120), NOW)
    assert "cleared" in wide[1]


def test_an_empty_pool_says_so():
    assert "no accounts registered" in render.render_accounts([], PLAIN, NOW)[0]


def _run(argv, handler, monkeypatch, stdin=""):
    monkeypatch.setenv("ORACLE_URL", "http://oracle.test")
    monkeypatch.setenv("ORACLE_API_TOKEN", "po_secret")
    monkeypatch.setattr("sys.stdin", io.StringIO(stdin))
    requests: list[httpx.Request] = []

    def record(request: httpx.Request) -> httpx.Response:
        requests.append(request)
        return handler(request)

    out, err = io.StringIO(), io.StringIO()
    code = main(argv, transport=httpx.MockTransport(record), out=out, err=err)
    return code, out.getvalue(), err.getvalue(), requests


LISTING = {
    "accounts": [_account("work", five_hour=_w(0.2)), _account("spare", stale=True)],
    "unreadable_documents": [],
    "unreadable_document_count": 0,
    "refresh_sweep": {"last_completed_at": None, "last_outcome": None, "readable": True},
    "fallback": None,
}


def _api(request: httpx.Request) -> httpx.Response:
    if request.method == "GET":
        return httpx.Response(200, json=LISTING)
    if request.method == "PUT":
        state = json.loads(request.content)["state"]
        return httpx.Response(
            200, json={"account": {**LISTING["accounts"][0], "state": state}, "moving": 2}
        )
    if request.method == "DELETE":
        return httpx.Response(
            200,
            json={
                "removed": "id-work",
                "label": "work",
                "closed_holds": 0,
                "credential": "deleted",
            },
        )
    return httpx.Response(404)


def test_oracle_accounts_prints_the_pool(monkeypatch):
    code, out, err, reqs = _run(["accounts"], _api, monkeypatch)
    assert code == 0, err
    assert str(reqs[0].url) == "http://oracle.test/v1/claude-accounts"
    assert out.startswith("accounts · 2 accounts · 2 jobs assigned · 1 stale")
    assert "ACCOUNT" in out and "CLEARS" in out and "refresh sweep: never completed" in out
    code, out, _, _ = _run(["accounts", "--json"], _api, monkeypatch)
    assert json.loads(out)["accounts"][0]["label"] == "work"


@pytest.mark.parametrize(
    "verb,state", [("pause", "PAUSED"), ("resume", "AVAILABLE"), ("drain", "DRAINING")]
)
def test_the_state_verbs_resolve_by_label_and_say_what_drain_does(monkeypatch, verb, state):
    code, out, err, reqs = _run(
        ["account", verb, "work", "--reason", "held back"], _api, monkeypatch
    )
    assert code == 0, err
    put = reqs[-1]
    assert (put.method, put.url.path) == ("PUT", "/v1/claude-accounts/id-work/state")
    assert json.loads(put.content) == {"state": state, "reason": "held back"}
    assert ("move to another account at their next turn boundary" in out) == (verb == "drain")


def test_an_unknown_account_is_refused_with_the_labels(monkeypatch):
    code, _, err, reqs = _run(["account", "pause", "nope"], _api, monkeypatch)
    assert code == 1 and "accounts: spare, work" in err
    assert all(r.method == "GET" for r in reqs)


def test_remove_needs_the_label_typed_back(monkeypatch):
    code, _, err, reqs = _run(["account", "remove", "work"], _api, monkeypatch, stdin="wrok\n")
    assert code == 1 and "nothing was removed" in err
    assert not any(r.method == "DELETE" for r in reqs)
    code, out, err, reqs = _run(["account", "remove", "work"], _api, monkeypatch, stdin="work\n")
    assert code == 0, err
    assert reqs[-1].method == "DELETE" and "removed work" in out


def test_add_signs_in_through_the_browser_and_never_prints_the_code(monkeypatch):
    state = "s" * 43
    monkeypatch.setattr(oracle_cli, "_open_browser", lambda url: False)
    monkeypatch.setattr(oracle_cli, "_read_code", lambda prompt: f"c0de-secret#{state}")

    def api(request: httpx.Request) -> httpx.Response:
        if request.url.path.endswith("/authorize"):
            assert json.loads(request.content) == {"label": "personal"}
            return httpx.Response(
                200,
                json={"authorize_url": "https://claude.com/x", "state": state,
                      "expires_in_seconds": 900},
            )  # fmt: skip
        assert json.loads(request.content) == {"state": state, "code": f"c0de-secret#{state}"}
        return httpx.Response(
            201,
            json={"account": {"label": "personal", "account_id": "id-p", "state": "AVAILABLE"},
                  "expires_at": NOW.isoformat(), "note": "stored"},
        )  # fmt: skip

    code, out, err, _ = _run(["account", "add", "--label", "personal"], api, monkeypatch)
    assert code == 0, err
    assert "label       personal" in out and "c0de-secret" not in out + err

    def refused(request: httpx.Request) -> httpx.Response:
        if request.url.path.endswith("/authorize"):
            return api(request)
        return httpx.Response(422, json={"detail": f"code c0de-secret#{state} was not accepted"})

    code, out, err, _ = _run(["account", "add", "--label", "personal"], refused, monkeypatch)
    assert code == 1 and "c0de-secret" not in err and state not in err and "****" in err


def test_tick_prints_the_pool_sweep(monkeypatch):
    result = {
        "runs_checked": 0,
        "segments_finished": 0,
        "runs_advanced": 0,
        "runs_paused": 0,
        "errors": [],
        "claude_accounts": {
            "reclaimed": 1,
            "examined": 3,
            "refreshed": 1,
            "reauth_required": ["id-dead"],
            "polled": 3,
            "lease": "ran",
            "errors": [],
        },
    }
    code, out, err, _ = _run(["tick"], lambda r: httpx.Response(200, json=result), monkeypatch)
    assert code == 0, err
    assert "Claude accounts: 1 hold(s) reclaimed, 1 of 3 credential(s) refreshed" in out
    assert "needs a sign-in: id-dead" in out
