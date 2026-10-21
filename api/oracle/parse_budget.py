"""A CPU budget for parsing untrusted markdown, enforced inside markdown-it.

markdown-it-py is pure Python and some text costs it far more per character than prose
(measured on 200 KB: '![' repeated 3.1 s, '[' 1.9 s, '[[[[a]]]] ' 1.2 s, prose 0.01 s). That
cost is linear in the whole text, not in one paragraph (the '![' text takes as long in one
paragraph as in 19 KB paragraphs), so no line or paragraph cap bounds it. Instead every
markdown-it parser that reads untrusted text is :func:`guard`-ed: a rule
first in its block and inline chains, and its link-label scan (``skipToken``), check the
budget as the parse runs and stop it with :class:`Exceeded` once the thread has used the
CPU time it was given. The parse ends within a few milliseconds of its cap, so it can not
hold a slot of the parse pool (:func:`oracle.safe_yaml.run_parse_within`) any longer.

The budget is CPU time of the parsing thread (``time.thread_time``), counted from the
moment the parse starts: neither a queue wait nor other threads' load on the machine uses
it, so an honest parse is not refused because others are slow. Without a budget
(:func:`limit` not entered) a guarded parser runs unbounded, as markdown-it does.
"""

import time
from collections.abc import Iterator
from contextlib import contextmanager
from contextvars import ContextVar
from typing import Any

from markdown_it import MarkdownIt


class Exceeded(Exception):  # noqa: N818 - read as parse_budget.Exceeded
    """The parse used up its CPU budget. Not a ValueError: nothing inside a parse that
    catches bad input (DraftError, SafeYamlError) may swallow it."""


# The thread CPU time (time.thread_time) after which a guarded parse stops.
_deadline: ContextVar[float | None] = ContextVar("parse_budget_deadline", default=None)
# How often the guards read the clock: every this many calls (a power of two).
_EVERY = 32
_calls = 0


def active() -> bool:
    """A budget is in force here."""
    return _deadline.get() is not None


@contextmanager
def limit(seconds: float) -> Iterator[None]:
    """Within the block, a guarded parse on this thread stops (:class:`Exceeded`) once the
    thread has used ``seconds`` of CPU time from now. An enclosing budget still applies:
    the earlier deadline wins."""
    deadline = time.thread_time() + seconds
    outer = _deadline.get()
    token = _deadline.set(deadline if outer is None else min(outer, deadline))
    try:
        yield
    finally:
        _deadline.reset(token)


def check() -> None:
    """Raise :class:`Exceeded` when this thread is past the budget in force."""
    deadline = _deadline.get()
    if deadline is not None and time.thread_time() > deadline:
        raise Exceeded


def _tick() -> None:
    # The count is shared by every thread (a lost update only moves a check by a call).
    global _calls
    _calls += 1
    if not _calls & (_EVERY - 1):
        check()


def _block_guard(state: Any, start: int, end: int, silent: bool) -> bool:
    _tick()
    return False


def _inline_guard(state: Any, silent: bool) -> bool:
    _tick()
    return False


def guard(md: MarkdownIt) -> MarkdownIt:
    """``md`` with the budget checked as it parses: once per line its block parser tries,
    once per position its inline parser tries, and once per step of a link or image label
    scan (where the cost of '[' and '![' runs is). Returns ``md``."""
    md.block.ruler.before(md.block.ruler.get_all_rules()[0], "oracle_budget", _block_guard)
    md.inline.ruler.before(md.inline.ruler.get_all_rules()[0], "oracle_budget", _inline_guard)
    skip = md.inline.skipToken

    def skip_token(state: Any) -> None:
        _tick()
        skip(state)

    md.inline.skipToken = skip_token  # type: ignore[method-assign]
    return md
