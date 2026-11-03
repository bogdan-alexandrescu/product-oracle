"""A run's roles proposing the same change twice, accepting a link that already exists,
and an accept closing the proposals it made no-ops (baseline-proposals)."""

import uuid

import pytest

from oracle.runs.models import Run
from oracle.tenancy import tenant_session
from tests.baseline_helpers import entity, make_ctx

B = "/v1/baseline"


@pytest.fixture
async def ctx():
    return await make_ctx()


async def _run(ctx) -> str:
    async with tenant_session(ctx.tenant_id) as s:
        run = Run(flow="baseline_to_prd", status="running", created_by=ctx.users["owner"].id)
        s.add(run)
        await s.commit()
        return str(run.id)


async def _feature(client, ctx, key="saved-carts", title="Saved carts") -> dict:
    return await entity(client, ctx, type="feature", key=key, title=title,
                        attrs={"milestone": "M1"})  # fmt: skip


async def _propose(client, ctx, body: dict, run_id: str | None = None, role=None) -> dict:
    body = {**body, **({"run_id": run_id} if run_id else {}), **({"role": role} if role else {})}
    resp = await client.post(f"{B}/proposals", json=body, headers=ctx.as_("token"))
    assert resp.status_code == 201, resp.text
    return resp.json()


def _update(feat: dict, fields: dict, reason: str) -> dict:
    return {"op": "update", "kind": "entity", "entity_id": feat["id"], "fields": fields,
            "reason": reason}  # fmt: skip


def _link(src: dict, dst: dict, reason: str) -> dict:
    return {"op": "create", "kind": "edge", "reason": reason,
            "fields": {"src_id": src["id"], "dst_id": dst["id"], "type": "depends_on"}}  # fmt: skip


async def _open(client, ctx) -> dict[str, dict]:
    resp = await client.get(f"{B}/proposals", params={"status": "open"}, headers=ctx.as_("viewer"))
    assert resp.status_code == 200, resp.text
    return {p["id"]: p for p in resp.json()}


async def _all(client, ctx) -> dict[str, dict]:
    resp = await client.get(f"{B}/proposals", headers=ctx.as_("viewer"))
    assert resp.status_code == 200, resp.text
    return {p["id"]: p for p in resp.json()}


async def _accept(client, ctx, proposal: dict):
    return await client.post(f"{B}/proposals/{proposal['id']}/accept", headers=ctx.as_("approver"))


async def test_the_same_change_twice_in_a_run_is_marked(client, ctx):
    """protects: a run's second proposal of the same field values on the same item is
    marked as the first's duplicate, and the first names who also proposed it.
    fails_when: it is not marked, or the first does not list the second's role."""
    run = await _run(ctx)
    feat = await _feature(client, ctx)
    m2 = {"attrs": {"milestone": "M2"}}
    first = await _propose(client, ctx, _update(feat, m2, "Ships in M2."), run, "writer")
    second = await _propose(client, ctx, _update(feat, m2, "M2 slice."), run, "critic")
    listed = await _open(client, ctx)
    assert listed[second["id"]]["duplicate_of"] == first["id"]
    assert listed[first["id"]]["duplicate_of"] is None
    [also] = listed[first["id"]]["also_proposed"]
    assert (also["id"], also["by"], also["same"]) == (second["id"], "Critic", True)


async def test_two_values_for_one_field_are_one_choice(client, ctx):
    """protects: two proposals of one run that set one field to different values are one
    choice: the second is marked, not same; accepting either closes the other as not chosen.
    fails_when: they stay two cards, or the other stays open after the choice."""
    run = await _run(ctx)
    feat = await _feature(client, ctx)
    planned = await _propose(client, ctx, _update(feat, {"status": "planned"}, "Next up."), run,
                             "writer")  # fmt: skip
    proposed = await _propose(client, ctx, _update(feat, {"status": "proposed"}, "Not yet."),
                              run, "critic")  # fmt: skip
    listed = await _open(client, ctx)
    assert listed[proposed["id"]]["duplicate_of"] == planned["id"]
    [also] = listed[planned["id"]]["also_proposed"]
    assert (also["by"], also["same"], also["fields"]) == ("Critic", False, {"status": "proposed"})

    resp = await _accept(client, ctx, proposed)
    assert resp.status_code == 200, resp.text
    assert await _open(client, ctx) == {}
    other = (await _all(client, ctx))[planned["id"]]
    assert (other["status"], other["outcome"]) == ("rejected", "not_chosen")


async def test_new_items_with_near_identical_titles_are_marked(client, ctx):
    """protects: two of a run's proposals to add a feature whose titles differ only in
    case, plural or an "Add" are one; an unrelated title is not.
    fails_when: the near-identical one is not marked, or the unrelated one is."""
    run = await _run(ctx)

    def add(key: str, title: str) -> dict:
        return {"op": "create", "kind": "entity",
                "fields": {"type": "feature", "key": key, "title": title}}  # fmt: skip

    first = await _propose(client, ctx, add("saved-carts", "Saved carts"), run, "writer")
    second = await _propose(client, ctx, add("save-cart", "Add saved cart"), run, "critic")
    other = await _propose(client, ctx, add("gift-cards", "Gift cards"), run, "critic")
    addresses = await _propose(client, ctx, add("addresses", "Saved addresses"), run, "writer")
    address = await _propose(client, ctx, add("address", "Saved address"), run, "critic")
    listed = await _open(client, ctx)
    assert listed[address["id"]]["duplicate_of"] == addresses["id"]
    assert listed[second["id"]]["duplicate_of"] == first["id"]
    assert listed[other["id"]]["duplicate_of"] is None
    assert [a["id"] for a in listed[first["id"]]["also_proposed"]] == [second["id"]]


async def test_identical_links_are_marked_and_other_runs_are_not(client, ctx):
    """protects: the same link proposed twice by one run is marked; the same link from
    another run, or a person, is left as its own card.
    fails_when: the second link is not marked, or another run's is."""
    run, other_run = await _run(ctx), await _run(ctx)
    a = await _feature(client, ctx)
    b = await _feature(client, ctx, "team-invites", "Team invites")
    first = await _propose(client, ctx, _link(a, b, "Carts need invites."), run, "writer")
    second = await _propose(client, ctx, _link(a, b, "Invites first."), run, "critic")
    third = await _propose(client, ctx, _link(a, b, "Seen in planning."), other_run, "writer")
    listed = await _open(client, ctx)
    assert listed[second["id"]]["duplicate_of"] == first["id"]
    assert listed[third["id"]]["duplicate_of"] is None


async def test_accepting_a_link_that_exists_is_already_done(client, ctx):
    """protects: accepting a proposed link that a person has made since is no error: the
    proposal closes as already done; making it by hand says so in plain words.
    fails_when: the accept answers 409, or the raw edge text is shown."""
    a = await _feature(client, ctx)
    b = await _feature(client, ctx, "team-invites", "Team invites")
    proposal = await _propose(client, ctx, _link(a, b, "Carts need invites."))
    made = await client.post(f"{B}/edges", json={"src_id": a["id"], "dst_id": b["id"],
                             "type": "depends_on"}, headers=ctx.as_("owner"))  # fmt: skip
    assert made.status_code == 201, made.text
    again = await client.post(f"{B}/edges", json={"src_id": a["id"], "dst_id": b["id"],
                              "type": "depends_on"}, headers=ctx.as_("owner"))  # fmt: skip
    assert again.status_code == 409
    assert again.json()["detail"] == "This link already exists"

    resp = await _accept(client, ctx, proposal)
    assert resp.status_code == 200, resp.text
    out = resp.json()
    assert (out["status"], out["outcome"]) == ("accepted", "already_done")


async def test_an_accept_closes_the_proposals_it_made_no_ops(client, ctx):
    """protects: after an accept, the other open proposals on the item that now change
    nothing close at once as already done; one that would undo it stays open, marked.
    fails_when: the no-op stays open (asking the same decision again), or the conflicting
    one is closed."""
    feat = await _feature(client, ctx)
    accepted = await _propose(client, ctx, _update(feat, {"attrs": {"milestone": "M2"}}, "M2."))
    same = await _propose(client, ctx, _update(feat, {"attrs": {"milestone": "M2"}}, "Also M2."))
    title = await _propose(client, ctx, _update(feat, {"title": "Saved carts"}, "Name it."))
    clash = await _propose(client, ctx, _update(feat, {"attrs": {"milestone": "M3"}}, "Later."))

    resp = await _accept(client, ctx, accepted)
    assert resp.status_code == 200, resp.text
    assert sorted(resp.json()["closed_as_done"]) == sorted([same["id"], title["id"]])
    listed = await _open(client, ctx)
    assert list(listed) == [clash["id"]]
    assert listed[clash["id"]]["overlaps"][0]["by"] == "proposal"
    every = await _all(client, ctx)
    for p in (same, title):
        assert (every[p["id"]]["status"], every[p["id"]]["outcome"]) == ("accepted", "already_done")


async def test_a_link_accept_closes_the_same_link_proposed_again(client, ctx):
    """protects: accepting a link closes another open proposal of that same link as done.
    fails_when: the second link proposal stays open and its accept would fail."""
    a = await _feature(client, ctx)
    b = await _feature(client, ctx, "team-invites", "Team invites")
    first = await _propose(client, ctx, _link(a, b, "Carts need invites."))
    second = await _propose(client, ctx, _link(a, b, "Invites first."))
    resp = await _accept(client, ctx, first)
    assert resp.status_code == 200, resp.text
    assert resp.json()["closed_as_done"] == [second["id"]]
    assert uuid.UUID(second["id"]) and await _open(client, ctx) == {}


async def test_a_title_with_a_version_or_an_extra_word_is_its_own_feature(client, ctx):
    """protects: "Search v2" or "Sharing UI" is a feature of its own, not a near-identical
    title of "Search" or "Sharing"; accepting one leaves the other open.
    fails_when: the second is marked a duplicate, or the accept closes it as already done."""
    run = await _run(ctx)

    def add(key: str, title: str) -> dict:
        return {"op": "create", "kind": "entity",
                "fields": {"type": "feature", "key": key, "title": title}}  # fmt: skip

    search = await _propose(client, ctx, add("search", "Search"), run, "writer")
    search_v2 = await _propose(client, ctx, add("search-v2", "Search v2"), run, "critic")
    sharing = await _propose(client, ctx, add("sharing", "Sharing"), run, "writer")
    sharing_ui = await _propose(client, ctx, add("sharing-ui", "Sharing UI"), run, "critic")
    reports = await _propose(client, ctx, add("reports", "Reports"), run, "writer")
    reports_v2 = await _propose(client, ctx, add("reports-v2", "Reports v2"), run, "critic")
    listed = await _open(client, ctx)
    for p in (search_v2, sharing_ui, reports_v2):
        assert listed[p["id"]]["duplicate_of"] is None
    for p in (search, sharing, reports):
        assert listed[p["id"]]["also_proposed"] == []

    resp = await _accept(client, ctx, search)
    assert resp.status_code == 200, resp.text
    assert resp.json()["closed_as_done"] == []
    assert search_v2["id"] in await _open(client, ctx)


async def test_duplicates_stay_one_card_when_their_first_closes_alone(client, ctx):
    """protects: when the proposal a group's card showed is rejected on its own, the
    others of the group stay one card, on the oldest of them.
    fails_when: each remaining duplicate gets a card of its own."""
    run = await _run(ctx)
    feat = await _feature(client, ctx)
    m2 = {"attrs": {"milestone": "M2"}}
    first = await _propose(client, ctx, _update(feat, m2, "Ships in M2."), run, "writer")
    second = await _propose(client, ctx, _update(feat, m2, "M2 slice."), run, "critic")
    third = await _propose(client, ctx, _update(feat, m2, "M2 it is."), run, "scope_reviewer")
    resp = await client.post(f"{B}/proposals/{first['id']}/reject", json={},
                             headers=ctx.as_("approver"))  # fmt: skip
    assert resp.status_code == 200, resp.text
    listed = await _open(client, ctx)
    assert listed[second["id"]]["duplicate_of"] is None
    assert [a["id"] for a in listed[second["id"]]["also_proposed"]] == [third["id"]]
    assert listed[third["id"]]["duplicate_of"] == second["id"]
    assert listed[third["id"]]["also_proposed"] == []


async def test_a_create_accept_checks_only_new_items_of_its_type(client, ctx, monkeypatch):
    """protects: accepting a new feature checks only the open proposals that add a feature,
    not every open proposal adding any item in the workspace, one query each.
    fails_when: a proposal adding a goal is checked too."""
    from oracle.baseline import service

    checked: list[str] = []
    no_op = service._no_op

    async def counting(db, p):
        checked.append(str(p.id))
        return await no_op(db, p)

    monkeypatch.setattr(service, "_no_op", counting)

    def add(type_: str, key: str, title: str) -> dict:
        return {"op": "create", "kind": "entity",
                "fields": {"type": type_, "key": key, "title": title}}  # fmt: skip

    feature = await _propose(client, ctx, add("feature", "search", "Search"))
    goal = await _propose(client, ctx, add("goal", "g.reach", "Reach"))
    resp = await _accept(client, ctx, feature)
    assert resp.status_code == 200, resp.text
    assert goal["id"] not in checked
    assert goal["id"] in await _open(client, ctx)
