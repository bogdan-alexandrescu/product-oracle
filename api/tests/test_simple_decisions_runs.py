"""build-rundecide RD1 a: Simple › Decisions lists each run's decided stops as a Runs group
(``runs`` on ``GET /v1/simple/decisions``). Against Postgres.

Test cards (protects / fails_when / no_claim):

- test_runs_group_lists_each_stop: protects=a run on a readable PRD is one group named
  after the PRD ("Payments plan"), its decided stops in order, each with the person's name,
  role, note and the company's day; a stop sent back and then approved is one row,
  "Approved after a change", whose trail has both steps; a pending stop is not listed;
  fails_when=the field is missing, a stop is split in two, or names are left out;
  no_claim=the run pages (tests.test_runs_*).
- test_runs_group_reads_do_not_grow_with_runs: protects=the Runs group reads every run's
  stops at once; fails_when=the page reads once more per run (one list_decisions call per
  run); no_claim=how long the page takes.
- test_dates_stop_says_how_many_dates_changed: protects=a Dates stop (eng_dates) approved
  after the approver changed dates reads "Approved with one date changed" or "Approved
  with 2 dates changed" (dates_changed on the stop), an accepted one reads "Approved", and
  a stop sent back first keeps "Approved after a change" with its last step naming the
  count; fails_when=the date edits recorded at approval are not counted; no_claim=how the
  dates are changed (tests.test_eng_dates_*).
"""

import datetime as dt

from sqlalchemy import event, select

from oracle.db import get_engine
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


async def _runs_with_a_stop(w, n):
    owner = w.ctx.users["owner"]
    async with tenant_session(w.ctx.tenant_id) as s:
        prd = await s.scalar(select(Document).where(Document.slug == PRD))
        for i in range(n):
            run = Run(flow="baseline_to_prd", document_id=prd.id, created_by=owner.id,
                      status="running")  # fmt: skip
            s.add(run)
            await s.flush()
            s.add(Checkpoint(
                run_id=run.id, kind="feature_set", status="approved", approver_role="approver",
                decided_by=owner.id, decided_at=AT + dt.timedelta(days=i),
                payload={"segment_seq": 1, "decided": {"role": "owner", "by": str(owner.id)}},
            ))  # fmt: skip
        await s.commit()


async def _reads(client, w):
    statements: list[str] = []

    def count(conn, cursor, statement, *args):
        statements.append(statement)

    engine = get_engine().sync_engine
    event.listen(engine, "before_cursor_execute", count)
    try:
        r = await client.get("/v1/simple/decisions", headers=w.ctx.as_("owner"))
    finally:
        event.remove(engine, "before_cursor_execute", count)
    assert r.status_code == 200, r.text
    return len(r.json()["runs"]), len([st for st in statements if "SAVEPOINT" not in st])


async def test_runs_group_reads_do_not_grow_with_runs(client):
    w = await world()
    await _runs_with_a_stop(w, 1)
    runs, one = await _reads(client, w)
    assert runs == 1
    await _runs_with_a_stop(w, 5)
    runs, six = await _reads(client, w)
    assert runs == 6
    assert six <= one, (one, six)


def _dates(changed: int, accepted: int = 1) -> dict:
    """The dates an approval records (engineering.dates.on_approved): changed and accepted."""
    est = {"kind": "estimate", "reference": "Example sizing", "supports_date": "2026-12-01"}
    out = {f"R-{i}": {"decision": "changed", "estimate": est} for i in range(changed)}
    out |= {f"A-{i}": {"decision": "accepted", "estimate": est} for i in range(accepted)}
    return out


async def test_dates_stop_says_how_many_dates_changed(client):
    w = await world()
    owner, lead = w.ctx.users["owner"], w.ctx.users["approver"]
    runs = {}
    async with tenant_session(w.ctx.tenant_id) as s:
        prd = await s.scalar(select(Document).where(Document.slug == PRD))

        def stop(run, kind, status, days, dates=None, attempt=1):
            payload = {
                "segment_seq": 1,
                "attempt": attempt,
                "decided": {"role": "approver", "by": str(lead.id)},
            }
            if dates is not None:
                payload["dates"] = dates
            return Checkpoint(run_id=run.id, kind=kind, status=status, approver_role="approver",
                              decided_by=lead.id, decided_at=AT + dt.timedelta(days=days),
                              payload=payload)  # fmt: skip

        for name, days in (("one", 0), ("two", 1), ("none", 2), ("back", 3)):
            run = Run(flow="baseline_to_prd", document_id=prd.id, created_by=owner.id,
                      status="running", created_at=AT + dt.timedelta(days=days))  # fmt: skip
            s.add(run)
            await s.flush()
            runs[name] = run.id
        s.add_all([
            stop(await s.get(Run, runs["one"]), "eng_dates", "approved", 0, _dates(1)),
            stop(await s.get(Run, runs["two"]), "eng_dates", "approved", 1, _dates(2)),
            stop(await s.get(Run, runs["none"]), "eng_dates", "approved", 2, _dates(0)),
            # Only the dates stop counts date edits.
            stop(await s.get(Run, runs["none"]), "feature_set", "approved", 2, _dates(1)),
            stop(await s.get(Run, runs["back"]), "eng_dates", "changes_requested", 3),
            stop(await s.get(Run, runs["back"]), "eng_dates", "approved", 4, _dates(1),
                 attempt=2),
        ])  # fmt: skip
        await s.commit()
    r = await client.get("/v1/simple/decisions", headers=w.ctx.as_("owner"))
    assert r.status_code == 200, r.text
    by_run = {g["run_id"]: g["stops"] for g in r.json()["runs"]}
    one, two, none, back = (by_run[str(runs[k])] for k in ("one", "two", "none", "back"))
    assert [(x["stop"], x["outcome"], x["dates_changed"]) for x in one] == [
        ("Dates", "Approved with one date changed", 1)
    ]
    assert [(x["outcome"], x["dates_changed"]) for x in two] == [
        ("Approved with 2 dates changed", 2)
    ]
    assert sorted((x["stop"], x["outcome"], x["dates_changed"]) for x in none) == [
        ("Dates", "Approved", 0),
        ("Feature set", "Approved", 0),
    ]
    (stop_,) = back
    assert (stop_["outcome"], stop_["dates_changed"]) == ("Approved after a change", 1)
    assert [t["what"] for t in stop_["trail"]] == ["Sent back", "Approved with one date changed"]
