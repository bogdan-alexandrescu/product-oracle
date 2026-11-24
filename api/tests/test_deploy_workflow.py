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
- test_deploy_job_is_the_production_environment: protects=the job runs as the environment
  production, which the federation's attribute condition requires; fails_when=it is dropped.
- test_serving_api_must_not_migrate_at_start_before_the_migration: protects=the job stops
  before the backup and the migration when a serving oracle-api revision lacks
  ORACLE_MIGRATE_AT_START=0 or can not be read (a stand-in gcloud); fails_when=the check is
  missing, after the migration, or passes such a revision.
- test_traffic_moves_to_the_staged_tag_and_the_tag_is_removed: protects=traffic moves to the
  staged revision by its tag c-<sha> at 100 percent (never to-latest), the tag is removed
  after, and a failed run removes its leftover tag; fails_when=--to-latest comes back (a
  revision deployed meanwhile would take the traffic) or a failed run leaves the tag.
- test_version_routes_are_asked_with_an_iap_id_token: protects=both deploy-serves calls send
  a Google ID token for each service's IAP audience (repository variables); fails_when=a
  /version is asked without one and IAP turns it away.
- test_laptop_deploy_*: protects=ops/deploy/deploy-api.sh (laptop deploys) passes the serving
  revision's ORACLE_MIGRATE_AT_START through, never deploys when it can not read it, and only
  prints the traffic-only rollback once Actions deploys are on (or it can not tell), and reads
  gcloud's ^<delim>^ form (values with commas, such as a JSON list) as well as NAME=value,...;
  fails_when=a laptop deploy drops the value, deploys beside the Actions job, refuses or
  rewrites the ^<delim>^ form, or lets ORACLE_MIGRATE_AT_START in through it.
- test_laptop_deploy_with_migrate_at_start_off_migrates_before_traffic (#1709): protects=with
  the kept value 0 a laptop deploy stages the revision with no traffic, runs the migrate job on
  its image, then moves the traffic by its tag and removes the tag; fails_when=it serves the new
  image on the old schema (no migrate step), moves traffic before or without the migration, or
  leaves the tag after a failed one.
"""

import json
import os
import re
import subprocess
from pathlib import Path

import pytest
import yaml

# #1570: this test reads CI's own workflow and the laptop deploy script, outside api/ on purpose.
pytestmark = pytest.mark.foreign_read(".github/workflows/ci.yml", "ops/deploy/deploy-api.sh")

ROOT = Path(__file__).resolve().parents[2]
CI = ROOT / ".github" / "workflows" / "ci.yml"
LAPTOP = ROOT / "ops" / "deploy" / "deploy-api.sh"
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
    """The deploy job waits on every test job in the workflow, missing none."""
    tests = set(_jobs()) - NOT_TESTS
    assert tests
    assert set(_deploy()["needs"]) == tests


def test_deploy_is_off_until_the_owner_turns_it_on():
    """Deploy runs only on main, only once the owner's flag turns it on."""
    condition = _deploy()["if"]
    assert "vars.ORACLE_DEPLOY_ENABLED == 'true'" in condition
    assert "github.ref == 'refs/heads/main'" in condition
    assert " || " not in condition


def test_backup_and_migration_come_before_any_traffic_moves():
    """Backup and migration always run before any step moves live traffic."""
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
    """Every deploy env value comes from a repository variable, never a bare secret."""
    text = yaml.safe_dump(_deploy())
    assert "secrets." not in text
    for name, value in _deploy()["env"].items():
        value = str(value)
        assert re.fullmatch(r"\$\{\{ (vars|github)\.[A-Za-z_]+( \|\| '[a-z-]+')? \}\}", value), (
            name,
            value,
        )


# A stand-in gcloud and gh on PATH: each call is logged; gcloud answers from FAKE_SERVICE /
# FAKE_REVISIONS (JSON), gh from FAKE_ENABLED. Nothing here reaches a cloud.
FAKE_GCLOUD = r"""#!/usr/bin/env bash
echo "gcloud $*" >> "$FAKE_LOG"
case "$*" in
  "run services describe"*) [ -n "$FAKE_SERVICE" ] || exit 1; echo "$FAKE_SERVICE" ;;
  "run jobs execute"*) [ "$FAKE_JOB_FAILS" != 1 ] || exit 1 ;;
  "run revisions describe"*)
    rev=$4
    jq -e --arg r "$rev" '.[$r]' <<<"$FAKE_REVISIONS" || exit 1 ;;
  *) : ;;
esac
"""
FAKE_GH = r"""#!/usr/bin/env bash
echo "gh $*" >> "$FAKE_LOG"
[ "$FAKE_GH_FAILS" = 1 ] && exit 1
if [ -n "$FAKE_ENABLED" ]; then echo "$FAKE_ENABLED"; fi
"""


def _revision(env: dict[str, str]) -> dict:
    return {"spec": {"containers": [{"env": [{"name": k, "value": v} for k, v in env.items()]}]}}


def _fake(
    tmp_path: Path,
    serving: dict[str, dict[str, str]] | None,
    enabled: str = "",
    staged: dict[str, dict[str, str]] | None = None,
) -> dict:
    """The stand-ins; ``serving`` share the traffic, ``staged`` revisions have none."""
    bin_ = tmp_path / "bin"
    bin_.mkdir(parents=True)
    for name, text in (("gcloud", FAKE_GCLOUD), ("gh", FAKE_GH)):
        (bin_ / name).write_text(text)
        (bin_ / name).chmod(0o755)
    service = (
        json.dumps(
            {
                "status": {
                    "latestCreatedRevisionName": list({**serving, **(staged or {})})[-1],
                    "traffic": [
                        {"revisionName": r, "percent": 100 // len(serving)} for r in serving
                    ]
                    + [{"revisionName": r, "percent": 0, "tag": "c-example"} for r in staged or {}],
                }
            }
        )
        if serving is not None
        else ""
    )
    every = {**(serving or {}), **(staged or {})}
    revisions = json.dumps({r: _revision(env) for r, env in every.items()})
    return {
        "PATH": f"{bin_}:{os.environ['PATH']}",
        "HOME": str(tmp_path),
        "FAKE_LOG": str(tmp_path / "calls.log"),
        "FAKE_SERVICE": service,
        "FAKE_REVISIONS": revisions,
        "FAKE_ENABLED": enabled,
        "FAKE_JOB_FAILS": "",
        "ORACLE_GCP_PROJECT": "example-project",
        "ORACLE_GCP_REGION": "example-region",
    }


def _calls(env: dict) -> str:
    log = Path(env["FAKE_LOG"])
    return log.read_text() if log.exists() else ""


def _bash(script: str, env: dict, *args: str) -> subprocess.CompletedProcess:
    return subprocess.run(
        ["bash", "-c", script, "bash", *args],
        env=env,
        cwd=ROOT,
        capture_output=True,
        text=True,
        timeout=60,
    )


def _run_step(name: str, env: dict) -> subprocess.CompletedProcess:
    step = _deploy()["steps"][_step(name)]
    return _bash(
        "set -eo pipefail\n" + step["run"],
        {**env, "API_SERVICE": "oracle-api", "REGION": "example-region"},
    )


def test_deploy_job_is_the_production_environment():
    """The deploy job runs under the production environment, not some other one."""
    assert _deploy()["environment"] == "production"


def test_serving_api_must_not_migrate_at_start_before_the_migration(tmp_path):
    """Deploy refuses to proceed if the serving revision still migrates at start."""
    steps = _deploy()["steps"]
    check = _step("the serving api does not migrate at start")
    assert check < _step("back up the database") < _step("migrate the database")
    assert steps[check]["if"] == "steps.served.outputs.api != 'true'"
    ok = _run_step(
        "the serving api does not migrate at start",
        _fake(tmp_path / "ok", {"r1": {"ORACLE_MIGRATE_AT_START": "0"}}),
    )
    assert ok.returncode == 0, ok.stdout + ok.stderr
    for case, serving in {
        "unset": {"r1": {"OTHER": "1"}},
        "one": {"r1": {"ORACLE_MIGRATE_AT_START": "1"}},
        "split": {"r1": {"ORACLE_MIGRATE_AT_START": "0"}, "r2": {}},
        "unknown": None,
    }.items():
        r = _run_step("the serving api does not migrate at start", _fake(tmp_path / case, serving))
        assert r.returncode != 0, case
        assert "ORACLE_MIGRATE_AT_START" in r.stdout + r.stderr, case
    # The revision with traffic counts, not a staged one (the latest) that has the value.
    staged = _fake(tmp_path / "staged", {"r1": {}}, staged={"r2": {"ORACLE_MIGRATE_AT_START": "0"}})
    assert _run_step("the serving api does not migrate at start", staged).returncode != 0


def test_traffic_moves_to_the_staged_tag_and_the_tag_is_removed():
    """Deploy moves traffic to the newly staged tag, then removes that tag once live."""
    steps = _deploy()["steps"]
    tag = "c-${SHA:0:12}"

    def unquoted(name: str) -> str:
        return steps[_step(name)]["run"].replace('"', "")

    stage = steps[_step("stage the api")]
    assert stage["id"] == "stage"
    assert f"--tag={tag}" in unquoted("stage the api")
    move = unquoted("move the api's traffic")
    assert "--to-latest" not in yaml.safe_dump(_deploy())
    assert f"--to-tags={tag}=100" in move
    assert move.index("--to-tags") < move.index(f"--remove-tags={tag}")
    leftover = steps[_step("remove a failed run's tag")]
    assert "failure()" in leftover["if"] and "steps.stage.outcome" in leftover["if"]
    assert f"--remove-tags={tag}" in unquoted("remove a failed run's tag")
    assert _step("remove a failed run's tag") == len(steps) - 1


def test_version_routes_are_asked_with_an_iap_id_token():
    """Deploy checks the api and web are serving, using a signed IAP identity token."""
    env = _deploy()["env"]
    assert env["IAP_AUDIENCE_API"] == "${{ vars.ORACLE_IAP_AUDIENCE_API }}"
    assert env["IAP_AUDIENCE_WEB"] == "${{ vars.ORACLE_IAP_AUDIENCE_WEB }}"
    steps = _deploy()["steps"]
    assert _step("sign in to google cloud") < _step("skip what already serves")
    for name in ("skip what already serves", "containment check"):
        run = steps[_step(name)]["run"]
        assert "gcloud auth print-identity-token" in run, name
        assert (
            '--audiences="$IAP_AUDIENCE_API"' in run and '--audiences="$IAP_AUDIENCE_WEB"' in run
        ), name
        assert "ORACLE_VERSION_TOKEN=" in run and "deploy-serves.ts" in run, name
    required = steps[_step("every repository variable is set")]["run"]
    assert "IAP_AUDIENCE_API" in required and "IAP_AUDIENCE_WEB" in required


def _laptop(
    env: dict, *extra: str, env_vars: str = "ORACLE_ENV=prod,ORACLE_EXAMPLE=1"
) -> subprocess.CompletedProcess:
    return subprocess.run(
        [
            "bash",
            str(LAPTOP),
            "example-image@sha256:abc",
            env_vars,
            *extra,
        ],
        env=env,
        cwd=ROOT,
        capture_output=True,
        text=True,
        timeout=60,
    )


def test_laptop_deploy_passes_migrate_at_start_through(tmp_path):
    """A laptop deploy passes its migrate-at-start setting through, then moves traffic."""
    for case, kept in {"unset": None, "one": "1"}.items():
        serving = {"ORACLE_ENV": "prod"} | ({"ORACLE_MIGRATE_AT_START": kept} if kept else {})
        env = _fake(tmp_path / case, {"r1": serving})
        r = _laptop(env)
        assert r.returncode == 0, r.stdout + r.stderr
        calls = _calls(env).splitlines()
        deploy = [c for c in calls if c.startswith("gcloud run deploy")]
        assert len(deploy) == 1, case
        # The revision migrates at start itself: no job, and the traffic moves to it (an
        # Actions deploy left it on one revision).
        assert not [c for c in calls if c.startswith("gcloud run jobs")], case
        assert "update-traffic oracle-api" in calls[-1] and "--to-latest" in calls[-1], case
        suffix = f",ORACLE_MIGRATE_AT_START={kept}" if kept else ""
        assert deploy[0].endswith(f"--set-env-vars=ORACLE_ENV=prod,ORACLE_EXAMPLE=1{suffix}"), case


def test_laptop_deploy_with_migrate_at_start_off_migrates_before_traffic(tmp_path):
    """#1709: with the kept value 0, the new revision is staged with no traffic, the migrate
    job runs on its image, and only then does the traffic move to it, by its tag."""
    env = _fake(tmp_path / "ok", {"r1": {"ORACLE_MIGRATE_AT_START": "0"}})
    r = _laptop(env)
    assert r.returncode == 0, r.stdout + r.stderr
    calls = _calls(env).splitlines()
    i = {
        name: next(n for n, c in enumerate(calls) if c.startswith(prefix))
        for name, prefix in {
            "deploy": "gcloud run deploy oracle-api",
            "job": "gcloud run jobs update oracle-api-migrate",
            "run": "gcloud run jobs execute oracle-api-migrate",
            "move": "gcloud run services update-traffic oracle-api",
        }.items()
    }
    assert i["deploy"] < i["job"] < i["run"] < i["move"]
    deploy, job, run, move = (calls[i[k]] for k in ("deploy", "job", "run", "move"))
    assert "--set-env-vars=ORACLE_ENV=prod,ORACLE_EXAMPLE=1,ORACLE_MIGRATE_AT_START=0" in deploy
    assert "--no-traffic" in deploy
    tag = re.search(r"--tag=(\S+)", deploy)
    assert tag and re.fullmatch(r"[a-z][a-z0-9-]*", tag[1]), deploy
    assert "--image=example-image@sha256:abc" in job and "--args=-m,oracle.startup,migrate" in job
    assert "--wait" in run
    assert f"--to-tags={tag[1]}=100" in move
    assert "--to-latest" not in _calls(env)
    assert f"--remove-tags={tag[1]}" in calls[-1]
    # A job named by ORACLE_MIGRATE_JOB is the one run.
    named = _fake(tmp_path / "named", {"r1": {"ORACLE_MIGRATE_AT_START": "0"}})
    named["ORACLE_MIGRATE_JOB"] = "example-migrate"
    assert _laptop(named).returncode == 0
    assert "gcloud run jobs execute example-migrate " in _calls(named)
    # A failed migration moves no traffic and leaves no tag behind.
    failed = _fake(tmp_path / "failed", {"r1": {"ORACLE_MIGRATE_AT_START": "0"}})
    failed["FAKE_JOB_FAILS"] = "1"
    r = _laptop(failed)
    assert r.returncode != 0
    calls = _calls(failed)
    assert "--to-tags" not in calls and "--to-latest" not in calls
    assert f"--remove-tags={tag[1].split('-')[0]}" in calls


def test_laptop_deploy_reads_the_alternate_delimiter_form(tmp_path):
    """Values with commas pass through intact in gcloud's ^##^ form, the kept value appended."""
    serving = {"r1": {"ORACLE_MIGRATE_AT_START": "0"}}
    given = (
        '^##^ORACLE_ENV=prod##ORACLE_IAP_BACKENDS=["a-be","b-be"]'
        '##ORACLE_IAP_AUDIENCES=["/projects/N/global/backendServices/M"]'
    )
    env = _fake(tmp_path / "alt", serving)
    r = _laptop(env, "--set-secrets=EXAMPLE_KEY=example-key:latest", env_vars=given)
    assert r.returncode == 0, r.stdout + r.stderr
    deploy = [c for c in _calls(env).splitlines() if c.startswith("gcloud run deploy")]
    assert len(deploy) == 1
    assert f"--set-env-vars={given}##ORACLE_MIGRATE_AT_START=0 " in deploy[0]
    assert deploy[0].endswith(" --set-secrets=EXAMPLE_KEY=example-key:latest")
    # Another delimiter is kept as given too.
    colon = _fake(tmp_path / "colon", serving)
    r = _laptop(colon, env_vars="^:^ORACLE_ENV=prod:ORACLE_LIST=a,b")
    assert r.returncode == 0, r.stdout + r.stderr
    assert "--set-env-vars=^:^ORACLE_ENV=prod:ORACLE_LIST=a,b:ORACLE_MIGRATE_AT_START=0" in _calls(
        colon
    )
    # The plain comma form still works the same.
    plain = _fake(tmp_path / "plain", serving)
    r = _laptop(plain)
    assert r.returncode == 0, r.stdout + r.stderr
    deploy = [c for c in _calls(plain).splitlines() if c.startswith("gcloud run deploy")]
    assert deploy[0].endswith(
        "--set-env-vars=ORACLE_ENV=prod,ORACLE_EXAMPLE=1,ORACLE_MIGRATE_AT_START=0"
    )


def test_laptop_deploy_refuses_migrate_at_start_in_either_form(tmp_path):
    """ORACLE_MIGRATE_AT_START given in the arguments is refused, in the ^##^ form as well."""
    for case, given in {
        "alt-first": '^##^ORACLE_MIGRATE_AT_START=1##ORACLE_LIST=["a","b"]',
        "alt-later": '^##^ORACLE_LIST=["a","b"]##ORACLE_MIGRATE_AT_START=1',
        "plain-later": "ORACLE_ENV=prod,ORACLE_MIGRATE_AT_START=1",
        "no-delimiter": "^^ORACLE_ENV=prod",
        "unclosed": "^##ORACLE_ENV=prod",
    }.items():
        env = _fake(tmp_path / case, {"r1": {"ORACLE_MIGRATE_AT_START": "0"}})
        r = _laptop(env, env_vars=given)
        assert r.returncode != 0, case
        assert "gcloud run deploy" not in _calls(env), case


def test_laptop_deploy_never_deploys_blind_or_over_the_kept_value(tmp_path):
    """A laptop deploy refuses to run with a split, unknown, or overridden setting."""
    split = _fake(tmp_path / "split", {"r1": {"ORACLE_MIGRATE_AT_START": "0"}, "r2": {}})
    unknown = _fake(tmp_path / "unknown", None)
    for env in (split, unknown):
        r = _laptop(env)
        assert r.returncode != 0
        assert "gcloud run deploy" not in _calls(env)
    given = _fake(tmp_path / "given", {"r1": {"ORACLE_MIGRATE_AT_START": "0"}})
    r = subprocess.run(
        ["bash", str(LAPTOP), "example-image@sha256:abc", "ORACLE_MIGRATE_AT_START=1"],
        env=given,
        cwd=ROOT,
        capture_output=True,
        text=True,
        timeout=60,
    )
    assert r.returncode != 0
    assert "gcloud run deploy" not in _calls(given)


def test_laptop_deploy_is_traffic_only_once_actions_deploys_are_on(tmp_path):
    """Once Actions deploys are on, a laptop deploy only moves traffic."""
    env = _fake(tmp_path / "on", {"r1": {"ORACLE_MIGRATE_AT_START": "0"}}, enabled="true")
    r = _laptop(env)
    assert r.returncode != 0
    assert "gcloud run deploy" not in _calls(env)
    assert "update-traffic oracle-api" in r.stdout and "--to-revisions=<revision>=100" in r.stdout
    cannot_tell = _fake(tmp_path / "gh", {"r1": {"ORACLE_MIGRATE_AT_START": "0"}})
    cannot_tell["FAKE_GH_FAILS"] = "1"
    r = _laptop(cannot_tell)
    assert r.returncode != 0
    assert "gcloud run deploy" not in _calls(cannot_tell)
