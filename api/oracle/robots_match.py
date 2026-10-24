"""One robots.txt rule against one path (RFC 9309 2.2.2), for both of Oracle's readers
(oracle.web.robots and oracle.market.robots).

``*`` matches any run of characters, a trailing ``$`` anchors the end, everything else is
literal and the rule matches from the path's start. No regex: the rule is split on ``*``
and its parts are found in order with :meth:`str.find`, leftmost first, which is enough
for a glob of literal parts and never backtracks. A rule longer than
:data:`MAX_RULE_LENGTH` or with more than :data:`MAX_WILDCARDS` ``*`` is not matched at
all: it counts as a Disallow of every path (:attr:`Rule.allow` False, :meth:`matches`
always True), the safe side for a file that asks for more than a reader judges.
"""

from dataclasses import dataclass

MAX_RULE_LENGTH = 512
MAX_WILDCARDS = 16


@dataclass(frozen=True)
class Rule:
    # The rule as written; its length decides which matching rule wins.
    pattern: str
    # The rule's literal parts between ``*``; None for a rule over the caps.
    parts: tuple[str, ...] | None
    anchored: bool

    @property
    def length(self) -> int:
        return len(self.pattern)


def compile_rule(pattern: str) -> Rule:
    if len(pattern) > MAX_RULE_LENGTH or pattern.count("*") > MAX_WILDCARDS:
        return Rule(pattern, None, False)
    anchored = pattern.endswith("$")
    body = pattern[:-1] if anchored else pattern
    return Rule(pattern, tuple(body.split("*")), anchored)


def matches(rule: Rule, path: str) -> bool:
    parts = rule.parts
    if parts is None:
        return True
    first, *rest = parts
    if not path.startswith(first):
        return False
    if not rest:
        return path == first if rule.anchored else True
    *middle, last = rest
    pos = len(first)
    for part in middle:
        found = path.find(part, pos)
        if found < 0:
            return False
        pos = found + len(part)
    if rule.anchored:
        return path.endswith(last) and len(path) - len(last) >= pos
    return path.find(last, pos) >= 0


def allows(rules: list[tuple[bool, Rule]], path: str) -> bool:
    """The longest matching rule wins, Allow on a tie; no matching rule allows. A rule
    over the caps is a Disallow, whatever it said."""
    best: tuple[int, bool] | None = None
    for allow, rule in rules:
        if matches(rule, path):
            key = (rule.length, allow and rule.parts is not None)
            if best is None or key > best:
                best = key
    return True if best is None else best[1]
