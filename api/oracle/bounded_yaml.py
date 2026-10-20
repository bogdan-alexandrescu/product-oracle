"""YAML read the one bounded way, for files an agent or a person hands Oracle.

``yaml.safe_load`` shares an alias's node, so a few hundred bytes of anchors and aliases
expand to gigabytes once anything walks the result (the "billion laughs"); a few hundred
``[`` overflow the composer's recursion; YAML 1.1's implicit base-60 and long numbers
make the resolver scan and convert without bound. :func:`load` refuses all of that
before a node is built, the same caps as the roadmap lane's ``roadmap_items.yaml``
loader (oracle.runs.roadmap on that lane): no anchors, aliases or explicit tags; at most
``max_nodes`` nodes, ``MAX_DEPTH`` levels of nesting, ``MAX_SCALAR_CHARS`` per value,
``max_chars`` in all; the implicit types are null, booleans, bounded decimal integers and
floats, ISO dates and timestamps (no octal, hex, base-60 or ``_`` forms: those stay
text). It raises :class:`BoundedYamlError` and nothing else.
"""

import re
from typing import Any

import yaml

MAX_TEXT_CHARS = 1_000_000
MAX_NODES = 50_000
MAX_SCALAR_CHARS = 20_000
MAX_DEPTH = 32
MAX_DIGITS = 30


class BoundedYamlError(ValueError):
    """The YAML was refused before it was expanded: ``code`` names why."""

    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code


class _Resolver(yaml.resolver.BaseResolver):
    """The implicit types allowed, each cheap to build."""


_Resolver.add_implicit_resolver(
    "tag:yaml.org,2002:bool",
    re.compile(r"^(?:yes|Yes|YES|no|No|NO|true|True|TRUE|false|False|FALSE|on|On|ON|off|Off|OFF)$"),
    list("yYnNtTfFoO"),
)
_Resolver.add_implicit_resolver(
    "tag:yaml.org,2002:int", re.compile(r"^[-+]?(?:0|[1-9][0-9]{0,17})$"), list("-+0123456789")
)
_Resolver.add_implicit_resolver(
    "tag:yaml.org,2002:float",
    re.compile(
        r"^(?:[-+]?(?:[0-9]{1,18}\.[0-9]{0,18}|\.[0-9]{1,18})(?:[eE][-+]?[0-9]{1,3})?"
        r"|[-+]?[0-9]{1,18}[eE][-+]?[0-9]{1,3})$"
    ),
    list("-+0123456789."),
)
_Resolver.add_implicit_resolver(
    "tag:yaml.org,2002:null", re.compile(r"^(?:~|null|Null|NULL|)$"), ["~", "n", "N", ""]
)
_Resolver.add_implicit_resolver(
    "tag:yaml.org,2002:timestamp",
    re.compile(
        r"^(?:[0-9]{4}-[0-9]{2}-[0-9]{2}"
        r"|[0-9]{4}-[0-9]{1,2}-[0-9]{1,2}(?:[Tt]|[ \t]+)[0-9]{1,2}:[0-9]{2}:[0-9]{2}"
        r"(?:\.[0-9]{0,9})?(?:[ \t]*(?:Z|[-+][0-9]{1,2}(?::[0-9]{2})?))?)$"
    ),
    list("0123456789"),
)

# A plain scalar that looks like a number but has more digits than any count or score.
_NUMBERISH = re.compile(r"[-+]?[0-9][0-9_:.,eE+-]*")


class _Loader(
    yaml.reader.Reader,
    yaml.scanner.Scanner,
    yaml.parser.Parser,
    yaml.composer.Composer,
    yaml.constructor.SafeConstructor,
    _Resolver,
):
    """A safe loader without aliases, anchors or explicit tags, with the bounded implicit
    types above, a node budget, and caps on scalar length and nesting depth, all checked
    before a node is built."""

    def __init__(self, stream: str, name: str, max_nodes: int) -> None:
        yaml.reader.Reader.__init__(self, stream)
        yaml.scanner.Scanner.__init__(self)
        yaml.parser.Parser.__init__(self)
        yaml.composer.Composer.__init__(self)
        yaml.constructor.SafeConstructor.__init__(self)
        _Resolver.__init__(self)
        self._name = name
        self._max_nodes = max_nodes
        self._nodes = 0
        self._depth = 0

    def compose_node(self, parent: Any, index: Any) -> Any:
        event = self.peek_event()
        where = f"{event.start_mark.line + 1}:{event.start_mark.column + 1}"
        if isinstance(event, yaml.AliasEvent) or getattr(event, "anchor", None):
            raise BoundedYamlError(
                "yaml_alias",
                f"{self._name} uses a YAML anchor or alias ({where}); write each value out in full",
            )
        if getattr(event, "tag", None) not in (None, "!"):
            raise BoundedYamlError(
                "yaml_tag",
                f"{self._name} uses the explicit YAML tag {event.tag} ({where}); write plain "
                "values",
            )
        self._nodes += 1
        if self._nodes > self._max_nodes:
            raise BoundedYamlError(
                "too_large", f"{self._name} has more than {self._max_nodes} YAML nodes"
            )
        if isinstance(event, yaml.ScalarEvent):
            _check_scalar(self._name, event.value, plain=event.implicit[0], where=where)
            return super().compose_node(parent, index)
        nested = isinstance(event, yaml.SequenceStartEvent | yaml.MappingStartEvent)
        if nested:
            self._depth += 1
            if self._depth > MAX_DEPTH:
                raise BoundedYamlError(
                    "too_deep",
                    f"{self._name} nests lists or mappings more than {MAX_DEPTH} levels deep "
                    f"({where})",
                )
        try:
            return super().compose_node(parent, index)
        finally:
            if nested:
                self._depth -= 1


def _check_scalar(name: str, value: str, *, plain: bool, where: str) -> None:
    if len(value) > MAX_SCALAR_CHARS:
        raise BoundedYamlError(
            "too_large",
            f"{name} has a value of {len(value)} characters ({where}), over {MAX_SCALAR_CHARS}",
        )
    if plain and _NUMBERISH.fullmatch(value) and sum(c.isdigit() for c in value) > MAX_DIGITS:
        raise BoundedYamlError(
            "invalid_number", f"{name} has a number with more than {MAX_DIGITS} digits ({where})"
        )


def load(
    text: str,
    *,
    name: str = "the YAML",
    max_chars: int = MAX_TEXT_CHARS,
    max_nodes: int = MAX_NODES,
) -> Any:
    """Parse ``text`` the bounded way (module docstring). Raises :class:`BoundedYamlError`
    and nothing else: a YAML error, and any other failure to read it (a recursion, a
    number Python will not convert, memory), is a refusal with its code."""
    if len(text) > max_chars:
        raise BoundedYamlError("too_large", f"{name} is {len(text)} characters, over {max_chars}")
    # Before the YAML reader: an over-long unbroken token is refused in one linear pass
    # instead of being scanned character by character.
    longest = max(map(len, text.split()), default=0)
    if longest > MAX_SCALAR_CHARS:
        raise BoundedYamlError(
            "too_large", f"{name} has a value of {longest} characters, over {MAX_SCALAR_CHARS}"
        )
    loader = _Loader(text, name, max_nodes)
    try:
        return loader.get_single_data()
    except BoundedYamlError:
        raise
    except yaml.YAMLError as exc:
        raise BoundedYamlError("invalid_yaml", str(exc)) from None
    except (RecursionError, MemoryError, ValueError, OverflowError) as exc:
        raise BoundedYamlError(
            "invalid_yaml", f"{name} could not be read ({type(exc).__name__})"
        ) from None
    finally:
        loader.dispose()
