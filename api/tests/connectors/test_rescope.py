"""What each connector keeps of its cursor when a source's selection changes
(``rescope_cursor``, review round 3 M4): enough to notice upstream deletes, nothing that
would skip re-reading."""

import pytest

from oracle.sources.connectors.github import GithubConnector
from oracle.sources.connectors.notion import NotionConnector
from oracle.sources.connectors.slack import SlackConnector


# Connectors do no database work.
@pytest.fixture(scope="session")
def migrated_db():
    return None


@pytest.fixture
def _truncate_after_test():
    return None


def test_github_keeps_what_deletes_are_compared_against():
    old = {
        "repos": {
            "example-org/one": {
                "tree_sha": "t1",
                "files": {"docs/a.md": "s1"},
                "include": ["docs"],
                "issues_since": "2025-10-01T00:00:00Z",
                "releases": [7],
                "milestones": [1],
            },
            "example-org/two": {"releases": [8]},
        }
    }
    config = {"repos": ["Example-Org/One"], "include": ["docs", "releases"]}
    assert GithubConnector().rescope_cursor(old, config) == {
        "repos": {
            "example-org/one": {
                "files": {"docs/a.md": "s1"},
                "releases": [7],
                "milestones": [1],
                "refetch": True,
            }
        }
    }
    assert GithubConnector().rescope_cursor(None, config) is None


def test_notion_keeps_page_ids_only():
    old = {"pages": {"p1": {"edited": "x", "children": ["p2"], "databases": []}}}
    assert NotionConnector().rescope_cursor(old, {"roots": ["p1"]}) == {"pages": {"p1": {}}}
    assert NotionConnector().rescope_cursor(None, {"roots": ["p1"]}) is None


def test_slack_keeps_what_deletes_are_compared_against_and_refetches():
    """A new range (or a cursor saved before ranges were kept): the channels still
    selected keep messages and threads, lose oldest and walk, and read everything again."""
    old = {
        "channels": {
            "C1": {
                "name": "general",
                "oldest": "3.0",
                "threads": {"1.0": "2.0"},
                "messages": ["3.0"],
                "walk": {"from": None},
            },
            "C2": {"oldest": "5.0", "threads": {}, "messages": ["5.0"]},
        }
    }
    assert SlackConnector().rescope_cursor(old, {"channels": ["C1", "C3"]}) == {
        "range": {},
        "channels": {
            "C1": {
                "name": "general",
                "threads": {"1.0": "2.0"},
                "messages": ["3.0"],
                "refetch": True,
            }
        },
    }
    assert SlackConnector().rescope_cursor(None, {"channels": ["C1"]}) is None


def test_slack_keeps_a_channel_untouched_when_the_range_did_not_change():
    entry = {"oldest": "3.0", "threads": {}, "messages": ["3.0"]}
    old = {"range": {"since": "2025-01-01"}, "channels": {"C1": entry, "C2": entry}}
    config = {"channels": ["C1", "C3"], "since": "2025-01-01"}
    assert SlackConnector().rescope_cursor(old, config) == {
        "range": {"since": "2025-01-01"},
        "channels": {"C1": entry},
    }
    # A later since: refetched.
    later = SlackConnector().rescope_cursor(old, {**config, "since": "2025-02-01"})
    assert later["channels"]["C1"]["refetch"] is True
    assert "oldest" not in later["channels"]["C1"]
