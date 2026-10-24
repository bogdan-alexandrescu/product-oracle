"""Shared setup for the H7 Competitive digest tests: a fake web behind Oracle's own
fetcher (LinkFetcher with a mock transport and resolver, so its guards run), made-up
alternatives on ``.example`` hosts, and a ready digest occurrence."""

import uuid
from dataclasses import dataclass, field

import httpx
import pytest
from sqlalchemy import select

from oracle.baseline.public_links import LinkFetcher, get_link_fetcher
from oracle.main import app
from oracle.market import robots, watch
from oracle.rituals.models import Ritual, RitualOccurrence
from oracle.tenancy import tenant_session
from oracle.web.models import WebResult
from tests.ritual_helpers import occurrences_of, rituals_of, tick

PUBLIC = "93.184.216.34"


@dataclass
class FakeWeb:
    # url -> (status, body, content type)
    pages: dict[str, tuple[int, str, str]] = field(default_factory=dict)
    # host -> address (PUBLIC unless named)
    addresses: dict[str, str] = field(default_factory=dict)
    # host -> raise a timeout on every request
    slow: set[str] = field(default_factory=set)
    requests: list[str] = field(default_factory=list)

    def page(self, url: str, body: str, status: int = 200, kind: str = "text/html") -> None:
        self.pages[url] = (status, body, kind)

    def handler(self, request: httpx.Request) -> httpx.Response:
        url = str(request.url)
        self.requests.append(url)
        if request.url.host in self.slow:
            raise httpx.ReadTimeout("slow", request=request)
        status, body, kind = self.pages.get(url, (404, "not found", "text/plain"))
        return httpx.Response(status, text=body, headers={"content-type": kind})

    def fetcher(self) -> LinkFetcher:
        async def resolve(host: str, port: int) -> list[str]:
            return [self.addresses.get(host, PUBLIC)]

        return LinkFetcher(transport=httpx.MockTransport(self.handler), resolve=resolve)

    def hits(self, url: str) -> int:
        return sum(1 for u in self.requests if u == url)


@pytest.fixture
def web(monkeypatch):
    fake = FakeWeb()
    robots.clear()
    monkeypatch.setattr(watch, "fetcher", fake.fetcher)
    app.dependency_overrides[get_link_fetcher] = fake.fetcher
    yield fake
    app.dependency_overrides.pop(get_link_fetcher, None)
    robots.clear()


def html(*lines: str) -> str:
    body = "".join(f"<p>{line}</p>" for line in lines)
    return f"<html><head><title>Pricing</title></head><body>{body}</body></html>"


async def add_competitor(
    client, ctx, name="Competitor A", kind="direct", aliases=(), who="approver"
):
    site = f"https://{name.lower().replace(' ', '-')}.example"
    body = {"name": name, "kind": kind, "website": site, "aliases": list(aliases)}
    resp = await client.post("/v1/competitors", json=body, headers=ctx.as_(who))
    return resp


async def watch_page(client, ctx, cid, url, label="pricing", who="approver"):
    return await client.post(
        f"/v1/competitors/{cid}/pages", json={"url": url, "label": label}, headers=ctx.as_(who)
    )


async def digest_ritual(tenant_id: uuid.UUID) -> Ritual:
    return (await rituals_of(tenant_id))["competitive_digest"]


async def ready_digest(ctx, at) -> RitualOccurrence:
    """Moves the clock to the active digest ritual's preparation moment and ticks."""
    ritual = await digest_ritual(ctx.tenant_id)
    assert ritual.status == "active" and ritual.next_due_at is not None
    at(ritual.next_due_at)
    await tick(ctx.tenant_id)
    (occ,) = await occurrences_of(ctx.tenant_id, ritual.id)
    assert occ.status == "ready", occ.error
    return occ


async def record_results(tenant_id: uuid.UUID, run_id, *results: dict) -> None:
    """What Oracle's search_web would have recorded for the run (H7 lane 1's tool, faked
    here): each result with its ref."""
    async with tenant_session(tenant_id) as s:
        for r in results:
            s.add(WebResult(run_id=run_id, kind=r.get("kind", "search_result"), **{
                k: v for k, v in r.items() if k != "kind"}))  # fmt: skip
        await s.commit()


async def occurrence(tenant_id: uuid.UUID, occ_id) -> RitualOccurrence:
    async with tenant_session(tenant_id) as s:
        return await s.scalar(select(RitualOccurrence).where(RitualOccurrence.id == occ_id))
