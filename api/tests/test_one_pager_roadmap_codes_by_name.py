"""PRD one-pager Timeline strip, roadmap-milestone-codes (owner, Nov 10): one_pager.roadmap_codes_of
reads a track milestone named by an item's milestone text. No database; invented data."""


def test_a_track_milestone_named_by_its_text_reads_its_roadmap_code():
    """protects=an item whose milestone text names a roadmap track milestone ("Beta launch",
    undated, no record) reads that milestone's roadmap code, the one Home and the Roadmap show;
    fails_when=the row reads "Beta launch" with no code; no_claim=a PRD's written code (above)."""
    import uuid
    from types import SimpleNamespace as NS

    from oracle.simple.one_pager import roadmap_codes_of

    prd = uuid.uuid4()
    read = NS(
        goal_milestones=[],
        milestones=[NS(id=uuid.uuid4(), name="Beta launch", roadmap_code="M5")],
    )
    of = roadmap_codes_of(read, prd)
    assert of("Beta launch") == "M5"
    assert of("beta  launch") == "M5"
    assert of("Ship to beta") is None
