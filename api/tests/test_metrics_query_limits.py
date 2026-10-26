# ruff: noqa: F811 - the fixtures are imported
"""H5 security minors (#541): what a metric's HogQL query may do, and the error a failed
pull stores and shows (fixed and redacted; PostHog's own text only in the server log).

Each test's card: protects=<the observable>; fails_when=<the wrong result it rejects>;
no_claim=<what green does not prove>.
"""

import json
import logging

import pytest

from oracle.metrics import posthog
from tests import metrics_helpers
from tests.baseline_helpers import make_ctx
from tests.metrics_helpers import QUERY, clock, connect, create, fake_posthog  # noqa: F401

LEAK = "table secret_billing_ledger does not exist; you may query: secret_billing_ledger_v2"


@pytest.fixture
async def ctx():
    return await make_ctx()


@pytest.mark.parametrize(
    "query",
    [
        QUERY,
        "select count() from events where timestamp >= '{period_start}'",
        "SELECT avg(x) FROM (SELECT count() AS x FROM events GROUP BY person_id);",
        "SELECT count() FROM events e JOIN persons p ON e.person_id = p.id",
        "SELECT count() FROM sessions WHERE $start_timestamp >= '{period_start}'",
        "SELECT count() FROM events WHERE event = 'insert; drop'",
    ],
)
def test_a_read_only_select_over_the_allowed_tables_passes(query):
    """protects=criterion 1: one SELECT over events, persons, sessions or groups (a
    subquery, a join and a trailing semicolon included) is accepted; words inside a
    string do not count; fails_when=a valid metric query is refused; no_claim=HogQL's
    own parser."""
    posthog.check_query(query)


@pytest.mark.parametrize(
    "query",
    [
        "SELECT 1; SELECT 2",
        "INSERT INTO events VALUES (1)",
        "WITH x AS (SELECT 1) SELECT * FROM x",
        "SHOW TABLES",
        "SELECT count() FROM system.tables",
        "SELECT count() FROM cohort_people",
        "SELECT * FROM url('https://example.com/x.csv', CSV)",
        "SELECT * FROM s3('https://bucket.example/x')",
        "SELECT count() FROM events e JOIN raw_sessions r ON e.id = r.id",
        "SELECT count() FROM events -- a comment",
        "SELECT count() FROM events /* a comment */",
        "SELECT count() FROM events SETTINGS max_execution_time = 3600",
        "SELECT count() FROM events INTO OUTFILE 'x'",
        "SELECT count() FROM events FORMAT JSON",
        "",
    ],
)
def test_anything_else_is_refused(query):
    """protects=criterion 1: more than one statement, a write, a WITH, a table outside
    the allowed ones, a table function (url, s3), comments and SETTINGS/INTO/FORMAT are
    refused with a reason; fails_when=any of them reaches PostHog; no_claim=every
    HogQL form."""
    with pytest.raises(posthog.QueryRefused):
        posthog.check_query(query)


async def test_a_refused_query_is_422_and_never_sent(client, ctx, clock, fake_posthog):
    """protects=criterion 1: creating, editing or testing a metric with a refused query
    is 422 and no request reaches PostHog; fails_when=an approver runs any HogQL with
    the owner's key; no_claim=metrics saved before this rule (refused at pull time, the
    next test)."""
    assert (await connect(client, ctx)).status_code == 200
    before = len(fake_posthog.requests)
    bad = "SELECT count() FROM system.tables"
    resp = await create(client, ctx, source="posthog", query=bad)
    assert resp.status_code == 422, resp.text
    resp = await client.post("/v1/metrics/test", json={"query": bad},
                             headers=ctx.as_("approver"))  # fmt: skip
    assert resp.status_code == 422, resp.text
    metric = (await create(client, ctx, source="posthog", query=QUERY)).json()
    sent = len(fake_posthog.requests)
    resp = await client.patch(
        f"/v1/metrics/{metric['id']}",
        json={"query": "SELECT 1; DROP TABLE events", "lock_version": metric["lock_version"]},
        headers=ctx.as_("approver"),
    )
    assert resp.status_code == 422, resp.text
    assert len(fake_posthog.requests) == sent
    assert all("system.tables" not in q for q in fake_posthog.queries()[before:])


async def test_the_sent_query_has_a_row_limit_and_the_read_a_time_limit(
    client, ctx, clock, fake_posthog
):
    """protects=criterion 1: every metric query goes out wrapped in a row limit, and the
    read gives up within the time limit; fails_when=a query can return any number of rows
    or run for as long as PostHog lets it; no_claim=PostHog's own server-side caps."""
    assert (await connect(client, ctx)).status_code == 200
    await create(client, ctx, source="posthog", query=QUERY)
    sent = fake_posthog.metric_queries()
    assert sent and all(q.endswith(f"LIMIT {posthog.MAX_ROWS}") for q in sent)
    assert all(q.startswith("SELECT * FROM (") for q in sent)
    assert posthog.TIMEOUT_SECONDS <= 20


async def test_a_failed_pull_stores_and_shows_a_fixed_error(
    client, ctx, clock, fake_posthog, caplog, monkeypatch
):
    """protects=criterion 1: PostHog's error text never reaches metric.last_error, Pull
    now's 502 or Test's error; every role reads the same fixed sentence; the full text
    (key removed) is in the server log; fails_when=a member reads PostHog's message;
    no_claim=the log's retention."""
    assert (await connect(client, ctx)).status_code == 200
    metric = (await create(client, ctx, source="posthog", query=QUERY)).json()

    async def leaky(request):
        fake_posthog.requests.append(request)
        return metrics_helpers.httpx.Response(
            500, json={"detail": f"{LEAK} (key {metrics_helpers.KEY})"}
        )

    posthog.set_transport(metrics_helpers.httpx.MockTransport(leaky))
    # The migrations' fileConfig disables loggers that already exist; the server's is on.
    monkeypatch.setattr(posthog.log, "disabled", False)
    with caplog.at_level(logging.WARNING, logger="oracle.metrics.posthog"):
        resp = await client.post(f"/v1/metrics/{metric['id']}/pull",
                                 headers=ctx.as_("approver"))  # fmt: skip
    assert resp.status_code == 502
    assert resp.json()["detail"] == posthog.QUERY_FAILED
    assert "secret_billing_ledger" not in resp.text
    assert "secret_billing_ledger" in caplog.text and metrics_helpers.KEY not in caplog.text
    for who in ("owner", "approver", "commenter", "viewer"):
        got = await client.get(f"/v1/metrics/{metric['id']}", headers=ctx.as_(who))
        assert got.status_code == 200
        assert got.json()["last_error"] == posthog.QUERY_FAILED, who
        assert "secret_billing_ledger" not in got.text, who
    resp = await client.post("/v1/metrics/test", json={"query": QUERY},
                             headers=ctx.as_("approver"))  # fmt: skip
    assert resp.json()["error"] == posthog.QUERY_FAILED
    assert "secret_billing_ledger" not in json.dumps(resp.json())


@pytest.mark.parametrize(
    "query",
    [
        # (a) a quoted system table
        "SELECT count() FROM `system.tables`",
        'SELECT count() FROM "system".tables',
        "SELECT count() FROM `system`.`tables`",
        'SELECT count() FROM "system"."tables"',
        'SELECT count() FROM "raw_sessions"',
        "SELECT count() FROM events e JOIN `raw_sessions` r ON e.id = r.id",
        # (b) a quoted table function: the huge scan
        "SELECT count() FROM `numbers`(1000000000000)",
        'SELECT count() FROM "numbers"(1000000000000)',
        "SELECT count() FROM events JOIN `numbers`(10) n ON 1 = 1",
        # (c) a comma join, outside and inside parentheses
        "SELECT count() FROM events, raw_sessions",
        "SELECT count() FROM events AS e, raw_sessions AS r",
        "SELECT count() FROM events e , system.tables",
        "SELECT count() FROM events, numbers(10)",
        "SELECT count() FROM (SELECT 1 AS x FROM events, raw_sessions)",
        "SELECT count() FROM events e JOIN persons p ON e.person_id = p.id, raw_sessions",
        "SELECT count() FROM (SELECT x FROM events), raw_sessions",
        # (d) wrapper-closing or unbalanced parentheses
        "SELECT 1) UNION ALL SELECT event FROM (SELECT event FROM events",
        "SELECT 1) AS t, raw_sessions WHERE (1 = 1",
        "SELECT count() FROM events)",
        "SELECT count(( FROM events",
        "SELECT (count() FROM events",
        # set operators, anywhere
        "SELECT 1 UNION ALL SELECT event FROM events",
        "SELECT count() FROM (SELECT 1 UNION ALL SELECT 2)",
        "SELECT 1 INTERSECT SELECT 1",
        "SELECT 1 EXCEPT SELECT 2",
        "SELECT 1 union distinct SELECT 2",
        # other ways a name or a source hides
        "SELECT count() FROM system . tables",
        "SELECT count() FROM events.raw",
        "SELECT count() FROM (system.tables)",
        "SELECT count() FROM ((SELECT 1), raw_sessions)",
        "SELECT count() FROM events WHERE event IN raw_sessions",
        "SELECT count() FROM events WHERE event IN numbers(10)",
        "SELECT count() FROM events WHERE event GLOBAL IN system.tables",
        "SELECT f'{(SELECT 1)}' FROM events",
        "SELECT count() FROM events WHERE event = 'x",
        "SELECT count() FROM evénts",
        "SELECT count() FROM events WHERE x = {secret}",
    ],
)
def test_quoted_names_comma_joins_and_wrapper_escapes_are_refused(query):
    """protects=#565 review MAJOR 1: a quoted (backtick or double-quoted) table, schema
    or table function, a comma join (outside or inside parentheses), a parenthesis that
    closes the row-limit wrapper or leaves it unbalanced, UNION/INTERSECT/EXCEPT, a
    spaced or parenthesised schema.table, IN over a table, an f-string, an unterminated
    string, a non-ASCII name and a placeholder other than the period's are refused;
    fails_when=any of them reaches PostHog (a system or warehouse table read, a huge
    numbers() scan, or rows past the limit); no_claim=HogQL's own parser."""
    with pytest.raises(posthog.QueryRefused):
        posthog.check_query(query)


@pytest.mark.parametrize(
    "query",
    [
        "SELECT count() FROM events WHERE timestamp >= {period_start} AND timestamp < {period_end}",
        "SELECT count() FROM events WHERE event IN ('a', 'b') AND properties.$os = 'x'",
        "SELECT count() FROM events e LEFT JOIN persons AS p ON e.person_id = p.id "
        "WHERE e.event = 'it''s, `here`' GROUP BY e.event, p.id ORDER BY 1, 2 LIMIT 1",
        "SELECT count() FROM events WHERE event = 'a \\' FROM system.tables'",
        "SELECT sum(x) FROM (SELECT count() AS x FROM events GROUP BY event) AS t",
    ],
)
def test_the_plain_forms_still_pass(query):
    """protects=#565 review MAJOR 1: a comma in a select list, an IN list, GROUP BY or
    ORDER BY, quotes inside a string, an unquoted period placeholder and an aliased
    subquery still pass; fails_when=the stricter checker refuses an ordinary metric
    query; no_claim=HogQL's own parser."""
    posthog.check_query(query)


@pytest.mark.parametrize(
    "query",
    [
        "SELECT 1) UNION ALL SELECT event FROM (SELECT event FROM events",
        "SELECT count() FROM events, raw_sessions",
        "SELECT count() FROM `system.tables`",
    ],
)
async def test_a_bypass_is_422_and_never_sent(client, ctx, clock, fake_posthog, query):
    """protects=#565 review MAJOR 1: the review's bypasses are 422 at Test and create and
    nothing reaches PostHog; fails_when=an approver's quoted, comma-joined or
    wrapper-escaping query is sent with the owner's key; no_claim=PostHog's own caps."""
    assert (await connect(client, ctx)).status_code == 200
    before = len(fake_posthog.requests)
    resp = await client.post("/v1/metrics/test", json={"query": query},
                             headers=ctx.as_("approver"))  # fmt: skip
    assert resp.status_code == 422, resp.text
    assert (await create(client, ctx, source="posthog", query=query)).status_code == 422
    assert len(fake_posthog.requests) == before
