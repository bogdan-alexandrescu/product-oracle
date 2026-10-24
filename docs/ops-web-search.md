# Web search for Oracle's agents (H7 Competitive digest)

Oracle's agents get the open web only through two of Oracle's own tools,
`search_web` (`POST /v1/web/search`) and `fetch_web_page` (`POST /v1/web/fetch`)
(`api/oracle/web/`). Only the monthly competitive digest's run token holds the
`read:web` scope they need. People, API tokens and MCP clients get 403 "Web search is
for Oracle's monthly digest".

## 1. The provider and its key

Q5 "Web search" (owner, 2026-10-23): Oracle holds a search API key, and the provider is
the Brave Search API. The owner creates the Brave Search API account and its key. Oracle
sends the key only to `api.search.brave.com`, in the `X-Subscription-Token` header. It
never writes the key to a log or a response, and never passes it to an agent.

The key goes in Secret Manager as `oracle-web-search-key`, mounted on the API service as
`ORACLE_WEB_SEARCH_KEY`:

```sh
printf '%s' "$BRAVE_KEY" | gcloud secrets create oracle-web-search-key \
  --project="$PROJECT" --data-file=-
gcloud run services update oracle-api --project="$PROJECT" --region="$REGION" \
  --update-secrets=ORACLE_WEB_SEARCH_KEY=oracle-web-search-key:latest
```

While the key is empty, or `ORACLE_WEB_SEARCH_PROVIDER=none`, `search_web` answers 503
`web_search_unconfigured`. Everything else keeps working, and the digest says web search
was not available. Removing the key turns web search off without a code change.

## 2. Caps

| Setting | Default | Beyond it |
|---|---|---|
| `ORACLE_WEB_SEARCH_MAX_PER_RUN` | 30 searches | 429 `web_cap_reached` |
| `ORACLE_WEB_FETCH_MAX_PER_RUN` | 40 page reads | 429 `web_cap_reached` |
| Company setting `web_searches_per_month` (owners, 0-2,000) | 200 | 429 `web_cap_reached`; 0 turns web search off |

The monthly count is taken from `web_searches` in the Company time zone's month. A search
that returns nothing still counts, because the provider bills the call. The provider's
bill is not part of a run's model estimate.

## 3. What a page read may reach

- Only a URL a search of the same run returned. Any other URL gets 403
  `not_from_this_run`, so a page's text cannot send the agent somewhere else.
- Reads go through `LinkFetcher`: https only, public addresses only (checked again on
  every connect and redirect), 20 s, 2 MB, HTML or plain text, with user agent
  `ProductOracleBot`.
- Before a page is read, Oracle reads the site's `robots.txt` and keeps it for 24 hours.
  If the file disallows the path for `ProductOracleBot` or `*`, the read gets 409
  `robots_disallowed`. If the file cannot be reached, nothing on that site is read until
  the next try.

## 4. Retention

`web_searches` and `web_results` are kept for 13 months. The run ticker then purges them
in its own step.
