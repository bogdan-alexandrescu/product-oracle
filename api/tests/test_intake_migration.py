"""Migration 0014_intake: additive on 0013, document jobs untouched, reversible.

Sync tests on purpose (Alembic runs its own event loop); own scratch database.
"""

import asyncio
import uuid

import pytest
from alembic import command
from alembic.config import Config
from alembic.script import ScriptDirectory
from sqlalchemy import text
from sqlalchemy.engine import make_url

from tests.conftest import API_DIR, TEST_DATABASE_URL, _reset_schema

SCRATCH_URL = (
    make_url(TEST_DATABASE_URL)
    .set(database=make_url(TEST_DATABASE_URL).database + "_migrations_intake")
    .render_as_string(hide_password=False)
)


def _cfg() -> Config:
    cfg = Config(str(API_DIR / "alembic.ini"))
    cfg.attributes["database_url"] = SCRATCH_URL
    return cfg


def _run(sql: str, **params):
    async def go():
        from sqlalchemy.ext.asyncio import create_async_engine

        engine = create_async_engine(SCRATCH_URL)
        async with engine.begin() as conn:
            result = await conn.execute(text(sql), params)
            rows = result.all() if result.returns_rows else None
        await engine.dispose()
        return rows

    return asyncio.run(go())


@pytest.fixture
def scratch_db():
    asyncio.run(_reset_schema(SCRATCH_URL))
    yield
    asyncio.run(_reset_schema(SCRATCH_URL))


def test_0014_intake_chains_after_mains_head():
    script = ScriptDirectory.from_config(_cfg())
    assert script.get_revision("0014_intake").down_revision == "0019_citation_confidence"
    # The PRD review chain (0014_review ... 0014_member_follow_up_retry) chains on it and
    # v2-specs 0015_specs on that.
    assert script.get_revision("0014_review").down_revision == "0018_source_unavailable_items"
    assert script.get_heads() == ["0090_interview_new_link"]


def test_widened_checks_keep_other_lanes_values(scratch_db):
    """The kind check is extended from what the database holds: 0014_quality's
    ``quality_review`` survives the upgrade and the downgrade (round 10)."""
    cfg = _cfg()
    command.upgrade(cfg, "0014_blockers_snapshot")
    t, doc = uuid.uuid4(), uuid.uuid4()
    _run("INSERT INTO tenants (id, name) VALUES (:t, 'Example Co')", t=t)
    _run(
        "INSERT INTO documents (id, tenant_id, slug, title, status) "
        "VALUES (:d, :t, 'legacy', 'Legacy', 'draft')",
        d=doc,
        t=t,
    )
    insert = (
        "INSERT INTO llm_jobs (id, tenant_id, kind, document_id, status) "
        "VALUES (gen_random_uuid(), :t, 'quality_review', :d, 'queued')"
    )
    command.upgrade(cfg, "0014_intake")
    _run(insert, t=t, d=doc)
    command.downgrade(cfg, "0014_blockers_snapshot")
    _run(insert, t=t, d=doc)
    assert _run("SELECT count(*) FROM llm_jobs WHERE kind = 'quality_review'") == [(2,)]


def test_upgrade_keeps_document_jobs_and_downgrade_reverses(scratch_db):
    cfg = _cfg()
    command.upgrade(cfg, "0013")
    t, doc = uuid.uuid4(), uuid.uuid4()
    _run("INSERT INTO tenants (id, name) VALUES (:t, 'Example Co')", t=t)
    _run(
        "INSERT INTO documents (id, tenant_id, slug, title, status) "
        "VALUES (:d, :t, 'legacy', 'Legacy', 'draft')",
        d=doc,
        t=t,
    )
    _run(
        "INSERT INTO llm_jobs (id, tenant_id, kind, document_id, status) "
        "VALUES (gen_random_uuid(), :t, 'reporting', :d, 'queued')",
        t=t,
        d=doc,
    )

    command.upgrade(cfg, "0014_intake")
    assert _run("SELECT kind, document_id, intake_id FROM llm_jobs") == [("reporting", doc, None)]
    intake = uuid.uuid4()
    _run(
        "INSERT INTO product_intakes (id, tenant_id, title, brief) "
        "VALUES (:i, :t, 'Saved addresses', 'Returning buyers retype addresses.')",
        i=intake,
        t=t,
    )
    _run(
        "INSERT INTO llm_jobs (id, tenant_id, kind, intake_id, status) "
        "VALUES (gen_random_uuid(), :t, 'intake_analysis', :i, 'queued')",
        t=t,
        i=intake,
    )
    _run(
        "INSERT INTO intake_proposals (id, tenant_id, intake_id, kind, title) "
        "VALUES (gen_random_uuid(), :t, :i, 'research_run', 'Research the metric')",
        t=t,
        i=intake,
    )
    # A job belongs to a document or an intake; a proposal kind is checked.
    with pytest.raises(Exception, match="ck_llm_jobs_subject"):
        _run(
            "INSERT INTO llm_jobs (id, tenant_id, kind, status) "
            "VALUES (gen_random_uuid(), :t, 'reporting', 'queued')",
            t=t,
        )
    with pytest.raises(Exception, match="ck_intake_proposals_kind"):
        _run(
            "INSERT INTO intake_proposals (id, tenant_id, intake_id, kind, title) "
            "VALUES (gen_random_uuid(), :t, :i, 'run_now', 'x')",
            t=t,
            i=intake,
        )

    command.downgrade(cfg, "0013")
    assert _run("SELECT kind FROM llm_jobs") == [("reporting",)]
    with pytest.raises(Exception, match="ck_llm_jobs_kind"):
        _run(
            "INSERT INTO llm_jobs (id, tenant_id, kind, document_id, status) "
            "VALUES (gen_random_uuid(), :t, 'intake_analysis', :d, 'queued')",
            t=t,
            d=doc,
        )
    command.upgrade(cfg, "0014_intake")
    assert _run("SELECT count(*) FROM intake_proposals") == [(0,)]


def test_rule_made_gaps_are_keyed_by_category_not_by_text(scratch_db):
    """Round 3 (S6): a rule-made gap carries its category key, backfilled from the
    statements as they stand at this revision; model and person gaps carry none."""
    cfg = _cfg()
    command.upgrade(cfg, "0013")
    t, intake, person = uuid.uuid4(), uuid.uuid4(), uuid.uuid4()
    _run("INSERT INTO tenants (id, name) VALUES (:t, 'Example Co')", t=t)
    _run(
        "INSERT INTO product_intakes (id, tenant_id, title, brief) "
        "VALUES (:i, :t, 'Saved addresses', 'Returning buyers retype addresses.')",
        i=intake,
        t=t,
    )
    rows = {
        "rule": ("ownership", "No team or person owns the outcome.", None),
        "model": ("ownership", "Is the checkout team staffed for this?", None),
        "person": ("ownership", "No team or person owns the outcome.", person),
    }
    ids = {}
    for name, (category, statement, created_by) in rows.items():
        ids[name] = uuid.uuid4()
        _run(
            "INSERT INTO knowledge_gaps (id, tenant_id, intake_id, category, statement, "
            "impact, importance, created_by) VALUES (:g, :t, :i, :c, :s, '{}', 'high', :by)",
            g=ids[name], t=t, i=intake, c=category, s=statement, by=created_by,
        )  # fmt: skip
    command.upgrade(cfg, "0014_intake")
    keys = dict(_run("SELECT id, rule_key FROM knowledge_gaps"))
    assert keys == {ids["rule"]: "ownership", ids["model"]: None, ids["person"]: None}
    command.downgrade(cfg, "0013")
    columns = _run(
        "SELECT column_name FROM information_schema.columns WHERE table_name = 'knowledge_gaps'"
    )
    assert ("rule_key",) not in columns


def test_existing_intakes_withhold_everything_their_analysis_names(scratch_db):
    """Round 5 (S6, owner 2026-10-19): an intake analysed before reads were recorded
    withholds, fail closed, every item its stored analysis names from its author's
    runs; the legacy importance rows get their index."""
    import json

    cfg = _cfg()
    command.upgrade(cfg, "0013")
    t, intake, author = uuid.uuid4(), uuid.uuid4(), uuid.uuid4()
    ids = [str(uuid.uuid4()) for _ in range(6)]
    _run("INSERT INTO tenants (id, name) VALUES (:t, 'Example Co')", t=t)
    analysis = {
        "relevant_item_ids": [ids[0]],
        "stale": [{"item_id": ids[1], "freshness": 0.1}],
        "conflicts": [{"claims": [{"item_id": ids[2]}, {"item_id": ids[0]}]}],
        "findings": {
            "f1": {"kind": "gap", "source_item_ids": [ids[3]], "sharing": "full"},
            "f2": {"kind": "gap", "evidence_ids": [ids[4]]},
        },
    }
    _run(
        "INSERT INTO product_intakes (id, tenant_id, title, brief, author_id, analysis) "
        "VALUES (:i, :t, 'Saved addresses', 'Returning buyers.', :a, CAST(:an AS jsonb))",
        i=intake,
        t=t,
        a=author,
        an=json.dumps(analysis),
    )
    command.upgrade(cfg, "0014_intake")
    rows = _run("SELECT intake_id, user_id, item_id FROM intake_withheld_items")
    assert {(r[0], r[1]) for r in rows} == {(intake, author)}
    assert sorted(str(r[2]) for r in rows) == sorted(ids[:5])
    names = [r[0] for r in _run("SELECT indexname FROM pg_indexes")]
    assert "ix_knowledge_gaps_legacy_importance" in names
    command.downgrade(cfg, "0013")
    command.upgrade(cfg, "0014_intake")


def test_the_backfills_skip_malformed_item_ids_and_record_full_findings(scratch_db):
    """Round 6: a stored analysis naming an id that is not a UUID never aborts the
    migration (the id is skipped); the items findings shared in full cite are recorded
    (intake_shared_items); proposals may be withdrawn."""
    import json

    cfg = _cfg()
    command.upgrade(cfg, "0013")
    t, intake, author = uuid.uuid4(), uuid.uuid4(), uuid.uuid4()
    ids = [str(uuid.uuid4()) for _ in range(3)]
    _run("INSERT INTO tenants (id, name) VALUES (:t, 'Example Co')", t=t)
    analysis = {
        "read_item_ids": [ids[0], "not-a-uuid"],
        "stale": [{"item_id": "", "freshness": 0.1}],
        "findings": {
            "f1": {"kind": "gap", "source_item_ids": [ids[1], "item-7"], "sharing": "full"},
            "f2": {"kind": "gap", "source_item_ids": [ids[2]], "sharing": "summary"},
        },
    }
    _run(
        "INSERT INTO product_intakes (id, tenant_id, title, brief, author_id, analysis) "
        "VALUES (:i, :t, 'Saved addresses', 'Returning buyers.', :a, CAST(:an AS jsonb))",
        i=intake,
        t=t,
        a=author,
        an=json.dumps(analysis),
    )
    command.upgrade(cfg, "0014_intake")
    withheld = _run("SELECT item_id FROM intake_withheld_items")
    assert sorted(str(r[0]) for r in withheld) == sorted(ids)
    # Round 7 (freeze at sharing): the item's version at the pin cannot be determined
    # (no pin, no such item), so nothing is released; it stays withheld.
    shared = _run("SELECT intake_id, user_id, item_id FROM intake_shared_items")
    assert shared == []
    checks = _run(
        "SELECT pg_get_constraintdef(oid) FROM pg_constraint WHERE conname = 'ck_proposals_status'"
    )
    assert "withdrawn" in checks[0][0]
    command.downgrade(cfg, "0013")
    command.upgrade(cfg, "0014_intake")


def test_full_shares_are_frozen_at_the_pins_versions_and_null_findings_migrate(scratch_db):
    """Round 7 (freeze at sharing, owner 2026-10-19): an existing full share releases
    the version each cited item had at the intake's pin, recorded in the finding and in
    intake_shared_items; an item with no version at the pin, or deleted, is not
    released (fail closed). A JSON-null findings value never aborts the migration."""
    import json
    from datetime import UTC, datetime

    JAN, MAR = datetime(2026, 1, 1, tzinfo=UTC), datetime(2026, 3, 1, tzinfo=UTC)
    cfg = _cfg()
    command.upgrade(cfg, "0013")
    t, author = uuid.uuid4(), uuid.uuid4()
    intake, other, nulls = uuid.uuid4(), uuid.uuid4(), uuid.uuid4()
    source, snap = uuid.uuid4(), uuid.uuid4()
    pinned, late, gone = uuid.uuid4(), uuid.uuid4(), uuid.uuid4()
    v1, v2, v3, v4 = (uuid.uuid4() for _ in range(4))
    _run("INSERT INTO tenants (id, name) VALUES (:t, 'Example Co')", t=t)
    _run(
        "INSERT INTO users (id, tenant_id, email, password_hash, role) "
        "VALUES (:u, :t, 'author@example.com', 'x', 'commenter')",
        u=author,
        t=t,
    )
    _run(
        "INSERT INTO sources (id, tenant_id, owner_user_id, kind, name, status) "
        "VALUES (:s, :t, :u, 'slack', 'slack-1', 'active')",
        s=source,
        t=t,
        u=author,
    )
    for item, deleted in ((pinned, False), (late, False), (gone, True)):
        _run(
            "INSERT INTO source_items (id, tenant_id, source_id, external_id, kind, deleted_at) "
            "VALUES (:i, :t, :s, :e, 'message', CASE WHEN :d THEN now() END)",
            i=item, t=t, s=source, e=str(item), d=deleted,
        )  # fmt: skip
    # pinned: v1 before the pin, v2 after it; late: only v3, after it; gone: v4 before.
    for version, item, when in (
        (v1, pinned, JAN), (v2, pinned, MAR), (v3, late, MAR), (v4, gone, JAN),
    ):  # fmt: skip
        _run(
            "INSERT INTO source_item_versions (id, tenant_id, item_id, content, content_hash, "
            "fetched_at) VALUES (:v, :t, :i, 'Returning buyers.', 'h', :w)",
            v=version, t=t, i=item, w=when,
        )  # fmt: skip
    _run(
        "INSERT INTO snapshots (id, tenant_id, label, as_of) VALUES (:s, :t, 'pin', :w)",
        s=snap,
        t=t,
        w=JAN.replace(month=2),
    )
    ids = [str(pinned), str(late), str(gone)]
    rows = {
        intake: {"read_item_ids": ids, "findings": {
            "f1": {"kind": "gap", "source_item_ids": ids, "sharing": "full"},
            "f2": {"kind": "gap", "source_item_ids": [str(pinned)], "sharing": "summary"},
            "f3": None,
        }},
        other: {"read_item_ids": [str(pinned)], "findings": {
            "f1": {"kind": "gap", "source_item_ids": [str(pinned)], "sharing": "full"}}},
        nulls: {"read_item_ids": None, "stale": None, "conflicts": [{"claims": None}],
                "findings": None},
    }  # fmt: skip
    for intake_id, analysis in rows.items():
        # ``other`` has no pin: nothing it cites can be released.
        pins = "ARRAY[CAST(:p AS uuid)]" if intake_id == intake else "CAST('{}' AS uuid[])"
        _run(
            "INSERT INTO product_intakes (id, tenant_id, title, brief, author_id, analysis, "
            f"source_snapshot_ids) VALUES (:i, :t, 'Saved addresses', 'Returning buyers.', "
            f":a, CAST(:an AS jsonb), {pins})",
            i=intake_id, t=t, a=author, an=json.dumps(analysis),
            **({"p": snap} if intake_id == intake else {}),
        )  # fmt: skip
    command.upgrade(cfg, "0014_intake")
    shared = _run("SELECT intake_id, item_id, version_id FROM intake_shared_items")
    assert [tuple(r) for r in shared] == [(intake, pinned, v1)]
    [[analysis]] = _run("SELECT analysis FROM product_intakes WHERE id = :i", i=intake)
    assert analysis["findings"]["f1"]["frozen"] == {str(pinned): str(v1)}
    assert "frozen" not in analysis["findings"]["f2"] and analysis["findings"]["f3"] is None
    [[analysis]] = _run("SELECT analysis FROM product_intakes WHERE id = :i", i=other)
    assert analysis["findings"]["f1"]["frozen"] == {}
    # Everything they read stays withheld until the next analysis (round 5).
    withheld = _run("SELECT intake_id, item_id FROM intake_withheld_items")
    assert {(r[0], str(r[1])) for r in withheld} == {(intake, i) for i in ids} | {
        (other, str(pinned))
    }
    command.downgrade(cfg, "0013")
    command.upgrade(cfg, "0014_intake")


def test_versions_keep_their_link_and_notion_links_lose_the_title(scratch_db):
    """Round 9 (links, owner 2026-10-20): every existing version gets a link built from
    its item's id only, never the item's current link, which can carry a name that
    changed after sharing: a Notion page's id-only link, a Fireflies transcript's id, a
    Google Doc's file id, a GitHub issue or pull request under the repository its source
    names; a Slack permalink (ids only) as it is. An id not of the expected form, a
    GitHub release and an upload get none (fail closed)."""
    cfg = _cfg()
    command.upgrade(cfg, "0013")
    t, author = uuid.uuid4(), uuid.uuid4()
    slack, notion, fireflies, gdocs, github, upload = (uuid.uuid4() for _ in range(6))
    message, page, odd = uuid.uuid4(), uuid.uuid4(), uuid.uuid4()
    meeting, doc, issue, pull, release, file_ = (uuid.uuid4() for _ in range(6))
    page_id = "1f2e3d4c-5b6a-4987-8a1b-2c3d4e5f6a7b"
    _run("INSERT INTO tenants (id, name) VALUES (:t, 'Example Co')", t=t)
    _run(
        "INSERT INTO users (id, tenant_id, email, password_hash, role) "
        "VALUES (:u, :t, 'author@example.com', 'x', 'commenter')",
        u=author,
        t=t,
    )
    for source, kind in (
        (slack, "slack"), (notion, "notion"), (fireflies, "fireflies"),
        (gdocs, "google_docs"), (github, "github"), (upload, "upload"),
    ):  # fmt: skip
        _run(
            "INSERT INTO sources (id, tenant_id, owner_user_id, kind, name, status) "
            "VALUES (:s, :t, :u, :k, :k, 'active')",
            s=source, t=t, u=author, k=kind,
        )  # fmt: skip
    for item, source, external, url in (
        (message, slack, "C1-p1", "https://chat.example.com/archives/C1/p1"),
        (page, notion, page_id, "https://www.notion.so/Acquisition-of-Example-Corp-1f2e3d4c"),
        (odd, notion, "not-a-page-id", "https://www.notion.so/Acquisition-of-Example-Corp"),
        (
            meeting,
            fireflies,
            "01TRANSCRIPT9",
            "https://app.fireflies.ai/view/Acquisition-of-Example-Corp::01TRANSCRIPT9",
        ),
        (
            doc,
            gdocs,
            "1AbC_dEf-2",
            "https://docs.google.com/document/d/1AbC_dEf-2/edit?usp=drivesdk",
        ),
        (
            issue,
            github,
            "example/checkout:issue:42",
            "https://github.com/example/acquisition-of-example-corp/issues/42",
        ),
        (
            pull,
            github,
            "example/checkout:pull:7",
            "https://github.com/example/acquisition-of-example-corp/pull/7",
        ),
        (
            release,
            github,
            "example/checkout:release:991",
            "https://github.com/example/acquisition-of-example-corp/releases/tag/v1",
        ),
        (file_, upload, "notes.md", None),
    ):
        _run(
            "INSERT INTO source_items (id, tenant_id, source_id, external_id, kind, url) "
            "VALUES (:i, :t, :s, :e, 'page', :u)",
            i=item, t=t, s=source, e=external, u=url,
        )  # fmt: skip
        _run(
            "INSERT INTO source_item_versions (id, tenant_id, item_id, content, content_hash) "
            "VALUES (gen_random_uuid(), :t, :i, 'Returning buyers.', 'h')",
            t=t, i=item,
        )  # fmt: skip
    command.upgrade(cfg, "0014_intake")
    links = dict(_run("SELECT item_id, url FROM source_item_versions"))
    assert links == {
        message: "https://chat.example.com/archives/C1/p1",
        page: "https://www.notion.so/1f2e3d4c5b6a49878a1b2c3d4e5f6a7b",
        odd: None,
        meeting: "https://app.fireflies.ai/view/01TRANSCRIPT9",
        doc: "https://docs.google.com/document/d/1AbC_dEf-2/edit",
        issue: "https://github.com/example/checkout/issues/42",
        pull: "https://github.com/example/checkout/pull/7",
        release: None,
        file_: None,
    }
    command.downgrade(cfg, "0013")
    command.upgrade(cfg, "0014_intake")
