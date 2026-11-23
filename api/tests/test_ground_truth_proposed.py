"""In the Ground Truth, one rule (the owner, Nov 23: every roadmap feature joins the Ground
Truth and takes the next F-code, from the UI). A roadmap item whose feature a run only proposed
is not in the Ground Truth: the Simple roadmap read names that feature
(``confirm_feature_id``), so Simple's feature panel offers Confirm into the Ground Truth, and the
Ground Truth check flags the item with Confirm it on the same feature (``oracle.baseline.fixes
.to_confirm`` for both). Confirming it from the item gives it the next F-code: the read shows
the code and no feature to confirm, and the check drops the flag. Against Postgres. Invented
data only.

Test cards (protects / fails_when / no_claim):

- test_the_read_and_the_check_name_one_feature_to_confirm: protects=Import history 2 (its
  feature proposed) reads no code and names its feature to confirm, the same one its flag's
  Confirm it targets; Bulk import (F-01, confirmed) names none; fails_when=the read gives no
  feature to confirm, or another than the check's.
- test_confirm_gives_the_next_code: protects=Confirm it from the item gives its feature the next
  code (next_code's), read with that code and nothing to confirm, and the check has one flag fewer;
  fails_when=the item still reads Not in the Ground Truth after the confirm.
"""

from tests.test_ground_truth_check import (
    _check,
    _fixes,
    _of,
    clock,  # noqa: F401  (the fixture)
    world,
)

URL = "/v1/simple/roadmap"


async def _items(client, w: dict) -> dict[str, dict]:
    r = await client.get(URL, headers=w["ctx"].as_("owner"))
    assert r.status_code == 200, r.text
    return {i["id"]: i for i in r.json()["items"]}


def _flag(out: dict, item: str) -> dict | None:
    return next((f for f in _of(out, "unlinked_item") if f["item"]["id"] == item), None)


async def test_the_read_and_the_check_name_one_feature_to_confirm(client):
    """The panel's Confirm and the check's Confirm it act on the one feature."""
    w = await world()
    d, a = w["items"]["d"], w["items"]["a"]
    items = await _items(client, w)
    assert items[d]["code"] is None
    assert items[d]["confirm_feature_id"] == w["features"]["proposed"]
    assert items[a]["confirm_feature_id"] is None
    out = await _check(client, w["ctx"])
    assert _fixes(_flag(out, d))[0] == ("confirm_feature", items[d]["confirm_feature_id"])


async def test_confirm_gives_the_next_code(client):
    """Confirmed from the item, its feature takes the next F-code and leaves the check."""
    w = await world()
    d = w["items"]["d"]
    before = len(_of(await _check(client, w["ctx"]), "unlinked_item"))
    feature = (await _items(client, w))[d]["confirm_feature_id"]
    r = await client.post(
        f"/v1/baseline/entities/{feature}/confirm",
        params={"item_id": d},
        headers=w["ctx"].as_("approver"),
    )
    assert r.status_code == 200, r.text
    code = r.json()["key"]
    assert code.startswith("F-")
    item = (await _items(client, w))[d]
    assert item["code"] == code and item["confirm_feature_id"] is None
    out = await _check(client, w["ctx"])
    assert _flag(out, d) is None
    assert len(_of(out, "unlinked_item")) == before - 1
