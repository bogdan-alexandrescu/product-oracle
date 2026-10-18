Recorded public-link responses for `tests/test_public_links.py`.

The structure of each file was recorded on 2026-10-18 from live anonymous fetches
(with the fetcher's `ProductOracleBot` user agent); the page content was replaced
with made-up text so no third-party page is copied here.

- `notion_public.html`: a public `*.notion.site` page as Notion serves it to a
  link-preview bot: page metadata in `<head>`, styles, then the page as a bare
  `<body>` of paragraphs and lists.
- `notion_shell.html`: what Notion serves when it will not render a page for
  anonymous readers (generic "Notion" title and description, scripts only).
- `gdoc_export.txt`: the body of `docs.google.com/document/d/<id>/export?format=txt`
  after its 307 redirect to `*.googleusercontent.com` (UTF-8 with a BOM, CRLF lines).
  The response's `Content-Disposition` carries the title; the tests set it.
- `web_article.html`: a plain public web page with navigation, header, footer, a
  `<main>` article and `article:modified_time`.
