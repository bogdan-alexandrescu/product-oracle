"""Which run-token scope an operation needs (``None``: refused for scoped callers).

Paths are the OpenAPI templates (``/v1/documents/{doc}/versions``); the first literal
segment after ``/v1`` names the area.
"""

READ_AREAS = {
    # Requester notes quote what people asked: source text (H6).
    # Code capability maps are drawn from a person's source (S6): a run reads shared
    # ones only (oracle.engineering.codemaps.visible).
    # Request replies quote askers' words, the same rule as requester notes (H10).
    # H9: interviews hold customer words, source text.
    # A source item (/v1/source-items/{id}) is source text itself: a run reads it as
    # the route allows (S6: shared items at the version released only).
    "read:sources": {
        "sources",
        "source-items",
        "search",
        "snapshots",
        "requester-notes",
        "code-maps",
        "request-replies",
        "interviews",
    },
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
        # H2: rituals and their pre-reads (a summary or update draft run reads them).
        "rituals",
        "ritual-occurrences",
        # H5: the weekly metrics and their variances (reading only: an agent never
        # writes a weekly value).
        "metrics",
        "metric-variances",
        # H9: win and loss records and the pricing memos with their decision (owners and
        # approvers only; a run reads them when its creator may).
        "deal-outcomes",
        "pricing-memos",
        # H7: the alternatives, their change log, the open web's findings (public pages,
        # read with no credential) and the positioning inputs. Run tokens never write them.
        "competitors",
        "competitor-changes",
        "competitor-web-findings",
        "positioning",
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
    # H10: a request's why-not replies quote what people asked.
    ("requests", "replies"),
}
# GET routes whose area's scope is not enough: they also show source-item titles and
# links. The evidence inspector (owner, 2026-10-25): read:documents and read:sources.
ALSO_NEEDS = {("documents", "evidence"): "read:sources"}
# Reads for people's clients only, refused to run tokens like the runs reads: whether a
# new PRD run may reuse the baseline (C4) is about runs, not baseline knowledge.
# Likewise the goals an interview is offered on (B6): it names people's discussions.
PEOPLE_READS = {("baseline", "review-status"), ("baseline", "goals", "vague")}
# H7: Oracle's web tools (POST /v1/web/search, /v1/web/fetch) are for run tokens holding
# read:web only (the competitive digest's): people's MCP clients are not offered them.
RUN_ONLY_AREAS = {"web": "read:web"}
# INT2: GET /v1/intakes/{id}/analysis-input, the job's payload for that intake's own read
# run only (owner answer Q1): never read:baseline or read:sources.
RUN_ONLY_READS = {("intakes", "analysis-input"): "read:intake-input"}
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
        if len(parts) == 3 and (area, parts[-1]) in RUN_ONLY_READS:
            return RUN_ONLY_READS[(area, parts[-1])]
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
    if area in RUN_ONLY_AREAS:
        return RUN_ONLY_AREAS[area]
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


def also_needed(method: str, path: str) -> str | None:
    """The second scope a GET needs on top of :func:`required_scope`'s, else None."""
    parts = _segments(path)
    if method.upper() != "GET" or not parts:
        return None
    return ALSO_NEEDS.get((parts[0], parts[-1]))


def missing(scopes: frozenset[str], method: str, path: str) -> list[str]:
    """The scopes a run token lacks for this operation (empty: it may run)."""
    needed = [s for s in (required_scope(method, path), also_needed(method, path)) if s]
    return [s for s in needed if s not in scopes]


def allowed(scopes: frozenset[str] | None, method: str, path: str) -> bool:
    if scopes is None:
        parts = _segments(path)
        return not (parts and parts[0] in RUN_ONLY_AREAS)
    return required_scope(method, path) is not None and not missing(scopes, method, path)
