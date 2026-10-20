"""Security review of PR 101: a bare ``x-oracle-run-id`` header must not make a person a
run. Only a server-signed run binding (or a run token) does (S6: only runs read the text
a finding released "shared in full"; people see title, link and the 400-char excerpt).

Synthetic placeholders only.
"""

import uuid

from tests.test_intake_sharing import EXCERPT_A, share_all
from tests.test_intake_sharing_round5 import fake, world  # noqa: F401

FORGED = "x-oracle-run-id"


def forged(ctx, who: str) -> dict[str, str]:
    return {**ctx.as_(who), FORGED: str(uuid.uuid4())}


async def test_a_bare_run_header_on_a_person_credential_reads_no_full_text(client, fake):
    ctx, intake_id, items = await world(client, fake, hidden=False)
    await share_all(client, ctx, intake_id, "full")
    for who in ("approver", "viewer", "token"):
        headers = forged(ctx, who)
        resp = await client.get(f"/v1/source-items/{items['a']}", headers=headers)
        assert resp.status_code == 404 or EXCERPT_A not in resp.text, (who, resp.text)
        resp = await client.get("/v1/search", params={"q": "buyers", "limit": 100}, headers=headers)
        assert resp.status_code == 200, resp.text
        assert str(items["a"]) not in {h["item"]["id"] for h in resp.json()["hits"]}, who
        resp = await client.get(
            f"/v1/intakes/{intake_id}/evidence",
            params={"q": "buyers", "limit": 50},
            headers=headers,
        )
        assert resp.status_code in (403, 404) or all(
            EXCERPT_A not in (h.get("snippet") or "") or not h.get("visible")
            for h in resp.json().get("hits", [])
        ), (who, resp.text)
