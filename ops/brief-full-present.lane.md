# Lane: brief and full layers, with a Present mode (O1f)

Dispatch after the v1 integration pull request is merged, from the merged `main`.
One SwarmCloud `claude-code` task, strategy `direct-pr`.

## Prompt

BRIEF, FULL AND PRESENT for Product Oracle (decision O1f in docs/questions.md; read it,
O1c, O1e and O1d first, then the templates, themes, docs, review and export code).

Every document has a brief layer and a full layer, and the brief can be presented and
discussed at an all-hands meeting.

1. Templates: each section of a template version carries `layer: brief | detail` (in
   the template's front matter or a per-section marker, versioned with the body). Mark
   all 12 built-ins: the brief is the summary, goals, problems, a one-line-per-item table
   of features or roadmap items grouped by milestone with links to their detail
   sections, the roadmap at outcome level, not-doing, top risks and the decisions
   needed; everything else is detail. Template validation reports a template with no
   brief sections. A document version records which of its sections are brief.
2. App: a document opens on the brief. Each feature row and milestone has Expand, which
   shows its detail section in place; Show full document switches to the whole version;
   the choice is remembered per user. Comments, verdicts and diffs work in both views
   and say which layer a section belongs to.
3. Present mode: one brief section per slide, full screen, keyboard and click
   navigation, a presenter view with the next slide and notes (the section's guidance
   text or a `notes` block), and Expand on a slide's feature or milestone opens its
   detail in an overlay for questions. Uses the document's theme, with a slide variant
   of each built-in theme.
4. Exports: Brief (PDF, HTML), Full (PDF, HTML, markdown, as today) and Deck (PDF slides
   and PPTX) from the brief layer; each carries the version banner and the
   Sources and data points appendix where it applies.
5. Tests: layer marking and validation, brief/full views, expand, present navigation,
   each export (PDF tests with ORACLE_REQUIRE_PDF=1; PPTX opens and has one slide per
   brief section), role checks, Playwright mock tests for brief, expand and present.

Product Oracle words only (users, roles; never "workspace"). Never touch .github/.
Run the full API suite, ruff, make openapi, web lint/tsc/build, Playwright. Commit.
Write `$SWARM_ARTIFACTS_DIR/brief-full-report.md`.
