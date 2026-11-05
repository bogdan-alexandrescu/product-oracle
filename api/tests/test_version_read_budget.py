"""A PRD's version page, first load: ``GET /v1/documents/<doc>/versions/<n>`` and
``GET /v1/documents/<doc>/feedback`` answer in a fixed number of statements and well under
a second for a PRD the size of a real one (49 sections, 50 sources cited many times, 7
versions, a run's draft under review, comments, section verdicts and feedback on every
version), however long the company's audit log has grown.

Before: the version read looked up who imported it (a run's draft reads "Oracle") and
whether it was imported again in the audit log, by action and entity, with no index but the
company's: each read scanned every audit event the company ever wrote (1 M events: about
2 s; a production log took the page about 30 s, and the feedback read waited on the same
busy database).

Integration tests against Postgres, with invented example data only.

Test cards (protects / fails_when / no_claim) head each test.
"""

import time
import uuid

from sqlalchemy import event, select, text

from oracle.db import get_engine
from oracle.docs.models import Document, DocumentVersion
from oracle.models import AuditEvent
from oracle.review.models import FeedbackItem
from oracle.tenancy import tenant_session
from tests.fixtures import import_draft, seed_auth

DOC = "example-big-prd"
SECTIONS = 49  # the title and 48 numbered parts
SOURCES = 50
VERSIONS = 7
# The company's audit log: other companies' work and older events, none about this PRD.
AUDIT_EVENTS = 300_000
# Each read's statements, the sign-in's two included (measured 15 and 11, the feedback's
# with the verdicts of its changes asked): the same whatever the number of sections,
# citations, versions, comments or feedback items.
MAX_VERSION_READS = 15
MAX_FEEDBACK_READS = 11
# Each read's budget at this size (measured, after the fix, about 0.05 s and 0.08 s).
MAX_SECONDS = 1.0


def big_prd(version: int) -> str:
    """A PRD the size of a real one: 50 sources, each of 48 parts citing six of them in
    every one of its paragraphs."""
    sources = "".join(
        f"  - id: c{i}\n    source: gdocs\n    ref: https://docs.example.com/d/note-{i}\n"
        f'    title: Example research note {i}\n    excerpt: "Shoppers said thing {i}"\n'
        "    retrieved_at: 2026-10-16T13:10Z\n"
        for i in range(SOURCES)
    )
    parts = []
    for s in range(SECTIONS - 1):
        cites = " ".join(f"[c:c{(s + k) % SOURCES}]" for k in range(6))
        paragraphs = "\n\n".join(
            f"Paragraph {p} of part {s} in draft {version}: shoppers want a faster "
            f"checkout with fewer steps and clear prices {cites}."
            for p in range(12)
        )
        parts.append(f"## {s + 1}. Part {s} {{#part-{s}}}\n\n{paragraphs}\n\n- One\n- Two\n")
    return (
        f"---\ndocument: {DOC}\ntitle: Example big PRD\ntemplate: oracle-default\n"
        f'template_version: "1"\nsnapshot: 2026-10-16T14:00Z\ncitations:\n{sources}---\n\n'
        "# Example big PRD {#title}\n\nOwner: product.\n\n" + "\n".join(parts)
    )


async def seed_big_prd(client, tenant_id, auth) -> None:
    for v in range(1, VERSIONS + 1):
        resp = await import_draft(client, auth, big_prd(v), DOC)
        assert resp.status_code == 201, resp.text[:2000]
    base = f"/v1/documents/{DOC}/versions/{VERSIONS}"
    for s in range(0, SECTIONS - 1, 2):
        resp = await client.post(
            f"{base}/comments",
            json={
                "section_key": f"part-{s}",
                "anchor": {"exact": "shoppers want"},
                "body": f"Example remark on part {s}",
                "severity": "minor",
            },
            headers=auth,
        )
        assert resp.status_code == 201, resp.text
    for s in range(1, 20, 2):
        verdict = "approved" if s % 4 == 1 else "changes_requested"
        resp = await client.put(
            f"{base}/sections/part-{s}/review",
            json={"verdict": verdict, "note": None if verdict == "approved" else "Tighten it"},
            headers=auth,
        )
        assert resp.status_code == 200, resp.text
    async with tenant_session(tenant_id) as s:
        document = await s.scalar(select(Document).where(Document.slug == DOC))
        latest = await s.scalar(
            select(DocumentVersion).where(
                DocumentVersion.document_id == document.id, DocumentVersion.number == VERSIONS
            )
        )
        # Feedback raised on every earlier draft, most of it settled.
        for v in range(1, VERSIONS):
            for i in range(25):
                s.add(
                    FeedbackItem(
                        document_id=document.id,
                        raised_on_version=v,
                        kind="general",
                        summary=f"Example point {i + 1} on draft {v}",
                        status="addressed" if i % 3 else "open",
                    )
                )
        # The latest draft is a run's (its import's audit event names the run), and its
        # run review is open on it.
        s.add(
            AuditEvent(
                actor="oracle",
                action="document.version_imported",
                entity="document_version",
                entity_id=latest.id,
                data={"document_id": str(document.id), "run_id": str(uuid.uuid4())},
            )
        )
        await s.flush()
        await s.execute(
            text(
                "INSERT INTO audit_events (id, tenant_id, actor, action, entity, entity_id, data)"
                " SELECT gen_random_uuid(), :tenant, 'user:example', (ARRAY['comment.created',"
                " 'document.version_imported', 'feedback.updated', 'run.checkpoint_opened',"
                " 'job.succeeded'])[1 + g % 5], 'example', gen_random_uuid(),"
                " jsonb_build_object('document_id', md5((g % 300)::text), 'run_id', md5(g::text),"
                " 'note', repeat('example ', 1 + g % 40))"
                " FROM generate_series(1, :n) g"
            ),
            {"tenant": tenant_id, "n": AUDIT_EVENTS},
        )
        await s.commit()
    async with get_engine().connect() as conn:
        await conn.execute(text("ANALYZE audit_events"))
        await conn.commit()


async def read(client, auth, url: str) -> tuple[list[tuple[str, tuple]], float, dict]:
    """GET ``url``: its statements (with their parameters), its seconds and its body."""
    statements: list[tuple[str, tuple]] = []

    def count(conn, cursor, statement, parameters, *args):
        statements.append((statement, tuple(parameters or ())))

    engine = get_engine().sync_engine
    event.listen(engine, "before_cursor_execute", count)
    try:
        start = time.perf_counter()
        resp = await client.get(url, headers=auth)
        seconds = time.perf_counter() - start
    finally:
        event.remove(engine, "before_cursor_execute", count)
    assert resp.status_code == 200, resp.text
    return [st for st in statements if "SAVEPOINT" not in st[0]], seconds, resp.json()


async def plans(statements: list[tuple[str, tuple]]) -> list[str]:
    """Postgres's plan of each statement that reads the audit log, with its parameters."""
    out = []
    async with get_engine().connect() as conn:
        for statement, parameters in statements:
            if "FROM audit_events" in statement:
                rows = await conn.exec_driver_sql(f"EXPLAIN {statement}", parameters)
                out.append("\n".join(r[0] for r in rows))
    return out


async def test_a_big_prds_version_page_reads_in_a_fixed_budget(client):
    """protects=the version page of a 49-section PRD with 50 sources, 7 versions, a run's
    draft under review, comments, verdicts and feedback shows within a second: the version
    and the feedback reads each answer in a fixed number of statements and under a second,
    and neither scans the company's audit log; fails_when=a read looks something up in the
    audit log without an index that narrows it to the event (a scan of every event the
    company wrote), a statement is read per section, citation, version or feedback item, or
    a read takes a second or more; no_claim=the network, the web proxy and the browser's
    drawing time."""
    tenant_id, auth = await seed_auth()
    await seed_big_prd(client, tenant_id, auth)
    version_url = f"/v1/documents/{DOC}/versions/{VERSIONS}"
    feedback_url = f"/v1/documents/{DOC}/feedback"
    # A first read of each builds what a process builds once (its models' validators).
    await read(client, auth, version_url)
    await read(client, auth, feedback_url)

    statements, seconds, version = await read(client, auth, version_url)
    assert len(version["sections"]) == SECTIONS
    assert len(version["citations"]) == SOURCES
    assert version["imported_by_name"] == "Oracle"
    assert len(statements) <= MAX_VERSION_READS, [s for s, _ in statements]
    for plan in await plans(statements):
        assert "Seq Scan on audit_events" not in plan, plan
    assert seconds < MAX_SECONDS, f"the version read took {seconds:.2f} s"

    statements, seconds, feedback = await read(client, auth, feedback_url)
    # Every draft's: the earlier ones' points, the comments and the changes asked.
    assert len(feedback) == (VERSIONS - 1) * 25 + len(range(0, SECTIONS - 1, 2)) + 5
    assert len(statements) <= MAX_FEEDBACK_READS, [s for s, _ in statements]
    for plan in await plans(statements):
        assert "Seq Scan on audit_events" not in plan, plan
    assert seconds < MAX_SECONDS, f"the feedback read took {seconds:.2f} s"
