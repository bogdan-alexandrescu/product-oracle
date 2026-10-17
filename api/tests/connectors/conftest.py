"""Connector tests are pure I/O against httpx.MockTransport: they need no database.

These override the suite-wide autouse fixtures in ``tests/conftest.py`` for this
directory, so the tests run where no Postgres is available.
"""

import pytest


@pytest.fixture(scope="session")
def migrated_db() -> None:
    return None


@pytest.fixture
def _truncate_after_test() -> None:
    return None
