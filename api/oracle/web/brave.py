"""The first web search provider: the Brave Search API (Q5 "Web search", owner
2026-10-23: a search API key held by Oracle; the owner creates the account and stores the
key as ``oracle-web-search-key``).

``GET https://api.search.brave.com/res/v1/web/search?q=…&count=…`` with the key in the
``X-Subscription-Token`` header (never in the URL). Titles and descriptions come with
``<strong>`` highlights and HTML entities: they are reduced to plain text. Only https
results are kept, since only those can be fetched.
"""

import html
import re
from datetime import date

import httpx

from oracle.web.search import ProviderError, SearchResult, WebSearchProvider

ENDPOINT = "https://api.search.brave.com/res/v1/web/search"
TIMEOUT = 10.0
_TAG = re.compile(r"<[^>]{0,200}>")


def _plain(value: object) -> str:
    if not isinstance(value, str):
        return ""
    return " ".join(html.unescape(_TAG.sub("", value)).split())


def _day(value: object) -> date | None:
    if not isinstance(value, str) or len(value) < 10:
        return None
    try:
        return date.fromisoformat(value[:10])
    except ValueError:
        return None


class BraveSearch(WebSearchProvider):
    name = "brave"

    def __init__(self, key: str, transport: httpx.AsyncBaseTransport | None = None):
        self._key = key
        self._transport = transport

    def __repr__(self) -> str:
        return "BraveSearch(key=***)"

    async def search(self, query: str, n: int) -> list[SearchResult]:
        try:
            async with httpx.AsyncClient(
                transport=self._transport, trust_env=False, timeout=TIMEOUT
            ) as client:
                resp = await client.get(
                    ENDPOINT,
                    params={"q": query, "count": n},
                    headers={"Accept": "application/json", "X-Subscription-Token": self._key},
                )
        except httpx.HTTPError as exc:
            raise ProviderError(
                0, f"The search provider did not answer ({type(exc).__name__})."
            ) from None
        if resp.status_code != 200:
            raise ProviderError(
                resp.status_code, f"The search provider answered {resp.status_code}."
            )
        try:
            items = (resp.json().get("web") or {}).get("results") or []
        except (ValueError, AttributeError):
            raise ProviderError(
                resp.status_code, "The search provider's answer was not JSON."
            ) from None
        out: list[SearchResult] = []
        for item in items:
            if not isinstance(item, dict):
                continue
            url = item.get("url")
            if not isinstance(url, str) or not url.startswith("https://"):
                continue
            out.append(
                SearchResult(
                    url=url,
                    title=_plain(item.get("title"))[:500],
                    snippet=_plain(item.get("description"))[:2000],
                    published_on=_day(item.get("page_age")),
                )
            )
            if len(out) >= n:
                break
        return out
