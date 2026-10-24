"""robots.txt for watched pages (an engineering default: a scheduled reader is a crawler).

Before a scheduled read or a Check now, Oracle reads ``https://<host>/robots.txt``
through the same fetcher (oracle.baseline.public_links.LinkFetcher: https, public
addresses, size and time caps) and keeps it :data:`TTL`. The group for
``ProductOracleBot`` applies when the file has one, otherwise the ``*`` group; the longest
matching ``Allow`` or ``Disallow`` wins (``Allow`` on a tie), with ``*`` and ``$`` as in
RFC 9309. A missing file (404) or one that cannot be read allows everything, except a
file that answers 5xx: the site is unreachable, so nothing is allowed (RFC 9309 2.3.1.4).
An empty ``User-agent:`` line names no crawler.
"""

import re
from dataclasses import dataclass
from datetime import datetime, timedelta
from urllib.parse import urlsplit

from oracle.baseline.public_links import LinkError, LinkFetcher

AGENT = "productoraclebot"
TTL = timedelta(hours=24)
BLOCKED = "The site asks bots not to read this page"


@dataclass(frozen=True)
class Rules:
    # (allow, pattern) of the group that applies.
    rules: tuple[tuple[bool, str], ...] = ()
    # robots.txt answered 5xx: nothing may be read.
    disallow_all: bool = False

    def allows(self, path: str) -> bool:
        if self.disallow_all:
            return False
        best: tuple[int, bool] | None = None
        for allow, pattern in self.rules:
            if not pattern:
                continue
            if _match(pattern, path):
                key = (len(pattern), allow)
                if best is None or key > best:
                    best = key
        return True if best is None else best[1]


def _match(pattern: str, path: str) -> bool:
    regex = re.escape(pattern).replace(r"\*", ".*")
    if regex.endswith(r"\$"):
        regex = regex[:-2] + "$"
    return re.match(regex, path) is not None


def parse(text: str) -> Rules:
    """The rules for ProductOracleBot, else for ``*``."""
    groups: list[tuple[set[str], list[tuple[bool, str]]]] = []
    agents: set[str] = set()
    rules: list[tuple[bool, str]] = []
    in_rules = False
    for raw in (text or "").splitlines():
        line = raw.split("#", 1)[0].strip()
        if ":" not in line:
            continue
        key, value = (p.strip() for p in line.split(":", 1))
        key = key.lower()
        if key == "user-agent":
            if in_rules:
                groups.append((agents, rules))
                agents, rules, in_rules = set(), [], False
            if value:
                agents.add(value.lower())
        elif key in ("allow", "disallow"):
            in_rules = True
            rules.append((key == "allow", value))
    if agents:
        groups.append((agents, rules))
    for wanted in (lambda a: AGENT in a or any(AGENT.startswith(x) for x in a if x != "*"),
                   lambda a: "*" in a):  # fmt: skip
        chosen = [r for a, rs in groups if wanted(a) for r in rs]
        if any(wanted(a) for a, _ in groups):
            return Rules(tuple(chosen))
    return Rules()


# The fetcher reports an error answer as "The page answered with an error (<code>)."
_SERVER_ERROR = re.compile(r"\(5\d\d\)")

_cache: dict[str, tuple[datetime, Rules]] = {}


def clear() -> None:
    _cache.clear()


def cached(url: str, now: datetime) -> bool:
    """Whether the rules for ``url``'s host are at hand (no robots.txt read needed)."""
    hit = _cache.get((urlsplit(url).hostname or "").lower())
    return hit is not None and now - hit[0] < TTL


async def rules_for(fetcher: LinkFetcher, url: str, now: datetime) -> Rules:
    host = (urlsplit(url).hostname or "").lower()
    hit = _cache.get(host)
    if hit is not None and now - hit[0] < TTL:
        return hit[1]
    try:
        page = await fetcher.fetch(f"https://{host}/robots.txt", now=now)
        rules = parse(page.text)
    except LinkError as e:
        server_error = e.code == "unreachable" and _SERVER_ERROR.search(str(e)) is not None
        rules = Rules(disallow_all=server_error)
    _cache[host] = (now, rules)
    return rules


async def allowed(fetcher: LinkFetcher, url: str, now: datetime) -> bool:
    parts = urlsplit(url)
    path = (parts.path or "/") + (f"?{parts.query}" if parts.query else "")
    return (await rules_for(fetcher, url, now)).allows(path)
