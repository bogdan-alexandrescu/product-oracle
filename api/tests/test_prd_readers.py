"""New PRD (2): 'Who reads and approves it?' takes several answers, stored as a list.

A brief's ``prd_answers.readers`` is a list (founder, product and engineering, ...); a
brief saved with one value before reads back as a one-item list, and the recommendation
reads every reader picked.

Each test's card is one line: protects / fails_when / no_claim. Synthetic placeholders
only.
"""

import uuid

import pytest

from oracle.templates.schemas import PrdAnswers
from oracle.templates.service import recommend_prd
from oracle.tenancy import tenant_session
from oracle.v2.models import ProductIntake
from tests.baseline_helpers import Ctx, make_ctx
from tests.intake_helpers import create_intake, summary


@pytest.fixture
async def ctx() -> Ctx:
    return await make_ctx()


async def test_the_brief_stores_several_readers_as_a_list(client, ctx):
    """protects=New PRD (2) (several readers are stored as a list and read back in order);
    fails_when=the API refuses a list, keeps only one, or reads them back as a string;
    no_claim=the form's chips (web e2e new-prd-readers)."""
    readers = ["founder", "product_eng", "engineers_or_agents"]
    out = await create_intake(client, ctx, prd_answers={"readers": readers, "model_driven": True})
    intake_id = out["intake"]["id"]
    async with tenant_session(ctx.tenant_id) as s:
        row = await s.get(ProductIntake, uuid.UUID(intake_id))
        assert row.prd_answers["readers"] == readers
    seen = await summary(client, ctx, intake_id)
    assert seen["intake"]["prd_answers"]["readers"] == readers


async def test_a_single_reader_saved_before_reads_as_a_one_item_list(client, ctx):
    """protects=New PRD (2) (an existing single value reads as a one-item list);
    fails_when=a brief saved with readers "founder" fails to load or reads as a string;
    no_claim=a data migration (none: the read turns it into a list)."""
    out = await create_intake(client, ctx)
    intake_id = out["intake"]["id"]
    async with tenant_session(ctx.tenant_id) as s:
        row = await s.get(ProductIntake, uuid.UUID(intake_id))
        row.prd_answers = {"readers": "founder"}
        await s.commit()
    seen = await summary(client, ctx, intake_id)
    assert seen["intake"]["prd_answers"]["readers"] == ["founder"]
    assert PrdAnswers.model_validate({"readers": "leadership"}).readers == ["leadership"]
    assert PrdAnswers.model_validate({"readers": None}).readers is None


def test_the_recommendation_reads_every_reader():
    """protects=New PRD (2) (the template follows any reader picked: leadership among
    several still gets the memo); fails_when=a list of readers is ignored; no_claim=the
    other rules' order (test_drafts_export)."""
    many = PrdAnswers(readers=["founder", "leadership"])
    assert recommend_prd(many)[0] == "narrative-memo"
    small = PrdAnswers(size="small_change", readers=["founder"])
    assert recommend_prd(small)[0] == "one-pager"
    mixed = PrdAnswers(size="small_change", readers=["founder", "product_eng"])
    assert recommend_prd(mixed)[0] == "oracle-default"
    builders = PrdAnswers(readers=["product_eng", "engineers_or_agents"])
    assert recommend_prd(builders)[0] == "oracle-default"
