"""The ``critical_blockers`` readiness check (hard), build prompt §6 and T2.

A critical, hard, unresolved blocker that gates a document is ``critical``, so the
publish transaction refuses the publish, unless its status rests on a recorded decision:
an approved scoped feasibility experiment before its decision gate (with its owner and
success threshold), or a risk an authorized person accepted (who and why are recorded,
with an audit event) before its review date. A strategy that disagrees with its last
recorded snapshot fails closed (``service.assess``). Archived (rejected) or deleted
constraints no longer gate; archiving one that still gates takes the B4 role
(``service.require_archiver``).
Lesser unresolved blockers (hard but not critical, critical but not hard) are a
``warning``. A document with no blockers is ``not_applicable``.
"""

from oracle import readiness
from oracle.blockers import service
from oracle.blockers.render import BRIEF_SECTION_ID, section_id_for
from oracle.readiness import CheckOutcome, ReadinessContext

CHECK_KEY = "critical_blockers"


async def critical_blockers(ctx: ReadinessContext) -> CheckOutcome:
    entities = await service.blockers_for_document(ctx.db, ctx.document_id)
    if not entities:
        return CheckOutcome(
            status="not_applicable", rationale="No blockers are linked to this document."
        )
    inputs = await service.gate_inputs(ctx.db, [e.id for e in entities])
    rows = []
    for entity in entities:
        spec = service.safe_spec(entity)
        rows.append((entity, spec, service.assess(entity, spec, inputs)))
    rows.sort(key=lambda r: service.rank(*r))
    critical = [r for r in rows if r[2].status == "critical"]
    warnings = [r for r in rows if r[2].status == "warning"]
    if critical:
        status, shown = "critical", critical
    elif warnings:
        status, shown = "warning", warnings
    else:
        status, shown = "pass", rows
    owner = next((spec.owner_id for _e, spec, _g in shown if spec and spec.owner_id), None)
    return CheckOutcome(
        status=status,
        rationale=" ".join(g.rationale.rstrip(".") + "." for _e, _s, g in shown),
        evidence_ids=[e.id for e, _s, _g in shown],
        owner_id=owner,
        section_keys=[BRIEF_SECTION_ID, *(section_id_for(e.key) for e, _s, _g in shown)],
    )


readiness.register_check(CHECK_KEY, critical_blockers, hard=True)
