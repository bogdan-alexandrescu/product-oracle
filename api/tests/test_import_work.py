"""Work importing oracle.main must not do (each new API instance pays it before serving):
the roadmap leak check's table of letters with several readings (a scan of every Unicode
code point, about 0.4 s on one CPU) and the argon2 hashes a sign-in or share link checks
when nothing matches (about 0.2 s each), are made on first use, not on import. No
database; the import runs in its own process, so nothing earlier in the session has
built them.

Each test's card: protects=<the observable>; fails_when=<the wrong result it rejects>;
no_claim=<what green does not prove>.

- test_no_password_is_hashed_on_import: protects=importing oracle.main runs no argon2 hash;
  fails_when=a module computes a dummy hash at import again; no_claim=the import's time.
- test_the_leak_check_table_is_not_built_on_import: protects=importing oracle.main does not
  scan Unicode for the leak check's stand-ins; fails_when=the table is built at import
  again; no_claim=other import-time work.
- test_the_leak_check_table_is_built_on_first_use: protects=after the import, the first
  leak check reading builds the table and a capital I reads as its stand-in (i or l);
  fails_when=the lazy table is never built, or built empty.
- test_a_wasted_check_costs_one_argon2_step_each_time: protects=a sign-in for an unknown
  email or a share link with no passcode spends one argon2 step every time, the first
  included (it makes the dummy hash, which takes as long as a check); fails_when=the
  first call hashes and checks (twice as slow) or skips argon2; no_claim=wall-clock time.
"""

import json
import subprocess
import sys

import pytest

from tests.conftest import API_DIR

PROBE = """
import json, unicodedata
from argon2 import PasswordHasher

counts = {"hash": 0, "decomposition": 0}
_hash, _decomposition = PasswordHasher.hash, unicodedata.decomposition


def hash_(*args, **kwargs):
    counts["hash"] += 1
    return _hash(*args, **kwargs)


def decomposition(char):
    counts["decomposition"] += 1
    return _decomposition(char)


PasswordHasher.hash = hash_
unicodedata.decomposition = decomposition
import oracle.main  # noqa: E402,F401
from oracle.roadmap import leak_check  # noqa: E402

at_import = dict(counts)
mixed = leak_check._mixed("I")
print(json.dumps({"at_import": at_import, "after_use": counts, "mixed": mixed}))
"""

# The scan reads every code point (1,114,112); anything else at import reads a handful.
SCAN = 100_000


@pytest.fixture(scope="module")
def probe() -> dict:
    out = subprocess.run(
        [sys.executable, "-c", PROBE],
        cwd=API_DIR,
        capture_output=True,
        text=True,
        timeout=120,
        check=True,
    )
    return json.loads(out.stdout.strip().splitlines()[-1])


def test_no_password_is_hashed_on_import(probe):
    assert probe["at_import"]["hash"] == 0


def test_the_leak_check_table_is_not_built_on_import(probe):
    assert probe["at_import"]["decomposition"] < SCAN


def test_the_leak_check_table_is_built_on_first_use(probe):
    assert probe["after_use"]["decomposition"] >= SCAN
    assert probe["mixed"] not in ("i", "l", "I"), "a capital I stands for both i and l"


def test_a_wasted_check_costs_one_argon2_step_each_time(monkeypatch):
    from argon2 import PasswordHasher

    from oracle.auth import service

    steps: list[str] = []
    hash_, verify = PasswordHasher.hash, PasswordHasher.verify

    def spy_hash(*args, **kwargs):
        steps.append("hash")
        return hash_(*args, **kwargs)

    def spy_verify(*args, **kwargs):
        steps.append("verify")
        return verify(*args, **kwargs)

    monkeypatch.setattr(PasswordHasher, "hash", spy_hash)
    monkeypatch.setattr(PasswordHasher, "verify", spy_verify)
    monkeypatch.setattr(service, "_dummy_hash", None)
    for _ in range(3):
        service.waste_password_check("not-a-password")
    assert steps == ["hash", "verify", "verify"]
