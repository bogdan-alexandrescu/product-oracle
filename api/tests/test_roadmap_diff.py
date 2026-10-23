"""The one roadmap item diff (oracle.roadmap.diff): pure, on hand-built snapshots.

protects: one notion of "changed" for the roadmap items checkpoint's reasons, per-item
resolutions, the roadmap item diff and the plan screen.
fails_when: an item lands in the wrong class, or a renamed item shows as new plus dropped.
no_claim: the routes and screens that show a diff.
"""

from datetime import date
from types import SimpleNamespace

from oracle.roadmap.diff import (
    ALL_FIELDS,
    COUNTED_FIELDS,
    NOTE_FIELDS,
    RANK_THRESHOLD,
    ItemSnapshot,
    diff_items,
    normalize,
    snapshot_from_raw,
    snapshot_from_row,
)


def snap(key: str, position: int, **kw) -> ItemSnapshot:
    return ItemSnapshot(key=key, title=kw.pop("title", key.title()), position=position, **kw)


def test_the_plan_fields_count_and_confidence_is_a_note():
    assert set(COUNTED_FIELDS) == {
        "title", "outcome", "horizon", "milestone_name", "milestone_date", "depends_on",
        "prd_section", "rank",
    }  # fmt: skip
    assert "confidence" in NOTE_FIELDS and "confidence" not in COUNTED_FIELDS
    assert set(ALL_FIELDS) == set(COUNTED_FIELDS) | set(NOTE_FIELDS)
    assert RANK_THRESHOLD == 2


def test_one_of_each_class():
    base = [
        snap("a", 0, horizon="now"),
        snap("b", 1, horizon="next", outcome="Fewer drop-offs"),
        snap("c", 2, horizon="next"),
        snap("d", 3, horizon="later"),
    ]
    head = [
        snap("a", 0, horizon="next"),
        snap("b", 1, horizon="next", outcome="Half the drop-offs"),
        snap("c", 2, horizon="next"),
        snap("e", 3, horizon="later"),
    ]
    out = diff_items(base, head)
    assert out.summary == {"added": 1, "dropped": 1, "moved": 1, "changed": 1, "unchanged": 1}
    assert {d.key: d.status for d in out.items} == {
        "a": "moved", "b": "changed", "c": "unchanged", "d": "dropped", "e": "added",
    }  # fmt: skip
    moved = out.by_key("a").changed("horizon")
    assert (moved.before, moved.after) == ("now", "next")
    assert out.by_key("b").changed("outcome").after == "Half the drop-offs"
    assert out.by_key("d").head is None and out.by_key("e").base is None


def test_a_renamed_item_is_matched_by_its_title():
    base = [snap("pay", 0, title="Payment step", horizon="now")]
    head = [snap("payment-step", 0, title="  payment STEP! ", horizon="now")]
    out = diff_items(base, head)
    assert out.summary == {"added": 0, "dropped": 0, "moved": 0, "changed": 1, "unchanged": 0}
    (item,) = out.items
    assert item.status == "changed" and item.renamed
    assert item.key == "payment-step" and item.base_key == "pay"
    assert item.changed("key").before == "pay"


def test_an_ambiguous_title_is_not_a_rename():
    base = [snap("x", 0, title="Alerts")]
    head = [snap("y", 0, title="Alerts"), snap("z", 1, title="alerts")]
    out = diff_items(base, head)
    assert out.summary["added"] == 2 and out.summary["dropped"] == 1


def test_rank_moves_count_from_the_threshold():
    base = [snap("a", 0, rank=1), snap("b", 1, rank=2)]
    head = [snap("a", 0, rank=2), snap("b", 1, rank=5)]
    out = diff_items(base, head)
    a, b = out.by_key("a"), out.by_key("b")
    assert a.status == "unchanged" and [n.field for n in a.notes] == ["rank"]
    assert b.status == "changed" and b.changed("rank").after == 5
    # A caller may set its own threshold.
    assert diff_items(base, head, rank_threshold=1).by_key("a").status == "changed"


def test_confidence_and_date_state_are_notes_only():
    base = [snap("a", 0, confidence="high", date_state="proposed")]
    head = [snap("a", 0, confidence="low", date_state="verified")]
    (item,) = diff_items(base, head).items
    assert item.status == "unchanged"
    assert {n.field for n in item.notes} == {"confidence", "date_state"}
    # Counted fields are the caller's to choose.
    counted = (*COUNTED_FIELDS, "confidence")
    assert diff_items(base, head, counted=counted).items[0].status == "changed"


def test_a_dropped_item_keeps_its_place():
    base = [snap("a", 0), snap("b", 1), snap("c", 2), snap("first", -1)]
    head = [snap("a", 0), snap("c", 1), snap("n", 2)]
    out = diff_items(base, head)
    assert [(d.key, d.status) for d in out.items] == [
        ("first", "dropped"),
        ("a", "unchanged"),
        ("b", "dropped"),
        ("c", "unchanged"),
        ("n", "added"),
    ]


def test_snapshots_from_the_file_and_from_a_row():
    raw = {
        "id": "pay",
        "title": "Payment step",
        "outcome": "Buyers pay",
        "horizon": "now",
        "milestone": {"name": "Beta", "date": date(2026, 11, 30), "date_source": "ENG-412"},
        "depends_on": ["csv"],
        "priority": {"rank": 1, "score": 4.2},
        "confidence": 0.4,
        "prd_section": "s-5-1",
    }
    s = snapshot_from_raw(raw, 3)
    assert (s.key, s.horizon, s.milestone_name, s.milestone_date, s.date_state) == (
        "pay", "now", "Beta", "2026-11-30", "proposed",
    )  # fmt: skip
    assert (s.depends_on, s.rank, s.confidence, s.prd_section, s.position) == (
        ("csv",), 1, "0.4", "s-5-1", 3,
    )  # fmt: skip
    assert snapshot_from_raw({"title": "No id", "milestone": "Beta"}, 0).key == "#1"

    row = SimpleNamespace(
        item_key="pay", title="Payment step", outcome="Buyers pay", horizon="now",
        milestone={"name": "Beta", "date": "2026-11-30"}, depends_on=["csv"],
        priority={"rank": 1}, confidence="high", prd_section_key="s-5-1",
        prd_section_hash="h1", position=0,
    )  # fmt: skip
    r = snapshot_from_row(row, None)
    assert (r.milestone_date, r.date_state, r.section_hash) == ("2026-11-30", "verified", "h1")
    live = {"name": "Beta", "date": None, "refused_date": "2026-11-30"}
    assert snapshot_from_row(row, live).date_state == "refused"
    assert normalize("Ünïcode — Step!!") == "unicode step"


def test_the_e3_fixture_as_the_route_shows_it():
    """protects: the roadmap item diff route's rows (E3): five classes on a known pair,
    dropped rows placed by horizon, the section's text and date state as notes only;
    fails_when: an item lands in the wrong class or place, or a field is missing;
    no_claim: how agents choose ids."""
    from oracle.roadmap.diff_views import item_rows

    base = [
        snap("cart-review", 0, title="Cart review shows the full price", horizon="now", rank=1),
        snap("shipping-step", 1, title="Shipping step on one screen", horizon="now", rank=2,
             milestone_date="2026-11-30", date_state="verified"),
        snap("guest-checkout", 2, title="Guest checkout", horizon="next", rank=3),
        snap("wallet-pay", 3, title="One-tap wallet pay", horizon="later", rank=4),
    ]  # fmt: skip
    head = [
        snap("cart-review", 0, title="Cart review shows the full price", horizon="now", rank=1),
        snap("guest-checkout", 1, title="Guest checkout", horizon="now", rank=2),
        snap("shipping-step", 2, title="Shipping step on one screen", horizon="now", rank=3),
        snap("saved-addresses", 3, title="Saved addresses", horizon="next", rank=4),
    ]
    diff = diff_items(base, head)
    assert diff.summary == {"added": 1, "dropped": 1, "moved": 1, "changed": 1, "unchanged": 1}
    rows = item_rows(diff)
    assert [(r["item_key"], r["change"]) for r in rows] == [
        ("cart-review", "unchanged"),
        ("guest-checkout", "moved"),
        ("shipping-step", "changed"),
        ("saved-addresses", "added"),
        ("wallet-pay", "dropped"),
    ]
    cart, guest, ship, saved, wallet = rows
    assert cart == {
        "item_key": "cart-review", "change": "unchanged", "matched_by": "key",
        "title": "Cart review shows the full price", "base_horizon": "now",
        "head_horizon": "now", "base_position": 0, "head_position": 0, "fields": [],
        "notes": [],
    }  # fmt: skip
    assert guest["fields"] == [{"field": "horizon", "before": "next", "after": "now"}]
    assert guest["notes"] == [{"field": "rank", "before": 3, "after": 2}]
    assert (guest["base_position"], guest["head_position"]) == (2, 1)
    # The date's state follows the date: no separate note.
    assert ship["fields"] == [{"field": "milestone_date", "before": "2026-11-30", "after": None}]
    assert ship["notes"] == [{"field": "rank", "before": 2, "after": 3}]
    assert saved["matched_by"] is None and saved["base_horizon"] is None
    assert saved["head_horizon"] == "next" and saved["head_position"] == 3
    assert wallet["title"] == "One-tap wallet pay" and wallet["base_horizon"] == "later"
    assert wallet["head_horizon"] is None and wallet["head_position"] is None

    # A rename is matched by title, with an item_key field; a section's text change and
    # a date state alone are notes.
    renamed = item_rows(
        diff_items(
            [snap("pay", 0, title="Pay step", section_hash="a", date_state="refused")],
            [snap("payment", 0, title="pay STEP.", section_hash="b")],
        )
    )
    assert renamed[0]["matched_by"] == "title" and renamed[0]["change"] == "changed"
    assert renamed[0]["fields"][0] == {"field": "item_key", "before": "pay", "after": "payment"}
    assert {n["field"] for n in renamed[0]["notes"]} == {"prd_section_text", "date_state"}
