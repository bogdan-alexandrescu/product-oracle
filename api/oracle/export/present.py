"""Present mode's deck (``/deck``): built on the export pool in a place of its own, and kept.

Owner decision 2026-10-20 (review of 7ab8fcf): a deck build takes a place
(:func:`oracle.export.offload.place` with ``present=True``: two per person at once, apart
from the person's exports, and one of the company's two places for exports and decks
together). Versions are immutable, so a built deck is kept in this process (an LRU, not the
database) and a repeat request is served from it: no place, no render. Requests for a deck
that is being built wait for that build instead of starting their own.

The key is what the deck shows: the company and the version, the theme as it is now (its
id and when it last changed), :data:`RENDERER`, the dates marked now (a roadmap's
``[unverified]`` markers change as its PRD's bases do), and what the banner reads from
outside the version (the document's title, slug and status, the latest version's number,
the approval, the source's label). Any of them changing builds the deck again.
"""

import asyncio
import hashlib
import sys
from collections import OrderedDict
from collections.abc import Callable, Hashable
from typing import TYPE_CHECKING

from oracle.export import offload
from oracle.export.deck import Deck
from oracle.export.render import ExportVersion

if TYPE_CHECKING:
    from oracle.auth.deps import Principal

# Bump when build_deck shows the same version differently: older decks are not served.
RENDERER = 1
# Roughly what the kept decks may hold, in bytes (least recently used out first). A deck
# above KEPT_BYTES / KEPT_SHARE is not kept at all: it would evict every other one.
KEPT_BYTES = 32 * 1024 * 1024
KEPT_SHARE = 8


def _weight(deck: Deck) -> int:
    """About how many bytes a kept deck holds."""
    strings = [deck.title, deck.slug, deck.status, deck.as_of, deck.banner, deck.css]
    strings += [deck.theme_key or "", deck.theme_name or "", deck.source_label or ""]
    for s in deck.slides:
        strings += [s.heading, s.body_md, s.body_html, s.html, s.notes or "", s.section_key or ""]
        for e in s.expand:
            strings += [e.section_key, e.heading, e.html]
        for row in s.sources:
            strings += [str(v) for v in row]
    return sum(sys.getsizeof(str(v)) for v in strings) + 64 * len(strings) + 512


class Decks:
    """Built decks per key, least recently used out first past ``KEPT_BYTES``."""

    def __init__(self) -> None:
        self.values: OrderedDict[Hashable, tuple[Deck, int]] = OrderedDict()
        self.weight = 0

    def get(self, key: Hashable) -> Deck | None:
        hit = self.values.get(key)
        if hit is None:
            return None
        self.values.move_to_end(key)
        return hit[0]

    def put(self, key: Hashable, deck: Deck) -> bool:
        """Keep ``deck``; False (and nothing evicted) when it is too large to keep."""
        weight = _weight(deck)
        if weight > KEPT_BYTES // KEPT_SHARE:
            return False
        old = self.values.pop(key, None)
        if old is not None:
            self.weight -= old[1]
        self.values[key] = (deck, weight)
        self.weight += weight
        while self.weight > KEPT_BYTES and len(self.values) > 1:
            _, (_, dropped) = self.values.popitem(last=False)
            self.weight -= dropped
        return True


_KEPT = Decks()
# Builds running now, one per key: their requests' waiters are told when each ends.
_building: dict[Hashable, asyncio.Future[None]] = {}


def key(principal: "Principal", ev: ExportVersion) -> Hashable:
    """What the deck of ``ev`` shows, scoped to ``principal``'s company."""
    theme = ev.theme
    marks = hashlib.sha256(repr(ev.date_marks).encode()).hexdigest() if ev.date_marks else ""
    return (
        principal.tenant_id,
        ev.version.id,
        RENDERER,
        (theme.id, theme.updated_at) if theme is not None else None,
        marks,
        (
            ev.title,
            ev.document.slug,
            ev.status,
            ev.latest_number,
            ev.version.approved_at,
            ev.source_label,
        ),
    )


async def deck_for(
    principal: "Principal", ev: ExportVersion, build: Callable[[ExportVersion], Deck]
) -> Deck:
    """The deck of ``ev``: kept, else ``build(ev)`` on the export pool in a Present place
    of ``principal`` (:class:`offload.Refused` when there is none or no worker is free in
    time), kept for the next request. ``ev`` holds no session's rows
    (:func:`oracle.export.render.detached`)."""
    k = key(principal, ev)
    while (deck := _KEPT.get(k)) is None:
        pending = _building.get(k)
        if pending is None:
            break
        # Another request builds it: wait for its end, then read it (or build it, when that
        # build was refused or failed).
        await asyncio.wait({pending})
    if deck is not None:
        return deck
    done = asyncio.get_running_loop().create_future()
    _building[k] = done
    try:
        with offload.place(principal, present=True) as held:
            deck = await offload.run(held, build, ev)
        _KEPT.put(k, deck)
        return deck
    finally:
        if _building.get(k) is done:
            del _building[k]
        done.set_result(None)
