"""Pure tests (no database): the evaluator, the packaged catalogue, the composer and
skeleton rendering. They replace the suite's autouse database fixtures with no-ops, so
they run without Postgres."""

import pytest


@pytest.fixture(scope="session", autouse=True)
def migrated_db() -> None:
    return None


@pytest.fixture(autouse=True)
def _truncate_after_test():
    yield
