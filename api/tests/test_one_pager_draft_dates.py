"""vqa-one-pager (e): a draft whose date has no verified source was refused with a bare
count ("draft rejected: 1 problem(s)"), so the person never learned what to change. Against
Postgres with the FakeRuntime; invented PRD and roadmap (tests.test_roadmap).

- test_an_unbacked_date_is_refused_naming_it_and_its_fix: protects=the refusal names the
  date's problem in its detail and carries the fix (add a date source on Plan > Dates for
  the PRD, filtered to the day); fails_when=the detail is only a count or the problem has
  no fix.
- test_a_date_backed_by_a_verified_source_is_accepted: protects=the same draft is accepted
  once a verified source backs its date; fails_when=a backed date is still refused.
"""

from tests.test_roadmap import approved_prd, built_roadmap, owner, runtime  # noqa: F401
from tests.test_roadmap_doc_dates import push, record, with_line


async def _prd_id(client, auth) -> str:
    from tests.test_roadmap import PRD

    r = await client.get(f"/v1/documents/{PRD}", headers=auth)
    assert r.status_code == 200, r.text
    return r.json()["id"]


async def test_an_unbacked_date_is_refused_naming_it_and_its_fix(client, owner, runtime):  # noqa: F811
    _, auth = owner
    await approved_prd(client, auth)
    await built_roadmap(client, auth, runtime)

    resp = await push(client, auth, with_line("GA on 2026-12-15."))
    assert resp.status_code == 422, resp.text
    body = resp.json()
    (problem,) = body["errors"]
    assert problem["code"] == "unverified_date"
    # The detail names the problem, never only how many there are.
    assert "problem(s)" not in body["detail"]
    assert "Dec 15, 2026" in body["detail"]
    # The fix: a date source on Plan > Dates, for this PRD and this day.
    assert problem["fix"] == {
        "action": "add_date_source",
        "prd_document_id": await _prd_id(client, auth),
        "days": ["2026-12-15"],
    }


async def test_a_date_backed_by_a_verified_source_is_accepted(client, owner, runtime):  # noqa: F811
    _, auth = owner
    await approved_prd(client, auth)
    await built_roadmap(client, auth, runtime)
    await record(client, auth, "ENG-500", "2026-12-15")
    resp = await push(client, auth, with_line("GA on 2026-12-15."))
    assert resp.status_code == 201, resp.text
