# Brief, full and present (O1f)

Every document has a **brief** layer and a **full** layer. The brief is what gets
presented and discussed at an all-hands: slide-sized sections in plain language. The
full layer is the whole version.

## Templates mark the brief

A template version marks its brief in its front matter, versioned with the body:

```yaml
---
brief: [summary, goal-trace, problem, brief-items, brief-roadmap, non-goals, top-risks, decisions]
---
```

Every section not listed is detail. All 12 built-ins follow one shape: the title, the
brief sections, a level-1 `# Full version {#full}` heading, the detail, and Sources and
data points last. The brief sections are:

| Brief section | Ids used |
|---------------|----------|
| Summary | `summary` (`decision` in the decision memo) |
| Goals | `goal-trace` (PRDs), `goals` (roadmaps) |
| Problems | `problem` (PRDs), `problems` (roadmaps) |
| One line per feature or roadmap item, grouped by milestone, linking to each item's and milestone's detail section | `brief-items` |
| The roadmap at outcome level: one line per milestone | `brief-roadmap` |
| Not doing | `non-goals`, `not-doing` or `no-gos` |
| Top risks | `top-risks` |
| Decisions needed | `decisions` |

Links in the items table and the roadmap are in-document links, such as
`[Bulk import](#feature-bulk-import)` and `[Beta](#milestone-beta)`. The PRD
templates have `## Feature detail` (one `### <Feature> {#feature-<slug>}` per
feature) and `## Milestones` (one `### <Milestone> {#milestone-<slug>}` each). The
roadmaps link to their existing horizon, release, cycle and item sections.

Validation:
- `brief` must list section ids of the body: `invalid_brief`, `unknown_brief_section`.
- `full` and Sources and data points cannot be brief: `full_section_brief`,
  `sources_section_brief`.
- A template with no brief gets a `no_brief_sections` warning. It is reported, not
  blocking. `POST /v1/templates/validate` returns `warnings` and `brief_sections`; every
  template version carries both.

Existing companies get each built-in's new skeleton as its next version, unless they
edited it (its latest version was created by a user) or archived it.

## A version records its brief

On import, `sections.layer` is set to `brief` or `detail` and
`document_versions.brief_source` records where the brief came from. Sources are tried
in this order:

1. `draft`: the draft's own `brief: [...]` front matter. Drafts started from a
   template carry their template's list.
2. `template`: the markers of the template version the draft names.
3. `full_heading`: for a draft without markers, the sections before a level-1
   `# Full version {#full}` heading, except the leading title section.
4. `none`: no brief. The version opens on the full document, and the brief and deck
   exports answer 422.

Presenter notes for a brief section come from a fenced `notes` block in its body. When
there is none, they come from the section's guidance text: the HTML comment under its
heading in the draft, else in the template. Notes and guidance never reach an export.

## In the app

- A document opens on the brief.
- Each feature row and milestone has **Expand**, which shows its detail section, with
  its sub-sections, in place.
- **Show full document** (or the Brief / Full document switch, or `v`) changes the
  view. The choice is remembered per user (`document_view`).
- Comments and verdicts work in both views. Each section, comment and diff row is
  labelled Brief or Detail. Clicking a comment on hidden detail expands the item that
  holds it, or shows the full document. The diff can show brief sections only.

## Present mode

`/documents/{doc}/v/{n}/present` shows one brief section per slide, in this order:

1. A title slide with the version banner.
2. One slide per brief section.
3. Sources and data points.

It shows full screen in the document's theme.

- **Keys:** ← → (also Space, PageUp/PageDown), Home, End. `s` switches to the
  presenter view and `f` to full screen.
- **Click:** clicking the slide advances.
- **Expand:** Expand on a slide's feature or milestone opens its detail in an overlay.
- **Presenter view:** the current slide, the next slide, the notes and a timer.
  "Open audience window" opens a second window. Both windows stay on the same slide
  through a BroadcastChannel.

Slides come from `GET .../versions/{n}/deck`, rendered by the API
(`oracle/export/deck.py`) in a shadow root. Each built-in theme has a slide variant
(`templates/builtin/themes/slides/<key>.css`) on top of the shared
`export/static/slides.css`. A company theme gets the shared slide layout in its own
colours and fonts.

## Exports

`GET .../export?layer=&format=`:

| Layer | Formats | Content |
|-------|---------|---------|
| `full` (default) | html, pdf, md | every section, as before |
| `brief` | html, pdf | brief sections, then the Sources and data points appendix. Links to detail keep their text. |
| `deck` | pdf, pptx (html: the printable slides) | the Present mode slides: 16:9 pages, or a PPTX with native tables and presenter notes |

Each export carries the version banner. The deck has it on the title slide and in
every slide's footer.
