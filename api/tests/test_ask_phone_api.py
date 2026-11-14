"""ask-phone QA (Nov 14): Ask names Simple's Goal map and Inbox, and a discussion's subject
line names its item, never its key.

Each test's card: protects=<the observable>; fails_when=<the wrong result>;
no_claim=<what green does not prove>. Synthetic placeholders only.
"""

from tests.test_checkpoint_review import review  # noqa: F401 - fixtures
from tests.test_discussion_changes import item_discussion
from tests.test_roadmap import owner, runtime  # noqa: F401 - fixtures


# protects=QA row 1: Ask on /simple/goals and /simple/inbox names the page; fails_when=the raw
# path reads as its name; no_claim=the web's own map (its Playwright spec covers it).
def test_simple_goal_map_and_inbox_have_names():
    from oracle.discussions.context import page_name
    from oracle.simple.chat import page_name as chat_page_name

    assert page_name("/simple/goals") == "Goal map"
    assert page_name("/simple/inbox") == "Inbox"
    assert chat_page_name("/simple/goals") == "Goal map"


# protects=QA row 2: a checkpoint item's discussion reads "<flow> · <stop> · <item's name>";
# fails_when=the subject line ends in the item's key (mobile-push); no_claim=a code (this
# item has no Ground Truth feature).
async def test_a_checkpoint_items_subject_names_the_item(review):  # noqa: F811
    d_id = await item_discussion(review)
    resp = await review.client.get(f"/v1/discussions/{d_id}", headers=review.h("commenter"))
    assert resp.status_code == 200, resp.text
    label = resp.json()["subject_label"]
    assert label.endswith(" · Mobile push"), label
    assert "mobile-push" not in label
