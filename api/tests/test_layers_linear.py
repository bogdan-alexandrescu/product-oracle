"""Comment and notes stripping is linear and matches the regexes it replaced."""

import random
import re
import time

from oracle.docs import layers

_OLD_COMMENT = re.compile(r"<!--(.*?)-->", re.S)
_OLD_NOTES = re.compile(r"^```[ \t]*notes[ \t]*\n(.*?)^```[ \t]*$\n?", re.S | re.M)
_PIECES = [
    "<!--",
    "-->",
    "--",
    "<!-",
    "```notes\n",
    "``` notes \n",
    "```\n",
    "```",
    "``` \n",
    "\n",
    "x",
    " ",
    "\t",
    "a b\n",
    "```note\n",
    "\r\n",
    ">",
]


def _old_slide_body(text: str) -> str:
    return _OLD_COMMENT.sub("", _OLD_NOTES.sub("", text)).strip("\n")


def _old_notes(text: str) -> str | None:
    found = [m.group(1).strip() for m in _OLD_NOTES.finditer(text)]
    found = [f for f in found if f]
    return "\n\n".join(found) if found else None


def test_the_same_result_as_the_regexes_on_random_bodies():
    rng = random.Random(20261020)
    for _ in range(5000):
        text = "".join(rng.choice(_PIECES) for _ in range(rng.randint(0, 30)))
        assert layers.strip_comments(text) == _OLD_COMMENT.sub("", text), repr(text)
        assert layers.slide_body(text) == _old_slide_body(text), repr(text)
        assert layers.notes_block(text) == _old_notes(text), repr(text)


def test_many_unclosed_openers_are_linear():
    for body in ("x " + "<!--" * 262_144, "```notes\n" * 116_508):
        started = time.monotonic()
        layers.slide_body(body)
        layers.notes_block(body)
        layers.linked_sections(body)
        assert time.monotonic() - started < 2
