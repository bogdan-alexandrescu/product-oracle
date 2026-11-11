"""A company the size of a real one, for the one waiting list's speed and sameness tests
(tests/test_simple_waiting_speed.py): 4 goals, 5 tracks, 25 PRDs, 400 roadmap items, 2,000
Ground Truth entities, 1,500 changes (300 proposed), 200 decisions, 150 drafts, 60 meetings
and 30 members. Invented example data only."""

from __future__ import annotations

import hashlib
import uuid
from datetime import UTC, date, datetime, timedelta
from typing import Any

from sqlalchemy import insert

from oracle.auth.models import User
from oracle.baseline.models import Edge, Entity
from oracle.decisions.models import Decision
from oracle.docs.models import Document, DocumentVersion
from oracle.review.models import DocumentReviewPolicy
from oracle.roadmap.models import ProductTrack, RoadmapItem
from oracle.runs.models import Checkpoint, Run, RunSegment
from oracle.simple import suggestions
from oracle.simple.models import (
    SimpleChange,
    SimpleDraft,
    SimpleGoalSuggestion,
    SimpleMeeting,
    SimpleSession,
)
from oracle.tenancy import tenant_session
from tests.baseline_helpers import Ctx

AT = datetime(2026, 10, 20, 9, tzinfo=UTC)
ROLES = ("owner", "approver", "commenter", "viewer")


async def big_company(ctx: Ctx) -> dict[str, Any]:
    """Seeds ``ctx``'s company; returns the members' ids by name (``member-<n>``) and the
    roadmaps' deciders."""
    out: dict[str, Any] = {"members": {}}
    async with tenant_session(ctx.tenant_id) as s:

        async def add(row):
            s.add(row)
            await s.flush()
            return row

        # 30 members: the four of make_ctx and 26 more, every role.
        members = [u.id for u in ctx.users.values()]
        for n in range(26):
            u = await add(User(email=f"member-{n}@example.com", password_hash="x",
                               role=ROLES[n % 4], name=f"Member {n}"))  # fmt: skip
            out["members"][f"member-{n}"] = u
            members.append(u.id)
        approver = ctx.users["approver"].id
        owner = ctx.users["owner"].id

        # 4 goals (a fifth proposed), 2,000 Ground Truth entities in all.
        goals = []
        for g in range(4):
            goal = Entity(type="goal", key=f"goal-{g}", title=f"Goal {g}", status="confirmed",
                          origin="user", attrs={})  # fmt: skip
            goals.append(await add(goal))
        await add(Entity(type="goal", key="goal-proposed", title="A proposed goal",
                         status="proposed", origin="agent", attrs={}))  # fmt: skip
        rows = []
        for f in range(1995):
            kind = "feature" if f < 600 else ("requirement", "person", "outcome")[f % 3]
            rows.append({"id": uuid.uuid4(), "tenant_id": ctx.tenant_id, "type": kind,
                         "key": f"entity-{f}", "title": f"Entity {f}", "status": "confirmed",
                         "origin": "user", "attrs": {}})  # fmt: skip
        await s.execute(insert(Entity), rows)
        features = [r["id"] for r in rows[:600]]
        await s.execute(insert(Edge), [
            {"id": uuid.uuid4(), "tenant_id": ctx.tenant_id, "src_id": fid,
             "dst_id": goals[i % 4].id, "type": "supports", "status": "confirmed",
             "origin": "user"}
            for i, fid in enumerate(features)
        ])  # fmt: skip

        # 25 PRDs, 5 roadmaps (one per track), 400 items: 80 per roadmap, 16 per PRD.
        def body(slug: str) -> dict[str, Any]:
            text = f"# {slug}\n"
            return {"markdown": text, "content_hash": hashlib.sha256(text.encode()).hexdigest(),
                    "approved_at": AT - timedelta(days=30)}  # fmt: skip

        prds = []
        for p in range(25):
            doc = await add(Document(slug=f"prd-{p}", title=f"Example PRD {p}", kind="prd",
                                     status="approved", visibility="company"))  # fmt: skip
            prds.append((doc, await add(DocumentVersion(document_id=doc.id, number=1,
                                                         **body(doc.slug)))))  # fmt: skip
        roadmaps = []
        item_ids: list[uuid.UUID] = []
        for r in range(5):
            rm = await add(Document(slug=f"roadmap-{r}", title=f"Roadmap {r}", kind="roadmap",
                                    status="approved", visibility="company"))  # fmt: skip
            rv = await add(DocumentVersion(document_id=rm.id, number=1, **body(rm.slug)))
            # Roadmaps 0-2 decided by the approver, 3 by another member, 4 by none (owners).
            decider = approver if r < 3 else (members[5] if r == 3 else None)
            if decider is not None:
                await add(DocumentReviewPolicy(document_id=rm.id, decider_id=decider,
                                               mandatory_reviewer_ids=[members[6]]))  # fmt: skip
            pd, pv = prds[r * 5]
            track = await add(ProductTrack(
                prd_document_id=pd.id, started_version_id=pv.id, current_version_id=pv.id,
                roadmap_document_id=rm.id, title=f"Track {r}",
                owner_id=approver if r % 2 else members[7]))  # fmt: skip
            roadmaps.append((rm, rv, track))
            for i in range(80):
                pd, pv = prds[r * 5 + i // 16]
                kw: dict[str, Any] = {"horizon": ("now", "next", "later")[i % 3]}
                if i % 16:
                    kw["depends_on"] = [f"item-{i - 1}"]
                if i % 5 != 4:
                    # Each dated item overlaps the one before: a red, fixable link.
                    kw.update(start_date=date(2026, 10, 1) + timedelta(days=3 * i),
                              end_date=date(2026, 10, 20) + timedelta(days=3 * i),
                              date_source="typed")  # fmt: skip
                row = await add(RoadmapItem(
                    roadmap_document_id=rm.id, roadmap_version_id=rv.id, item_key=f"item-{i}",
                    title=f"Item {r}-{i}", prd_document_id=pd.id, prd_version_id=pv.id,
                    position=i, track_id=track.id, feature_id=features[r * 80 + i],
                    confidence=("low", "medium", "high")[i % 3], **kw))  # fmt: skip
                item_ids.append(row.id)

        # 60 meetings, each in its own meeting session.
        sessions = []
        for m in range(60):
            ss = await add(SimpleSession(kind="meeting", started_by=members[m % 30],
                                         started_at=AT - timedelta(days=m)))  # fmt: skip
            sessions.append(ss.id)
            await add(SimpleMeeting(
                title=f"Review {m}", prd_document_id=prds[m % 25][0].id, origin="one_pager",
                session_id=ss.id, presenter_id=members[m % 30], attendee_ids=members[:5],
                status="ended", started_at=AT - timedelta(days=m)))  # fmt: skip

        # 150 drafts: one working draft per roadmap, the rest submitted or approved.
        for d in range(150):
            rm, rv, _ = roadmaps[d % 5]
            status = "working" if d < 5 else ("submitted" if d % 3 else "approved")
            await add(SimpleDraft(
                document_id=rm.id, base_version_id=rv.id, status=status,
                created_by=members[d % 30], participant_ids=[members[(d + 1) % 30]],
                waiting_on=[approver, members[6]] if status == "submitted" and d % 2 else [],
                overlay={}))  # fmt: skip

        # 1,500 changes, 300 proposed (routed to the roadmap's decider).
        changes = []
        for c in range(1500):
            n = c % 400
            rm = roadmaps[n // 80][0]
            proposed = c % 5 == 0
            changes.append({
                "id": uuid.uuid4(), "tenant_id": ctx.tenant_id,
                "session_id": sessions[c % 60] if c % 4 == 0 else None,
                "document_id": rm.id,
                "op": ("move_dates", "change_horizon", "edit_title")[c % 3],
                "target": {"item_id": str(item_ids[n])},
                "before": {"title": f"Item {n}"} if c % 3 == 2 else {"horizon": "now"},
                "after": {"title": f"Item {n} v2"} if c % 3 == 2 else {"horizon": "next"},
                "status": "proposed" if proposed else ("applied", "accepted", "declined")[c % 3],
                "by": members[c % 30],
                "at": AT - timedelta(minutes=c),
                "routed_to": [approver] if proposed and n < 240 else [owner],
            })  # fmt: skip
            if c % 3 == 0:
                changes[-1]["before"] = {"start_date": "2026-10-01", "end_date": "2026-10-20"}
                changes[-1]["after"] = {"start_date": "2026-10-05", "end_date": "2026-10-24"}
        await s.execute(insert(SimpleChange), changes)

        # 200 decisions: the approver's calls, other people's, decided ones.
        for d in range(200):
            await add(Decision(
                number=d + 1, title=f"Example call {d}", question=f"Which way {d}?",
                status="proposed" if d % 2 else "decided",
                approver_id=approver if d % 4 == 1 else members[d % 30],
                driver="owner@example.com",
                origin=("manual", "meeting", "oracle", "pricing")[d % 4],
                created_at=AT - timedelta(hours=d),
                **({} if d % 2 else {"chosen_option": "a", "rationale": "Example", "decided_at": AT,
                                     "review_at": date(2027, 1, 4)})))  # fmt: skip

        # Goal suggestions, open and decided.
        for g in range(40):
            await add(SimpleGoalSuggestion(
                goal_id=goals[g % 4].id, title=f"Suggested feature {g}", outcome="Faster setup",
                why="Example reason", evidence=[], origin="auto",
                status="open" if g % 3 else "rejected"))  # fmt: skip

        # Run stops for approvers.
        for _ in range(5):
            run = await add(Run(flow="baseline_to_prd", status="awaiting_checkpoint",
                                created_by=owner))  # fmt: skip
            s.add(RunSegment(run_id=run.id, seq=1, name="baseline", status="succeeded"))
            s.add(Checkpoint(run_id=run.id, kind="baseline_confirm", status="pending",
                             approver_role="approver", payload={"segment_seq": 1}))  # fmt: skip
        await s.commit()
        await suggestions.regenerate(s)
        await s.commit()
    return out
