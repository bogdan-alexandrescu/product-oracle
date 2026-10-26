"""O5 owner decision (2026-10-26): Board and Team group a roadmap version's items by the
confirmed goal derived through each item's feature in the baseline at render time
(confirmed ``supports`` edges to confirmed goals, as oracle.launches.tiers reads them);
an item reaching two goals sits under the first by title, once; items with no feature
sit under "No goal" at the end. Board still leaves out items that serve no confirmed
goal, with its line; a goal renamed or unconfirmed changes the next render.
"""

import re

import pytest
from sqlalchemy import select, update

from oracle.baseline.models import Edge, Entity
from oracle.roadmap import variants
from oracle.shares import public as share_public
from oracle.shares import render as share_render
from oracle.tenancy import tenant_session
from tests.baseline_helpers import make_ctx
from tests.test_export_audience import EXPORT, ITEMS, _text, seed_roadmap
from tests.test_share_links import create, opened, token_of

PUBLIC = "/v1/public/shares"


@pytest.fixture
async def ctx():
    share_public.reset_limits()
    return await make_ctx("Example Labs")


# A fifth item in Now with no feature at all (nothing in the baseline keyed so).
AUDIT = ("audit-log", "now", "Audit log", "Every admin action is kept", {"confidence": "high"})


def outline(html: str) -> list[str]:
    """The rendering's headings ("h<level> <text>") and table rows, in page order (the
    export banner left out)."""
    page = re.sub(r"<style\b.*?</style>|<header\b.*?</header>", "", html, flags=re.S)
    out = []
    for m in re.finditer(r"<h([1-6])\b[^>]*>(.*?)</h\1>|<tr\b.*?</tr>", page, re.S):
        if m.group(1):
            out.append(f"h{m.group(1)} {_text(m.group(2)).strip()}")
        elif "<th" not in m.group(0):
            out.append(_text(m.group(0)).strip())
    return out


async def add_goal_links(ctx, links: dict[str, list[tuple[str, int]]]) -> None:
    """Per item key, a confirmed feature keyed as the item with a confirmed ``supports``
    edge (and contribution) to each named confirmed goal; a goal not yet there is made."""
    async with tenant_session(ctx.tenant_id) as s:
        goals = {g.title: g for g in await s.scalars(select(Entity).where(Entity.type == "goal"))}
        for key, served in links.items():
            feature = Entity(type="feature", key=key, title=key, status="confirmed", origin="user")
            s.add(feature)
            await s.flush()
            for title, contribution in served:
                if title not in goals:
                    goals[title] = Entity(
                        type="goal", key=title.lower(), title=title, status="confirmed",
                        origin="user",
                    )  # fmt: skip
                    s.add(goals[title])
                    await s.flush()
                s.add(
                    Edge(src_id=feature.id, dst_id=goals[title].id, type="supports",
                         status="confirmed", origin="user", attrs={"contribution": contribution})
                )  # fmt: skip
        await s.commit()


async def export(client, ctx, audience: str) -> list[str]:
    resp = await client.get(EXPORT, params={"audience": audience}, headers=ctx.as_("viewer"))
    assert resp.status_code == 200, resp.text
    return outline(resp.text)


async def test_board_groups_each_horizons_rows_under_the_goal_its_feature_serves(client, ctx):
    """protects=the owner decision: Board's rows sit under the confirmed goal reached
    through each item's feature, per horizon; the left-out line is unchanged;
    fails_when=Board's rows are not under a goal heading, or the left-out line changes;
    no_claim=Team (below), the written text (Board never reads it)."""
    await seed_roadmap(ctx)
    out = await export(client, ctx, "board")
    now = out.index("h2 Now")
    assert out[now + 1] == "h3 Activation", out
    rows = out[now + 2 : now + 4]
    assert rows[0].startswith("Bulk import") and rows[1].startswith("CSV parser"), out
    text = " ".join(out)
    resp = await client.get(EXPORT, params={"audience": "board"}, headers=ctx.as_("viewer"))
    assert "2 items serve no confirmed goal and are left out." in _text(resp.text)
    assert "Confetti" not in text and "Stickers" not in text
    assert variants.NO_GOAL_GROUP not in text


async def test_team_puts_items_with_no_feature_under_no_goal_at_the_end(client, ctx):
    """protects=items with no feature sit under "No goal" after every goal group, still
    flagged in Team; an item whose feature serves no goal is flagged too; fails_when=a
    feature-less item is dropped from Team, sits under a goal or before one;
    no_claim=Engineering's grouping (by team)."""
    await seed_roadmap(ctx, items=[*ITEMS, AUDIT], served=())
    await add_goal_links(
        ctx, {"csv-parser": [("Activation", 2)], "bulk-import": [("Retention", 2)]}
    )
    out = await export(client, ctx, "team")
    now = out.index("h2 Now")
    later = out.index("h2 Next")
    assert out[now:later] == [
        "h2 Now",
        "h3 Activation",
        "h4 CSV parser",
        "h3 Retention",
        "h4 Bulk import",
        f"h3 {variants.NO_GOAL_GROUP}",
        "h4 Audit log",
    ], out
    resp = await client.get(EXPORT, params={"audience": "team"}, headers=ctx.as_("viewer"))
    assert resp.text.count(variants.NO_GOAL_FLAG.split(" ", 1)[1]) >= 1
    # Board leaves both goal-less items out (no feature, and a feature serving none).
    board = await export(client, ctx, "board")
    assert "h3 Activation" in board and "h3 Retention" in board
    assert f"h3 {variants.NO_GOAL_GROUP}" not in board
    resp = await client.get(EXPORT, params={"audience": "board"}, headers=ctx.as_("viewer"))
    assert "3 items serve no confirmed goal and are left out." in _text(resp.text)


async def test_an_item_reaching_two_goals_sits_under_the_first_by_title_once(client, ctx):
    """protects=two confirmed goals: the item is grouped under the first by goal title and
    named once in Board and Team; fails_when=it shows under both, or under the other;
    no_claim=the Goal column's own pick (oracle.launches.tiers.best_goal)."""
    await seed_roadmap(ctx, served=())
    # Retention carries the larger contribution, yet Growth comes first by title.
    await add_goal_links(
        ctx, {"bulk-import": [("Retention", 5), ("Growth", 1)], "csv-parser": [("Retention", 1)]}
    )
    for audience, item in (("board", "Bulk import"), ("team", "h4 Bulk import")):
        out = await export(client, ctx, audience)
        now = out.index("h2 Now")
        assert out[now + 1] == "h3 Growth", (audience, out)
        assert out[now + 2].startswith(item), (audience, out)
        assert out[now + 3] == "h3 Retention", (audience, out)
        assert sum(x.startswith(item) for x in out) == 1, (audience, out)


async def test_board_with_no_confirmed_goal_groups_everything_under_no_goal(client, ctx):
    """protects=a tenant with no confirmed goal leaves nothing out and groups every item
    under "No goal"; fails_when=items are left out or grouped under a goal;
    no_claim=Team."""
    await seed_roadmap(ctx, served=())
    async with tenant_session(ctx.tenant_id) as s:
        await s.execute(update(Entity).where(Entity.type == "goal").values(status="proposed"))
        await s.commit()
    out = await export(client, ctx, "board")
    assert out[out.index("h2 Now") + 1] == f"h3 {variants.NO_GOAL_GROUP}", out
    assert not any("left out" in x for x in out)


async def test_a_goal_renamed_between_renders_regroups_the_shared_page(client, ctx):
    """protects=the share render key changes with the derived grouping: a goal renamed
    (or unconfirmed) after the link was opened regroups the next render; fails_when=the
    cached page keeps the old goal title; no_claim=the PDF (rendered per link)."""
    share_render.clear_cache()
    await seed_roadmap(ctx, publish=True)
    for audience in ("board", "team"):
        token = token_of((await create(client, ctx, "owner", audience=audience)).json())
        cookie = await opened(client, token)
        first = outline((await client.get(f"{PUBLIC}/{token}", headers=cookie)).text)
        assert "h3 Activation" in first, first
        async with tenant_session(ctx.tenant_id) as s:
            await s.execute(
                update(Entity).where(Entity.key == "g1").values(title=f"Adoption {audience}")
            )
            await s.commit()
        second = outline((await client.get(f"{PUBLIC}/{token}", headers=cookie)).text)
        assert f"h3 Adoption {audience}" in second and "h3 Activation" not in second, second
        async with tenant_session(ctx.tenant_id) as s:
            await s.execute(update(Entity).where(Entity.key == "g1").values(title="Activation"))
            await s.commit()


async def test_the_render_key_follows_the_derived_grouping():
    """protects=the key a share render is cached under holds each item's derived group
    and goal flag; fails_when=two groupings share a key; no_claim=the database."""
    a = variants.ItemView(key="x", title="X", outcome=None, horizon="now", position=0)
    a.group, a.goals = "Activation", ["Activation"]
    b = variants.ItemView(key="x", title="X", outcome=None, horizon="now", position=0)
    b.group, b.goals = "Adoption", ["Adoption"]
    assert variants.render_key([a]) != variants.render_key([b])
    c = variants.ItemView(key="x", title="X", outcome=None, horizon="now", position=0)
    c.group, c.goals = "Activation", ["Activation"]
    assert variants.render_key([a]) == variants.render_key([c])
