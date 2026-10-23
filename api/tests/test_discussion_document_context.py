"""G2 Live replies on a document (#406): a discussion on a document version reads that
version's text, the section it is on first, under the same reader rule (S6, AUD-9); and the
stream sends a citation as soon as its marker is complete.

Each test's card: protects=<the observable>; fails_when=<the wrong result>;
no_claim=<what green does not prove>. Synthetic placeholders only.
"""

from sqlalchemy import event

from oracle.db import get_engine
from oracle.discussions import context
from tests.test_discussion_replies import ASK, fake, read_stream, say, with_key  # noqa: F401
from tests.test_discussions import company, section, start

PROBLEM = "Too many shoppers leave checkout before paying"
PAYMENT = "Show saved cards first and offer wallet payments"
LAST = "Do we need guest checkout in the first release?"
# A citation's excerpt is drawn from a person's source: never read here (AUD-9).
EXCERPT = "I did not know what shipping would cost"


async def ask(client, fake, subject_kind: str, subject: dict) -> tuple[str, list]:  # noqa: F811
    ctx, doc = await company(client)
    await with_key(ctx)
    statements: list[str] = []

    def spy(conn, cursor, statement, *args):
        statements.append(statement)

    engine = get_engine().sync_engine
    event.listen(engine, "before_cursor_execute", spy)
    try:
        d = await start(client, ctx, subject_kind=subject_kind, subject=subject(doc))
        reply = (await say(client, ctx, d["id"], "commenter", ASK))["reply"]
        events = await read_stream(client, ctx, d["id"], reply["id"])
    finally:
        event.remove(engine, "before_cursor_execute", spy)
    assert statements and not any("source_items" in s for s in statements)
    return fake.requests[0].messages[0]["content"], events


# protects=#406 Done when 1: a section discussion reads its section first, then the rest of
# the version, and no citation excerpt or source item; fails_when=Oracle reads only the
# section (the horizon on another line goes unseen) or a person's source enters;
# no_claim=what the model writes.
async def test_a_section_discussion_reads_the_version_section_first(client, fake):  # noqa: F811
    prompt, events = await ask(client, fake, "section", section)
    assert PROBLEM in prompt and PAYMENT in prompt and LAST in prompt
    assert prompt.index(PROBLEM) < prompt.index("Owner: product. Status: draft for review.")
    assert prompt.index(PROBLEM) < prompt.index(PAYMENT) < prompt.index(LAST)
    assert EXCERPT not in prompt
    assert "[c:c" not in prompt  # the document's own markers would read as Oracle's
    done = dict(events)["done"]
    assert done["citations"][0]["kind"] == "section"
    assert done["citations"][0]["title"] == "2. Problem"


# protects=#406 Done when 1: a discussion on the whole document reads every section of the
# version even when it has no brief layer; fails_when=it reads nothing of the document;
# no_claim=the budget's exact cut.
async def test_a_document_discussion_reads_the_whole_version(client, fake):  # noqa: F811
    prompt, _ = await ask(client, fake, "document", lambda doc: {"document_id": doc, "version": 1})
    assert PROBLEM in prompt and PAYMENT in prompt and LAST in prompt
    assert EXCERPT not in prompt


# protects=#406 Build: the document stays within its share of the context, so the
# conversation still fits; fails_when=a long document crowds out the conversation;
# no_claim=the order of the sections (above).
def test_the_document_has_its_own_budget():
    ctx = context.Context()
    sections = [(f"s{i}", f"Section {i}", "x" * 5000) for i in range(30)]
    context.add_sections(ctx, "doc", sections)
    assert ctx.size <= context.MAX_DOCUMENT_CHARS
    assert 0 < len(ctx.entries) < len(sections)  # the first sections, not all of them


# protects=#406 Build: a citation reaches the reader as soon as its marker is complete, not
# only when the reply ends; fails_when=the stream sends citations only after the last
# piece; no_claim=the chip (Playwright).
async def test_the_stream_sends_a_citation_when_its_marker_completes(client, fake):  # noqa: F811
    _, events = await ask(client, fake, "section", section)
    names = [name for name, _ in events]
    deltas = [i for i, name in enumerate(names) if name == "delta"]
    first_cite = names.index("citations")
    assert first_cite < deltas[-1], names
    assert events[first_cite][1][0]["n"] == 1
