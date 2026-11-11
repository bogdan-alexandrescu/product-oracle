"""one-feature-panel: the roadmap read names an item's own decider (``own_decider_id``),
set_decider's ``before``, the same way it already names its own owner (``own_owner_id``).
Against Postgres.

Test cards (protects / fails_when / no_claim):

- test_panel_own_decider_id_apply_and_read: protects=an owner applies ``set_decider`` on
  one item and the roadmap read shows that item's ``own_decider_id`` as the named person,
  while another item's stays null; fails_when=``own_decider_id`` is missing from the read
  or carries the wrong (or another item's) value; no_claim=the web panel.
"""

import pytest

from oracle import company_time
from tests.test_simple_changes_api import make_people
from tests.test_simple_panel_fields import Panel
from tests.test_simple_roadmap_api import NOW

pytestmark = pytest.mark.asyncio(loop_scope="session")


@pytest.fixture(autouse=True)
def clock(monkeypatch):
    monkeypatch.setattr(company_time, "now", lambda: NOW)


async def test_panel_own_decider_id_apply_and_read(client):
    p = await Panel().build(await make_people())
    items = await p.read(client)
    assert items["a"]["own_decider_id"] is None
    assert items["b"]["own_decider_id"] is None

    decider = str(p.ctx.users["decider"].id)
    r = await p.post(client, "set_decider", {"decider_id": None}, {"decider_id": decider})
    assert r.status_code == 201, r.text
    assert r.json()["change"]["status"] == "applied"

    items = await p.read(client)
    assert items["a"]["own_decider_id"] == decider
    assert items["b"]["own_decider_id"] is None
