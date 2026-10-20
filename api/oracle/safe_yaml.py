"""The one YAML loader for text Oracle did not write (drafts' front matter, baseline.yaml,
templates, a run's roadmap_items.yaml).

``yaml.safe_load`` is safe from code execution but not from cost: an alias shares its
node, so a few hundred bytes expand to gigabytes once copied to JSON; a YAML 1.1 base-60
integer (``1:1:1...``) is quadratic to build; a few hundred ``[`` overflow the composer's
recursion; Python refuses ``int()`` of more than 4,300 digits. :func:`load` refuses all of
that before a node is built, as a :class:`SafeYamlError` and never any other exception:

- no aliases or anchors, no explicit tags;
- implicit types: null, booleans, plain decimal integers and floats of a bounded length,
  ISO dates and timestamps (no base-60, octal, hex, binary or ``_`` forms: those stay
  strings, ``1:30`` is text); the YAML 1.1 words ``yes/no/on/off`` are booleans only when
  the caller asks (``yaml11_booleans``), else strings;
- duplicate mapping keys are refused (stock YAML keeps the last one silently);
- caps on the text, each value, nesting depth and node count; NaN and infinities refused.

:func:`run_parse` runs a parse (or any CPU-bound check of agent or user text) off the event
loop, on a small dedicated pool, at most ``PARSE_SECONDS``: a bad file is a refusal, never
a stalled event loop.
"""

import asyncio
import math
import re
import threading
from collections.abc import Callable
from concurrent.futures import ThreadPoolExecutor
from typing import Any

import yaml

MAX_TEXT_CHARS = 1_000_000
MAX_SCALAR_CHARS = 20_000
MAX_DEPTH = 32
MAX_NODES = 50_000
MAX_DIGITS = 30
# A parse runs on this pool, at most this long (the whole wait, queue included).
PARSE_SECONDS = 5.0
PARSE_WORKERS = 4


class SafeYamlError(ValueError):
    """The YAML was refused: ``code`` names why, ``line`` is 1-based when known."""

    def __init__(self, code: str, message: str, line: int | None = None) -> None:
        super().__init__(message)
        self.code = code
        self.message = message
        self.line = line


class ParseTimeout(SafeYamlError):
    def __init__(self, name: str, seconds: float) -> None:
        super().__init__(
            "too_slow", f"{name} took more than {seconds:g} s to read; keep it small and plain"
        )


_BOOL_CORE = r"true|True|TRUE|false|False|FALSE"
_BOOL_11 = r"yes|Yes|YES|no|No|NO|on|On|ON|off|Off|OFF"
_INT = re.compile(r"^[-+]?(?:0|[1-9][0-9]{0,17})$")
_FLOAT = re.compile(
    r"^(?:[-+]?(?:[0-9]{1,18}\.[0-9]{0,18}|\.[0-9]{1,18})(?:[eE][-+]?[0-9]{1,3})?"
    r"|[-+]?[0-9]{1,18}[eE][-+]?[0-9]{1,3}"
    r"|[-+]?\.(?:inf|Inf|INF)|\.(?:nan|NaN|NAN))$"
)
_NULL = re.compile(r"^(?:~|null|Null|NULL|)$")
_TIMESTAMP = re.compile(
    r"^(?:[0-9]{4}-[0-9]{2}-[0-9]{2}"
    r"|[0-9]{4}-[0-9]{1,2}-[0-9]{1,2}(?:[Tt]|[ \t]+)[0-9]{1,2}:[0-9]{2}:[0-9]{2}"
    r"(?:\.[0-9]{0,9})?(?:[ \t]*(?:Z|[-+][0-9]{1,2}(?::[0-9]{2})?))?)$"
)
# A plain scalar that looks like a number but has more digits than any count or score.
_NUMBERISH = re.compile(
    r"[-+]?[0-9][0-9_]*(?:\.[0-9_]*)?(?:[eE][-+]?[0-9]+)?|[-+]?[0-9][0-9_]*(?::[0-9_]+)+"
)


def _resolver(yaml11_booleans: bool) -> type[yaml.resolver.BaseResolver]:
    class Resolver(yaml.resolver.BaseResolver):
        pass

    words = f"{_BOOL_CORE}|{_BOOL_11}" if yaml11_booleans else _BOOL_CORE
    Resolver.add_implicit_resolver(
        "tag:yaml.org,2002:bool",
        re.compile(rf"^(?:{words})$"),
        list("yYnNtTfFoO" if yaml11_booleans else "tTfF"),
    )
    Resolver.add_implicit_resolver("tag:yaml.org,2002:int", _INT, list("-+0123456789"))
    Resolver.add_implicit_resolver("tag:yaml.org,2002:float", _FLOAT, list("-+0123456789."))
    Resolver.add_implicit_resolver("tag:yaml.org,2002:null", _NULL, ["~", "n", "N", ""])
    Resolver.add_implicit_resolver("tag:yaml.org,2002:timestamp", _TIMESTAMP, list("0123456789"))
    return Resolver


_RESOLVERS = {flag: _resolver(flag) for flag in (False, True)}


def _loader_class(yaml11_booleans: bool) -> type:
    resolver = _RESOLVERS[yaml11_booleans]

    class Loader(
        yaml.reader.Reader,
        yaml.scanner.Scanner,
        yaml.parser.Parser,
        yaml.composer.Composer,
        yaml.constructor.SafeConstructor,
        resolver,
    ):
        """A safe loader without aliases, anchors, explicit tags or duplicate keys, with
        a node budget and caps on value length and nesting depth, all checked before a
        node is built."""

        def __init__(self, stream: str, limits: "_Limits") -> None:
            yaml.reader.Reader.__init__(self, stream)
            yaml.scanner.Scanner.__init__(self)
            yaml.parser.Parser.__init__(self)
            yaml.composer.Composer.__init__(self)
            yaml.constructor.SafeConstructor.__init__(self)
            resolver.__init__(self)
            self._limits = limits
            self._nodes = 0
            self._depth = 0

        def compose_node(self, parent: Any, index: Any) -> Any:
            lim = self._limits
            event = self.peek_event()
            line = event.start_mark.line + 1 + lim.line_offset
            where = f"{line}:{event.start_mark.column + 1}"
            if isinstance(event, yaml.AliasEvent) or getattr(event, "anchor", None):
                raise SafeYamlError(
                    "yaml_alias",
                    f"{lim.name} uses a YAML anchor or alias ({where}); write each value "
                    "out in full",
                    line,
                )
            if getattr(event, "tag", None) not in (None, "!"):
                raise SafeYamlError(
                    "yaml_tag",
                    f"{lim.name} uses the explicit YAML tag {event.tag} ({where}); write "
                    "plain values",
                    line,
                )
            self._nodes += 1
            if self._nodes > lim.max_nodes:
                raise SafeYamlError(
                    "too_large", f"{lim.name} has more than {lim.max_nodes} YAML nodes", line
                )
            if isinstance(event, yaml.ScalarEvent):
                _check_scalar(event.value, plain=event.implicit[0], where=where, lim=lim, line=line)
                return super().compose_node(parent, index)
            nested = isinstance(event, yaml.SequenceStartEvent | yaml.MappingStartEvent)
            if nested:
                self._depth += 1
                if self._depth > lim.max_depth:
                    raise SafeYamlError(
                        "too_deep",
                        f"{lim.name} nests lists or mappings more than {lim.max_depth} "
                        f"levels deep ({where})",
                        line,
                    )
            try:
                return super().compose_node(parent, index)
            finally:
                if nested:
                    self._depth -= 1

        def construct_mapping(self, node: Any, deep: bool = False) -> Any:
            if isinstance(node, yaml.MappingNode):
                seen: set[Any] = set()
                for key_node, _ in node.value:
                    key = key_node.value if isinstance(key_node, yaml.ScalarNode) else None
                    if key is None:
                        continue
                    ident = (key_node.tag, key)
                    if ident in seen:
                        line = key_node.start_mark.line + 1 + self._limits.line_offset
                        raise SafeYamlError(
                            "duplicate_key",
                            f"{self._limits.name} has the key '{key}' twice in one mapping "
                            f"(line {line}); write it once",
                            line,
                        )
                    seen.add(ident)
            return super().construct_mapping(node, deep=deep)

    return Loader


_LOADERS = {flag: _loader_class(flag) for flag in (False, True)}


class _Limits:
    __slots__ = ("name", "max_scalar_chars", "max_depth", "max_nodes", "line_offset")

    def __init__(
        self, name: str, max_scalar_chars: int, max_depth: int, max_nodes: int, line_offset: int
    ) -> None:
        self.name = name
        self.max_scalar_chars = max_scalar_chars
        self.max_depth = max_depth
        self.max_nodes = max_nodes
        self.line_offset = line_offset


def _check_scalar(value: str, *, plain: bool, where: str, lim: _Limits, line: int) -> None:
    if len(value) > lim.max_scalar_chars:
        raise SafeYamlError(
            "too_large",
            f"{lim.name} has a value of {len(value)} characters ({where}), over "
            f"{lim.max_scalar_chars}",
            line,
        )
    if plain and _NUMBERISH.fullmatch(value) and sum(c.isdigit() for c in value) > MAX_DIGITS:
        raise SafeYamlError(
            "invalid_number",
            f"{lim.name} has a number with more than {MAX_DIGITS} digits ({where})",
            line,
        )


def non_finite(data: Any, path: str = "") -> str | None:
    """The path of the first NaN or infinite number in ``data``, if any."""
    stack: list[tuple[Any, str]] = [(data, path)]
    while stack:
        value, at = stack.pop()
        if isinstance(value, float) and not math.isfinite(value):
            return at or "(top)"
        if isinstance(value, dict):
            stack.extend((v, f"{at}.{k}" if at else str(k)) for k, v in value.items())
        elif isinstance(value, list):
            stack.extend((v, f"{at}[{n}]") for n, v in enumerate(value))
    return None


def load(
    text: str,
    *,
    name: str = "the YAML",
    max_text_chars: int = MAX_TEXT_CHARS,
    max_scalar_chars: int = MAX_SCALAR_CHARS,
    max_depth: int = MAX_DEPTH,
    max_nodes: int = MAX_NODES,
    yaml11_booleans: bool = False,
    line_offset: int = 0,
) -> Any:
    """Parse ``text`` the one safe way. Raises :class:`SafeYamlError` and nothing else: a
    YAML error, and any other failure to read the text (a recursion, a number Python will
    not convert, memory), is a refusal with its code. ``name`` starts every message;
    ``line_offset`` is added to reported lines (front matter starts on line 2)."""
    try:
        if len(text) > max_text_chars:
            raise SafeYamlError(
                "too_large", f"{name} is {len(text)} characters, over {max_text_chars}"
            )
        # Before the YAML reader: an over-long unbroken token (the base-60 probe) is
        # refused in one linear pass instead of being scanned character by character.
        longest = max(map(len, text.split()), default=0)
        if longest > max_scalar_chars:
            raise SafeYamlError(
                "too_large", f"{name} has a value of {longest} characters, over {max_scalar_chars}"
            )
        limits = _Limits(name, max_scalar_chars, max_depth, max_nodes, line_offset)
        loader = _LOADERS[yaml11_booleans](text, limits)
        try:
            data = loader.get_single_data()
        finally:
            loader.dispose()
        bad = non_finite(data)
        if bad is not None:
            raise SafeYamlError(
                "non_finite_number",
                f"{name} has NaN or an infinite number at {bad}; write a finite number",
            )
        return data
    except SafeYamlError:
        raise
    except yaml.YAMLError as exc:
        mark = getattr(exc, "problem_mark", None)
        line = mark.line + 1 + line_offset if mark else None
        raise SafeYamlError("invalid_yaml", f"{name} is not valid YAML: {exc}", line) from exc
    except Exception as exc:  # noqa: BLE001 - untrusted text: every failure is a refusal
        raise SafeYamlError(
            "unreadable_yaml",
            f"{name} could not be read ({type(exc).__name__}: {str(exc)[:200]})",
        ) from exc


class NoAliasDumper(yaml.SafeDumper):
    """A dumper that writes a shared value out in full each time: what Oracle exports must
    load again through :func:`load`, which refuses aliases."""

    def ignore_aliases(self, data: Any) -> bool:
        return True


def dump(data: Any, **kwargs: Any) -> str:
    return yaml.dump(data, Dumper=NoAliasDumper, **kwargs)


# --- off the event loop ----------------------------------------------------------------

_pool: ThreadPoolExecutor | None = None
_pool_lock = threading.Lock()


def _executor() -> ThreadPoolExecutor:
    global _pool
    with _pool_lock:
        if _pool is None:
            _pool = ThreadPoolExecutor(max_workers=PARSE_WORKERS, thread_name_prefix="oracle-parse")
        return _pool


async def run_parse[T](
    fn: Callable[..., T], *args: Any, name: str = "the text", seconds: float | None = None
) -> T:
    """``fn(*args)`` on the parse pool, at most ``seconds`` (``PARSE_SECONDS``): the event
    loop never waits on a parse. Raises :class:`ParseTimeout` when it takes longer; any
    exception ``fn`` raises is re-raised as is."""
    limit = PARSE_SECONDS if seconds is None else seconds
    loop = asyncio.get_running_loop()
    future = loop.run_in_executor(_executor(), lambda: fn(*args))
    try:
        return await asyncio.wait_for(future, timeout=limit)
    except TimeoutError:
        raise ParseTimeout(name, limit) from None
