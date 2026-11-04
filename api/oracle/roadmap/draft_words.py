"""roadmap-draft-wording: the date words a run's roadmap draft may not use.

- **A queue said to be an estimate** (``queue_said_as_estimate``): the text says an end
  date comes from the item's own (engineering) estimate. A roadmap's end dates place
  each item in the team's queue (team size, focus, milestone order), so a 1-week item may
  end months out; the text says so and gives the item's own effort.
- **A date the writer calls unverified** (``unverified_written``): "date unverified",
  "unverified date", "[unverified]". Oracle marks the dates no verified basis backs
  (oracle.roadmap.doc_dates); a date from an accepted engineering estimate is verified, and
  the writer never marks one itself.

A run's draft that breaks either rule is imported with a warning per rule and sent back
to the writer (oracle.docs.draft_checks), like a code without its name. The Sources and
data points sections are not read.

Every pattern reads untrusted text and stays linear (see oracle.jobs.prompting).
"""

import re
from collections.abc import Iterable

from oracle.docs.parser import ParsedSection
from oracle.docs.schemas import VersionWarning

# "Each end date comes from that item's own engineering estimate": a date, then within
# the same sentence the item's own estimate.
_QUEUE_AS_ESTIMATE = re.compile(
    r"\bdates?\b[^.!?]{0,160}?\bown\s+(?:engineering\s+)?estimates?\b", re.I
)
_UNVERIFIED = re.compile(
    r"\bdates?\s+unverified\b|\bunverified\s+dates?\b|[\[(]\s*unverified\s*[\])]", re.I
)
CODES = ("queue_said_as_estimate", "unverified_written")


def _plain(heading: str) -> str:
    return re.sub(r"\s*\{#[^}]*\}\s*$", "", heading).strip()


def check(sections: Iterable[ParsedSection]) -> list[VersionWarning]:
    """Warnings for a run's roadmap draft, one per rule, naming the sections."""
    queue: dict[str, str] = {}
    unverified: dict[str, str] = {}
    for s in sections:
        if s.section_key.startswith("sources"):
            continue
        where = _plain(s.heading) or s.section_key
        text = f"{s.heading}\n{s.body_md}"
        if _QUEUE_AS_ESTIMATE.search(text):
            queue[s.section_key] = where
        if _UNVERIFIED.search(text):
            unverified[s.section_key] = where
    out: list[VersionWarning] = []
    if queue:
        out.append(
            VersionWarning(
                code="queue_said_as_estimate",
                message="These sections say an end date comes from the item's own estimate: "
                + ", ".join(queue.values())
                + ". An end date is the item's place in the team's queue (team size, focus "
                "and milestone order), not how long the item takes: say so, and give the "
                "item's own effort next to it ('ends Feb 12: its place in the team's queue; "
                "its own effort is 1 week').",
                section_keys=list(queue),
            )
        )
    if unverified:
        out.append(
            VersionWarning(
                code="unverified_written",
                message="These sections call a date unverified: "
                + ", ".join(unverified.values())
                + ". A date from an accepted engineering estimate is verified; write it "
                "plainly in its item's own row or section. Oracle marks the dates nothing "
                "backs; never write 'date unverified' yourself.",
                section_keys=list(unverified),
            )
        )
    return out
