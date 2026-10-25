"""robots.txt for Oracle's reader (RFC 9309), cached 24 hours per host.

A scheduled or agent-driven reader is a crawler, unlike a link a person pastes once, so
before it reads a page Oracle fetches ``https://<host>/robots.txt`` through the same
``LinkFetcher`` (https, public addresses only) and obeys the group for
``ProductOracleBot``, else the ``*`` group. The longest matching rule wins; on a tie,
Allow. ``*`` matches any run of characters and a trailing ``$`` anchors the end
(oracle.robots_match, in linear time; a rule too long or too wild counts as Disallow).

- No robots.txt (404, 410), an empty one, or one behind a sign-in: everything is allowed
  (RFC 9309 2.3.1.3).
- Unreachable (5xx, a timeout, too large): nothing is allowed until the next try (2.3.1.4).
- A host resolving to a non-public address: the fetcher's LinkError is raised, and no
  request leaves.
"""

from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta
from urllib.parse import urlsplit

from oracle import robots_match
from oracle.baseline.public_links import LinkError, LinkFetcher

AGENT = "productoraclebot"
TTL = timedelta(hours=24)
# Answers that mean "no rules": read everything.
_ALLOW_ALL = {"not_found", "empty", "not_public", "unsupported_content"}
# The fetcher's refusals that are about the address itself: raised, never cached.
_RAISE = {"blocked_address", "invalid_url", "not_https"}


@dataclass
class Rules:
    # (allow, rule), for the group that applies to Oracle.
    rules: list[tuple[bool, robots_match.Rule]] = field(default_factory=list)
    disallow_all: bool = False

    @classmethod
    def parse(cls, text: str) -> "Rules":
        groups: list[tuple[set[str], list[tuple[bool, str]]]] = []
        agents: set[str] = set()
        rules: list[tuple[bool, str]] = []
        in_rules = False
        for raw in text.splitlines():
            line = raw.split("#", 1)[0].strip()
            if ":" not in line:
                continue
            key, value = (p.strip() for p in line.split(":", 1))
            key = key.lower()
            if key == "user-agent":
                if in_rules:
                    groups.append((agents, rules))
                    agents, rules, in_rules = set(), [], False
                agents.add(value.lower())
            elif key in ("allow", "disallow"):
                if not agents:
                    continue
                in_rules = True
                if value:
                    rules.append((key == "allow", value))
        if agents:
            groups.append((agents, rules))
        ours = [rs for a, rs in groups if any(x.split("/", 1)[0] == AGENT for x in a)]
        if not ours:
            ours = [rs for a, rs in groups if "*" in a]
        mine = [r for rs in ours for r in rs]
        return cls(
            rules=[
                (allow, robots_match.compile_rule(p))
                for allow, p in mine
                if p.startswith(("/", "*"))
            ]
        )

    def allows(self, path: str) -> bool:
        return not self.disallow_all and robots_match.allows(self.rules, path)


_cache: dict[str, tuple[datetime, Rules]] = {}


def clear_cache() -> None:
    _cache.clear()


async def rules_for(fetcher: LinkFetcher, host: str, now: datetime | None = None) -> Rules:
    now = now or datetime.now(UTC)
    cached = _cache.get(host)
    if cached is not None and now - cached[0] <= TTL:
        return cached[1]
    try:
        page = await fetcher.fetch(f"https://{host}/robots.txt", now=now)
        rules = Rules.parse(page.text)
    except LinkError as exc:
        if exc.code in _RAISE:
            raise
        rules = Rules() if exc.code in _ALLOW_ALL else Rules(disallow_all=True)
    _cache[host] = (now, rules)
    return rules


async def allowed(fetcher: LinkFetcher, url: str, now: datetime | None = None) -> bool:
    """Whether robots.txt lets ProductOracleBot read ``url`` (an https URL)."""
    parts = urlsplit(url)
    host = (parts.hostname or "").lower()
    path = (parts.path or "/") + (f"?{parts.query}" if parts.query else "")
    rules = await rules_for(fetcher, host, now)
    return rules.allows(path)
