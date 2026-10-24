"""H9 win and loss records: approvers and owners record, edit, delete and import them
from CSV; for a commenter or viewer they are absent (404 on reads, 403 on writes); a run
token reads them only when its run's creator may, and never writes. Against Postgres.
Made-up accounts and segments only.

Each test's card: protects=<the observable>; fails_when=<the wrong result it rejects>;
no_claim=<what green does not prove>.
"""

from datetime import timedelta

import pytest
from sqlalchemy import func, select

from oracle.models import AuditEvent
from oracle.pricing.models import DealOutcome
from oracle.runs.models import Run
from oracle.runtokens import mint_run_token
from oracle.swarm import FakeRuntime, set_runtime
from oracle.tenancy import tenant_session
from tests.baseline_helpers import make_ctx, make_item
from tests.day_helpers import company_today
from tests.test_mcp import mcp_client, text_of

URL = "/v1/deal-outcomes"
HEADER = (
    "result,account,segment,plan,annual_value,currency,decided_on,reason,reason_note,"
    "alternative,price_quoted"
)
CSV_TYPE = {"Content-Type": "text/csv"}


@pytest.fixture
async def ctx():
    return await make_ctx()


@pytest.fixture
def runtime():
    fake = FakeRuntime()
    set_runtime(fake)
    yield fake
    set_runtime(None)


def _deal(**over) -> dict:
    body = {
        "result": "lost",
        "account": "Account 14",
        "segment": "Teams 10-50",
        "plan": "Team",
        "annual_value": 4800,
        "currency": "USD",
        "decided_on": "2026-09-30",
        "reason": "price",
        "reason_note": "Asked for a flat team price",
        "price_quoted": "$20 per seat a month",
    }
    return body | over


async def _create(client, ctx, who: str = "approver", **over) -> dict:
    resp = await client.post(URL, json=_deal(**over), headers=ctx.as_(who))
    assert resp.status_code == 201, resp.text
    return resp.json()


async def _count(ctx) -> int:
    async with tenant_session(ctx.tenant_id) as s:
        return await s.scalar(select(func.count()).select_from(DealOutcome))


async def _import(client, ctx, body: str | bytes, dry_run: bool = False, who: str = "approver"):
    return await client.post(
        f"{URL}/import",
        params={"dry_run": str(dry_run).lower()},
        content=body,
        headers=ctx.as_(who) | CSV_TYPE,
    )


# --------------------------------------------------------------------------- the form


async def test_an_approver_records_a_deal_and_a_commenter_cannot(client, ctx):
    """protects=POST by an approver is a 201 with the record and an audit event; by a
    commenter or viewer a 403 and no row; fails_when=a commenter writes one or an approver
    is refused; no_claim=the Win and loss screen (the e2e covers it)."""
    out = await _create(client, ctx)
    assert out["result"] == "lost" and out["account"] == "Account 14"
    assert out["annual_value"] == 4800 and out["currency"] == "USD"
    assert out["recorded_by"] == str(ctx.users["approver"].id)
    assert out["lock_version"] == 1 and out["source_item"] is None
    for who in ("commenter", "viewer"):
        resp = await client.post(URL, json=_deal(), headers=ctx.as_(who))
        assert resp.status_code == 403, who
    assert await _count(ctx) == 1
    async with tenant_session(ctx.tenant_id) as s:
        actions = list(
            await s.scalars(select(AuditEvent.action).where(AuditEvent.entity == "deal_outcome"))
        )
    assert actions == ["deal_outcome.created"]


async def test_the_rules_refuse_with_422(client, ctx):
    """protects=Other without a note, a future decided_on (the company's tomorrow), a value
    without its currency, a currency outside USD/EUR/GBP, a result or reason outside its
    list, an empty or 121-character account and an H7 competitor_id are 422s; fails_when=
    any of them creates a row; no_claim=the CSV path (its own test)."""
    tomorrow = (company_today() + timedelta(days=2)).isoformat()
    bad = [
        {"reason": "other", "reason_note": None},
        {"reason": "other", "reason_note": "   "},
        {"decided_on": tomorrow},
        {"currency": None},
        {"annual_value": None},
        {"currency": "JPY"},
        {"result": "pending"},
        {"reason": "vibes"},
        {"account": ""},
        {"account": "A" * 121},
        {"competitor_id": "00000000-0000-0000-0000-000000000001"},
    ]
    for over in bad:
        resp = await client.post(URL, json=_deal(**over), headers=ctx.as_("approver"))
        assert resp.status_code == 422, (over, resp.text)
    assert await _count(ctx) == 0
    ok = await _create(client, ctx, reason="other", reason_note="Moved to a spreadsheet")
    assert ok["reason"] == "other"
    ok = await _create(client, ctx, annual_value=None, currency=None)
    assert ok["annual_value"] is None


async def test_a_source_item_must_be_the_recorders_own(client, ctx):
    """protects=source_item_id of the recorder's own item is kept and shows its title,
    link and an excerpt of at most 400 characters, audited as shared in full; another
    person's item is a 422; fails_when=someone else's item is accepted or the excerpt is
    longer; no_claim=what a commenter sees (the records are absent for them)."""
    content = "Asked for a flat team price for teams of ten. " * 30
    mine = await make_item(ctx, "approver", content=content, title="#sales thread")
    theirs = await make_item(ctx, "owner")
    resp = await client.post(
        URL, json=_deal(source_item_id=str(theirs)), headers=ctx.as_("approver")
    )
    assert resp.status_code == 422, resp.text
    out = await _create(client, ctx, source_item_id=str(mine))
    assert out["source_item_id"] == str(mine)
    item = out["source_item"]
    assert item["title"] == "#sales thread"
    assert item["url"] == "https://chat.example.com/archives/C1/p1"
    assert 0 < len(item["excerpt"]) <= 400
    async with tenant_session(ctx.tenant_id) as s:
        event = await s.scalar(
            select(AuditEvent).where(AuditEvent.action == "deal_outcome.created")
        )
    assert event.data["shared"] == "full" and event.data["source_item_id"] == str(mine)


async def test_the_list_is_absent_below_approver_and_filters(client, ctx):
    """protects=GET by a commenter or viewer is a 404 (absent, not disabled); an approver
    and an owner get the records newest decided_on first, filtered by result, reason and
    an inclusive from/to; fails_when=a commenter sees the list, a filter leaks other rows,
    or the order is wrong; no_claim=the web app's sub-tab (the e2e covers it)."""
    await _create(client, ctx, account="Account 1", decided_on="2026-08-01")
    await _create(client, ctx, account="Account 2", decided_on="2026-09-15", result="won",
                  reason="value")  # fmt: skip
    await _create(client, ctx, account="Account 3", decided_on="2026-09-30")
    for who in ("commenter", "viewer"):
        resp = await client.get(URL, headers=ctx.as_(who))
        assert resp.status_code == 404, who
    for who in ("approver", "owner"):
        resp = await client.get(URL, headers=ctx.as_(who))
        assert resp.status_code == 200, resp.text
        assert [r["account"] for r in resp.json()] == ["Account 3", "Account 2", "Account 1"]

    async def accounts(**params) -> list[str]:
        resp = await client.get(URL, params=params, headers=ctx.as_("approver"))
        assert resp.status_code == 200, resp.text
        return [r["account"] for r in resp.json()]

    assert await accounts(result="won") == ["Account 2"]
    assert await accounts(reason="price") == ["Account 3", "Account 1"]
    assert await accounts(**{"from": "2026-09-15", "to": "2026-09-30"}) == [
        "Account 3",
        "Account 2",
    ]
    assert await accounts(to="2026-08-01") == ["Account 1"]
    resp = await client.get(URL, params={"result": "pending"}, headers=ctx.as_("approver"))
    assert resp.status_code == 422


async def test_edit_needs_the_current_lock_version_and_delete_is_204(client, ctx):
    """protects=PATCH with the current lock_version changes the record and bumps it; a
    stale one is a 409 that changes nothing; a commenter's PATCH and DELETE are 403;
    DELETE by an approver is a 204 and the row is gone; fails_when=a stale edit overwrites,
    or a commenter edits or deletes; no_claim=two writers racing at the same instant
    (flush_or_conflict has its own tests)."""
    out = await _create(client, ctx)
    url = f"{URL}/{out['id']}"
    resp = await client.patch(url, json={"lock_version": 1, "reason": "timing"},
                              headers=ctx.as_("approver"))  # fmt: skip
    assert resp.status_code == 200, resp.text
    assert resp.json()["reason"] == "timing" and resp.json()["lock_version"] == 2
    resp = await client.patch(url, json={"lock_version": 1, "reason": "price"},
                              headers=ctx.as_("owner"))  # fmt: skip
    assert resp.status_code == 409, resp.text
    resp = await client.patch(url, json={"lock_version": 2, "reason": "other"},
                              headers=ctx.as_("owner"))  # fmt: skip
    assert resp.status_code == 200  # the record's note is still there
    resp = await client.patch(url, json={"lock_version": 3, "reason_note": None},
                              headers=ctx.as_("owner"))  # fmt: skip
    assert resp.status_code == 422  # Other without a note
    got = (await client.get(URL, headers=ctx.as_("approver"))).json()
    assert got[0]["reason"] == "other" and got[0]["lock_version"] == 3
    resp = await client.patch(url, json={"lock_version": 3, "plan": None},
                              headers=ctx.as_("commenter"))  # fmt: skip
    assert resp.status_code == 403
    assert (await client.delete(url, headers=ctx.as_("commenter"))).status_code == 403
    resp = await client.delete(url, headers=ctx.as_("approver"))
    assert resp.status_code == 204, resp.text
    assert await _count(ctx) == 0
    assert (await client.delete(url, headers=ctx.as_("approver"))).status_code == 404


async def test_another_companys_ids_are_404(client, ctx):
    """protects=PATCH and DELETE of another company's record are 404 and leave it as it
    was, and its list does not show it; fails_when=one company edits, deletes or reads
    another's; no_claim=row-level security itself (tenancy has its own tests)."""
    other = await make_ctx("Other Co")
    theirs = await _create(client, other, account="Account 9")
    url = f"{URL}/{theirs['id']}"
    resp = await client.patch(url, json={"lock_version": 1, "reason": "timing"},
                              headers=ctx.as_("approver"))  # fmt: skip
    assert resp.status_code == 404
    assert (await client.delete(url, headers=ctx.as_("owner"))).status_code == 404
    assert (await client.get(URL, headers=ctx.as_("owner"))).json() == []
    still = (await client.get(URL, headers=other.as_("owner"))).json()
    assert [(r["account"], r["reason"]) for r in still] == [("Account 9", "price")]


# --------------------------------------------------------------------------- CSV import


def _csv(*rows: str) -> str:
    return "\n".join([HEADER, *rows]) + "\n"


GOOD_AND_BAD = _csv(
    "Lost,Account 14,Teams 10-50,Team,4800,usd,2026-09-30,Price,,Alternative Co,$20 a seat",
    "won,Account 15,Teams 10-50,Team,,,2026-09-12,value not clear,,,",
    "Lost,Account 16,,,,,30/09/2026,Timing,,,",
    "No decision,Account 17,Teams 50+,,1200.5,EUR,2026-08-01,OTHER,Went quiet,,",
)


async def test_csv_imports_good_rows_and_lists_bad_ones_by_line(client, ctx):
    """protects=a CSV with 3 good rows and a bad date on line 4 creates 3 records and
    skips line 4 with "decided_on must be YYYY-MM-DD"; labels and keys are read in either
    case, and an alternative is kept in reason_note; fails_when=the bad row stops the
    file, the line number is off by one, or a label is refused; no_claim=matching an H7
    alternative (H7 is not on this branch)."""
    resp = await _import(client, ctx, GOOD_AND_BAD)
    assert resp.status_code == 200, resp.text
    assert resp.json() == {
        "dry_run": False,
        "created": 3,
        "skipped": [{"line": 4, "message": "decided_on must be YYYY-MM-DD"}],
    }
    rows = {r["account"]: r for r in (await client.get(URL, headers=ctx.as_("owner"))).json()}
    assert set(rows) == {"Account 14", "Account 15", "Account 17"}
    assert rows["Account 14"]["currency"] == "USD"
    assert rows["Account 14"]["reason_note"] == "Alternative: Alternative Co"
    assert rows["Account 15"]["result"] == "won" and rows["Account 15"]["reason"] == "value"
    assert rows["Account 17"]["result"] == "no_decision"
    assert rows["Account 17"]["reason"] == "other"
    assert rows["Account 17"]["annual_value"] == 1200.5
    async with tenant_session(ctx.tenant_id) as s:
        event = await s.scalar(
            select(AuditEvent).where(AuditEvent.action == "deal_outcome.imported")
        )
    assert event.data == {"created": 3, "skipped": 1}


async def test_csv_rows_break_the_rules_one_by_one(client, ctx):
    """protects=each bad row is skipped with its own plain message and line (a future day,
    Other without a note, a value without currency, an unknown result or reason, an empty
    account), a quoted multi-line note keeps later line numbers right, and good rows still
    import; fails_when=a bad row imports or a message names the wrong line; no_claim=
    every message's exact wording."""
    future = (company_today() + timedelta(days=2)).isoformat()
    body = _csv(
        f"lost,Account 1,,,,,{future},price,,,",  # line 2
        "lost,Account 2,,,,,2026-09-01,other,,,",  # 3
        "lost,Account 3,,,100,,2026-09-01,price,,,",  # 4
        'lost,Account 4,,,,,2026-09-01,price,"two\nlines",,',  # 5-6
        "pending,Account 5,,,,,2026-09-01,price,,,",  # 7
        "lost,Account 6,,,,,2026-09-01,vibes,,,",  # 8
        "lost,,,,,,2026-09-01,price,,,",  # 9
        "",
        "lost,Account 7,,,10,JPY,2026-09-01,price,,,",  # 11
    )
    resp = await _import(client, ctx, body)
    assert resp.status_code == 200, resp.text
    out = resp.json()
    assert out["created"] == 1
    skipped = {s["line"]: s["message"] for s in out["skipped"]}
    assert skipped == {
        2: "decided_on is in the future",
        3: "reason other needs a reason_note",
        4: "annual_value needs a currency",
        7: "result must be one of: Won, Lost, No decision, Churned",
        8: "reason must be one of: Price, Value not clear, Missing feature, "
        "Chose an alternative, Timing, No budget, Lost the champion, Other",
        9: "account is required",
        11: "currency must be USD, EUR or GBP",
    }
    assert [r["account"] for r in (await client.get(URL, headers=ctx.as_("owner"))).json()] == [
        "Account 4"
    ]


async def test_a_dry_run_creates_nothing(client, ctx):
    """protects=dry_run=true returns the same created count and skipped lines and writes
    no row and no audit event; fails_when=a dry run creates records; no_claim=the web
    app's preview (the e2e covers it)."""
    resp = await _import(client, ctx, GOOD_AND_BAD, dry_run=True)
    assert resp.status_code == 200, resp.text
    assert resp.json()["dry_run"] is True and resp.json()["created"] == 3
    assert [s["line"] for s in resp.json()["skipped"]] == [4]
    assert await _count(ctx) == 0
    async with tenant_session(ctx.tenant_id) as s:
        events = await s.scalar(
            select(func.count()).select_from(AuditEvent).where(AuditEvent.entity == "deal_outcome")
        )
    assert events == 0


async def test_too_many_rows_or_bytes_refuse_the_whole_file(client, ctx):
    """protects=2,001 data rows, a body over 1 MB, and a file without a header row are each
    a 422 creating nothing, while 2,000 rows import; a commenter's import is 403;
    fails_when=a part of an oversized file imports or 2,000 rows are refused; no_claim=
    the reverse proxy's own body limit."""
    row = "lost,Account 14,Teams 10-50,Team,4800,USD,2026-09-30,price,,,"
    resp = await _import(client, ctx, _csv(*[row] * 2001))
    assert resp.status_code == 422 and "2,000" in resp.json()["detail"]
    fat = "lost,Account 14,,,,,2026-09-30,other," + "n" * 1100 + ",,"
    big = _csv(*[fat] * 1000)  # under 2,000 rows, over 1 MB
    assert len(big.encode()) > 1024 * 1024
    resp = await _import(client, ctx, big)
    assert resp.status_code == 422 and "1 MB" in resp.json()["detail"]
    resp = await _import(client, ctx, row + "\n")
    assert resp.status_code == 422 and "header" in resp.json()["detail"]
    assert await _count(ctx) == 0
    resp = await _import(client, ctx, _csv(row), who="commenter")
    assert resp.status_code == 403
    resp = await _import(client, ctx, _csv(*[row] * 2000), dry_run=True)
    assert resp.status_code == 200 and resp.json()["created"] == 2000


# --------------------------------------------------------------------------- run tokens


async def test_a_run_token_reads_them_only_for_an_approver_or_owner_creator(client, ctx, runtime):
    """protects=over MCP, a run token of a run created by an owner or an approver lists
    the records and is refused create_deal_outcome (no write scope covers the area); one
    of a run created by a commenter gets 404 on list_deal_outcomes; fails_when=the
    commenter's run reads them or a run writes one; no_claim=the pricing_memo flow's
    prompt (the flow's own tests)."""
    await _create(client, ctx)
    for who, ok in (("owner", True), ("approver", True), ("commenter", False)):
        async with tenant_session(ctx.tenant_id) as s:
            run = Run(flow="pricing_memo", created_by=ctx.users[who].id)
            s.add(run)
            await s.flush()
            raw = await mint_run_token(s, run.id, ["read:baseline"], ttl_seconds=600)
            await s.commit()
        async with mcp_client(raw) as c:
            got = await c.call_tool("list_deal_outcomes", {})
            refused = await c.call_tool("create_deal_outcome", {"body": _deal()})
        if ok:
            assert not got.is_error, (who, text_of(got))
            assert "Account 14" in text_of(got)
        else:
            assert got.is_error and "HTTP 404" in text_of(got), who
        assert refused.is_error and "not available to run tokens" in text_of(refused), who
    assert await _count(ctx) == 1
