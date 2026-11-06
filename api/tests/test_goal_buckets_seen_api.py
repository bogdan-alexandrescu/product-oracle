"""Editing a goal from Simple's goal form refuses to overwrite a change made since the form
opened: the form sends the goal's name, measure, target and date as it read them
(``seen``). Against Postgres.

Test cards (protects / fails_when / no_claim):

- test_edit_with_matching_seen_saves: protects=PATCH /v1/simple/goal-buckets/goals/{id}
  with ``seen`` equal to the goal's current name, measure, target and date saves the edit
  (200) as before; fails_when=a goal read just now is refused or the edit is not saved;
  no_claim=edits without ``seen`` (test_simple_goal_buckets_api).
- test_edit_after_another_edit_is_refused: protects=when another edit moved the goal's
  measure after the form opened, the save is refused with 409 and the plain words "This
  goal changed since you opened it. Look again and save.", and the goal keeps the other
  edit; fails_when=the late save overwrites the other edit or the refusal reads as code;
  no_claim=the web form's reload (web/e2e).
"""

import pytest

from tests.test_simple_goal_buckets_api import URL, World

CHANGED = "This goal changed since you opened it. Look again and save."
# The goal "grow" as World seeds it, as the edit form reads it.
SEEN = {"title": "Grow", "measure": "Shops live", "target": "40 shops", "due": "2027-03-31"}
EDIT = {"title": "Grow shops", "measure": "Shops live", "target": "50 shops", "due": "2027-04-30"}


async def _grow(client, w: World) -> dict:
    return next(g for g in (await w.read(client))["goals"] if g["id"] == w.goals["grow"])


@pytest.mark.asyncio
async def test_edit_with_matching_seen_saves(client):
    w = await World().build()
    r = await client.patch(f"{URL}/goals/{w.goals['grow']}", headers=w.as_("owner"),
                           json={**EDIT, "seen": SEEN})  # fmt: skip
    assert r.status_code == 200, r.text
    grow = await _grow(client, w)
    assert (grow["title"], grow["target"], grow["due"]) == ("Grow shops", "50 shops", "2027-04-30")


@pytest.mark.asyncio
async def test_edit_after_another_edit_is_refused(client):
    w = await World().build()
    # Someone else changes the measure after the form opened.
    other = {**SEEN, "measure": "Shops selling weekly"}
    r = await client.patch(f"{URL}/goals/{w.goals['grow']}", headers=w.as_("approver"),
                           json=other)  # fmt: skip
    assert r.status_code == 200, r.text

    r = await client.patch(f"{URL}/goals/{w.goals['grow']}", headers=w.as_("owner"),
                           json={**EDIT, "seen": SEEN})  # fmt: skip
    assert r.status_code == 409, r.text
    assert r.json()["detail"] == CHANGED
    grow = await _grow(client, w)
    assert (grow["title"], grow["measure"], grow["target"], grow["due"]) == (
        "Grow", "Shops selling weekly", "40 shops", "2027-03-31")  # fmt: skip
