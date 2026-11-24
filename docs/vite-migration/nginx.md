# Vite migration: serving the web with nginx (phase 0)

Part of #1553; this is #1578. Design only: nothing here is installed or wired yet. The owner
chose nginx, as in ai-studio. After the move, `web/` builds to static files (`vite build` →
`web/dist`) and one nginx container serves them and proxies the API on the same origin, in
place of `next start` (the standalone `server.js` in `web/Dockerfile`).

## What nginx replaces

| Next today (`web/next.config.ts`) | nginx after the move |
|---|---|
| `rewrites()`: `/v1/*`, `/healthz`, `/uploads/*` to `API_INTERNAL_URL` | `proxy_pass` locations, same origin ([Proxy](#proxy-v1-uploads-healthz)) |
| `experimental.proxyTimeout: 120_000` (brief-answers: a 25 s model call plus saving) | `proxy_read_timeout 120s` on `/v1/` |
| `headers()`: the CSP on every page | `add_header Content-Security-Policy … always`, from one include ([CSP](#csp)) |
| `web/lib/redirects.ts` (4 redirects, applied by `web/proxy.ts`, #1580) | `return 308` / `return 307` locations ([table](#generated-from-nextconfigts)) |
| App Router pages, one HTML per route | SPA fallback to `index.html`; TanStack Router picks the route |
| `/_next/static/*` immutable chunks | `/assets/*` (Vite's hashed output), immutable; a missing one is a `no-store` 404 |
| `env` / `NEXT_PUBLIC_*` inlined at build | `VITE_*` inlined at build ([Env](#env-oracle_simple_mode-and-next_public_-to-vite_)) |
| `API_INTERNAL_URL` fixed at **build** time (rewrites are resolved then) | `API_INTERNAL_URL` read at **container start** (nginx template) |

## Generated from next.config.ts

Generated before the move (#1581) from `next.config.ts`, which is gone; `web/lib/redirects.test.ts`
and `web/lib/csp.test.ts` now keep `web/nginx/` in step with the app.

<!-- generated:next-config begin -->
| `lib/redirects.ts` from | Destination | Status | nginx |
|---|---|---|---|
| `/roadmap` | `/plan` | 308 | `location = /roadmap { return 308 /plan$is_args$args; }` |
| `/baseline/:path*` | `/ground-truth/:path*` | 308 | `location ~ ^/baseline(/.*)?$ { return 308 /ground-truth$1$is_args$args; }` |
| `/simple/prds/:doc` | `/simple/one-pagers/:doc` | 307 | `location ~ ^/simple/prds/([^/\x5c]+)/?$ { return 307 /simple/one-pagers/$1$is_args$args; }` |
| `/requests/new` | `/requests/to-decide` (no query: `/requests?compose=request`) | 307 | `location = /requests/new { if ($args = "") { return 307 /requests?compose=request; } return 307 /requests/to-decide$is_args$args; }` |

| Next `rewrites()` source | Upstream today | nginx |
|---|---|---|
| `/v1/:path*` | `http://api:8000/v1/:path*` | `location ^~ /v1/` → `proxy_pass ${API_INTERNAL_URL};` |
| `/healthz` | `http://api:8000/healthz` | `location = /healthz` → `proxy_pass ${API_INTERNAL_URL};` |
| `/uploads/:path*` | `http://api:8000/uploads/:path*` | `location ^~ /uploads/` → `proxy_pass ${API_INTERNAL_URL};` |

| CSP directive (production) | Value |
|---|---|
| `default-src` | `'self'` |
| `script-src` | `'self' 'unsafe-inline' https://apis.google.com https://accounts.google.com/gsi/` |
| `style-src` | `'self' 'unsafe-inline' https://accounts.google.com/gsi/style` |
| `img-src` | `'self' data: https://notion.so https://*.notion.so https://notion.site https://*.notion.site https://notion-static.com https://*.notion-static.com https://prod-files-secure.s3.us-west-2.amazonaws.com` |
| `font-src` | `'self' data:` |
| `frame-src` | `'self' https://docs.google.com https://accounts.google.com/gsi/` |
| `connect-src` | `'self' https://accounts.google.com/gsi/` |
| `object-src` | `'none'` |
| `base-uri` | `'self'` |
| `form-action` | `'self'` |
| `frame-ancestors` | `'self'` |
<!-- generated:next-config end -->

Notes on the rows:

- Next keeps the query string on a redirect; `$is_args$args` does the same.
- `/roadmap` is exact: `/roadmap/changelog` and `/roadmap/launches` are live pages and must
  not redirect.
- `/simple/prds/:doc` is 307 (not permanent), one segment only.
- Next's `/v1/:path*` also matches a bare `/v1`; nothing calls it (every client path is
  `/v1/<something>`), so `^~ /v1/` is enough.
- `^~` matters: nginx tries regex locations before plain prefixes, so without it the
  trailing-slash and redirect regexes below could catch an API path.
- Next also 308s a trailing slash away (`/plan/` → `/plan`); nginx keeps that with one regex
  location so old links behave the same.
- The redirects stay in the client router too (a `beforeLoad` redirect per row), so in-app
  links, `vite dev` and `vite preview` (the Playwright server, which has no nginx) agree
  with production. nginx answers first for a full page load.

## Proxy: /v1, /uploads, /healthz

- **Same origin.** The browser only ever talks to the web's origin; nginx forwards to the
  API. The session cookie (`oracle_session`, `path=/`, no `Domain`) stays a host-only
  cookie of that origin, so no CORS and no `proxy_cookie_domain`/`proxy_cookie_path`.
  `Set-Cookie` and `Cookie` pass through untouched (nginx does not strip them).
- **Path kept.** `proxy_pass http://api:8000;` with no URI part forwards `/v1/x?y` as is.
- **Streaming** (`web/lib/stream.ts` reads Live replies as server-sent events through
  `fetch` on `/v1/discussions/…/messages/…/stream`, `StreamingResponse` in
  `api/oracle/discussions/router.py`):
  - `proxy_buffering off` so each event reaches the browser as it is written;
  - `proxy_read_timeout 120s` and `proxy_send_timeout 120s` (Next's `proxyTimeout`);
  - `proxy_http_version 1.1` and `proxy_set_header Connection ""` (keep-alive upstream, no
    `close` mid-stream);
  - `gzip` stays off for `/v1/` (gzip would hold events back to fill a block); the API
    already sends compact JSON.
  Buffering is off for all of `/v1/`, as in ai-studio: simpler than matching the stream
  paths, and harmless for ordinary JSON.
- **Bodies.** nginx's default `client_max_body_size` (1 MiB) would break Sources uploads
  (`POST /v1/sources/{id}/uploads`: several files, up to 20 MiB each,
  `api/oracle/sources/uploads.py`). Set `client_max_body_size 100m` on `/v1/`; the API
  keeps its own per-file and per-body limits (`ORACLE_MAX_BODY_BYTES`, 413).
- **Headers to the API.** `Host $http_host`, `X-Forwarded-Host $http_host`,
  `X-Forwarded-For $proxy_add_x_forwarded_for`, `X-Forwarded-Proto $scheme`. The same-origin
  check of signed-in writes (`api/oracle/auth/deps.py`) reads `Host` and `X-Forwarded-Host`,
  port included, as Next sent them; `$host` drops the port, so `http://127.0.0.1:3000` would get
  a 403 on every write (#1609).
- **No API behind the image** (production, where the load balancer sends `/v1/*`,
  `/uploads/*` and `/healthz` to the API): `40-oracle-config.sh` answers `/v1/` and
  `/uploads/` with a 404, so a path the URL map misses is a loud 404, not `index.html` (#1708).
- **/uploads/** (company logos, served by the API to members): proxied with buffering on;
  the API sets its own cache headers.
- **/healthz**: proxied, so the container's health check proves nginx *and* the API answer.
- **Upstream at start-up.** The image's entrypoint renders `/etc/nginx/templates/*.template`
  with `envsubst`, so `API_INTERNAL_URL` is set per environment without a rebuild. No
  `resolver` directive: the name is resolved once at start (compose already starts `web`
  only after `api` is healthy).

## CSP

The production policy is the table above, sent on every response nginx makes (HTML,
assets, redirects, errors) with `always`. Because an `add_header` inside a `location`
drops every inherited one, the headers live in one `security-headers.conf` included in each
location that sets its own headers.

- Same directives as today: Google picker and sign-in hosts, Notion icon hosts, inline
  styles, `data:` images and fonts, `frame-ancestors 'self'`.
- `script-src 'unsafe-inline'` stays for parity (the theme script in `index.html`, and
  `@vitejs/plugin-react`'s refresh preamble in dev). Vite needs no inline bootstrap, so a
  later change can swap it for the theme script's hash; not in this move.
- Dev: `vite dev` sets the dev policy (adds `'unsafe-eval'` and `ws:` for hot reload)
  through `server.headers` in `createViteConfig`; nginx only ever serves production.
- `server_tokens off`; Next's `X-Powered-By` goes away with Next.

## SPA fallback and missing chunks

| Request | Served | Cache-Control |
|---|---|---|
| `/assets/<name>-<hash>.<ext>` that exists | the file | `public, max-age=31536000, immutable` |
| `/assets/…` that does not exist | `404`, empty body, **no** fallback | `no-store` |
| any other file that exists (`/icon.svg`, `/apple-icon.png`, from `web/public/`) | the file | none (nginx's `ETag` and `Last-Modified` revalidate) |
| any other path (`/plan`, `/s/<token>`, `/ground-truth/…`) | `/index.html` | `no-cache` |

- A missing chunk must not get `index.html`: the browser would run HTML as a module and fail
  with a MIME error instead of a clean 404. `no-store` keeps a browser or proxy from
  caching that 404 during a deploy, so the chunk loads once the new files are in place.
- `index.html` is `no-cache`, so a deploy is picked up on the next load; the hashed assets
  it names are immutable.
- In the app, a `vite:preloadError` listener reloads the page once when a chunk from an
  older deploy is gone (phase 1 code; noted here because it pairs with the `no-store` 404).
- Unknown routes are the router's not-found page (today's `app/not-found.tsx`), shown with
  status 200 from the fallback; a real 404 status for unknown pages would need a route list
  in nginx and is not worth it.
- gzip on for `text/html`, `text/css`, `application/javascript`, `application/json`,
  `image/svg+xml` (static files only, not `/v1/`).

## Env: ORACLE_SIMPLE_MODE and NEXT_PUBLIC_* to VITE_*

Vite inlines only `VITE_*` variables, as `import.meta.env.VITE_*`, at build time
(`envPrefix` stays the default). Node-side code (Playwright configs and specs, scripts)
keeps `process.env`.

| Today | Read in | After the move |
|---|---|---|
| `NEXT_PUBLIC_API_MOCKS=1` | `lib/api/client.ts` (`MOCK_MODE`), `lib/google-picker-mock.ts`, `next.config.ts`, `package.json` scripts, `e2e/ci.env`, Playwright configs | `VITE_API_MOCKS=1`; the mock build is `vite build --mode mock` with `web/.env.mock` holding it, so scripts and `e2e/ci.env` stop passing it by hand |
| `NEXT_PUBLIC_ORACLE_SIMPLE_MODE=1` | `lib/simple-mode.ts` (`SIMPLE_MODE`, also on whenever `MOCK_MODE` is) | `VITE_ORACLE_SIMPLE_MODE=1` |
| `ORACLE_SIMPLE_MODE` (copied into the web by `next.config.ts` `env`; on in the mock build) | only `next.config.ts` now (`app/simple/_flag.ts` re-exports `lib/simple-mode`) | dropped from the web: `VITE_ORACLE_SIMPLE_MODE` is the one web flag. The API's `ORACLE_SIMPLE_MODE` (`simple_mode` in `/v1/auth/me`) is unchanged |
| `API_INTERNAL_URL` (build arg) | `next.config.ts` rewrites, `web/Dockerfile` | nginx template variable at container start; `createViteConfig` reads it for the dev proxy (default `http://localhost:8000`) |
| `NEXT_DIST_DIR` (`.next-mock`, `.next-e2e`, …) | `next.config.ts`, Playwright configs, `tsconfig.json` includes | `vite build --outDir dist-mock` (etc.); the `.next-*` includes leave `tsconfig.json` |
| `process.env.NODE_ENV` | `next.config.ts` (dev CSP) | `import.meta.env.DEV` / `PROD`, or the `command` passed to `createViteConfig` |
| `NEXT_TELEMETRY_DISABLED`, `HOSTNAME` | `web/Dockerfile` | dropped |

A `web/env.d.ts` declares `ImportMetaEnv` with the two `VITE_*` flags so `tsc` checks them.

## createViteConfig

ai-studio's `createViteConfig` (PR #2071) is the model: one function returning the Vite
config for dev, build and preview. For Oracle it holds:

- plugins: `tanstackRouter({ target: "react", autoCodeSplitting: true })` **before**
  `react()`, then `tailwindcss()` (`@tailwindcss/vite`, replacing `@tailwindcss/turbopack`);
- `resolve.alias`: `@` → `web/` (today's `paths` in `tsconfig.json`);
- `server.proxy` and `preview.proxy`: `/v1`, `/uploads`, `/healthz` to `API_INTERNAL_URL`
  with `timeout`/`proxyTimeout` 120 000 ms (the same streaming budget as nginx); none in
  mock mode;
- `server.headers` / `preview.headers`: the dev or production CSP, built from the same
  directive list that nginx's `security-headers.conf` is generated from, so the two cannot
  drift;
- `build.outDir` from the mode (`dist`, `dist-mock`, `dist-e2e`), `build.assetsDir: "assets"`.

## The nginx config

Built in `web/nginx/`: `default.conf.template` (rendered to `/etc/nginx/conf.d/default.conf`
by `40-oracle-config.sh` at container start), `api-proxy.conf.template` and
`security-headers.conf`. Read those files; `lib/nginx-config.test.ts` and
`lib/redirects.test.ts` check them. What they fix from the first draft (#1609):

- `absolute_redirect off`: a redirect's `Location` is the path alone. Without it nginx adds
  the scheme and its listen port, sending people behind the TLS load balancer to
  `http://<host>:3000/...`.
- `if ($uri ~ "[\x00-\x1f\x7f]") { return 400; }` before any location: the regex redirects
  copy part of the decoded path into `Location`, and nginx refuses only `%00`, so
  `%0D%0A` would split the response.
- A captured segment excludes `\` (`[^/\x5c]`), and the trailing-slash rule needs a second
  character that is neither `/` nor `\`: once redirects are relative, `/%5Cevil.com/` would
  answer `Location: /\evil.com`, which browsers read as `//evil.com`.
- `/i/<token>` and `/s/<token>` (interview and share pages) get `Referrer-Policy: no-referrer`
  and `X-Robots-Tag: noindex, nofollow` with the app shell, before any script runs.
- `X-Forwarded-Host $http_host` to the API (Headers to the API, above).

`root` + `try_files` only, never `alias` (two 2026 nginx advisories, CVE-2026-125283 and
CVE-2026-15176, are about `alias` with `try_files`/`rewrite`). No HTTP/2, HTTP/3, `resolver`,
`stream` or `mail` modules are used: TLS ends in front of the container, as it does for
`next start` today.

### Image

```dockerfile
FROM node:24-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build                      # vite build → dist/

FROM nginx:<version>-alpine-slim       # pinned by digest; see dependencies.md
COPY nginx/security-headers.conf /etc/nginx/security-headers.conf
COPY nginx/default.conf.template /etc/nginx/templates/default.conf.template
COPY --from=build /app/dist /usr/share/nginx/html
ENV API_INTERNAL_URL=http://api:8000
EXPOSE 3000
```

`docker-compose.yml` keeps `ports: 3000:3000`; the `API_INTERNAL_URL` build arg becomes an
`environment:` entry. Check in phase 1 that the slim image's entrypoint still renders
templates (`20-envsubst-on-templates.sh`); if not, use the non-slim `-alpine` tag.

## Phase 1 checks (when code moves)

- `nginx -t` in the built image; `curl -N` a Live reply stream through nginx and see events
  arrive one by one; a reply longer than 30 s completes.
- Each row of the generated table: `curl -sI` shows the status, `Location` and query.
- `curl -sI /assets/missing.js` → `404` with `Cache-Control: no-store` and the CSP;
  `/plan` → `index.html` with `no-cache`; `/v1/auth/me` keeps the session cookie after
  sign-in.
- A mock-backed Playwright spec for each redirect through the client router (the
  Playwright server is `vite preview`, without nginx).
