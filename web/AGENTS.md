## web/ after the move off Next (#1581)

The app is a Vite single-page app: TanStack Router file routes under `app/` (`page.tsx` is a
route's page, `layout.tsx` its layout, `$name` a param, `__root.tsx` the root; `_`-prefixed and
other files are not routes, `lib/route-files.ts`). A route file exports only `Route`
(`app/route-files.test.ts`). Links and navigation come from `@/lib/nav` only. Production is
static `dist/` behind nginx (`nginx/`, `Dockerfile`). Design: `docs/vite-migration/`.
