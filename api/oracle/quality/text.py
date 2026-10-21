"""What a PRD's sections say: which role each section plays, and simple text signals.

Deterministic and explainable on purpose: every signal is a named pattern a person can
read, so a rationale can say exactly why a criterion is not a pass.
"""

import re
from dataclasses import dataclass, field

# Section roles, matched against the section key and heading (case-insensitive).
ROLES: dict[str, re.Pattern[str]] = {
    "problem": re.compile(r"problem|pain|why now|background|opportunity|context"),
    "users": re.compile(r"\buser|persona|customer|audience|who\b|buyer"),
    "goals": re.compile(r"goal|objective|outcome|okr|strateg|goal-trace"),
    "alternatives": re.compile(r"alternative|option|trade-?off|considered|approaches"),
    "risks": re.compile(r"risk|constraint|blocker|dependenc|feasib|limitation|assumption"),
    "scope": re.compile(r"scope|requirement|feature|solution|proposal|functional|what we"),
    "non_goals": re.compile(r"non-?goal|out[- ]of[- ]scope|not doing|won.?t do"),
    "acceptance": re.compile(r"acceptance|criteri|definition of done"),
    "economics": re.compile(r"econom|cost|pricing|business case|revenue|budget|unit"),
    "scaling": re.compile(r"scal|capacity|volume|load\b|performance|configur"),
    "metrics": re.compile(r"metric|success|kpi|measure"),
    "validation": re.compile(r"validat|experiment|pilot|test plan|launch criteria|decision"),
    "operations": re.compile(r"rollout|release|launch|operat|support|monitor|on-?call|runbook"),
    "ownership": re.compile(r"owner|stakeholder|raci|team|approv|review"),
    "sources": re.compile(r"sources and data points|^sources$"),
}
# A "non-goals" or "out of scope" heading is not scope; a "success metrics" one is not goals.
EXCLUDES: dict[str, set[str]] = {"scope": {"non_goals"}, "goals": {"metrics", "non_goals"}}

# Possessive and within one line: linear on blank lines and space runs.
_BULLET = re.compile(r"^[ \t]*+(?:[-*+]|\d+[.)])[ \t]++(.*\S)", re.M)
_NUMBER = re.compile(r"\d")
_WORD = re.compile(r"[A-Za-z0-9][A-Za-z0-9'%$.-]*")

# Acceptance language no one can test (the word itself, with no number beside it).
VAGUE = re.compile(
    r"\b(fast|quick(ly)?|easy|easily|simple|intuitive|user[- ]friendly|seamless(ly)?|"
    r"robust|better|improved?|nice|smooth(ly)?|as needed|etc\.?|appropriate(ly)?|"
    r"reasonable|modern|delightful|feel)\b",
    re.I,
)
# Observable conditions that make a criterion testable even without a number.
OBSERVABLE = re.compile(
    r"\b(within|under|at most|at least|no more than|fewer than|less than|returns?|shows?|"
    r"displays?|rejects?|refuses?|removes?|logs?|sends?|blocks?|fails?|equals?|matches)\b",
    re.I,
)
THRESHOLD = re.compile(
    r"\b(threshold|at least|at most|below|above|under|over|target|go/no-go|kill|stop|"
    r"revisit|roll ?back|if\b.+\bthen|decision)\b",
    re.I,
)
USERS_IN_TEXT = re.compile(
    r"\b(users?|buyers?|customers?|teams?|admins?|members?|operators?|agents?|personas?)\b", re.I
)
OWNER_LINE = re.compile(r"\b(owner|owned by|dri|decider|accountable)\s*[:\-]", re.I)
# Tenant-specific behaviour written into product requirements instead of configuration.
TENANT_LEAKAGE = re.compile(
    r"\b(hard[- ]?code[sd]?|hard[- ]?coding|only for (?:customer|tenant|client)\b|"
    r"(?:customer|tenant|client)[- ]specific|special[- ]case for|fork for|"
    r"custom build for)\b",
    re.I,
)


@dataclass
class SectionText:
    key: str
    heading: str
    body: str
    # The markdown body (bullets and tables); ``body`` is its plain text.
    md: str = ""
    layer: str = "detail"
    citation_keys: list[str] = field(default_factory=list)
    roles: set[str] = field(default_factory=set)

    @property
    def words(self) -> int:
        return len(_WORD.findall(self.body))

    @property
    def bullets(self) -> list[str]:
        return [m.group(1).strip() for m in _BULLET.finditer(self.md or self.body)]

    @property
    def has_number(self) -> bool:
        return bool(_NUMBER.search(self.body))


def roles_of(key: str, heading: str) -> set[str]:
    label = f"{key} {heading}".lower().replace("_", " ")
    found = {role for role, pattern in ROLES.items() if pattern.search(label)}
    for role, excluded in EXCLUDES.items():
        if role in found and found & excluded:
            found.discard(role)
    return found


def classify(sections: list[SectionText]) -> list[SectionText]:
    for s in sections:
        s.roles = roles_of(s.key, s.heading)
    return sections


def with_role(sections: list[SectionText], role: str) -> list[SectionText]:
    return [s for s in sections if role in s.roles and "sources" not in s.roles]


def content(sections: list[SectionText]) -> list[SectionText]:
    """Every section except the Sources and data points appendix."""
    return [s for s in sections if "sources" not in s.roles]


def items_of(sections: list[SectionText]) -> list[str]:
    """Bullets of the sections; a section with no bullets counts as one item."""
    out: list[str] = []
    for s in sections:
        out += s.bullets or ([s.body.strip()] if s.body.strip() else [])
    return out


def untestable(item: str) -> str | None:
    """The vague word that makes an acceptance criterion untestable, if any."""
    if _NUMBER.search(item) or OBSERVABLE.search(item):
        return None
    match = VAGUE.search(item)
    if match:
        return match.group(0).lower()
    # No number, no observable condition and no vague word: still untestable.
    return "no measurable condition"


def leakage(sections: list[SectionText]) -> list[tuple[str, str]]:
    """(section key, matched words) for tenant-specific behaviour in requirements."""
    return [
        (s.key, m.group(0).lower())
        for s in content(sections)
        for m in TENANT_LEAKAGE.finditer(s.body)
    ]


def quote(text: str, limit: int = 80) -> str:
    text = " ".join(text.split())
    return text if len(text) <= limit else text[: limit - 1].rstrip() + "…"
