"""INT2: on-demand reads of an intake are capped per Company day (owner decision,
2026-10-26, on #624's review).

At most 3 reads the author starts (``POST /v1/intakes/{id}/ai-read``) per intake per
Company day (``oracle.company_time``, the Company time zone); the automatic reads on create
and repin are not counted. Over the cap the start route refuses with 429 in words, and the
author's ``ai_read`` says how many they started today and, at the cap, why Read again
waits. Owners get the same cap. Synthetic placeholders only.
"""

from datetime import UTC, datetime

import pytest

from oracle import company_time
from oracle.config import get_settings
from oracle.swarm import FakeRuntime, Outcome, set_runtime
from tests.intake_helpers import company, summary
from tests.test_intake_read import ANALYSIS, _new, _tick

CAPPED = "This intake was read 3 times today; read it again tomorrow"
# Oct 25 in the Company time zone (Los Angeles, PDT is UTC-7): 4:00 PM, then 11:00 PM and
# 11:30 PM, which are already Oct 26 in UTC; then 12:30 AM on Oct 26.
AFTERNOON = datetime(2026, 10, 25, 23, 0, tzinfo=UTC)
LATE = datetime(2026, 10, 26, 6, 0, tzinfo=UTC)
LATER = datetime(2026, 10, 26, 6, 30, tzinfo=UTC)
NEXT_DAY = datetime(2026, 10, 26, 7, 30, tzinfo=UTC)


@pytest.fixture(autouse=True)
def _finishing_reads(monkeypatch):
    """Every read finishes on the next tick, so the author may start the next one."""
    monkeypatch.setattr(get_settings(), "intake_read_runtime", "swarmcloud")
    set_runtime(FakeRuntime({"read": [Outcome(artifacts={"analysis.yaml": ANALYSIS})] * 20}))
    yield
    set_runtime(None)


def _at(monkeypatch, moment: datetime) -> None:
    monkeypatch.setattr(company_time, "now", lambda: moment)


async def _read(client, ctx, intake_id: str, who: str = "commenter"):
    resp = await client.post(f"/v1/intakes/{intake_id}/ai-read", headers=ctx.as_(who))
    if resp.status_code == 202:
        await _tick(client, ctx)
    return resp


# protects=the cap and its words: three reads the author starts in a Company day are
# accepted, the fourth is 429 with the owner's sentence, and the author's ai_read counts
# them (2 of 3, then 3 of 3 with the sentence); fails_when=a fourth read starts, the
# refusal is another status or other words, or ai_read does not count;
# no_claim=the button (web/e2e/intake-read-cap.spec.ts).
async def test_a_fourth_read_in_a_company_day_is_refused_in_words(client, monkeypatch):
    _at(monkeypatch, AFTERNOON)
    ctx = await company()
    intake_id = await _new(client, ctx, ai_extraction=False)
    read = (await summary(client, ctx, intake_id, who="commenter"))["ai_read"]
    assert read["reads_today"] == 0 and read["reads_per_day"] == 3
    assert read["read_again_refused"] is None
    for n in (1, 2):
        resp = await _read(client, ctx, intake_id)
        assert resp.status_code == 202, resp.text
        assert resp.json()["reads_today"] == n
    read = (await summary(client, ctx, intake_id, who="commenter"))["ai_read"]
    assert read["reads_today"] == 2 and read["read_again_refused"] is None
    assert (await _read(client, ctx, intake_id)).status_code == 202
    resp = await _read(client, ctx, intake_id)
    assert resp.status_code == 429, resp.text
    assert resp.json()["detail"] == CAPPED
    read = (await summary(client, ctx, intake_id, who="commenter"))["ai_read"]
    assert read["reads_today"] == 3 and read["read_again_refused"] == CAPPED
    # Nobody else sees the read, or its count (S6).
    assert (await summary(client, ctx, intake_id, who="approver"))["ai_read"] is None


# protects=the Company day boundary: reads at 4 PM and 11 PM Pacific on Oct 25 (the last on
# Oct 26 in UTC) count on one Company day, so the fourth at 11:30 PM is refused; at 12:30 AM
# the next Company day starts the count again; fails_when=the server's (UTC) day is counted,
# or yesterday's reads still count; no_claim=other time zones' wording.
async def test_the_count_is_per_company_day_not_the_servers(client, monkeypatch):
    _at(monkeypatch, AFTERNOON)
    ctx = await company()
    intake_id = await _new(client, ctx, ai_extraction=False)
    for _ in range(2):
        assert (await _read(client, ctx, intake_id)).status_code == 202
    _at(monkeypatch, LATE)
    assert (await _read(client, ctx, intake_id)).status_code == 202
    _at(monkeypatch, LATER)
    assert (await _read(client, ctx, intake_id)).status_code == 429
    _at(monkeypatch, NEXT_DAY)
    read = (await summary(client, ctx, intake_id, who="commenter"))["ai_read"]
    assert read["reads_today"] == 0 and read["read_again_refused"] is None
    resp = await _read(client, ctx, intake_id)
    assert resp.status_code == 202, resp.text
    assert resp.json()["reads_today"] == 1


# protects=create and repin not counted: the automatic reads on create and on repin leave
# all three on-demand reads; fails_when=an automatic read uses one up;
# no_claim=the automatic reads' own rules (test_intake_read).
async def test_the_reads_on_create_and_repin_are_not_counted(client, monkeypatch):
    _at(monkeypatch, AFTERNOON)
    ctx = await company()
    intake_id = await _new(client, ctx)
    await _tick(client, ctx)
    resp = await client.post(f"/v1/intakes/{intake_id}/repin", headers=ctx.as_("commenter"))
    assert resp.status_code == 200, resp.text
    assert resp.json()["ai_read"]["reads_today"] == 0
    await _tick(client, ctx)
    for _ in range(3):
        resp = await _read(client, ctx, intake_id)
        assert resp.status_code == 202, resp.text
    assert (await _read(client, ctx, intake_id)).status_code == 429
    # A repin at the cap still reads (automatic), and the cap still holds after it.
    resp = await client.post(f"/v1/intakes/{intake_id}/repin", headers=ctx.as_("commenter"))
    assert resp.status_code == 200, resp.text
    assert resp.json()["ai_read"]["state"] in ("queued", "running")
    await _tick(client, ctx)
    assert (await _read(client, ctx, intake_id)).status_code == 429


# protects=per intake: another intake's reads are not counted; fails_when=the cap is the
# author's across intakes; no_claim=a per-author cap (none was decided).
async def test_another_intakes_reads_are_not_counted(client, monkeypatch):
    _at(monkeypatch, AFTERNOON)
    ctx = await company()
    first = await _new(client, ctx, ai_extraction=False)
    second = await _new(client, ctx, ai_extraction=False)
    for _ in range(3):
        assert (await _read(client, ctx, first)).status_code == 202
    assert (await _read(client, ctx, first)).status_code == 429
    resp = await _read(client, ctx, second)
    assert resp.status_code == 202, resp.text
    assert resp.json()["reads_today"] == 1


# protects=owners see the same cap: an owner's own intake is refused at the fourth read
# too; fails_when=an owner bypasses it; no_claim=owners starting reads of others' intakes
# (only the author starts one, test_ai_read_route_roles_and_conflicts).
async def test_owners_get_the_same_cap(client, monkeypatch):
    from tests.baseline_helpers import make_item
    from tests.intake_helpers import PAIN, create_intake

    _at(monkeypatch, AFTERNOON)
    ctx = await company()
    await make_item(ctx, "owner", content=PAIN, title="#support thread")
    intake_id = (await create_intake(client, ctx, "owner", ai_extraction=False))["intake"]["id"]
    for _ in range(3):
        assert (await _read(client, ctx, intake_id, who="owner")).status_code == 202
    resp = await _read(client, ctx, intake_id, who="owner")
    assert resp.status_code == 429 and resp.json()["detail"] == CAPPED
