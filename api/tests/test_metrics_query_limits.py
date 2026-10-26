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


KEYWORD_ALIASES = [
    # a clause word after AS
    "SELECT count() FROM events AS order, cohort_people",
    "SELECT count() FROM events AS where, cohort_people",
    "SELECT count() FROM events AS limit, cohort_people",
    "SELECT count() FROM events AS group, cohort_people",
    "SELECT count() FROM events AS Qualify, cohort_people",
    "SELECT 1 FROM (SELECT count() FROM events AS where, cohort_people)",
    "SELECT count() FROM (SELECT * FROM events AS order, numbers(1000000))",
    "SELECT count() FROM events WHERE person_id IN "
    "(SELECT id FROM persons AS having, cohort_people)",
    "SELECT count() FROM (SELECT 1 AS x FROM events) AS offset, cohort_people",
    "SELECT count() FROM events e JOIN persons AS window ON e.person_id = window.id, cohort_people",
    # a clause word directly after the table: an implicit alias
    "SELECT count() FROM events order, cohort_people",
    "SELECT count() FROM events where, cohort_people",
    "SELECT count() FROM events prewhere , cohort_people",
    "SELECT 1 FROM (SELECT count() FROM events order, cohort_people)",
    "SELECT count() FROM (SELECT * FROM events limit, numbers(1000000))",
    "SELECT count() FROM events WHERE person_id IN (SELECT id FROM persons having, cohort_people)",
    "SELECT count() FROM (SELECT 1 AS x FROM events) offset, cohort_people",
    "SELECT count() FROM events e JOIN persons limit ON e.person_id = limit.id, cohort_people",
    "SELECT count() FROM events AS e where, cohort_people",
    "SELECT count() FROM events where JOIN persons p ON 1 = 1, cohort_people",
]


@pytest.mark.parametrize("query", KEYWORD_ALIASES)
def test_a_keyword_used_as_a_table_alias_is_refused(query):
    """protects=#608 re-review MAJOR 1: a clause word (ORDER, WHERE, HAVING, LIMIT, ...)
    used as a table's alias, after AS or bare, does not end the FROM clause, so a comma
    join after it is still refused, with and without subqueries; fails_when=an approver's
    metric reads cohort_people or scans numbers() past the allowed tables;
    no_claim=HogQL's own parser."""
    with pytest.raises(posthog.QueryRefused):
        posthog.check_query(query)
    with pytest.raises(posthog.QueryRefused):
        posthog.check_query(posthog.limited(query))


@pytest.mark.parametrize("query", KEYWORD_ALIASES[:3] + KEYWORD_ALIASES[10:12])
async def test_the_pull_path_refuses_a_keyword_alias(fake_posthog, query):
    """protects=#608 re-review MAJOR 1: query_number, which the weekly pull and Check now
    call on a saved metric, refuses a keyword-aliased comma join before any request;
    fails_when=a saved metric reads a table outside the allowed four with the owner's
    key; no_claim=PostHog's own caps."""
    conn = posthog.Connection(host="eu", project_id="12345", api_key="phx_test")
    with pytest.raises(posthog.PostHogError):
        await posthog.query_number(conn, query)
    assert fake_posthog.requests == []


@pytest.mark.parametrize(
    "query",
    [
        "SELECT count() FROM events WHERE event IN(cohort_people)",
        "SELECT count() FROM events WHERE event IN ( cohort_people )",
        "SELECT count() FROM events WHERE in(event, cohort_people)",
        "SELECT count() FROM events WHERE event NOT IN (raw_sessions)",
        "SELECT count() FROM events WHERE in(event, events)",
    ],
)
def test_a_bare_name_as_an_in_operand_is_refused(query):
    """protects=#608 re-review minor: IN (name) and in(x, name) with a bare name, which
    HogQL may read as a table, are refused; fails_when=an IN reads cohort_people or
    another table; no_claim=HogQL's own parser."""
    with pytest.raises(posthog.QueryRefused):
        posthog.check_query(query)


@pytest.mark.parametrize(
    "query",
    [
        "SELECT count() FROM events WHERE event = 'x' ORDER BY 1 LIMIT 1 OFFSET 0",
        "SELECT count() FROM events e WHERE e.event = 'x' GROUP BY e.event HAVING count() > 1",
        "SELECT count() FROM events AS e PREWHERE e.event = 'x'",
        "SELECT count() AS c FROM (SELECT 1 AS x FROM events) AS t WHERE t.x = 1 LIMIT 1",
        "SELECT count() FROM events WHERE event IN ('a', 'b') AND person_id IN "
        "(SELECT id FROM persons WHERE id IN (1, 2))",
        "SELECT count() FROM events WHERE event IN (NULL, 'a')",
        "SELECT count() FROM events WHERE event IN (lower('A'), 'b')",
    ],
)
def test_clauses_after_a_table_or_alias_still_pass(query):
    """protects=#608 re-review MAJOR 1: WHERE, PREWHERE, GROUP BY, HAVING, ORDER BY,
    LIMIT and OFFSET after a table, its alias or a subquery still end the FROM clause, and
    IN over literals, calls or a subquery passes; fails_when=the stricter alias rule
    refuses an ordinary metric query; no_claim=HogQL's own parser."""
    posthog.check_query(query)


@pytest.mark.parametrize(
    "query",
    [
        "SELECT 1) UNION ALL SELECT event FROM (SELECT event FROM events",
        "SELECT count() FROM events, raw_sessions",
        "SELECT count() FROM `system.tables`",
        "SELECT count() FROM events AS order, cohort_people",
        "SELECT count() FROM events order, cohort_people",
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


SAMPLE_OFFSETS = [
    "SELECT count() FROM events SAMPLE 1 OFFSET 0, cohort_people",
    "SELECT count() FROM events SAMPLE 1/10 OFFSET 1/2, cohort_people",
    "SELECT count() FROM (SELECT * FROM events SAMPLE 1 OFFSET 0, numbers(1000000))",
    "SELECT count() FROM events AS e SAMPLE 0.1 OFFSET 0.5, cohort_people",
    "SELECT count() FROM events FINAL SAMPLE 1 OFFSET 0, cohort_people",
    "SELECT count() FROM events WHERE person_id IN "
    "(SELECT id FROM persons SAMPLE 1 OFFSET 0, cohort_people)",
]


@pytest.mark.parametrize("query", SAMPLE_OFFSETS)
def test_a_comma_join_after_sample_offset_is_refused(query):
    """protects=#643 re-review MAJOR 1: HogQL's SAMPLE r OFFSET r belongs to the table, so
    its OFFSET does not end the FROM clause and a comma join after it is refused, in
    check_query and in the row-limited text; fails_when=an approver's metric reads
    cohort_people or scans numbers() past the allowed tables; no_claim=HogQL's own
    parser (sqlglot's ClickHouse grammar is the one checked)."""
    with pytest.raises(posthog.QueryRefused):
        posthog.check_query(query)
    with pytest.raises(posthog.QueryRefused):
        posthog.check_query(posthog.limited(query))


@pytest.mark.parametrize("query", SAMPLE_OFFSETS[:3])
async def test_the_pull_path_refuses_a_sample_offset_join(fake_posthog, query):
    """protects=#643 re-review MAJOR 1: query_number (the weekly pull and Check now)
    refuses the SAMPLE OFFSET comma join before any request; fails_when=a saved metric
    reads a table outside the allowed four with the owner's key; no_claim=PostHog's caps."""
    conn = posthog.Connection(host="eu", project_id="12345", api_key="phx_test")
    with pytest.raises(posthog.PostHogError):
        await posthog.query_number(conn, query)
    assert fake_posthog.requests == []


@pytest.mark.parametrize(
    "query",
    [
        # a clause word after "." does not end the join's ON
        "SELECT count() FROM events e JOIN persons p ON e.properties.limit = 1, cohort_people",
        "SELECT count() FROM events e JOIN persons p ON p.properties.where = 1, cohort_people",
        # IN forms that read a table
        "SELECT count() FROM events WHERE event IN ((cohort_people))",
        "SELECT count() FROM events WHERE event IN [cohort_people]",
        "SELECT count() FROM events WHERE notIn(event, cohort_people)",
        "SELECT count() FROM events WHERE globalIn(event, cohort_people)",
        "SELECT count() FROM events WHERE globalNotIn(event, cohort_people)",
        "SELECT count() FROM events WHERE event IN (cohort_people AS c)",
        "SELECT count() FROM events WHERE event IN (SELECT 1 FROM cohort_people)",
        # WITH and ARRAY JOIN keep every table checked
        "WITH x AS (SELECT 1) SELECT * FROM x",
        "WITH x AS (SELECT * FROM cohort_people) SELECT count() FROM events",
        "WITH events AS (SELECT * FROM cohort_people) SELECT count() FROM events",
        "SELECT count() FROM events ARRAY JOIN (SELECT [1] FROM cohort_people) AS a",
        # what the parser cannot read is refused
        "SELECT count() FROM events WHERE",
        "SELECT count() FROM FROM events",
    ],
)
def test_the_parsed_tree_refuses_every_other_table(query):
    """protects=#643 re-review minors: a clause word after a dot, IN over a table in any
    form (nested parentheses, [ ], notIn, globalIn, an alias), a WITH or ARRAY JOIN that
    reads another table, and a query the parser cannot read are refused;
    fails_when=any of them reaches PostHog; no_claim=HogQL's own parser."""
    with pytest.raises(posthog.QueryRefused):
        posthog.check_query(query)


@pytest.mark.parametrize(
    "query",
    [
        "SELECT count() FROM events WHERE properties.order = 'x'",
        "SELECT count() FROM events WHERE properties.group = 'x' AND properties.limit = 1",
        "SELECT count() FROM events e JOIN persons p ON e.properties.where = p.id WHERE 1 = 1",
        "SELECT count() FROM events SAMPLE 1/10 OFFSET 1/2 WHERE event = 'x'",
        "SELECT count() FROM events SAMPLE 0.1",
        "SELECT count() FROM events e ARRAY JOIN e.properties.items AS item",
        "WITH x AS (SELECT count() AS n FROM events) SELECT n FROM events",
        "WITH 7 AS days SELECT count() FROM events WHERE timestamp > now() - INTERVAL days DAY",
        "SELECT dateDiff('day', min(timestamp), max(timestamp)) FROM events",
        "SELECT count() FROM events WHERE event IN ('a', 'b') AND properties.$os = 'x'",
    ],
)
def test_names_and_clauses_the_scanner_refused_now_pass(query):
    """protects=#643 re-review minors: a clause word after a dot (properties.order),
    SAMPLE ... OFFSET without a comma join, ARRAY JOIN over a column and a WITH whose
    tables are all allowed pass; fails_when=an ordinary metric query is refused;
    no_claim=HogQL's own parser."""
    posthog.check_query(query)


def test_the_row_limit_wraps_the_parsed_statement():
    """protects=#643 re-review: limited() refuses text the parser cannot read as one
    checked SELECT (no string-glued wrapper escape) and sends the statement unchanged
    inside SELECT * FROM ( ... ) LIMIT 2; fails_when=a wrapper-closing query is wrapped
    and sent; no_claim=PostHog's own caps."""
    for bad in (
        "SELECT 1) UNION ALL SELECT event FROM (SELECT event FROM events",
        "SELECT count() FROM events) AS t, cohort_people WHERE (1 = 1",
        "SELECT count() FROM events SAMPLE 1 OFFSET 0, cohort_people",
    ):
        with pytest.raises(posthog.QueryRefused):
            posthog.limited(bad)
    query = "SELECT dateDiff('day', min(timestamp), max(timestamp)) FROM events SAMPLE 1/10;"
    sent = posthog.limited(query)
    assert sent == f"SELECT * FROM ({query[:-1]}) LIMIT {posthog.MAX_ROWS}"


# (table, what follows its alias): FINAL and SAMPLE come after the alias in HogQL.
_TABLES = [("events", ""), ("events", " FINAL"), ("events", " SAMPLE 1 OFFSET 0"),
           ("events", " SAMPLE 1/10"), ("events", " FINAL SAMPLE 1/10 OFFSET 1/2"),
           ("(SELECT * FROM events)", ""),
           ("(SELECT * FROM events SAMPLE 1 OFFSET 0)", "")]  # fmt: skip
_PLACES = ["{}", "SELECT 1 FROM ({})", "SELECT 1 FROM events WHERE 1 IN ({})", "SELECT ({})",
           "SELECT 1 FROM events WHERE EXISTS ({})", "WITH x AS ({}) SELECT 1 FROM events",
           "SELECT 1 FROM events WHERE 1 IN (1, ({}))"]  # fmt: skip
_WORDS = ["order", "where", "limit", "offset", "sample", "group", "having", "prewhere",
          "window", "qualify", "join", "final", "settings", "array", "global", "e"]  # fmt: skip
_OTHERS = [", cohort_people", ", numbers(10)", ", system.tables", " JOIN cohort_people c ON 1 = 1",
           " CROSS JOIN cohort_people", ", (SELECT * FROM cohort_people)",
           " ARRAY JOIN (SELECT [1] FROM cohort_people) AS a"]  # fmt: skip


def _fuzz_cases() -> list[tuple[str, bool]]:
    """(query, allowed): each table form, with no alias, a bare or AS alias (a clause word
    or a plain name), followed by another table (refused) or a JOIN of persons (allowed
    when the alias is a plain name), in each of :data:`_PLACES`. sqlglot cannot parse
    SAMPLE then JOIN inside a scalar, EXISTS or IN-list subquery, so those are refused
    (fail closed) and not expected to pass."""
    cases = []
    for table, after in _TABLES:
        for alias in ["", *(f" {w}" for w in _WORDS), *(f" AS {w}" for w in _WORDS)]:
            plain = alias.split()[-1:] in ([], ["e"])
            for wrap in _PLACES:
                for other in _OTHERS:
                    body = f"SELECT count() FROM {table}{alias}{after}{other}"
                    cases.append((wrap.format(body), False))
                if plain and not ("SAMPLE" in after and _PLACES.index(wrap) > 2):
                    join = " JOIN persons p ON 1 = 1 WHERE 1 = 1"
                    body = f"SELECT count() FROM {table}{alias}{after}{join}"
                    cases.append((wrap.format(body), True))
    return cases


def test_fuzz_aliases_keywords_and_joins():
    """protects=#643 re-review: over every combination of a table form (FINAL, SAMPLE,
    SAMPLE OFFSET, a subquery), an alias (none, bare or after AS, a clause word or a
    name), a place (top level, FROM, IN, a scalar, EXISTS, WITH) and a second source (a
    comma join, a JOIN, a table function, a system table, ARRAY JOIN over a subquery), a
    source outside the allowed tables is always refused and a JOIN of persons with a plain
    alias passes;
    fails_when=any combination reads another table; no_claim=forms outside these lists."""
    leaks, refused = [], []
    for query, allowed in _fuzz_cases():
        try:
            posthog.check_query(query)
            if not allowed:
                leaks.append(query)
        except posthog.QueryRefused:
            if allowed:
                refused.append(query)
    assert leaks == []
    assert refused == []
