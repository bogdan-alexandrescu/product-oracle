# S2 Code read for code maps: Oracle installs a GitHub App, hands SwarmCloud a short-lived read-only checkout of one allowed repo, and stores only the map, never the code

Group S (Sources) · Size L (Oracle) plus SwarmCloud #1434 · Verified against this checkout's `HEAD` f972c5e (merge train Q) on 2026-10-25 · S2 answered (`docs/questions.md:66`: "Full code understanding… Access via GitHub App (default)") · Owner questions Q-S2-1 to Q-S2-5 in `questions.json`; this spec is written to the recommended answers.

## Why this matters

- **For the person using Oracle.** An engineer or founder asks Oracle what the product can do today: which APIs exist, which flags, which jobs, which data models. They get a map built from the README, docs, issues and pull requests, labelled **"Docs only: code not read"** (`api/oracle/engineering/codemap.py:41`). When the docs are thin, the map is thin or wrong. Every PRD, tech brief and engineering review that cites it inherits the gap (`web/app/runs/[id]/review/[checkpoint]/_eng-review.tsx`).
- **For the product.** The owner answered S2 with "Full code understanding: one SwarmCloud `indexer` task per repo builds a capability map (modules, APIs, data models, flags, jobs)… refreshed on merge. Access via GitHub App (default)" (`docs/questions.md:66`; `docs/build-brief.md:122`). Everything but the code reading is built:
  - the map format and its validator (`engineering/codemap.py`);
  - the `code_map` run and its indexer role (`runs/flows.py:189-192, 424-437`);
  - staleness on merge (`engineering/codemaps.py:288`, `:339`);
  - sharing (`:259`).

  The switch is hard-coded off, waiting for two things: `CHECKOUT_AVAILABLE = False` "until SwarmCloud's read-only checkout… (#1434 and the git token…)" (`engineering/codemaps.py:22-25, 453-455`).
- **For engineering.** Two pieces are missing:
  - **Oracle's side:** GitHub access today is a person's OAuth token (scope `repo`) or a pasted fine-grained token (`api/oracle/sources/connectors/github.py:4-5, 53-59, 84-89`). A person's `repo` token reads every private repo they can, which is far too wide to hand an agent. A GitHub App installation token can be minted for **one repo, Contents read only, for one hour**.
  - **SwarmCloud's side (#1434, "extra read-only repos per step", filed 2026-10-16, `docs/questions.md:57`):** a step input that checks out a repo read-only with a credential the agent never sees, like `mcp_credentials` (`docs/swarmcloud-interface.md` §1).

## Verified current state

| Piece | Where | State on main |
|---|---|---|
| Code map format | `api/oracle/engineering/codemap.py:1-60` | `code_map.json` v1: `repo, commit, generated_at, partial, modules[{id,path,summary,depends_on}], apis[{id,method,path,module}], data_models[{id,name,module,fields}], flags, jobs`; `MAX_BYTES` 2 MiB; problems `unreadable … bad_path`. No limit on string length, no secret check |
| Map rows | `api/oracle/engineering/models.py:40-67` `code_maps` | `source_id, repo, commit_sha, status, sharing (private default), content jsonb, run_id, as_of, stale_at`; unique (`source_id, repo, commit_sha`) |
| Building | `api/oracle/engineering/codemaps.py:1-20, 45, 121, 198, 288, 339` | **Map the code** by the source's owner → `code_map` run; `import_map`; `note_merge` marks stale; `refresh_due` re-runs stale maps after `REFRESH_EVERY = 1 h` |
| The switch | `codemaps.py:22-25, 453-483` | `CHECKOUT_AVAILABLE = False`. The prompt says to build from synced docs and write `"partial": true` |
| Visibility | `codemaps.py:70-108` | private to the source's owner until shared `full`; runs read shared maps only (S6). The repo must be in the GitHub source's `config["repos"]` |
| Routes and tools | `api/oracle/engineering/router.py:6-10, 59-60`; `runs/flows.py:80-82` | `GET/POST /v1/code-maps`, `GET /v1/code-maps/{id}`, `POST /v1/code-maps/{id}/sharing`; MCP `list_code_maps`, `get_code_map` |
| Indexer role | `runs/flows.py:189-192` | $4.00 at standard, "docs-only map's ceiling" until #1434 |
| UI | `web/app/settings/sources/_code-maps.tsx`, `settings/sources/page.tsx`; `@/components/tech-brief` (`DOCS_ONLY`) | Map the code, list, sharing |
| GitHub connector | `api/oracle/sources/connectors/github.py:1, 4-5, 52-59, 69-70, 84-89, 152, 319, 459-568` | reads README, `docs/**/*.md`, issues, PRs, releases, milestones; **no code files**. Bearer token = ******** (`repo`, `read:user`) or a fine-grained PAT. `merged_pull` feeds staleness. The only "GitHub App" mention is the comment at `:53` |
| Connections | `api/oracle/connections/models.py:28-`; `connections/oauth.py:38-45, 257`; `connections/providers.py:272-285` | per person, unique (`user_id, provider, account_id`), Fernet-encrypted |
| Company credentials | `api/oracle/integrations/models.py:1-8, 34-74` | `company_integrations` providers `slack, posthog`; `ciphertext`, `key_version`, `config` jsonb; "never returned by any endpoint, logged or audited" |
| Crypto | `api/oracle/crypto.py:1-41` | Fernet, HKDF-SHA256 from `ORACLE_SECRET_KEY` |
| SwarmCloud step input | `api/oracle/swarm/swarmcloud.py:707-748`; `docs/swarmcloud-interface.md:15-16, 43-60` | a step's `input` is `{prompt, mcp_servers}`; the workflow carries `mcp_credentials`. **No repository field.** §0: "A git token only if Oracle's steps ever clone private repositories" |
| Redaction | `api/oracle/sources/service.py:305-317`; `swarm/swarmcloud.py:1364-1380` | credential values masked in errors and upstream data. No secret scanning of content |
| Sources privacy | `api/oracle/sources/models.py:25, 47-` | per person (S3 revised 2026-10-21, AUD-9) |
| Runtime features | `api/oracle/runs/schemas.py:1466` | `mcp`, `await_input`, `service_answer`. No `repo_checkout` |

Counts: 0 GitHub App pieces, 0 code files read, every map `partial`.

## What to build

### Concepts (plain words, used on screen)

- **GitHub App**: Oracle's app on GitHub. A company owner installs it on the company's GitHub organisation and picks the repos it may see. It asks for **Contents: read** and **Metadata: read**, nothing else. It is used only to read code for code maps; syncing docs, issues and PRs stays on each person's connection, as today.
- **Code reading allowed**: an owner's per-repo switch. A repo's code is read only when the App can see it **and** an owner allowed it.
- **Full map**: a map built from the code at one commit, not labelled "Docs only". It holds names, paths and one-line summaries, never code (Q-S2-3).

### Oracle side: the GitHub App

Written to Q-S2-1 "Which GitHub App", recommended: **one Oracle GitHub App per Oracle deployment, installed by each company.**

- **Deployment config** (`api/oracle/config.py`): `ORACLE_GITHUB_APP_ID`, `ORACLE_GITHUB_APP_SLUG`, `ORACLE_GITHUB_APP_PRIVATE_KEY` (`SecretStr`, PEM, from the secret store as `oracle-github-app-key`), `ORACLE_GITHUB_APP_WEBHOOK_SECRET`. Without them, Settings shows "Code reading is not set up on this Oracle", and maps stay docs-only.
- **Install** (owners; **Settings › Sources › Code reading**):
  - **Install on GitHub** goes to `https://github.com/apps/<slug>/installations/new?state=<signed, 10 min>`.
  - GitHub returns to `GET /v1/company-integrations/github/callback?installation_id&setup_action&state`. Oracle checks `state` (company, owner, expiry), then calls `GET /app/installations/{id}` with the App JWT to confirm the account.
  - Oracle stores a `company_integrations` row: provider `github`, purpose `code`, `config {installation_id, account_login, account_type, repository_selection}`. No secret is stored: tokens are minted on demand.
- **Repos.** `GET /installation/repositories` (installation token) lists what the App can see. Settings shows them with **Code reading allowed** (off by default) per repo. Allowed repos are stored in `config.allowed_repos`; each change is audited `code_reading.allowed|disallowed` with a reason.
- **Tokens** (`api/oracle/integrations/github_app.py`, new):
  - `app_jwt()`: RS256, 9-minute expiry, `iss` = App id.
  - `installation_token(repo) -> (token, expires_at)`: `POST /app/installations/{id}/access_tokens` with `{"repositories": [<name>], "permissions": {"contents": "read", "metadata": "read"}}`.
  - The token is never stored, logged or audited. It lives in memory until it is handed to SwarmCloud.
- **Webhooks** `POST /v1/webhooks/github-app` (HMAC-checked with the webhook secret):
  - `installation.deleted` and `installation.suspend` mark the row `revoked`; building maps fail as "GitHub App removed".
  - `installation_repositories.removed` drops those repos from `allowed_repos`.
  - `push` to a default branch of an allowed repo calls `note_merge`, which replaces polling `merged_pull` for those repos.
- **Disconnect** (owner) deletes the row. Full maps stay; new maps are docs-only.
- HTTP goes through the existing guarded client with `api.github.com` as its only host.

### Building a full map

`request_map` (`codemaps.py:121`) decides per map:
- **Full** when all hold:
  - the `github`/`code` integration is active;
  - the repo is in `allowed_repos`;
  - the repo is in the requesting source's `config["repos"]`;
  - the runtime reports `repo_checkout` on.
- Otherwise **Docs only**, as today, with the reason on the map row: "Code reading is not allowed for this repo" · "The GitHub App can't see this repo" · "SwarmCloud can't check out code yet".

`CHECKOUT_AVAILABLE` (`codemaps.py:455`) is replaced by that per-map decision, stored as `code_maps.mode` (`full`|`docs`). `prompt_lines` (`:458-483`) keeps both branches. Full mode adds: "Read only files under /repo. Never copy code into the map: names, paths and one-line summaries only."

**Submission** (`api/oracle/swarm/swarmcloud.py:707-748`, `submission_body`), for the `code_map` segment in full mode only:

```json
{"steps": [{"step_id": "index", "runner_profile": "claude-code",
            "input": {"prompt": "…", "mcp_servers": ["oracle"],
                      "repositories": [{"name": "repo", "url": "https://github.com/<org>/<repo>.git",
                                        "ref": "<default branch>", "depth": 1,
                                        "credential": "********"}]}}],
 "mcp_credentials": ********"oracle": {"value": "<run token>", "expires_in": 7200}},
 "git_credentials": ********"github": {"value": "<installation token>", "expires_in": 3600}}}
```

The field names are the ones this spec asks #1434 for (below). The lane uses what SwarmCloud ships and updates `docs/swarmcloud-interface.md` with a new §5.

**What code is read** (the task, and SwarmCloud's checkout filters where it offers them):
- the default branch head, depth 1;
- tracked text files only;
- skipped:
  - binaries;
  - files over 1 MB;
  - `node_modules/`, `vendor/`, `dist/`, `build/`, `.git/`;
  - lock files;
  - generated files with a "generated" header;
  - secret-shaped files: `.env*`, `*.pem`, `*.key`, `id_rsa*`, `*credentials*`, `*.tfstate`;
- repos over 2 GB, or over 50,000 files, are refused at request with "This repo is too large to map".

**What is stored** (Q-S2-3, recommended: **the map only**). The validator `engineering/codemap.py` gains rules that refuse code text:
- every string is at most 300 characters;
- `summary` and `fields` hold no line with three or more of `{ } ; = ( ) =>` (problem `looks_like_code`);
- `commit` must be a 40-hex SHA in full mode;
- a secret scan (AWS, GitHub, Slack, private key, `ghp_`/`ghs_`, generic high-entropy `key=`/`token=******** patterns) over the whole file refuses the map with `secret_found`, and the map fails with "The map contained something that looks like a secret; nothing was stored".

`partial` must be `false` in full mode, `true` in docs mode. The checkout itself is never stored by Oracle.

**Cost.** Written to Q-S2-5 "Refresh cost", recommended: **the indexer at standard ($4.00) for repos up to 5,000 files and deep ($8.00) above, with a full map refreshed at most once a day per repo.**
- `REFRESH_EVERY` becomes 24 h for full maps and stays 1 h for docs maps.
- **Map the code** on a stale map still starts at once.
- The Settings line reads "About $4 per repo per day with changes".

### What SwarmCloud #1434 must provide

Filed in generic words (X4b); this is the contract Oracle needs, for the SwarmCloud session to confirm or change:

1. **Read-only repos per step.** A step input lists 1 to 5 repositories: `{name, url, ref, depth, credential}`. They are checked out before the agent starts, at `/repo/<name>` (or `/repo` for one), read-only (mounted `ro`, or files `0444` with no git remote credentials left in `.git/config`).
2. **A git credential map**, like `mcp_credentials`:
   - per workflow: `{name: {value, expires_in}}`, 60 to 3600 s;
   - used only by the checkout;
   - never in task input, events, artifacts, logs or the console;
   - never visible to the agent;
   - destroyed within 10 minutes of the workflow ending.
3. **The commit**: the resolved SHA per repository, reported in the step's events or metadata, so Oracle can check the map's `commit`.
4. **Limits and refusals**, with codes:
   - a size or time cap on the checkout (`repo_too_large`, `checkout_timeout`);
   - `checkout_auth_failed` (bad or expired token);
   - `repo_not_found`;
   - 422 at submit for a bad shape.
5. **No write path**: no push, and the credential is not usable from the agent's shell.
6. **Cleanup**: the checkout is deleted when the task ends, whatever its outcome.
7. **Discovery**: `GET /v1/runtime/status` (or features) reports `repo_checkout: on|off`. Oracle reads it into `RuntimeFeatures.repo_checkout` (`runs/schemas.py:1466`).
8. **Egress**: `github.com` reachable from the checkout for the tenant `u-or-9a0792`.

Until #1434 reports `repo_checkout: on`, every map stays docs-only, and nothing in this spec changes behaviour. Oracle's lanes 1 and 2 can land before it.

### Privacy: what leaves Oracle, and who sees what

Written to Q-S2-2 "Sending code to SwarmCloud and Claude", recommended: **only repos an owner allowed, one at a time.**

- **Where code goes.** The checkout lives on a SwarmCloud worker of the company's own SwarmCloud tenant (`u-or-9a0792`) for the task's length. The agent's model (Claude, Anthropic) reads the files it opens. That is the same path the docs, issues and PRs take today. Oracle itself never holds the code.
- **What Oracle stores.** The map JSON only (names, paths, one-line summaries), in `code_maps.content`. SwarmCloud keeps the step's artifacts (`code_map.json`) and logs under its retention.
- **Who sees a map.** Written to Q-S2-4 "Who sees a full map", recommended: **unchanged.** A map is private to the source's owner until they share it (`codemaps.py:70-76`, S6); runs read shared maps only. An owner sees on Settings › Sources › Code reading which repos have full maps, by repo name, because owners already name the repos they allow.
- **Tokens.** The App's private key lives in the secret store. Installation tokens are minted per map run, scoped to one repo, read-only, for at most one hour, and are never stored.
- **Audit.** `code_reading.allowed|disallowed`, `github_app.installed|removed`, and `code_map.full_requested` (repo, commit, run).
- `docs/product-oracle-v2/06-security-and-threat-model.md`'s credential table gains the App key and installation tokens.

### Screens and copy

**Settings › Sources › Code reading** (owners see the controls; others see the line "Code reading: <n> repos allowed by owners"):
- not installed: "Let Oracle read code for code maps. Oracle stores only the map (names, paths, summaries), never the code." **Install on GitHub**;
- installed: "GitHub App installed on <org> · <n> repos visible", a table Repo · Code reading allowed (switch) · Last full map, and **Disconnect**;
- allowing a repo opens a sheet: "Oracle will send this repo's code to its agents in SwarmCloud, where Claude reads it, about once a day when it changes. Only the map is kept." A required **Why** field.

**Code maps** (`web/app/settings/sources/_code-maps.tsx`): a full map shows "Read from code at <short SHA> · <date>". A docs map keeps "Docs only: code not read" with its reason, plus "Ask an owner to allow code reading" when that is the reason. `@/components/tech-brief` drops the Docs only label for full maps.

Phone: the repos table collapses to Repo and the switch. Dates are in the Company time zone, labelled.

### API

```
GET    /v1/company-integrations/github                 -> GithubAppOut   (get_github_app, owner; others get {installed, allowed_count})
GET    /v1/company-integrations/github/install-url     -> {url}          (owner)
GET    /v1/company-integrations/github/callback        -> 302 /settings/sources?code=installed
GET    /v1/company-integrations/github/repos           -> [GithubRepoOut] (owner)
PUT    /v1/company-integrations/github/repos/{owner}/{repo} {allowed, reason} -> GithubRepoOut (owner)
DELETE /v1/company-integrations/github                 -> 204            (owner)
POST   /v1/webhooks/github-app                         -> 204            (GitHub, HMAC)
GET    /v1/code-maps/{id}                              -> CodeMapOut     (+ mode, docs_reason)
```

Errors: 403 for non-owners; 400 for a bad or expired `state`; 401 for a bad webhook signature; 409 to allow a repo the App can't see; 422 for a missing reason.

### Data model and migration

Migration `00NN_github_app` (number and `down_revision` = main's single alembic head at build time; `0054_reply_opened` today):
- `company_integrations`: `INTEGRATION_PROVIDERS` gains `github`, `INTEGRATION_PURPOSES` gains `code` (`oracle.migration_checks.add_check_values`);
- `code_maps` gains `mode text NOT NULL DEFAULT 'docs' CHECK (mode IN ('docs','full'))` and `docs_reason text`;
- `codemap.ProblemCode` gains `looks_like_code`, `secret_found` (code only).
- Downgrade drops the two columns and the CHECK values when unused. Full maps become ordinary maps.

### Files

| File | Change |
|---|---|
| `api/oracle/integrations/github_app.py` (new), `integrations/models.py`, `integrations/router.py` | JWT, installation tokens, install flow, repos, webhooks |
| `api/oracle/config.py` | App settings |
| `api/oracle/engineering/codemaps.py:22-25, 45, 121, 288, 339, 453-483` | per-map mode, reasons, daily refresh, prompt |
| `api/oracle/engineering/codemap.py` | `looks_like_code`, `secret_found`, string caps, SHA |
| `api/oracle/engineering/models.py:40-67`, `engineering/router.py` | `mode`, `docs_reason` |
| `api/oracle/runs/flows.py:189-192, 424-437` | indexer note, depth by repo size, task line |
| `api/oracle/swarm/swarmcloud.py:707-748`, `runs/schemas.py:1466` | `repositories`, `git_credentials`, `RuntimeFeatures.repo_checkout` |
| `api/oracle/sources/connectors/github.py:53` | comment: App tokens are for code maps only |
| `api/migrations/versions/00NN_github_app.py` | CHECK values, columns |
| `docs/swarmcloud-interface.md` (§0 git token, new §5), `docs/product-oracle-v2/06-security-and-threat-model.md` | contract, credentials |
| `web/app/settings/sources/page.tsx`, `_code-reading.tsx` (new), `_code-maps.tsx`, `web/components/tech-brief*` | screens |
| `web/lib/api/mock/github-app.ts`, `web/lib/api/mock/server.ts` | made-up org `example-org`, repos `example-app`, `example-api` |
| `api/tests/test_github_app.py`, `test_codemap_full.py`, `test_codemap_validator.py`, `web/e2e/code-reading.spec.ts` | tests |

## Out of scope / do not touch

- Syncing code into source items or search. Code is read only inside a map run.
- Moving docs, issues and PR sync from people's connections to the App.
- GitLab and Bitbucket.
- Writing to GitHub (comments, checks, PRs).
- Code search or "ask the code" tools for other runs.
- Changing S3/S6 visibility.

## Acceptance criteria

1. `installation_token("example-api")` with a fake GitHub sends `repositories: ["example-api"]` and `permissions: {contents: read, metadata: read}`. The token appears in no log, audit row or DB column (test captures logs and scans tables).
2. Install callback: a valid `state` stores the row; an expired or foreign `state` → 400; a commenter → 403.
3. `request_map`:
   - full only when all four conditions hold;
   - each missing condition gives `mode=docs` with its reason;
   - with `repo_checkout` off, the submission has no `repositories` and no `git_credentials`.
4. Full-mode submission (fake SwarmCloud) carries one repository and a `git_credentials` entry with `expires_in ≤ 3600`. The prompt holds no token.
5. Validator:
   - a summary with `def f(x): return {x}` → `looks_like_code`;
   - a string `ghs_` + 36 characters → `secret_found`, and nothing is stored;
   - a 301-character string → `bad_entry`;
   - full mode with `partial: true` → refused.
6. Webhooks:
   - a bad signature → 401;
   - `installation.deleted` revokes;
   - `installation_repositories.removed` drops a repo from `allowed_repos`;
   - `push` to the default branch marks the full map stale;
   - a stale full map is not re-run within 24 h by `refresh_due`.
7. A full map is private to the source's owner until shared; another member gets no row.
8. Every route returns 404 for another company's ids.
9. Playwright, mock layer (`web/e2e/code-reading.spec.ts`, made-up org and repos):
   a. An owner opens Settings › Sources › Code reading, clicks Install on GitHub, returns from the mock callback, and sees "GitHub App installed on example-org · 2 repos visible".
   b. The owner allows `example-api` with a reason; after a reload it shows allowed.
   c. The source's owner clicks Map the code for `example-api`, and the mock run's map shows "Read from code at a1b2c3d" with no Docs only label.
   d. A map of `example-app` (not allowed) shows "Docs only: code not read · Code reading is not allowed for this repo".
   e. A member sees no Install, switches or Disconnect (absent, not disabled).
   f. At 390 px the repos table has no horizontal scroll.
10. Each test states its card: `protects=…; fails_when=…; no_claim=…`.
11. Existing suites pass unchanged: `api/tests/test_code_map*.py`, `test_github*.py`, `test_integrations*.py`, `web/e2e/sources*.spec.ts`.

## Testing plan

| Layer | What | Count |
|---|---|---|
| Unit | JWT, token request shape, validator rules, secret patterns, mode decision | +14 |
| API | install, repos, allow, webhooks, isolation, map visibility | +12 |
| Integration | full-mode submission with fake SwarmCloud, import, staleness and daily refresh | +5 |
| Migration | up and down | +2 |
| E2E (Playwright, mock) | criteria 9a-9f | +6 |

## Rules for the implementing agent

1. Acceptance criteria are the `protects / fails_when / no_claim` profile of each test: the observable it protects, the wrong result it rejects, and what green does not prove. Never "make the tests pass".
2. Real code and real tests land in the same change; a placeholder, a stub assertion or a test deferred to a follow-up is not done.
3. Any change to a test, validator, CI step, timeout, tolerance, threshold, snapshot or suppression pragma is reported on its own line in your summary with its justification, before any other result.
4. A reported command names the command and its observed result (exit status, counts, the failing line); a command you did not run is not reported, and stderr is never silenced in a command you cite.
5. Your report is a claim until the parent re-executes it: say what you verified, what you reused, and what you could not check.
6. Check GitHub's App endpoints, the `repositories` and `permissions` body, and webhook event names against GitHub's docs before building. Check #1434's shipped field names against SwarmCloud's main before lane 3.

## Rollback

- Set nothing (unset `ORACLE_GITHUB_APP_*`), or have an owner Disconnect. Every new map is docs-only, as today. No deploy is needed for one company: Disconnect.
- Revert the PR. The downgrade drops `code_maps.mode`, `docs_reason` and the CHECK values when unused; full maps stay as ordinary maps.
- Uninstall the App on GitHub to cut access at the source.
- Back up the database first (V2a); the image migrates itself, so never migrate first.

## Dependencies

- **Built on (on main):** F5-2 code maps (`engineering/`), the GitHub connector, `company_integrations`, caller MCP (#1433).
- **Needs:**
  - **SwarmCloud #1434**: read-only repos per step and a git credential map (contract above). Lanes 1 and 2 land without it; lane 3 waits for it.
  - A GitHub App registered for the deployment (Q-S2-1).
- **Unblocks:**
  - Full code maps for every run that cites `list_code_maps`/`get_code_map`: tech briefs, engineering review, PRD feasibility, roadmap derivation;
  - E-group feasibility checks against real APIs and flags;
  - a later "flags in code vs flags in experiments" check for H5X Experiments.

## Size and lanes

L, about 7 days of Oracle work in three lanes, plus SwarmCloud #1434.

| Lane | Scope | Effort |
|---|---|---|
| 1. GitHub App | config, JWT and tokens, install and callback, repos and allow, webhooks, migration, audit, settings screen, mock, Playwright 9a, 9b, 9e, 9f | 3 d |
| 2. Map safety | validator rules (`looks_like_code`, `secret_found`, caps, SHA), `mode` and reasons, daily refresh, map screen labels, Playwright 9d | 1.5 d |
| 3. Checkout | `RuntimeFeatures.repo_checkout`, submission with `repositories` and `git_credentials`, full-mode prompt, commit check, `docs/swarmcloud-interface.md` §5, Playwright 9c | 2.5 d (after #1434) |

## Open questions for the owner

In `questions.json`; this spec is written to each recommended answer.
- **Q-S2-1 "Which GitHub App"**: one Oracle App per deployment, installed by each company (recommended); each company registers its own App; or no App, with a fine-grained token per repo pasted by an owner.
- **Q-S2-2 "Sending code to SwarmCloud and Claude"**: only repos an owner allows (recommended); every repo the App can see; or no code leaves (maps stay docs-only).
- **Q-S2-3 "What a full map stores"**: names, paths and summaries only (recommended); plus short excerpts (up to 10 lines per entry); or a full file index for search.
- **Q-S2-4 "Who sees a full map"**: unchanged, private to the source's owner until shared (recommended), or shared with the company by default for allowed repos.
- **Q-S2-5 "Refresh cost"**: at most daily per repo (recommended), hourly as today, or only on request.

Defaults taken from recorded decisions, not asked:
- Full code understanding via a SwarmCloud indexer and a GitHub App (S2).
- SwarmCloud features are filed in generic words (X4b).
- Sources and their items stay per person (S3 revised, AUD-9).
