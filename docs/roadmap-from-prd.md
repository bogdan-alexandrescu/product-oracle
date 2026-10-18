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

`document_versions.source_version_id` (migration 0011) records the PRD version a roadmap
version came from. Documents and versions return it as `source` (document id, slug, title,
kind, version, approval); runs return the run's `source`. The app shows "From <PRD title>
v<n>" linking to it, and every export's version banner (HTML, PDF, markdown, deck) says
the same. The feedback loop keeps a roadmap's provenance on its next draft.

## Feedback loop on a roadmap

`feedback_loop` works on PRDs and roadmaps: the next draft is the document's kind
(`roadmap.md` for a roadmap, in the same template), imported as its next version.
