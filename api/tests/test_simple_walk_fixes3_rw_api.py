"""The owner's production walk of Simple mode, the roadmap (walk fixes 3, R4 and R5).
Against Postgres; the company's clock is fixed (Mon Nov 2, 2026, Pacific).

Test cards (protects / fails_when / no_claim):

- test_why_line_names_prd_draft_code_and_feature: protects=the item card's "Why" line
  naming where an item came from reads "From <PRD> (draft N): F-01 Sign-up flow." (the
  PRD's name, the number of the PRD draft the item was imported from, the code with the
  feature's name); a coded section with no heading reads its code with the item's name;
  a section key that is no code reads the item's own code (its feature's, F-12) with its
  name, else its name alone; fails_when=any reason reads "section <key>" (a lowercase
  anchor such as "section f-01"), or the draft number is missing; no_claim=the other
  reasons (rationale, goal).
- test_later_starts_where_next_ends: protects=the roadmap's Later window starts the day
  after Next ends (Jul 1, 2027 when Next ends Jun 30, 2027) and ends where the long
  horizon ends (today + 24 months), and an undated Later item's estimated bar starts
  there; fails_when=Later starts at today + 1 year (Nov 2, 2027), leaving a gap after
  Next; no_claim=the Settings page's planning horizons (unchanged).
"""

from datetime import date, timedelta

from oracle.docs.models import Section
from oracle.tenancy import tenant_session
from tests.baseline_helpers import make_ctx
from tests.test_simple_roadmap_api import Seed, by_key, get
from tests.test_simple_roadmap_api import clock as clock  # noqa: F401


def _from_line(item: dict) -> str:
    lines = [r for r in item["reasons"] if r.startswith("From ")]
    assert len(lines) == 1, item["reasons"]
    return lines[0]


async def test_why_line_names_prd_draft_code_and_feature(client):
    ctx = await make_ctx()
    async with tenant_session(ctx.tenant_id) as s:
        seed = Seed(s)
        prd = await seed.doc("signup-prd")
        pv = await seed.version(prd, n=5)
        rm = await seed.doc("signup", "roadmap", "company")
        rv = await seed.version(rm)
        s.add(Section(version_id=pv.id, section_key="f-01", ordinal=1, level=2,
                      heading="F-01 Sign-up flow", content_hash="h1"))  # fmt: skip
        await seed.item(rv, pv, "sign-up", title="Sign-up flow", prd_section_key="f-01")
        await seed.item(rv, pv, "invites", title="Team invites", prd_section_key="f-02",
                        position=1)  # fmt: skip
        feature = await seed.entity("feature", "F-12")
        await seed.item(rv, pv, "billing", title="Billing page", prd_section_key="scope",
                        feature_id=feature.id, position=2)  # fmt: skip
        await seed.item(rv, pv, "tour", title="Product tour", prd_section_key="goals",
                        position=3)  # fmt: skip
        await s.commit()
    for role in ("owner", "viewer"):
        items = by_key(await get(client, ctx, role))
        assert _from_line(items["sign-up"]) == "From Signup Prd (draft 5): F-01 Sign-up flow."
        assert _from_line(items["invites"]) == "From Signup Prd (draft 5): F-02 Team invites."
        assert _from_line(items["billing"]) == "From Signup Prd (draft 5): F-12 Billing page."
        assert _from_line(items["tour"]) == "From Signup Prd (draft 5): Product tour."
        for item in items.values():
            assert not any("section " in r for r in item["reasons"]), item["reasons"]


async def test_later_starts_where_next_ends(client):
    ctx = await make_ctx()
    async with tenant_session(ctx.tenant_id) as s:
        seed = Seed(s)
        _, pv, _, rv = await seed.roadmap("growth")
        await seed.item(rv, pv, "referrals", horizon="later")
        await s.commit()
    body = await get(client, ctx, "viewer")
    w = body["windows"]
    assert w["next"] == {"start": "2027-01-01", "end": "2027-06-30"}
    assert w["later"] == {"start": "2027-07-01", "end": "2028-11-02"}
    assert date.fromisoformat(w["later"]["start"]) == date.fromisoformat(
        w["next"]["end"]
    ) + timedelta(days=1)
    later = by_key(body)["referrals"]
    assert later["start"]["date"] == "2027-07-01"
    assert later["start"]["estimated"] is True
