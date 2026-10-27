"""Simple S2 (#723): the constraint checker's flags (oracle.simple.constraints). Pure
functions, no database.

Test cards (protects / fails_when / no_claim):

- test_dependency_order: protects=a dependency ending on or after the item's start flags
  the item, red, with a one-line reason naming the dependency and the fixes
  shift_dependents, move_dependency, accept_risk; fails_when=no flag, a wrong reason or
  fixes; no_claim=applying a fix (S3).
- test_dependency_order_between_two_estimated_bars_is_no_flag: protects=two hatched
  window estimates never conflict; fails_when=every Now item depending on another Now
  item is red; no_claim=none.
- test_blocker_date: protects=an open blocker expected after the start flags it
  [accept_risk], the line naming the item first; a resolved one or one expected before does not; fails_when=either way;
  no_claim=how a blocker's expected date is recorded (the API test seeds it).
- test_outside_milestone: protects=a bar ending after its milestone's date flags it
  [accept_risk], the line naming the item first; fails_when=either way; no_claim=none.
- test_cut_with_dependents: protects=a cut item others depend on is flagged
  [accept_risk], naming them; fails_when=either way; no_claim=none.
- test_draft_without_owner: protects=a draft item without an owner is flagged with no
  fixes; with an owner, or not a draft, no flag; fails_when=either way; no_claim=none.
- test_accepted_risk_turns_amber_not_gone: protects=an accepted risk keeps the flag,
  amber, with its note; another flag of the item stays red; fails_when=the flag vanishes
  or stays red; no_claim=accepting the risk (S3).
- test_every_reason_is_one_line: protects=no reason has a line break or exceeds 160
  characters; fails_when=a reason runs on; no_claim=wording review.
"""

from datetime import date

from oracle.simple import constraints
from oracle.simple.constraints import Blocker, Node
from oracle.simple.dates import Dated


def d(y: int, m: int, day: int, estimated: bool = False) -> Dated:
    return Dated(date(y, m, day), "estimated" if estimated else "typed", estimated)


def node(id_: str, start: Dated, end: Dated, **kw) -> Node:
    kw.setdefault("title", id_.title())
    return Node(id=id_, start=start, end=end, **kw)


def kinds(flags) -> list[str]:
    return [f.kind for f in flags]


def test_dependency_order():
    dep = node("ledger", d(2026, 10, 1), d(2026, 11, 10))
    item = node("import", d(2026, 11, 10), d(2026, 12, 1), depends_on=["ledger"])
    ok = node("export", d(2026, 11, 11), d(2026, 12, 1), depends_on=["ledger"])
    out = constraints.check([dep, item, ok])
    (flag,) = out["import"]
    assert flag.kind == "dependency_order"
    assert flag.fixes == ["shift_dependents", "move_dependency", "accept_risk"]
    assert flag.state == "red"
    assert flag.subject == "ledger"
    assert "Ledger" in flag.reason and "Nov 10" in flag.reason
    assert out["export"] == [] and out["ledger"] == []


def test_dependency_order_between_two_estimated_bars_is_no_flag():
    dep = node("ledger", d(2026, 10, 1, True), d(2026, 12, 31, True))
    item = node("import", d(2026, 10, 1, True), d(2026, 12, 31, True), depends_on=["ledger"])
    assert constraints.check([dep, item])["import"] == []


def test_blocker_date():
    late = Blocker(id="b1", title="Rate limit", expected=date(2026, 11, 20), open=True)
    early = Blocker(id="b2", title="Contract", expected=date(2026, 10, 1), open=True)
    closed = Blocker(id="b3", title="Old", expected=date(2026, 12, 20), open=False)
    item = node("import", d(2026, 11, 1), d(2026, 12, 1), blockers=[late, early, closed])
    (flag,) = constraints.check([item])["import"]
    assert (flag.kind, flag.fixes, flag.subject) == ("blocker_date", ["accept_risk"], "b1")
    assert "Rate limit" in flag.reason and "Nov 20" in flag.reason
    # Named: a change card lists a dependent's lines under the moved item.
    assert flag.reason.startswith("'Import' starts Nov 1, but blocker 'Rate limit'")


def test_outside_milestone():
    item = node("import", d(2026, 11, 1), d(2026, 12, 1), milestone=("Beta", date(2026, 11, 15)))
    inside = node("export", d(2026, 11, 1), d(2026, 11, 15), milestone=("Beta", date(2026, 11, 15)))
    out = constraints.check([item, inside])
    (flag,) = out["import"]
    assert (flag.kind, flag.fixes) == ("outside_milestone", ["accept_risk"])
    assert "Beta" in flag.reason and "Nov 15" in flag.reason
    assert flag.reason == "'Import' ends Dec 1, after its milestone 'Beta' (Nov 15)"
    assert out["export"] == []


def test_cut_with_dependents():
    cut = node("ledger", d(2026, 10, 1), d(2026, 10, 20), status="cut")
    a = node("import", d(2026, 11, 1), d(2026, 12, 1), depends_on=["ledger"])
    b = node("export", d(2026, 11, 1), d(2026, 12, 1), depends_on=["ledger"])
    out = constraints.check([cut, a, b])
    (flag,) = out["ledger"]
    assert (flag.kind, flag.fixes) == ("cut_with_dependents", ["accept_risk"])
    assert "Import" in flag.reason and "1 other" in flag.reason
    lone = node("solo", d(2026, 10, 1), d(2026, 10, 20), status="cut")
    assert constraints.check([lone])["solo"] == []


def test_draft_without_owner():
    draft = node("idea", d(2026, 10, 1, True), d(2026, 12, 31, True), draft=True)
    owned = node("owned", d(2026, 10, 1, True), d(2026, 12, 31, True), draft=True,
                 owner_id="u1")  # fmt: skip
    plain = node("plain", d(2026, 10, 1, True), d(2026, 12, 31, True))
    out = constraints.check([draft, owned, plain])
    (flag,) = out["idea"]
    assert (flag.kind, flag.fixes) == ("draft_without_owner", [])
    assert out["owned"] == [] and out["plain"] == []


def test_accepted_risk_turns_amber_not_gone():
    dep = node("ledger", d(2026, 10, 1), d(2026, 11, 10))
    late = Blocker(id="b1", title="Rate limit", expected=date(2026, 11, 20), open=True)
    risks = [{"flag": "dependency_order", "subject": "ledger", "note": "Ledger ships early"}]
    item = node("import", d(2026, 11, 1), d(2026, 12, 1), depends_on=["ledger"],
                blockers=[late], accepted_risks=risks)  # fmt: skip
    out = {f.kind: f for f in constraints.check([dep, item])["import"]}
    assert out["dependency_order"].state == "amber"
    assert out["dependency_order"].risk_note == "Ledger ships early"
    assert out["blocker_date"].state == "red"


def test_every_reason_is_one_line():
    dep = node("a-very-long-dependency-title-" * 3, d(2026, 10, 1), d(2026, 11, 10))
    item = node("import", d(2026, 11, 1), d(2026, 12, 1), depends_on=[dep.id],
                milestone=("Beta", date(2026, 11, 15)), draft=True,
                blockers=[Blocker("b", "x" * 200, date(2026, 12, 1), True)])  # fmt: skip
    flags = constraints.check([dep, item])["import"]
    assert len(flags) == 4
    for f in flags:
        assert "\n" not in f.reason and len(f.reason) <= 160
