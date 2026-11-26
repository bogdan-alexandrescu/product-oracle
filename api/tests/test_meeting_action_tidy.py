"""A meeting's action items as the minutes editor and the answer give them, tidied before they
are kept. Pure: no database, no request. Invented example data only.

Test cards (protects / fails_when / no_claim):

- test_minutes_actions_keep_only_what_the_record_backs: protects=an action without a title or
  that is not an object is dropped; an owner who is not a member, or an id that is not one,
  falls back to the default owner; a date that is not one is dropped; a linked item that is not
  an id is dropped, one that is kept as its canonical id; a recorded action keeps its id; the
  title's whitespace is folded; at most MAX_ACTIONS are kept; fails_when=a stranger owns an
  action, a malformed date or item id is kept, or a recorded action loses its id;
  no_claim=Send, the Inbox.
- test_answer_actions_keep_title_owner_and_a_real_date: protects=the answer's actions keep a
  folded title, the owner as given and a valid date only; fails_when=an untitled action is kept
  or a malformed date passes; no_claim=owner checks (the minutes do them).
"""

import uuid

from oracle.simple.meetings_common import MAX_ACTIONS
from oracle.simple.meetings_words import _answer_actions, _clean_actions

MEMBER = uuid.UUID("00000000-0000-4000-8000-000000000001")
DEFAULT = uuid.UUID("00000000-0000-4000-8000-000000000002")
ITEM = uuid.UUID("00000000-0000-4000-8000-000000000003")


def test_minutes_actions_keep_only_what_the_record_backs():
    """Malformed owners, dates and item ids fall back or drop; the list is capped."""
    raw = [
        "not an action",
        {"title": "   "},
        {
            "title": "  Send   the brief ",
            "owner_id": str(MEMBER),
            "due_date": "2026-12-01",
            "item_id": str(ITEM).upper(),
            "action_item_id": "a-1",
        },
        {
            "title": "Book the room",
            "owner_id": "not-a-uuid",
            "due_date": "tomorrow",
            "item_id": "not-a-uuid",
        },
        {"title": "Ask legal", "owner_id": str(uuid.uuid4())},
    ]
    out = _clean_actions(raw, {MEMBER}, DEFAULT)
    assert out == [
        {
            "title": "Send the brief",
            "owner_id": str(MEMBER),
            "due_date": "2026-12-01",
            "item_id": str(ITEM),
            "action_item_id": "a-1",
        },
        {"title": "Book the room", "owner_id": str(DEFAULT), "due_date": None},
        {"title": "Ask legal", "owner_id": str(DEFAULT), "due_date": None},
    ]
    assert _clean_actions({"title": "not a list"}, {MEMBER}, DEFAULT) == []
    assert _clean_actions([{"title": "No owner"}], set(), None)[0]["owner_id"] is None
    many = [{"title": f"Step {i}"} for i in range(MAX_ACTIONS + 3)]
    assert len(_clean_actions(many, set(), None)) == MAX_ACTIONS


def test_answer_actions_keep_title_owner_and_a_real_date():
    """The answer's actions keep a folded title, the owner as given and a valid date only."""
    raw = [
        {"title": ""},
        7,
        {"title": " Draft   the plan", "owner_id": "o-1", "due_date": "2026-12-01"},
        {"title": "Review", "due_date": "next week"},
    ]
    assert _answer_actions(raw) == [
        {"title": "Draft the plan", "owner_id": "o-1", "due_date": "2026-12-01"},
        {"title": "Review", "owner_id": None, "due_date": None},
    ]
    assert _answer_actions(None) == []
