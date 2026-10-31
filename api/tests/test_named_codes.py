"""#306 Named codes, part 3: agents name the codes they write.

The drafting prompts (PRD sections, proposals, checkpoint notes) say: a code is named on
first use, three or more codes are a list, a milestone section's title carries its dates,
and no code is invented. A run's PRD draft that breaks the first two rules is imported with
a warning (never refused).
"""

from oracle.docs import named_codes
from oracle.docs.parser import parse_draft
from oracle.jobs import prompting
from oracle.runs import flows, workflow
from oracle.tenancy import tenant_session
from tests.review_v2_helpers import DOC, DRAFT, person, replace, setup

RULES = (
    "F-28 Retire the legacy deploy path",
    "three or more codes",
    "one per line",
    "M1 · Oct 19 – Nov 13",
    "Never invent a code",
)


# --- Prompt render -------------------------------------------------------------------


def test_job_prompts_that_write_text_are_new_versions_with_the_rules():
    # refinement_batch.v2 is main's discussion-instructions version; the rules go in v3.
    versions = {"refinement": "v2", "refinement_batch": "v3", "review_comments": "v2"}
    for kind, version in versions.items():
        name, text = prompting.current(kind)
        assert name == f"{kind}.{version}"
        for rule in RULES:
            assert rule in text, (kind, rule)
    # Earlier versions stay as they were: a job records the prompt it ran with.
    for kind in ("refinement", "refinement_batch", "review_comments"):
        assert "F-28" not in prompting.load(f"{kind}.v1")
    assert "F-28" not in prompting.load("refinement_batch.v2")


def _prompt(flow_key: str, segment: str, role: str, *, last: bool = True) -> str:
    flow = flows.FLOWS[flow_key]
    ctx = flows.PromptContext(
        run_id="run-1", document="team-calendar", snapshot_as_of=None, low_confidence=0.4
    )
    return flows.step_prompt(flow, flow.segment(segment), role, last=last, ctx=ctx)


def test_drafting_and_note_prompts_carry_the_named_code_rules():
    flow = flows.FLOWS["baseline_to_prd"]
    for seg in flow.segments:
        for i, role in enumerate(seg.roles):
            text = _prompt(flow.key, seg.name, role, last=i == len(seg.roles) - 1)
            for rule in RULES:
                assert rule in text, (seg.name, role, rule)
    text = _prompt("feedback_loop", "next_draft", "writer")
    assert flows.NAMED_CODES in text


def test_the_roadmap_prompts_do_not_carry_the_named_code_rules():
    """Only the prompts that write PRD sections, proposals and checkpoint notes carry the
    rules; the roadmap draft's prompt is pinned byte for byte (test_runs_prd_template)."""
    flow = flows.FLOWS["prd_to_roadmap"]
    ctx = flows.PromptContext(
        run_id="run-1",
        document="team-calendar-roadmap",
        snapshot_as_of=None,
        low_confidence=0.4,
        kind="roadmap",
    )
    for seg in flow.segments:
        for role in seg.roles:
            text = flows.step_prompt(flow, seg, role, last=True, ctx=ctx)
            assert flows.NAMED_CODES not in text, (seg.name, role)


# --- Output checks -------------------------------------------------------------------


def test_named_first_use_and_lists_pass():
    body = (
        "F-28 Retire the legacy deploy path comes first. F-28 frees the old hosts.\n\n"
        "The failed delivery flow (F-34) takes the rest.\n\n"
        "Ships:\n- F-31 Route planner\n- F-32 Live arrival times\n- F-33 Proof of delivery\n\n"
        "Text is UTF-8 and hashed with SHA-256."
    )
    assert named_codes.findings(body) == named_codes.Findings(unnamed=[], runs=[])


def test_a_bare_first_use_and_a_run_of_codes_are_found():
    body = "This needs F-28 first.\n\nThen F-31, F-32 and F-33 ship together."
    found = named_codes.findings(body)
    assert found.unnamed == ["F-28"]
    assert found.runs == [["F-31", "F-32", "F-33"]]
    # Two codes are not a list yet; a later bare mention of a named code is fine.
    two = named_codes.findings("F-1 Sign-up form and F-2 Invite flow; then F-1, F-2 again.")
    assert two == named_codes.Findings(unnamed=[], runs=[])


def test_undashed_goal_requirement_and_milestone_codes_are_checked():
    body = "This serves G1 first and needs R1.\n\nG2, R2 and M2 land together."
    found = named_codes.findings(body)
    assert found.unnamed == ["G1", "R1"]
    assert found.runs == [["G2", "R2", "M2"]]
    named = named_codes.findings(
        "G1 Fewer missed deadlines leads. The shared calendar (R1) serves G1.\n\n"
        "M1 · Oct 19 – Nov 13 ships it."
    )
    assert named == named_codes.Findings(unnamed=[], runs=[])
    # A milestone heading with its dates names the code for its section.
    assert named_codes.findings("M1 ships the calendar.", "M1 · Oct 19 – Nov 13").unnamed == []
    # Quarters, halves, versions and standards are not codes.
    plain = named_codes.findings("Ships in Q3, H2 or v2; uses SHA256, MD5 and UTF8.")
    assert plain == named_codes.Findings(unnamed=[], runs=[])


# A milestone whose name reads like prose: commas and numbers (invented example data).
MILESTONE = "200 teams and 50 seats, and onboarding at scale"


def test_a_name_in_brackets_after_its_code_names_it():
    """e2e-draft-codes: "M3 (<name>)" names M3 even when the name starts with a number or
    holds commas; a name spliced bare after the code ("at M3 200 teams ...") does not."""
    named = named_codes.findings(
        f"G-B Faster first week is not expected to move at M3 ({MILESTONE}), and ships later."
    )
    assert named == named_codes.Findings(unnamed=[], runs=[])
    first = named_codes.findings(f"Onboarding at scale (M3) waits. M3: {MILESTONE} is next.")
    assert first.unnamed == []
    spliced = named_codes.findings(
        f"G-B Faster first week is not expected to move at M3 {MILESTONE}."
    )
    assert spliced.unnamed == ["M3"]


def test_a_bracket_or_colon_names_a_code_only_when_it_holds_a_name():
    """e2e-draft-codes review: a reference, a number or another code after the code is no
    name; a word or a number then words is."""
    for body in (
        "F-28 (see below) ships first.",
        "G1 (40%) is the target.",
        "R1 (M3) waits.",
        "G1: 40% is the target.",
    ):
        assert named_codes.findings(body).unnamed[:1] in (["F-28"], ["G1"], ["R1"]), body
    for body in (
        "F-28 (Retire the legacy deploy path) ships first.",
        "G1 (activation) comes first.",
        f"M3 ({MILESTONE}) is next.",
        f"M3: {MILESTONE} is next.",
    ):
        assert named_codes.findings(body).unnamed == [], body


def test_a_run_of_codes_alone_is_sent_back_as_a_run_not_as_unnamed_codes():
    """e2e-draft-codes review: the lead line says which rule the draft breaks."""
    md = replace(DRAFT, "Teams miss shared deadlines.", "Teams miss deadlines: G-4, G-5, G-6.")
    warnings = named_codes.check(parse_draft(md).sections)
    assert [w.code for w in warnings] == ["codes_not_listed"]
    [lead, line] = workflow.code_name_findings(
        "prd.md", [w.message for w in warnings], [w.code for w in warnings]
    )
    assert "without their names" not in lead
    assert "in a row instead of a list" in lead and "prd.md" in lead
    [lead, *_] = workflow.code_name_findings("prd.md", ["x"], ["unnamed_code"])
    assert "without their names" in lead and "in a row" not in lead
    [lead, *_] = workflow.code_name_findings(
        "prd.md", ["x", "y"], ["unnamed_code", "codes_not_listed"]
    )
    assert "without their names" in lead and "in a row instead of a list" in lead


def test_the_prompt_puts_a_prose_name_in_brackets():
    """The writer is told to bracket a name that reads like a sentence, never to splice it
    after the code mid-sentence."""
    assert "M3 (" in flows.NAMED_CODES
    assert "brackets" in flows.NAMED_CODES
    text = _prompt("baseline_to_prd", "prd_draft", "critic")
    assert flows.NAMED_CODES in text


def test_the_warning_says_plainly_which_codes_lack_names():
    md = replace(DRAFT, "Calendar sync may lag.", f"Calendar sync may lag until M3 {MILESTONE}.")
    [warning] = named_codes.check(parse_draft(md).sections)
    assert warning.code == "unnamed_code"
    # The section by its heading, the code, and how to write it, in plain words.
    assert "M3" in warning.message
    assert "Risks: M3" in warning.message
    assert "M3 (its name)" in warning.message


FIXTURE = replace(
    replace(DRAFT, "Teams miss shared deadlines.", "Teams miss deadlines: G-4, G-5, G-6."),
    "Calendar sync may lag.",
    "Calendar sync may lag until F-12 ships.",
)


def test_check_flags_sections_by_rule():
    draft = parse_draft(FIXTURE)
    warnings = named_codes.check(draft.sections)
    assert [(w.code, w.section_keys) for w in warnings] == [
        ("unnamed_code", ["risks"]),
        ("codes_not_listed", ["problem"]),
    ]
    assert "F-12" in warnings[0].message
    assert "G-4, G-5, G-6" in warnings[1].message


async def test_a_run_draft_with_bare_codes_imports_with_warnings(client):
    from oracle.auth.deps import Principal
    from oracle.docs import service as docs_service

    ctx = await setup(client)
    async with tenant_session(ctx.tenant_id) as s:
        owner = await person(ctx.tenant_id, "owner")
        principal = Principal(
            tenant_id=ctx.tenant_id, kind="user", role="owner", user_id=owner.user_id
        )
        result = await docs_service.import_draft(
            s, DOC, FIXTURE, principal, cause="run_draft", origin="run"
        )
    # A warning in the run's report, not a hard failure: the version exists.
    assert result.created
    assert [w.code for w in result.version.warnings] == ["unnamed_code", "codes_not_listed"]


async def test_a_persons_import_is_not_checked(client):
    ctx = await setup(client)
    from tests.review_v2_helpers import import_md

    resp = await import_md(client, ctx.auth, FIXTURE, base=1)
    assert resp.status_code == 201, resp.text
    assert resp.json()["warnings"] == []
