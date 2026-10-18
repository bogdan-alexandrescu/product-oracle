"""How ``oracle accounts`` prints the Claude account pool, and nothing it fetches.

Ported from SwarmCloud's ``apps/swarm-mcp/swarm_mcp/render.py`` (``render_accounts``
and the formatters under it). The columns are ``cs status``'s: ACCOUNT | 5H USED |
7D USED | CLEARS | STATE, and the three marks are its whole vocabulary:

    12%     a measurement, recent enough to trust
    ~12%    the last measurement, too old to trust -- a projection, not a fact
    —       not measured (``--`` on a terminal that cannot draw an em dash)

Never 0 for unknown: "used none of its quota" and "nobody has asked" are different
claims. A table that is too wide drops whole columns (CLEARS first) rather than wrapping.
"""

from __future__ import annotations

from collections.abc import Iterable, Sequence
from dataclasses import dataclass
from datetime import datetime
from typing import Any


@dataclass(frozen=True)
class Style:
    width: int = 80
    unicode: bool = True

    MIN_WIDTH = 32

    @property
    def usable(self) -> int:
        return max(self.MIN_WIDTH, self.width)

    @property
    def dash(self) -> str:
        """The mark for "not measured". Never a zero, never an empty cell."""
        return "—" if self.unicode else "--"

    @property
    def filled(self) -> str:
        return "▰" if self.unicode else "#"

    @property
    def empty(self) -> str:
        return "▱" if self.unicode else "."

    @property
    def ellipsis(self) -> str:
        return "…" if self.unicode else "..."

    @property
    def sep(self) -> str:
        return " · " if self.unicode else " - "


@dataclass(frozen=True)
class Reading:
    key: str
    utilization: float | None = None
    resets_at: Any = None
    reset: bool = False
    stale: bool = True

    @property
    def known(self) -> bool:
        return self.utilization is not None

    @property
    def trusted(self) -> bool:
        """A reset window's reading describes a window that is over: a projection."""
        return self.known and not self.stale and not self.reset


def parse_time(value: Any) -> datetime | None:
    if isinstance(value, datetime):
        return value
    if isinstance(value, str) and value:
        try:
            return datetime.fromisoformat(value.replace("Z", "+00:00"))
        except ValueError:
            return None
    return None


def _span(seconds: float) -> str:
    seconds = int(seconds)
    if seconds < 60:
        return "<1m"
    minutes, hours = seconds // 60, seconds // 3600
    if hours < 1:
        return f"{minutes}m"
    if hours < 24:
        return f"{hours}h {minutes % 60:02d}m"
    days = hours // 24
    return f"{days}d {hours % 24:02d}h"


def format_until(value: Any, now: datetime, style: Style) -> str:
    """How long until ``value``; ``cleared`` once it is in the past."""
    when = parse_time(value)
    if when is None:
        return style.dash
    delta = (when - now).total_seconds()
    if delta <= 0:
        return "cleared"
    return _span(delta)


def account_is_stale(account: dict[str, Any]) -> bool:
    """Absent provenance is stale provenance."""
    if account.get("observed_at") is None:
        return True
    flag = account.get("stale")
    return True if flag is None else bool(flag)


def read_window(account: dict[str, Any], key: str) -> Reading:
    windows = account.get("windows")
    entry = windows.get(key) if isinstance(windows, dict) else None
    stale = account_is_stale(account)
    if not isinstance(entry, dict):
        return Reading(key=key, stale=stale)
    raw = entry.get("utilization")
    util = None
    if raw is not None:  # `is None`, not falsiness: 0.0 is a measurement
        try:
            util = float(raw)
        except (TypeError, ValueError):
            util = None
    return Reading(
        key=key,
        utilization=util,
        resets_at=entry.get("resets_at"),
        reset=bool(entry.get("reset")),
        stale=stale,
    )


_WINDOW_HEADINGS = {
    "five_hour": "5H",
    "session": "5H",
    "5h": "5H",
    "seven_day": "7D",
    "weekly": "7D",
    "weekly_all": "7D",
    "7d": "7D",
}
_SHORT_KEYS = ("five_hour", "session", "5h")
_LONG_KEYS = ("seven_day", "weekly", "weekly_all", "7d")


def window_heading(key: str) -> str:
    return _WINDOW_HEADINGS.get(key, key.replace("_", " ").upper()[:7])


def window_keys(accounts: Iterable[dict[str, Any]]) -> tuple[str | None, str | None]:
    """The two window keys this pool reports, 5H and 7D first when present."""
    ordered: list[str] = []
    for account in accounts:
        windows = account.get("windows")
        if isinstance(windows, dict):
            for key in windows:
                if key not in ordered:
                    ordered.append(key)
    if not ordered:
        return None, None
    short = next((k for k in _SHORT_KEYS if k in ordered), None)
    long = next((k for k in _LONG_KEYS if k in ordered), None)
    rest = [k for k in ordered if k not in (short, long)]
    if short is None:
        short = rest.pop(0) if rest else None
    if long is None:
        long = rest.pop(0) if rest else None
    return short, long


def format_percent(reading: Reading, style: Style) -> str:
    if not reading.known:
        return style.dash
    assert reading.utilization is not None
    pct = f"{round(reading.utilization * 100)}%"
    return pct if reading.trusted else f"~{pct}"


def format_bar(reading: Reading, style: Style, cells: int = 5) -> str:
    if not reading.known:
        return ""
    assert reading.utilization is not None
    filled = min(cells, max(0, int(round(reading.utilization * cells))))
    if filled == 0 and reading.utilization > 0:
        filled = 1
    return style.filled * filled + style.empty * (cells - filled)


def format_window(reading: Reading, style: Style) -> str:
    if not reading.known:
        return f"{style.dash:>5}"
    return f"{format_percent(reading, style):>5}  {format_bar(reading, style)}"


def binding_window(readings: Sequence[Reading]) -> Reading | None:
    """The window that will stop this account first: the fullest known one."""
    known = [r for r in readings if r.known]
    if not known:
        return None
    return max(known, key=lambda r: r.utilization or 0.0)


_STATE_TEXT = {
    "AVAILABLE": "available",
    "PAUSED": "paused",
    "DRAINING": "draining",
    "REAUTH_REQUIRED": "reauth needed",
}


def format_account_state(account: dict[str, Any], style: Style) -> str:
    raw = str(account.get("state") or "")
    text = _STATE_TEXT.get(raw, raw.lower() or "?")
    reason = str(account.get("reason") or "").strip()
    if reason and raw != "AVAILABLE":
        text = f"{text}{style.sep}{reason}"
    return text


@dataclass(frozen=True)
class Column:
    key: str
    heading: str
    align: str = "left"
    flex: bool = False
    # Drop priority: 0 never drops; higher drops first.
    drop: int = 0


def render_table(
    columns: Sequence[Column], rows: Sequence[dict[str, str]], style: Style
) -> list[str]:
    """Lay a table out, dropping whole columns (highest ``drop`` first) to fit."""
    if not rows:
        return []
    indent, gutter = 2, 2
    live = list(columns)
    budget = style.usable - indent

    def widths(cols: Sequence[Column]) -> dict[str, int]:
        return {c.key: max([len(c.heading), *(len(r.get(c.key, "")) for r in rows)]) for c in cols}

    def total(cols: Sequence[Column], w: dict[str, int]) -> int:
        return sum(w[c.key] for c in cols) + gutter * max(0, len(cols) - 1)

    w = widths(live)
    while total(live, w) > budget:
        droppable = [c for c in live if c.drop > 0]
        if not droppable:
            break
        victim = max(droppable, key=lambda c: c.drop)
        live = [c for c in live if c.key != victim.key]
        w = widths(live)
    overflow = total(live, w) - budget
    if overflow > 0:
        flex = next((c for c in live if c.flex), None)
        if flex is not None:
            w[flex.key] = max(len(flex.heading), w[flex.key] - overflow)

    def cell(col: Column, text: str) -> str:
        width = w[col.key]
        if len(text) > width:
            text = text[: max(0, width - len(style.ellipsis))] + style.ellipsis
        return text.rjust(width) if col.align == "right" else text.ljust(width)

    lines = [" " * indent + (" " * gutter).join(cell(c, c.heading) for c in live).rstrip()]
    for row in rows:
        lines.append(
            " " * indent + (" " * gutter).join(cell(c, row.get(c.key, "")) for c in live).rstrip()
        )
    return lines


def render_accounts(accounts: Sequence[dict[str, Any]], style: Style, now: datetime) -> list[str]:
    """The pool, in ``cs status``'s columns, with the footnote when a ``~`` is shown."""
    if not accounts:
        return [
            "  no accounts registered",
            "    built-in jobs use the fallback credential, if one is set",
        ]
    short_key, long_key = window_keys(accounts)
    columns = [
        Column("account", "ACCOUNT", flex=True),
        Column("short", f"{window_heading(short_key) if short_key else '5H'} USED", drop=1),
        Column("long", f"{window_heading(long_key) if long_key else '7D'} USED", drop=2),
        Column("clears", "CLEARS", align="right", drop=4),
        Column("state", "STATE", flex=True, drop=3),
    ]
    rows: list[dict[str, str]] = []
    for account in accounts:
        short = read_window(account, short_key) if short_key else Reading("5h")
        long = read_window(account, long_key) if long_key else Reading("7d")
        binding = binding_window([short, long])
        rows.append(
            {
                "account": str(account.get("label") or account.get("account_id") or "?"),
                "short": format_window(short, style),
                "long": format_window(long, style),
                "clears": format_until(binding.resets_at, now, style) if binding else style.dash,
                "state": format_account_state(account, style),
            }
        )
    lines = render_table(columns, rows, style)
    if any(account_is_stale(a) for a in accounts):
        joiner = style.sep if style.unicode else "   "
        lines.append(f"    ~ projected from an older reading{joiner}{style.dash} not measured")
    return lines


def accounts_subtitle(accounts: Sequence[dict[str, Any]], style: Style) -> str:
    assigned = sum(int(a.get("assigned") or 0) for a in accounts)
    stale = sum(1 for a in accounts if account_is_stale(a))
    bits = [f"{len(accounts)} account{'s' if len(accounts) != 1 else ''}"]
    bits.append(f"{assigned} job{'s' if assigned != 1 else ''} assigned")
    if stale:
        bits.append(f"{stale} stale")
    return style.sep.join(bits).strip()
