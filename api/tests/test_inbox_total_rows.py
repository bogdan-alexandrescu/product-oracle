"""#514 walk finding 1: the Inbox's ``total`` (the rail badge) counts each new or open row
once, as Home's Needs you and the Inbox header count them: a track is one row however many
of its alerts are open (they are its children, as a checkpoint's items are). Against
Postgres with the FakeRuntime.

Each test's card: protects=what it guards; fails_when=what breaks it; no_claim=what it
does not prove.
"""

from tests.test_roadmap import owner, runtime  # noqa: F401 - fixtures
from tests.test_track_alerts import BETA, alerts_of, importing, record, tracked


async def test_a_track_with_several_open_alerts_counts_once_in_the_total(
    client,
    owner,  # noqa: F811
    runtime,  # noqa: F811
):
    """protects=#514 finding 1, the badge counts one per Inbox row (a track, not its alerts);
    fails_when=the total grows by the number of the track's open alerts; no_claim=the web's
    row counting (web/e2e/walk-514.spec.ts)."""
    _, auth = owner
    track = await tracked(client, auth, runtime)
    before = (await client.get("/v1/inbox", headers=auth)).json()
    assert before["tracks"] == []

    # Two open alerts on the one track: a date slip and an issue not on the roadmap.
    await importing(client, auth, record(track["id"], BETA))
    await importing(client, auth, record(track["id"]))
    await importing(
        client, auth,
        {"external_ref": "ENG-777", "title": "Refactor cart", "state": "todo",
         "track_id": track["id"]},
    )  # fmt: skip
    assert len(await alerts_of(client, auth)) >= 2

    inbox = (await client.get("/v1/inbox", headers=auth)).json()
    (row,) = inbox["tracks"]
    assert row["counts"]["new"] + row["counts"]["open"] >= 2
    assert inbox["total"] == before["total"] + 1
