"""robots.txt rule matching shared by the web reader (oracle.web.robots) and watched pages
(oracle.market.robots): linear in the path whatever the rule, and a rule too long or too
wild to judge counts as Disallow.

Each test's card: protects=<the observable>; fails_when=<the wrong result it rejects>;
no_claim=<what green does not prove>.
"""

import time

import pytest

from oracle import robots_match
from oracle.market import robots as market_robots
from oracle.web import robots as web_robots

ATTACK = "/*a*a*a*a*a*b"


def _web(text: str, path: str) -> bool:
    return web_robots.Rules.parse(text).allows(path)


def _market(text: str, path: str) -> bool:
    return market_robots.parse(text).allows(path)


@pytest.mark.parametrize("allows", [_web, _market], ids=["web", "market"])
@pytest.mark.parametrize("path", ["/" + "a" * 99, "/" + "a" * 1999, "/" + "ab" * 1000])
def test_the_backtracking_rule_answers_at_once(allows, path):
    """protects=Disallow: /*a*a*a*a*a*b against a 100- or 2,000-character path is judged in
    well under 50 ms by both readers, with the right answer; fails_when=a regex backtracks
    (seconds per path, the event loop blocked for every company); no_claim=the fetch."""
    text = f"User-agent: *\nDisallow: {ATTACK}\n"
    start = time.perf_counter()
    got = allows(text, path)
    elapsed = time.perf_counter() - start
    assert elapsed < 0.05, elapsed
    assert got is ("b" not in path)


@pytest.mark.parametrize("allows", [_web, _market], ids=["web", "market"])
def test_a_rule_too_long_or_too_wild_disallows(allows):
    """protects=a rule over the length or wildcard caps counts as Disallow for every path,
    Allow rules included; fails_when=such a rule is matched (slow) or ignored (the page is
    read against the site's wish); no_claim=where exactly the caps sit."""
    wild = "/" + "*x" * (robots_match.MAX_WILDCARDS + 1)
    long = "/" + "p" * robots_match.MAX_RULE_LENGTH
    for rule in (wild, long):
        for key in ("Disallow", "Allow"):
            assert not allows(f"User-agent: *\n{key}: {rule}\n", "/docs"), (key, rule[:20])
    at_cap = "/" + "*x" * robots_match.MAX_WILDCARDS
    assert allows(f"User-agent: *\nDisallow: {at_cap}\n", "/docs")


@pytest.mark.parametrize(
    ("rule", "path", "match"),
    [
        ("/pricing", "/pricing/teams", True),
        ("/pricing", "/pric", False),
        ("/pricing$", "/pricing", True),
        ("/pricing$", "/pricing/", False),
        ("/*.pdf$", "/files/x.pdf", True),
        ("/*.pdf$", "/files/x.pdf.html", False),
        ("/*.pdf", "/files/x.pdf.html", True),
        ("*", "/anything", True),
        ("/a*b*c", "/a-c-b-c", True),
        ("/a*b*c", "/a-c-b", False),
        ("/a*ab$", "/aab", True),
        ("/a*ab$", "/ab", False),
        ("/x*$", "/x", True),
        ("/*/a$", "/a", False),
        ("/p.html", "/pxhtml", False),
        ("/q?x=1", "/q?x=1&y", True),
        ("/$", "/", True),
        ("/$", "/a", False),
    ],
)
def test_the_matcher_follows_rfc_9309(rule, path, match):
    """protects=* matches any run, a trailing $ anchors the end, everything else is literal
    and anchored at the start; fails_when=the linear matcher disagrees with RFC 9309;
    no_claim=percent-encoding equivalence (not done before either)."""
    assert robots_match.matches(robots_match.compile_rule(rule), path) is match


def test_both_readers_use_the_shared_matcher():
    """protects=one matcher for both readers; fails_when=either keeps its own regex;
    no_claim=the parsing of groups (each reader's own tests)."""
    assert not hasattr(web_robots, "_pattern") and not hasattr(market_robots, "_match")
    assert web_robots.robots_match is robots_match
    assert market_robots.robots_match is robots_match
