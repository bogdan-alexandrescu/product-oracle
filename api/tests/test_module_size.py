"""#1723: no api/oracle module grows past 1,500 lines. The modules already over it are
listed in tests/module_sizes.json with today's length, which may only shrink: a listed
module that grows fails, and an entry that no longer matches its module (shorter, at or
under the limit, or gone) is stale and fails until lowered or removed.

Card: protects=the api's module-size limit, as the web's max-lines does for web files;
fails_when=a new module passes 1,500 lines, a listed one grows, or an entry is stale;
no_claim=how a module is split (review)."""

import json

from tests.conftest import API_DIR

LIMIT = 1500
BASELINE = API_DIR / "tests" / "module_sizes.json"


def _lengths() -> dict[str, int]:
    return {
        str(p.relative_to(API_DIR)): len(p.read_text().splitlines())
        for p in sorted((API_DIR / "oracle").rglob("*.py"))
    }


def check(lengths: dict[str, int], baseline: dict[str, int]) -> list[str]:
    """What breaks the ratchet: modules over the limit and past their entry, stale entries."""
    found = []
    for name, n in lengths.items():
        allowed = baseline.get(name, LIMIT)
        if n > allowed:
            found.append(f"{name}: {n} lines, over its limit of {allowed}; split it")
    for name, allowed in baseline.items():
        n = lengths.get(name)
        if n is None or n <= LIMIT:
            found.append(f"{name}: stale entry, now {n or 0} lines; remove it")
        elif n < allowed:
            found.append(f"{name}: stale entry, now {n} lines; lower it to {n}")
    return found


def test_no_app_module_grows_past_its_line_limit():
    """Every api/oracle module stays within 1,500 lines or its listed, shrinking length."""
    assert check(_lengths(), json.loads(BASELINE.read_text())) == []


def test_the_ratchet_fails_growth_new_modules_and_stale_entries():
    """A grown listed module, a new long module and every kind of stale entry are all seen."""
    lengths = {"a.py": 1700, "b.py": 1601, "c.py": 1400, "d.py": 1550, "e.py": 1600}
    baseline = {"a.py": 1600, "c.py": 1600, "d.py": 1600, "e.py": 1600, "gone.py": 1800}
    assert check(lengths, baseline) == [
        "a.py: 1700 lines, over its limit of 1600; split it",
        "b.py: 1601 lines, over its limit of 1500; split it",
        "c.py: stale entry, now 1400 lines; remove it",
        "d.py: stale entry, now 1550 lines; lower it to 1550",
        "gone.py: stale entry, now 0 lines; remove it",
    ]
