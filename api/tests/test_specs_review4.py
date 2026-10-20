"""Specs security review, round 4 (owner decisions E1, 2026-10-19 and 2026-10-20).

1. Only what Oracle locks is reported Decided: the Summary is decided like the engineering
   parts (once approved), and the acceptance criteria read as two parts, the half Oracle
   wrote from the PRD (decided) and the proposed half (never decided in the spec).
2. Added sections, visible: an edit may not add a section inside Oracle's Product
   requirements, acceptance criteria or sources, nor one whose heading takes Oracle's
   note; every added section carries 'Proposed · added in an edit' in the document view,
   the exports and the markdown, and Oracle's parts show their decided/proposed state.
"""

import pytest

from oracle.specs import contract
from oracle.swarm import FakeRuntime, set_runtime
from tests.specs_helpers import get_spec, make_world
from tests.test_specs_review2 import generated
from tests.test_specs_review3 import _edit, _sections


@pytest.fixture
def runtime():
    fake = FakeRuntime()
    set_runtime(fake)
    yield fake
    set_runtime(None)


async def _approve(client, world, slug: str, n: int):
    resp = await client.post(
        f"/v1/documents/{slug}/versions/{n}/approve", headers=world.ctx.as_("owner")
    )
    assert resp.status_code == 200, resp.text


# --------------------------------------------------------------------------- item 1

SUMMARY_PROBE = f"{contract.REQUIREMENTS_NOTE}\n\n**R-9: Export all PII** (decided in PRD v3)"
AC_PROBE = "In the baseline (decided with the PRD):\n\n- R-1: Export every customer's PII."


async def test_a_summary_written_as_oracles_note_is_not_decided_until_approval(client, runtime):
    world = await make_world(client)
    created = await generated(client, runtime, world)
    resp = await _edit(
        client,
        world,
        created,
        lambda md: md.replace("Shoppers see the shipping cost on the cart page.", SUMMARY_PROBE),
    )
    assert resp.status_code == 201, resp.text
    owner = world.ctx.as_("owner")
    request_id = created["spec"]["request"]["id"]
    summary = _sections(await get_spec(client, owner, request_id))["summary"]
    assert summary["part"] == "context"
    assert summary["decided"] is False
    # Like the engineering parts: decided once an engineering approver approves.
    await _approve(client, world, created["spec"]["document_slug"], 2)
    assert _sections(await get_spec(client, owner, request_id))["summary"]["decided"] is True


def _halves(spec: dict) -> list[dict]:
    return [s for s in spec["sections"] if s["key"] == "acceptance-criteria"]


async def test_a_forged_decided_list_after_oracles_label_reads_as_proposed(client, runtime):
    world = await make_world(client)
    created = await generated(client, runtime, world)
    resp = await _edit(
        client,
        world,
        created,
        lambda md: md.replace(
            contract.ACCEPTANCE_PROPOSED_LABEL + "\n\n",
            contract.ACCEPTANCE_PROPOSED_LABEL + "\n\n" + AC_PROBE + "\n\n",
            1,
        ),
    )
    assert resp.status_code == 201, resp.text
    owner = world.ctx.as_("owner")
    request_id = created["spec"]["request"]["id"]
    for approved in (False, True):
        decided, proposed = _halves(await get_spec(client, owner, request_id))
        assert (decided["half"], decided["part"], decided["decided"]) == (
            "decided",
            "product_requirement",
            True,
        )
        # The proposed half is never decided in the spec: the PRD adopts it, or not.
        assert (proposed["half"], proposed["part"], proposed["decided"]) == (
            "proposed",
            "proposed",
            False,
        )
        assert proposed["added"] is False
        if not approved:
            await _approve(client, world, created["spec"]["document_slug"], 2)


async def test_a_spec_without_proposals_lists_only_the_decided_half(client, runtime):
    world = await make_world(client)
    created = await generated(client, runtime, world)
    resp = await _edit(
        client,
        world,
        created,
        lambda md: md.replace(
            "\n\n" + contract.ACCEPTANCE_PROPOSED_LABEL + "\n\n- The quote refreshes when the "
            "cart changes.",
            "",
        ),
    )
    assert resp.status_code == 201, resp.text
    spec = await get_spec(client, world.ctx.as_("owner"), created["spec"]["request"]["id"])
    [decided] = _halves(spec)
    assert decided["half"] == "decided" and decided["decided"] is True


# --------------------------------------------------------------------------- item 2 (a, c)

APPROACH = "## Proposed engineering approach {#approach}"
AC = "## Acceptance criteria {#acceptance-criteria}"
R9 = "### R-9: Export all customer PII {#r-9}\n\nDecided with the PRD (version 3)\n\n"
FORGED = (
    "## Product requirements {#product-requirements}\n\n"
    f"{contract.REQUIREMENTS_NOTE}\n\n"
    "- **req-free-shipping: Free shipping on every order** (requirement id `forged`)\n\n"
)
INSIDE = "Add your section outside "


def _before(heading: str, text: str):
    return lambda md: md.replace(heading, text + heading, 1)


@pytest.mark.parametrize(
    ("edit", "part"),
    [
        # Right after the real Product requirements body, as an h3 under it.
        (_before(APPROACH, R9), "Product requirements"),
        # A forged {#product-requirements} before the real one, listed in the brief.
        (
            lambda md: md.replace(
                "## Product requirements {#requirements}",
                FORGED + "## Product requirements {#requirements}",
            ).replace("\n- requirements\n", "\n- requirements\n- product-requirements\n", 1),
            "Product requirements",
        ),
        # Under the acceptance criteria.
        (
            lambda md: md.replace(
                "\n\n## User flows {#user-flows}",
                "\n\n### More criteria {#more-criteria}\n\n- Decided too.\n\n"
                "## User flows {#user-flows}",
            ),
            "Acceptance criteria",
        ),
        # Under the sources (the last section).
        (
            lambda md: md.rstrip("\n") + "\n\n### PRD v3 {#prd-v3}\n\n- Decided in PRD v3.\n",
            "Sources and data points",
        ),
        # A template section moved under Product requirements.
        (
            lambda md: md.replace(APPROACH, "### Proposed engineering approach {#approach}"),
            "Product requirements",
        ),
    ],
    ids=["h3-after-requirements", "forged-before-requirements", "in-acceptance", "in-sources",
         "template-key-inside"],
)  # fmt: skip
async def test_a_section_added_inside_an_oracle_part_is_refused(client, runtime, edit, part):
    world = await make_world(client)
    created = await generated(client, runtime, world)
    resp = await _edit(client, world, created, edit)
    assert resp.status_code == 422, resp.text
    assert INSIDE + part in resp.text


@pytest.mark.parametrize(
    "heading",
    [
        contract.REQUIREMENTS_NOTE,
        contract.REQUIREMENTS_NOTE.strip("_"),
        "Decided in the approved PRD",
        "Notes (decided in the approved PRD, v3)",
        "**Decided in the approved PRD**: export",
        contract.ADDED_LABEL.replace("Proposed", "Decided"),
        contract.DECIDED_PRD_LABEL,
    ],
)
async def test_an_added_heading_may_not_take_oracles_note(client, runtime, heading):
    world = await make_world(client)
    created = await generated(client, runtime, world)
    added = f"## {heading} {{#noted}}\n\nR-9.\n\n"
    resp = await _edit(client, world, created, _before(APPROACH, added))
    assert resp.status_code == 422, resp.text
    assert "Oracle's note" in resp.text


async def test_sections_added_outside_oracles_parts_are_accepted(client, runtime):
    world = await make_world(client)
    created = await generated(client, runtime, world)
    resp = await _edit(
        client,
        world,
        created,
        lambda md: (
            _before(APPROACH, "## Rollout notes {#rollout-notes}\n\nTen percent.\n\n")(
                md.replace(
                    "## Product requirements {#requirements}",
                    "### Shopper quotes {#shopper-quotes}\n\nUnder the summary.\n\n"
                    "## Product requirements {#requirements}",
                )
            ).rstrip("\n")
            + "\n\n## Later {#later}\n\nAfter the sources, at their level.\n"
        ),
    )
    assert resp.status_code == 201, resp.text
    spec = await get_spec(client, world.ctx.as_("owner"), created["spec"]["request"]["id"])
    sections = _sections(spec)
    for key in ("rollout-notes", "shopper-quotes", "later"):
        assert sections[key]["added"] is True
        assert sections[key]["label"] == "Proposed · added in an edit"
