"""inbox-codes (#1786, reopened; review round): a run's item under its checkpoint's Inbox row
carries the code it reads with (``code``), so the row names it with its code.

Test cards (protects / fails_when / no_claim):

- test_a_child_from_a_coded_prd_section_carries_its_code: protects=an item imported from PRD
  section f-06 reads code "F-06"; fails_when=the child has no code; no_claim=the web
  (e2e/inbox-proposal-codes.spec.ts).
- test_a_childs_own_title_code_wins: protects=a title that leads with a code keeps it;
  fails_when=the section's code replaces it.
- test_a_child_with_no_code_has_none: fails_when=a code is made up for an uncoded item.
"""

from oracle.runs import actions
from oracle.runs.schemas import ReviewItem
from tests.test_inbox_checkpoint_summary import reason, review


def _child(title: str, section: str | None):
    it = ReviewItem(
        key="bulk-edit",
        position=1,
        title=title,
        prd_section=section,
        reasons=[reason("bulk-edit", "new_item", "confirm", [])],
        state="needs_you",
    )
    [child] = actions.summarize(review([it])).children
    return child


def test_a_child_from_a_coded_prd_section_carries_its_code():
    """A run item imported from section f-06 shows under its checkpoint as F-06."""
    child = _child("Bulk edit", "f-06")
    assert child.code == "F-06"
    assert child.title == "Bulk edit"


def test_a_childs_own_title_code_wins():
    """An item whose title leads with a code keeps that code."""
    assert _child("F-09 Bulk edit", "f-06").code == "F-09"


def test_a_child_with_no_code_has_none():
    """An item with no code stays as its name."""
    assert _child("Bulk edit", "goals").code is None
    assert _child("Bulk edit", None).code is None
