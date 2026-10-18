"""Public-link evidence on the baseline: add, preview, refresh, visibility, scoring, roles."""

from datetime import UTC, datetime, timedelta

import httpx
import pytest
from sqlalchemy import func, select

from oracle import confidence
from oracle.audit import AuditEvent
from oracle.baseline.models import Evidence, EvidenceLinkSnapshot
from oracle.baseline.public_links import LinkFetcher, get_link_fetcher
from oracle.main import app
from oracle.tenancy import tenant_session
from tests.baseline_helpers import cite, confirm, edge, entity, make_ctx, make_item
from tests.test_public_links import GDOC_ID, NOTION_URL, PUBLIC_IP, fixture, html, redirect

B = "/v1/baseline"
WEB_URL = "https://research.example.com/activation"
GDOC_URL = f"https://docs.google.com/document/d/{GDOC_ID}/edit?usp=sharing"
GDOC_EXPORT = f"https://docs.google.com/document/d/{GDOC_ID}/export?format=txt"


class FakeWeb:
    """The public web as the tests see it; ``routes`` can change between calls."""

    def __init__(self) -> None:
        self.routes: dict[str, httpx.Response] = {
            NOTION_URL: html(fixture("notion_public.html")),
            WEB_URL: html(fixture("web_article.html")),
            GDOC_EXPORT: httpx.Response(
                200,
                content=fixture("gdoc_export.txt"),
                headers={
                    "content-type": "text/plain; charset=utf-8",
                    "content-disposition": 'attachment; filename="Pricing page refresh.txt"',
                },
            ),
            "https://wiki.example.com/private": redirect("/login"),
        }
        self.hosts = {"intranet.example.com": ["10.0.0.7"]}
        self.requests: list[str] = []

    def fetcher(self) -> LinkFetcher:
        def handler(request: httpx.Request) -> httpx.Response:
            self.requests.append(str(request.url))
            return self.routes.get(str(request.url)) or httpx.Response(404)

        async def resolve(host: str, port: int) -> list[str]:
            return self.hosts.get(host, [PUBLIC_IP])

        return LinkFetcher(transport=httpx.MockTransport(handler), resolve=resolve)


@pytest.fixture
def web():
    fake = FakeWeb()
    app.dependency_overrides[get_link_fetcher] = fake.fetcher
    yield fake
    app.dependency_overrides.pop(get_link_fetcher, None)


@pytest.fixture
async def ctx():
    return await make_ctx()


async def add(client, ctx, who="commenter", **body):
    return await client.post(f"{B}/evidence/link", json=body, headers=ctx.as_(who))


async def count_evidence(ctx) -> tuple[int, int]:
    async with tenant_session(ctx.tenant_id) as s:
        return (
            await s.scalar(select(func.count()).select_from(Evidence)),
            await s.scalar(select(func.count()).select_from(EvidenceLinkSnapshot)),
        )


def _close(a: float, b: float) -> bool:
    return abs(a - b) <= 0.002


async def test_commenter_adds_a_notion_link_everyone_sees_it(client, ctx, web):
    feat = await entity(client, ctx, type="feature", key="guided-setup")
    resp = await add(
        client, ctx, entity_id=feat["id"], url=NOTION_URL + "#decision", note="Interview data"
    )
    assert resp.status_code == 201, resp.text
    ev = resp.json()
    assert ev["kind"] == "notion" and ev["source_kind"] == "notion"
    assert ev["url"] == NOTION_URL  # fragment dropped
    assert ev["ref"] == "Onboarding research summary"
    assert ev["note"] == "Interview data"
    assert ev["excerpt"].startswith("We interviewed 24 new accounts")
    assert len(ev["excerpt"]) <= 501
    assert ev["source_item"] is None and ev["source_item_private"] is False
    link = ev["link"]
    assert link["title"] == "Onboarding research summary"
    assert link["final_url"] == NOTION_URL
    assert link["last_modified"] is None and link["fetched_at"] == ev["retrieved_at"]
    assert link["text_chars"] > 100
    # Scored like a notion source, freshness from fetched_at (just now).
    inputs = ev["confidence_factors"]["inputs"]
    assert inputs["source_kind"] == "notion" and inputs["item_kind"] is None
    assert ev["confidence_factors"]["breakdown"]["source"]["value"] == 0.7
    assert ev["confidence_factors"]["breakdown"]["freshness"]["value"] > 0.99
    assert ev["confidence"] is not None

    # Public: every role sees the same evidence and its page, not as someone's private item.
    for who in ("owner", "approver", "commenter", "viewer", "token"):
        detail = (await client.get(f"{B}/entities/{feat['id']}", headers=ctx.as_(who))).json()
        (seen,) = detail["evidence"]
        assert seen["link"] == link, who
        assert seen["excerpt"] == ev["excerpt"] and seen["note"] == "Interview data"
        assert seen["source_item_private"] is False
        assert detail["confidence"] == ev["confidence"]

    async with tenant_session(ctx.tenant_id) as s:
        snap = await s.scalar(select(EvidenceLinkSnapshot))
        assert snap.text.startswith("We interviewed")
        assert snap.fetched_by == ctx.users["commenter"].id
        events = (await s.scalars(select(AuditEvent.action))).all()
        assert "baseline.evidence.link_added" in events


async def test_google_doc_and_web_links_and_edges(client, ctx, web):
    goal = await entity(client, ctx, type="goal", key="activation")
    feat = await entity(client, ctx, type="feature", key="pricing-page")
    sup = await edge(client, ctx, feat, goal, "supports", attrs={"contribution": 2})

    gdoc = (await add(client, ctx, edge_id=sup["id"], url=GDOC_URL)).json()
    assert gdoc["kind"] == "google_docs" and gdoc["edge_id"] == sup["id"]
    assert gdoc["ref"] == "Pricing page refresh"
    assert gdoc["excerpt"].startswith("Pricing page refresh Goal: raise trial-to-paid")
    assert gdoc["link"]["final_url"] == GDOC_EXPORT
    assert gdoc["confidence_factors"]["breakdown"]["source"]["value"] == 0.7

    page = (await add(client, ctx, who="approver", entity_id=feat["id"], url=WEB_URL)).json()
    assert page["kind"] == "web"
    assert page["confidence_factors"]["breakdown"]["source"]["value"] == 0.55
    # Freshness from the page's stated last change, not from when it was fetched.
    assert page["link"]["last_modified"] == "2026-09-15T10:30:00Z"
    assert page["confidence_factors"]["inputs"]["latest_at"].startswith("2026-09-15T10:30:00")
    assert page["confidence_factors"]["breakdown"]["freshness"]["value"] < 1.0

    edge_detail = (await client.get(f"{B}/edges/{sup['id']}", headers=ctx.as_("viewer"))).json()
    assert edge_detail["evidence"][0]["link"]["title"] == "Pricing page refresh"


async def test_freshness_halves_from_last_modified(client, ctx, web):
    feat = await entity(client, ctx, type="feature", key="f")
    stamp = datetime.now(UTC) - timedelta(days=90)
    web.routes[WEB_URL] = html(
        "<main><p>Old research.</p></main>",
        **{"last-modified": stamp.strftime("%a, %d %b %Y %H:%M:%S GMT")},
    )
    ev = (await add(client, ctx, entity_id=feat["id"], url=WEB_URL)).json()
    # web: half-life 90 days.
    assert _close(ev["confidence_factors"]["breakdown"]["freshness"]["value"], 0.5)
    expected = confidence.score(
        confidence.Factors(source_kind="web", latest_at=stamp.replace(microsecond=0))
    ).confidence
    assert _close(ev["confidence"], expected)


async def test_links_count_as_independent_mentions(client, ctx, web):
    goal = await confirm(client, ctx, await entity(client, ctx, type="goal", key="g"))
    feat = await entity(client, ctx, type="feature", key="f")
    await edge(client, ctx, feat, goal, "supports", attrs={"contribution": 3})
    item_id = await make_item(ctx, "owner")
    await cite(client, ctx, feat, who="owner", source_item_id=str(item_id))
    await add(client, ctx, entity_id=feat["id"], url=NOTION_URL)
    await add(client, ctx, entity_id=feat["id"], url=WEB_URL)

    detail = (await client.get(f"{B}/entities/{feat['id']}", headers=ctx.as_("viewer"))).json()
    assert len(detail["evidence"]) == 3
    for ev in detail["evidence"]:
        assert ev["confidence_factors"]["inputs"]["mentions"] == 3
        assert ev["confidence_factors"]["inputs"]["goal_contribution"] == 3
    expected = confidence.aggregate([ev["confidence"] for ev in detail["evidence"]])
    assert _close(detail["confidence"], expected)


async def test_preview_shows_title_excerpt_and_confidence_and_saves_nothing(client, ctx, web):
    feat = await entity(client, ctx, type="feature", key="guided-setup")
    resp = await client.post(
        f"{B}/evidence/link/preview",
        json={"entity_id": feat["id"], "url": NOTION_URL},
        headers=ctx.as_("commenter"),
    )
    assert resp.status_code == 200, resp.text
    preview = resp.json()
    assert preview["title"] == "Onboarding research summary"
    assert preview["kind"] == "notion" and preview["already_cited"] is False
    assert preview["excerpt"].startswith("We interviewed 24 new accounts")
    assert await count_evidence(ctx) == (0, 0)

    saved = (await add(client, ctx, entity_id=feat["id"], url=NOTION_URL)).json()
    assert _close(saved["confidence"], preview["confidence"])
    assert saved["excerpt"] == preview["excerpt"]

    again = await client.post(
        f"{B}/evidence/link/preview",
        json={"entity_id": feat["id"], "url": NOTION_URL},
        headers=ctx.as_("commenter"),
    )
    assert again.json()["already_cited"] is True


async def test_refused_links_save_nothing(client, ctx, web):
    feat = await entity(client, ctx, type="feature", key="f")
    cases = [
        ("http://research.example.com/activation", 422, "not_https"),
        ("https://intranet.example.com/wiki", 422, "blocked_address"),
        ("https://169.254.169.254/latest/meta-data/", 422, "blocked_address"),
        ("https://wiki.example.com/private", 422, "not_public"),
        ("https://www.notion.so/Secret-0123456789abcdef0123456789abcdef", 422, "not_public"),
        (f"https://docs.google.com/spreadsheets/d/{GDOC_ID}/edit", 422, "unsupported_link"),
    ]
    for url, code, reason in cases:
        for path in ("/evidence/link", "/evidence/link/preview"):
            resp = await client.post(
                B + path, json={"entity_id": feat["id"], "url": url}, headers=ctx.as_("commenter")
            )
            assert resp.status_code == code, (url, resp.text)
            assert resp.json()["code"] == reason, url
    not_public = await add(
        client, ctx, entity_id=feat["id"], url="https://wiki.example.com/private"
    )
    assert not_public.json()["detail"].startswith("This link is not public")
    assert await count_evidence(ctx) == (0, 0)
    assert not any("intranet" in u or "169.254" in u for u in web.requests)


async def test_targets_are_checked(client, ctx, web):
    feat = await entity(client, ctx, type="feature", key="f")
    other = await entity(client, ctx, type="feature", key="g")
    sup = await edge(client, ctx, feat, other, "depends_on")
    both = await add(client, ctx, entity_id=feat["id"], edge_id=sup["id"], url=WEB_URL)
    assert both.status_code == 422
    neither = await add(client, ctx, url=WEB_URL)
    assert neither.status_code == 422
    missing = await add(client, ctx, entity_id="00000000-0000-0000-0000-000000000000", url=WEB_URL)
    assert missing.status_code == 404
    assert web.requests == []  # nothing fetched for a bad target

    assert (await add(client, ctx, entity_id=feat["id"], url=WEB_URL)).status_code == 201
    dup = await add(client, ctx, entity_id=feat["id"], url=WEB_URL + "#again")
    assert dup.status_code == 409
    # The same link on another item is fine.
    assert (await add(client, ctx, entity_id=other["id"], url=WEB_URL)).status_code == 201


async def test_roles(client, ctx, web):
    feat = await entity(client, ctx, type="feature", key="f")
    body = {"entity_id": feat["id"], "url": WEB_URL}
    assert (await add(client, ctx, who="viewer", **body)).status_code == 403
    preview = await client.post(f"{B}/evidence/link/preview", json=body, headers=ctx.as_("viewer"))
    assert preview.status_code == 403
    assert (await client.post(f"{B}/evidence/link", json=body)).status_code == 401
    assert web.requests == []

    ev = (await add(client, ctx, who="commenter", **body)).json()
    refresh = f"{B}/evidence/{ev['id']}/refresh"
    assert (await client.post(refresh, headers=ctx.as_("viewer"))).status_code == 403
    assert (await client.post(refresh, headers=ctx.as_("commenter"))).status_code == 200
    # Removing evidence stays with approvers.
    gone = await client.delete(f"{B}/evidence/{ev['id']}", headers=ctx.as_("commenter"))
    assert gone.status_code == 403
    for who in ("approver", "owner", "token"):
        other = await entity(client, ctx, type="feature", key=f"f-{who}")
        resp = await add(client, ctx, who=who, entity_id=other["id"], url=NOTION_URL)
        assert resp.status_code == 201, who


async def test_refresh_updates_the_snapshot_and_rescores(client, ctx, web):
    feat = await entity(client, ctx, type="feature", key="f")
    old = (datetime.now(UTC) - timedelta(days=180)).strftime("%a, %d %b %Y %H:%M:%S GMT")
    web.routes[WEB_URL] = html("<main><p>First draft.</p></main>", **{"last-modified": old})
    ev = (await add(client, ctx, entity_id=feat["id"], url=WEB_URL)).json()
    assert ev["excerpt"] == "First draft."
    stale = ev["confidence"]

    # Same content: no new snapshot, but fetched_at moves.
    same = await client.post(f"{B}/evidence/{ev['id']}/refresh", headers=ctx.as_("commenter"))
    assert same.status_code == 200
    assert await count_evidence(ctx) == (1, 1)

    web.routes[WEB_URL] = html(
        "<html><head><title>Second</title></head><main><p>Updated findings.</p></main></html>"
    )
    resp = await client.post(f"{B}/evidence/{ev['id']}/refresh", headers=ctx.as_("commenter"))
    assert resp.status_code == 200, resp.text
    fresh = resp.json()
    assert fresh["excerpt"] == "Updated findings." and fresh["ref"] == "Second"
    assert fresh["link"]["title"] == "Second" and fresh["link"]["last_modified"] is None
    assert fresh["confidence"] > stale  # freshness from the new fetch
    assert fresh["scored_at"] > ev["scored_at"]
    assert await count_evidence(ctx) == (1, 2)
    detail = (await client.get(f"{B}/entities/{feat['id']}", headers=ctx.as_("viewer"))).json()
    assert detail["confidence"] == fresh["confidence"]

    # A page that stopped being public keeps the last snapshot and says why.
    web.routes[WEB_URL] = httpx.Response(403)
    gone = await client.post(f"{B}/evidence/{ev['id']}/refresh", headers=ctx.as_("commenter"))
    assert gone.status_code == 422 and gone.json()["code"] == "not_public"
    assert await count_evidence(ctx) == (1, 2)


async def test_refresh_only_for_link_evidence(client, ctx, web):
    feat = await entity(client, ctx, type="feature", key="f")
    manual = await cite(client, ctx, feat, who="approver", url=WEB_URL, excerpt="Typed in")
    assert manual["kind"] is None and manual["link"] is None
    assert manual["source_kind"] == "manual"
    resp = await client.post(f"{B}/evidence/{manual['id']}/refresh", headers=ctx.as_("commenter"))
    assert resp.status_code == 422
    missing = await client.post(
        f"{B}/evidence/00000000-0000-0000-0000-000000000000/refresh", headers=ctx.as_("commenter")
    )
    assert missing.status_code == 404
    assert web.requests == []


async def test_rescore_all_keeps_link_scoring(client, ctx, web):
    feat = await entity(client, ctx, type="feature", key="f")
    ev = (await add(client, ctx, entity_id=feat["id"], url=GDOC_URL)).json()
    resp = await client.post(f"{B}/rescore", headers=ctx.as_("approver"))
    assert resp.status_code == 200
    params = {"entity_id": feat["id"]}
    (after,) = (await client.get(f"{B}/evidence", params=params, headers=ctx.as_("viewer"))).json()
    assert after["confidence_factors"]["inputs"]["source_kind"] == "google_docs"
    assert _close(after["confidence"], ev["confidence"])


async def test_link_evidence_is_deleted_with_its_snapshots(client, ctx, web):
    feat = await entity(client, ctx, type="feature", key="f")
    ev = (await add(client, ctx, entity_id=feat["id"], url=NOTION_URL)).json()
    resp = await client.delete(f"{B}/evidence/{ev['id']}", headers=ctx.as_("approver"))
    assert resp.status_code == 204
    assert await count_evidence(ctx) == (0, 0)
