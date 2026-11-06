"""The wording checks on a run's imported draft (never a person's): a PRD's and a
roadmap's codes with their names (#306, oracle.docs.named_codes), a PRD's sources by
their titles and its issues by what they are (oracle.docs.source_words), and a roadmap's date
words (roadmap-draft-wording, oracle.roadmap.draft_words). Each is a version warning;
a run sends a draft with any of them (:data:`SENT_BACK`) back to its writer before a
person reviews it."""

from collections.abc import Sequence

from oracle.docs import named_codes, source_words
from oracle.docs.parser import ParsedSection
from oracle.docs.schemas import VersionWarning
from oracle.roadmap import draft_words

# oracle.intake.draft_check.CODE: a PRD drafted from an intake calls missing what its
# sources or features describe (walk 2, problem 17).
DESCRIBED_CALLED_MISSING = "described_called_missing"
SENT_BACK = (
    *named_codes.CODES,
    *source_words.CODES,
    *draft_words.CODES,
    DESCRIBED_CALLED_MISSING,
)


def run_warnings(
    kind: str, sections: Sequence[ParsedSection], markdown: str | None = None
) -> list[VersionWarning]:
    """The wording warnings of a run's draft of a ``kind`` document (``markdown``: the
    draft the sections were parsed from, for the lines its warnings name)."""
    if kind == "prd":
        # PRD source words: its sources by their titles, its issues by what they are.
        return [*named_codes.check(sections), *source_words.check(sections, markdown)]
    if kind == "roadmap":
        return [*named_codes.check(sections), *draft_words.check(sections)]
    return []
