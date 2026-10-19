"""Third-party limits and compliant solution paths (build prompt §6, §16 item 8).

A limit set by a third party is one of four kinds, and each is solved differently:

- ``capacity``: a rate or capacity limit. Efficiency, batching, queueing within the
  permitted rate, or a higher tier through the provider's own process.
- ``eligibility``: API eligibility. The approved program or entitlement, a workflow that
  does not need the gated API, or another channel.
- ``permission``: permissions. People grant access explicitly (opt-in, OAuth consent), or
  the permission is requested through the provider's review.
- ``policy``: a third party's policy. Opt-in interactions, negotiated or sanctioned
  access, another channel. A policy is never "optimized around".

:func:`screen` is a deterministic check of an option's text for tactics Oracle never
proposes: evading platform restrictions, abusing identities or accounts, and messaging
people without permission. It is conservative on purpose: a flagged option is stored as
``non_compliant`` and ``rejected``, is never recommended and can never be selected or
kept as a fallback. Rewording an idea that was flagged by mistake is the way out; no
role can mark flagged text compliant.
"""

import re
from dataclasses import dataclass
from typing import Literal, get_args

from pydantic import BaseModel

LimitKind = Literal["capacity", "eligibility", "permission", "policy", "other"]
LIMIT_KINDS: tuple[str, ...] = get_args(LimitKind)
THIRD_PARTY_KINDS = ("capacity", "eligibility", "permission", "policy")

LIMIT_KIND_LABELS = {
    "capacity": "Rate or capacity limit",
    "eligibility": "API eligibility",
    "permission": "Permissions",
    "policy": "Third-party policy",
    "other": "Other constraint",
}

PolicyCategory = Literal["evasion", "identity_abuse", "unauthorized_messaging"]

PROHIBITED = (
    "Oracle never proposes evading platform restrictions, abusing identities or accounts, "
    "or messaging people without their permission."
)


class BlockerPolicyFlag(BaseModel):
    category: PolicyCategory
    # The words that matched, so a reviewer sees why.
    match: str
    message: str


class BlockerCompliantPath(BaseModel):
    approach: str
    label: str
    guidance: str


_MESSAGES = {
    "evasion": "Evades a platform restriction (limits, detection, terms)",
    "identity_abuse": "Abuses identities or accounts",
    "unauthorized_messaging": "Messages people without their permission",
}

_RULES: list[tuple[str, str]] = [
    # Evading platform restrictions.
    (
        "evasion",
        r"\b(bypass\w*|circumvent\w*|evad\w*|evasion|sidestep\w*|defeat\w*|get(?:ting)? around"
        r"|work(?:ing)? around|dodg\w*)\b[^.;]{0,40}?\b(rate[ -]?limit\w*|limit\w*|quota\w*"
        r"|restriction\w*|bans?|block\w*|captcha\w*|detection|terms|tos|polic\w*|throttl\w*"
        r"|filters?)",
    ),
    ("evasion", r"\brotat\w*\s+(?:\w+\s+){0,2}(ips?|ip addresses|prox(?:y|ies)|user[ -]?agents?)"),
    ("evasion", r"\bresidential prox(?:y|ies)"),
    ("evasion", r"\bspoof\w*"),
    ("evasion", r"\bcaptcha[ -]?solv\w*"),
    ("evasion", r"\b(avoid|escape|evade)\w*\s+(?:\w+\s+){0,2}detect\w*"),
    ("evasion", r"\b(cannot|can't|won't|not)\s+(?:\w+\s+){0,2}detect\b"),
    ("evasion", r"\bstealth\w*\s+(?:\w+\s+){0,2}(browser|crawl\w*|scrap\w*|mode)"),
    ("evasion", r"\bscrap\w*\b[^.;]{0,40}?\b(despite|against|violat\w*|without permission)"),
    ("evasion", r"\b(violat\w*|break\w*|ignor\w*)\s+(?:\w+\s+){0,3}(terms|tos|polic\w*)"),
    # Abusing identities or accounts.
    (
        "identity_abuse",
        r"\b(fake|sock[ -]?puppet|burner|throwaway|purchased|bought|rented|aged|bot)\s+"
        r"(?:\w+\s+){0,1}(accounts?|profiles?|identit\w*|personas?)",
    ),
    (
        "identity_abuse",
        r"\b(create|creating|register\w*|spin\w* up|open\w*|farm\w*|make|making|set\w* up)\s+"
        r"(?:\w+\s+){0,3}(many|multiple|hundreds of|thousands of|bulk|extra|additional|more|"
        r"several|duplicate)\s+(?:\w+\s+){0,1}(accounts?|profiles?|identit\w*)",
    ),
    ("identity_abuse", r"\b(buy|buying|rent|renting|purchas\w*)\s+(?:\w+\s+){0,2}accounts?"),
    ("identity_abuse", r"\baccount[ -]?farm\w*"),
    ("identity_abuse", r"\bimpersonat\w*|\bpos(?:e|ing) as\b"),
    (
        "identity_abuse",
        r"\b(shar\w*|borrow\w*|reus\w*|pool\w*)\s+(?:\w+\s+){0,3}(logins?|credentials|passwords?"
        r"|accounts?)\s+(across|between|among|with)",
    ),
    # Messaging people without permission.
    (
        "unauthorized_messaging",
        r"\b(unsolicited|spam\w*|cold)\s+(?:\w+\s+){0,1}(dms?|direct messages?|messag\w*|emails?"
        r"|texts?|sms|outreach|invit\w*)",
    ),
    (
        "unauthorized_messaging",
        r"\b(mass|bulk|blast\w*)[ -]+(?:\w+\s+){0,1}(dms?|direct[ -]messag\w*|messag\w*|emails?|"
        r"texts?|sms|outreach)",
    ),
    (
        "unauthorized_messaging",
        r"\b(messag\w*|dm\w*|contact\w*|email\w*|text\w*|invit\w*|ping\w*)\b[^.;]{0,40}?\bwithout"
        r"\s+(their\s+)?(consent|opt[ -]?in|permission|asking)",
    ),
    ("unauthorized_messaging", r"\bauto[ -]?(dm|follow|like|comment|message|reply)\w*"),
    (
        "unauthorized_messaging",
        r"\bscraped\s+(?:\w+\s+){0,1}(contacts|emails|phone numbers|addresses|leads)",
    ),
]
_COMPILED = [(cat, re.compile(rx, re.I)) for cat, rx in _RULES]
# A tactic named only to rule it out ("instead of bypassing the limit", "never create
# extra accounts") is not a proposal.
_NEGATION = re.compile(
    r"\b(not|never|no|without|instead of|rather than|avoid(?:ing)?|refuse to|don't|do not)"
    r"(\s+\w+){0,2}\s*$",
    re.I,
)


def screen(*texts: str | None) -> list[BlockerPolicyFlag]:
    """Flags for prohibited tactics in ``texts`` (an option's title, description and
    details); empty when none is found."""
    flags: list[BlockerPolicyFlag] = []
    seen: set[tuple[str, str]] = set()
    for text in texts:
        if not text:
            continue
        for category, rx in _COMPILED:
            for m in rx.finditer(text):
                if _NEGATION.search(text[max(0, m.start() - 30) : m.start()]):
                    continue
                key = (category, m.group(0).lower())
                if key in seen:
                    continue
                seen.add(key)
                flags.append(
                    BlockerPolicyFlag(
                        category=category, match=m.group(0), message=_MESSAGES[category]
                    )
                )
    return flags


@dataclass(frozen=True)
class _Path:
    approach: str
    label: str
    guidance: str


_PATHS: dict[str, list[_Path]] = {
    "capacity": [
        _Path(
            "architecture",
            "Efficiency",
            "Batch, cache and deduplicate calls so peak use stays under the published limit.",
        ),
        _Path(
            "operations",
            "Queue within the permitted rate",
            "Queue work and back off when the provider signals the limit; tell users "
            "when a result is delayed.",
        ),
        _Path(
            "partnership",
            "Higher tier or quota",
            "Request a higher quota or a paid tier through the provider's own process.",
        ),
        _Path(
            "alternative_workflow",
            "Fewer calls by design",
            "Change the workflow so fewer calls are needed (digests, on-demand refresh).",
        ),
    ],
    "eligibility": [
        _Path(
            "partnership",
            "Approved program or entitlement",
            "Apply for the provider's approved API program, partner status or entitlement.",
        ),
        _Path(
            "alternative_workflow",
            "A workflow that does not need the gated API",
            "Deliver the outcome through features available to every integration.",
        ),
        _Path(
            "distribution",
            "Channel diversification",
            "Offer the outcome through a channel or integration where the product is eligible.",
        ),
    ],
    "permission": [
        _Path(
            "alternative_workflow",
            "Explicit opt-in",
            "People grant access themselves (OAuth consent with the needed scopes, opt-in "
            "settings) and can revoke it.",
        ),
        _Path(
            "direct_remedy",
            "Request the permission",
            "Request the scope or permission through the provider's review process.",
        ),
        _Path(
            "operations",
            "Assisted step",
            "Keep a person in the loop for the step automation is not permitted to do.",
        ),
    ],
    "policy": [
        _Path(
            "alternative_workflow",
            "Opt-in interactions",
            "Interact only with people who asked for it; they start the conversation or subscribe.",
        ),
        _Path(
            "partnership",
            "Negotiated or sanctioned access",
            "Agree terms with the platform, or use its sanctioned integration.",
        ),
        _Path(
            "distribution",
            "Another channel",
            "Move the interaction to a channel whose policy allows it.",
        ),
    ],
}
_GENERIC = [
    _Path("direct_remedy", "Direct remedy", "Remove the constraint at its source."),
    _Path(
        "alternative_workflow",
        "Alternative workflow",
        "Reach the same user outcome by a different flow.",
    ),
    _Path(
        "architecture",
        "Architecture optimization",
        "Change the design so the constraint matters less.",
    ),
    _Path(
        "partnership",
        "Approved partnership or commercial path",
        "Agree access or capacity with the party that sets the constraint.",
    ),
    _Path("operations", "Operations or process", "Handle it with a process or a person."),
    _Path(
        "distribution",
        "Alternate distribution or integration",
        "Deliver through another channel or integration.",
    ),
]


def compliant_paths(limit_kind: str) -> list[BlockerCompliantPath]:
    """Compliant ways to reach the user outcome for this kind of limit (§6)."""
    paths = _PATHS.get(limit_kind, _GENERIC)
    return [
        BlockerCompliantPath(approach=p.approach, label=p.label, guidance=p.guidance) for p in paths
    ]
