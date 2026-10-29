"""O5 owner decision (2026-10-26): the status tells an opened link whether it allows
downloads, and the shared page shows Download PDF only when it does.

``GET /v1/public/shares/{token}/status`` answers ``allow_download`` once the passcode
opened the link (active or ended), never while locked; the API's own script-free page
links Download PDF only when downloads are on, and the PDF route keeps refusing when
they are off. Invented data only ("Example Labs").
"""

import uuid
from datetime import UTC, datetime, timedelta

import pytest

from oracle.shares import public as share_public
from oracle.shares.models import ShareLink
from oracle.tenancy import tenant_session
from tests.baseline_helpers import make_ctx
from tests.test_export_audience import seed_roadmap
from tests.test_share_links import PUBLIC, create, opened, token_of

# A browser that opens the address itself (not the web page's fetch).
NAVIGATION = {"Sec-Fetch-Dest": "document", "Sec-Fetch-Mode": "navigate"}
FETCH = {"Sec-Fetch-Dest": "empty", "Sec-Fetch-Mode": "cors"}


@pytest.fixture
async def ctx():
    share_public.reset_limits()
    return await make_ctx("Example Labs")


async def test_a_locked_link_says_nothing_about_downloads(client, ctx):
    """protects=the owner decision with Q5: before the passcode the status is only
    ``locked``, the same for a real link and a guess; fails_when=a locked status carries
    allow_download (it would tell a real link from a guess); no_claim=the page."""
    await seed_roadmap(ctx, publish=True)
    for allow in (True, False):
        token = token_of((await create(client, ctx, "owner", allow_download=allow)).json())
        status = await client.get(f"{PUBLIC}/{token}/status")
        guess = await client.get(f"{PUBLIC}/{'q' * 43}/status")
        assert status.status_code == 200
        assert status.json() == {"state": "locked"}
        assert status.text == guess.text


@pytest.mark.parametrize("allow", [True, False])
async def test_an_open_link_answers_allow_download_and_the_page_follows(client, ctx, allow):
    """protects=the owner decision: an opened, active link's status carries its
    allow_download, and the API's own page links Download PDF only when it is on (never
    inside the web page's frame, which shows its own button); the PDF stays 404 when off;
    fails_when=the status lacks allow_download, or the page offers Download PDF on a
    no-download link or hides it on a download link; no_claim=the PDF's content."""
    await seed_roadmap(ctx, publish=True)
    token = token_of((await create(client, ctx, "owner", allow_download=allow)).json())
    cookie = await opened(client, token)
    status = await client.get(f"{PUBLIC}/{token}/status", headers=cookie)
    assert status.status_code == 200
    got = status.json()
    assert got["state"] == "active" and got["allow_download"] is allow
    # qa-docs-71: only an opened, active link names its roadmap, sender and end.
    assert got["title"] == "Example Labs roadmap" and got["shared_by"] and got["expires_at"]
    page = await client.get(f"{PUBLIC}/{token}", headers={**cookie, **NAVIGATION})
    assert page.status_code == 200, page.text
    assert ("Download PDF" in page.text) is allow
    assert ('href="' + token + '/pdf"' in page.text) is allow
    assert "<script" not in page.text.lower()
    framed = await client.get(f"{PUBLIC}/{token}", headers={**cookie, **FETCH})
    assert framed.status_code == 200
    assert "Download PDF" not in framed.text
    if not allow:
        assert (await client.get(f"{PUBLIC}/{token}/pdf", headers=cookie)).status_code == 404


@pytest.mark.parametrize("allow", [True, False])
async def test_an_ended_link_still_answers_allow_download(client, ctx, allow):
    """protects=the owner decision: a cookie holder of an ended link (expired here) gets
    ``ended`` with the link's allow_download; fails_when=the ended answer lacks it or
    names another value; no_claim=the ended page's words."""
    await seed_roadmap(ctx, publish=True)
    made = (await create(client, ctx, "owner", allow_download=allow)).json()
    token = token_of(made)
    cookie = await opened(client, token)
    async with tenant_session(ctx.tenant_id) as s:
        link = await s.get(ShareLink, uuid.UUID(made["link"]["id"]))
        link.expires_at = datetime.now(UTC) - timedelta(minutes=1)
        await s.commit()
    status = await client.get(f"{PUBLIC}/{token}/status", headers=cookie)
    assert status.json() == {"state": "ended", "allow_download": allow}
