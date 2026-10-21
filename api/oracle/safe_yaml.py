"""YAML for untrusted text: drafts' front matter, baseline.yaml, template bodies, run files.

The stock ``yaml.safe_load`` constructs no Python objects but is not cheap: a YAML 1.1
base-60 number (``n: 1:1:1:...``) is quadratic to build, a thousand ``[`` exhaust the
recursion limit, and anchors expand into billions of nodes. :func:`load` is a
``safe_load`` without those:

* anchors and aliases, explicit tags (``!x``, ``!!binary``, ``!<...>``) and directives
  (``%TAG``, ``%YAML``) are refused;
* numbers are plain decimals only (``42``, ``-1.5``, ``2.5e+3``): base-60 (``1:30``),
  hex, octal and ``1_000`` stay strings, as does ``1e5`` (no dot: a string in YAML 1.1
  too); ``.nan``, ``.inf`` and values that overflow (``1.0e+999``) are refused, and so is
  a number of more than 30 digits;
* booleans are ``true``/``false`` only: ``yes``, ``no``, ``on`` and ``off`` stay strings;
* duplicate keys and non-printable characters are refused;
* the input is at most ``ORACLE_YAML_MAX_BYTES`` (1 MiB), nested at most 32 deep, with
  at most 50,000 nodes and scalars of at most 256 KiB.

Every failure, including a ``RecursionError``/``ValueError``/``OverflowError`` from
inside the loader, is one :class:`SafeYamlError` (a ``yaml.YAMLError``) whose ``problem``
says what is wrong and whose ``code`` names it for a problem list (``duplicate_key``,
``too_large``...). :func:`run_parse` runs a parse on a small dedicated thread pool, so a
slow one never blocks the event loop; :func:`run_parse_within` also caps it at
``PARSE_SECONDS`` from the moment it starts (a run's roadmap files, a draft, a spec edit),
refused as a :class:`ParseTimeout`.
"""

import asyncio
import contextlib
import contextvars
import functools
import math
import re
import threading
import time
from collections.abc import Callable, Iterator
from concurrent.futures import ThreadPoolExecutor
from typing import Any

import yaml
from yaml.composer import Composer
from yaml.constructor import SafeConstructor
from yaml.events import AliasEvent, DocumentStartEvent, ScalarEvent
from yaml.nodes import MappingNode
from yaml.resolver import Resolver

from oracle import parse_budget

try:  # libyaml's event parser: the same events, much faster than the pure-Python one.
    from yaml.cyaml import CParser as _EventParser

    _PARSER_BASES: tuple[type, ...] = (_EventParser,)
except ImportError:  # pragma: no cover - PyYAML built without libyaml
    from yaml.parser import Parser
    from yaml.reader import Reader
    from yaml.scanner import Scanner

    _PARSER_BASES = (Reader, Scanner, Parser)

DEFAULT_MAX_BYTES = 1024 * 1024
MAX_DEPTH = 32
MAX_NODES = 50_000
MAX_SCALAR_CHARS = 256 * 1024
MAX_DIGITS = 30
# run_parse_within's cap on one parse: this much CPU time of its markdown parses
# (oracle.parse_budget), counted from the moment the parse starts; a queue wait does not
# count. As a backstop for anything else, the caller stops waiting WALL_FACTOR times this
# long after the parse started (the worker thread is not freed by that: it runs to its end).
PARSE_SECONDS = 5.0
WALL_FACTOR = 4
# Owner decision 2026-10-20: a parse that waits more than QUEUE_SECONDS for a free worker is
# refused (ParseBusy 503), and one person (the principal's user id; a run token's run) has at
# most MAX_PER_OWNER parses running or queued: a further one is refused at once (429).
QUEUE_SECONDS = 10.0
MAX_PER_OWNER = 2

# What YAML's reader accepts (tab, LF, CR and printable Unicode); anything else is refused,
# in the input and in the value of an escaped ("\x00") double-quoted scalar.
_NON_PRINTABLE = re.compile("[^\x09\x0a\x0d\x20-\x7e\x85\xa0-퟿-�\U00010000-\U0010ffff]")
_INT = re.compile(r"^[-+]?(?:0|[1-9][0-9]*)$")
# YAML 1.1's decimal float (a dot; an exponent has a sign), as yaml.safe_load reads it:
# so whatever yaml.safe_dump wrote unquoted as a string (1e5) is still a string here.
_FLOAT = re.compile(r"^[-+]?(?:[0-9]+\.[0-9]*|\.[0-9]+)(?:[eE][-+][0-9]+)?$")
_SPECIAL_FLOAT = re.compile(r"^[-+]?\.(?:inf|Inf|INF|nan|NaN|NAN)$")
_INT_TAG = "tag:yaml.org,2002:int"
_FLOAT_TAG = "tag:yaml.org,2002:float"


class SafeYamlError(yaml.YAMLError):
    """Text :func:`load` refuses. ``problem`` says why; ``problem_mark`` (when known)
    is where, 0-based like PyYAML's marks; ``code`` names the refusal for a problem list."""

    def __init__(
        self,
        problem: str,
        mark: Any = None,
        *,
        show_mark: bool = True,
        code: str = "invalid_yaml",
    ):
        self.problem = problem
        self.code = code
        self.problem_mark = mark
        self._show_mark = show_mark
        super().__init__(problem)

    @property
    def line(self) -> int | None:
        """1-based line of the problem in the YAML text, when known."""
        return self.problem_mark.line + 1 if self.problem_mark is not None else None

    def __str__(self) -> str:
        if self._show_mark and self.problem_mark is not None:
            return (
                f"{self.problem} (line {self.problem_mark.line + 1}, "
                f"column {self.problem_mark.column + 1})"
            )
        return self.problem


class _LimitedComposer(Composer):
    """Builds the node tree, refusing what :func:`load` refuses before it costs anything."""

    def __init__(self) -> None:
        super().__init__()
        self._depth = 0
        self._nodes = 0

    def compose_document(self):
        event = self.peek_event()
        if isinstance(event, DocumentStartEvent) and (event.version or event.tags):
            raise SafeYamlError(
                "YAML directives (%YAML, %TAG) are not allowed", event.start_mark, code="yaml_tag"
            )
        return super().compose_document()

    def compose_node(self, parent, index):
        event = self.peek_event()
        if isinstance(event, AliasEvent) or event.anchor is not None:
            raise SafeYamlError(
                "anchors and aliases (&, *) are not allowed", event.start_mark, code="yaml_alias"
            )
        if event.tag is not None:
            raise SafeYamlError(
                f"tags are not allowed (found {event.tag!r})", event.start_mark, code="yaml_tag"
            )
        self._nodes += 1
        if not self._nodes % 128:
            time.sleep(0)  # let other threads (the event loop) take the GIL
        if self._nodes > MAX_NODES:
            raise SafeYamlError(f"more than {MAX_NODES} values", event.start_mark, code="too_large")
        if isinstance(event, ScalarEvent):
            _check_scalar(event)
        else:
            self._depth += 1
            if self._depth > MAX_DEPTH:
                raise SafeYamlError(
                    f"nested more than {MAX_DEPTH} levels deep", event.start_mark, code="too_deep"
                )
        node = super().compose_node(parent, index)
        if not isinstance(event, ScalarEvent):
            self._depth -= 1
        return node


def _check_scalar(event: ScalarEvent) -> None:
    value = event.value
    if len(value) > MAX_SCALAR_CHARS:
        raise SafeYamlError(
            f"a value is longer than {MAX_SCALAR_CHARS} characters",
            event.start_mark,
            code="too_large",
        )
    if _NON_PRINTABLE.search(value):
        raise SafeYamlError(
            "a value contains a non-printable character", event.start_mark, code="non_printable"
        )
    if event.implicit[0] and _SPECIAL_FLOAT.match(value):
        raise SafeYamlError(
            f"{value} is not allowed: numbers must be finite",
            event.start_mark,
            code="non_finite_number",
        )


class _LimitedConstructor(SafeConstructor):
    def __init__(self) -> None:
        super().__init__()
        self._built = 0

    def construct_object(self, node, deep=False):
        self._built += 1
        if not self._built % 128:
            time.sleep(0)  # let other threads (the event loop) take the GIL
        return super().construct_object(node, deep=deep)

    def construct_mapping(self, node, deep=False):
        if isinstance(node, MappingNode):
            seen: set[Any] = set()
            for key_node, _ in node.value:
                key = self.construct_object(key_node, deep=True)
                try:
                    duplicate = key in seen
                    seen.add(key)
                except TypeError:
                    continue  # unhashable: SafeConstructor reports it
                if duplicate:
                    raise SafeYamlError(
                        f"duplicate key {repr(key)[:80]}", key_node.start_mark, code="duplicate_key"
                    )
        return super().construct_mapping(node, deep=deep)

    def construct_yaml_int(self, node):
        return int(_number_text(node))

    def construct_yaml_float(self, node):
        value = float(_number_text(node))
        if not math.isfinite(value):
            raise SafeYamlError(
                f"{node.value} is out of range for a number",
                node.start_mark,
                code="non_finite_number",
            )
        return value


def _number_text(node) -> str:
    text = node.value
    if sum(c.isdigit() for c in text) > MAX_DIGITS:
        raise SafeYamlError(
            f"a number has more than {MAX_DIGITS} digits", node.start_mark, code="invalid_number"
        )
    return text


_LimitedConstructor.add_constructor(_INT_TAG, _LimitedConstructor.construct_yaml_int)
_LimitedConstructor.add_constructor(_FLOAT_TAG, _LimitedConstructor.construct_yaml_float)


class _LimitedResolver(Resolver):
    """YAML 1.1's implicit types, narrowed: no yes/no/on/off, no base-60/hex/octal, no
    merge (``<<``) or value (``=``) keys."""

    yaml_implicit_resolvers: dict = {}


_LimitedResolver.add_implicit_resolver(
    "tag:yaml.org,2002:bool",
    re.compile(r"^(?:true|True|TRUE|false|False|FALSE)$"),
    list("tTfF"),
)
_LimitedResolver.add_implicit_resolver(_INT_TAG, _INT, list("-+0123456789"))
_LimitedResolver.add_implicit_resolver(_FLOAT_TAG, _FLOAT, list("-+0123456789."))
_LimitedResolver.add_implicit_resolver(
    "tag:yaml.org,2002:null", re.compile(r"^(?:~|null|Null|NULL|)$"), ["~", "n", "N", ""]
)
# Dates and times, as yaml.safe_load reads them (front matter's retrieved_at, milestones).
for _first, _resolvers in Resolver.yaml_implicit_resolvers.items():
    for _tag, _regexp in _resolvers:
        if _tag == "tag:yaml.org,2002:timestamp":
            _LimitedResolver.yaml_implicit_resolvers.setdefault(_first, []).append((_tag, _regexp))


class SafeYamlLoader(_LimitedComposer, *_PARSER_BASES, _LimitedConstructor, _LimitedResolver):
    def __init__(self, stream: str):
        # CParser(stream), or Reader(stream), Scanner(), Parser().
        _PARSER_BASES[0].__init__(self, stream)
        for base in _PARSER_BASES[1:]:  # pragma: no cover - pure-Python parser
            base.__init__(self)
        _LimitedComposer.__init__(self)
        _LimitedConstructor.__init__(self)
        _LimitedResolver.__init__(self)


def max_bytes() -> int:
    """The largest YAML text :func:`load` reads (``ORACLE_YAML_MAX_BYTES``)."""
    from oracle.config import get_settings

    return get_settings().yaml_max_bytes


def load(text: str, *, limit: int | None = None) -> Any:
    """Parse one YAML document from ``text``; raise :class:`SafeYamlError` on anything
    unsafe or invalid. ``limit`` overrides the size cap in bytes (UTF-8)."""
    cap = max_bytes() if limit is None else limit
    try:
        size = len(text.encode("utf-8"))
    except UnicodeEncodeError:
        raise SafeYamlError("the text is not valid Unicode") from None
    if size > cap:
        raise SafeYamlError(f"the YAML is larger than {cap} bytes ({size} bytes)", code="too_large")
    bad = _NON_PRINTABLE.search(text)
    if bad:
        line = text.count("\n", 0, bad.start()) + 1
        raise SafeYamlError(
            f"non-printable character {bad.group()!r} on line {line} is not allowed",
            code="non_printable",
        )
    loader = SafeYamlLoader(text)
    try:
        return loader.get_single_data()
    except SafeYamlError:
        raise
    except yaml.YAMLError as exc:
        error = SafeYamlError(str(exc), show_mark=False)
        error.problem_mark = getattr(exc, "problem_mark", None)
        raise error from None
    except RecursionError:
        raise SafeYamlError(f"nested more than {MAX_DEPTH} levels deep", code="too_deep") from None
    except (ValueError, OverflowError, TypeError, ArithmeticError) as exc:
        raise SafeYamlError(f"a value could not be read: {str(exc)[:200]}") from None
    except Exception as exc:  # noqa: BLE001 - one error type for every failure
        raise SafeYamlError(
            f"the YAML could not be read: {type(exc).__name__}", code="unreadable_yaml"
        ) from None
    finally:
        loader.dispose()


class NoAliasDumper(yaml.SafeDumper):
    """Writes a shared value out in full each time: what Oracle exports (baseline.yaml)
    must load again through :func:`load`, which refuses aliases."""

    def ignore_aliases(self, data: Any) -> bool:
        return True


def dump(data: Any, **kwargs: Any) -> str:
    """``yaml.safe_dump`` without anchors or aliases."""
    return yaml.dump(data, Dumper=NoAliasDumper, **kwargs)


# --- off the event loop -----------------------------------------------------------------

_EXECUTOR = ThreadPoolExecutor(max_workers=4, thread_name_prefix="safe-yaml")


async def run_parse[T](fn: Callable[..., T], /, *args: Any, **kwargs: Any) -> T:
    """``fn(*args, **kwargs)`` on the parse pool (4 threads), so a slow parse of untrusted
    text never stalls other requests. Exceptions propagate unchanged."""
    ctx = contextvars.copy_context()
    call = functools.partial(ctx.run, fn, *args, **kwargs)
    return await asyncio.get_running_loop().run_in_executor(_EXECUTOR, call)


# Who the parses of this request/tick count against (set by oracle.auth.deps.get_principal and
# the run tick); None: not limited per person.
PARSE_OWNER: contextvars.ContextVar[str | None] = contextvars.ContextVar(
    "parse_owner", default=None
)
_active: dict[str, int] = {}


@contextlib.contextmanager
def parse_owner(key: str | None) -> Iterator[None]:
    """Within the block, parses count against ``key`` (see :data:`MAX_PER_OWNER`)."""
    token = PARSE_OWNER.set(key)
    try:
        yield
    finally:
        PARSE_OWNER.reset(token)


class ParseBusy(Exception):  # noqa: N818 - read as safe_yaml.ParseBusy
    """The parse pool would not take this parse now. Not a SafeYamlError: it says nothing
    about the text, so nothing may report it as a bad file. ``status`` is the HTTP answer
    (429: this person already has :data:`MAX_PER_OWNER` parses; 503: no free worker within
    :data:`QUEUE_SECONDS`); a run tick that gets it gives up for this tick and retries on the
    next."""

    _WHAT = {
        "parse_busy_you": (
            429,
            "Another import of yours is still being checked. Try again when it finishes.",
        ),
        "parse_busy": (
            503,
            "Oracle is busy checking other imports. Try again in a moment.",
        ),
    }

    def __init__(self, code: str) -> None:
        self.code = code
        self.status, self.message = self._WHAT[code]
        super().__init__(self.message)


class ParseTimeout(SafeYamlError):
    """:func:`run_parse_within` gave up: the parse took longer than its time cap."""

    def __init__(self, name: str, seconds: float) -> None:
        super().__init__(
            f"{name} took more than {seconds:g} s to read; keep it small and plain",
            code="too_slow",
        )


async def run_parse_within[T](
    fn: Callable[..., T],
    /,
    *args: Any,
    name: str = "the text",
    seconds: float | None = None,
    **kwargs: Any,
) -> T:
    """:func:`run_parse`, capped at ``seconds`` (``PARSE_SECONDS``) from the moment the
    parse starts on the pool: a run's file, a draft or an edit too slow to read is a refusal
    (:class:`ParseTimeout`, ``name`` starts its message), never a stalled tick.

    The cap is CPU time of its markdown parses (:mod:`oracle.parse_budget`): a parse past
    it stops at its next check (a few milliseconds past the cap, once the parse is between
    two steps), so the worker is freed then. Waiting for a free worker does not count against
    that cap (the queue has its own, below). The checks run inside markdown-it and in the
    per-block loops of the draft parser; a single regex call is not interruptible (Python
    holds the GIL for its whole run), so every regex that reads untrusted text must be linear
    (``tests/test_quadratic_regex.py``). As a backstop for work outside those checks, the
    *caller* stops waiting ``WALL_FACTOR`` times the cap after the parse started: the caller
    is refused at that point, but the worker thread keeps running the parse to its end and is
    not freed (a thread can not be killed). The pool can therefore still be held by work no
    check reaches; this bounds the caller's wait, not the worker's time.

    Queue policy (owner, 2026-10-20): at most :data:`MAX_PER_OWNER` parses per person running
    or queued (:class:`ParseBusy` 429 beyond), and a wait of more than :data:`QUEUE_SECONDS`
    for a free worker is :class:`ParseBusy` 503."""
    limit = PARSE_SECONDS if seconds is None else seconds
    owner = PARSE_OWNER.get()
    if owner is not None:
        if _active.get(owner, 0) >= MAX_PER_OWNER:
            raise ParseBusy("parse_busy_you")
        _active[owner] = _active.get(owner, 0) + 1
    loop = asyncio.get_running_loop()
    started = loop.create_future()
    abandoned = threading.Event()

    def mark_started() -> None:
        if not started.done():
            started.set_result(None)

    def job() -> T:
        if abandoned.is_set():  # its caller gave up while it was queued
            raise ParseBusy("parse_busy")
        loop.call_soon_threadsafe(mark_started)
        with parse_budget.limit(limit):
            return fn(*args, **kwargs)

    def release(_: object) -> None:
        # The slot is free when the parse is over (or never began), not when its caller
        # stops waiting: a worker still running a parse is still that person's.
        if owner is not None:
            left = _active.get(owner, 1) - 1
            if left > 0:
                _active[owner] = left
            else:
                _active.pop(owner, None)

    parse = asyncio.ensure_future(run_parse(job))
    parse.add_done_callback(release)
    # An abandoned parse's outcome is read, never reported as unretrieved.
    parse.add_done_callback(lambda f: f.cancelled() or f.exception())
    try:
        # QUEUE-WAIT POLICY (owner, 2026-10-20): a parse that waits more than QUEUE_SECONDS
        # for a free worker is refused (503); the wait for a worker is otherwise not
        # counted against the parse's own CPU cap.
        await asyncio.wait(
            {started, parse}, timeout=QUEUE_SECONDS, return_when=asyncio.FIRST_COMPLETED
        )
        if not started.done() and not parse.done():
            abandoned.set()
            parse.cancel()
            raise ParseBusy("parse_busy")
        return await asyncio.wait_for(asyncio.shield(parse), timeout=limit * WALL_FACTOR)
    except (TimeoutError, parse_budget.Exceeded):
        raise ParseTimeout(name, limit) from None
