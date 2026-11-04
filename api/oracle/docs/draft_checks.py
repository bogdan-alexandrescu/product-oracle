"""The wording checks on a run's imported draft (never a person's): a PRD's and a
roadmap's codes with their names (#306, oracle.docs.named_codes), and a roadmap's date
words (roadmap-draft-wording, oracle.roadmap.draft_words). Each is a version warning;
a run sends a draft with any of them (:data:`SENT_BACK`) back to its writer before a
person reviews it."""

from collections.abc import Sequence

from oracle.docs import named_codes
from oracle.docs.parser import ParsedSection
from oracle.docs.schemas import VersionWarning
from oracle.roadmap import draft_words

SENT_BACK = (*named_codes.CODES, *draft_words.CODES)


def run_warnings(kind: str, sections: Sequence[ParsedSection]) -> list[VersionWarning]:
    """The wording warnings of a run's draft of a ``kind`` document."""
    if kind == "prd":
        return named_codes.check(sections)
    if kind == "roadmap":
        return [*named_codes.check(sections), *draft_words.check(sections)]
    return []
