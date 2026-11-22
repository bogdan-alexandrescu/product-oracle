# web/

Rules for work under `web/`. The root `CLAUDE.md` router and `.claude/rules/oracle-product.md`
still apply; the commands are in `docs/agents/lane-rules.md` (Building a lane, Browser lanes).

@AGENTS.md

- Every user-facing change has a mock-backed Playwright spec in `e2e/` that drives the UI as
  a person would and fails without the change. Import `test` from `e2e/test.ts` (it pins the
  mock clock). A spec that measures elapsed time is tagged `@timing`
  (`scripts/check-timing-tags.mjs`).
- The mock API (`lib/api/mock`) matches the real API for every route and field a page reads.
  `lib/api/openapi.json` and `lib/api/schema.d.ts` are generated (`make openapi`); never edit
  or read them whole.
- Checks: `npx tsc --noEmit -p .` and `npx vite build` (Vite does not type-check), then `npm run lint`, then
  `npm run format:check` (Prettier; `npm run format` writes it).
- Unit tests (Vitest, `npm run test:unit`): pure logic in `*.test.ts` beside its module, a render
  test (happy-dom, Testing Library) in `*.test.tsx` beside its component. Playwright keeps the
  flows a person drives; a spec that only calls a module, with no page, is a unit test. A test with a
  wall-clock budget goes in `*.timing.test.ts`, tagged @timing; `npm run test:timing` runs those alone.
- Playwright: `--reporter=line`, trace off, `rm -rf test-results` between runs; it builds the
  mock app itself. Port from `E2E_PORT`.
- No new visible prose: the prose guard (`e2e/prose-guard.spec.ts`) counts it against
  `e2e/prose-ceilings.json`, whose ceilings only go down and are never edited by hand.
- Text sizes are the type scale's steps (`text-xs` to `text-4xl`, `app/globals.css` @theme); an arbitrary
  `text-[Npx]` fails lint (#1589).
- Roles go through `can()` or an item's own `can_*` field only; never compare role names.
- Dates read month first ("Oct 31", "Oct 30, 2026, 2:49 PM PDT"), never ISO. A feature shows
  its code with its name.
- Simple pages keep the owner's picked mock-up designs; every feature anywhere opens the same
  feature panel (`.claude/rules/oracle-product.md`).
- No new dependency (package, tool, Action or image) without the owner's go.
- `lib/api/mock/server.ts` (about 10k lines) and the other large mock files are read by range
  (`.claude/rules/large-files.md`). Exact edits: `scripts/replace.mjs`; planted defects:
  `scripts/mutate.mjs`.
