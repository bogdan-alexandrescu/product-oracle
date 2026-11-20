"""qa3 quality wording: the readiness dashboard's rule notes and check descriptions read as
plain English (qa-docs-55, qa-docs-57)."""

from oracle.quality import criteria, service


def test_qa_docs_55_evidence_is_counted_in_pieces():
    """A count of evidence reads as '1 piece' or 'N pieces', never a bare number."""
    assert criteria.pieces_of_evidence(1) == "1 piece of evidence"
    assert criteria.pieces_of_evidence(2) == "2 pieces of evidence"
    assert criteria.pieces_of_evidence(12) == "12 pieces of evidence"


def test_qa_docs_57_critical_blockers_says_what_it_checks():
    """The critical-blockers check reads as a plain question, not its internal name."""
    title, question = service.check_words("critical_blockers")
    assert title == "Critical blockers"
    assert "registered" not in question
    assert "blocker" in question and question.endswith("?")


def test_qa_docs_57_every_other_lanes_check_reads_as_words():
    """Every other lane's check shows a plain title and question, not its raw key."""
    for key in service.OTHER_CHECKS:
        title, question = service.check_words(key)
        assert "_" not in title and "." not in title
        assert "registered by Oracle" not in question


def test_qa_docs_57_an_unknown_check_never_shows_its_key():
    """An unknown check still gets a readable title, never its raw key shown to people."""
    title, question = service.check_words("billing.card_on_file")
    assert title == "Card on file"
    assert "registered by Oracle" not in question


def test_a_criterion_keeps_its_own_title_and_question():
    """A criterion keeps its own title and question instead of a generic one."""
    info = criteria.BY_KEY["problem_clarity"]
    assert service.check_words("problem_clarity") == (info.title, info.question)
