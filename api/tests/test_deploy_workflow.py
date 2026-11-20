"""#1569: the deploy job in .github/workflows/ci.yml. No database.

- test_deploy_needs_every_test_job: protects=the deploy waits for every other job of the
  workflow; fails_when=a test job is added (or one dropped from needs:) and a deploy can go
  ahead without it.
- test_deploy_is_off_until_the_owner_turns_it_on: protects=the job runs only on main pushes
  with ORACLE_DEPLOY_ENABLED 'true'; fails_when=it runs before the IAM runbook is applied.
- test_backup_and_migration_come_before_any_traffic_moves: protects=the order backup, stage
  (no traffic), migrate, move traffic, deploy web, containment check; fails_when=traffic moves
  (or the web deploys) before the migration, or the API revision migrates itself at start
  (Oct 18: a migration before the new image was live, a 503).
- test_every_name_is_a_repository_variable: protects=no secret and no project, instance or
  registry name written into the job; fails_when=one is hard-coded or read from secrets.
"""

import re
from pathlib import Path

import yaml

CI = Path(__file__).resolve().parents[2] / ".github" / "workflows" / "ci.yml"
NOT_TESTS = {"cancel-superseded", "deploy"}


def _jobs() -> dict:
    return yaml.safe_load(CI.read_text())["jobs"]


def _deploy() -> dict:
    return _jobs()["deploy"]


def _step(name: str) -> int:
    steps = _deploy()["steps"]
    found = [i for i, s in enumerate(steps) if name.lower() in s.get("name", "").lower()]
    assert len(found) == 1, f"one step named like {name!r}: {found}"
    return found[0]


def test_deploy_needs_every_test_job():
    tests = set(_jobs()) - NOT_TESTS
    assert tests
    assert set(_deploy()["needs"]) == tests


def test_deploy_is_off_until_the_owner_turns_it_on():
    condition = _deploy()["if"]
    assert "vars.ORACLE_DEPLOY_ENABLED == 'true'" in condition
    assert "github.ref == 'refs/heads/main'" in condition
    assert " || " not in condition


def test_backup_and_migration_come_before_any_traffic_moves():
    steps = _deploy()["steps"]
    order = [
        _step("back up the database"),
        _step("stage the api"),
        _step("migrate the database"),
        _step("move the api's traffic"),
        _step("deploy the web"),
        _step("containment check"),
    ]
    assert order == sorted(order)
    stage = steps[order[1]]["run"]
    assert "--no-traffic" in stage
    assert "ORACLE_MIGRATE_AT_START=0" in stage
    assert "oracle.startup,migrate" in steps[order[2]]["run"]
    assert "--wait" in steps[order[2]]["run"]
    # Nothing before the migration moves traffic: only the staging step deploys, with none.
    for step in steps[: order[2]]:
        run = step.get("run", "")
        assert "update-traffic" not in run
        assert "gcloud run deploy" not in run or "--no-traffic" in run


def test_every_name_is_a_repository_variable():
    text = yaml.safe_dump(_deploy())
    assert "secrets." not in text
    for name, value in _deploy()["env"].items():
        value = str(value)
        assert re.fullmatch(r"\$\{\{ (vars|github)\.[A-Za-z_]+( \|\| '[a-z-]+')? \}\}", value), (
            name,
            value,
        )
