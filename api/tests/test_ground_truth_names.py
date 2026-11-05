"""Owner's decision (Nov 4): Oracle's cited graph is the Ground Truth in every word a person
sees. Flow, step and checkpoint names, decision rows, ritual names, autonomy text and the
page names say Ground Truth; "baseline" stays only in internal values (flow, kind, keys).
"""

import re

from oracle import autonomy
from oracle.decisions.capture import STOP_LABELS
from oracle.discussions.context import PAGES
from oracle.rituals.kinds import KINDS
from oracle.rituals.rebuild import TITLES
from oracle.runs import flows, reasons
from oracle.runs.service import CHECKPOINT_TITLES, decision_summary
from oracle.simple.meetings import _STOP_WORDS

BASELINE = re.compile(r"baseline", re.I)


def _says_ground_truth(text: str) -> None:
    assert "Ground Truth" in text, text
    assert not BASELINE.search(text), text


def test_checkpoint_names_say_ground_truth():
    for names in (CHECKPOINT_TITLES, STOP_LABELS, _STOP_WORDS):
        _says_ground_truth(names["baseline_confirm"])
        for value in names.values():
            assert not BASELINE.search(value), value


def test_flow_and_step_names_say_ground_truth():
    _says_ground_truth(flows.FLOWS["baseline_to_prd"].title)
    _says_ground_truth(flows.FLOWS["baseline"].title)
    _says_ground_truth(flows.BASELINE_SEGMENT.title)
    for flow in flows.FLOWS.values():
        assert not BASELINE.search(flow.title), flow.title
        assert not BASELINE.search(flow.description or ""), flow.description
        for seg in flow.segments:
            assert not BASELINE.search(seg.title), seg.title


def test_flow_start_link_is_the_ground_truth_page():
    label, href = flows.FLOWS["baseline"].starts_from
    _says_ground_truth(label)
    assert href.startswith("/ground-truth")


def test_decision_line_names_the_ground_truth():
    line = decision_summary("baseline_confirm", "approved", "approver", "web", None, True)
    assert line.startswith("Ground Truth · approved")
    assert not BASELINE.search(line)


def test_ritual_and_autonomy_names_say_ground_truth():
    _says_ground_truth(KINDS["baseline_rebuild"].title)
    _says_ground_truth(TITLES["baseline_rebuild"])
    area = next(r for r in autonomy._ALL if r.key == "baseline")
    _says_ground_truth(area.title)
    _says_ground_truth(area.levels["observe"])


def test_page_names_say_ground_truth():
    assert PAGES["ground-truth"] == "Ground Truth"
    assert PAGES["baseline"] == "Ground Truth"  # an old /baseline link's screen


def test_a_serves_no_goal_reason_names_a_ground_truth_feature():
    """A roadmap item Oracle could not trace reads "a Ground Truth feature", in the review
    catalogue and in the reason a run's review shows; fails_when=either says "baseline"."""
    text = reasons.CATALOGUE["serves_no_goal"].sentence
    assert "a Ground Truth feature" in text and not BASELINE.search(text), text
    said = reasons.SERVES_NO_GOAL_UNTRACED
    assert said == "Oracle could not trace it to a Ground Truth feature, so no goal is known."
