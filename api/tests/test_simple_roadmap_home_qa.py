"""Pre-demo QA S-5: one broken-link count on Home, the side menu and the Roadmap.

- test_waiting_counts_every_red_flag_with_a_fix: protects=GET /v1/simple/roadmap/waiting
  counts every red flag with a one-click fix (an end past its milestone too), as Home's tile
  and the side menu's waiting list do (waiting_list._roadmap); a flag with no fix (a draft
  with no owner), an accepted risk and a done item are left out; fails_when=it counts the
  dependency kinds alone; no_claim=the web.
"""

from types import SimpleNamespace

from oracle.simple import drafts, service
from oracle.simple.constraints import Flag


def _red(kind: str, fixes: list[str]) -> Flag:
    return Flag(kind=kind, reason=kind, fixes=fixes, state="red")


async def test_waiting_counts_every_red_flag_with_a_fix(monkeypatch):
    entries = [
        SimpleNamespace(
            status="planned",
            suggestion=None,
            flags=[
                _red("dependency_order", ["shift_dependents", "accept_risk"]),
                _red("outside_milestone", ["accept_risk"]),
            ],
        ),
        SimpleNamespace(status="planned", suggestion=None, flags=[_red("draft_without_owner", [])]),
        SimpleNamespace(
            status="planned",
            suggestion=None,
            flags=[Flag(kind="blocker_date", reason="", fixes=["accept_risk"], state="amber")],
        ),
        SimpleNamespace(status="done", suggestion=None, flags=[_red("outside_milestone", ["accept_risk"])]),
    ]

    async def reader(db, principal):
        return SimpleNamespace(overlays={})

    async def load(db, overlays):
        return SimpleNamespace(entries=entries, deciders={})

    monkeypatch.setattr(drafts, "reader", reader)
    monkeypatch.setattr(service, "load", load)
    links, dates = await service.waiting(None, SimpleNamespace())
    assert (links, dates) == (2, 0)
