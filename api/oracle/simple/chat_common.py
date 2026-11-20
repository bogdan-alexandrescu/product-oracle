"""Constants, errors and small helpers shared by oracle.simple.chat and its parts."""

import importlib
import re
import uuid
from datetime import date
from typing import Any, get_args

from sqlalchemy.ext.asyncio import AsyncSession

from oracle.simple import service
from oracle.simple.schemas import ChatKind

MEETINGS = "oracle.simple.meetings"
VISUALS = "oracle.simple.visuals"
ENGINE = "oracle.simple.chat"
READER_JOB = "chat_reader"
DEAD = ("failed", "cancelled")
KINDS = frozenset(get_args(ChatKind))
FLOW_OPS = ("add_feature_ask", "add_item_task")
# walkc-meeting r2 (5g): cards that add work and move no date; they carry no constraint
# check (the item's own red flags are not theirs) and no Preview.
UNCHECKED_OPS = (*FLOW_OPS, "add_launch_task", "add_action_item")
CARD_OPS_ON_ITEMS = ("move_dates", "change_horizon", "set_milestone", "edit_title", "cut")
VIEWER_NOTE = "Viewers ask questions here; ask the presenter to make a change."
EXAMPLES = (
    "Try “move <item> to Q2”, “add a milestone 'beta' to <item> on March 1”, “new feature ask "
    "from <name>: <ask>”, “add a task '<task>' to <item>”, “action item: <person> to <do> by "
    "<day>” or “who owns <item>?”."
)
MONTHS = {
    m: i + 1
    for i, m in enumerate(
        (
            "january february march april may june july august september october november december"
        ).split()
    )
}
HERE = "Here is the change. Preview it, then apply or discard it."
# walkc-meeting r2 (5g): a card with no Preview is not asked to be previewed.
HERE_PLAIN = "Here is the change. Apply or discard it."
NEITHER: dict[str, Any] = {"label": "Neither", "op": None, "args": {}}
READING = "Reading that…"
COULD_NOT_READ = "I couldn't read that just now."
# A read that failed because every Claude account was spent (the job's error_reason and
# next_reset_at, set by the worker): until when, with no Retry until the window clears.
SPENT_UNTIL = "Oracle's Claude accounts are used up until {when}."
SAY_AGAIN = "Say it another way."
# qa-simple-decide-3: a question in a meeting's chat is kept for the minutes' open questions
# (minutes.Record.questions); Ask Oracle answers it.
MEETING_ASK = "Kept as a question for the minutes. For an answer now, use Ask Oracle."
QUOTE = r"[\"'“‘](.+?)[\"'”’]"
DAY = r"(\d{4}-\d{2}-\d{2}|[a-z]+ \d{1,2})"


class ChatError(Exception):
    def __init__(self, status: int, detail: Any) -> None:
        super().__init__(str(detail))
        self.status = status
        self.detail = detail


def _module(name: str) -> Any:
    """A parallel lane's module (S8 meetings, S10 visuals), or None while it is absent."""
    try:
        return importlib.import_module(name)
    except ImportError:
        return None


def _me(principal: Any) -> uuid.UUID:
    me = getattr(principal, "user_id", None)
    if me is None:
        raise ChatError(403, "Simple's chat is for people")
    return me


# --------------------------------------------------------------------------- words


def _unquote(s: str) -> str:
    return re.sub(r"[?.!]+$", "", s.strip().strip("\"'“”‘’")).strip()


def _or(xs: list[str]) -> str:
    return xs[0] if len(xs) < 2 else f"{', '.join(xs[:-1])} or {xs[-1]}"


def _day_words(d: date | str | None, year: bool = False) -> str:
    if d is None:
        return "no date"
    d = date.fromisoformat(d) if isinstance(d, str) else d
    # Month first, as everywhere else in the app: "Nov 20", "Dec 20, 2026".
    return f"{d:%b} {d.day}" + (f", {d.year}" if year else "")


# --------------------------------------------------------------------------- Oracle's reply


class Reply:
    """``understood``: the line is one Oracle's reader knows (the Ask panel's one box sends
    any other line to Oracle's Ask); ``missing``: no item (or person) has the name it gave."""

    def __init__(self, kind: str, body: str, cards: list[dict[str, Any]] | None = None,
                 understood: bool = True, missing: bool = False, reader: bool = False,
                 choices: list[dict[str, Any]] | None = None) -> None:  # fmt: skip
        self.kind, self.body, self.cards = kind, body, cards or []
        self.understood, self.missing = understood, missing
        # ``reader``: a line parse() does not know, for Oracle's reader (the chat_reader job).
        self.reader = reader
        # A question's clickable choices ({label, op, args}; NEITHER last).
        self.choices = choices or []
        # The items an ambiguous name matched (ChatOp builds turn them into choices).
        self.candidates: list[service.Entry] = []
        # The people an unknown or ambiguous name may mean (build turns them into choices).
        self.people: list[str] = []
        self.person_text: str | None = None
        # roadmap-talk: where an item talk's answer comes from (the message's citations).
        self.citations: list[dict[str, Any]] = []
        # The reader saw nothing to change in the line (no action, no clarify): in a
        # meeting a line ending in "?" is then kept for the minutes (MEETING_ASK).
        self.no_change = False
        # ask-length-limit: where the parts Oracle cannot change yet are changed ({label, href}).
        self.links: list[dict[str, str]] = []


# --------------------------------------------------------------------------- meetings


async def rules_of(db: AsyncSession, meeting_id: uuid.UUID) -> Any:
    meetings = _module(MEETINGS)
    rules = await meetings.meeting_rules(db, meeting_id) if meetings is not None else None
    if rules is None:
        raise ChatError(404, "No such meeting")
    return rules


def _attends(principal: Any, rules: Any) -> bool:
    me = _me(principal)
    return me == rules.presenter_id or me in (rules.attendee_ids or [])


def _talk() -> Any:
    from oracle.simple import roadmap_talk

    return roadmap_talk


def _shipped() -> Any:
    from oracle.simple import shipped

    return shipped


def _actions() -> Any:
    from oracle.simple import chat_actions

    return chat_actions


def _api() -> Any:
    from oracle.simple import ask_actions

    return ask_actions
