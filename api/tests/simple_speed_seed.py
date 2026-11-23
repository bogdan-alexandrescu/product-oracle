"""simple-speed: one invented company of the size the owner's own is today, for the statement
ceilings of the reads a Simple page makes (tests/test_simple_page_reads_speed.py).

One company roadmap with 19 approved versions (each keeps its own item rows), 60 live items
and 6 in Trash across 5 tracks and 4 PRDs (15 approved versions each, with a plan), 16 goals
(4 with 3 sub-goals each), about 250 Ground Truth entities with their links, 20 milestones,
220 decisions, 120 things waiting in the Inbox (feedback and proposed changes), 65 launches,
60 items flagged potentially stale, 12 meetings, 8 drafts, 24 goal suggestions and 6 members.
Every name is made up; rows go in through the models.
"""

import hashlib
import uuid
from datetime import UTC, date, datetime, timedelta

from oracle.auth.models import User
from oracle.baseline.models import Edge, Entity
from oracle.decisions.models import Decision
from oracle.docs.models import Document, DocumentVersion
from oracle.launches.models import Launch
from oracle.review.models import DocumentReviewPolicy, FeedbackItem
from oracle.roadmap.models import (
    ProductTrack,
    RoadmapItem,
    ScheduleBasis,
    TrackerRecord,
    TrackMilestone,
    TrackPrd,
)
from oracle.simple.models import (
    RoadmapItemTask,
    SimpleChange,
    SimpleDraft,
    SimpleGoalSuggestion,
    SimpleMeeting,
    SimpleSession,
)
from oracle.tenancy import tenant_session
from tests.baseline_helpers import Ctx
from tests.conftest import make_tenant

NOW = datetime(2026, 11, 2, 20, 0, tzinfo=UTC)
GOALS, SUBGOALS, TRACKS, PRDS, PER_PRD, PRD_VERSIONS, ROADMAP_VERSIONS = 4, 3, 5, 4, 15, 15, 19
ENTITIES, MEMBERS, DECISIONS, FEEDBACK, PROPOSED, LAUNCHES = 250, 6, 220, 60, 60, 65
PRODUCTS = ("Lantern", "Harbor", "Meadow", "Quarry")


def _plan(n: int, codes: list[str]) -> str:
    start = date(2026, 10, 5) + timedelta(weeks=n)
    mid = start + timedelta(weeks=8)
    end = mid + timedelta(weeks=10)

    def on(d: date) -> str:
        return f"{d:%b} {d.day}, {d.year}"

    rows = []
    for i, code in enumerate(codes):
        m = (
            "[M1 Pilot](#milestone-m1)"
            if i == 0
            else ("[M2 Rollout](#milestone-m2)" if i == 8 else "")
        )
        rows.append(
            f"| {m} | [{code} Part {n}-{i}](#{code.lower()}) | Goal {n % GOALS} | Done {i} |"
        )
    filler = "\n".join(f"Paragraph {k} of plan {n}: example words." for k in range(120))
    return (
        f"# {PRODUCTS[n]} PRD\n\n## Features by milestone {{#brief-items}}\n\n"
        "| Milestone | Feature | Goal | Outcome |\n|---|---|---|---|\n"
        + "\n".join(rows)
        + "\n\n## Milestones {#milestones}\n\n"
        + "| Milestone | Name | Start | End |\n|---|---|---|---|\n"
        + f"| M1 | Pilot | {on(start)} | {on(mid)} |\n"
        + f"| M2 | Rollout | {on(mid + timedelta(days=1))} | {on(end)} |\n\n"
        + filler
        + "\n"
    )


def _version(doc: Document, number: int, markdown: str) -> DocumentVersion:
    return DocumentVersion(
        document_id=doc.id,
        number=number,
        markdown=markdown,
        content_hash=hashlib.sha256(markdown.encode()).hexdigest(),
        approved_at=datetime(2026, 9, 1, tzinfo=UTC) + timedelta(days=number),
    )


async def seed_company() -> Ctx:
    """The company and its members (owner, approver, commenter and viewer first)."""
    ctx = Ctx(tenant_id=await make_tenant("Example Speed Co"))
    async with tenant_session(ctx.tenant_id) as s:

        async def add(row):
            s.add(row)
            await s.flush()
            return row

        members = []
        for role in ("owner", "approver", "commenter", "viewer"):
            ctx.users[role] = await add(
                User(email=f"{role}@example.com", password_hash="x", role=role)
            )
            members.append(ctx.users[role])
        for i in range(MEMBERS - len(members)):
            members.append(
                await add(
                    User(
                        email=f"member{i}@example.com",
                        password_hash="x",
                        role=("approver", "commenter")[i % 2],
                        name=f"Member {i}",
                    )
                )
            )
        goals = [
            await add(
                Entity(
                    type="goal",
                    key=f"goal-{g}",
                    title=f"Grow example metric {g}",
                    status="confirmed",
                    origin="user",
                    attrs={"target": "40%", "metric": f"Metric {g}", "due": "2027-06-30"},
                )
            )
            for g in range(GOALS)
        ]
        for g, goal in enumerate(goals):
            for k in range(SUBGOALS):
                s.add(
                    Entity(
                        type="goal",
                        key=f"goal-{g}-{k}",
                        title=f"Example step {k} of metric {g}",
                        status="confirmed",
                        origin="user",
                        parent_id=goal.id,
                        attrs={"target": f"{10 * (k + 1)}%", "due": "2027-03-31"},
                    )
                )
        features: list[Entity] = []
        for n in range(ENTITIES - GOALS * (1 + SUBGOALS)):
            kind = "feature" if n < 180 else ("requirement", "constraint", "product")[n % 3]
            e = Entity(
                type=kind,
                key=f"F-{100 + n}" if kind == "feature" else f"{kind}-{n}",
                title=f"Example {kind} {n}",
                status="confirmed",
                origin="user",
                attrs={"effort": ("XS", "S", "M", "L")[n % 4]} if kind == "feature" else {},
            )
            s.add(e)
            if kind == "feature":
                features.append(e)
        await s.flush()
        for n, f in enumerate(features[:150]):
            s.add(
                Edge(
                    src_id=f.id,
                    dst_id=goals[n % GOALS].id,
                    type="supports",
                    status="confirmed",
                    origin="user",
                )
            )
        await s.flush()

        roadmap = await add(
            Document(
                slug="company-roadmap",
                title="Company roadmap",
                kind="roadmap",
                status="approved",
                visibility="company",
                company_roadmap=True,
            )
        )
        rvs = [
            await add(_version(roadmap, k, f"# Company roadmap v{k}\n"))
            for k in range(1, ROADMAP_VERSIONS + 1)
        ]
        rv = rvs[-1]
        s.add(DocumentReviewPolicy(document_id=roadmap.id, decider_id=members[1].id))
        prds: list[tuple[Document, DocumentVersion, list[str]]] = []
        for p in range(PRDS):
            doc = await add(
                Document(
                    slug=f"{PRODUCTS[p].lower()}-prd",
                    title=f"{PRODUCTS[p]} PRD",
                    kind="prd",
                    status="approved",
                    visibility="company",
                )
            )
            codes = [features[p * PER_PRD + i].key for i in range(PER_PRD)]
            pv = None
            for k in range(1, PRD_VERSIONS + 1):
                pv = await add(_version(doc, k, _plan(p, codes) + f"\nRevision {k}\n"))
            prds.append((doc, pv, codes))
        tracks = []
        for t in range(TRACKS):
            # Four tracks each follow a PRD; the fifth holds none.
            lead = prds[t] if t < PRDS else None
            track = await add(
                ProductTrack(
                    prd_document_id=lead[0].id if lead else None,
                    started_version_id=lead[1].id if lead else None,
                    current_version_id=lead[1].id if lead else None,
                    roadmap_document_id=roadmap.id,
                    title=f"Track {t}",
                    owner_id=members[1 + t % (MEMBERS - 1)].id,
                    goal_id=goals[t % GOALS].id,
                    position=t + 1,
                )
            )
            tracks.append(track)
        assert TrackPrd is not None
        items: list[RoadmapItem] = []
        for p, (doc, pv, codes) in enumerate(prds):
            for i, code in enumerate(codes):
                n = p * PER_PRD + i
                track = tracks[n % TRACKS]
                kw: dict = {
                    "horizon": ("now", "next", "later")[n % 3],
                    "confidence": ("low", "medium", "high")[n % 3],
                }
                deps = []
                if i and i % 8:
                    deps.append(codes[i - 1])
                if p and i == 3:
                    deps.append(prds[p - 1][2][5])  # another PRD's feature
                if n % 2 == 0:
                    kw.update(
                        start_date=date(2026, 10, 1) + timedelta(days=n % 90),
                        end_date=date(2026, 11, 15) + timedelta(days=n % 120),
                        date_source="typed",
                    )
                if i in (2, 10):
                    kw["parent_key"] = codes[i - 1]
                if n % 7 == 0:
                    kw["goal_ids"] = [goals[(n // 7) % GOALS].id]
                if n % 5 == 0:
                    kw["owner_id"] = members[n % MEMBERS].id
                row = RoadmapItem(
                    roadmap_document_id=roadmap.id,
                    roadmap_version_id=rv.id,
                    item_key=code,
                    title=f"Part {p}-{i}",
                    prd_document_id=doc.id,
                    prd_version_id=pv.id,
                    prd_section_key=code.lower(),
                    feature_id=features[n].id,
                    position=n,
                    track_id=track.id,
                    depends_on=deps,
                    # The owner's company: every item potentially stale.
                    freshness="potentially_stale",
                    stale_since=NOW - timedelta(days=3),
                    stale_reasons=[f"{PRODUCTS[p]} PRD changed since this item was written"],
                    **kw,
                )
                s.add(row)
                items.append(row)
                # Every older approved version keeps its own copy of the item.
                for old in rvs[:-1]:
                    s.add(
                        RoadmapItem(
                            roadmap_document_id=roadmap.id,
                            roadmap_version_id=old.id,
                            item_key=code,
                            title=f"Part {p}-{i}",
                            horizon="now",
                            position=n,
                            prd_document_id=doc.id,
                            prd_version_id=pv.id,
                            feature_id=features[n].id,
                        )
                    )
                if n % 4 == 1:
                    s.add(
                        TrackerRecord(
                            tracker="linear",
                            external_ref=f"EX-{n}",
                            track_id=track.id,
                            item_key=code,
                            state=("todo", "in_progress", "done")[n % 3],
                            target_date=date(2026, 12, 1) + timedelta(days=n % 40),
                            observed_at=NOW,
                        )
                    )
                if n % 4 == 2:
                    s.add(
                        ScheduleBasis(
                            kind="estimate",
                            reference=f"EST-{n}",
                            supports_date=date(2026, 12, 10),
                            prd_document_id=doc.id,
                            item_key=code,
                            status="verified",
                            verified_at=NOW,
                        )
                    )
        # Six more in Trash.
        for n in range(6):
            doc, pv, _ = prds[n % PRDS]
            s.add(
                RoadmapItem(
                    roadmap_document_id=roadmap.id,
                    roadmap_version_id=rv.id,
                    item_key=f"X-{n}",
                    title=f"Dropped part {n}",
                    prd_document_id=doc.id,
                    prd_version_id=pv.id,
                    feature_id=features[100 + n].id,
                    horizon="later",
                    position=200 + n,
                    track_id=tracks[n % TRACKS].id,
                    cut=True,
                )
            )
        await s.flush()
        for n, row in enumerate(items):
            if n % 3 == 0:
                for k in range(2):
                    s.add(
                        RoadmapItemTask(
                            item_id=row.id,
                            roadmap_document_id=roadmap.id,
                            item_key=row.item_key,
                            title=f"Task {n}-{k}",
                            position=k,
                            created_by=members[0].id,
                        )
                    )
        for t, track in enumerate(tracks[:PRDS]):
            for m in range(2):
                s.add(
                    TrackMilestone(
                        track_id=track.id,
                        name=f"Track {t} step {m}",
                        horizon="now",
                        item_keys=[prds[t][2][m * 3 + j] for j in range(3)],
                    )
                )
        for g, goal in enumerate(goals):
            for m in range(3):
                p = (g + m) % PRDS
                s.add(
                    TrackMilestone(
                        roadmap_id=roadmap.id,
                        goal_id=goal.id,
                        code=f"M{g * 3 + m + 1}",
                        name=f"Goal {g} step {m}",
                        horizon="now",
                        kind="delivery",
                        target_date=date(2026, 11, 1) + timedelta(days=14 * (g * 3 + m)),
                        item_ids=[items[p * PER_PRD + m * 2 + j].id for j in range(2)],
                    )
                )
        await s.flush()

        editing = await add(
            SimpleSession(
                kind="editing",
                started_by=members[0].id,
                started_at=NOW - timedelta(days=5),
                closed_at=NOW - timedelta(days=5) + timedelta(hours=1),
            )
        )
        meeting_sessions = []
        for m in range(12):
            ms = await add(
                SimpleSession(
                    kind="meeting",
                    started_by=members[0].id,
                    started_at=NOW - timedelta(days=m + 1),
                    closed_at=NOW - timedelta(days=m + 1) + timedelta(hours=1),
                )
            )
            s.add(
                SimpleMeeting(
                    title=f"Example review {m}",
                    prd_document_id=prds[m % PRDS][0].id,
                    origin="one_pager",
                    session_id=ms.id,
                    presenter_id=members[0].id,
                    attendee_ids=[u.id for u in members[:4]],
                    joined_ids=[members[0].id],
                    status="ended",
                    started_at=ms.started_at,
                    ended_at=ms.closed_at,
                    ended_by=members[0].id,
                )
            )
            meeting_sessions.append(ms.id)
        draft = await add(
            SimpleDraft(
                document_id=roadmap.id,
                base_version_id=rv.id,
                status="working",
                created_by=members[0].id,
                participant_ids=[members[0].id],
                overlay={},
            )
        )
        for d in range(7):
            s.add(
                SimpleDraft(
                    document_id=roadmap.id,
                    base_version_id=rvs[d].id,
                    status=("approved", "discarded")[d % 2],
                    created_by=members[d % MEMBERS].id,
                    participant_ids=[members[0].id],
                    overlay={},
                )
            )
        for c in range(PROPOSED + 240):
            row = items[c % len(items)]
            proposed = c < PROPOSED
            s.add(
                SimpleChange(
                    session_id=None
                    if proposed
                    else (
                        meeting_sessions[c % len(meeting_sessions)] if c % 4 == 1 else editing.id
                    ),
                    document_id=roadmap.id,
                    op="edit_title",
                    target={"item_id": str(row.id)},
                    before={"title": row.title},
                    after={"title": f"{row.title} v{c}"},
                    status="proposed" if proposed else ("applied", "accepted", "undone")[c % 3],
                    by=members[1 + c % (MEMBERS - 1)].id if proposed else members[0].id,
                    at=NOW - timedelta(hours=c),
                    routed_to=[members[0].id, members[1].id] if proposed else [],
                    draft_ids=[] if proposed else [draft.id],
                )
            )
        for d in range(DECISIONS):
            row = items[(d * 5) % len(items)]
            state = ("decided", "decided", "proposed", "reversed")[d % 4]
            decided = state == "decided"
            s.add(
                Decision(
                    number=d + 1,
                    title=f"Example call {d}",
                    status=state,
                    chosen_option="A" if decided else None,
                    rationale="Example reason" if decided else None,
                    decided_at=NOW - timedelta(days=d) if decided else None,
                    review_at=date(2027, 1, 4) if decided else None,
                    reversibility="reversible",
                    approver_id=members[d % MEMBERS].id,
                    driver="Example driver",
                    origin="manual",
                    subjects=[{"kind": "roadmap_item", "id": str(row.id)}],
                )
            )
        for f in range(FEEDBACK):
            s.add(
                FeedbackItem(
                    document_id=prds[f % PRDS][0].id,
                    raised_on_version=PRD_VERSIONS,
                    kind="general",
                    summary=f"Example feedback {f}",
                    author_id=members[f % MEMBERS].id,
                    status="open",
                    section_key="scope",
                )
            )
        for n in range(LAUNCHES):
            p, i = n % PRDS, n % PER_PRD
            s.add(
                Launch(
                    title=f"Example launch {n}",
                    track_id=tracks[(p * PER_PRD + i) % TRACKS].id,
                    roadmap_version_id=rv.id,
                    item_keys=[prds[p][2][i], f"launch-{n}"],
                    state=("planned", "ready", "launched")[n % 3],
                    tier_suggestion={},
                    owner_id=members[n % MEMBERS].id,
                    launched_at=NOW - timedelta(days=n) if n % 3 == 2 else None,
                    created_by=members[0].id,
                )
            )
        for g, goal in enumerate(goals):
            for n in range(6):
                status = ("open", "open", "rejected", "accepted")[n % 4]
                s.add(
                    SimpleGoalSuggestion(
                        goal_id=goal.id,
                        title=f"Example idea {g}-{n}",
                        outcome="An example outcome",
                        why="Asked for in example interviews",
                        evidence=[],
                        status=status,
                        origin="auto",
                        reason="Not now" if status == "rejected" else None,
                    )
                )
        await s.commit()
    return ctx


def session_ids(ctx: Ctx) -> dict[str, uuid.UUID]:
    return {name: user.id for name, user in ctx.users.items()}
