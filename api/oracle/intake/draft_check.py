"""A PRD drafted from an intake never calls missing what the intake's read describes
(walk 2, problem 17).

The run's task and its critic are told to read every pinned source and the baseline
features the brief names before calling anything not described. This is the structured
check behind them: on the import of a run's PRD draft, each sentence that says something
is not described or missing (:func:`oracle.intake.job.described`) is checked against the
same read the intake's analysis gets (:func:`oracle.intake.job.payload`): the features
with a description or evidence, and the headings of the source sections it holds. A hit
is a version warning (:data:`CODE`), which a run sends back to its writer before a person
reviews the draft (oracle.docs.draft_checks.SENT_BACK).
"""

import re
import uuid
from collections.abc import Sequence

from sqlalchemy.ext.asyncio import AsyncSession

from oracle.docs import draft_checks
from oracle.docs.parser import ParsedSection
from oracle.docs.schemas import VersionWarning
from oracle.intake import extract, job
from oracle.intake.drafting import _intake_id
from oracle.runs.models import Run
from oracle.v2.models import ProductIntake

CODE = draft_checks.DESCRIBED_CALLED_MISSING
# Sentences quoted in the warning, and each one's length.
MAX_QUOTED = 5
MAX_SENTENCE = 200


def _plain(heading: str) -> str:
    return re.sub(r"\s*\{#[^}]*\}\s*$", "", heading).strip()


async def check(
    db: AsyncSession, run_id: uuid.UUID, sections: Sequence[ParsedSection]
) -> list[VersionWarning]:
    """The warning for a PRD draft of run ``run_id`` that calls described things missing;
    nothing for a run that starts from no intake."""
    run = await db.get(Run, run_id)
    intake_id = _intake_id(run) if run is not None else None
    intake = await db.get(ProductIntake, intake_id) if intake_id else None
    if intake is None:
        return []
    body, _, _ = await job.payload(db, intake)
    read = body["untrusted_data"]
    features = read.get("features") or []
    headings = [h for src in read.get("sources") or [] for h in src.get("sections") or []]
    if not features and not headings:
        return []
    hits: dict[str, list[str]] = {}
    names: dict[str, str] = {}
    for s in sections:
        # The Sources and data points sections hold references, not claims.
        if s.section_key.startswith("sources"):
            continue
        for sentence in extract._SENTENCE.split(" ".join(s.body_text.split())):
            if job.described(sentence, features, headings):
                hits.setdefault(s.section_key, []).append(sentence)
                names[s.section_key] = _plain(s.heading) or s.section_key
    if not hits:
        return []
    quoted = [
        f"{names[k]}: “{job._text(t)[:MAX_SENTENCE]}”" for k, said in hits.items() for t in said
    ]
    return [
        VersionWarning(
            code=CODE,
            message="These sentences say something is not described or missing, but a "
            "source or a feature the brief names describes it: "
            + "; ".join(quoted[:MAX_QUOTED])
            + ". Read that source or feature and cite it instead.",
            section_keys=list(hits),
        )
    ]
