"""Review r2 of PR 1286: the config refusals a source needing attention shows read in plain
words (no keys, codes or ISO dates), and those that already say what to do are actions, so
the source reads them once ("..., then it syncs again"), each with the cause a role that
cannot edit reads."""

import pytest

from oracle.sources.base import ConnectorConfigError, config_zone
from oracle.sources.connectors.fireflies import selection
from oracle.sources.connectors.github import GithubConnector
from oracle.sources.connectors.google_docs import GoogleDocsConnector
from oracle.sources.connectors.notion import NotionConnector
from oracle.sources.connectors.slack import SlackConnector

DOC = "1AbCdEfGhIjKlMnOpQrStUvWxYz0123456789"


def refusal(check, config) -> ConnectorConfigError:
    with pytest.raises(ConnectorConfigError) as e:
        check(config)
    return e.value


@pytest.mark.parametrize(
    ("check", "config", "message", "cause"),
    [
        (
            GithubConnector().check_config,
            {"repos": [f"example-org/repo{n}" for n in range(101)]},
            "allowlist at most 100 repos",
            "over 100 repos",
        ),
        (
            GithubConnector().check_config,
            {"repos": ["example-org/widgets"], "include": []},
            "include at least one of readme, docs, issues, pull_requests, releases, milestones",
            "nothing to include",
        ),
        (
            GoogleDocsConnector().check_config,
            {"docs": [f"{DOC}{n:03d}" for n in range(501)]},
            "choose at most 500 files and folders per source",
            "over 500 files and folders",
        ),
        (
            GoogleDocsConnector().check_config,
            {"docs": ["not an id!"]},
            "'not an id!' is not a Drive file or folder id: choose it from Drive",
            "'not an id!' is not a Drive file or folder id",
        ),
        (
            selection,
            {"mode": "selected"},
            "pick at least one series or meeting, or take all meetings",
            "no series or meeting picked",
        ),
        (
            NotionConnector().check_config,
            {"pages": ["x"]},
            'use "roots" for the Notion pages and databases, not "pages"',
            "pages saved under an old name",
        ),
        (
            selection,
            {"mode": "selected", "series": ["standup"]},
            "pick calendar series from the list",
            "a series not from the calendar",
        ),
        (
            config_zone,
            {"timezone": "Mars/Base"},
            "pick a time zone from the list",
            "an unknown time zone",
        ),
        (
            SlackConnector().check_config,
            {"channels": ["C0EXAMPLE1"], "until": "2101-01-01"},
            "pick an end date from Jan 1, 2000 to Dec 31, 2100",
            "the end date is out of range",
        ),
    ],
)
def test_a_refusal_that_names_the_fix_is_an_action(check, config, message, cause):
    e = refusal(check, config)
    assert str(e) == message
    assert e.is_action
    assert e.cause == cause


@pytest.mark.parametrize(
    ("check", "config", "message"),
    [
        (
            selection,
            {"mode": "all", "date_from": "2026-10-02", "date_to": "2026-10-01"},
            "the end date must be on or after the start date",
        ),
        (
            SlackConnector().check_config,
            {"channels": ["C0EXAMPLE1"], "since": "2026-10-02", "until": "2026-10-01"},
            "the end date must be on or after the start date",
        ),
    ],
)
def test_a_cause_is_not_an_action(check, config, message):
    e = refusal(check, config)
    assert str(e) == message
    assert not e.is_action
    assert e.cause is None
