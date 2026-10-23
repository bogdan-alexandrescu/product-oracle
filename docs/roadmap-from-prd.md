# Roadmap from an approved PRD (O4b)

The `prd_to_roadmap` flow turns an approved PRD version into a roadmap draft that is
reviewed and approved like a PRD (brief/full, Present, comments, verdicts, diffs and the
Brief / Full / Deck exports work unchanged on a roadmap).

## Starting a run

`POST /v1/runs` (approver and above; MCP `create_run`):

```json
{"flow": "prd_to_roadmap", "source": "checkout-redesign", "source_version": 3,
 "document": "checkout-redesign-roadmap", "template": "now-next-later",
 "theme": "roadmap-board", "knobs": {"depth": "standard"}}
```

- `source`: the PRD (slug or id). `source_version`: an approved version; omitted, the
  PRD's latest approved version. A PRD with no approved version, or a named version that
  is not approved, is refused with 422.
- `document`: the roadmap to write, new or existing (kind `roadmap`); omitted,
  `<prd slug>-roadmap`. An existing roadmap gets its next version.
- `template` (a roadmap template; default `now-next-later`, O4, or the existing
  roadmap's) and `theme` (default `roadmap-board`, or the existing roadmap's).
- Knobs as for the other flows (depth, roles, checkpoints, budget). Estimate and start
  as usual; a run over $50 waits for an owner (P3).

## Segments

| Segment | Roles | Checkpoint | Writes |
|---------|-------|------------|--------|
| `roadmap_items` | analyst, prioritizer | `roadmap_items` | `roadmap_items.yaml` |
| `roadmap_draft` | writer, critic | `roadmap_review` | `roadmap.md`, imported as the roadmap's next version |

The `roadmap_items` prompt carries the PRD version (its markdown and section ids), the
confirmed goals and B2 horizons, the priority order (this PRD's approved order, else the
latest saved company-wide priority snapshot, else the live goal-weighted ranking, every
score with its explanation; a run's order that is not approved never counts) and the
baseline's `depends_on` / `blocks` edges. The `roadmap_draft` prompt adds the approved items file,
the template skeleton (front matter with the template's brief markers, O1f) and the link
form below.

### roadmap_items.yaml

```yaml
version: 1
prd: {document: checkout-redesign, version: 3}
items:
  - id: payment-step
    title: Payment step
    outcome: Buyers pay without re-entering their card
    horizon: now                    # now | next | later
    milestone: {name: Beta, date: 2026-11-30, date_source: ENG-412 estimate}
    depends_on: []
    priority: {score: 4.2, rank: 1, explanation: "..."}
    confidence: high                # high | medium | low (or 0-1)
    prd_section: s-5-1
```

Oracle checks it when the segment ends (`oracle/runs/roadmap.py`) and shows the result
on the segment and its checkpoint (`items_check`): required fields, horizons, unique ids,
known dependencies listed before the items that need them and never in a later horizon,
dates only in Now and only with their source (O4), priority scores with an explanation,
and PRD section ids that exist in the PRD version. With the checkpoint off, a file with
problems fails the run.

## Links back to the PRD

Each roadmap item links to its PRD section with a cross-document link:
`[Payment step](/documents/checkout-redesign/v/3#s-5-1)`. The app opens it in the PRD
view at that section; exports make it absolute under `ORACLE_APP_URL`
(`<app>/documents/checkout-redesign/v/3#s-s-5-1`). The import reports how many links
resolve to a section of the source version (`draft_import.prd_links`).

## Provenance

`document_versions.source_version_id` (migration 0012) records the PRD version a roadmap
version came from. Documents and versions return it as `source` (document id, slug, title,
kind, version, approval); runs return the run's `source`. The app shows "From <PRD title>
v<n>" linking to it, and every export's version banner (HTML, PDF, markdown, deck) says
the same. The feedback loop keeps a roadmap's provenance on its next draft.

## Feedback loop on a roadmap

`feedback_loop` works on PRDs and roadmaps: the next draft is the document's kind
(`roadmap.md` for a roadmap, in the same template), imported as its next version.

## Roadmap items, alignment and product tracks (CR-11)

Lane `v2-roadmap` extends this flow without replacing it: the five roadmap templates, the
two segments and checkpoints, the `roadmap_review` approval loop, brief/full, Present and
every export work as before. What it adds (code in `api/oracle/roadmap/`, migration
`0016_roadmap`, contract in
[product-oracle-v2/05-artifact-contracts.md §8](product-oracle-v2/05-artifact-contracts.md)):

- **Items as rows.** When `roadmap.md` is imported, the run's `roadmap_items.yaml` becomes
  one `roadmap_items` row per item of that roadmap version, traced to the exact PRD
  version, section (at its hash), feature, requirements and blockers, with validation
  gates and economics. `GET /v1/roadmaps/{doc}/items` (`view=brief|full`).
- **Optional item fields:** `feature`, `requirements`, `blockers` (baseline keys),
  `validation_gates` (`[{name, criterion}]`) and `economics` (a mapping).
- **Dates need a verified basis (O4).** A milestone date is accepted only when its
  `date_source` names a verified schedule basis (`POST /v1/schedule-bases`: an estimate,
  capacity figure or commitment an approver recorded) that supports exactly that date.
  Otherwise `items_check` reports `unverified_date` (the run waits at its checkpoint, or
  fails with the checkpoint off), and a stored item keeps the milestone's name but never
  the date. The prompt lists the verified bases; with none, it asks for horizons only.
- **Dates in the roadmap's text (O4 'document dates', owner 2026-10-19/20).** Every
  day-precision date a reader sees (title, headings, bodies, `notes` blocks, code, link
  text; ISO, `30/11/2026`, `11/30/2026`, `2026.11.30`, `20261130`, ISO datetimes,
  `Nov 30, 2026`, `the 30th of November`, year-less `Nov 30`; read after markdown
  rendering, with no-break spaces, Unicode hyphens, zero-width and fullwidth characters
  normalized) must rest on a verified basis of the roadmap's PRD. The PRD is the one the
  version was built from, its track's, or the one its front matter names
  (`prd: {document: <slug>, version: <n>}`); never one its text merely links to. An
  item-scoped basis counts only where that item owns the date (its section, or the row,
  list item or line whose first item link is that item's). Sources and data points is
  exempt and must be the last part (`sources_not_last`); a company template's literal
  dates are exempt. A person's import with an unverified date is refused (422
  `unverified_date`); a run's import keeps the draft, marks each date `unverified` and
  records a warning, and the version cannot be approved (409 listing the dates) until
  every marker is resolved. A withdrawn basis never rewrites approved text: every place
  the date shows gets `date withdrawn`. The markdown (`GET .../markdown`, the md export,
  MCP `get_document_markdown`, which also returns `date_marks`) carries
  `<!-- oracle: date unverified -->` / `<!-- oracle: date withdrawn -->` right after the
  date; the import drops these comments, so the body imports again.
- **Staleness.** A new PRD version that changes an item's section, or a change to its
  feature, requirements or blockers, marks the item `potentially_stale` (with reasons and
  the causing change). `POST /v1/roadmaps/{doc}/items/staleness` reviews or reconciles.
- **Alignment.** `GET /v1/roadmaps/{doc}/alignment` compares items with engineering status
  read back from a tracker (`POST /v1/tracker/records`), read-only. Two-way tracker sync
  is off (`ORACLE_TRACKER_TWO_WAY_ENABLED`); a push is refused and nothing is written.
- **Product tracks.** An accepted PRD starts a track (`/v1/tracks`), which follows its
  roadmap: health, the next milestone, items at risk (blocked, stale, slipping) and drift.
  `POST /v1/tracks/{id}/roadmap-run` drafts the next `prd_to_roadmap` run.
- **Launches.** Approving a roadmap version plans a launch for each item in Now; see
  [launches-and-changelog.md](launches-and-changelog.md).

## Roadmap items per PRD draft (E1, PS1)

Every imported PRD version gets its own items-only roadmap (owner, 2026-10-20: "yes, items
only"), shown on the version's **Roadmap** tab (`/documents/{doc}/v/{n}/roadmap`). There is
no roadmap document: only items, derived by the `prd_draft_items` flow (one `roadmap_items`
segment, analyst + prioritizer, about $5.50 at standard depth) and checked by the same O4
rules as a roadmap's items.

- **Queued on import.** The `roadmap.draft_items` change handler records a `draft_roadmaps`
  row for each new PRD version: `queued`, or `skipped` for a template's empty skeleton
  (`POST /v1/drafts`), or `off` when the PRD's owner turned "Derive for each new draft" off.
  A failure in the handler is logged and never fails the import.
- **One at a time, latest draft wins.** The tick starts at most one derivation per PRD, the
  queued row of the highest version first; an older row queued automatically is
  `superseded` by a newer draft. A person's Derive (approver+) is never superseded.
- **For the importer.** The run is created by, and reads as, whoever imported the version
  (or clicked Derive). If they can no longer start runs, the row is `failed` and nothing
  runs.
- **No checkpoint.** Items are stored with the check's problems (a refused date is kept as
  `refused_date`); the run fails only when nothing can be stored (no file, an unreadable
  or refused file, no items, `wrong_prd`).
- **Stable ids.** The prompt says "PRD draft" and lists the known items (the nearest
  earlier ready draft's, then the approved roadmap's) so the agents keep their ids.
- **Never stale.** Draft items (`roadmap_items.draft_roadmap_id` set, no roadmap version)
  are skipped by staleness, tracker links and basis withdrawal; the next draft derives
  again.
- **API.** `GET /v1/documents/{doc}/versions/{n}/roadmap-items` (viewer+, run tokens with
  `read:documents`), `POST .../roadmap-items/derive` (approver+, 202; 409 while queued or
  running), `GET`/`PUT /v1/documents/{doc}/roadmap-items/settings` (`PUT`: owners).
  `VersionOut.draft_roadmap` carries `{status, items, problems}` for the tab label.

## Plan screen (F1, c7 Plan rename)

The Roadmap page became **Plan** (`/plan`; `/roadmap` redirects there, 308): one view of
where the plan stands. Its tabs are a registry, `web/app/plan/_tabs.ts` (`PLAN_TABS`):
**Plan** and **Roadmap documents** (`/plan/documents`, the roadmap list with Build roadmap,
as before); later specs add Dates, Outcomes, Launches and Changelog. A roadmap document's
breadcrumb and rail highlight say Plan. API routes keep their names.

The Plan tab shows Home's goals band, one card per PRD in play (an active or paused track,
an unfinished run, or a latest version not approved) with its journey stage, and every
roadmap item under Now / Next / Later (or grouped by goal or PRD) with its state,
engineering status and the next decision, the selected item in the inspector. One read
assembles it: `GET /v1/plan` (`scope=all|approved`, viewer and up; code in
`api/oracle/plan/`). It reads the items of each roadmap's latest approved version and of
its latest draft; a draft's item replaces its approved twin and says how it differs
through the one item diff (`roadmap/diff.py`: new, moved, changed; a confidence change or
a one-place rank shift is no change). Track health and at-risk reasons are the track
overview's (`views.assess`), dates are re-checked as `live_milestones` does. It writes
nothing, calls no model, issues a fixed number of statements whatever the number of
tracks, and refuses run tokens (MCP: `get_plan`, `get_plan_item_history` for people).
`GET /v1/plan/items/history?roadmap=<slug>&item=<key>` lists the item's horizon in each
roadmap version that has it. "Approved + drafts" or "Approved only" is remembered per
viewer in the browser.

**Changed since the last roadmap (E3).** A roadmap version's Items tab compares its items
with the previous version or with the approved plan (the roadmap's latest approved version
other than this one), item by item, through the same item diff: New, Dropped (a muted,
struck row in the horizon it had), Moved, Changed or Unchanged, with "Changed N" as a
filter and `?compare=previous|approved&filter=all|changed|attention` in the URL.
`GET /v1/roadmap-items/diff?head=<slug>@<n>&base=previous|approved|<slug>@<m>` and
`GET /v1/roadmap-items/history?prd=<slug>&item_key=<key>` serve it (viewer and up; run
tokens are refused; code in `api/oracle/roadmap/diff_views.py`). Dates compare as they
stand now on both sides. A prd_to_roadmap run that writes the next version of an existing
roadmap lists that roadmap's latest items as "Known items" so the agents keep their ids.
A PRD version's own draft items (E1) are not stored yet: a PRD ref answers 409.
