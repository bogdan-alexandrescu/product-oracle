"""A company the size of a real one, for the Inbox read's budget (test_inbox_read_budget):
4 goals, 5 tracks, 25 PRDs, 400 roadmap items, 2,000 Ground Truth entities, 1,500 changes
(300 proposed), 200 decisions, 150 drafts, 60 meetings, 30 members and 500 feedback items,
20 runs waiting at Confirm the baseline and three more that touch each other's items
(:func:`cross_runs`), in a company time zone not the default. Invented example data only;
rows go in by bulk insert, so seeding stays quick."""

import hashlib
import uuid
from datetime import UTC, datetime, timedelta

from oracle.auth.models import User
from oracle.baseline.models import Conflict, Edge, Entity, EntityRevision, Proposal
from oracle.decisions.models import Decision
from oracle.docs.models import Document, DocumentVersion
from oracle.review.models import FeedbackItem
from oracle.roadmap.models import ProductTrack, RoadmapItem
from oracle.runs.models import Checkpoint, Run, RunSegment
from oracle.simple.models import SimpleChange, SimpleDraft, SimpleMeeting, SimpleSession
from oracle.tenancy import tenant_session
from oracle.tenant_settings import TenantSetting
from tests.baseline_helpers import Ctx

NOW = datetime(2026, 11, 1, 12, tzinfo=UTC)
# Not the default (America/Los_Angeles): rows that tell a day tell it here.
ZONE = "Pacific/Auckland"
# The Confirm the baseline stops cross_runs adds.
CROSS_STOPS = 3
PROPOSED = {"status": "proposed"}
DECIDED = {
    "status": "decided",
    "chosen_option": "a",
    "rationale": "Example",
    "decided_at": NOW,
    "review_at": NOW + timedelta(days=30),
}


def _version(doc: Document, n: int, **kw) -> DocumentVersion:
    text = f"# {doc.title} v{n}\n\n## Scope\n\nExample scope.\n"
    return DocumentVersion(
        id=uuid.uuid4(),
        document_id=doc.id,
        number=n,
        markdown=text,
        content_hash=hashlib.sha256(text.encode()).hexdigest(),
        **kw,
    )


async def seed_company(ctx: Ctx, scale: int = 1) -> None:
    """``scale`` divides the row counts (20 for a small company of the same shape)."""

    def n(count: int) -> int:
        return max(1, count // scale)

    async with tenant_session(ctx.tenant_id) as s:
        owner = ctx.users["owner"].id
        members = [ctx.users[r].id for r in ("owner", "approver", "commenter", "viewer")]
        for i in range(n(30) - len(members)):
            u = User(
                id=uuid.uuid4(),
                email=f"member{i}@example.com",
                password_hash="x",
                role=("approver", "commenter", "viewer")[i % 3],
                name=f"Member {i}",
            )
            s.add(u)
            members.append(u.id)
        await s.flush()
        goals = [
            Entity(
                id=uuid.uuid4(),
                type="goal",
                key=f"goal-{g}",
                title=f"Goal {g}",
                status="confirmed",
                origin="user",
                attrs={},
            )
            for g in range(4)
        ]
        features = [
            Entity(
                id=uuid.uuid4(),
                type="feature",
                key=f"feature-{f}",
                title=f"Feature {f}",
                status="confirmed",
                origin="user",
                attrs={"code": f"F-{f + 1}"},
            )
            for f in range(n(2000) - 4)
        ]
        s.add_all([*goals, *features])
        await s.flush()
        s.add_all(
            Edge(
                src_id=f.id,
                dst_id=goals[i % 4].id,
                type="supports",
                status="confirmed",
                origin="user",
            )
            for i, f in enumerate(features)
        )
        prds, prd_versions = [], []
        for p in range(n(25)):
            d = Document(
                id=uuid.uuid4(),
                slug=f"prd-{p}",
                title=f"Example PRD {p}",
                kind="prd",
                status="approved",
            )
            s.add(d)
            prds.append(d)
        await s.flush()
        for d in prds:
            v = _version(d, 1, approved_at=NOW - timedelta(days=10))
            s.add(v)
            prd_versions.append(v)
        await s.flush()
        roadmaps, items = [], []
        per = n(400) // n(5) or 1
        for t in range(n(5)):
            pv = prd_versions[t % len(prd_versions)]
            rm = Document(
                id=uuid.uuid4(),
                slug=f"roadmap-{t}",
                title=f"Roadmap {t}",
                kind="roadmap",
                status="approved",
            )
            s.add(rm)
            await s.flush()
            rv = _version(rm, 1, approved_at=NOW - timedelta(days=9), source_version_id=pv.id)
            s.add(rv)
            await s.flush()
            track = ProductTrack(
                id=uuid.uuid4(),
                prd_document_id=pv.document_id,
                started_version_id=pv.id,
                current_version_id=pv.id,
                roadmap_document_id=rm.id,
                title=f"Track {t}",
                owner_id=members[t % len(members)],
            )
            s.add(track)
            await s.flush()
            roadmaps.append((rm, rv))
            for i in range(per):
                k = t * per + i
                pv_i = prd_versions[k % len(prd_versions)]
                it = RoadmapItem(
                    id=uuid.uuid4(),
                    roadmap_document_id=rm.id,
                    roadmap_version_id=rv.id,
                    item_key=f"item-{k}",
                    title=f"Item {k}",
                    horizon=("now", "next", "later")[k % 3],
                    position=i,
                    prd_document_id=pv_i.document_id,
                    prd_version_id=pv_i.id,
                    prd_section_key="scope",
                    feature_id=features[k % len(features)].id,
                    track_id=track.id,
                    owner_id=members[k % len(members)],
                )
                s.add(it)
                items.append(it)
        await s.flush()
        sessions = []
        for m in range(n(60)):
            ses = SimpleSession(
                id=uuid.uuid4(),
                kind="meeting",
                started_by=owner,
                started_at=NOW - timedelta(days=m),
                closed_at=NOW,
            )
            s.add(ses)
            sessions.append(ses)
        await s.flush()
        for m, ses in enumerate(sessions):
            s.add(
                SimpleMeeting(
                    id=uuid.uuid4(),
                    title=f"Review {m}",
                    prd_document_id=prds[m % len(prds)].id,
                    origin="roadmap",
                    session_id=ses.id,
                    presenter_id=owner,
                    attendee_ids=members[:6],
                    started_at=ses.started_at,
                    ended_at=ses.started_at + timedelta(hours=1),
                )
            )
        changes = n(1500)
        for c in range(changes):
            it = items[c % len(items)]
            proposed = c < n(300)
            s.add(
                SimpleChange(
                    op="cut",
                    target={"item_id": str(it.id)},
                    before={"cut": False},
                    after={"cut": True},
                    status="proposed" if proposed else "accepted",
                    by=members[2 + c % (len(members) - 2)] if proposed else owner,
                    at=NOW - timedelta(hours=c),
                    decided_at=None if proposed else NOW - timedelta(hours=c),
                    decided_by=None if proposed else owner,
                    routed_to=[owner] if proposed else [],
                    session_id=sessions[c % len(sessions)].id if c % 4 == 0 else None,
                )
            )
        for d in range(n(200)):
            s.add(
                Decision(
                    number=d + 1,
                    title=f"Decision {d}",
                    approver_id=members[d % 4],
                    driver="Example driver",
                    origin="manual",
                    **(PROPOSED if d % 2 == 0 else DECIDED),
                )
            )
        for d in range(n(150)):
            # One working draft per roadmap; the rest approved drafts of the PRDs.
            working = d < len(roadmaps)
            doc, ver = (
                roadmaps[d] if working else (prds[d % len(prds)], prd_versions[d % len(prds)])
            )
            s.add(
                SimpleDraft(
                    document_id=doc.id,
                    base_version_id=ver.id,
                    status="working" if working else "approved",
                    created_by=members[d % len(members)],
                )
            )
        for f in range(n(500)):
            d = prds[f % len(prds)]
            s.add(
                FeedbackItem(
                    document_id=d.id,
                    raised_on_version=1,
                    kind="general",
                    summary=f"Example feedback {f}",
                    author_id=members[f % len(members)],
                    status="open",
                    section_key="scope",
                )
            )
        s.add(TenantSetting(key="company_timezone", value=ZONE))
        await s.commit()
    await stops(ctx, n(20))
    await cross_runs(ctx)


async def stops(ctx: Ctx, count: int) -> None:
    """``count`` runs waiting at Confirm the baseline, each with a goal it proposed (open:
    the stop's gate reason) and a feature it found."""
    async with tenant_session(ctx.tenant_id) as s:
        for _ in range(count):
            run = Run(
                id=uuid.uuid4(),
                flow="baseline_to_prd",
                status="awaiting_checkpoint",
                created_by=ctx.users["owner"].id,
            )
            s.add(run)
            await s.flush()
            tag = run.id.hex[:8]
            s.add_all(
                [
                    Entity(
                        type="goal",
                        key=f"run-goal-{tag}",
                        title=f"Run goal {tag}",
                        status="proposed",
                        origin="agent",
                        run_id=run.id,
                        attrs={},
                    ),
                    Entity(
                        type="feature",
                        key=f"run-feature-{tag}",
                        title=f"Run feature {tag}",
                        status="proposed",
                        origin="agent",
                        run_id=run.id,
                        attrs={},
                    ),
                    RunSegment(run_id=run.id, seq=1, name="baseline", status="succeeded"),
                    Checkpoint(
                        run_id=run.id,
                        kind="baseline_confirm",
                        status="pending",
                        approver_role="approver",
                        payload={"segment_seq": 1},
                    ),
                ]
            )
        await s.commit()


def _run(ctx: Ctx) -> Run:
    return Run(
        id=uuid.uuid4(),
        flow="baseline_to_prd",
        status="awaiting_checkpoint",
        created_by=ctx.users["owner"].id,
    )


def _stop(run: Run, role: str = "approver") -> list:
    return [
        RunSegment(run_id=run.id, seq=1, name="baseline", status="succeeded"),
        Checkpoint(
            run_id=run.id,
            kind="baseline_confirm",
            status="pending",
            approver_role=role,
            payload={"segment_seq": 1},
        ),
    ]


async def cross_runs(ctx: Ctx) -> None:
    """Three runs waiting at Confirm the baseline whose items cross: run A proposes a goal,
    a feature and the edge between them; run B revises A's goal and edge and finds a
    feature of its own, on which sources disagree (an open material conflict); run C, a
    stop only an owner may approve, proposes changes to A's feature and B's (open) and
    withdrew one to A's goal."""
    async with tenant_session(ctx.tenant_id) as s:
        a, b, c = _run(ctx), _run(ctx), _run(ctx)
        s.add_all([a, b, c])
        await s.flush()

        def ent(run: Run, type_: str, name: str) -> Entity:
            return Entity(
                id=uuid.uuid4(),
                type=type_,
                key=f"cross-{name}-{run.id.hex[:8]}",
                title=f"Cross-run {name}",
                status="proposed",
                origin="agent",
                run_id=run.id,
                attrs={},
            )

        goal_a, feature_a, feature_b = (
            ent(a, "goal", "goal"),
            ent(a, "feature", "feature A"),
            ent(b, "feature", "feature B"),
        )
        s.add_all([goal_a, feature_a, feature_b])
        await s.flush()
        edge_a = Edge(
            id=uuid.uuid4(),
            src_id=feature_a.id,
            dst_id=goal_a.id,
            type="supports",
            status="proposed",
            origin="agent",
            run_id=a.id,
        )
        s.add(edge_a)
        await s.flush()
        actor_b, actor_c = f"run:{b.id}", f"run:{c.id}"
        s.add_all(
            [
                *_stop(a),
                *_stop(b),
                *_stop(c, "owner"),
                EntityRevision(
                    entity_id=goal_a.id,
                    before={"title": "Cross-run goal"},
                    after={"title": "Cross-run goal, revised"},
                    actor=actor_b,
                    run_id=b.id,
                ),
                EntityRevision(
                    edge_id=edge_a.id,
                    before={"status": "proposed"},
                    after={"status": "proposed", "attrs": {"weight": 2}},
                    actor=actor_b,
                    run_id=b.id,
                ),
                Conflict(
                    entity_id=feature_b.id,
                    field="title",
                    claims=[
                        {"value": "Cross-run feature B", "evidence_ids": []},
                        {"value": "Another title", "evidence_ids": []},
                    ],
                    material=True,
                    status="open",
                ),
                Proposal(
                    entity_id=feature_a.id,
                    payload={"title": "Feature A, as C reads it"},
                    run_id=c.id,
                    actor=actor_c,
                    status="open",
                ),
                Proposal(
                    entity_id=feature_b.id,
                    payload={"title": "Feature B, as C reads it"},
                    run_id=c.id,
                    actor=actor_c,
                    status="open",
                ),
                Proposal(
                    entity_id=goal_a.id,
                    payload={"title": "Goal, as C first read it"},
                    run_id=c.id,
                    actor=actor_c,
                    status="withdrawn",
                ),
            ]
        )
        await s.commit()
