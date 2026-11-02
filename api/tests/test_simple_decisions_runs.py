"""build-rundecide RD1 a: Simple › Decisions lists each run's decided stops as a Runs group
(``runs`` on ``GET /v1/simple/decisions``). Against Postgres.

Test cards (protects / fails_when / no_claim):

- test_runs_group_lists_each_stop: protects=a run on a readable PRD is one group named
  after the PRD ("Payments plan"), its decided stops in order, each with the person's name,
  role, note and the company's day; a stop sent back and then approved is one row,
  "Approved after a change", whose trail has both steps; a pending stop is not listed;
  fails_when=the field is missing, a stop is split in two, or names are left out;
  no_claim=the run pages (tests.test_runs_*).
"""

import datetime as dt

from sqlalchemy import select

from oracle.docs.models import Document
from oracle.runs.models import Checkpoint, Run
from oracle.tenancy import tenant_session
from tests.test_simple_changes_api import clock as clock  # noqa: F401
from tests.test_simple_meetings_api import PRD, world

AT = dt.datetime(2026, 10, 20, 18, 0, tzinfo=dt.UTC)


async def test_runs_group_lists_each_stop(client):
    w = await world()
    owner, lead = w.ctx.users["owner"], w.ctx.users["approver"]
    async with tenant_session(w.ctx.tenant_id) as s:
        prd = await s.scalar(select(Document).where(Document.slug == PRD))
        run = Run(flow="baseline_to_prd", document_id=prd.id, created_by=owner.id, status="running")
        s.add(run)
        await s.flush()

        def stop(kind, status, by, days, note=None, seq=1, attempt=1):
            return Checkpoint(
                run_id=run.id, kind=kind, status=status, approver_role="approver",
                decided_by=by.id if by else None,
                decided_at=AT + dt.timedelta(days=days) if by else None, note=note,
                payload={"segment_seq": seq, "attempt": attempt,
                         "decided": {"role": "owner" if by is owner else "approver",
                                     "by": str(by.id)} if by else None} if by else
                {"segment_seq": seq},
            )  # fmt: skip

        s.add_all([
            stop("feature_set", "approved", owner, 0, "Keep the weekly digest.", seq=1),
            stop("eng_review", "changes_requested", lead, 1, "Needs a zone per workspace.", seq=2),
            stop("eng_review", "approved", lead, 2, "Quiet hours follow the zone.", seq=2,
                 attempt=2),
            stop("priority_order", "pending", None, 0, seq=3),
        ])  # fmt: skip
        await s.commit()
    r = await client.get("/v1/simple/decisions", headers=w.ctx.as_("owner"))
    assert r.status_code == 200, r.text
    groups = r.json()["runs"]
    assert len(groups) == 1
    g = groups[0]
    assert g["name"] == "Payments plan"
    assert g["prd"]["id"] == PRD
    rows = [(x["stop"], x["outcome"], x["role"], x["note"]) for x in g["stops"]]
    assert rows == [
        ("Feature set", "Approved", "owner", "Keep the weekly digest."),
        ("Engineering check", "Approved after a change", "approver",
         "Quiet hours follow the zone."),
    ]  # fmt: skip
    first, check = g["stops"]
    assert first["who"] and first["day"] == "2026-10-20" and first["trail"] == []
    assert [(t["what"], t["day"], t["note"]) for t in check["trail"]] == [
        ("Sent back", "2026-10-21", "Needs a zone per workspace."),
        ("Approved", "2026-10-22", "Quiet hours follow the zone."),
    ]
