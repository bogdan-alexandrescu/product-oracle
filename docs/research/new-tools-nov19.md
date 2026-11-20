# New tools for the Nov 19 audit issues

Research for the owner's go, per the dependency rule: nothing here is installed yet. One section per
tool: what it is for, advisories, maintenance, size, licence, the exact version proposed and the plan.

Gathered on Nov 20, 2026. "At least 14 days old" means published on or before Nov 6, 2026.
Sources: the npm registry (`npm view`), PyPI's JSON API, GitHub releases, the OSV API
(`api.osv.dev/v1/query`, by package and by the proposed version) and `npm audit`. Install counts come
from `npm install --package-lock-only --min-release-age=14 --save-exact` in a scratch folder (resolves a
lockfile, installs nothing), compared with today's `web/package-lock.json`.

| Issue | Tool | Proposed version | Published | Licence |
| --- | --- | --- | --- | --- |
| #1557, #1568 | pyright (npm) | 1.1.414 | Sep 9, 2026 | MIT |
| #1557 | typescript-language-server | 6.0.3 | Nov 2, 2026 | Apache-2.0 |
| #1560 | CodeRabbit CLI | 0.9.2 | Oct 31, 2026 | Proprietary |
| #1566 | OSV-Scanner (binary) | 2.7.0 | Oct 12, 2026 | Apache-2.0 |
| #1566 | google/osv-scanner-action | v2.7.0 (`b1d267aea5211fa648d9d442fa64b90dbdcbdd36`) | Oct 12, 2026 | Apache-2.0 |
| #1567 | pytest-cov | 7.1.0 | Mar 21, 2026 | MIT |
| #1567 | coverage (pulled in by pytest-cov) | 7.17.2 | Nov 4, 2026 | Apache-2.0 |
| #1583 | vitest | 5.1.0 | Nov 2, 2026 | MIT |
| #1583 | vite (vitest's peer) | 8.3.6 | Nov 5, 2026 | MIT |
| #1583 | @vitejs/plugin-react | 6.2.1 | Nov 2, 2026 | MIT |
| #1583 | happy-dom | 21.0.4 | Oct 20, 2026 | MIT |
| #1583 | @testing-library/react | 16.3.3 | Aug 27, 2026 | MIT |
| #1583 | @testing-library/dom | 10.4.2 | Sep 13, 2026 | MIT |
| #1583 | @testing-library/jest-dom | 7.0.1 | Aug 9, 2026 | MIT |
| #1583 | @testing-library/user-event | 14.6.8 | Oct 13, 2026 | MIT |
| #1584 | prettier | 3.9.10 | Oct 10, 2026 | MIT |
| #1585 | eslint-plugin-import-x | 4.17.1 | Jun 28, 2026 | MIT |
| #1585 | eslint-import-resolver-typescript | 4.4.5 | Jun 1, 2026 | ISC |
| #1585 | eslint-plugin-unused-imports | 4.4.1 | Feb 9, 2026 | MIT |
| #1585 | eslint-plugin-sonarjs | 4.2.2 | Sep 28, 2026 | LGPL-3.0-only |
| #1585 | eslint-plugin-testing-library | 7.16.2 | Mar 24, 2026 | MIT |
| #1585 | typescript-eslint (already in the lockfile) | 8.71.2 | already locked | MIT |

Every version above is the newest stable release that is at least 14 days old. A newer release
exists for typescript-language-server (6.1.0), CodeRabbit CLI (0.9.6), OSV-Scanner (2.7.1),
coverage (7.17.3), vitest (5.1.1), vite (8.3.8), @vitejs/plugin-react (6.3.0), jest-dom (8.0.0),
user-event (14.6.13), prettier (3.10.1) and import-x (4.18.1). None of these fixes an advisory that
affects the proposed version, except as noted under ESLint.

## The 14-day release age needs no new tool (#1566)

Both package managers we already use can enforce it:

- npm 11.19 (the one on Node 24) has `min-release-age` (days). `web/.npmrc`:
  `save-exact=true` and `min-release-age=14`. `min-release-age-exclude` lists packages that may skip
  it, for an urgent security fix.
- uv 0.12 takes a duration for `exclude-newer`: `[tool.uv] exclude-newer = "14 days"` in the root
  `pyproject.toml`. `exclude-newer-package` lets one package skip it.

Pinning exactly: the web's 9 `^` ranges become the versions in today's lockfile; the api's `>=`
ranges become `==` the versions in today's `uv.lock`. No version changes, so no lockfile churn.

## pyright (#1557 LSP, #1568 type check)

- **For**: the Python type checker (#1568, basic mode on `api/oracle` with a baseline) and the
  Python language server agents use to find a symbol's uses (#1557).
- **Advisories**: none in OSV for the npm or the PyPI package.
- **Maintenance**: Microsoft; 7 releases in the last 12 months; the repo had commits this week.
- **Size**: 19.5 MB unpacked, 1 dependency (fsevents, macOS only). 3 packages in all with
  typescript-language-server.
- **Licence**: MIT.
- **Version**: npm `pyright@1.1.414` (Sep 9, 2026; the newest release).
- **Which package**: the npm one, as a web devDependency. It is in `package-lock.json`, so the OSV
  scan and `min-release-age` cover it. The PyPI `pyright` package is only a wrapper that downloads
  the npm package on first run, outside any lockfile.
- **Plan**: add it to `web` devDependencies. #1568: `pyrightconfig.json` at the repo root
  (`include: ["api/oracle"]`, `typeCheckingMode: "basic"`, the api's `.venv`), a CI step
  `npm --prefix web exec -- pyright --outputjson`, and a script that compares the errors with a
  committed baseline file (file, rule, message; no line numbers) so that only new errors fail and
  the baseline only shrinks. #1557: the code-intel plugin starts the same binary
  (`pyright-langserver --stdio`).

## typescript-language-server (#1557)

- **For**: the TypeScript language server agents use instead of grep. It drives the `typescript`
  package the web already has (5.9.3).
- **Advisories**: none in OSV.
- **Maintenance**: 7 releases in the last 12 months, 3 maintainers.
- **Size**: 2.4 MB unpacked, no dependencies.
- **Licence**: Apache-2.0.
- **Version**: 6.0.3 (Nov 2, 2026). Needs Node 22.22.2 or later; we run Node 24.
- **Plan**: `make agent-setup` runs `npm ci` for a small `.agent-tools/package.json` (gitignored
  install, committed lockfile) holding exactly this package, or adds it to `web` devDependencies
  if the owner prefers one lockfile. It also keeps generated files (such as `web/lib/api/openapi.json` and `schema.d.ts`) out of local
  `git diff` with a local diff driver, and sets `git config merge.stat false` (the diffstat `git pull` prints). The SessionStart hook in `.claude/settings.json` runs a check that prints one line
  asking for `make agent-setup` when a binary is missing; it never installs by itself. The
  code-intel plugin under `tools/claude-plugins/code-intel` is our own files, not a dependency.

## CodeRabbit CLI (#1560)

- **Is CodeRabbit enabled here?** It seems not: the last few merged pull requests (#1500, #1530,
  #1540, #1549) have no comment or review from a CodeRabbit account, and the repo has no
  `.coderabbit.yaml`. The issue says to close it in that case. This is the owner's call; see
  `questions.json`.
- **For**: a local review of a diff before the pull request, with a script that reads the CLI's
  output and reports one of four states: reviewed, did not review, reviewed nothing applicable,
  reviewed incompletely (the CLI can print an `error` line and still exit 0).
- **Advisories**: none found (not in OSV; it is not on a public package registry).
- **Maintenance**: frequent releases (0.9.0 on Oct 8 to 0.9.6 on Nov 19). The installer checks a
  signed SHA256SUMS before unpacking.
- **Size**: 53 MB zip for linux-x64.
- **Licence**: proprietary (CodeRabbit's terms); it needs a CodeRabbit account and sends the diff
  to CodeRabbit's service.
- **Version**: 0.9.2 (uploaded Oct 31, 2026), installed with
  `CODERABBIT_VERSION=0.9.2` and the official installer.
- **Plan, only if enabled**: install it in `make agent-setup` into `.agent-tools/`, never in CI.
  Port the adjudicating script as `web/scripts/coderabbit-cli-review.ts` plus its logic in
  `web/lib/coderabbitCliReview.ts`, with unit tests for the four states.

## OSV-Scanner and its Action (#1566)

- **For**: a scan of `uv.lock` and `web/package-lock.json` against the OSV database on pushes to
  main and on a schedule; only findings not in a committed baseline fail.
- **Advisories**: none in OSV for the scanner itself.
- **Maintenance**: Google; monthly releases (2.4.0 Jun 18 to 2.7.1 Nov 9); 11.5k stars.
- **Size**: 58 MB static binary. The Action pulls its own container image at the pinned tag.
- **Licence**: Apache-2.0.
- **Version**: scanner 2.7.0 (Oct 12, 2026); the Action's reusable workflow
  `google/osv-scanner-action/.github/workflows/osv-scanner-reusable.yml` at v2.7.0, pinned by the
  commit `b1d267aea5211fa648d9d442fa64b90dbdcbdd36`.
- **Alternative with no new Action**: download the 2.7.0 release binary in a `run:` step and check
  its SHA-256 against a value committed in the workflow. This keeps the baseline logic in our own
  script (`scripts/osv-scan.mjs`, Node only) and needs no third-party Action. Recommended, since the
  baseline compare is ours either way.
- **Plan**: `scripts/osv-scan.mjs` runs `osv-scanner scan --format json --lockfile uv.lock
  --lockfile web/package-lock.json`, drops findings listed in `security/osv-baseline.json`
  (id and package, each with a reason), and fails on anything else.
  `.github/workflows/vulnerability-scan.yml` runs it on main and weekly.
  Today the web lockfile has 7 moderate findings, all one minimatch advisory (GHSA-g3hv-75wg-m249)
  reached through typescript-eslint: they start in the baseline.

## pytest-cov and coverage (#1567)

- **For**: running the api suite under `--cov` so a CI job can fail when total coverage drops below
  a committed floor. The floor only moves up.
- **Advisories**: none in OSV for either package.
- **Maintenance**: pytest-dev; pytest-cov had 1 release in the last 12 months (stable plugin);
  coverage (Ned Batchelder) had 22.
- **Size**: pytest-cov wheel 23 kB; coverage wheel about 230 kB (compiled tracer).
- **Licence**: pytest-cov MIT, coverage Apache-2.0.
- **Version**: `pytest-cov==7.1.0` (Mar 21, 2026) with `coverage==7.17.2` (Nov 4, 2026); it needs
  `coverage>=7.10.6`, `pytest>=7` (we have 9.1.1) and works with pytest-xdist.
- **Plan**: add both to the api dev group. The api CI job runs
  `pytest --cov=oracle --cov-report=json`; a `coverage-floors` job runs
  `.github/scripts/coverage_floor.py`, which reads `coverage.json` and fails below the floor in
  `api/coverage-floor.json`; a separate step proposes a higher floor when the total rises.

## Vitest, happy-dom and Testing Library (#1583)

- **For**: testing `web/lib` logic without a browser build, and rendering a component alone.
  Playwright stays for flows a person drives.
- **Advisories**: none for the proposed versions. Earlier versions had some:
  - vitest: 3 (UI or API server reachable from a web page, a mocker path traversal); they only
    matter with `--ui` or `--api`, which we would not use.
  - vite: 29 over its life, all in the dev server; none for 8.3.6.
  - happy-dom: 8, for running untrusted HTML or scripts (VM escape, SSRF, cookie scope). Tests only
    load our own components, never outside HTML.
- **Maintenance**: vitest and vite (VoidZero) 32 releases in 12 months; happy-dom 82 releases but one
  maintainer; Testing Library 18 maintainers, slow and steady.
- **Size**: 97 packages in all, 61 of them new to the web lockfile. vitest 2.9 MB, vite 2.4 MB plus
  its native builds (rolldown, lightningcss), happy-dom 9.2 MB.
- **Licence**: all MIT except lightningcss (MPL-2.0, through vite), a few Apache-2.0, BSD and ISC.
  MPL-2.0 is fine for a dev tool we do not change or ship.
- **Versions**: vitest 5.1.0, vite 8.3.6, @vitejs/plugin-react 6.2.1, happy-dom 21.0.4,
  @testing-library/react 16.3.3, @testing-library/dom 10.4.2, @testing-library/jest-dom 7.0.1,
  @testing-library/user-event 14.6.8. These resolve together under `--min-release-age=14`.
- **The no-dependency option**: `node --test` with Node 24's type stripping. It cannot import most of
  `web/lib` as is: 125 lib files import through the `@/` alias, and type stripping needs file
  extensions on relative imports, which the code leaves out. It would need our own resolve hook
  (`module.register`, about 20 lines), and it cannot render components. See `questions.json`.
- **Plan**: `web/vitest.config.ts` (happy-dom, the `@/` alias, `include: ['**/*.test.ts?(x)']`),
  `web/vitest.setup.ts` (jest-dom matchers, cleanup, the fixed clock the Playwright mock uses), a
  `test:unit` script and a CI step. Then move logic-only Playwright specs one area at a time to a
  `*.test.ts` beside the module, deleting each spec in the same commit.

## Prettier (#1584)

- **For**: one format for the web, checked in CI like `ruff format --check` for the api.
- **Advisories**: none in OSV.
- **Maintenance**: 24 releases in 12 months, 11 maintainers.
- **Size**: 10 MB unpacked, no dependencies (1 package).
- **Licence**: MIT.
- **Version**: 3.9.10 (Oct 10, 2026).
- **Plan**: `web/.prettierrc.json` (`singleQuote: true`, `trailingComma: "all"`, `printWidth: 100`),
  `web/.prettierignore` (builds, generated `lib/api/openapi.json`, `e2e/prose-ceilings.json`), and
  `format` / `format:check` scripts. CI adds `format:check` and `npx tsc --noEmit -p .` (after
  `next typegen`); tsc is not new. The reformat lands as one commit with no other change, and its
  hash goes into `.git-blame-ignore-revs`.

## ESLint plugins (#1585)

ESLint 9.39.5 and typescript-eslint 8.71.2 are already in the lockfile (through
`eslint-config-next`); the typed rules need only `parserOptions.projectService`, not a new package.

- **eslint-plugin-import-x 4.17.1** (MIT, 1.1 MB, 1 maintainer, a maintained fork of
  eslint-plugin-import) with **eslint-import-resolver-typescript 4.4.5** (ISC, 60 kB) for the `@/`
  alias: import order, cycles, unresolved imports.
- **eslint-plugin-unused-imports 4.4.1** (MIT, 18 kB, no dependencies; 1 release in 12 months, it
  is small and done): removes unused imports with `--fix`.
- **eslint-plugin-sonarjs 4.2.2** (SonarSource, 4.3 MB, 10 releases in 12 months): complexity and
  bug-pattern rules. **Licence LGPL-3.0-only**: fine for a lint tool we run and do not ship or
  change, but it is the one copyleft licence here. See `questions.json`.
- **eslint-plugin-testing-library 7.16.2** (MIT, 440 kB): rules for the new Vitest render tests.
- **Size**: 16 packages new to the web lockfile.
- **Advisories**: none for the plugins themselves. All of them, like today's typescript-eslint,
  reach `minimatch` with GHSA-g3hv-75wg-m249 (moderate, a slow-down on hostile glob patterns; our
  globs are our own). The fixed releases are too new: import-x 4.18.1 (Nov 9) is 14 days old on
  Nov 23 and typescript-eslint 8.73.0 (Nov 16) on Nov 30. Take those when they are old enough; until
  then the finding sits in the OSV baseline.
- **Plan**: after Prettier (D4), one pull request per phase, every rule at `error` with a
  suppressions baseline (ESLint 9's `--suppress-all` / `eslint-suppressions.json`), never `warn`:
  1. core and imports (import-x, unused-imports, typed typescript-eslint rules);
  2. size and complexity (`max-lines` 400, `max-lines-per-function`, `complexity`);
  3. sonarjs;
  4. design-system bans (`no-restricted-imports` / `no-restricted-syntax`, no package).
  Each phase then burns its baseline down; the 25 `exhaustive-deps` disables get fixed or each
  carries a reason.

## Not checked here

- ai-studio's files named in the issues (`agent-setup.ts`, `osv-scan.mjs`, `coverage_floor.py`,
  `eslint.config.*`) were not read from this lane; the plans above follow the issue text.
- The real pyright error count on `api/oracle` and the coverage total: measuring them means running
  the tools, which waits for the go.
