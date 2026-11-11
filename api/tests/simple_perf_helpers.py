"""A company the size of a real one, for the Simple reads' timing and statement-count tests
(tests/test_simple_reads_perf.py): 4 goals, 5 tracks, 25 PRDs each with its roadmap, 400 live
roadmap items and 200 cut (Trash), about 2,000 Ground Truth entities, 1,500 changes (300
proposed), 150 drafts (25 working), 60 meetings, 30 members and 120 goal suggestions.

Invented example data only. Rows are added in bulk through the models; the caller's clock
is the tests' (Nov 2, 2026)."""

import hashlib
from dataclasses import dataclass, field
from datetime import UTC, date, datetime, timedelta
from typing import Any

from oracle.auth.models import User
from oracle.baseline.models import Edge, Entity
from oracle.docs.models import Document, DocumentVersion
from oracle.review.models import DocumentReviewPolicy
from oracle.roadmap.models import ProductTrack, RoadmapItem
from oracle.simple.models import (
    SimpleChange,
    SimpleDraft,
    SimpleGoalSuggestion,
    SimpleMeeting,
    SimpleSession,
)
from oracle.tenancy import tenant_session
from tests.baseline_helpers import Ctx

AT = datetime(2026, 10, 1, 16, 0, tzinfo=UTC)
VERBS = ("Bulk", "Guided", "Faster", "Shared", "Scheduled", "Mobile", "Offline", "Smart",
         "Custom", "Audit", "Team", "Instant", "Secure", "Simple", "Weekly", "Live")  # fmt: skip
NOUNS = ("export", "setup", "search", "invoices", "reports", "alerts", "sign in", "billing",
         "dashboards", "comments", "uploads", "roles", "calendar", "checkout", "onboarding",
         "templates", "reminders", "payments", "tags", "history", "sharing", "imports",
         "approvals", "filters", "webhooks")  # fmt: skip


def title(n: int) -> str:
    """An invented feature name; names repeat their words as a real company's do."""
    base = f"{VERBS[n % len(VERBS)]} {NOUNS[(n // len(VERBS)) % len(NOUNS)]}"
    return base if n < len(VERBS) * len(NOUNS) else f"{base} for {NOUNS[n % len(NOUNS)]}"


@dataclass
class Company:
    goals: list[Entity] = field(default_factory=list)
    roadmaps: list[Document] = field(default_factory=list)
    prds: list[Document] = field(default_factory=list)
    items: list[RoadmapItem] = field(default_factory=list)
    drafts: dict[Any, SimpleDraft] = field(default_factory=dict)


def _version(doc: Document, n: int = 1) -> DocumentVersion:
    body = f"# {doc.slug} v{n}\n\n## Scope\n\nExample scope.\n"
    return DocumentVersion(
        document_id=doc.id,
        number=n,
        markdown=body,
        content_hash=hashlib.sha256(body.encode()).hexdigest(),
        approved_at=datetime(2026, 9, 1, tzinfo=UTC),
    )


async def seed_company(ctx: Ctx, *, prds: int = 25, per: int = 16, cut_per: int = 8,
                       entities: int = 2000, changes: int = 1500, proposed: int = 300,
                       drafts: int = 150, meetings: int = 60, members: int = 30,
                       suggestions_per_goal: int = 30) -> Company:  # fmt: skip
    co = Company()
    owner = ctx.users["owner"]
    async with tenant_session(ctx.tenant_id) as s:
        people = [owner, ctx.users["approver"], ctx.users["commenter"], ctx.users["viewer"]]
        for n in range(members - len(people)):
            role = ("approver", "commenter", "viewer")[n % 3]
            user = User(email=f"member{n}@example.com", name=f"Member {n}", password_hash="x",
                        role=role)  # fmt: skip
            s.add(user)
            people.append(user)
        await s.flush()

        co.goals = [
            Entity(type="goal", key=f"goal-{g}", title=f"Grow example metric {g}",
                   status="confirmed", origin="user", attrs={})  # fmt: skip
            for g in range(4)
        ]
        s.add_all(co.goals)
        features = [
            Entity(type="feature", key=f"feature-{f}", title=title(f),
                   status="confirmed", origin="user", attrs={})  # fmt: skip
            for f in range(entities * 3 // 4)
        ]
        others = [
            Entity(type=("requirement", "constraint", "decision")[f % 3], key=f"other-{f}",
                   title=f"Example entity {f}", status="confirmed", origin="user", attrs={})  # fmt: skip
            for f in range(entities - len(features) - len(co.goals))
        ]
        s.add_all(features + others)
        await s.flush()
        s.add_all(
            Edge(src_id=f.id, dst_id=co.goals[i % 4].id, type="supports", status="confirmed",
                 origin="user")  # fmt: skip
            for i, f in enumerate(features)
        )

        tracks: list[ProductTrack] = []
        for r in range(prds):
            prd = Document(slug=f"prd-{r}", title=f"Example PRD {r}", kind="prd",
                           status="approved", visibility="company")  # fmt: skip
            rm = Document(slug=f"roadmap-{r}", title=f"Example roadmap {r}", kind="roadmap",
                          status="approved", visibility="company")  # fmt: skip
            s.add_all([prd, rm])
            await s.flush()
            pv, rv = _version(prd), _version(rm)
            s.add_all([pv, rv])
            await s.flush()
            co.prds.append(prd)
            co.roadmaps.append(rm)
            track = ProductTrack(prd_document_id=prd.id, started_version_id=pv.id,
                                 current_version_id=pv.id, roadmap_document_id=rm.id,
                                 title=f"Track {r % 5}", owner_id=people[1 + r % 3].id)  # fmt: skip
            s.add(track)
            await s.flush()
            tracks.append(track)
            if r % 2 == 0:
                s.add(DocumentReviewPolicy(document_id=rm.id, decider_id=people[1].id))
            for i in range(per + cut_per):
                kw: dict[str, Any] = {}
                if i % 3 == 0:
                    kw.update(start_date=date(2026, 10, 1) + timedelta(days=i * 3),
                              end_date=date(2026, 11, 15) + timedelta(days=i * 3),
                              date_source="typed")  # fmt: skip
                if 0 < i < per:
                    kw["depends_on"] = [f"item-{i - 1}"]
                item = RoadmapItem(
                    roadmap_document_id=rm.id,
                    roadmap_version_id=rv.id,
                    item_key=f"item-{i}",
                    title=title(r * (per + cut_per) + i),
                    prd_document_id=prd.id,
                    prd_version_id=pv.id,
                    horizon=("now", "next", "later")[i % 3],
                    position=i,
                    track_id=track.id,
                    feature_id=features[(r * (per + cut_per) + i) % len(features)].id,
                    cut=i >= per,
                    **kw,
                )
                s.add(item)
                co.items.append(item)
        await s.flush()

        live = [i for i in co.items if not i.cut]
        session = SimpleSession(kind="editing", started_by=owner.id, started_at=AT,
                                closed_at=AT + timedelta(hours=1))  # fmt: skip
        s.add(session)
        await s.flush()
        for n in range(drafts):
            rm = co.roadmaps[n % prds]
            working = n < prds
            d = SimpleDraft(
                document_id=rm.id,
                status="working" if working else ("approved", "discarded", "submitted")[n % 3],
                created_by=owner.id,
                participant_ids=[owner.id],
                overlay={},
            )
            if d.status == "submitted":
                d.status = "approved"
            s.add(d)
            if working:
                co.drafts[rm.id] = d
        await s.flush()
        for n in range(changes):
            item = live[n % len(live)]
            is_proposal = n < proposed
            draft = co.drafts.get(item.roadmap_document_id)
            s.add(
                SimpleChange(
                    session_id=None if is_proposal else session.id,
                    document_id=item.roadmap_document_id,
                    op="edit_title",
                    target={"item_id": str(item.id)},
                    before={"title": item.title},
                    after={"title": f"{item.title} v{n}"},
                    status="proposed" if is_proposal else "applied",
                    by=people[1 + n % (len(people) - 1)].id if is_proposal else owner.id,
                    at=AT + timedelta(minutes=n),
                    routed_to=[owner.id] if is_proposal else [],
                    draft_ids=[draft.id] if (draft is not None and not is_proposal) else [],
                )
            )
        await s.flush()

        for g, goal in enumerate(co.goals):
            for n in range(suggestions_per_goal):
                status = ("open", "open", "rejected", "accepted")[n % 4]
                s.add(
                    SimpleGoalSuggestion(
                        goal_id=goal.id,
                        title=f"{title(g * suggestions_per_goal + n * 7)} v2",
                        outcome="An example outcome",
                        why="Asked for in example interviews",
                        evidence=[],
                        status=status,
                        origin="auto",
                        reason="Not now" if status == "rejected" else None,
                    )
                )

        for n in range(meetings):
            ms = SimpleSession(kind="meeting", started_by=owner.id,
                               started_at=AT + timedelta(days=n % 30),
                               closed_at=AT + timedelta(days=n % 30, hours=1))  # fmt: skip
            s.add(ms)
            await s.flush()
            s.add(
                SimpleMeeting(
                    title=f"Example review {n}",
                    prd_document_id=co.prds[n % prds].id,
                    origin="one_pager",
                    session_id=ms.id,
                    presenter_id=owner.id,
                    attendee_ids=[p.id for p in people[:5]],
                    joined_ids=[owner.id],
                    status="ended",
                    started_at=ms.started_at,
                    ended_at=ms.closed_at,
                    ended_by=owner.id,
                )
            )
        await s.commit()
    return co
