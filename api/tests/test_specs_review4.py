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
