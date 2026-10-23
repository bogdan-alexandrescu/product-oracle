"""CR-06 security review fixes, round 2 (PR #16 / #27): approvals count only while the
approver still is one (role, membership, an active token), an agent draft cannot drop
an approved section through an unclosed code fence, and the minors (revocation
matching, a revision that covers citation source, retrieved_at and section links, one
markdown env per exported section, open criticals gate publish, a run's draft closes
only the feedback it addressed).

Synthetic placeholders only."""

import uuid
from datetime import UTC, datetime
from types import SimpleNamespace

import pytest
from sqlalchemy import select

from oracle import readiness
from oracle.audit import AuditEvent
from oracle.auth.deps import Principal
from oracle.auth.models import ApiToken, User
from oracle.auth.service import create_api_token
from oracle.baseline.models import Entity, Evidence
from oracle.docs import service as docs_service
from oracle.docs.models import Document
from oracle.docs.parser import DraftError
from oracle.review.models import FeedbackItem, SectionPatch
from oracle.sources.models import Source, SourceItem
from oracle.tenancy import tenant_session
from oracle.v2.models import ChangeEvent, DocumentSectionLink
from tests.review_v2_helpers import (  # noqa: F401 (local_runtime: a fixture)
    DOC,
    DRAFT,
    approve_all,
    import_md,
    local_runtime,
    person,
    replace,
    setup,
    states,
    verdict,
)


@pytest.fixture(autouse=True)
def _only_test_checks():
    with readiness.isolated_checks():
        yield


async def approved(client, ctx, n: int = 1, headers=None) -> None:
    resp = await client.post(ctx.v(n, "/approve"), headers=headers or ctx.auth)
    assert resp.status_code == 200, resp.text


async def check(client, ctx, n: int = 1) -> dict:
    resp = await client.get(ctx.v(n, "/publish-check"), headers=ctx.auth)
    assert resp.status_code == 200, resp.text
    return resp.json()


def codes(body: dict) -> list[str]:
    return [b["code"] for b in body["blockers"]]


def blocker(body: dict, code: str) -> dict:
    [b] = [b for b in body["blockers"] if b["code"] == code]
    return b


async def policy(client, ctx, **value) -> None:
    resp = await client.put(f"/v1/documents/{DOC}/review-policy", json=value, headers=ctx.auth)
    assert resp.status_code == 200, resp.text


async def set_role(client, ctx, user_id, role: str):
    return await client.patch(f"/v1/members/{user_id}", json={"role": role}, headers=ctx.auth)


SECTIONS = ["title", "goal-trace", "problem", "solution", "risks", "sources"]


# --- BLOCKER: approvals count only while the approver still is one ----------------------


async def test_a_demoted_approvers_approvals_stop_counting(client):
    ctx = await setup(client)
    await policy(client, ctx, section_approval="all_sections")
    pm = await person(ctx.tenant_id, "approver", "pm")
    await approve_all(client, pm.headers, 1)
    await approved(client, ctx, headers=pm.headers)
    assert (await check(client, ctx))["can_publish"] is True

    assert (await set_role(client, ctx, pm.user_id, "viewer")).status_code == 200
    body = await check(client, ctx)
    assert body["can_publish"] is False
    assert codes(body) == ["version_approval_lapsed", "missing_approval"]
    lapsed = blocker(body, "version_approval_lapsed")
    assert lapsed["ids"] == [str(pm.user_id)]
    assert "no longer" in lapsed["message"]
    missing = blocker(body, "missing_approval")
    assert missing["section_keys"] == SECTIONS
    assert str(pm.user_id) in missing["message"]
    s1 = await states(client, ctx.auth, 1)
    assert {s["status"] for s in s1.values()} == {"unreviewed"}
    resp = await client.post(ctx.v(1, "/publish"), json={}, headers=ctx.auth)
    assert resp.status_code == 409, resp.text

    async with tenant_session(ctx.tenant_id) as s:
        [event] = (
            await s.scalars(select(ChangeEvent).where(ChangeEvent.subject_kind == "member"))
        ).all()
        assert (event.cause, event.subject_id) == ("role_changed", pm.user_id)
        assert (event.data["before"], event.data["after"]) == ("approver", "viewer")

    # Promoted again: the approvals lapsed for good (C2), they never come back.
    assert (await set_role(client, ctx, pm.user_id, "approver")).status_code == 200
    assert codes(await check(client, ctx)) == ["version_approval_lapsed", "missing_approval"]


async def test_a_demoted_designated_decider_blocks(client):
    ctx = await setup(client)
    decider = await person(ctx.tenant_id, "approver", "decider")
    await policy(client, ctx, decider_id=str(decider.user_id))
    await approved(client, ctx, headers=decider.headers)
    assert (await check(client, ctx))["can_publish"] is True

    assert (await set_role(client, ctx, decider.user_id, "commenter")).status_code == 200
    body = await check(client, ctx)
    assert codes(body) == ["decider_not_current", "version_approval_lapsed"]
    named = blocker(body, "decider_not_current")
    assert named["ids"] == [str(decider.user_id)]
    assert "review policy" in named["message"]


async def test_a_demoted_mandatory_reviewer_blocks(client):
    ctx = await setup(client)
    reviewer = await person(ctx.tenant_id, "approver", "eng-lead")
    await policy(client, ctx, mandatory_reviewer_ids=[str(reviewer.user_id)])
    await approve_all(client, reviewer.headers, 1)
    await approved(client, ctx)
    assert (await check(client, ctx))["can_publish"] is True

    assert (await set_role(client, ctx, reviewer.user_id, "viewer")).status_code == 200
    body = await check(client, ctx)
    assert codes(body) == ["mandatory_reviewer_pending"]
    pending = blocker(body, "mandatory_reviewer_pending")
    assert pending["ids"] == [str(reviewer.user_id)]
    assert pending["section_keys"] == SECTIONS
    assert "no longer has the approver role" in pending["message"]
    s1 = await states(client, ctx.auth, 1)
    assert s1["problem"]["mandatory_approvals"] == [
        {"reviewer_id": str(reviewer.user_id), "approved": False}
    ]


async def test_a_removed_members_approvals_stop_counting(client):
    """Removing a member disables them (C2): the row stays, their approvals lapse."""
    ctx = await setup(client)
    await policy(client, ctx, section_approval="all_sections")
    pm = await person(ctx.tenant_id, "approver", "pm")
    await approve_all(client, pm.headers, 1)
    await approved(client, ctx, headers=pm.headers)
    assert (await check(client, ctx))["can_publish"] is True
    other = await person(ctx.tenant_id, "approver", "other")
    # Owners only.
    resp = await client.delete(f"/v1/members/{pm.user_id}", headers=other.headers)
    assert resp.status_code == 403
    resp = await client.delete(f"/v1/members/{pm.user_id}", headers=ctx.auth)
    assert resp.status_code == 204, resp.text
    # Removing a disabled member again is a no-op.
    assert (await client.delete(f"/v1/members/{pm.user_id}", headers=ctx.auth)).status_code == 204
    # The removed member cannot sign in with their session any more.
    assert (await client.get(f"/v1/documents/{DOC}", headers=pm.headers)).status_code == 401

    body = await check(client, ctx)
    assert codes(body) == ["version_approval_lapsed", "missing_approval"]
    async with tenant_session(ctx.tenant_id) as s:
        user = await s.get(User, pm.user_id)
        assert user is not None and user.disabled_at is not None
        [event] = (
            await s.scalars(select(ChangeEvent).where(ChangeEvent.subject_kind == "member"))
        ).all()
        assert (event.cause, event.subject_id) == ("member_disabled", pm.user_id)
        [audit] = (
            await s.scalars(select(AuditEvent).where(AuditEvent.action == "member.disable"))
        ).all()
        assert audit.entity_id == pm.user_id and audit.data["role"] == "approver"


async def test_the_last_owner_cannot_be_removed(client):
    ctx = await setup(client)
    async with tenant_session(ctx.tenant_id) as s:
        [owner] = (await s.scalars(select(User).where(User.role == "owner"))).all()
    resp = await client.delete(f"/v1/members/{owner.id}", headers=ctx.auth)
    assert resp.status_code == 409, resp.text


async def test_a_removed_members_sources_are_revoked_first(client):
    """Removing (disabling) a member revokes their sources: each gets a
    source_permission revocation, so documents citing them cannot publish."""
    ctx = await setup(client)
    await approved(client, ctx)
    analyst = await person(ctx.tenant_id, "commenter", "analyst")
    async with tenant_session(ctx.tenant_id) as s:
        source = Source(owner_user_id=analyst.user_id, kind="upload", name="Survey")
        s.add(source)
        await s.flush()
        s.add(
            SourceItem(
                source_id=source.id,
                external_id="survey.md",
                kind="file",
                url="https://example.com/calendar-survey",
            )
        )
        await s.commit()
    assert (await check(client, ctx))["can_publish"] is True
    resp = await client.delete(f"/v1/members/{analyst.user_id}", headers=ctx.auth)
    assert resp.status_code == 204, resp.text
    assert codes(await check(client, ctx)) == ["source_permission_revoked"]


async def test_a_revoked_tokens_verdicts_stop_counting(client):
    ctx = await setup(client)
    await policy(client, ctx, section_approval="all_sections")
    async with tenant_session(ctx.tenant_id) as s:
        token, raw = await create_api_token(s, "review-bot")
        token.role = "approver"
        await s.commit()
        token_id = token.id
    bot = {"Authorization": f"Bearer {raw}"}
    await approve_all(client, bot, 1)
    await approved(client, ctx, headers=bot)
    assert (await check(client, ctx))["can_publish"] is True

    async with tenant_session(ctx.tenant_id) as s:
        row = await s.get(ApiToken, token_id)
        row.revoked_at = datetime.now(UTC)
        await s.commit()
    body = await check(client, ctx)
    assert codes(body) == ["version_approval_lapsed", "missing_approval"]
    assert blocker(body, "version_approval_lapsed")["ids"] == [str(token_id)]


async def test_a_member_tokens_approval_lapses_with_the_token(client):
    """A token acting for a user approves as the user, and Oracle records the token:
    revoking it voids the approvals it gave (C2), even when revoked outside the API."""
    ctx = await setup(client)
    pm = await person(ctx.tenant_id, "approver", "pm")
    async with tenant_session(ctx.tenant_id) as s:
        token, raw = await create_api_token(s, "pm-agent", user_id=pm.user_id)
        await s.commit()
        token_id = token.id
    await approved(client, ctx, headers={"Authorization": f"Bearer {raw}"})
    assert (await check(client, ctx))["can_publish"] is True
    async with tenant_session(ctx.tenant_id) as s:
        (await s.get(ApiToken, token_id)).revoked_at = datetime.now(UTC)
        await s.commit()
    assert codes(await check(client, ctx)) == ["version_approval_lapsed"]


# --- MAJOR: an unclosed code fence cannot swallow an approved section -------------------

FENCED = replace(DRAFT, "A shared calendar view per project.", "A shared calendar view.\n\n```text")


@pytest.mark.usefixtures("local_runtime")
async def test_an_unclosed_fence_push_draft_keeps_the_approved_section(client):
    from oracle.runs.models import Run
    from oracle.runtokens import mint_run_token
    from tests.legacy.helpers import mcp_session

    ctx = await setup(client)
    assert (await verdict(client, ctx.auth, 1, "risks")).status_code == 200
    pm = await person(ctx.tenant_id, "approver", "pm")
    async with tenant_session(ctx.tenant_id) as s:
        run = Run(flow="baseline_to_prd", created_by=pm.user_id)
        s.add(run)
        await s.flush()
        token = await mint_run_token(s, run.id, ["write:drafts", "read:documents"], 600)
        await s.commit()
    async with mcp_session(token) as c:
        pushed = await c.call_tool(
            "push_draft", {"doc": DOC, "markdown": FENCED, "base_version": 1}
        )
        assert not pushed.is_error, pushed.content
    v2 = pushed.structured_content
    bodies = {s["section_key"]: s["body_md"] for s in v2["sections"]}
    assert bodies["risks"] == "Calendar sync may lag."
    # The fence the agent left open is closed before the held section.
    assert bodies["solution"].endswith("```")
    s2 = await states(client, ctx.auth, 2)
    assert s2["risks"]["status"] == "approved"
    async with tenant_session(ctx.tenant_id) as s:
        patches = (await s.scalars(select(SectionPatch))).all()
        assert [(p.section_key, p.action) for p in patches] == [("risks", "remove")]


async def test_the_hold_refuses_a_draft_that_still_loses_an_approved_section(client, monkeypatch):
    """Whatever the composer does, the held draft is checked: every approved section
    must be there with its approved revision, or the import is refused."""
    from oracle.jobs import service as jobs_service

    ctx = await setup(client)
    assert (await verdict(client, ctx.auth, 1, "risks")).status_code == 200
    real = jobs_service.compose_markdown

    def leaky(front_matter, sections, replace_, resolutions):
        out = real(front_matter, sections, replace_, resolutions)
        return out.replace("Calendar sync may lag.", "Calendar sync never lags.")

    monkeypatch.setattr(jobs_service, "compose_markdown", leaky)
    owner = await person(ctx.tenant_id, "owner", "run-creator")
    agent = replace(DRAFT, "Calendar sync may lag.", "Sync is instant.")
    async with tenant_session(ctx.tenant_id) as s:
        with pytest.raises(DraftError) as raised:
            await docs_service.import_draft(
                s,
                DOC,
                agent,
                Principal(ctx.tenant_id, "user", "owner", user_id=owner.user_id),
                origin="run",
                cause="run_draft",
            )
    assert [p.code for p in raised.value.problems] == ["approved_section_not_held"]
    assert raised.value.problems[0].section_key == "risks"


@pytest.mark.parametrize(
    ("body", "closing"),
    [
        ("Intro.\n\n```text\ncode", "```"),
        ("Intro.\n\n~~~~\ncode", "~~~~"),
        ("Intro.\n\n  `````\n```\nstill code", "`````"),
    ],
)
def test_compose_closes_a_dangling_fence(body, closing):
    from oracle.docs.parser import parse_draft
    from oracle.jobs.service import compose_markdown

    sections = [
        SimpleNamespace(section_key="a", level=2, heading="A", body_md=body),
        SimpleNamespace(section_key="b", level=2, heading="B", body_md="Kept."),
    ]
    parsed = parse_draft(compose_markdown({"title": "T"}, sections, {}, []))
    assert [s.section_key for s in parsed.sections] == ["a", "b"]
    assert parsed.sections[0].body_md == f"{body}\n{closing}"
    assert parsed.sections[1].body_md == "Kept."


def test_compose_leaves_closed_fences_and_the_last_section_alone():
    from oracle.jobs.service import compose_markdown

    sections = [
        SimpleNamespace(section_key="a", level=2, heading="A", body_md="```\nx\n```"),
        SimpleNamespace(section_key="b", level=2, heading="B", body_md="```\nopen"),
    ]
    out = compose_markdown({"title": "T"}, sections, {}, [])
    assert out.endswith("## B {#b}\n\n```\nopen\n")
    assert "```\nx\n```\n\n## B" in out


# --- minors: revocation matching -----------------------------------------------------------


def test_normalized_urls_ignore_scheme_www_slash_and_tracking():
    from oracle.review.publish import normalize_url

    assert normalize_url("http://www.Example.com/a/") == "https://example.com/a"
    assert normalize_url("https://example.com/a?utm_source=x&b=2&a=1#f") == (
        "https://example.com/a?a=1&b=2"
    )
    assert normalize_url("HTTPS://WWW.example.com:443/") == "https://example.com"
    assert normalize_url("https://example.com:8443/a") == "https://example.com:8443/a"
    # Idempotent, so tombstones recorded with an older normalization still match.
    for url in ("https://example.com/a?b=1", "http://www.x.test/"):
        assert normalize_url(normalize_url(url)) == normalize_url(url)


async def _source(ctx, owner, *, url="https://example.com/calendar-survey", kind="upload"):
    async with tenant_session(ctx.tenant_id) as s:
        source = Source(owner_user_id=owner.user_id, kind=kind, name=f"S {uuid.uuid4().hex[:6]}")
        s.add(source)
        await s.flush()
        item = SourceItem(
            source_id=source.id, external_id="survey-123", kind="file", title="Survey", url=url
        )
        s.add(item)
        await s.commit()
        return source.id, item.id


async def _delete_source(client, owner, source_id) -> None:
    resp = await client.delete(f"/v1/sources/{source_id}", headers=owner.headers)
    assert resp.status_code == 204, resp.text


async def _cited(client, ctx, ref: str, source: str = "web") -> None:
    draft = replace(
        replace(DRAFT, "ref: https://example.com/calendar-survey", f"ref: {ref}"),
        "source: web",
        f"source: {source}",
    )
    assert (await import_md(client, ctx.auth, draft, base=1)).status_code == 201
    await approved(client, ctx, 2)
    assert (await check(client, ctx, 2))["can_publish"] is True


async def test_a_citation_url_variant_is_matched(client):
    ctx = await setup(client)
    owner = await person(ctx.tenant_id, "owner", "source-owner")
    source_id, _ = await _source(ctx, owner)
    await _cited(client, ctx, "http://www.example.com/calendar-survey/?utm_source=mail")
    await _delete_source(client, owner, source_id)
    body = await check(client, ctx, 2)
    assert codes(body) == ["source_permission_revoked"]
    assert blocker(body, "source_permission_revoked")["section_keys"] == ["goal-trace"]


async def test_a_citation_by_external_id_is_matched(client):
    ctx = await setup(client)
    owner = await person(ctx.tenant_id, "owner", "source-owner")
    source_id, _ = await _source(ctx, owner, url=None)
    await _cited(client, ctx, "survey-123", source="upload")
    await _delete_source(client, owner, source_id)
    assert codes(await check(client, ctx, 2)) == ["source_permission_revoked"]


async def test_a_citation_by_evidence_id_is_matched(client):
    ctx = await setup(client)
    owner = await person(ctx.tenant_id, "owner", "source-owner")
    source_id, item_id = await _source(ctx, owner, url="https://x.test/evidence-only")
    async with tenant_session(ctx.tenant_id) as s:
        goal = Entity(type="goal", key="retention", title="Retention", origin="user")
        s.add(goal)
        await s.flush()
        evidence = Evidence(entity_id=goal.id, source_item_id=item_id, excerpt="Teams plan")
        s.add(evidence)
        await s.commit()
        evidence_id = evidence.id
    await _cited(client, ctx, str(evidence_id))
    await _delete_source(client, owner, source_id)
    body = await check(client, ctx, 2)
    assert codes(body) == ["source_permission_revoked"]
    assert blocker(body, "source_permission_revoked")["section_keys"] == ["goal-trace"]


# --- minors: the revision covers citation source, retrieved_at and links -----------------


@pytest.mark.parametrize(
    ("old", "new"),
    [
        (
            "title: Calendar survey",
            "title: Calendar survey\n    retrieved_at: 2026-09-01T00:00:00Z",
        ),
        ("source: web", "source: upload"),
    ],
)
async def test_citation_source_and_retrieved_at_change_the_revision(client, old, new):
    ctx = await setup(client)
    assert (await verdict(client, ctx.auth, 1, "goal-trace")).status_code == 200
    assert (await import_md(client, ctx.auth, replace(DRAFT, old, new), base=1)).status_code == 201
    s2 = await states(client, ctx.auth, 2)
    assert s2["goal-trace"]["status"] == "approval_stale"


async def test_an_unchanged_retrieved_at_keeps_the_revision(client):
    dated = replace(
        DRAFT, "title: Calendar survey", "title: Calendar survey\n    retrieved_at: 2026-09-01"
    )
    ctx = await setup(client, dated)
    assert (await verdict(client, ctx.auth, 1, "goal-trace")).status_code == 200
    again = replace(dated, "Owner: product.", "Owner: growth.")
    assert (await import_md(client, ctx.auth, again, base=1)).status_code == 201
    assert (await states(client, ctx.auth, 2))["goal-trace"]["status"] == "approved"


async def test_a_link_added_after_approval_stales_the_section(client):
    ctx = await setup(client)
    await policy(client, ctx, section_approval="all_sections")
    await approve_all(client, ctx.auth, 1)
    await approved(client, ctx)
    assert (await check(client, ctx))["can_publish"] is True
    async with tenant_session(ctx.tenant_id) as s:
        goal = Entity(type="goal", key="retention", title="Retention", origin="user")
        s.add(goal)
        await s.flush()
        document = await s.scalar(select(Document).where(Document.slug == DOC))
        s.add(
            DocumentSectionLink(
                document_id=document.id, section_key="problem", kind="evidences", entity_id=goal.id
            )
        )
        await s.commit()
    s1 = await states(client, ctx.auth, 1)
    assert s1["problem"]["status"] == "approval_stale"
    assert s1["solution"]["status"] == "approved"
    body = await check(client, ctx)
    assert codes(body) == ["stale_approval"]
    assert blocker(body, "stale_approval")["section_keys"] == ["problem"]
    # Approving the section with its link is what counts.
    assert (await verdict(client, ctx.auth, 1, "problem")).status_code == 200
    assert (await check(client, ctx))["can_publish"] is True


# --- minors: one markdown env per exported section -------------------------------------

LEAKY = [
    SimpleNamespace(
        section_key="a",
        level=2,
        heading="A",
        body_md="Defines a reference.\n\n[ref]: https://leak.example/a",
        layer="detail",
        citation_keys=[],
    ),
    SimpleNamespace(
        section_key="b",
        level=2,
        heading="B",
        body_md="Uses [ref] here.",
        citation_keys=[],
        layer="detail",
    ),
]


def _ev(theme=None):
    from oracle.export.render import ExportVersion

    return ExportVersion(
        document=SimpleNamespace(
            kind="prd", title="T", slug="t", status="draft", template=None, template_version=None
        ),
        version=SimpleNamespace(
            number=1, snapshot=None, created_at=datetime.now(UTC), approved_at=None
        ),
        sections=LEAKY,
        citations=[],
        latest_number=1,
        theme=theme,
        all_sections=LEAKY,
    )


def test_a_link_reference_does_not_leak_across_sections():
    from oracle.export.render import build_context

    ctx = build_context(_ev())
    b = next(s for s in ctx["sections"] if s.key == "b")
    assert "leak.example" not in str(b.body)


def test_a_link_reference_does_not_leak_across_themed_sections():
    from oracle.export.render import build_themed_context

    theme = SimpleNamespace(key="plain", name="Plain", tokens={}, css="")
    ctx = build_themed_context(_ev(theme))
    b = next(g for g in ctx["groups"] if g.key == "b")
    assert "leak.example" not in str(b.body)


# --- minors: open criticals gate publish (T2) -----------------------------------------------


async def test_an_open_critical_change_request_blocks_publish(client):
    ctx = await setup(client)
    created = await client.post(
        ctx.v(1, "/comments"),
        json={
            "section_key": "risks",
            "anchor": {"exact": "lag"},
            "body": "This is a launch risk",
            "severity": "critical",
        },
        headers=ctx.auth,
    )
    assert created.status_code == 201, created.text
    await approved(client, ctx)
    body = await check(client, ctx)
    assert codes(body) == ["open_critical_change_request"]
    assert blocker(body, "open_critical_change_request")["section_keys"] == ["risks"]
    assert (await client.post(ctx.v(1, "/publish"), json={}, headers=ctx.auth)).status_code == 409
    item_id = created.json()["feedback_item_id"]
    resp = await client.patch(
        f"/v1/feedback/{item_id}",
        json={"status": "addressed", "resolution_note": "Mitigated"},
        headers=ctx.auth,
    )
    assert resp.status_code == 200, resp.text
    assert (await check(client, ctx))["can_publish"] is True


# --- minors: a run's draft closes only the feedback it addressed -----------------------


async def test_a_run_draft_closes_only_feedback_on_sections_it_changed(client):
    ctx = await setup(client)
    assert (await verdict(client, ctx.auth, 1, "risks")).status_code == 200
    items = {}
    for key in ("solution", "problem", "risks"):
        created = await client.post(
            ctx.v(1, "/comments"),
            json={"section_key": key, "anchor": {"exact": "a"}, "body": f"About {key}"},
            headers=ctx.auth,
        )
        items[key] = created.json()["feedback_item_id"]
    resolutions = "".join(
        f"  - feedback_id: {items[k]}\n    status: {status}\n"
        for k, status in (
            ("solution", "addressed"),
            ("problem", "addressed"),
            ("risks", "addressed"),
        )
    )
    agent = replace(
        replace(
            replace(DRAFT, "A shared calendar view per project.", "A calendar per team."),
            "Calendar sync may lag.",
            "Sync is instant.",
        ),
        "title: Team calendar PRD\n",
        f"title: Team calendar PRD\nresolutions:\n{resolutions}",
    )
    owner = await person(ctx.tenant_id, "owner", "run-creator")
    async with tenant_session(ctx.tenant_id) as s:
        result = await docs_service.import_draft(
            s,
            DOC,
            agent,
            Principal(ctx.tenant_id, "user", "owner", user_id=owner.user_id),
            origin="run",
            cause="run_draft",
        )
    warnings = {w.code: w for w in result.version.warnings}
    # problem: not changed; risks: approved, the change waits as a patch.
    assert warnings["resolution_not_applied"].section_keys == ["problem", "risks"]
    # #396: a person reads the sections by heading; agents get the feedback ids in refs.
    left_open = warnings["resolution_not_applied"]
    assert items["problem"] not in left_open.message and "2 feedback items" in left_open.message
    assert left_open.refs == {"feedback_items": f"{items['problem']}, {items['risks']}"}
    async with tenant_session(ctx.tenant_id) as s:
        rows = {i.section_key: i.status for i in await s.scalars(select(FeedbackItem))}
    assert rows == {"solution": "addressed", "problem": "open", "risks": "open"}


async def test_a_run_draft_cannot_decline_feedback(client):
    ctx = await setup(client)
    created = await client.post(
        ctx.v(1, "/comments"),
        json={"section_key": "solution", "anchor": {"exact": "a"}, "body": "Too vague"},
        headers=ctx.auth,
    )
    item = created.json()["feedback_item_id"]
    agent = replace(
        replace(DRAFT, "A shared calendar view per project.", "A calendar per team."),
        "title: Team calendar PRD\n",
        f"title: Team calendar PRD\nresolutions:\n  - feedback_id: {item}\n    status: declined\n",
    )
    owner = await person(ctx.tenant_id, "owner", "run-creator")
    async with tenant_session(ctx.tenant_id) as s:
        result = await docs_service.import_draft(
            s,
            DOC,
            agent,
            Principal(ctx.tenant_id, "user", "owner", user_id=owner.user_id),
            origin="run",
            cause="run_draft",
        )
    assert "resolution_not_applied" in [w.code for w in result.version.warnings]
    async with tenant_session(ctx.tenant_id) as s:
        assert (await s.get(FeedbackItem, uuid.UUID(item))).status == "open"


def test_the_migration_backfills_the_same_revision():
    """0014_review backfills sections.revision with a frozen copy of the parser's."""
    import importlib.util

    from oracle.docs.parser import cited_entries, instant, section_revision
    from tests.conftest import API_DIR

    path = API_DIR / "migrations" / "versions" / "0014_review.py"
    spec = importlib.util.spec_from_file_location("m0014", path)
    migration = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(migration)
    at = datetime(2026, 9, 1, 12, 30, tzinfo=UTC)
    citation = SimpleNamespace(ref="https://x.test", title="T", excerpt=None, source="web")
    for retrieved in (at, at.replace(tzinfo=None), None):
        citation.retrieved_at = retrieved
        cited = cited_entries(["c1"], {"c1": citation})
        frozen = [["c1", "https://x.test", "T", None, "web", migration._instant(retrieved)]]
        assert cited == [tuple(frozen[0])]
        assert instant(retrieved) == migration._instant(retrieved)
        for layer in ("brief", "detail"):
            assert section_revision("h", layer, cited) == migration._revision("h", layer, frozen)
