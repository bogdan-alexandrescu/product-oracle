O5 Roadmap sharing: expiring, revocable share links with a view log, a public-safe variant a person checks before it leaves, board / team / engineering variants from one source, and company branding with a logo on every export and shared page

Group O (Outputs) · Size L (6 lanes) · Verified against `f972c5e` (merge train Q) on 2026-10-25 · Answers O5 (`docs/questions.md:105`: "All four: tenant branding (logo, colors, fonts) on every HTML/PDF; expiring, revocable share links with view log; audience variants (board / team / engineering) from one source; public links (need a public-safe variant so internal detail cannot leak)") · Listed as not built in `docs/build-brief.md:333`

Owner choices in this spec are written to the recommended answer of each question in `questions.json` (keys `O5-Q1` … `O5-Q10`), and each such place says so with "(O5-Qn, recommended)".

## Why this matters

- **For the person using Oracle.** A roadmap is made to be read by people who are not in Oracle: the board, the whole team, engineering, and sometimes customers. Today the only way out is a downloaded file (`GET /v1/documents/{doc}/versions/{n}/export`). That causes four problems:
  - **No control once it is sent.** A PDF in an inbox never expires, cannot be withdrawn, and nobody knows whether the board read it before the meeting.
  - **One audience only.** Engineering and the board get the same document. The picker already asks "who reads it first?" (`audience: board | team | engineering | public`), but the answer only picks a template; nothing renders the roadmap differently per reader.
  - **Leaks.** No variant exists that is safe to show outside the company. To publish a roadmap to customers, a founder must copy it by hand and remember to strip owners, goals, effort, customer names, unannounced dates and dependencies. One missed line can expose strategy or a customer.
  - **No branding.** Exports carry Oracle's look and no company logo, so a board pack looks like a tool's output, not the company's.
- **For the product.** The research has already decided the shape (`docs/research/roadmap-formats.md` §7, §8 and "General rules"):
  - one roadmap, rendered as a **variant**: field visibility, level of detail and grouping, applied to any template;
  - a **public-safe** variant built from **allowlisted fields only**, with dates only where they are announced, a mandatory disclaimer, and "explicit approval of each item's public text";
  - a header with the tenant logo, the variant badge, the as-of date, the version and the approval state, and a footer with the share link's expiry.

  A share pins a **publication** (`document_publications`, `api/oracle/review/models.py:328`), so what leaves the company is always a reviewed, immutable version.
- **For engineering.** Most pieces exist:
  - the export pipeline with its pool, its caps and its sanitiser (`api/oracle/export/*`);
  - immutable publications with their own export route (`api/oracle/review/v2_router.py:490`);
  - structured roadmap items per version (`roadmap_items`, `api/oracle/roadmap/models.py:258`);
  - the picker's variant answer (`api/oracle/templates/service.py:595-690`);
  - theme tokens with a contrast check (`api/oracle/templates/validation.py:293`);
  - a proven pattern for a credential-free outside page: the customer interview link (`api/oracle/interviews/public.py`), with a hashed token, expiry, withdrawal, a 404 that matches expired, rate limits and capped refusal audits.

  This pick adds a variant layer, a public-text table, a share-link table with a view log, a brand setting, and the public share routes.

## Verified current state

| Piece | Where | State on main |
|---|---|---|
| Audience knob | `api/oracle/templates/schemas.py:229` (`RoadmapAnswers.audience: board \| team \| engineering \| public`, `public_version: bool`); `:282` (`Recommendation.variant`) | Picker input and output only |
| Variant computed | `api/oracle/templates/service.py:595-690` (`recommend_roadmap`) | `options["variant"]` is returned to the picker, and two warnings mention the public version ("no public variant…", "Each item's public text needs approval…"). **Nothing stores or applies it.** `grep -rn variant api/oracle` finds no other use outside slide themes |
| Start draft | `api/oracle/templates/schemas.py:296-311` (`StartDraftIn`) | No variant field; the document has no audience |
| Document | `api/oracle/docs/models.py:49-92` | `kind`, `theme`, `visibility` (`company` \| `approvers`, H8). No audience, no share state |
| Roadmap templates | `api/oracle/templates/builtin/roadmap/{now-next-later,outcome-roadmap,quarterly-timeline,release-plan,cycle-bets}.md` | Section keys such as `summary`, `goals`, `problems`, `brief-items`, `brief-roadmap`, `not-doing`, `top-risks`, `decisions`. The now-next-later comment asks for "the audience variant" under the title, but nothing renders one |
| Roadmap items | `api/oracle/roadmap/models.py:258-331` (`RoadmapItem`) | Per version: `title`, `outcome`, `horizon`, `milestone {name, date, date_source, basis_ids}`, `confidence`, `priority`, `economics`, `depends_on`, `requirement_ids`, `blocker_ids`, `feature_id`, `track_id`. **No public title, public description or announced flag** (`grep -rn "announced\|public_title" api/oracle` finds nothing) |
| Export | `api/oracle/export/router.py:96-128`; `export/render.py:738` (`render_html`), `:1040` (`banner_line`) | Viewer and up; `format=html\|pdf\|md\|pptx`, `layer=full\|brief\|deck`; 1 per person, 2 per company, 60 s render cap (`export/offload.py`). The banner is a line of text with no logo |
| Publications | `api/oracle/review/models.py:328-360`; `review/v2_router.py:490` | Immutable (DB trigger); `GET /documents/{doc}/publications/{p}/export` serves the pinned exports |
| Images | `api/oracle/export/render.py:559-600` (`STORED_IMAGES = "/uploads/"`) | Only `/uploads/…` images load; others render as a link. **No route serves `/uploads/`** and no brand asset is stored |
| Themes | `api/oracle/templates/models.py:70-97`; `templates/validation.py:293-345`; `/settings/themes` | Company themes with `tokens.colors`, `tokens.fonts` and `page`, checked for WCAG AA. No logo |
| Company settings | `api/oracle/tenant_settings_api.py:94-150` (`DEFAULTS`) | No `branding` key |
| Outside-page precedent | `api/oracle/interviews/public.py:1-140`; `interviews/service.py:333-347`; `web/app/i/[token]/page.tsx` | 32-byte URL-safe token with only its sha256 stored; 7-day expiry; withdrawn link is 410; unknown token is 404 with the expired body; 1 message per 2 s (429); refused requests audited at most 20 a minute per interview; `PUBLIC_OPERATIONS` are never MCP tools (`api/oracle/mcp/tools.py:37-42, 126`) |
| Public hosting | `docs/build-brief.md:21, 65`; `docs/ops-slack-bridge.md` §3; `docs/ops-run-ticker.md` §3 | The app is behind IAP. A second backend without IAP serves `/mcp`, OAuth and `/.well-known/*`, and exact paths are added to its path rule by hand (Slack events, scheduler tick). No ops doc adds the interview link's paths |
| Autonomy | `api/oracle/autonomy.py` (H11) | `external_messages` ceiling is **Draft**: words for people outside are always drafts that a person sends |
| Plan | `web/app/plan/_tabs.ts:9-14`; `web/app/documents/[doc]/page.tsx`, `…/publish` | Roadmap documents live in Plan › Roadmap documents and open on the document page. No Share action |

Counts: 0 share links, 0 audience renders, 0 public texts, 0 brand assets. 5 roadmap templates, 4 picker audiences.

## What to build

### Concepts (plain words, used on screen)

- **Audience**: who a rendering of a roadmap is for. There are four: **Board**, **Team**, **Engineering** and **Public**. Every roadmap version can be shown, exported and shared in any audience. It is **one source**: the version's sections and its roadmap items. The audience only decides what is shown and how it is grouped; it never changes the text.
- **Public version**: the Public audience. It is **built** from allowlisted fields of approved public texts. It is never made by removing things from the internal text, so nothing internal can be left in by mistake.
- **Public text**: for one roadmap item, a public title (up to 80 characters), a public description (up to 280), a stage (Exploring, Planned, In progress, Shipped), and optionally an announced quarter and a changelog link. A person approves each one. An item without an approved public text does not appear in the Public audience.
- **Share link**: a private web address that shows one published version of one roadmap, in one audience, to whoever has the link, until it expires or is revoked. It has a label ("Board, October meeting") so the view log is readable.
- **View log**: when a shared link was opened, and roughly by how many different browsers. It never records a viewer's identity (O5-Q4, recommended).
- **Branding**: the company's display name, logo and accent colour. They appear on every export (HTML, PDF, deck and PPTX), in Present mode and on every shared page.

### 1. Audience variants (one source, four renderings)

New module `api/oracle/roadmap/variants.py` holds the registry. The code is the source of truth, and the UI and API read it.

```python
Audience = Literal["board", "team", "engineering", "public"]

@dataclass(frozen=True)
class Variant:
    key: Audience
    label: str                      # "Board", shown as the header badge
    hidden_sections: frozenset[str] # section keys never rendered
    item_fields: frozenset[str]     # roadmap item fields rendered on cards and tables
    group_by: Literal["goal", "theme", "team", "stage"]
    max_items_per_horizon: int | None
    appendix: bool                  # Sources and data points
```

| Audience | Shows | Hides | Grouping and detail |
|---|---|---|---|
| Board | Goals with metric and target; the top 7 items per horizon by priority; status, confidence, key risks | Owners below lead level, effort, tracker issues, dependencies (collapsed into one risk line per item), items that serve no confirmed goal (and says "N items serve no confirmed goal and are left out"), the Sources appendix | Grouped by goal, one page where it fits |
| Team | Everything the template has: goal, owner, confidence, dependencies, Now dates | Tracker issue keys | Grouped by goal (or theme when `group_by: theme`) |
| Engineering | Team plus effort (`economics`), capacity (when F/E1 estimates exist), tracker epics and issues, estimate against plan, drift flags, dependency arrows | Board-level financial framing (`economics.revenue*` keys) | Grouped by track or team; release-plan appendix |
| Public | Built separately (section 2) | Everything else | Stage columns, a disclaimer, a changelog link |

Rules:

- **Default audience** of a roadmap document is the picker's answer. New nullable column `documents.audience` (`board\|team\|engineering\|public`, CHECK). `StartDraftIn` gains `audience` (`templates/schemas.py:296`), set from `Recommendation.variant` by the New roadmap dialog. Today's roadmaps read as `team`. The default only preselects; every reader may switch audience.
- **Templates can narrow it.** A roadmap template's front matter may add `audiences: {board: {hide: [not-doing]}}` to hide more of its own sections. It can never un-hide a field the registry hides. Company-edited templates without the key use the registry. `api/oracle/templates/validation.py` checks the keys against the template's sections (422 naming an unknown section).
- **Where it applies.**
  - `GET /v1/documents/{doc}/versions/{n}/export` and `…/deck` gain `audience=` (roadmaps only; 422 on other kinds).
  - `GET …/publications/{p}/export` gains it too.
  - `apply_layer` (`export/render.py`) gains `apply_audience(ev, audience)` after the layer. It drops hidden sections, then re-renders the item tables from `roadmap_items` with the variant's fields. A section that only holds item rows (`brief-items`, the horizon sections) is rebuilt from items. Prose sections are kept or dropped whole and never edited.
  - `banner_line` adds "audience Board".
- **Who may switch.** Viewers and up see every non-public audience in the app (it hides, never adds). The Public audience in the app needs approver or above until the version has a public check (section 2), because before it is checked it shows "not ready" warnings that name internal items.
- **Hard rule.** Items that serve no confirmed goal are hidden from Board and Public and shown in Team and Engineering with the ⚑ flag (research "General rules").

### 2. The public-safe variant (what is removed, and how a person checks it)

**Built, not filtered.** `api/oracle/roadmap/public.py` renders the Public audience from a fixed template, `api/oracle/export/templates/public_roadmap.html.j2`. That template has only these fields:

| Field | Source | Rule |
|---|---|---|
| Company name, logo, accent | `branding` (section 4) | none |
| Roadmap title | new `documents.public_title`, else "<Company> roadmap" | The internal document title is never used |
| Columns | stage: Shipped recently · In progress · Planned · Exploring | From each public text's stage; the internal horizon is not shown |
| Item card | public title, public description, stage, announced quarter (only when `announced_quarter` is set), changelog link (only an `https` link to an H6 public changelog entry or an address the approver typed) | none |
| Intro | new `documents.public_intro` (up to 600 characters, approved with the check) | Optional |
| Disclaimer | `branding.public_disclaimer`, default "This roadmap shows our current plans. It is not a commitment, and plans and timing can change." | Mandatory; cannot be empty |
| Footer | "Shared <date> · expires <date>" | no version number, no "generated from" line (O5-Q8, recommended: a small "Made with Product Oracle" mark that the owner can switch off) |

**What is always removed** (the public template has no slot for it, so none of it can appear): goals, metrics and targets; owners and every person's name; effort, estimates, capacity and economics; tracker keys and links; dependencies and blockers; confidence and priority numbers; internal item titles and outcomes; every prose section of the template; citations, the Sources and data points appendix, presenter notes and decisions; dates other than an announced quarter; items without an approved public text; items that serve no confirmed goal; customer, account and alternative names (blocked by the leak check below).

**Public texts.** New table `roadmap_public_texts`: one row per (roadmap document, `item_key`), so a text carries over between versions while the item exists.

```sql
CREATE TABLE roadmap_public_texts (
  id uuid PRIMARY KEY, tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  document_id uuid NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  item_key text NOT NULL,
  title text NOT NULL CHECK (char_length(title) BETWEEN 1 AND 80),
  description text NOT NULL DEFAULT '' CHECK (char_length(description) <= 280),
  stage text NOT NULL CHECK (stage IN ('exploring','planned','in_progress','shipped')),
  announced_quarter text CHECK (announced_quarter ~ '^[0-9]{4}-Q[1-4]$'),
  changelog_url text,
  state text NOT NULL DEFAULT 'draft' CHECK (state IN ('draft','approved','excluded')),
  drafted_by text NOT NULL,             -- 'oracle' or a member id
  approved_by uuid, approved_at timestamptz,
  source_hash text NOT NULL,            -- hash of the item's title+outcome when written
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (document_id, item_key)
);
```

- **Drafting** (O5-Q7, recommended): **Draft public texts** runs a built-in model job `public_text` on Oracle's Claude account pool, as the C1c jobs do. It writes `draft` rows for items that have none, in customer language and within the length limits, and never fills `announced_quarter`. Its prompt says: "Never name a customer, a person, a competitor, an internal project code or a number from the internal text." The job can be switched off per document (`disabled_llm_jobs`). It follows H11 `external_messages`, whose ceiling is Draft, so it only ever drafts.
- **Approving.** An approver of the roadmap (O5-Q1, recommended) edits and then approves each row, or marks it **Excluded** (an item kept private on purpose). Every change is audited (`roadmap.public_text.approved | edited | excluded`).
- **Going stale.** When an item's internal title or outcome changes in a new version (`source_hash` differs), its approved text goes back to `draft` with the chip "Internal item changed". The Public audience leaves it out until someone approves it again.
- **Announced quarter.** Only a person sets it, with the confirmation "Has this quarter been said in public?". It is shown as a quarter, never as a day.

**Leak check** (deterministic, no model): `api/oracle/roadmap/leak_check.py` runs on every public text, the public title and the intro.

| Finding | Matched against | Severity |
|---|---|---|
| `person_name` | active and removed members' names and emails | blocking |
| `email_or_phone` | email and phone patterns | blocking |
| `customer_name` | win/loss `account` labels (H9), request askers' company labels (C1), interview company labels (C3) | blocking |
| `alternative_name` | H7 alternatives' names and aliases | blocking (O5-Q7 context: comparing to competitors in public is a choice made outside Oracle) |
| `internal_code` | tracker keys (`[A-Z]{2,10}-\d+`), goal codes (`G\d+`), decision numbers (`D-\d+`), document slugs | blocking |
| `internal_host` | links to the company's own app host, `localhost`, private addresses, or a host on `company_email_domains` that is not a public site | blocking |
| `money_or_metric` | currency amounts and percentages | warning |
| `date` | a day or month outside `announced_quarter` | warning |
| `internal_title_copy` | the public title equals the internal title | warning ("Is the internal title fine to show?") |

A text with a blocking finding cannot be approved (422 naming the finding and the matched words). A warning needs a tick: "I checked this".

**How a person checks it: the Public check.** On the document page, **Share › Public version** opens `/documents/[doc]/public` (approvers and owners):

- **Left: the review list.** One row per item of the version, showing the internal title, then the public text and its state (Approved, Draft, Excluded, Missing, Internal item changed), its leak findings, Edit and Approve. Filters: To approve, Findings, All. The header shows "<n> shown · <m> left out", with the left-out items counted by reason: no approved text, excluded, serves no confirmed goal.
- **Right: the exact page a link holder sees.** It is rendered by the same public route code (`render_public`) from the same rows, not a preview approximation.
- **"What is removed" panel.** A fixed list of the removed categories above, each with its count for this version ("12 owners · 9 goals · 4 dates not announced · 31 tracker links · 6 dependencies").
- **Mark as checked.** It is enabled when every shown item is approved and has no blocking finding. It records a **public check**: new table `roadmap_public_checks (document_id, version_id, publication_id, checked_by, checked_at, shown_item_keys text[], content_hash)`, audited as `roadmap.public_checked`.
- **A Public share link needs a public check of exactly that publication** whose `content_hash` still matches the render. If any public text changes afterwards, the check lapses ("Changed since checked") and live Public links show "This page is being updated" until the version is checked again (section 3).

### 3. Share links

**Table** `share_links`:

```sql
CREATE TABLE share_links (
  id uuid PRIMARY KEY, tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  document_id uuid NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  publication_id uuid NOT NULL REFERENCES document_publications(id),
  audience text NOT NULL CHECK (audience IN ('board','team','engineering','public')),
  label text NOT NULL CHECK (char_length(label) BETWEEN 1 AND 120),
  token_hash text NOT NULL UNIQUE,              -- sha256 of 32 random bytes; the token is shown once
  created_by uuid NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  revoked_by uuid, revoked_at timestamptz, revoked_reason text,
  allow_download boolean NOT NULL DEFAULT true,  -- PDF download from the shared page
  follow_latest boolean NOT NULL DEFAULT false,  -- O5-Q6: off, the link stays on its publication
  views integer NOT NULL DEFAULT 0, last_viewed_at timestamptz,
  refused_window_start timestamptz, refused_in_window integer NOT NULL DEFAULT 0
);
CREATE INDEX ix_share_links_doc ON share_links (tenant_id, document_id, created_at DESC);

CREATE TABLE share_link_views (
  id uuid PRIMARY KEY, tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  share_link_id uuid NOT NULL REFERENCES share_links(id) ON DELETE CASCADE,
  viewed_at timestamptz NOT NULL DEFAULT now(),
  kind text NOT NULL CHECK (kind IN ('page','download')),
  browser_key text NOT NULL,     -- HMAC(link secret, cookie id): counts distinct browsers, not people
  browser_family text,           -- "Chrome", "Safari", "Other"; from the user agent, nothing else
  country text                   -- only when the load balancer gives one (O5-Q4); never an IP
);
CREATE INDEX ix_share_link_views ON share_link_views (share_link_id, viewed_at DESC);
```

A share pins a **publication**, never a draft. "Share" on an unpublished version says "Publish this version first" and links to `/documents/[doc]/publish`. With O5-Q6 at its recommendation, a link keeps showing its publication until it expires. A newer publication shows the creator a line on the link's row, "v4 is published · Move link to v4", which is one click, audited and keeps the token.

**Security model**

| Topic | Rule |
|---|---|
| Who may create | Approvers and owners for Board, Team and Engineering; **owners only** for Public (O5-Q1, recommended). Only from the signed-in browser or a personal API token of that role. **Never** a run token or an agent: `create_share_link` is in `BROWSER_OR_PERSON_OPERATIONS`, and run tokens get 403 "Sharing outside the company is a person's act" (H11 `external_messages` ceiling Draft). Viewers and commenters see no Share action |
| Which documents | Roadmap documents with `visibility = 'company'` only. An `approvers` document (H8) is 403 |
| Expiry | Required. Choices: 24 hours, 7 days, **14 days (preselected)**, 30 days, 90 days (the maximum) (O5-Q3, recommended). No link lives forever. Extending is allowed up to 90 days from the moment of the extension, audited |
| Revocation | Revoke on the link's row (creator, any owner, or any approver for non-public links), with an optional reason. It takes effect on the next request (no cache; the page is `Cache-Control: no-store`). Revoking cannot be undone; make a new link instead. **Revoke all links** on the document is owners only |
| People leaving | A member's disable or demotion below approver **revokes the links they created** (reason "creator removed" or "creator's role changed"), listed to owners in the Inbox with **Re-share** (O5-Q10, recommended) |
| Document changes | Trashing the document, or setting it to `approvers`, revokes every link on it at once. Restoring does not bring them back |
| Token | 32 random bytes, URL-safe, shown once in the creation dialog (with Copy); only its sha256 is stored. URL: `https://<host>/s/<token>`. A lost link cannot be shown again, so make a new one |
| Unknown, expired, revoked | An unknown token is **404 with the same body and timing class as expired**, so a guess learns nothing. Expired is 410 `expired` and revoked is 410 `withdrawn`, with the page "This link has ended. Ask the person who sent it for a new one" and no company name |
| Rate limits | Per link: 60 page requests a minute and 10 downloads an hour (429 with `Retry-After`). Per client address: 120 requests a minute across all share routes, held in memory per API instance and not stored. Refused requests are audited at most 20 a minute per link (counted on its row, as for interviews) |
| Render cost | The shared page and its PDF render on the export pool. Each link's rendering is cached per (publication, audience, brand revision), so a busy link does not take export places; a cache miss takes the company's export place under the existing limits, and a busy pool is 503 "Try again in a moment" |
| What the page sends | `Content-Security-Policy: default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'; frame-ancestors 'none'`; `X-Robots-Tag: noindex, nofollow`; `Referrer-Policy: no-referrer`; `Cache-Control: no-store`. No scripts, no third-party fonts or images, no outbound links except the changelog links (`rel="noopener noreferrer nofollow"`). One cookie `po_share` (HttpOnly, Secure, SameSite=Strict, path `/s/<token>`, random id) used only for the distinct-browser count |
| Access | Anyone with the link (O5-Q5, recommended). There is no sign-in and no passcode in this pick |
| Where it is served | `/s/*` (web page) and `/v1/public/shares/*` (API) on the **public backend** of the existing load balancer, added as two path-rule entries by an ops runbook (O5-Q2, recommended). Every other route stays behind IAP |
| MCP | The public routes are `PUBLIC_OPERATIONS` (`api/oracle/mcp/tools.py:37`) and never MCP tools. Members' share-management routes are MCP tools as usual (I2), for people's own MCP clients |
| Audit | `share_link.created \| extended \| moved \| revoked \| viewed_first`, with the link id and never the token. Each view goes into `share_link_views`, not the audit log |

**What a link holder can never see**, whatever the audience and however the request is shaped:
- any other version, any draft, the version list or the diff;
- any other document, or any other company's data;
- comments, feedback, suggestions, review states, approvals and who approved;
- citations, citation markers (rendered as plain text), the Sources and data points appendix, source titles and excerpts;
- presenter notes, decisions and the decision log, and readiness or quality results;
- member names and emails (except owners named in the Team and Engineering audiences' item owners, which those audiences show by design), member ids, and the link's creator;
- the link's view log, other share links, and the internal document title or slug in the Public audience;
- the Oracle chat, runs, the baseline, and any `/v1` route other than its own three routes (below).

The render path for shares takes **no principal**. It reads through a dedicated `ShareContext(tenant_id, publication_id, audience)` and can only call `render_share(…)`. A test fails if `render_share` reaches the session-scoped document loaders.

**Download.** With `allow_download` (default on; O5-Q9, recommended), the page shows **Download PDF**: the same audience and the same branding, with the footer "Shared with you by <company> on <date> · link expires <date>". The PDF cannot be revoked once downloaded, and the creation dialog says so beside the switch.

### 4. Company branding

New company setting `branding` (`tenant_settings_api.py` `DEFAULTS`; owners edit):

```jsonc
{ "display_name": "Example Labs",          // default: the tenant name
  "logo": {"sha256": "…", "type": "image/png", "width": 320, "height": 80} | null,
  "logo_dark": { … } | null,                // optional variant for dark slides
  "accent": "#0369a1" | null,               // mapped onto theme tokens; contrast-checked
  "public_disclaimer": "…",
  "oracle_mark": true,                      // O5-Q8: "Made with Product Oracle" on shared pages
  "revision": 3 }                           // bumps on every change (cache key)
```

- **Logo storage.** New table `brand_assets (id, tenant_id, sha256, content_type, bytes bytea, width, height, created_by, created_at)`. Upload goes through `POST /v1/branding/logo` (multipart, owners).
  - Accepted: PNG, JPEG or WebP, at most 512 KB and 2,000 × 2,000 px. The image is decoded and re-encoded to PNG with Pillow, which strips metadata and refuses decompression bombs (`Image.MAX_IMAGE_PIXELS`).
  - SVG is refused: "Upload a PNG, JPEG or WebP" (engineering default; SVG can carry script).
  - Served to members at `GET /uploads/brand/<sha256>.png`, under the `STORED_IMAGES` prefix (`export/render.py:562`) and behind IAP.
  - **Inlined as a `data:` image** in exports, PDFs, decks, PPTX and shared pages, so a shared page and a PDF never fetch anything. This is the one data image the renderer allows, and it is only allowed from the renderer's own header partial; the body rule against `data:` images stays.
- **Where it shows.**
  - The header of every HTML/PDF export (`export/templates/*.j2`): logo (at most 40 px high), the roadmap title, the audience badge, the as-of date, the version and the approval state, as in the research's "General rules".
  - The title slide of decks and PPTX (`export/deck.py`, `export/pptx.py`), and Present mode.
  - The shared page header.
  - Every document kind's exports get the logo, not only roadmaps (O5: "on every HTML/PDF").
- **Accent and fonts.**
  - `accent`, when set, replaces the theme's `colors.accent` at render time and is checked with `check_theme_tokens` (`templates/validation.py:293`). It is refused on save if it fails AA against any built-in theme's background: "This colour is too light to read on white. Pick a darker one."
  - Fonts stay with themes: a company theme already sets `tokens.fonts`, and no web font is fetched from outside.

### Screens and copy

**Document page, roadmap** (`web/app/documents/[doc]/page.tsx`):
- An **Audience** switch in the header (Board · Team · Engineering · Public), preselected from `documents.audience`. It changes the view and the export menu's output, and the URL holds `?audience=`.
- A **Share** button (approvers and owners, published versions only) opens the Share sheet:
  - **Audience**;
  - **Label** (required; placeholder "Board, October meeting");
  - **Expires** (24 h · 7 d · **14 d** · 30 d · 90 d);
  - **Allow PDF download** (on), with the note "A downloaded PDF can't be revoked";
  - Public only: the public check's state, with **Check public version** when missing.
  - **Create link** shows the link once with Copy and the line "Only people you send this to can open it. It ends on <date>."
- **Share › Links** tab of the review panel: Label · Audience · Version · Created by · Expires · Views (distinct browsers) · Last viewed · state (Active, Expired, Revoked). Row actions: Copy is not possible (the token is gone), so the actions are **View log**, **Extend**, **Move to v<n>** and **Revoke**.
- **View log** (sheet): a list of Date and time (Company time zone, labelled) · Page or Download · Browser · Country, plus a per-day bar of views and the distinct-browser count. The header line reads "Counts browsers, not people. Oracle never records who opened a link."

**Public check** (`web/app/documents/[doc]/public/page.tsx`): the two panes from section 2. Phone: one pane with a **Review / Preview** switch.

**Shared page** (`web/app/s/[token]/page.tsx`, server-rendered with no client script): the branded header, the audience's rendering, the disclaimer (Public), the footer with the expiry, and **Download PDF**. The ended page reads "This link has ended. Ask the person who sent it for a new one."

**Settings › Company › Branding** (`web/app/settings/company/page.tsx`, owners edit, others read):
- Logo upload with a live preview on a light header and on a dark slide;
- Display name;
- Accent, with a contrast result;
- Public disclaimer;
- "Show 'Made with Product Oracle' on shared pages".

**Plan › Roadmap documents** (`web/app/plan/documents/page.tsx`): a **Shared** column with the count of active links and the next expiry.

**Inbox** (owners): "Links revoked: <name> left · 3 links" with **Re-share** and **Dismiss** (section 3, people leaving).

Every date is in the Company time zone, labelled. Every person is shown by name, never by id.

### API

```
GET    /v1/roadmap-audiences                                   -> [AudienceOut]           (viewer; the registry)
GET    /v1/documents/{doc}/versions/{n}/export?audience=…      (existing; audience added, roadmaps only)
GET    /v1/documents/{doc}/versions/{n}/deck?audience=…        (existing; audience added)
GET    /v1/documents/{doc}/publications/{p}/export?audience=…  (existing; audience added)

GET    /v1/roadmaps/{doc}/public-texts?version=n               -> PublicTextsOut          (approver)
POST   /v1/roadmaps/{doc}/public-texts/draft                   -> JobOut                  (approver; built-in job public_text)
PUT    /v1/roadmaps/{doc}/public-texts/{item_key}  {title, description, stage, announced_quarter?, changelog_url?, state, checked_warnings[]}
                                                                -> PublicTextOut           (approver; 422 blocking leak finding)
GET    /v1/roadmaps/{doc}/versions/{n}/public-preview          -> text/html               (approver; exactly the shared page)
POST   /v1/roadmaps/{doc}/publications/{p}/public-check        -> PublicCheckOut          (approver; 409 not_ready listing what is left)

GET    /v1/documents/{doc}/share-links                         -> [ShareLinkOut]          (approver)
POST   /v1/documents/{doc}/share-links  {publication_id, audience, label, expires_in, allow_download}
                                                                -> ShareLinkCreated {link, url, expires_at}  (approver; owner for public; 409 no_public_check; 403 run tokens)
PATCH  /v1/share-links/{id}  {expires_in? | publication_id?}   -> ShareLinkOut            (creator or owner)
POST   /v1/share-links/{id}/revoke  {reason?}                  -> ShareLinkOut            (creator, owner, or approver for non-public)
POST   /v1/documents/{doc}/share-links/revoke-all  {reason}    -> {revoked: n}            (owner)
GET    /v1/share-links/{id}/views?from&to                      -> ShareViewsOut           (creator, owner, or approver)

GET    /v1/branding                                            -> BrandingOut             (viewer)
PUT    /v1/branding  {display_name, accent, public_disclaimer, oracle_mark}  -> BrandingOut   (owner)
POST   /v1/branding/logo  (multipart: file, variant=light|dark) -> BrandingOut            (owner; 422 type/size)
DELETE /v1/branding/logo?variant=…                             -> BrandingOut             (owner)
GET    /uploads/brand/{sha256}.png                             -> image/png               (viewer)

# Public backend, no credential (PUBLIC_OPERATIONS, never MCP tools)
GET    /v1/public/shares/{token}                               -> text/html               (the page; 404/410/429)
GET    /v1/public/shares/{token}/pdf                           -> application/pdf         (when allow_download)
GET    /v1/public/shares/{token}/status                        -> {state: active|ended}   (for the web page's server render)
```

### MCP and agents

- The member routes above are generated tools (I2). `create_share_link` and `revoke_share_link` refuse run tokens (403).
- Agents get **no** tool that reads public texts or share links. The `prd_to_roadmap` task gains one sentence: "Never write text for people outside the company; public item texts are drafted by Oracle's public-text job and approved by a person."

## Out of scope / do not touch

- Sign-in or passcodes for link holders, and email-verified viewers (O5-Q5's other options; a later pick).
- A permanent, indexed public roadmap page that follows every new version (O5-Q6's other option). Links still expire.
- Sharing PRDs, specs, strategy or updates by link. The share table is document-generic, but the Share action and the audience layer ship for roadmaps only.
- Custom domains for shared pages, and web fonts.
- Votes or comments from link holders.
- Changing how publications are made (`review/publish.py`) or the export pool's limits (`export/offload.py`).
- Deploy files: the ops runbook documents the two path-rule entries, and an owner applies them.

## Acceptance criteria

1. `GET /v1/documents/{doc}/versions/{n}/export?format=html&audience=board` on a seeded roadmap renders no item owner, no `economics` field, no tracker key and no item without a confirmed goal, and shows "2 items serve no confirmed goal and are left out". `audience=engineering` shows effort and tracker links. A PRD with `audience=` is 422.
2. A company-edited roadmap template whose front matter hides `not-doing` for board drops that section from the Board render only. A template that names an unknown section in `audiences` is 422 on save.
3. A public text containing a member's name, a win/loss account label, an H7 alternative's alias or a tracker key cannot be approved (422 `leak_blocking` naming the finding and the words). A text with only a percentage is approved once `checked_warnings` includes `money_or_metric`.
4. The Public render of a version contains only the allowlisted fields: a test renders a seeded roadmap whose internal titles, owners, goals and dates are unique marker strings, and asserts **none** of the markers appears in the public HTML or PDF text.
5. `POST …/public-check` is 409 `not_ready` while any shown item lacks an approved text or has a blocking finding. After it succeeds, editing one public text sets the check to lapsed, and a live Public link's page shows "This page is being updated" until the version is checked again.
6. `POST …/share-links` on an unpublished version is 409 `not_published`; with `audience=public` by an approver it is 403; by an owner without a public check it is 409 `no_public_check`; with a run token it is 403; on an `approvers` document it is 403; with `expires_in` over 90 days it is 422.
7. A created link's token is returned once. The database holds only its sha256. `GET /v1/share-links/{id}` never returns the token or the URL.
8. `GET /v1/public/shares/<token>` serves the page with the CSP, `X-Robots-Tag: noindex, nofollow`, `Referrer-Policy: no-referrer` and `Cache-Control: no-store` headers, and makes no request to any other host (asserted by rendering with network access blocked).
9. An unknown token and an expired token get the same status class and an identical body; a revoked token is 410 `withdrawn`; after revoke, the very next request is refused.
10. The 61st page request in a minute on one link is 429 with `Retry-After`. Refused requests write at most 20 audit rows a minute per link.
11. Disabling the member who created two links revokes both with reason "creator removed", and the owners' Inbox shows the row with Re-share. Trashing the document revokes every link on it.
12. Each page view writes one `share_link_views` row with `browser_key`, `browser_family` and no IP address; two views from the same browser count as one distinct browser in `GET …/views`.
13. The shared page's HTML contains no comment, citation marker, presenter note, Sources appendix, member email or internal document slug (Public audience). A test walks the rendered HTML for each of those patterns.
14. `POST /v1/branding/logo` with an SVG is 422; with a 3 MB PNG it is 422; with a valid PNG the next HTML export's header holds the logo as a `data:image/png` image, the PDF shows it, and the PPTX title slide includes it.
15. An accent of `#e0f2fe` is refused with the contrast message; `#0369a1` is saved and appears in exports.
16. `render_share` never calls a principal-scoped loader (unit test with a loader that raises).
17. Playwright (mock): on a published seeded roadmap, an owner switches Audience to Board and the owners column disappears; opens Share, picks Board, labels it "Board, October meeting", keeps 14 days, creates the link and copies it; the Links tab shows the row as Active with 0 views.
18. Playwright (mock): the owner opens Share › Public version, sees "3 shown · 2 left out", edits a text that names a seeded customer and gets the blocking finding, fixes it, approves every row, clicks **Mark as checked**, then creates a Public link. Opening that link's `/s/<token>` page shows the branded header, the stage columns and the disclaimer, and none of the internal marker strings.
19. Playwright (mock): the owner revokes the Board link; opening its `/s/<token>` shows "This link has ended. Ask the person who sent it for a new one."; the View log shows the earlier view with "Counts browsers, not people."
20. Playwright (mock): Settings › Company › Branding: the owner uploads a PNG logo and sets an accent, and the preview and then the document page's HTML export show the logo.

## Testing plan

| Layer | What | Count | Card |
|---|---|---|---|
| Unit | `variants.apply_audience` per audience × template; `leak_check` per finding; `public.render_public` allowlist; token hashing; rate-limit window | +24 | protects: hiding and allowlisting; fails_when: a hidden field or a marker string appears; no_claim: route wiring |
| Integration (`api/tests/test_share_links.py`, `test_public_texts.py`, `test_branding.py`, `test_export_audience.py`) | Criteria 1-16 | +30 | protects: every refusal path and every never-see item; fails_when: a link-holder response holds anything outside its audience, or a refusal is missing; no_claim: the load balancer's path rule |
| E2E (Playwright, mock) | `web/e2e/roadmap-sharing.spec.ts`, `web/e2e/public-roadmap-check.spec.ts`, `web/e2e/branding.spec.ts` | +4 | protects: a person can switch audience, share, check the public version, revoke and brand through the UI; fails_when: any step needs an API call or hand-edited data; no_claim: real IAP and public-backend routing |

## Rules for the implementing agent

1. Acceptance criteria are the `protects / fails_when / no_claim` profile of each test, never "make the tests pass".
2. Real code and real tests land in the same change; no placeholder assertions or deferred tests.
3. Any change to a test, validator, CI step, timeout, threshold or snapshot is reported on its own line with its justification, before any other result.
4. A reported command names the command and its observed result; a command not run is not reported.
5. Your report is a claim until re-executed: say what you verified, what you reused, what you could not check.
6. SwarmCloud lanes cannot deploy: each lane with a screen proves it with a Playwright test that drives the built app's UI (CLAUDE.md, Feature loop). No test sets data or settings by calling the API directly.
7. Seed and test data are invented ("Example Labs", "Account 14", "Northwind"). Never real company or customer data.

## Lanes

| # | Lane | Size | Depends on | Touches |
|---|---|---|---|---|
| 1 | **Audience variants**: registry, `documents.audience`, `StartDraftIn.audience`, `apply_audience` in exports, decks and publications, template `audiences` front matter | M | none | `api/oracle/roadmap/variants.py` (new), `api/oracle/export/render.py`, `export/router.py`, `export/deck.py`, `review/v2_router.py:490`, `templates/schemas.py:229,282,296`, `templates/service.py:595-690`, `templates/validation.py`, `docs/models.py`, migration `0071_roadmap_audience` |
| 2 | **Public-safe variant**: `roadmap_public_texts`, `roadmap_public_checks`, `leak_check`, `public_text` built-in job, `render_public`, preview and check routes | M | 1 | `api/oracle/roadmap/public.py`, `roadmap/leak_check.py`, `roadmap/router.py`, `api/oracle/jobs/` (new kind), `export/templates/public_roadmap.html.j2`, migration `0072_public_texts` |
| 3 | **Share links**: tables, member routes, the public routes on `/v1/public/shares`, rate limits, view log, revocation on member disable or demotion and on trash or visibility change, `PUBLIC_OPERATIONS` | L | 1 (public audience needs 2) | `api/oracle/shares/{models,service,router,public}.py` (new), `api/oracle/main.py`, `mcp/tools.py:37`, `members/` (disable hook), `docs/service.py:355` (visibility hook), `trash/`, migration `0073_share_links` |
| 4 | **Branding**: `branding` setting, `brand_assets`, logo upload, `/uploads/brand/…`, header partial in every export template, PPTX and deck title, accent mapping | S | none | `tenant_settings_api.py:94`, `api/oracle/branding.py` (new), `export/templates/*.j2`, `export/pptx.py`, `export/deck.py`, `export/render.py:562`, migration `0058_brand_assets` |
| 5 | **Web**: Audience switch, Share sheet, Links tab and View log, Public check page, `/s/[token]` page, Settings › Company › Branding, Plan › Roadmap documents Shared column, Inbox row; mock data and Playwright | L | 1-4 | `web/app/documents/[doc]/page.tsx`, `web/app/documents/[doc]/public/page.tsx` (new), `web/app/s/[token]/page.tsx` (new), `web/app/settings/company/page.tsx`, `web/app/plan/documents/page.tsx`, `web/app/inbox/_needs.tsx`, `web/e2e/*.spec.ts` |
| 6 | **Ops runbook**: `docs/ops-share-links.md` adds `/s/*` and `/v1/public/shares/*` to the public backend's path rule (backup, import, check, rollback), as `docs/ops-slack-bridge.md` §3 does | S | 3 | `docs/ops-share-links.md` (new), `docs/build-brief.md:333` (move O5 out of "Not built") |

Lanes 1 and 4 start in parallel; 2 and 3 follow 1; 5 follows them; 6 can be written at any time but is applied by an owner after 3 merges.

## Owner decisions (questions.json)

Each is written to its recommended answer above.

| Key | Question | Assumed (recommended) |
|---|---|---|
| O5-Q1 | Who may create share links, per audience | Approvers and owners for Board, Team and Engineering; owners only for Public. Public texts are approved by approvers |
| O5-Q2 | Where shared pages are served from | Two exact path-rule entries on the existing public backend (`/s/*`, `/v1/public/shares/*`) |
| O5-Q3 | Link expiry | Required; 14 days preselected; 90 days at most; extendable |
| O5-Q4 | What the view log records about viewers | Time, page or download, browser family, distinct-browser count via a per-link cookie, country only if the load balancer supplies it; never an IP or identity |
| O5-Q5 | Who can open a link | Anyone with the link; no passcode or sign-in in this pick |
| O5-Q6 | A link and newer versions | Pinned to its publication; a one-click "Move to v<n>" |
| O5-Q7 | Who writes public item texts | Oracle drafts them with a built-in job on its Claude account pool; a person approves each |
| O5-Q8 | Oracle's mark on shared pages | A small "Made with Product Oracle" on shared pages, which the owner can switch off; none on exports |
| O5-Q9 | PDF download from a shared page | Allowed by default, switchable per link, with the note that a download cannot be revoked |
| O5-Q10 | Links of a member who leaves or is demoted | Revoked at once, with an owner Inbox row to re-share |

## What it unblocks

- **Board packs and investor updates (H8):** an update can link a Board-audience roadmap that expires after the meeting, instead of attaching a PDF; its view log tells the founder who has read it before the meeting.
- **Public changelog and launches (H6):** public roadmap cards link to the public changelog entries, and a Shipped stage can be filled from launches.
- **Engineering alignment (E1 / F6):** the Engineering audience is the place that shows tracker epics, estimates and drift, which E1's read-back fills.
- **Customer interviews and requests (C1, C3):** a Public link can be sent to a customer who asked for a feature, and the request records that it was shared.
- **Branding everywhere (O1b, O6):** the brand setting is reused by PRD exports, Present mode and future Figma frames.
- **Sharing other document kinds:** the share table and public routes are document-generic, so sharing a PRD brief or a strategy page later is a Share button and a variant registry.

## Rollback

Migrations `0055`-`0058` add columns and tables only, so revert the PRs and downgrade. Before rolling back lane 3, remove the two path-rule entries (runbook §Rollback) so `/s/*` falls back to IAP: every link stops working at once, which is the safe failure. Exports without lane 4 lose the logo and nothing else.

## Effort

Lane 1: 1.5 d · Lane 2: 2 d · Lane 3: 2.5 d · Lane 4: 1 d · Lane 5: 3 d · Lane 6: 0.25 d (about 10 days of lane time; 4-5 days elapsed with lanes in parallel).

## Files reference

| File | Change |
|---|---|
| `api/oracle/roadmap/variants.py` | new: audience registry and `apply_audience` |
| `api/oracle/roadmap/public.py` | new: `render_public`, public check |
| `api/oracle/roadmap/leak_check.py` | new: deterministic leak findings |
| `api/oracle/shares/` | new package: models, service, member router, public router |
| `api/oracle/branding.py` | new: setting validation, logo store, header partial data |
| `api/oracle/templates/schemas.py:229,282,296` | `RoadmapAnswers` unchanged; `Recommendation.variant` documented as the default audience; `StartDraftIn.audience` |
| `api/oracle/templates/service.py:595-690` | the variant is stored on the new document |
| `api/oracle/templates/validation.py` | `audiences` front matter check; accent check reuse |
| `api/oracle/docs/models.py:49` | `audience`, `public_title`, `public_intro` |
| `api/oracle/export/render.py:562, 738, 1040` | header partial with logo; `apply_audience`; banner audience |
| `api/oracle/export/router.py`, `export/deck.py`, `export/pptx.py` | `audience` parameter; branded title |
| `api/oracle/export/templates/public_roadmap.html.j2` | new |
| `api/oracle/review/v2_router.py:490` | publication export `audience` |
| `api/oracle/tenant_settings_api.py:94` | `branding` default and validation |
| `api/oracle/mcp/tools.py:37` | share public operations |
| `api/oracle/main.py` | include the share and branding routers |
| `api/migrations/versions/0055…0058` | new |
| `web/app/documents/[doc]/page.tsx`, `…/public/page.tsx`, `web/app/s/[token]/page.tsx` | Audience switch, Share, Public check, shared page |
| `web/app/settings/company/page.tsx` | Branding card |
| `web/app/plan/documents/page.tsx`, `web/app/inbox/_needs.tsx` | Shared column, revoked-links row |
| `docs/ops-share-links.md` | new runbook |
