# 06 — Security and threat model (build prompt §12, against the code at b1bc1cf)

The `v2-audit` lane (CR-00) wrote this by reading the code. No code was changed. Each
risk is marked:
- **mitigated:** a control exists and tests cover it;
- **partial:** a control exists with a gap, which is named;
- **open:** no control exists.

Paths are under `api/oracle/` unless they start with `web/`. Line numbers are for
`b1bc1cf`.

Out of scope here: the deployment (IAP, the load balancer, Cloud Run, `private/deploy/`).
It is not in the repository and was not reviewed.

## 1. Trust boundaries and credentials

```text
Browser ──IAP──> web (Next.js, same origin proxies /v1/*) ──> API (/v1)
External MCP client ──OAuth 2.1──> /mcp (public backend, no IAP) ──in-process──> /v1 routes
CLI / scripts ──API token──> /v1
SwarmCloud agent ──run token (not sent today)──> /mcp
API ──connector credentials (encrypted)──> GitHub, Slack, Notion, Fireflies, Google
API ──no credentials──> public web pages (public-link evidence)
API ──ID token or bearer──> SwarmCloud
```

| Credential | Where it is checked | Stored as | Lifetime and revocation |
|---|---|---|---|
| IAP JWT | `auth/deps.py:55-76`, `auth/iap.py:98-123` (ES256, issuer, audience, expiry) | not stored | Google's |
| Session cookie | `auth/service.py:83-97` (itsdangerous, timestamped), `auth/deps.py:121-130` (role re-read from the database) | signed with `ORACLE_SECRET_KEY`; HttpOnly, SameSite=Lax (`auth/router.py:20-28`) | 7 days; **no server-side revocation**: logout only deletes the cookie (`auth/router.py:41-43`) |
| API token `po_` | `auth/service.py:72-80`, `auth/deps.py:79-106` | sha256 | revocable in the database; **no REST route to issue or revoke** (only `oracle.seed`) |
| OAuth access token `poa_` | `mcp/oauth/verify.py:23-41` | hashed | refresh rotation, and reuse revokes the family (`mcp/oauth/service.py:381-427`) |
| Run token `ort_` | `runtokens.py:98-115`, only on `/mcp` (`mcp/auth.py:132-148`) | sha256 (`runtokens.py:47`) | TTL 6 h by default (`swarm/settings.py`); revoked when the run ends or a segment is resubmitted (§3) |
| Connector credentials | `crypto.py:25-41` (Fernet, key derived by HKDF from `ORACLE_SECRET_KEY`) | encrypted | S5b: OAuth grants revoked at the provider, then deleted (`connections/service.py:272-290`) |

## 2. Company (cross-company) and IDOR risks per route family

The core control is automatic company scoping. A `do_orm_execute` hook adds
`tenant_id = :company` to every ORM query on a `TenantScoped` table
(`tenancy.py:72-87`). A `before_flush` hook stamps new rows and refuses rows from
another company (`tenancy.py:90-103`). A session without a company refuses to run
(`tenancy.py:59-69`). Every request route uses `TenantDB` or `tenant_session`.

Raw SQL and Core statements are **not** rewritten (`tenancy.py:13-14`). The two Core
inserts in the code set `tenant_id` explicitly: `claude_accounts/sweep.py:127` and
`claude_accounts/store.py:174`.

`unscoped_session` appears only in authentication and background loops:
- `auth/service.py:61`, `:74`
- `auth/iap.py:127`
- `runtokens.py:103`
- `mcp/oauth/verify.py:27` (with a company check on the user at `:34`)
- `mcp/oauth/service.py:210`
- `jobs/worker.py:312` and `claude_accounts/sweep.py:416` (these list company ids only)
- `seed.py:45`

| Route family | Guard | Within-company object checks | Cross-company | Status |
|---|---|---|---|---|
| `/v1/documents/*` (`docs/router.py`) | viewer router-wide; approver to import (`:60`) | slug or id resolved in the scoped session | 404 (`test_import.py::test_documents_are_tenant_isolated`, `legacy/test_legacy_roles.py`) | mitigated |
| Review (`review/router.py`) | viewer reads; commenter comments; approver verdicts, feedback and approve | edit or resolve a comment: author or approver (`review/service.py:346-347`) | 404 (`test_review.py`, `legacy/test_legacy_roles.py`) | mitigated |
| Exports and deck (`export/router.py`) | viewer | | 404 (`test_export.py::test_export_is_tenant_scoped`, legacy) | mitigated |
| Templates, themes, drafts (`templates/router.py`) | any signed-in user reads, validates, previews and recommends; approver writes; owner sets draft defaults (`:277`) | | scoped | mitigated |
| Baseline (`baseline/router.py`) | viewer reads; commenter proposals and link evidence; approver writes | evidence removal: approver or the person who added it (`baseline/evidence.py:120-123`); evidence on a source item checks that the item is the caller's (`baseline/evidence.py:39-58`) | scoped | mitigated |
| Priorities | any signed-in user reads; approver writes (`priorities/router.py:43`) | | scoped | mitigated |
| Sources, items, snapshots, search (`sources/router.py`) | signed in only; **a viewer can create, sync and upload sources** | owner only: `sources/service.py:202-205`, `sources/items.py:32-35`, `:114`, `sources/router.py:319`, `:327` | scoped | mitigated; per-user reads are stricter than S3 (change request AUD-9) |
| Connections (`connections/router.py`) | signed-in user; own rows only (`connections/service.py:81-87`) | | scoped | mitigated |
| Members and invites | owner router-wide (`members/router.py:17`) | last owner protected | scoped | mitigated |
| Company settings | owner | the audit event stores the setting value (`tenant_settings_api.py:192`); settings hold no secrets today | scoped | mitigated; keep secrets out of settings |
| Claude accounts | viewer reads; owner writes (`claude_accounts/router.py:54`) | the fallback token is write-only | scoped | mitigated |
| Jobs | viewer reads; approver acts; owner sets settings (`jobs/router.py:71`) | | scoped | mitigated |
| Runs and Inbox | any signed-in user reads (`runs/router.py:79`, `:93`, `:157`, `:169`); approver or owner writes; the >$50 approve and the resume are owner only | **run artifacts readable by any viewer** (`runs/router.py:157-165`, `runs/service.py:400`) | scoped | partial: once agents read the creator's own sources through MCP, artifacts can carry source content that viewers could not read in `/v1/search` |
| `POST /v1/internal/tick` | an owner (re-read under the review gate), or an API token with the `tick` scope (`python -m oracle.tick_token`); viewer, commenter and approver tokens and run tokens are refused (`runs/router.py`, `tick`) | a tick token is refused on every other route and by the MCP server (`auth/deps.py`, `mcp/auth.py`) | scoped to the token's company | mitigated (review round 8; `test_review_v2_security_8.py::test_the_tick_takes_owners_and_the_tick_token_only`) |
| `/v1/runtime/status` | signed in | redacts echoed tokens (PR #8, #9) | n/a | mitigated |
| MCP `/mcp` | bearer: API, OAuth or run token (`mcp/auth.py:64-72`); each tool is the REST route called in-process with the caller's credentials (`mcp/tools.py:299-325`) | same as REST | same as REST (`legacy/test_legacy_roles.py` calls `get_document` from another company) | mitigated |
| OAuth endpoints (public) | PKCE S256 required (`mcp/oauth/routes.py:241-242`); single-use codes bound to the redirect URI (`mcp/oauth/service.py:335-378`); consent requires the same company (`routes.py:282-287`) | open dynamic registration (`routes.py:108`), by design (I2) | | mitigated |

What v2 must add for each new route:
- `require_role`;
- `TenantDB`;
- `audit.record` on every state change;
- a negative cross-company test (shared rule);
- a run-token scope in `mcp/scopes.py` if agents may call it. Routes default to refused
  for run tokens.

New tables must inherit `TenantScoped`. New Core or raw-SQL statements must set and
filter `tenant_id` by hand.

## 3. Run tokens

| Risk | Evidence | Status |
|---|---|---|
| A token leaks into prompts, labels, artifacts or logs | Only the sha256 is stored (`runtokens.py:47`, `:89`). `swarm/swarmcloud.py:225` does not send `spec.mcp`. The labels (`runs/service.py:1027-1032`) and the metadata (`swarmcloud.py:223`) carry ids only. The prompt (`runs/flows.py:475-479`) names "the run token you were given" and never includes its value. | mitigated (today it never leaves Oracle) |
| Token outlives its run | Revoked before each new mint (`runs/service.py:1005`), on a failed submit (`:1050`), on finish or cancel (`:1077`, `:1537`) and at `:1396`. Expiry is checked in `runtokens.py:98-115`. | mitigated |
| Overbroad authority | `verify_run_token_caller` mints a **session cookie for the run's creator** (`mcp/auth.py:75-93`, `:132-148`). The only limit is the per-area scope map, enforced in MCP (`mcp/scopes.py:23-48`, `mcp/tools.py:303`, `mcp/server.py:77-78`). `read:documents` reads every document in the company. `write:drafts` imports into any document. `write:proposals` adds evidence to any entity. | **partial**: not bound to the run's document, PRD version or snapshot. v2 (CR-07) should bind tokens to the run's document and source snapshot, and refuse writes elsewhere. |
| Scope check by route template, not the concrete path | `scopes.allowed` is called with `op.path` (`mcp/tools.py:303`). Path arguments are quoted with `safe=""` (`mcp/tools.py:292`), but httpx's ASGI transport unquotes `%2F` back into the routed path. | partial (defence in depth): no route today lets a `/` in a parameter reach another scope area. Check the concrete path after building it, or reject `/` in path arguments. |
| Network origin | No egress-address restriction on run tokens (`runtokens.py`, `mcp/auth.py`). Decided in `swarmcloud-interface.md` §3.2. | **open**: to build with the MCP switch (CR-07). Do not restrict people's OAuth or API tokens. |
| Source revoked after a run was queued | Agents read through the creator's REST session, so they see live state. Deleting a source cascades its items (`sources/models.py:83-84`). Disconnecting a connection sets `sources.connection_id` to null and **keeps the ingested items readable** (`sources/models.py:60`). The run pins `snapshot_id` (`runs/service.py:741-748`), but reads at a snapshot still return items that were ingested before it. | partial: document it as "disconnect stops future syncs; delete the source to remove its content". CR-12 should re-check the source status on every agent read. |
| Duplicate submit after a timeout (§16.15) | A failed submit leaves the segment pending and resubmits on the next tick (`runs/service.py:1046-1052`). There is no label lookup first. | **open**: CR-07, "check existing workflow labels before retry". |

## 4. Source and connection credentials

| Risk | Evidence | Status |
|---|---|---|
| Credentials at rest | Fernet with an HKDF-derived key (`crypto.py:25-41`), used for connections (`connections/service.py:60-65`, `:115`, `:206`), the PKCE verifier in OAuth state (`connections/oauth.py:111-139`) and the Claude account pairs (`claude_accounts/store.py:227-230`) | mitigated |
| One secret for everything, with an insecure default | `ORACLE_SECRET_KEY` defaults to `"dev-insecure-change-me"` (`config.py:13`), and nothing refuses that default at startup. The same key signs cookies (`auth/service.py:84`), OAuth state and consent requests, and derives the encryption key. `cookie_secure` defaults to `False` (`config.py:16`). There is no keyring (`crypto.py:17` `KEY_VERSION=1`), so rotation would orphan every stored credential. | **open (medium)**: refuse to start outside a local or test environment with the default key or `cookie_secure=False`; add key versions for rotation |
| Credentials in API responses | `ConnectionOut` has no secret fields (`connections/router.py:61-119`). The Claude fallback token is write-only (`claude_accounts/router.py:224-225`). | mitigated |
| Credentials in logs and errors | `sources/service.py:185-199` `redact`, applied in `sources/sync.py:99-109`, which logs only the exception type. SwarmCloud error details are redacted (PR #9 on `origin/main`). | mitigated |
| Credentials to an LLM or generated code | Connector credentials are only used inside `sources/connectors/*`. LLM jobs run `claude -p` with tools, MCP and settings disabled and a clean environment (`llm/transports.py:157-182`). | mitigated today; keep it so in CR-09 and CR-10 |
| Revocation (S5b) | `connections/router.py:289-302` and `connections/service.py:272-290`: OAuth grants are revoked at the provider (best effort), pasted tokens are only deleted, and both are audited. | mitigated |

## 5. SSRF and hostile content on public links (`baseline/public_links.py`)

| Control | Evidence | Status |
|---|---|---|
| Scheme, port, user info | https only, port 443, no user info (`_check_url`, `:126-144`) | mitigated |
| Private, metadata and special addresses | `public_address` (`:178-191`) requires `ip.is_global` and rejects multicast; it unwraps IPv4-mapped and NAT64 addresses and refuses 6to4 and Teredo. Every resolved address must pass (`public_addresses`, `:203-221`). This blocks 169.254.169.254, RFC 1918, loopback and 100.64/10. | mitigated |
| DNS rebinding | `_GuardedBackend` (`:224-255`) re-resolves, re-checks and connects to the checked IP (TLS keeps the hostname); unix sockets are refused | mitigated |
| Redirects | Followed by hand (`follow_redirects=False`, `:563`), at most 5 (`:49`, `:609`), each hop re-checked. Cookies are dropped and `trust_env=False` (`:564`). | mitigated |
| Size, decompression and time | `MAX_BYTES` 2 MB (`:47`), checked against Content-Length and the streamed decompressed bytes. Timeouts are 10 s per request and 20 s total. Text is capped at 200k characters. | partial: a single decompressed chunk can exceed the cap in memory before the check (memory only) |
| MIME types | `text/html`, `application/xhtml+xml` and `text/plain` only (`:55`, `:630`). HTML becomes text through an `HTMLParser` extractor that skips script and style. | mitigated |
| Tests | `test_public_links.py` (33 test functions, including rebinding, redirects and limits) | |

v2 (CR-09, CR-10, CR-12) must reuse `guarded_transport` for every server-side fetch: web
research results, Figma, prototype assets.

## 6. Untrusted ingested content (prompt injection) and rendering

| Risk | Evidence | Status |
|---|---|---|
| Ingested text steering the built-in LLM jobs | Versioned system prompts from files (`jobs/prompting.py:20-38`, `jobs/prompts/*.md`). The input is sent as a JSON-encoded user message (`jobs/worker.py:186-193`, `jobs/kinds.py:591-592`). No tools are available (`llm/transports.py:157-182`). Output is stripped of links, URLs and headings (`jobs/prompting.py:87-117`). | partial: JSON is the only delimiter, and nothing says "this is data, not instructions" |
| Ingested text steering SwarmCloud agents | Run prompts include reviewer feedback, change-request notes, earlier agent outputs and up to 30k characters of PRD markdown, separated only by `--- PRD … ---` (`runs/flows.py:460-567`). Agents have no Oracle MCP today. | partial: wrap untrusted text in labelled data blocks, keep instructions in versioned prompt files, and read through a least-privilege MCP (§5 of the build prompt) |
| Agent output treated as truth | Drafts are imported as new versions for review; the roadmap items file is validated (`runs/roadmap.py`); nothing auto-approves | mitigated |
| HTML and XSS in exports | markdown-it `commonmark` with `html: False` (`export/render.py:394`, `:546`) and its default link validation; Jinja autoescape; exports served as `attachment` (`export/router.py:113-117`) | mitigated |
| Theme CSS (exfiltration and injection) | `check_theme_css` (`templates/validation.py:377-393`) blocks `@import`, `</`, `expression(`, `javascript:`, backslashes and `image()`/`image-set()`/`cross-fade()`, and allows `url()` only for `data:` URIs. `check_slide_css` (`:396-408`) also blocks `:host`. Checked on save (`templates/service.py:318-322`), preview and deck. **The HTML export inserts `theme.css` without re-checking it** (`export/render.py:771`). PDF fetches allow `data:` only (`export/pdf.py:41-53`). | partial: re-run the check at export, so a theme saved before a rule tightened cannot inject |
| Links in the web app | `web/components/MarkdownBody.tsx:130-132`, evidence URLs (`web/app/baseline/_components/EvidenceChip.tsx:141-145`; the URL is free text at `baseline/schemas.py:143`) and citation refs (`web/components/VersionView.tsx:537`) are placed in `href` with no scheme allowlist. React 19.3 blocks `javascript:` URLs. | partial: add an http(s)/relative allowlist, because agent-written drafts (`write:drafts`) are untrusted |
| Open redirect after sign-in | `web/components/LoginForm.tsx:18` accepts `next` values that start with `/` and not `//`, so `/\evil.example` passes; browsers treat it as `//evil.example`. | **open (low)**: also reject `\` and anything that parses to another origin |
| No `dangerouslySetInnerHTML` | Present mode writes API-rendered HTML and validated CSS into a shadow root (`web/components/PresentMode.tsx:52-57`) on the app origin | mitigated (the content is server-sanitised), but not isolated |

## 7. Preview isolation (for wave 2, CR-10)

There is no prototype preview at b1bc1cf. What exists:
- `web/components/ThemePreview.tsx:90`, `:99`, `:125`: `<iframe sandbox="" srcDoc=…>` for
  theme previews, asserted by `web/e2e/themes.spec.ts:18`, `:91`. Fully sandboxed: no
  scripts and an opaque origin.
- `PresentMode` uses a same-origin shadow root (above).
- `web/next.config.ts` proxies `/v1/*` on the same origin and sets **no CSP or security
  headers**.

Requirements for any generated-code preview (§11.2, §16.20). All of them are **open**:

1. **Serve from a separate origin.** Use a distinct registrable domain, never a path on the
   app origin, so the app's session cookie (SameSite=Lax, host-only) and same-origin
   `/v1` are unreachable. Treat `sandbox="allow-scripts"` as the most to allow, and never
   combine it with `allow-same-origin`.
2. **Set headers.** The preview origin sends a strict CSP: `default-src 'none'`, scripts
   and styles only from the artifact's own hashed assets, `connect-src 'none'` (or a mock
   endpoint), and `frame-ancestors` set to the app origin. The app itself should gain a
   CSP and `frame-ancestors 'none'` for its own pages.
3. **Bound the build.** Builds run in SwarmCloud or an isolated runner with no Oracle
   credentials, no connector tokens and no production network. Set CPU, memory, time and
   output-size ceilings, and store the artifact by hash.
4. **Scan before serving.** Scan for secrets and malware, and label mocked behaviour
   visibly.
5. **Test it with Playwright.** The tests must show that the preview cannot read the app's
   cookies or call `/v1`.
6. **Gate it.** The feature stays behind a disabled gate until all of the above are
   verified (shared rules).

## 8. §12 checklist against the code

| §12 item | Status | Where |
|---|---|---|
| Company and role scoping on every route, tool, retrieval, artifact, comment and run; negative IDOR tests | mitigated, with these gaps: run artifacts are readable by viewers, the tick accepts any API token, and run tokens are not bound to their run | §2, §3 |
| Per-user connector OAuth, encrypted credentials, revocation, admin allowlists, snapshots | per-user, encryption and revocation are mitigated; the **admin allowlist is not built**, as each source owner sets its own (change request AUD-9) | §4 |
| A source revoked after a run was queued cannot be read | partial | §3 |
| Public-link SSRF, redirects, metadata IPs, decompression, MIME types; sanitised rendering | mitigated; partial on decompression memory and on theme CSS at export | §5, §6 |
| Ingested content treated as data | partial | §6 |
| SwarmCloud credential scope, identity, profile, tools, artifacts and lifespan logged without values | partial: labels and ids are logged, and no MCP credential is sent yet. Attestation logging is CR-07. | §3 |
| Generated designs and code have no production database, connector or network access | open (nothing is built yet) | §7 |
| Audit events for composition, questions, assumptions, approvals, external writes, publication, dispatch, spend, deletions | approvals, dispatch, spend decisions and deletions are audited today (`review/service.py`, `runs/service.py`, `templates/service.py`, `connections/router.py`). The v2 subjects do not exist yet. There is **no audit read API**. | `audit.py:12-29` |
| Cost approval defaults; no duplicate dispatch charges | approval and pause are mitigated (`legacy/test_legacy_cost_gates.py`); duplicate dispatch is open | §3 |
| External SaaS gates (ACL mirroring, isolation, deletion, T1) | open, deferred (CR-15, T1) | |

## 9. Findings for an owner or lane to pick up (none fixed here: this lane changes no code)

| # | Finding | Severity | Suggested owner |
|---|---|---|---|
| S-1 | The default `ORACLE_SECRET_KEY` and `cookie_secure=False` are not refused at startup (`config.py:13`, `:16`) | medium | foundation or a hardening PR |
| S-2 | Run tokens act with the creator's full role over every document and baseline node (`mcp/auth.py:132-148`) | medium (once MCP is switched on) | CR-07 adapter v2 |
| S-3 | `POST /v1/internal/tick` accepted an API token of any role; now owners and a `tick`-scoped token only (review round 8) | low, fixed | done |
| S-4 | Run artifacts are readable by any viewer (`runs/router.py:157-165`) | low today, medium after MCP | CR-07 / CR-12 |
| S-5 | The HTML export does not re-check the theme CSS (`export/render.py:771`) | low | hardening PR |
| S-6 | No scheme allowlist on hrefs in the web app (`MarkdownBody.tsx:132`, `EvidenceChip.tsx:143`, `VersionView.tsx:537`) | low | design-system or UI wave |
| S-7 | Open redirect through `next=/\host` (`LoginForm.tsx:18`) | low | design-system or UI wave |
| S-8 | Sessions cannot be revoked server-side (`auth/router.py:41-43`) | low (behind IAP) | later |
| S-9 | No duplicate-submit reconciliation (`runs/service.py:1046-1052`) | medium (cost) | CR-07 |
| S-10 | No CSP or security headers on the web app (`web/next.config.ts`) | low today; required before CR-10 | CR-10 |
