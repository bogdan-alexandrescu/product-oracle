"""Present mode's deck (``/deck``): built on the export pool in a place of its own, and kept.

Owner decision 2026-10-20 (review of 7ab8fcf): a deck build takes a place
(:func:`oracle.export.offload.place` with ``present=True``: two per person at once, apart
from the person's exports, and one of the company's two places for exports and decks
together). Versions are immutable, so a built deck is kept in this process (an LRU, not the
database) and a repeat request is served from it: no place, no render. Requests for a deck
that is being built wait for that build instead of starting their own, and answer as it
ended (review of PR #134, 2026-10-21: a failed build is not built again by each of them in
turn).

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

from fastapi import HTTPException, status

from oracle.export import offload
from oracle.export.deck import Deck
from oracle.export.render import ExportVersion, brand_dark

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
# Builds running now, one per key: whose request builds it, and how it ended (its deck,
# what it raised, None when its request was cancelled), for the requests waiting for it.
_building: dict[Hashable, tuple[Hashable, asyncio.Future[Deck | Exception | None]]] = {}


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
        # O5: a new logo, name or accent shows at once, and so does the other logo when
        # the theme's background turns dark or light.
        (ev.brand.key, brand_dark(ev)) if ev.brand is not None else None,
        (
            ev.title,
            ev.document.slug,
            ev.status,
            ev.latest_number,
            ev.version.approved_at,
            ev.source_label,
        ),
    )


def _again(ended: Exception) -> Exception:
    """The refusal or error a waiter answers when the build it waited for ended in
    ``ended`` (a copy: one exception is not raised in several requests at once)."""
    if isinstance(ended, offload.Refused):
        return offload.Refused(ended.status_code, ended.code, ended.message)
    if isinstance(ended, HTTPException):
        return HTTPException(ended.status_code, ended.detail, ended.headers)
    return HTTPException(status.HTTP_500_INTERNAL_SERVER_ERROR, "Internal Server Error")


async def deck_for(
    principal: "Principal", ev: ExportVersion, build: Callable[[ExportVersion], Deck]
) -> Deck:
    """The deck of ``ev``: kept, else ``build(ev)`` on the export pool in a Present place
    of ``principal`` (:class:`offload.Refused` when there is none or no worker is free in
    time), kept for the next request. ``ev`` holds no session's rows
    (:func:`oracle.export.render.detached`).

    A request for a deck that is being built waits for that build and answers as it ended:
    its deck, or the same refusal or error (it never builds a deck that just failed again).
    Two endings let a waiter build it in a place of its own: the builder's person had no
    Present place left (``present_busy_you``, when the waiter is another person), or the
    builder's request was cancelled (the first waiter to wake builds it, the others wait
    for that build)."""
    k = key(principal, ev)
    person = offload.person_of(principal)
    while (deck := _KEPT.get(k)) is None:
        pending = _building.get(k)
        if pending is None:
            break
        builder, built = pending
        await asyncio.wait({built})
        outcome = built.result()
        if isinstance(outcome, Deck):
            return outcome  # built, even when too large to keep
        if outcome is None:
            continue  # its request went away before it ended
        if (
            isinstance(outcome, offload.Refused)
            and outcome.code == "present_busy_you"
            and builder != person
        ):
            continue  # the builder's person's share, not this one's
        raise _again(outcome) from None
    if deck is not None:
        return deck
    done: asyncio.Future[Deck | Exception | None] = asyncio.get_running_loop().create_future()
    entry = _building[k] = (person, done)
    ended: Deck | Exception | None = None  # None: cancelled
    try:
        with offload.place(principal, present=True) as held:
            deck = await offload.run(held, build, ev)
        _KEPT.put(k, deck)
        ended = deck
        return deck
    except Exception as exc:
        ended = exc
        raise
    finally:
        if _building.get(k) is entry:
            del _building[k]
        done.set_result(ended)
