"""Public-link fetching: allowed and refused URLs, SSRF, non-public pages, extraction."""

from datetime import UTC, datetime
from pathlib import Path

import httpcore
import httpx
import pytest

from oracle.baseline import public_links
from oracle.baseline.public_links import LinkError, LinkFetcher, classify, public_address

FIXTURES = Path(__file__).parent / "fixtures" / "public_links"
PUBLIC_IP = "93.184.216.34"
NOW = datetime(2026, 10, 18, 9, 0, tzinfo=UTC)
GDOC_ID = "1AbCdEfGhIjKlMnOpQrStUvWxYz0123456789_-abc"
NOTION_URL = (
    "https://examplecorp.notion.site/Onboarding-research-summary-8c8f4dca142f44198555e626ba58742d"
)


def fixture(name: str) -> bytes:
    return (FIXTURES / name).read_bytes()


def resolver(table: dict[str, list[str]] | None = None):
    """A DNS stand-in: hosts not in the table resolve to a public address."""
    calls: list[str] = []

    async def resolve(host: str, port: int) -> list[str]:
        calls.append(host)
        return (table or {}).get(host, [PUBLIC_IP])

    resolve.calls = calls  # type: ignore[attr-defined]
    return resolve


def site(routes: dict[str, httpx.Response | Exception], seen: list[httpx.Request] | None = None):
    """A mock transport answering by full URL; anything else is a 404."""

    def handler(request: httpx.Request) -> httpx.Response:
        if seen is not None:
            seen.append(request)
        answer = routes.get(str(request.url))
        if isinstance(answer, Exception):
            raise answer
        return answer or httpx.Response(404, text="Not found")

    return httpx.MockTransport(handler)


def html(body: bytes | str, **headers: str) -> httpx.Response:
    return httpx.Response(
        200, content=body, headers={"content-type": "text/html; charset=utf-8", **headers}
    )


def redirect(location: str, code: int = 302) -> httpx.Response:
    return httpx.Response(code, headers={"location": location})


async def fetch(url: str, routes: dict, resolve=None, **kw) -> public_links.Page:
    fetcher = LinkFetcher(transport=site(routes), resolve=resolve or resolver(), **kw)
    return await fetcher.fetch(url, now=NOW)


async def refused(url: str, routes: dict | None = None, resolve=None, **kw) -> LinkError:
    with pytest.raises(LinkError) as info:
        await fetch(url, routes or {}, resolve, **kw)
    return info.value


# --- which URLs ----------------------------------------------------------------------------


@pytest.mark.parametrize(
    ("url", "kind", "fetch_url"),
    [
        (NOTION_URL, "notion", NOTION_URL),
        (
            "https://www.notion.so/examplecorp/Plan-8c8f4dca142f44198555e626ba58742d#heading",
            "notion",
            "https://www.notion.so/examplecorp/Plan-8c8f4dca142f44198555e626ba58742d",
        ),
        ("https://notion.so/Plan-8c8f4dca142f44198555e626ba58742d", "notion", None),
        (
            f"https://docs.google.com/document/d/{GDOC_ID}/edit?usp=sharing",
            "google_docs",
            f"https://docs.google.com/document/d/{GDOC_ID}/export?format=txt",
        ),
        (
            f"https://docs.google.com/document/u/1/d/{GDOC_ID}/view",
            "google_docs",
            f"https://docs.google.com/document/d/{GDOC_ID}/export?format=txt",
        ),
        (
            f"https://docs.google.com/document/d/e/{GDOC_ID}/pub",
            "google_docs",
            f"https://docs.google.com/document/d/e/{GDOC_ID}/pub",
        ),
        (
            "https://Research.Example.com./post?id=7",
            "web",
            "https://research.example.com/post?id=7",
        ),
        ("https://example.com:443/a", "web", "https://example.com/a"),
    ],
)
def test_allowed_urls(url, kind, fetch_url):
    target = classify(url)
    assert target.kind == kind
    assert "#" not in target.url
    if fetch_url:
        assert target.fetch_url == fetch_url


@pytest.mark.parametrize(
    ("url", "code"),
    [
        ("http://example.com/page", "not_https"),
        ("ftp://example.com/file.txt", "not_https"),
        ("file:///etc/passwd", "not_https"),
        ("javascript:alert(1)", "not_https"),
        ("example.com/page", "not_https"),
        ("https://", "invalid_url"),
        ("https://example.com:8443/page", "invalid_url"),
        ("https://user:secret@example.com/", "invalid_url"),
        ("https://example.com:99999/", "invalid_url"),
        (f"https://docs.google.com/spreadsheets/d/{GDOC_ID}/edit", "unsupported_link"),
        ("https://docs.google.com/forms/d/e/abc/viewform", "unsupported_link"),
    ],
)
def test_refused_urls(url, code):
    with pytest.raises(LinkError) as info:
        classify(url)
    assert info.value.code == code
    assert info.value.status_code == 422


@pytest.mark.parametrize(
    ("address", "public"),
    [
        (PUBLIC_IP, True),
        ("2606:4700:4700::1111", True),
        ("10.1.2.3", False),
        ("172.16.0.1", False),
        ("192.168.1.10", False),
        ("127.0.0.1", False),
        ("0.0.0.0", False),
        ("169.254.169.254", False),  # cloud metadata
        ("100.64.0.1", False),  # carrier-grade NAT
        ("224.0.0.1", False),
        ("255.255.255.255", False),
        ("::1", False),
        ("fe80::1%eth0", False),
        ("fc00::1", False),
        ("::ffff:127.0.0.1", False),
        ("::ffff:10.0.0.1", False),
        ("64:ff9b::a00:1", False),  # NAT64 of 10.0.0.1
        ("2002:a00:1::", False),  # 6to4
        ("not an address", False),
    ],
)
def test_public_address(address, public):
    assert public_address(address) is public


# --- SSRF ----------------------------------------------------------------------------------


@pytest.mark.parametrize(
    "addresses",
    [["10.0.0.5"], ["127.0.0.1"], ["169.254.169.254"], [PUBLIC_IP, "192.168.0.2"], ["::1"]],
)
async def test_host_resolving_to_private_addresses_is_refused(addresses):
    seen: list[httpx.Request] = []
    fetcher = LinkFetcher(
        transport=site({"https://intranet.example.com/": html("<p>secret</p>")}, seen),
        resolve=resolver({"intranet.example.com": addresses}),
    )
    with pytest.raises(LinkError) as info:
        await fetcher.fetch("https://intranet.example.com/")
    assert info.value.code == "blocked_address"
    assert seen == []  # never requested


@pytest.mark.parametrize(
    "url",
    [
        "https://127.0.0.1/",
        "https://[::1]/",
        "https://[::ffff:127.0.0.1]/",
        "https://169.254.169.254/latest/meta-data/",
        "https://10.0.0.1/",
    ],
)
async def test_private_ip_literals_are_refused(url):
    resolve = resolver()
    error = await refused(url, resolve=resolve)
    assert error.code == "blocked_address"
    assert resolve.calls == []


async def test_redirect_to_a_private_host_is_refused():
    seen: list[httpx.Request] = []
    fetcher = LinkFetcher(
        transport=site(
            {
                "https://blog.example.com/post": redirect("https://metadata.internal/latest"),
                "https://metadata.internal/latest": html("<p>credentials</p>"),
            },
            seen,
        ),
        resolve=resolver({"metadata.internal": ["169.254.169.254"]}),
    )
    with pytest.raises(LinkError) as info:
        await fetcher.fetch("https://blog.example.com/post")
    assert info.value.code == "blocked_address"
    assert [str(r.url) for r in seen] == ["https://blog.example.com/post"]


@pytest.mark.parametrize(
    ("location", "code"),
    [
        ("https://127.0.0.1/admin", "blocked_address"),
        ("http://blog.example.com/post", "not_https"),
        ("https://blog.example.com:8080/post", "invalid_url"),
        ("file:///etc/passwd", "not_https"),
    ],
)
async def test_redirects_are_checked_like_the_link(location, code):
    routes = {"https://blog.example.com/post": redirect(location)}
    assert (await refused("https://blog.example.com/post", routes)).code == code


async def test_too_many_redirects():
    routes = {f"https://example.com/{i}": redirect(f"/{i + 1}") for i in range(10)}
    error = await refused("https://example.com/0", routes)
    assert error.code == "unreachable" and "too many" in str(error)


async def test_guarded_backend_refuses_private_addresses_when_connecting():
    """The real transport checks the address again when it connects (DNS rebinding)."""
    backend = public_links._GuardedBackend(resolver({"rebind.example.com": ["127.0.0.1"]}))
    with pytest.raises(httpcore.ConnectError, match="private"):
        await backend.connect_tcp("rebind.example.com", 443)
    with pytest.raises(httpcore.ConnectError):
        await backend.connect_unix_socket("/var/run/docker.sock")


async def test_guarded_transport_never_connects_to_a_private_address():
    """End to end through the real transport: the first check stops it; if DNS answers
    public first and private when connecting, the backend stops it."""
    answers = iter([[PUBLIC_IP], ["127.0.0.1"]])

    async def flipping(host: str, port: int) -> list[str]:
        return next(answers)

    fetcher = LinkFetcher(resolve=flipping)
    with pytest.raises(LinkError) as info:
        await fetcher.fetch("https://rebind.example.com/")
    assert info.value.code == "unreachable"


async def test_fetch_sends_no_credentials_and_keeps_no_cookies():
    seen: list[httpx.Request] = []
    fetcher = LinkFetcher(
        transport=site(
            {
                "https://example.com/a": httpx.Response(
                    302, headers={"location": "/b", "set-cookie": "sid=abc; Path=/"}
                ),
                "https://example.com/b": html("<main><p>Hello there</p></main>"),
            },
            seen,
        ),
        resolve=resolver(),
    )
    page = await fetcher.fetch("https://example.com/a")
    assert page.final_url == "https://example.com/b"
    for request in seen:
        assert "cookie" not in request.headers
        assert "authorization" not in request.headers
        assert "ProductOracleBot" in request.headers["user-agent"]


# --- limits --------------------------------------------------------------------------------


@pytest.mark.parametrize("content_type", ["application/pdf", "image/png", "application/json", ""])
async def test_only_web_pages_and_text(content_type):
    routes = {
        "https://example.com/f": httpx.Response(
            200, content=b"%PDF-1.7", headers={"content-type": content_type}
        )
    }
    assert (await refused("https://example.com/f", routes)).code == "unsupported_content"


async def test_size_cap_from_content_length_and_while_streaming():
    big = b"<p>" + b"a" * 5000 + b"</p>"
    routes = {"https://example.com/big": html(big)}
    error = await refused("https://example.com/big", routes, max_bytes=1000)
    assert error.code == "too_large"

    def streamed(request):
        async def body():
            for _ in range(10):
                yield b"<p>" + b"b" * 500 + b"</p>"

        return httpx.Response(200, headers={"content-type": "text/html"}, content=body())

    fetcher = LinkFetcher(
        transport=httpx.MockTransport(streamed), resolve=resolver(), max_bytes=1000
    )
    with pytest.raises(LinkError) as info:
        await fetcher.fetch("https://example.com/stream")
    assert info.value.code == "too_large"


async def test_timeouts_and_unreachable():
    routes = {
        "https://slow.example.com/": httpx.ReadTimeout("slow"),
        "https://down.example.com/": httpx.ConnectError("refused"),
        "https://err.example.com/": httpx.Response(500, text="oops"),
    }
    assert (await refused("https://slow.example.com/", routes)).status_code == 504
    assert (await refused("https://down.example.com/", routes)).code == "unreachable"
    assert (await refused("https://err.example.com/", routes)).code == "unreachable"


async def test_whole_fetch_has_a_deadline(monkeypatch):
    monkeypatch.setattr(public_links, "TOTAL_TIMEOUT", 0.05)

    async def slow(host, port):
        import asyncio

        await asyncio.sleep(1)
        return [PUBLIC_IP]

    error = await refused("https://example.com/", {}, resolve=slow)
    assert error.code == "timeout"


async def test_unresolvable_host():
    async def nxdomain(host, port):
        raise OSError("Name or service not known")

    error = await refused("https://nope.example.com/", {}, resolve=nxdomain)
    assert error.code == "unreachable" and error.status_code == 502


# --- not public ----------------------------------------------------------------------------


@pytest.mark.parametrize("code", [401, 403])
async def test_sign_in_status_is_not_public(code):
    routes = {"https://example.com/private": httpx.Response(code, text="Sign in")}
    error = await refused("https://example.com/private", routes)
    assert error.code == "not_public"
    assert str(error).startswith("This link is not public")


async def test_private_google_doc_redirects_to_sign_in():
    export = f"https://docs.google.com/document/d/{GDOC_ID}/export?format=txt"
    routes = {
        export: redirect("https://accounts.google.com/ServiceLogin?service=wise&continue=" + export)
    }
    error = await refused(f"https://docs.google.com/document/d/{GDOC_ID}/edit", routes)
    assert error.code == "not_public"


async def test_redirect_to_a_login_page_is_not_public():
    routes = {"https://wiki.example.com/page": redirect("/login?next=/page")}
    assert (await refused("https://wiki.example.com/page", routes)).code == "not_public"


async def test_private_notion_page_is_not_public():
    # Notion answers a private (or missing) page with 404 to anonymous readers.
    routes = {NOTION_URL: httpx.Response(404, text="Not found")}
    assert (await refused(NOTION_URL, routes)).code == "not_public"


async def test_notion_app_shell_is_not_public():
    routes = {NOTION_URL: html(fixture("notion_shell.html"))}
    assert (await refused(NOTION_URL, routes)).code == "not_public"


async def test_missing_web_page():
    error = await refused("https://example.com/gone", {})
    assert error.code == "not_found"
    assert "not public" in str(error)


async def test_page_without_text():
    routes = {"https://example.com/empty": html("<html><body><script>x()</script></body></html>")}
    assert (await refused("https://example.com/empty", routes)).code == "empty"


# --- extraction ----------------------------------------------------------------------------


async def test_google_doc_through_the_public_export():
    export = f"https://docs.google.com/document/d/{GDOC_ID}/export?format=txt"
    content = (
        "https://doc-0k-0g-docstext.googleusercontent.com/export/abc/def/1792286475000/"
        f"114399244225648721090/*/{GDOC_ID}?format=txt"
    )
    routes = {
        export: httpx.Response(
            307, headers={"location": content, "content-type": "application/binary"}
        ),
        content: httpx.Response(
            200,
            content=fixture("gdoc_export.txt"),
            headers={
                "content-type": "text/plain; charset=utf-8",
                "content-disposition": (
                    'attachment; filename="PricingPageRefresh.txt"; '
                    "filename*=UTF-8''Pricing%20page%20refresh.txt"
                ),
            },
        ),
    }
    page = await fetch(f"https://docs.google.com/document/d/{GDOC_ID}/edit?usp=sharing", routes)
    assert page.kind == "google_docs"
    assert page.url == f"https://docs.google.com/document/d/{GDOC_ID}/edit?usp=sharing"
    assert page.final_url == content
    assert page.title == "Pricing page refresh"
    assert page.text.startswith("Pricing page refresh\n\nGoal: raise trial-to-paid conversion")
    assert "﻿" not in page.text and "\r" not in page.text
    assert page.content_type == "text/plain"
    assert page.last_modified is None  # the export does not say; freshness uses fetched_at
    assert page.fetched_at == NOW


async def test_google_doc_title_falls_back_to_its_first_line():
    export = f"https://docs.google.com/document/d/{GDOC_ID}/export?format=txt"
    routes = {
        export: httpx.Response(
            200, content=fixture("gdoc_export.txt"), headers={"content-type": "text/plain"}
        )
    }
    page = await fetch(f"https://docs.google.com/document/d/{GDOC_ID}/edit", routes)
    assert page.title == "Pricing page refresh"


def test_download_names():
    assert public_links._download_name('attachment; filename="Plan.txt"') == "Plan"
    assert (
        public_links._download_name(
            "attachment; filename=\"x.docx.txt\"; filename*=UTF-8''Q3%20plan.docx.txt"
        )
        == "Q3 plan"
    )
    assert public_links._download_name(None) is None


async def test_notion_public_page_from_its_html():
    routes = {NOTION_URL: html(fixture("notion_public.html"))}
    page = await fetch(NOTION_URL, routes)
    assert page.kind == "notion"
    assert page.title == "Onboarding research summary"
    assert page.text.startswith("We interviewed 24 new accounts in September")
    assert "17 of 24 asked for a guided setup" in page.text
    assert "Decision\nWe will build guided setup" in page.text
    assert "line-height" not in page.text and "__notion" not in page.text


async def test_notion_page_content_block_wins():
    body = (
        "<html><head><title>Plan | Notion</title></head><body><div class='sidebar'>Menu</div>"
        "<div class='notion-page-content'><p>The plan text.</p></div></body></html>"
    )
    page = await fetch(NOTION_URL, {NOTION_URL: html(body)})
    assert page.text == "The plan text."
    assert page.title == "Plan"


async def test_web_page_main_text_and_stated_last_change():
    url = "https://research.example.com/activation"
    page = await fetch(url, {url: html(fixture("web_article.html"))})
    assert page.kind == "web"
    assert page.title == "Why activation beats acquisition"
    assert page.text.startswith("Why activation beats acquisition\n\nTeams that fixed")
    assert "twice as fast" in page.text
    for chrome in ("Blog", "About", "Privacy", "Subscribe", "analytics", "display: none"):
        assert chrome not in page.text, chrome
    assert page.last_modified == datetime(2026, 9, 15, 10, 30, tzinfo=UTC)


async def test_last_modified_header_wins_and_future_dates_are_capped():
    url = "https://research.example.com/activation"
    stamp = {"last-modified": "Wed, 01 Oct 2026 08:00:00 GMT"}
    page = await fetch(url, {url: html(fixture("web_article.html"), **stamp)})
    assert page.last_modified == datetime(2026, 10, 1, 8, 0, tzinfo=UTC)

    future = html("<main><p>Soon</p></main>", **{"last-modified": "Fri, 01 Jan 2100 00:00:00 GMT"})
    page = await fetch("https://example.com/f", {"https://example.com/f": future})
    assert page.last_modified == NOW


async def test_json_ld_date_modified_and_body_fallback():
    body = (
        '<html><head><script type="application/ld+json">{"@graph": [{"@type": "Article",'
        ' "dateModified": "2026-08-01T00:00:00Z"}]}</script></head>'
        "<body><nav>Home</nav><div><p>Plain body text.</p></div></body></html>"
    )
    page = await fetch("https://example.com/p", {"https://example.com/p": html(body)})
    assert page.text == "Plain body text."
    assert page.title is None
    assert page.last_modified == datetime(2026, 8, 1, tzinfo=UTC)


async def test_description_when_the_page_has_no_text():
    body = (
        '<html><head><meta name="description" content="Only a summary."></head><body></body></html>'
    )
    page = await fetch("https://example.com/d", {"https://example.com/d": html(body)})
    assert page.text == "Only a summary."


async def test_plain_text_page_and_charset():
    url = "https://example.com/notes.txt"
    routes = {
        url: httpx.Response(
            200,
            content="Café notes\nline two".encode("latin-1"),
            headers={"content-type": "text/plain; charset=iso-8859-1"},
        )
    }
    page = await fetch(url, routes)
    assert page.text == "Café notes\nline two"
    assert page.title == "Café notes"
