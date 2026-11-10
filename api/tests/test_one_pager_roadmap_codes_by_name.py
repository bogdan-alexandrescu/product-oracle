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


def test_a_roadmap_goal_milestone_named_by_its_text_reads_its_roadmap_code():
    """protects=a roadmap's own milestone named by an item's text reads its code; a goal's
    target date (goal_target) never does; fails_when=it reads no code, or the target's."""
    import uuid
    from types import SimpleNamespace as NS

    from oracle.simple.one_pager import roadmap_codes_of

    gm = dict(prd=None, code="", roadmap_code="M5", goal_target=False)
    target = dict(gm, roadmap_code="M2", goal_target=True)
    read = NS(
        goal_milestones=[
            NS(id=uuid.uuid4(), name="Grow usage", **target),
            NS(id=uuid.uuid4(), name="Beta launch", **gm),
        ],
        milestones=[],
    )
    of = roadmap_codes_of(read, uuid.uuid4())
    assert of("Beta launch") == "M5"
    assert of("Grow usage") is None
