"""Runs started from Detailed (New PRD, its brief, Draft with Oracle).

Card (test_brief_run_reports_the_typed_title_before_the_import):
- protects: a Baseline-to-PRD run started from a brief whose PRD is not imported yet
  reports the title the person typed as its document_title (run, run list), never its
  slug in words ("E2e test x").
- fails_when: the run summary's document_title is null (or slug words) for a run with no
  document yet.
- no_claim: what the draft import writes.

Synthetic placeholders only.
"""

import pytest

from oracle.swarm import FakeRuntime, set_runtime
from tests.intake_helpers import company, create_intake


@pytest.fixture
def runtime():
    fake = FakeRuntime()
    set_runtime(fake)
    yield fake
    set_runtime(None)


async def test_brief_run_reports_the_typed_title_before_the_import(client, runtime):
    ctx = await company()
    typed = "Example test · Saved carts"
    out = await create_intake(client, ctx, who="approver", title=typed)
    resp = await client.post(
        f"/v1/intakes/{out['intake']['id']}/runs", json={}, headers=ctx.as_("approver")
    )
    assert resp.status_code == 201, resp.text
    run_id = resp.json()["id"]

    run = (await client.get(f"/v1/runs/{run_id}", headers=ctx.as_("approver"))).json()
    assert run["document_id"] is None
    assert run["document_slug"] == "example-test-saved-carts"
    assert run["document_title"] == typed

    rows = (await client.get("/v1/runs", headers=ctx.as_("approver"))).json()
    assert [r["document_title"] for r in rows if r["id"] == run_id] == [typed]


def test_an_earlier_workflow_being_stopped_reads_in_plain_words():
    """A workflow the run moved on from (it may have succeeded) is not worded as a failure,
    and no workflow id or step code reaches the reader."""
    from types import SimpleNamespace

    from oracle.runs.service import _searching

    run = SimpleNamespace(
        knobs={"searches": [{"id": "wf_example_1", "label": "eng_review-2", "seq": 3}]}
    )
    said = _searching(run)  # type: ignore[arg-type]
    assert said is not None
    assert "given up" not in said and "wf_example_1" not in said and "eng_review-2" not in said
    assert "unused steps of an earlier workflow" in said
