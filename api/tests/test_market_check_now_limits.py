# ruff: noqa: F811 - the fixtures are imported
"""H7 security minors (#541): Check now's rate limit (per page and per company, a 429
saying when it may be tried again in the Company time zone), and one URL check shared
with Oracle's own web fetcher (made-up alternatives on ``.example`` hosts; no request
leaves the test).

Each test's card: protects=<the observable>; fails_when=<the wrong result it rejects>;
no_claim=<what green does not prove>.
"""

import asyncio
from datetime import timedelta

import pytest

from oracle.baseline import public_links
from oracle.market import service
from tests.decision_helpers import set_company_zone
from tests.market_helpers import add_competitor, html, watch_page, web  # noqa: F401
from tests.ritual_helpers import START, at, ctx  # noqa: F401

SITE = "https://competitor-a.example"


async def _pages(client, ctx, web, n: int) -> list[str]:
    cid = (await add_competitor(client, ctx)).json()["id"]
    ids = []
    for i in range(n):
        url = f"{SITE}/p{i}"
        web.page(url, html(f"Page {i}"))
        resp = await watch_page(client, ctx, cid, url, label="other")
        assert resp.status_code == 201, resp.text
        ids.append(resp.json()["id"])
    return ids


async def _check(client, ctx, pid, who="approver"):
    return await client.post(f"/v1/competitor-pages/{pid}/check", headers=ctx.as_(who))


async def test_check_now_once_per_page_per_ten_minutes(client, ctx, at, web):
    """protects=criterion 2: a second Check now on the same page within 10 minutes is 429
    saying, in words and in the Company time zone, when it may be tried again (and a
    Retry-After), and nothing is fetched; after 10 minutes it works again; another page
    is not held back; fails_when=Check now can be pressed without limit, or the time is
    ISO/UTC; no_claim=the web's wording around the message (the mock spec)."""
    await set_company_zone(ctx.tenant_id, "Europe/Berlin")
    first, second = await _pages(client, ctx, web, 2)
    at(START)
    assert (await _check(client, ctx, first)).status_code == 200
    before = len(web.requests)
    at(START + timedelta(minutes=1))
    resp = await _check(client, ctx, first)
    assert resp.status_code == 429, resp.text
    assert resp.json()["detail"] == (
        "This page was checked at Mon Oct 19, 9:00 PM CEST; "
        "Check now works on it again after Mon Oct 19, 9:10 PM CEST"
    )
    assert resp.headers["Retry-After"] == "540"
    assert len(web.requests) == before
    assert (await _check(client, ctx, second)).status_code == 200
    at(START + timedelta(minutes=10))
    assert (await _check(client, ctx, first)).status_code == 200


async def test_check_now_at_most_so_many_per_company_per_hour(client, ctx, at, web, monkeypatch):
    """protects=criterion 2: past the company's hourly number of Check nows (20; 3 here)
    the next one is 429 naming when the oldest of the hour drops out; fails_when=many
    pages let one person fetch without limit; no_claim=several API processes racing
    (the count reads committed rows)."""
    monkeypatch.setattr(service, "CHECKS_PER_COMPANY_HOUR", 3)
    assert service.CHECKS_PER_PAGE_WINDOW == timedelta(minutes=10)
    ids = await _pages(client, ctx, web, 4)
    for i, pid in enumerate(ids[:3]):
        at(START + timedelta(minutes=i))
        assert (await _check(client, ctx, pid)).status_code == 200
    at(START + timedelta(minutes=5))
    resp = await _check(client, ctx, ids[3])
    assert resp.status_code == 429, resp.text
    assert resp.json()["detail"] == (
        "Check now was used 3 times in the last hour; it works again after Mon Oct 19, 1:00 PM PDT"
    )
    assert resp.headers["Retry-After"] == str(55 * 60)
    at(START + timedelta(hours=1))
    assert (await _check(client, ctx, ids[3])).status_code == 200


@pytest.mark.parametrize(
    "url",
    [
        "http://competitor-a.example/pricing",
        "ftp://competitor-a.example/pricing",
        "https://user:pw@competitor-a.example/pricing",
        "https://competitor-a.example:8443/pricing",
        "https://10.0.0.7/pricing",
        "https://127.0.0.1/pricing",
        "https://169.254.169.254/latest/meta-data",
        "https://[::1]/pricing",
        "https://localhost/pricing",
        "https://intranet.local/pricing",
        "https://metadata.internal/pricing",
        "https://intranet/pricing",
    ],
)
async def test_a_page_url_passes_the_fetchers_own_check(client, ctx, at, web, url):
    """protects=criterion 3: watching a page uses the web fetcher's URL check (scheme,
    user name, port, IP literals, private hosts), so a URL it would refuse is 422 and no
    request leaves; the fetcher refuses the same URL; fails_when=Market stores a URL the
    fetcher refuses; no_claim=a public name resolving to a private address (refused at
    connect, test_market_watch)."""
    with pytest.raises(public_links.LinkError):
        public_links.check_url(url)
    cid = (await add_competitor(client, ctx)).json()["id"]
    resp = await watch_page(client, ctx, cid, url)
    assert resp.status_code == 422, resp.text
    assert resp.json()["detail"].startswith("url: ")
    assert web.requests == []


async def test_a_public_page_url_is_watched_as_given(client, ctx, at, web):
    """protects=criterion 3: an https page on the standard port is watched as given;
    fails_when=the shared check refuses ordinary pages; no_claim=normalisation."""
    web.page(f"{SITE}/pricing", html("Team $10"))
    cid = (await add_competitor(client, ctx)).json()["id"]
    resp = await watch_page(client, ctx, cid, f" {SITE}/pricing ")
    assert resp.status_code == 201, resp.text
    assert resp.json()["url"] == f"{SITE}/pricing"


async def test_watching_a_page_again_does_not_fetch_without_limit(
    client, ctx, at, web, monkeypatch
):
    """protects=#565 review minor: the read a newly watched page gets at once counts
    against the company's hourly number (3 here), so removing and watching a page again
    stops fetching it at once past that number; the page is still watched (read at the
    next scheduled tick); fails_when=delete and re-add gives unlimited fetches;
    no_claim=the scheduled tick's own pace (test_market_watch)."""
    monkeypatch.setattr(service, "CHECKS_PER_COMPANY_HOUR", 3)
    url = f"{SITE}/pricing"
    web.page(url, html("Team $10"))
    cid = (await add_competitor(client, ctx)).json()["id"]
    for i in range(6):
        at(START + timedelta(minutes=i))
        resp = await watch_page(client, ctx, cid, url)
        assert resp.status_code == 201, resp.text
        if i < 5:
            gone = await client.delete(f"/v1/competitor-pages/{resp.json()['id']}",
                                       headers=ctx.as_("approver"))  # fmt: skip
            assert gone.status_code == 204, gone.text
    assert web.hits(url) == 3
    assert resp.json()["last_checked_at"] is None
    at(START + timedelta(hours=1, minutes=1))
    assert (await _check(client, ctx, resp.json()["id"])).status_code == 200
    assert web.hits(url) == 4


async def test_parallel_check_nows_on_different_pages_keep_the_company_cap(
    client, ctx, at, web, monkeypatch
):
    """protects=#565 review minor: Check nows on different pages at the same moment are
    counted one after another (a company-wide lock), so no more than the hourly number
    (1 here) pass; fails_when=parallel calls each read the count before any is written
    and all pass; no_claim=several API processes beyond one database."""
    monkeypatch.setattr(service, "CHECKS_PER_COMPANY_HOUR", 1)
    ids = await _pages(client, ctx, web, 4)
    at(START + timedelta(hours=2))
    got = await asyncio.gather(*(_check(client, ctx, pid) for pid in ids))
    codes = sorted(r.status_code for r in got)
    assert codes == [200, 429, 429, 429], [r.text for r in got]
