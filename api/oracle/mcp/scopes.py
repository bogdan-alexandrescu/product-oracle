"""Which run-token scope an operation needs (``None``: refused for scoped callers).

Paths are the OpenAPI templates (``/v1/documents/{doc}/versions``); the first literal
segment after ``/v1`` names the area.
"""

READ_AREAS = {
    "read:sources": {"sources", "search", "snapshots"},
    # Intakes, the gap registry and the question ledger (oracle.intake) are baseline
    # knowledge; reading source text through an intake still needs read:sources.
    "read:baseline": {
        "baseline",
        "priorities",
        "intakes",
        "gaps",
        "questions",
        "answers",
        "assumption-decisions",
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
}
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
    # POST /v1/documents/{doc}/versions: import a draft version.
    if len(parts) == 3 and parts[0] == "documents" and parts[2] == "versions":
        return "write:drafts"
    return None


def allowed(scopes: frozenset[str] | None, method: str, path: str) -> bool:
    if scopes is None:
        return True
    needed = required_scope(method, path)
    return needed is not None and needed in scopes
