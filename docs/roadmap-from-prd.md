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
confirmed goals and B2 horizons, the priority order (the latest priority snapshot, else
the live goal-weighted ranking, every score with its explanation) and the baseline's
`depends_on` / `blocks` edges. The `roadmap_draft` prompt adds the approved items file,
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
