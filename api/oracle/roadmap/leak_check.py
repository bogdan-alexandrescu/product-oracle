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
selectors, Hangul fillers), nonspacing and enclosing marks dropped (an accent, a keycap's
U+20E3), look-alike letters (Unicode's confusables, via :mod:`oracle.specs.confusables`)
and dashes mapped to their Latin and ASCII forms. Names, notes, titles and slugs then match
on their confusable skeleton (:func:`skeleton`, UTS #39 §4): NFD, every combining mark
(Mn, Mc, Me) and Default_Ignorable dropped, casefolded and mapped through Unicode's own
confusables.txt (vendored in ``unicode/`` for the Unicode version Python reports), so a
mark on or inside a name ("Northwi\u0307nd", "N\u00f6rthwind", U+0130) and mixed-script
look-alikes are found. They also match on the strict skeleton (:func:`strict_skeleton`:
every character mapped before case is folded, so a capital I, Greek Iota or Cyrillic I
stands in for a small l as Unicode says, then mapped and folded again until nothing
changes, so a stored "M" and a written "m" meet); a name is found when either form
matches. A public text holding an invisible character is refused when saved
(:func:`format_characters`), so what an approver reads is what was checked; only the
joiners, selectors and tags of an ordinary emoji sequence (a ZWJ emoji, a keycap, the
England, Scotland or Wales flag) are kept. Any other tag run is refused, and the check
reads it as the ASCII it spells, in place, so a name split across two flags is found.
Characters that render blank without being Default_Ignorable (a braille blank, the
ideographic space) read as spaces; the Ogham space mark, drawn as a line or a blank, is
refused like an invisible character.

Every pattern reads untrusted text and stays linear (no nested quantifiers).
"""

import functools
import ipaddress
import re
import unicodedata
from dataclasses import dataclass, field
from pathlib import Path
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
_SPACES = str.maketrans(
    {**dict.fromkeys(map(ord, _DASHES), "-"), **dict.fromkeys(map(ord, _BLANKS), " ")}
)
_FOLD = str.maketrans({**_LOOK_ALIKE, ord("κ"): "k"})
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
# Not Default_Ignorable, but drawn as a line or a blank depending on the font: refused and
# read as nothing, so it cannot split a name.
_REFUSED = "\u1680"

# Unicode's confusables.txt (UTS #39) for the Unicode version Python's unicodedata reports,
# vendored with its licence; a missing file fails at import.
CONFUSABLES_FILE = Path(__file__).parent / "unicode" / "confusables.txt"


def _load_skeleton_map(path: Path) -> dict[int, str]:
    """Each source character of confusables.txt to its prototype ("0" -> "O", "m" -> "rn")."""
    out: dict[int, str] = {}
    for line in path.read_text(encoding="utf-8").splitlines():
        fields = line.split("#", 1)[0].split(";")
        if len(fields) < 3:
            continue
        source = fields[0].split()
        if len(source) == 1:
            out[int(source[0], 16)] = "".join(chr(int(c, 16)) for c in fields[1].split())
    return out


# Letters newer than Python's Unicode (the look-alikes :mod:`oracle.specs.confusables` was
# generated with) keep their mapping too.
SKELETON_MAP = {**CONFUSABLES, **_load_skeleton_map(CONFUSABLES_FILE)}
_MARKS = ("Mn", "Mc", "Me")
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
    return char in _REFUSED or bool(_IGNORABLE.match(char)) or unicodedata.category(char) == "Cf"


def _strip_invisible(text: str) -> str:
    return "".join(c for c in text if not _invisible(c))


def _drop_marks(text: str, marks: tuple[str, ...]) -> str:
    """``text`` decomposed (NFD), without the combining marks of the ``marks`` categories."""
    return "".join(
        c for c in unicodedata.normalize("NFD", text) if unicodedata.category(c) not in marks
    )


# Only strings this short (names, titles, slugs) are cached: a 2,000-character text is
# checked once per save and render.
CACHED_TEXT = 256


def _cached(fn):
    cached = functools.lru_cache(maxsize=4096)(fn)

    @functools.wraps(fn)
    def wrapper(text: str) -> str:
        return cached(text) if len(text) <= CACHED_TEXT else fn(text)

    wrapper.cache = cached
    return wrapper


@_cached
def skeleton(text: str) -> str:
    """``text``'s confusable skeleton (UTS #39 §4, casefolded): NFD, every combining mark and
    Default_Ignorable dropped, casefolded, each character mapped through confusables.txt
    (:func:`_prototype`); repeated until nothing changes, since a prototype may itself be
    upper case ("0" -> "O") or decompose. Two strings a reader cannot tell apart have the
    same skeleton."""
    for _ in range(4):
        before = text
        text = "".join(map(_prototype, _strip_invisible(_drop_marks(text, _MARKS))))
        if text == before:
            break
    return text


def _prototype(char: str) -> str:
    """A character's prototype in confusables.txt, casefolded. ASCII is casefolded first
    ("I" is "i", not the "l" it is drawn like); any other letter keeps its own prototype,
    as casefolding can change it (Greek capital Nu folds to nu, drawn like "v"; Cherokee
    small letters fold to capitals). A capital drawn like "l" (Greek Iota, Cyrillic I)
    reads as "I", as in :func:`_as_latin`."""
    prototype = None if char.isascii() else SKELETON_MAP.get(ord(char))
    if prototype is None:
        return char.casefold().translate(SKELETON_MAP)
    return "i" if prototype == "l" and char.isupper() else prototype


# Rounds of mapping and casefolding allowed before the strict skeleton stops changing: three
# at most in practice ("M" -> "m" -> "rn"); a test checks every character settles in fewer,
# so the limit only bounds the loop and never cuts it short.
_STRICT_ROUNDS = 8


def _strict_round(text: str) -> str:
    """One round of :func:`strict_skeleton`: marks and invisibles dropped, each character
    mapped through confusables.txt as it is, then casefolded."""
    text = _strip_invisible(_drop_marks(text, _MARKS)).translate(SKELETON_MAP)
    return _drop_marks(text, _MARKS).casefold()


@_cached
def strict_skeleton(text: str) -> str:
    """``text``'s skeleton as UTS #39 §4 defines it, taken to a fixed point with casefolding:
    NFD, every combining mark and Default_Ignorable dropped, each character mapped through
    confusables.txt as it is (capital I, Greek Iota and Cyrillic I to "l"; "m" to "rn"),
    casefolded, and mapped and folded again until nothing changes. Unlike :func:`skeleton`,
    a capital I stands in for a small l ("RivaICo" is "RivalCo"); and as the map is applied
    after folding too, case and look-alikes meet in any order (a stored "Mallory" and a
    written "maIIory" are both "rnallory")."""
    for _ in range(_STRICT_ROUNDS):
        before = text
        text = _strict_round(text)
        if text == before:
            break
    return text


def _char_forms(char: str, *, cached: bool = True) -> frozenset[str]:
    """Each way a character is read: its skeleton (case folded first, :func:`skeleton`), its
    strict skeleton as written and its strict skeleton after case folding. A capital I is
    "i" or "l", a capital L only "l", a small l only "l"."""
    sk, strict = (
        (skeleton, strict_skeleton)
        if cached
        else (
            skeleton.__wrapped__,
            strict_skeleton.__wrapped__,
        )
    )
    return frozenset((sk(char), strict(char), strict(char.casefold())))


_char_forms_cached = functools.lru_cache(maxsize=8192)(_char_forms)


def _ambiguous_sets() -> list[frozenset[str]]:
    """Every set of more than one reading a character can have, once each ({"i", "l"} for a
    capital I, {"n", "v"} for Greek capital Nu...). Only a letter that confusables.txt maps,
    that case folding changes or that decomposes can have more than one."""
    found: dict[frozenset[str], None] = {}
    for cp in range(0x110000):
        char = chr(cp)
        if cp in SKELETON_MAP or char.casefold() != char or unicodedata.decomposition(char):
            forms = _char_forms(char, cached=False)
            if len(forms) > 1 and any(_TOKEN.search(f) for f in forms):
                found[forms] = None
    return list(found)


# A word in a text's mixed form (:func:`_mixed`): letters, digits and the stand-ins below.
_TOKEN = re.compile("[\\w\U000f0000-\U000ffffd]+")
# A written character with more than one reading stands for all of them in the mixed form,
# as one stand-in character (Supplementary Private Use Area-A) per set of readings; a name's
# letter matches every stand-in holding one of its own readings.
_STAND_INS = {forms: chr(0xF0000 + i) for i, forms in enumerate(_ambiguous_sets())}
_STAND_INS_FOR: dict[str, str] = {}
for _forms_set, _stand_in in _STAND_INS.items():
    for _form in _forms_set:
        _STAND_INS_FOR[_form] = _STAND_INS_FOR.get(_form, "") + _stand_in


def _mixed(read: str) -> str:
    """``read`` (a :func:`_read` text) letter by letter: each character's one reading, or
    the stand-in for its readings when it has several, so a capital I written for an "i"
    and another for an "l" both match within one name."""
    out = []
    for char in read:
        forms = _char_forms_cached(char)
        stand_in = _STAND_INS.get(forms) if len(forms) > 1 else None
        out.append(stand_in or min(forms))
    return "".join(out)


_GENERIC_SKELETONS = frozenset(map(skeleton, GENERIC_COMPANY_WORDS))


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
    """``text`` as a reader sees it: NFKC, no invisible characters, nonspacing and enclosing
    marks, look-alike letters, dashes and blanks mapped. A real flag reads as a space; any
    other tag run is read as the ASCII it spells, in place and without its flag, as a
    decoder would, so a name or number split across two flags is found. Case is kept
    (tracker keys and "May" read it)."""
    return _read(text).translate(_FOLD)


def _read(text: str) -> str:
    """:func:`normalize` before look-alike letters are mapped (:func:`skeleton` maps them
    from confusables.txt itself, after casefolding)."""
    text = _FLAG_TAGS.sub(" ", text or "")
    text = _strip_invisible(_TAG_RUN.sub(_tag_letters, text))
    text = _strip_invisible(unicodedata.normalize("NFKC", text))
    # An accent or a keycap's U+20E3 does not change the letter or digit it sits on.
    text = unicodedata.normalize("NFC", _drop_marks(text, ("Mn", "Me")))
    return text.translate(_SPACES)


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
    """``text``'s words on their confusable skeleton, one space apart."""
    return " ".join(_WORD.findall(skeleton(_read(text))))


# The few texts a check is reading (each name list is matched against the same text).
@functools.lru_cache(maxsize=8)
def _forms(text: str) -> tuple[str, ...]:
    """``text``'s words on each of its forms, one space apart: its skeleton
    (:func:`skeleton`), its strict skeleton as written and after case folding
    (:func:`strict_skeleton`), and its mixed form (:func:`_mixed`, each character on all of
    its readings at once). A name is found when any form holds it."""
    read = _read(text)
    forms = (
        skeleton(read),
        strict_skeleton(read),
        strict_skeleton(read.casefold()),
        _mixed(read),
    )
    return tuple(" ".join(_TOKEN.findall(form)) for form in forms)


@functools.lru_cache(maxsize=8)
def _slug_forms(text: str) -> tuple[str, ...]:
    """:func:`_forms` with every character kept (a slug's hyphens and underscores)."""
    read = _read(text)
    return (
        skeleton(read),
        strict_skeleton(read),
        strict_skeleton(read.casefold()),
        _mixed(read),
    )


def _letter(char: str) -> str | None:
    """The pattern of one character of a company's own record (a name, note or slug): any
    of its readings (:func:`_char_forms`), or a stand-in holding one; None when every
    reading is a space or punctuation."""
    forms = _char_forms_cached(char)
    words = {"".join(_TOKEN.findall(f)) for f in forms} - {""}
    if not words:
        return None
    stand_ins = "".join(dict.fromkeys(c for f in forms for c in _STAND_INS_FOR.get(f, "")))
    alts = [re.escape(w) for w in sorted(words, key=lambda w: (-len(w), w))]
    if stand_ins:
        alts.append(f"[{stand_ins}]")
    return alts[0] if len(alts) == 1 else f"(?:{'|'.join(alts)})"


@functools.lru_cache(maxsize=4096)
def _record_words(text: str) -> tuple[tuple[str, str], ...]:
    """A company's own record word by word: each word's pattern, letter by letter on all of
    its readings (:func:`_letter`), with the word on its skeleton. A record is found on any
    of its forms, the strict skeleton as stored (a capital I as "l") or after case folding
    (as "i"), and on a different one letter by letter: a stored "INGRID" written
    "lngrid"."""
    words: list[tuple[str, str]] = []
    pattern: list[str] = []
    plain: list[str] = []
    for char in _read(text) + " ":
        letter = _letter(char)
        if letter is not None:
            pattern.append(letter)
            plain.append(skeleton(char))
        elif pattern:
            words.append(("".join(pattern), "".join(plain)))
            pattern, plain = [], []
    return tuple(words)


@functools.lru_cache(maxsize=4096)
def _record_pattern(text: str) -> re.Pattern[str] | None:
    """:func:`_record_words` as whole words, one space apart (None for a record without
    one)."""
    words = _record_words(text)
    if not words:
        return None
    return re.compile(" " + " ".join(p for p, _ in words) + " ")


@functools.lru_cache(maxsize=4096)
def _slug_pattern(slug: str) -> re.Pattern[str]:
    """A slug letter by letter (:func:`_letter`), its hyphens and underscores as they are,
    as a whole token: no letter, digit, hyphen or underscore on either side."""
    parts = []
    for char in _read(slug):
        letter = _letter(char)
        parts.append(letter if letter is not None else re.escape(skeleton(char)))
    edge = "[\\w\U000f0000-\U000ffffd-]"
    return re.compile(f"(?<!{edge})" + "".join(parts) + f"(?!{edge})")


def _plain(text: str) -> str:
    """``text`` without its combining marks, for splitting a name into its parts."""
    return unicodedata.normalize("NFC", _drop_marks(_read(text), _MARKS))


def _names(text: str, names: list[str]) -> list[str]:
    """Each of ``names`` that ``text`` holds as whole words, on any form of the name
    (:func:`_record_words`) and any form of the text (:func:`_forms`)."""
    padded = [f" {form} " for form in _forms(text)]
    out: list[str] = []
    for name in names:
        if len(_norm(name or "")) < MIN_NAME or name in out:
            continue
        pattern = _record_pattern(name)
        if pattern and any(pattern.search(p) for p in padded):
            out.append(name)
    return out


def _norm_email(email: str) -> str:
    return normalize(email).casefold()


def _slug_in(slug: str) -> bool:
    """Whether a document slug is matched at all. Only hyphenated slugs count: a one-word
    slug ("import") is an ordinary word."""
    slug = (slug or "").casefold()
    return "-" in slug and len(slug) >= MIN_NAME


def _person_names(ctx: LeakContext) -> list[str]:
    """Full names, and each part of a full name of 4 letters or more (a surname alone
    names a person too)."""
    out: list[str] = []
    for name in ctx.people:
        if not name:
            continue
        out.append(name)
        parts = _WORD.findall(_plain(name))
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
        parts = _WORD.findall(_plain(name))
        if len(parts) > 1:
            out += [p for p in parts if len(p) >= 4 and skeleton(p) not in _GENERIC_SKELETONS]
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
    texts = [f" {form} " for form in _forms(text)]
    out: list[str] = []
    for note in notes:
        run = next((w for p, w in _note_runs(note or "") if any(p.search(t) for t in texts)), None)
        if run:
            out.append(run)
    return out


@functools.lru_cache(maxsize=256)
def _note_runs(note: str) -> tuple[tuple[re.Pattern[str], str], ...]:
    """Each run of NOTE_WORDS words of an internal note: its pattern (:func:`_record_words`)
    and its words on their skeleton."""
    words = _record_words(note)
    runs = (words[i : i + NOTE_WORDS] for i in range(len(words) - NOTE_WORDS + 1))
    return tuple(
        (re.compile(" " + " ".join(p for p, _ in run) + " "), " ".join(w for _, w in run))
        for run in runs
    )


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
    raw = (text or "")[:MAX_TEXT]
    text = normalize(raw)
    out: list[Finding] = []

    def add(code: str, words: list[str]) -> None:
        if words:
            severity = "blocking" if code in BLOCKING else "warning"
            out.append(Finding(code, severity, list(dict.fromkeys(words))))

    emails = [m.group(0) for m in _EMAIL.finditer(text)]
    people = _names(raw, _person_names(ctx))
    folded = text.casefold()
    people += [e for e in ctx.emails if e and _norm_email(e) in folded and e not in emails]
    add("person_name", people)
    phones = [m.group(0).strip() for m in _PHONE.finditer(text)]
    phones = [p for p in phones if sum(c.isdigit() for c in p) >= PHONE_DIGITS]
    add("email_or_phone", emails + phones)
    add("customer_name", _names(raw, _customer_names(ctx)))
    add("alternative_name", _names(raw, ctx.alternatives))
    codes = [m.group(0) for p in (_TRACKER, _GOAL, _DECISION) for m in p.finditer(text)]
    slug_forms = _slug_forms(raw)
    codes += [
        s for s in ctx.slugs if _slug_in(s) and any(_slug_pattern(s).search(f) for f in slug_forms)
    ]
    add("internal_code", codes)
    add("internal_host", _hosts(text, ctx))
    add("internal_document", _names(raw, ctx.hidden_documents))
    add("decision", _names(raw, ctx.decisions))
    add("pricing", _names(raw, ctx.pricing))
    add("internal_note", _note_copies(raw, ctx.notes))

    add(
        "money_or_metric",
        [m.group(0).strip() for p in (_MONEY, _PERCENT) for m in p.finditer(text)],
    )
    allowed = _quarter_months(announced_quarter)
    dates = [m.group(0) for m in _MONTH.finditer(text) if m.group(0)[:3].lower() not in allowed]
    # "may" is a word as well as a month: only "May" with a capital, followed by a day.
    dates = [d for d in dates if d.lower() != "may" or d == "May"]
    add("date", dates + [m.group(0) for m in _ISO_DATE.finditer(text)])
    if internal_title and _norm(internal_title) and _norm(raw) == _norm(internal_title):
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
