"""Which run-token scope an operation needs (``None``: refused for scoped callers).

Paths are the OpenAPI templates (``/v1/documents/{doc}/versions``); the first literal
segment after ``/v1`` names the area.
"""

READ_AREAS = {
    # Requester notes quote what people asked: source text (H6).
    # Code capability maps are drawn from a person's source (S6): a run reads shared
    # ones only (oracle.engineering.codemaps.visible).
    "read:sources": {"sources", "search", "snapshots", "requester-notes", "code-maps"},
    # Intakes, the gap registry and the question ledger (oracle.intake) are baseline
    # knowledge; reading source text through an intake still needs read:sources.
    # Blockers are baseline constraints (CR-04): their strategy, options, experiments
    # and events read like the rest of the baseline.
    "read:baseline": {
        "baseline",
        "priorities",
        "intakes",
        "gaps",
        "questions",
        "answers",
        "assumption-decisions",
        "blockers",
        "blocker-options",
        "feasibility-experiments",
        "blocker-events",
        # Requests and their themes (C1): a triage run lists them. Not
        # request-candidates: those are a person's private findings (S6).
        "requests",
        "request-themes",
        # H1: the company's decisions (judgement calls and the run stops' records).
        "decisions",
        # H4: the approved vision and strategy, and the drift findings against them.
        "strategy",
        # Outcomes tracked against goals (a strategy draft reads them), and the learnings
        # kept from them (H3: the prioritizer and writer read the track record).
        "outcomes",
        "learnings",
        # Launches, their checklist and the changelog (H6): reading only; run tokens
        # never publish, mark sent or mark launched.
        "launches",
        "launch-tasks",
        "changelog",
        # H11: how far Oracle may go per responsibility (get_autonomy).
        "autonomy",
        # H8: product tracks, their milestones and the roadmaps they follow (an update
        # draft reads what shipped, what slipped and which dates are verified).
        "tracks",
        "milestones",
        "roadmaps",
    },
    "read:documents": {"documents", "feedback", "exports"},
}
# GET /v1/<area>/{id}/<leaf> that can return source titles, links or excerpts: they
# need read:sources (an intake's summary and question batch carry evidence refs).
SOURCE_READS = {
    ("intakes", "evidence"),
    ("intakes", "new-evidence"),
    ("intakes", "summary"),
    ("intakes", "question-batch"),
    # C5: the next batch's preview (the same cards as a question batch).
    ("intakes", "next-batch"),
    # A launch's requester notes: what people asked, in their words.
    ("launches", "notes"),
}
# Reads for people's clients only, refused to run tokens like the runs reads: whether a
# new PRD run may reuse the baseline (C4) is about runs, not baseline knowledge.
PEOPLE_READS = {("baseline", "review-status")}
# Creating a proposal or a piece of evidence; deciding one stays with people.
PROPOSAL_WRITES = {"proposals", "evidence"}


def _segments(path: str) -> list[str]:
    parts = [p for p in path.split("/") if p]
    if parts and parts[0] == "v1":
        parts = parts[1:]
    return parts


def required_scope(method: str, path: str) -> str | None:
    method = method.upper()
    parts = _segments(path)
    if not parts:
        return None
    area = parts[0]
    if method == "GET":
        if tuple(parts) in PEOPLE_READS:
            return None
        if (area, parts[-1]) in SOURCE_READS and len(parts) == 3:
            return "read:sources"
        for scope, areas in READ_AREAS.items():
            if area in areas:
                return scope
        return None
    if method != "POST":
        return None
    if area == "baseline" and parts[-1] in PROPOSAL_WRITES:
        return "write:proposals"
    # POST /v1/decisions: propose a decision (as Oracle). Deciding, reviewing,
    # reassigning and withdrawing stay with people.
    if parts == ["decisions"]:
        return "write:proposals"
    # POST /v1/documents/{doc}/versions: import a draft version.
    if len(parts) == 3 and parts[0] == "documents" and parts[2] == "versions":
        return "write:drafts"
    return None


def allowed(scopes: frozenset[str] | None, method: str, path: str) -> bool:
    if scopes is None:
        return True
    needed = required_scope(method, path)
    return needed is not None and needed in scopes
