"""#556 item 2: a refusal stored before #403's wording reads the way #403 writes one now."""

from datetime import UTC, datetime

import pytest
from sqlalchemy import select

from oracle.claude_accounts.pool import readable_refusal
from oracle.docs.models import Document, DocumentVersion
from oracle.jobs.models import LlmJob
from oracle.tenancy import tenant_session
from oracle.tenant_settings_api import DEFAULTS
from tests.test_llm_jobs import SLUG, V, ctx, import_draft, jobs  # noqa: F401

# What a reporting job stored before #403: the earliest reset as raw UTC ISO.
OLD = (
    "No Claude account can take this call: every Claude account is spent; "
    "the earliest window clears 2026-10-25T22:00:00.475990+00:00"
)
NOW = (
    "No Claude account can take this call: every Claude account is spent; "
    "the earliest window clears Sun Oct 25, 3:00 PM PDT."
)


@pytest.fixture(autouse=True)
def company_in_los_angeles(monkeypatch):
    monkeypatch.setitem(DEFAULTS, "company_timezone", "America/Los_Angeles")


def test_a_raw_utc_time_reads_in_words_in_the_company_zone():
    assert readable_refusal(OLD, "America/Los_Angeles") == NOW
    assert readable_refusal(OLD, "Europe/London").endswith("clears Sun Oct 25, 10:00 PM GMT.")


def test_text_already_in_words_ends_its_sentence_once():
    assert readable_refusal(NOW, "America/Los_Angeles") == NOW
    paused = "No Claude account can take this call: every Claude account is paused"
    assert readable_refusal(paused, "America/Los_Angeles") == paused + "."


def test_other_errors_keep_their_words_but_lose_raw_times():
    assert readable_refusal(None, "America/Los_Angeles") is None
    assert readable_refusal("The model's answer was not JSON", "UTC") == (
        "The model's answer was not JSON"
    )
    assert readable_refusal("Rate limited until 2026-10-18T23:12:00Z", "America/Los_Angeles") == (
        "Rate limited until Sun Oct 18, 4:12 PM PDT"
    )


async def test_a_reports_row_and_the_jobs_list_show_a_stored_refusal_rewritten(client, ctx):
    await import_draft(client, ctx)
    async with tenant_session(ctx["tenant_id"]) as s:
        doc = (await s.execute(select(Document).where(Document.slug == SLUG))).scalar_one()
        version = (
            await s.execute(select(DocumentVersion).where(DocumentVersion.document_id == doc.id))
        ).scalar_one()
        for j in (await s.execute(select(LlmJob))).scalars():
            await s.delete(j)
        s.add(
            LlmJob(
                kind="reporting",
                document_id=doc.id,
                version_id=version.id,
                status="failed",
                attempts=1,
                error=OLD,
                error_reason="no_account_available",
                next_reset_at=datetime(2026, 10, 25, 22, tzinfo=UTC),
                finished_at=datetime(2026, 10, 18, 23, 12, tzinfo=UTC),
            )
        )
        await s.commit()

    reports = (await client.get(V(1, "/reports"), headers=ctx["headers"])).json()
    assert reports["latest_job"]["error"] == NOW
    assert [j["error"] for j in await jobs(client, ctx)] == [NOW]
    # The row stays as stored: the rewrite is at read time.
    async with tenant_session(ctx["tenant_id"]) as s:
        assert (await s.execute(select(LlmJob.error))).scalar_one() == OLD
