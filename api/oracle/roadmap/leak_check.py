"""The leak check of a roadmap's Public version (spec-O5 §2): deterministic, no model.

It runs on every public text, the public title and the intro, and finds what a public
reader may never see. A blocking finding stops approval (422 ``leak_blocking``); a
warning needs a person's tick ("I checked this").

What it matches against comes from the company's own records (:func:`load_context`):
members' names and emails, win/loss accounts and plans, request askers' and interviewees'
companies, H7 alternatives and their aliases, document slugs, approvers-only documents,
decisions, the items' internal notes, the app's own host and the company's email domains.

Text is normalised before matching (:func:`normalize`): NFKC (fullwidth letters), every
invisible character stripped (Unicode's Default_Ignorable_Code_Point and category Cf:
zero-width spaces, soft hyphens, word joiners, the combining grapheme joiner, variation
selectors, Hangul fillers), look-alike letters (Unicode's confusables, via
:mod:`oracle.specs.confusables`) and dashes mapped to their Latin and ASCII forms; names
then match casefolded. A public text holding an invisible character is refused when saved
(:func:`format_characters`), so what an approver reads is what was checked; only the
joiners, selectors and tags of an ordinary emoji sequence (a ZWJ emoji, a keycap, the
England, Scotland or Wales flag) are kept. Any other tag run is refused, and the check
reads it as the ASCII it spells, in place, so a name split across two flags is found.
Characters that render blank without being Default_Ignorable (a braille blank, the
ideographic space) read as spaces.

Every pattern reads untrusted text and stays linear (no nested quantifiers).
"""

import ipaddress
import re
import unicodedata
from dataclasses import dataclass, field
from urllib.parse import urlsplit

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from oracle.specs.confusables import CONFUSABLES

BLOCKING = (
    "person_name",
    "email_or_phone",
    "customer_name",
    "alternative_name",
    "internal_code",
    "internal_host",
    # Beyond the spec's table: what a public text must never name either.
    "internal_document",  # an approvers-only document (H8), by title or slug
    "decision",  # a decision's title (the decision log is internal)
    "pricing",  # a win/loss plan or quoted price (H9)
    "internal_note",  # five words or more copied from an item's internal note
)
WARNINGS = ("money_or_metric", "date", "internal_title_copy")

# Shorter names match too often inside ordinary words to be told apart from them.
MIN_NAME = 3
NOTE_WORDS = 5
# A phone number has at least this many digits ("2026-2027" is a range of years).
PHONE_DIGITS = 9
MAX_TEXT = 2000

_EMAIL = re.compile(r"[\w.+-]{1,64}@[\w-]{1,63}(?:\.[\w-]{1,63}){1,8}")
_PHONE = re.compile(r"\+?\d[\d ().-]{7,18}\d")
_TRACKER = re.compile(r"\b[A-Z]{2,10}-\d{1,6}\b")
_GOAL = re.compile(r"\bG\d{1,4}\b")
_DECISION = re.compile(r"\bD-\d{1,6}\b")
_URL = re.compile(r"\b(?:https?://|www\.)[^\s<>\"')]{1,300}", re.IGNORECASE)
_BARE_HOST = re.compile(r"\blocalhost\b", re.IGNORECASE)
_MONEY = re.compile(
    r"(?:[$€£]\s?\d[\d,.]*|\b\d[\d,.]*\s?(?:k|m|bn)?\s?(?:USD|EUR|GBP|dollars|euros)\b)"
)
_PERCENT = re.compile(r"\b\d{1,4}(?:[.,]\d{1,3})?\s?(?:%|percent\b)")
_MONTHS = (
    "january february march april may june july august september october november december"
).split()
_MONTH = re.compile(
    r"\b(" + "|".join(m[:3] + f"(?:{m[3:]})?" if len(m) > 3 else m for m in _MONTHS) + r")\b",
    re.IGNORECASE,
)
_ISO_DATE = re.compile(r"\b\d{4}-\d{2}-\d{2}\b|\b\d{1,2}/\d{1,2}(?:/\d{2,4})?\b")
_WORD = re.compile(r"\w+")

# Not Default_Ignorable, yet drawn as a blank: they read as a space.
_BLANKS = "\u2800\u3000\U0001d159"
# Dashes and minus signs that read as "-" (NFKC keeps them apart).
_DASHES = "\u2010\u2011\u2012\u2013\u2014\u2015\u2212\u2043\ufe58\ufe63\uff0d"


def _as_latin(char: str, prototype: str) -> str:
    """A confusable's Latin form in its own case: the prototype is lower case, and a
    capital drawn like "l" (Greek Iota, Cyrillic I) reads as "I"."""
    if not char.isupper():
        return prototype
    return "I" if prototype == "l" else prototype.upper()


# Every letter Unicode's confusables.txt draws like one or two Latin letters (Greek,
# Cyrillic, Cherokee, Armenian, IPA, small capitals...); Greek kappa is the one look-alike
# the file maps elsewhere.
_LOOK_ALIKE = {
    cp: _as_latin(chr(cp), prototype)
    for cp, prototype in CONFUSABLES.items()
    if prototype.isalpha()
}
_FOLD = str.maketrans(
    {
        **dict.fromkeys(map(ord, _DASHES), "-"),
        **_LOOK_ALIKE,
        ord("κ"): "k",
        **dict.fromkeys(map(ord, _BLANKS), " "),
    }
)
# Default_Ignorable_Code_Point (DerivedCoreProperties.txt): what renders as nothing,
# whatever its category (Cf, but also the marks U+034F, U+17B4/5 and the variation
# selectors, and the Hangul fillers, which are letters).
_IGNORABLE = re.compile(
    "[\u00ad\u034f\u061c\u115f\u1160\u17b4\u17b5\u180b-\u180f\u200b-\u200f"
    "\u202a-\u202e\u2060-\u206f\u3164\ufe00-\ufe0f\ufeff\uffa0\ufff0-\ufff8"
    "\U0001bca0-\U0001bca3\U0001d173-\U0001d17a\U000e0000-\U000e0fff]"
)


def _tags(text: str) -> str:
    return "".join(chr(0xE0000 + ord(c)) for c in text)


# The three subdivision flags Unicode recommends (England, Scotland, Wales): the black
# flag, their tag letters, the cancel tag. Any other tag run could spell hidden text.
_FLAG_TAGS = re.compile(
    "\U0001f3f4(" + "|".join(_tags(f) for f in ("gbeng", "gbsct", "gbwls")) + ")(\U000e007f)"
)
# Any other run of tags, with the black flag before it and the cancel tag after it.
_TAG_RUN = re.compile("\U0001f3f4?([\U000e0020-\U000e007e]+)\U000e007f?|\U000e007f")
_KEYCAP = "\u20e3"
# Words in a company's name that do not tell it apart ("Northwind Traders" is named by
# "Northwind" alone; "Traders" is anyone's).
GENERIC_COMPANY_WORDS = frozenset(
    """
    inc incorporated ltd limited llc llp plc gmbh corp corporation company companies group
    holding holdings international global worldwide partners partnership associates
    services service solutions systems software technologies technology tech labs
    industries enterprises enterprise traders trading consulting consultants capital
    ventures digital media health healthcare care medical bank banking financial finance
    insurance foods food logistics energy retail stores store shop online cloud data
    analytics networks network agency studio studios brands foundation university school
    products manufacturing motors airlines hotels resorts pharma pharmaceuticals north
    south east west american european national united first new
    """.split()
)


@dataclass(frozen=True)
class Finding:
    code: str
    severity: str  # "blocking" | "warning"
    words: list[str] = field(default_factory=list)


@dataclass
class LeakContext:
    people: list[str] = field(default_factory=list)
    emails: list[str] = field(default_factory=list)
    customers: list[str] = field(default_factory=list)
    alternatives: list[str] = field(default_factory=list)
    hidden_documents: list[str] = field(default_factory=list)
    slugs: list[str] = field(default_factory=list)
    decisions: list[str] = field(default_factory=list)
    pricing: list[str] = field(default_factory=list)
    notes: list[str] = field(default_factory=list)
    hosts: list[str] = field(default_factory=list)
    company_domains: list[str] = field(default_factory=list)


def _invisible(char: str) -> bool:
    return bool(_IGNORABLE.match(char)) or unicodedata.category(char) == "Cf"


def _strip_invisible(text: str) -> str:
    return "".join(c for c in text if not _invisible(c))


def _pictographic(char: str) -> bool:
    """An emoji or other symbol (a skin tone is Sk), never a letter or digit."""
    return ord(char) > 0x7F and unicodedata.category(char) in ("So", "Sk")


def _emoji_parts(text: str) -> set[int]:
    """Where ``text``'s invisible characters belong to an ordinary emoji sequence: a ZWJ
    between two emoji, a variation selector after an emoji or in a keycap, and a
    subdivision flag's tags. None of them can split a word."""
    keep: set[int] = set()
    for m in _FLAG_TAGS.finditer(text):
        keep.update(range(m.start(1), m.end(2)))
    for i, char in enumerate(text):
        if char not in "\u200d\ufe0e\ufe0f":
            continue
        before = text[i - 1] if i else " "
        after = text[i + 1] if i + 1 < len(text) else " "
        if char == "\u200d":
            if before in "\ufe0e\ufe0f" and i - 1 in keep:
                before = text[i - 2]
            ok = _pictographic(before) and _pictographic(after)
        else:
            ok = _pictographic(before) or (before in "0123456789#*" and after == _KEYCAP)
        if ok:
            keep.add(i)
    return keep


def _hidden(text: str) -> list[int]:
    """Where ``text`` holds an invisible character outside an emoji sequence."""
    keep = _emoji_parts(text)
    return [i for i, c in enumerate(text) if _invisible(c) and i not in keep]


def _tag_letters(m: re.Match[str]) -> str:
    return "".join(chr(ord(c) - 0xE0000) for c in m.group(1) or "")


def normalize(text: str) -> str:
    """``text`` as a reader sees it: NFKC, no invisible characters, look-alike letters,
    dashes and blanks mapped. A real flag reads as a space; any other tag run is read as
    the ASCII it spells, in place and without its flag, as a decoder would, so a name or
    number split across two flags is found. Case is kept (tracker keys and "May" read it)."""
    text = _FLAG_TAGS.sub(" ", text or "")
    text = _strip_invisible(_TAG_RUN.sub(_tag_letters, text))
    text = _strip_invisible(unicodedata.normalize("NFKC", text))
    return text.translate(_FOLD)


def format_characters(text: str) -> list[str]:
    """The invisible characters ``text`` holds outside an ordinary emoji sequence
    ("U+200B", "U+034F", ...), each once."""
    text = text or ""
    return list(dict.fromkeys(f"U+{ord(text[i]):04X}" for i in _hidden(text)))


def strip_format(text: str) -> str:
    """``text`` without the characters :func:`format_characters` tells."""
    text = text or ""
    hidden = set(_hidden(text))
    return "".join(c for i, c in enumerate(text) if i not in hidden)


def _norm(text: str) -> str:
    return " ".join(_WORD.findall(normalize(text).casefold()))


def _names(text: str, names: list[str]) -> list[str]:
    """Each of ``names`` that ``text`` holds as whole words (case-insensitive)."""
    padded = f" {_norm(text)} "
    out: list[str] = []
    for name in names:
        n = _norm(name or "")
        if len(n) < MIN_NAME or name in out:
            continue
        if f" {n} " in padded:
            out.append(name)
    return out


def _norm_email(email: str) -> str:
    return normalize(email).casefold()


def _slug_in(slug: str, lowered: str) -> bool:
    """A document slug as a whole token. Only hyphenated slugs count: a one-word slug
    ("import") is an ordinary word."""
    slug = (slug or "").casefold()
    if "-" not in slug or len(slug) < MIN_NAME:
        return False
    start = lowered.find(slug)
    while start != -1:
        end = start + len(slug)
        before = lowered[start - 1] if start else " "
        after = lowered[end] if end < len(lowered) else " "
        if not (before.isalnum() or before in "-_") and not (after.isalnum() or after in "-_"):
            return True
        start = lowered.find(slug, start + 1)
    return False


def _person_names(ctx: LeakContext) -> list[str]:
    """Full names, and each part of a full name of 4 letters or more (a surname alone
    names a person too)."""
    out: list[str] = []
    for name in ctx.people:
        if not name:
            continue
        out.append(name)
        parts = _WORD.findall(name)
        if len(parts) > 1:
            out += [p for p in parts if len(p) >= 4]
    return out


def _customer_names(ctx: LeakContext) -> list[str]:
    """Full labels, and each distinctive part of 4 letters or more ("Northwind" names
    "Northwind Traders"; a generic word such as "Traders" does not)."""
    out: list[str] = []
    for name in ctx.customers:
        if not name:
            continue
        out.append(name)
        parts = _WORD.findall(normalize(name))
        if len(parts) > 1:
            out += [p for p in parts if len(p) >= 4 and p.casefold() not in GENERIC_COMPANY_WORDS]
    return out


def _private_host(host: str) -> bool:
    if host in ("localhost",) or host.endswith(".localhost") or host.endswith(".internal"):
        return True
    try:
        ip = ipaddress.ip_address(host)
    except ValueError:
        return False
    return ip.is_private or ip.is_loopback or ip.is_link_local


def _hosts(text: str, ctx: LeakContext) -> list[str]:
    found: list[str] = []
    own = {h.lower() for h in ctx.hosts if h}
    domains = {d.lower() for d in ctx.company_domains if d}
    for m in _URL.finditer(text):
        raw = m.group(0)
        url = raw if "://" in raw else f"https://{raw}"
        host = (urlsplit(url).hostname or "").lower()
        if not host:
            continue
        on_domain = any(host == d or host.endswith("." + d) for d in domains)
        # The company's public site (example.com, www.example.com) is fine; an app or
        # internal host on its domain is not.
        public_site = host in domains or host in {f"www.{d}" for d in domains}
        if host in own or _private_host(host) or (on_domain and not public_site):
            found.append(host)
    if _BARE_HOST.search(text) and "localhost" not in found:
        found.append("localhost")
    return found


def _note_copies(text: str, notes: list[str]) -> list[str]:
    words = f" {_norm(text)} "
    out: list[str] = []
    for note in notes:
        parts = _norm(note or "").split()
        for i in range(len(parts) - NOTE_WORDS + 1):
            run = " ".join(parts[i : i + NOTE_WORDS])
            if f" {run} " in words:
                out.append(run)
                break
    return out


def _quarter_months(quarter: str | None) -> set[str]:
    if not quarter or not re.fullmatch(r"\d{4}-Q[1-4]", quarter):
        return set()
    q = int(quarter[-1])
    return {m[:3] for m in _MONTHS[(q - 1) * 3 : q * 3]}


def check(
    text: str,
    ctx: LeakContext,
    *,
    announced_quarter: str | None = None,
    internal_title: str | None = None,
) -> list[Finding]:
    """Every finding in ``text``: blocking ones first, then warnings."""
    text = normalize((text or "")[:MAX_TEXT])
    out: list[Finding] = []

    def add(code: str, words: list[str]) -> None:
        if words:
            severity = "blocking" if code in BLOCKING else "warning"
            out.append(Finding(code, severity, list(dict.fromkeys(words))))

    emails = [m.group(0) for m in _EMAIL.finditer(text)]
    people = _names(text, _person_names(ctx))
    folded = text.casefold()
    people += [e for e in ctx.emails if e and _norm_email(e) in folded and e not in emails]
    add("person_name", people)
    phones = [m.group(0).strip() for m in _PHONE.finditer(text)]
    phones = [p for p in phones if sum(c.isdigit() for c in p) >= PHONE_DIGITS]
    add("email_or_phone", emails + phones)
    add("customer_name", _names(text, _customer_names(ctx)))
    add("alternative_name", _names(text, ctx.alternatives))
    codes = [m.group(0) for p in (_TRACKER, _GOAL, _DECISION) for m in p.finditer(text)]
    lowered = folded
    codes += [s for s in ctx.slugs if _slug_in(normalize(s), lowered)]
    add("internal_code", codes)
    add("internal_host", _hosts(text, ctx))
    add("internal_document", _names(text, ctx.hidden_documents))
    add("decision", _names(text, ctx.decisions))
    add("pricing", _names(text, ctx.pricing))
    add("internal_note", _note_copies(text, ctx.notes))

    add(
        "money_or_metric",
        [m.group(0).strip() for p in (_MONEY, _PERCENT) for m in p.finditer(text)],
    )
    allowed = _quarter_months(announced_quarter)
    dates = [m.group(0) for m in _MONTH.finditer(text) if m.group(0)[:3].lower() not in allowed]
    # "may" is a word as well as a month: only "May" with a capital, followed by a day.
    dates = [d for d in dates if d.lower() != "may" or d == "May"]
    add("date", dates + [m.group(0) for m in _ISO_DATE.finditer(text)])
    if internal_title and _norm(internal_title) and _norm(text) == _norm(internal_title):
        add("internal_title_copy", [internal_title])
    return out


def blocking(findings: list[Finding]) -> list[Finding]:
    return [f for f in findings if f.severity == "blocking"]


def warnings(findings: list[Finding]) -> list[str]:
    return [f.code for f in findings if f.severity == "warning"]


async def load_context(db: AsyncSession) -> LeakContext:
    """The company's records a public text is checked against (the tenant session)."""
    from oracle import tenant_settings_api
    from oracle.auth.models import User
    from oracle.config import get_settings
    from oracle.decisions.models import Decision
    from oracle.docs.models import Document
    from oracle.interviews.models import Interview
    from oracle.market.models import Competitor
    from oracle.pricing.models import DealOutcome
    from oracle.requests.models import ProductRequest
    from oracle.roadmap.models import RoadmapItem

    ctx = LeakContext()
    for name, email in (await db.execute(select(User.name, User.email))).all():
        if name:
            ctx.people.append(name)
        if email:
            ctx.emails.append(email)
    for account, plan, price in (
        await db.execute(select(DealOutcome.account, DealOutcome.plan, DealOutcome.price_quoted))
    ).all():
        ctx.customers.append(account)
        ctx.pricing += [p for p in (plan, price) if p]
    ctx.customers += [
        n
        for n in await db.scalars(
            select(ProductRequest.requester_name).where(
                ProductRequest.requester_kind == "customer",
                ProductRequest.requester_name.is_not(None),
            )
        )
    ]
    for company, person in (
        await db.execute(select(Interview.interviewee_company, Interview.interviewee_name))
    ).all():
        if company:
            ctx.customers.append(company)
        if person:
            ctx.people.append(person)
    for name, aliases in (await db.execute(select(Competitor.name, Competitor.aliases))).all():
        ctx.alternatives += [name, *(aliases or [])]
    for slug, title, visibility in (
        await db.execute(select(Document.slug, Document.title, Document.visibility))
    ).all():
        ctx.slugs.append(slug)
        if visibility != "company":
            ctx.hidden_documents += [title, slug]
    ctx.decisions = [t for t in await db.scalars(select(Decision.title)) if t]
    ctx.notes = [
        n for n in await db.scalars(select(RoadmapItem.note).where(RoadmapItem.note.is_not(None)))
    ]
    app = urlsplit(get_settings().app_url or "").hostname
    if app:
        ctx.hosts.append(app)
    domains = await tenant_settings_api.get_setting(db, "company_email_domains")
    ctx.company_domains = [str(d) for d in domains or []]
    return ctx
