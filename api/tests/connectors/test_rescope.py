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


def test_slack_starts_over():
    old = {"channels": {"C1": {"oldest": "1.0", "threads": {}}}}
    assert SlackConnector().rescope_cursor(old, {"channels": ["C1"]}) is None
