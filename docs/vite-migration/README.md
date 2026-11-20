# Vite migration

Moving `web/` from Next.js to Vite, TanStack Router and nginx (#1553), as ai-studio did.

## Phase 0 (#1578): design and research, no code

- [nginx.md](nginx.md): how nginx serves the built app: the `/v1`, `/uploads` and
  `/healthz` proxy (streaming, 120 s, same-origin session cookie), the CSP and the 4
  redirects in a table generated from `web/next.config.ts`, the SPA fallback with a
  `no-store` 404 for a missing chunk, `NEXT_PUBLIC_*` / `ORACLE_SIMPLE_MODE` → `VITE_*`,
  `createViteConfig`, and a draft nginx config and image.
- [dependencies.md](dependencies.md): every package the move adds or drops, with
  advisories, maintenance, size, licence and versions at least 14 days old; the nginx image.
- [next-config-tables.mjs](next-config-tables.mjs): regenerates the tables in nginx.md
  from `next.config.ts` (`node docs/vite-migration/next-config-tables.mjs --write`).

Open for the owner (also in the lane's questions):

1. nginx 1.30.7 (2 days old, fixes major advisories) as an exception to the 14-day rule,
   or 1.30.5 (meets the rule, vulnerable).
2. Lint: keep `eslint-plugin-react` and `eslint-plugin-jsx-a11y` (already in the tree) when
   `eslint-config-next` goes; drop the Next and import plugins.
3. Fonts: vendor the Inter Tight and DM Mono `woff2` files rather than add `@fontsource`.

ai-studio's #1786 and PR #2071 (its nginx config and `createViteConfig`) were not reachable
from this lane (GitHub answers 404 without access); the design follows what the issue asks for. Phase 1 diffs the
draft against ai-studio's files before copying.

## Later phases

Phase 1 installs the packages (`npm install --before=…`, after the owner's go), adds
`createViteConfig`, the nginx files and the image, and moves routes from `app/` to
TanStack file routes; the Playwright suites build with `vite build --mode mock` and serve
with `vite preview`.
