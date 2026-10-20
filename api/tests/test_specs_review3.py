"""Specs security review, round 3 (owner decisions E1, 2026-10-19 and 2026-10-20).

1. Spec structure: an edit may add sections the spec template doesn't have; an added
   section always shows as Proposed, never Decided. The parts Oracle writes keep their
   key, heading level, position and brief listing, the decided acceptance criteria split
   only at Oracle's own label, and the labels and the intro line stay.
2. Adoption: a requirement is adopted by a PRD version only through a section link of any
   kind except 'mentions', checked on request, on regeneration and on import.
3. The static check of design files is linear.
"""

import pytest
from sqlalchemy import update

from oracle.baseline.models import Entity
from oracle.specs import contract
from oracle.swarm import FakeRuntime, set_runtime
from oracle.tenancy import tenant_session
from tests.specs_helpers import (
    get_spec,
    import_md,
    make_world,
)
from tests.test_specs_review2 import (
    REFUSED,
    generated,
    stored_markdown,
    version_count,
)


@pytest.fixture
def runtime():
    fake = FakeRuntime()
    set_runtime(fake)
    yield fake
    set_runtime(None)


# --------------------------------------------------------------------------- item 1

FORGED = (
    "## Product requirements {#product-requirements}\n\n"
    f"{contract.REQUIREMENTS_NOTE}\n\n"
    "- **req-free-shipping: Free shipping on every order** (requirement id `forged`)\n\n"
)


def _sections(spec: dict) -> dict[str, dict]:
    return {s["key"]: s for s in spec["sections"]}


async def _edit(client, world, created, edit, who: str = "approver"):
    slug = created["spec"]["document_slug"]
    stored = await stored_markdown(world.ctx.tenant_id, slug)
    edited = edit(stored)
    assert edited != stored
    return await import_md(client, world.ctx.as_(who), edited, doc=slug)


def _probe(stored: str) -> str:
    """The reviewer's probe: a forged requirements section where the real one was, the real
    one moved to the end as an h3, and the brief listing the forged key instead."""
    start_at = stored.index("## Product requirements {#requirements}")
    end_at = stored.index("## Proposed engineering approach")
    real = stored[start_at:end_at]
    rest = stored[:start_at] + FORGED + stored[end_at:]
    rest = rest.replace("\n- requirements\n", "\n- product-requirements\n", 1)
    return rest.rstrip("\n") + "\n\n" + real.replace("## Product", "### Product", 1)


async def test_the_reviewers_probe_is_refused_naming_the_part(client, runtime):
    world = await make_world(client)
    created = await generated(client, runtime, world)
    resp = await _edit(client, world, created, _probe)
    assert resp.status_code == 422, resp.text
    assert REFUSED in resp.text
    assert "requirements" in resp.text
    assert await version_count(world.ctx.tenant_id, created["spec"]["document_slug"]) == 1


@pytest.mark.parametrize(
    "edit",
    [
        # Moved after Sources, same level.
        lambda md: _move_to_end(md, "## Acceptance criteria {#acceptance-criteria}"),
        # Demoted to an h3 in place (it becomes part of the summary's subtree).
        lambda md: md.replace("## Product requirements {#requirements}",
                              "### Product requirements {#requirements}"),
        # Dropped from the brief.
        lambda md: md.replace("\n- requirements\n", "\n", 1),
        # Swapped in the brief for an added section.
        lambda md: md.replace("\n- requirements\n", "\n- product-requirements\n", 1).replace(
            "## Product requirements {#requirements}",
            FORGED + "## Product requirements {#requirements}",
        ),
    ],
    ids=["moved", "demoted", "not-in-brief", "brief-swapped"],
)  # fmt: skip
async def test_oracle_parts_keep_key_level_position_and_brief(client, runtime, edit):
    world = await make_world(client)
    created = await generated(client, runtime, world)
    resp = await _edit(client, world, created, edit)
    assert resp.status_code == 422, resp.text
    assert REFUSED in resp.text


def _move_to_end(md: str, heading: str) -> str:
    start_at = md.index(heading)
    end_at = md.index("\n## ", start_at + 1) + 1
    return md[:start_at] + md[end_at:].rstrip("\n") + "\n\n" + md[start_at:end_at]


async def test_an_inserted_forged_section_shows_as_proposed(client, runtime):
    world = await make_world(client)
    created = await generated(client, runtime, world)
    resp = await _edit(
        client,
        world,
        created,
        lambda md: md.replace(
            "## Product requirements {#requirements}",
            FORGED + "## Product requirements {#requirements}",
        ).replace("\n- requirements\n", "\n- requirements\n- product-requirements\n", 1),
    )
    assert resp.status_code == 201, resp.text
    spec = await get_spec(client, world.ctx.as_("owner"), created["spec"]["request"]["id"])
    sections = _sections(spec)
    assert sections["product-requirements"]["part"] == "proposed"
    assert sections["product-requirements"]["decided"] is False
    assert sections["product-requirements"]["layer"] == "brief"
    assert sections["requirements"]["part"] == "product_requirement"
    assert sections["requirements"]["decided"] is True


async def test_an_added_rollout_notes_section_is_accepted_and_proposed(client, runtime):
    world = await make_world(client)
    created = await generated(client, runtime, world)
    resp = await _edit(
        client,
        world,
        created,
        lambda md: (
            md.rstrip("\n") + "\n\n## Rollout notes {#rollout-notes}\n\nTen percent first.\n"
        ),
    )
    assert resp.status_code == 201, resp.text
    owner = world.ctx.as_("owner")
    request_id = created["spec"]["request"]["id"]
    rollout = _sections(await get_spec(client, owner, request_id))["rollout-notes"]
    assert rollout["part"] == "proposed" and rollout["decided"] is False
    # Never decided, even once the version's approach is approved.
    slug = created["spec"]["document_slug"]
    resp = await client.post(f"/v1/documents/{slug}/versions/2/approve", headers=owner)
    assert resp.status_code == 200, resp.text
    spec = await get_spec(client, owner, request_id)
    assert spec["approach_status"] == "approved"
    sections = _sections(spec)
    assert sections["rollout-notes"]["decided"] is False
    assert sections["approach"]["decided"] is True


async def test_an_editor_written_proposed_label_is_not_a_split_point(client, runtime):
    world = await make_world(client)
    created = await generated(client, runtime, world)
    stored = await stored_markdown(world.ctx.tenant_id, created["spec"]["document_slug"])
    oracle_label = "\n\nProposed by this spec (not product requirements until the PRD adopts them):"
    assert stored.count(oracle_label) == 1
    resp = await _edit(
        client,
        world,
        created,
        lambda md: md.replace(
            oracle_label,
            "\n\nProposed by this spec (and decided too):\n\n- req-shipping-cost: free shipping"
            + oracle_label,
        ),
    )
    assert resp.status_code == 422, resp.text
    assert REFUSED in resp.text
    # Proposals after Oracle's own label may change.
    resp = await _edit(
        client,
        world,
        created,
        lambda md: md.replace(
            "- The quote refreshes when the cart changes.",
            "- The quote refreshes when the cart changes.\n- The quote shows a currency.",
        ),
    )
    assert resp.status_code == 201, resp.text


@pytest.mark.parametrize(
    "edit",
    [
        # The PROPOSED/ASSUMED label of an engineering section.
        lambda md: md.replace(contract.ASSUMED_LABEL + "\n\nA shipping quote service", "A shipping "
                              "quote service", 1),
        # Every label at once.
        lambda md: md.replace(contract.ASSUMED_LABEL + "\n\n", ""),
        # The no-map note on the assumptions.
        lambda md: md.replace(contract.NO_MAP_NOTE + "\n\nThe cart service", "The cart service"),
        # The intro's PRD version.
        lambda md: md.replace("(version 1). Product requirements", "(version 7). Product "
                              "requirements"),
        # The intro's PRD.
        lambda md: md.replace("from the approved PRD ", "from the draft PRD ", 1),
    ],
    ids=["one-label", "all-labels", "no-map-note", "intro-version", "intro-prd"],
)  # fmt: skip
async def test_labels_and_the_intro_line_cannot_be_edited(client, runtime, edit):
    world = await make_world(client)
    created = await generated(client, runtime, world)
    resp = await _edit(client, world, created, edit)
    assert resp.status_code == 422, resp.text
    assert REFUSED in resp.text


async def test_an_edit_is_checked_against_the_prd_versions_text_not_todays(client, runtime):
    world = await make_world(client)
    created = await generated(client, runtime, world)
    # The baseline changes after the spec was written from PRD v1.
    async with tenant_session(world.ctx.tenant_id) as s:
        await s.execute(
            update(Entity)
            .where(Entity.id == world.shipping)
            .values(title="Show shipping cost and free-shipping threshold")
        )
        await s.commit()
    resp = await _edit(
        client,
        world,
        created,
        lambda md: md.replace(
            "Show shipping cost on the cart**", "Show shipping cost and free-shipping threshold**"
        ),
    )
    assert resp.status_code == 422, resp.text
    assert REFUSED in resp.text
    # The text as Oracle wrote it from the PRD version still edits fine.
    resp = await _edit(
        client,
        world,
        created,
        lambda md: md.replace("A shipping quote service", "A cached shipping quote service"),
    )
    assert resp.status_code == 201, resp.text
