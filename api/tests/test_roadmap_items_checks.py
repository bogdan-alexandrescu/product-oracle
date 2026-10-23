"""The checks of roadmap_items.yaml kept between calls (PR #385 review, #167 fixes 6).

One cache only (oracle.runs.roadmap._Checks): a roadmap import reuses the check the run's
checkpoint made, and clearing that cache (the conftest fixture does) makes every caller
check afresh. It is bounded by its number of entries, not by the size of their text.
Synthetic placeholders only.
"""

from oracle.runs import roadmap as items_file
from oracle.runs.roadmap import ItemsCheck, _Checks
from oracle.swarm import Outcome
from tests.fixtures import import_draft
from tests.test_roadmap import (  # noqa: F401 - fixtures
    ITEMS,
    PRD,
    ROADMAP,
    ROADMAP_MD,
    approved_prd,
    create,
    get,
    owner,
    runtime,
    start,
    tick,
)


def _check(code: str) -> ItemsCheck:
    out = ItemsCheck()
    out.add(code, code)
    return out


def test_the_checks_kept_are_bounded_by_their_number_not_their_text():
    """protects=the cache keeps at most ``keep`` checks, least recently used dropped first,
    whatever their files weigh; fails_when=it takes a byte bound or drops a check for its
    size; no_claim=the parse itself."""
    checks = _Checks(2)
    big = _Checks.key("x" * (32 * 1024 * 1024), {})
    checks.put(big, _check("big"))
    checks.put(_Checks.key("a", {}), _check("a"))
    assert checks.get(big).problems[0]["code"] == "big"  # kept whatever its size; now recent
    checks.put(_Checks.key("b", {}), _check("b"))
    assert checks.get(_Checks.key("a", {})) is None  # the least recently used went
    assert checks.get(big) is not None and checks.get(_Checks.key("b", {})) is not None
    assert len(checks) == 2
    checks.clear()
    assert len(checks) == 0


async def test_clearing_the_one_cache_makes_an_import_check_the_file_again(
    client,
    owner,  # noqa: F811
    runtime,  # noqa: F811
    monkeypatch,
):
    """protects=roadmap imports keep no check of their own: clearing oracle.runs.roadmap's
    cache (as the conftest fixture does between tests) means the next import parses the
    file again; fails_when=a second cache in oracle.roadmap.items still answers;
    no_claim=how often the Inbox parses (test_inbox_checkpoint_summary)."""
    _, auth = owner
    await approved_prd(client, auth)
    parses: list[int] = []
    real = items_file.load_items_yaml

    def counted(text):
        parses.append(len(text))
        return real(text)

    monkeypatch.setattr(items_file, "load_items_yaml", counted)
    runtime.script["roadmap_items"] = [Outcome(artifacts={"roadmap_items.yaml": ITEMS})]
    runtime.script["roadmap_draft"] = [Outcome(artifacts={"roadmap.md": ROADMAP_MD})]
    off = {"roadmap_items": False}
    run = await start(
        client, auth, await create(client, auth, source=PRD, knobs={"checkpoints": off})
    )
    await tick(client, auth)
    await tick(client, auth)
    assert (await get(client, auth, run["id"]))["status"] == "awaiting_checkpoint"
    md = ROADMAP_MD.replace("Make checkout predictable", "Make checkout predictable (1)")
    assert (await import_draft(client, auth, md, ROADMAP)).status_code == 201
    warm = len(parses)
    md = ROADMAP_MD.replace("Make checkout predictable", "Make checkout predictable (2)")
    assert (await import_draft(client, auth, md, ROADMAP)).status_code == 201
    assert len(parses) == warm, "a kept check was parsed again"
    items_file._checks.clear()
    md = ROADMAP_MD.replace("Make checkout predictable", "Make checkout predictable (3)")
    assert (await import_draft(client, auth, md, ROADMAP)).status_code == 201
    assert len(parses) == warm + 1, parses
