# Vite migration: dependency research (phase 0)

Part of #1553; this is #1578. Nothing is installed: this is the research the owner gives the
go on before phase 1 adds any package. Gathered on Nov 20, 2026 from the npm registry, the
npm download counts, the GitHub advisory database (npm's bulk advisory endpoint, every
published version of each package) and `npm audit` on a scratch lockfile resolved outside
the repository.

**The 14-day rule.** Every version below was published on or before Nov 6, 2026. The whole
tree was resolved with `npm install --package-lock-only --ignore-scripts
--before=2026-11-06T09:00:00Z`, so transitive packages obey it too; phase 1 installs the
same way (`npm install --before=…`) and commits the lockfile.

## Direct packages the move adds

| Package | Pin | Published | Newest (date) | Licence | Downloads a week | Maintainers | Unpacked | Role |
|---|---|---|---|---|---|---|---|---|
| `vite` | 8.3.6 | Nov 5, 2026 | 8.3.8 (Nov 11) | MIT | 288.6 M | 2 (Vite team, VoidZero) | 2.4 MB | dev server and build (bundles with Rolldown) |
| `@vitejs/plugin-react` | 6.2.1 | Nov 2, 2026 | 6.3.0 (Nov 9) | MIT | 141.9 M | 2 (Vite team) | 47 kB | JSX and React Refresh in dev |
| `@tanstack/react-router` | 1.170.46 | Oct 22, 2026 | same | MIT | 28.2 M | 3 (TanStack) | 1.1 MB | the router: replaces the App Router (runtime) |
| `@tanstack/router-plugin` | 1.168.48 | Oct 22, 2026 | 1.169.0 (Nov 8) | MIT | 22.3 M | 3 (TanStack) | 717 kB | file routes → `routeTree.gen.ts`, code splitting |
| `@tailwindcss/vite` | 4.3.4 | Nov 2, 2026 | 4.3.5 (Nov 6, after the cut) | MIT | 69.5 M | 3 (Tailwind Labs) | 12 kB | replaces `@tailwindcss/turbopack` |

- Peers line up: `@vitejs/plugin-react` 6 wants `vite ^8`; `@tanstack/router-plugin`
  1.168.48 wants `@tanstack/react-router ^1.170.46` and any Vite 5 to 8; `@tailwindcss/vite`
  takes Vite 5 to 8. `react` stays 19.3.0, `typescript` 5.9.3.
- Engines: Vite 8 and the plugin need Node `^20.19 || >=22.12`; TanStack `>=20.19`. The
  Dockerfile's `node:24-alpine` and CI's Node 24 qualify. Vite's `@types/node` peer
  (`^20.19.0 || >=22.12.0`) is met by today's 20.19.43.
- `tailwindcss` moves 4.3.3 → 4.3.4 with it (the Vite plugin pins its own core).
- Pin exact versions (no `^`): TanStack Router ships several releases a week.

### Not added

- **TanStack Query**: `web/lib/use-query.ts` already does what the pages need.
- `@tanstack/react-router-devtools`, `vite-tsconfig-paths` (one `resolve.alias` line does
  it), `@fontsource/*` (fonts are vendored, below), `esbuild` / `terser` (Vite 8 minifies
  with Rolldown and Oxc), any SSR or `@tanstack/react-start` package (the app stays a SPA).

## Lint after eslint-config-next

`eslint-config-next` goes with Next. Its rules come from packages that are **already in
today's lockfile** (pulled in by `eslint-config-next`), so keeping them adds nothing new;
they only become direct `devDependencies`:

| Package | Pin | Today in the tree | Keeps |
|---|---|---|---|
| `typescript-eslint` | 8.72.1 (Oct 26) | 8.71.2 | the TypeScript rules (`eslint-config-next/typescript`) |
| `eslint-plugin-react-hooks` | 7.1.1 (Apr 17) | 7.1.1 | rules of hooks, exhaustive deps |
| `eslint-plugin-react` | 7.37.5 | 7.37.5 | the React rules in `core-web-vitals` |
| `eslint-plugin-jsx-a11y` | 6.10.2 | 6.10.2 | the accessibility rules in `core-web-vitals` |
| `@eslint/js` | 9.39.5 | 9.39.5 | `recommended` |
| `globals` | 17.14.0 (Nov 1) | 14.0.0 / 16.4.0 | browser globals |

Dropped: `@next/eslint-plugin-next` (Next-only rules, e.g. `no-html-link-for-pages`) and
`eslint-plugin-import` with its two resolvers (`tsc` already fails on an unresolved
import). The repo's own rules in `web/eslint.config.mjs` (no `alert`/`confirm`, dates
through `lib/dates.ts`) carry over unchanged.

## Fonts without next/font

Done in #1580, still on Next: Inter Tight (latin, variable) and DM Mono (latin, 400 and 500)
are committed `woff2` files (SIL Open Font Licence 1.1, which allows bundling) under
`web/public/fonts/`, with `@font-face` rules in `app/globals.css` setting the same
`--font-inter-tight` / `--font-dm-mono` variables, `font-display: swap` and the metric-matched
Arial fallbacks next/font made; `app/layout.tsx` preloads them. No package. Under Vite they
can move to `web/fonts/` so Vite hashes them into `/assets/` (served immutable).

## The whole tree

`npm audit` / lockfile counts, today vs after (scratch lockfile, `--before` the cut):

| | Today (`web/package-lock.json`) | After the move |
|---|---|---|
| Packages | 464 | 415 |
| Runtime (`dependencies`) | 22 | 16 |
| Advisories (`npm audit`) | 7 moderate | 7 moderate (the same ones) |

- **Removed: 150** package versions, among them `next` (192 MB unpacked), its compiler
  `@next/swc-*` (about 100 MB for the one platform installed), `sharp` / `@img/*` (image
  optimisation, about 19 MB), `eslint-config-next`, `eslint-plugin-import` and the
  `@unrs/resolver-binding-*` set.
- **New: 45** package names, 16 of them optional per-platform binaries (one installs: 15
  `@rolldown/binding-*` and `fsevents` on macOS). The 29 others:

| Package | Version | Published | Licence | Unpacked | Ships in |
|---|---|---|---|---|---|
| `@oxc-project/types` | 0.156.0 | 2026-10-27 | MIT | 45 kB | build only |
| `@rolldown/pluginutils` | 1.0.1 | 2026-05-13 | MIT | 26 kB | build only |
| `@tailwindcss/vite` | 4.3.4 | 2026-11-02 | MIT | 12 kB | build only |
| `@tanstack/history` | 1.162.5 | 2026-10-10 | MIT | 128 kB | runtime |
| `@tanstack/react-router` | 1.170.46 | 2026-10-22 | MIT | 1073 kB | runtime |
| `@tanstack/react-store` | 0.11.2 | 2026-09-29 | MIT | 64 kB | runtime |
| `@tanstack/router-core` | 1.171.39 | 2026-10-22 | MIT | 3077 kB | runtime |
| `@tanstack/router-generator` | 1.167.46 | 2026-10-22 | MIT | 936 kB | build only |
| `@tanstack/router-plugin` | 1.168.48 | 2026-10-22 | MIT | 717 kB | build only |
| `@tanstack/router-utils` | 1.162.4 | 2026-10-14 | MIT | 220 kB | build only |
| `@tanstack/store` | 0.11.2 | 2026-09-29 | MIT | 124 kB | runtime |
| `@tanstack/virtual-file-routes` | 1.162.0 | 2026-05-15 | MIT | 33 kB | build only |
| `@vitejs/plugin-react` | 6.2.1 | 2026-11-02 | MIT | 47 kB | build only |
| `ansis` | 4.5.0 | 2026-11-01 | ISC | 6 kB | build only |
| `babel-dead-code-elimination` | 1.0.12 | 2026-01-13 | MIT | 35 kB | build only |
| `chokidar` | 5.0.0 | 2025-11-25 | MIT | 82 kB | build only |
| `cookie-es` | 3.1.1 | 2026-03-27 | MIT | 29 kB | runtime |
| `diff` | 9.0.0 | 2026-04-13 | BSD-3-Clause | 616 kB | build only |
| `isbot` | 5.2.2 | 2026-08-27 | Unlicense | 49 kB | runtime |
| `pathe` | 2.0.3 | 2025-02-11 | MIT | 51 kB | build only |
| `prettier` | 3.9.10 | 2026-10-10 | MIT | 9959 kB | build only |
| `readdirp` | 5.1.1 | 2026-08-06 | MIT | 27 kB | build only |
| `rolldown` | 1.2.16 | 2026-10-29 | MIT | 885 kB | build only |
| `seroval` | 1.7.7 | 2026-11-02 | MIT | 611 kB | runtime |
| `seroval-plugins` | 1.7.7 | 2026-11-02 | MIT | 118 kB | runtime |
| `unplugin` | 3.7.0 | 2026-10-28 | MIT | 92 kB | build only |
| `use-sync-external-store` | 1.7.0 | 2026-09-09 | MIT | 28 kB | runtime |
| `vite` | 8.3.6 | 2026-11-05 | MIT | 2378 kB | build only |
| `webpack-virtual-modules` | 0.6.2 | 2024-06-04 | MIT | 46 kB | build only |

- "runtime" is a dependency of `@tanstack/react-router`; only what the app imports reaches
  the browser bundle. `seroval`, `cookie-es` and `isbot` serve server rendering, which a SPA
  does not use, so they should tree-shake away; phase 1 measures the gzip size of the
  bundle against today's Next client runtime and writes it in its PR.
- "build only": none of it is in the image nginx serves (the image holds `dist/` only).
  The largest is `prettier` (10 MB): `@tanstack/router-generator` formats
  `routeTree.gen.ts` with it. The Rolldown binary for linux-x64 is 21 MB.
- **Bumped** (already present, newer version): `tailwindcss`, `@tailwindcss/node`,
  `@tailwindcss/oxide*` 4.3.3 → 4.3.4; `lightningcss*` 1.32.0 → 1.33.0; `postcss` 8.5.32;
  `magic-string` 1.4.5; `typescript-eslint` and `@typescript-eslint/*` 8.71.2 → 8.72.1;
  `globals` 17.14.0; `ignore` 7.0.14; `semver` 7.8.6.
- **Licences**: MIT throughout, except `ansis` and `semver` (ISC), `diff` (BSD-3-Clause),
  `isbot` (Unlicense) and `lightningcss` (MPL-2.0, already in today's tree through
  Tailwind). All permissive; none is copyleft for our code.

## Advisories

- **Open today, unchanged by the move**: the 7 moderate findings are one advisory,
  `minimatch` GHSA-g3hv-75wg-m249 (denial of service through brace patterns), reached
  through `typescript-eslint` ≤ 8.72.2. It is in today's tree already, is lint-only (never in
  the image or the browser) and is fixed in `typescript-eslint` 8.73.0, published Nov 16:
  take it in the first dependency bump after Nov 30 (14 days).
- **vite**: 29 advisories over its history, nearly all about the **dev server** (files
  outside `server.fs.allow` served, `launch-editor` on Windows, cross-origin requests to the
  dev server). The latest affect 8.3.0–8.3.2 and are fixed by 8.3.3; **8.3.6 has none**.
  Production serving is nginx, so the dev server never faces the internet; keep
  `server.host` at its default (localhost) and bump Vite promptly. This is the main reason
  to keep Vite current.
- **seroval** (via `@tanstack/router-core`): 13 advisories against its
  `fromJSON` deserializer (prototype pollution, code execution, denial of service), all
  fixed by 1.6.11; **1.7.7 has none**. A SPA never deserializes server-sent seroval data,
  and the code should tree-shake out (see above).
- **diff**: old advisories only (< 8.0.3); 9.0.0 has none.
- **None ever** for `@vitejs/plugin-react`, every `@tanstack/*` package, `@tailwindcss/vite`,
  `rolldown`, `unplugin`, `prettier`, `chokidar`, `readdirp`, `cookie-es`, `isbot`,
  `use-sync-external-store`, `webpack-virtual-modules`, `pathe`, `ansis`,
  `babel-dead-code-elimination` or `@oxc-project/types`.

## Maintenance

- **Vite**: the Vite team with VoidZero's backing; releases every week or two (8.3.8 on
  Nov 11, 8.4.0 in beta), security fixes back-ported to the last majors. 289 M downloads a
  week.
- **TanStack Router**: TanStack (Tanner Linsley and team); several releases a week, one
  major (1.x) since 2023. 28 M downloads a week. The fast cadence is why the pins are exact
  and bumped together (`react-router`, `router-plugin`, `router-core`, `router-generator`
  move in step: the plugin's peer range names the router's exact patch).
- **Tailwind Vite plugin**: same repo and release train as `tailwindcss` itself.
- **Rolldown** (Vite 8's bundler): VoidZero; weekly releases (1.2.16 is pulled in by Vite 8.3.6).

## nginx image

The design (`docs/vite-migration/nginx.md`) adds the official `nginx` image, `-alpine-slim`
variant (about 6 MB compressed). Licence: BSD-2-Clause (nginx), image built by Docker
Official Images. Maintained by F5/NGINX: stable 1.30.x and mainline 1.31.x, patch releases
every few weeks.

| Tag | Released | Note |
|---|---|---|
| `1.30.5-alpine-slim` | Sep 23, 2026 | newest stable that meets the 14-day rule; **vulnerable** to every 2026 advisory fixed in 1.30.6 and 1.30.7 |
| `1.30.6-alpine-slim` | Nov 10, 2026 (10 days) | fixes 5 advisories, among them a buffer overflow in script evaluation (CVE-2026-93479) |
| `1.30.7-alpine-slim` | Nov 18–19, 2026 (2 days) | fixes 9 more, among them a major HTTP/2 flow-control memory corruption (CVE-2026-123007) and `alias` + `try_files` overflow (CVE-2026-125283) |
| `1.31.9-alpine-slim` | Nov 18, 2026 | mainline; not recommended for production |

The 14-day rule and nginx's security releases conflict here: the only version that meets
the rule carries known memory-safety bugs in features the config uses (variables, script
evaluation). Recommended: **1.30.7-alpine-slim pinned by digest**
(`sha256:8c950211a641ec5b23f265450517001f6bcca533666120ebe36cb4cff3d00a55` as of Nov 20)
as a security exception, then follow the stable patch releases. The config avoids the
affected areas anyway (no `alias`, no HTTP/2 or HTTP/3, no `resolver`, `stream` or `mail`).
This is the owner's call (asked in this lane's questions).

## Proposed package.json (phase 1)

```jsonc
"dependencies": {
  "@tanstack/react-router": "1.170.46",
  "openapi-fetch": "^0.17.0",
  "react": "19.3.0",
  "react-dom": "19.3.0"
  // "next" removed
},
"devDependencies": {
  "@eslint/js": "9.39.5",
  "@playwright/test": "1.64.1",
  "@tailwindcss/vite": "4.3.4",           // replaces @tailwindcss/turbopack
  "@tanstack/router-plugin": "1.168.48",
  "@types/node": "^20",
  "@types/react": "^19",
  "@types/react-dom": "^19",
  "@vitejs/plugin-react": "6.2.1",
  "eslint": "^9",
  "eslint-plugin-jsx-a11y": "6.10.2",
  "eslint-plugin-react": "7.37.5",
  "eslint-plugin-react-hooks": "7.1.1",
  "globals": "17.14.0",
  "openapi-typescript": "^7.13.0",
  "tailwindcss": "^4",
  "typescript": "^5",
  "typescript-eslint": "8.72.1",
  "vite": "8.3.6"
  // "eslint-config-next" removed
}
```

Re-run the checks the day phase 1 installs: newer patches may then be 14 days old, and
`npm audit` must show nothing beyond the `minimatch` finding above (or nothing at all once
`typescript-eslint` 8.73.0 qualifies).
