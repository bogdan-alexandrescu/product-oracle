"""CR-06 optimistic concurrency (build prompt §9): a concurrent update to the same
section is a 409 a save can act on, never a silent last write; different sections are
edited and reviewed in parallel; a draft pushed on an older base than the latest
version is a 409 naming both versions (document_versions.base_number)."""

import asyncio

from sqlalchemy import select

from oracle.docs.models import DocumentVersion
from oracle.tenancy import tenant_session
from tests.legacy.helpers import run_cli
from tests.review_v2_helpers import (
    DOC,
    DRAFT,
    edit,
    import_md,
    person,
    replace,
    setup,
    states,
)


async def test_the_same_section_changed_since_is_a_conflict_with_its_current_text(client):
    ctx = await setup(client)
    s1 = await states(client, ctx.auth, 1)
    rev = s1["problem"]["revision"]
    first = await edit(client, ctx.auth, "problem", 1, rev, "Alice's version.")
    assert first.status_code == 201
    second = await edit(client, ctx.auth, "problem", 1, rev, "Bob's version.")
    assert second.status_code == 409
    body = second.json()
    assert body["code"] == "section_conflict"
    assert body["base_version"] == 1 and body["latest_version"] == 2
    [section] = body["sections"]
    assert section["section_key"] == "problem"
    assert section["base_revision"] == rev
    assert section["current_body_md"] == "Alice's version."
    # Nothing was overwritten.
    latest = (await client.get(f"/v1/documents/{DOC}/versions/2", headers=ctx.auth)).json()
    problem = next(s for s in latest["sections"] if s["section_key"] == "problem")
    assert problem["body_md"] == "Alice's version."
    # The save can act on it: retry with the current revision.
    retry = await edit(
        client, ctx.auth, "problem", 2, section["current_revision"], "Alice's and Bob's."
    )
    assert retry.status_code == 201 and retry.json()["number"] == 3


async def test_different_sections_are_edited_in_parallel(client):
    ctx = await setup(client)
    s1 = await states(client, ctx.auth, 1)
    a = await person(ctx.tenant_id, "approver", "a")
    b = await person(ctx.tenant_id, "approver", "b")
    r1, r2 = await asyncio.gather(
        edit(client, a.headers, "problem", 1, s1["problem"]["revision"], "Problem by A."),
        edit(client, b.headers, "risks", 1, s1["risks"]["revision"], "Risks by B."),
    )
    assert sorted([r1.status_code, r2.status_code]) == [201, 201], (r1.text, r2.text)
    latest = (await client.get(f"/v1/documents/{DOC}/versions/3", headers=ctx.auth)).json()
    bodies = {s["section_key"]: s["body_md"] for s in latest["sections"]}
    # Both edits are in the latest version: neither overwrote the other.
    assert bodies["problem"] == "Problem by A." and bodies["risks"] == "Risks by B."


async def test_concurrent_edits_of_one_section_never_both_win(client):
    ctx = await setup(client)
    s1 = await states(client, ctx.auth, 1)
    rev = s1["solution"]["revision"]
    results = await asyncio.gather(
        *(edit(client, ctx.auth, "solution", 1, rev, f"Variant {i}.") for i in range(3))
    )
    codes = sorted(r.status_code for r in results)
    assert codes == [201, 409, 409], [r.text for r in results]
    async with tenant_session(ctx.tenant_id) as s:
        numbers = (await s.scalars(select(DocumentVersion.number))).all()
    assert sorted(numbers) == [1, 2]


async def test_edit_roles_and_the_section_owner(client):
    ctx = await setup(client)
    s1 = await states(client, ctx.auth, 1)
    commenter = await person(ctx.tenant_id, "commenter")
    viewer = await person(ctx.tenant_id, "viewer")
    rev = s1["risks"]["revision"]
    assert (await edit(client, viewer.headers, "risks", 1, rev, "x")).status_code == 403
    assert (await edit(client, commenter.headers, "risks", 1, rev, "x")).status_code == 403
    resp = await client.put(
        f"/v1/documents/{DOC}/sections/risks/assignment",
        json={"owner_id": str(commenter.user_id)},
        headers=ctx.auth,
    )
    assert resp.status_code == 200, resp.text
    # The section's owner edits it.
    assert (await edit(client, commenter.headers, "risks", 1, rev, "Owned.")).status_code == 201
    s2 = await states(client, ctx.auth, 2)
    other = s2["problem"]["revision"]
    assert (await edit(client, commenter.headers, "problem", 2, other, "x")).status_code == 403
    # Unknown section, unknown base, unchanged text.
    assert (await edit(client, ctx.auth, "nope", 2, "h", "x")).status_code == 409
    assert (await edit(client, ctx.auth, "problem", 9, other, "x")).status_code == 422
    same = await edit(client, ctx.auth, "problem", 2, other, "Teams miss shared deadlines.")
    assert same.status_code == 200 and same.json()["number"] == 2


async def test_an_edit_can_resolve_feedback(client):
    ctx = await setup(client)
    created = await client.post(
        ctx.v(1, "/comments"),
        json={"section_key": "risks", "anchor": {"exact": "lag"}, "body": "How long?"},
        headers=ctx.auth,
    )
    item_id = created.json()["feedback_item_id"]
    s1 = await states(client, ctx.auth, 1)
    resp = await edit(
        client,
        ctx.auth,
        "risks",
        1,
        s1["risks"]["revision"],
        "Calendar sync may lag by up to an hour.",
        resolutions=[{"feedback_id": item_id, "status": "addressed", "note": "An hour"}],
    )
    assert resp.status_code == 201, resp.text
    items = (await client.get(f"/v1/documents/{DOC}/feedback", headers=ctx.auth)).json()
    assert [(i["status"], i["addressed_in_version"]) for i in items] == [("addressed", 2)]


# --- import base version (document_versions.base_number) -------------------------------


async def test_a_draft_on_an_older_base_is_a_409_naming_both_versions(client):
    ctx = await setup(client)
    v2 = replace(DRAFT, "Teams miss shared deadlines.", "Teams miss deadlines (v2).")
    assert (await import_md(client, ctx.auth, v2, base=1)).status_code == 201
    # Someone else's draft, also written on version 1, changes another section; it still
    # has version 1's problem text, so saving it would revert version 2's change.
    stale = replace(DRAFT, "Calendar sync may lag.", "Calendar sync lags.")
    resp = await import_md(client, ctx.auth, stale, base=1)
    assert resp.status_code == 409
    body = resp.json()
    assert body["code"] == "version_conflict"
    assert (body["base_version"], body["latest_version"]) == (1, 2)
    assert "version 1" in body["detail"] and "version 2" in body["detail"]
    [section] = body["sections"]
    assert section["section_key"] == "problem"
    assert section["current_body_md"] == "Teams miss deadlines (v2)."
    async with tenant_session(ctx.tenant_id) as s:
        assert len((await s.scalars(select(DocumentVersion))).all()) == 2

    # Merged with version 2, the same draft goes in; base_number is recorded.
    merged = replace(v2, "Calendar sync may lag.", "Calendar sync lags.")
    resp = await import_md(client, ctx.auth, merged, base=1)
    assert resp.status_code == 201, resp.text
    async with tenant_session(ctx.tenant_id) as s:
        row = await s.scalar(select(DocumentVersion).where(DocumentVersion.number == 3))
        assert row.base_number == 1


async def test_both_sides_changing_one_section_conflicts(client):
    ctx = await setup(client)
    v2 = replace(DRAFT, "Teams miss shared deadlines.", "Version two's problem.")
    assert (await import_md(client, ctx.auth, v2)).status_code == 201
    mine = replace(DRAFT, "Teams miss shared deadlines.", "My problem.")
    resp = await import_md(client, ctx.auth, mine, base=1)
    assert resp.status_code == 409
    section = resp.json()["sections"][0]
    assert section["your_revision"] not in (None, section["current_revision"])


async def test_base_version_edge_cases_and_legacy_imports(client):
    ctx = await setup(client)
    v2 = replace(DRAFT, "Calendar sync may lag.", "Sync lags.")
    # The latest as base: no conflict.
    assert (await import_md(client, ctx.auth, v2, base=1)).status_code == 201
    # An unknown base is a 422.
    v3 = replace(v2, "Sync lags.", "Sync lags a lot.")
    resp = await import_md(client, ctx.auth, v3, base=5)
    assert resp.status_code == 422
    assert resp.json()["errors"][0]["code"] == "unknown_base_version"
    # Without a base, an import behaves as before (no check), as `oracle push` does.
    old = replace(DRAFT, "Owner: product.", "Owner: growth.")
    assert (await import_md(client, ctx.auth, old)).status_code == 201
    # Pushing exactly an existing version is still a 200 with that version.
    resp = await import_md(client, ctx.auth, DRAFT, base=1)
    assert resp.status_code == 200 and resp.json()["number"] == 1
    # A new document with a base is refused.
    other = replace(DRAFT, "document: team-calendar", "document: other-doc")
    resp = await import_md(client, ctx.auth, other, doc="other-doc", base=1)
    assert resp.status_code == 422


async def test_cli_push_with_base_refuses_a_stale_draft(client, tmp_path):
    ctx = await setup(client)
    v2 = replace(DRAFT, "Teams miss shared deadlines.", "Changed in v2.")
    assert (await import_md(client, ctx.auth, v2)).status_code == 201
    stale = tmp_path / "draft.md"
    stale.write_text(replace(DRAFT, "Calendar sync may lag.", "Lag."), encoding="utf-8")
    token = ctx.auth["Authorization"].split(" ", 1)[1]
    code, out, err = await run_cli(client, ["push", str(stale), "--base", "1"], token)
    assert code != 0
    assert "409" in err and "version 1" in err and "version 2" in err
    # Without --base, push behaves as before.
    code, out, _ = await run_cli(client, ["push", str(stale)], token)
    assert code == 0 and "Imported team-calendar version 3" in out


async def test_assignment_lock_version_conflict(client):
    ctx = await setup(client)
    reviewer = await person(ctx.tenant_id, "commenter")
    url = f"/v1/documents/{DOC}/sections/problem/assignment"
    first = await client.put(url, json={"reviewer_ids": [str(reviewer.user_id)]}, headers=ctx.auth)
    assert first.status_code == 200 and first.json()["lock_version"] == 1
    # A second writer that did not see the first assignment.
    resp = await client.put(url, json={"due_at": "2026-11-01T00:00:00Z"}, headers=ctx.auth)
    assert resp.status_code == 409 and resp.json()["current_lock_version"] == 1
    resp = await client.put(
        url,
        json={
            "reviewer_ids": [str(reviewer.user_id)],
            "due_at": "2026-11-01T00:00:00Z",
            "lock_version": 1,
        },
        headers=ctx.auth,
    )
    assert resp.status_code == 200 and resp.json()["lock_version"] == 2
    s1 = await states(client, ctx.auth, 1)
    assert s1["problem"]["due_at"].startswith("2026-11-01")
    assert s1["problem"]["lock_version"] == 2
