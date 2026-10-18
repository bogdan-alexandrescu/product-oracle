# Lane: brief and full follow-ups (O1g)

Dispatch from `main` after 16e3916 (O1f brief/full/Present and its fix are merged and
deployed). One SwarmCloud `claude-code` task, strategy `direct-pr`.

## Prompt

BRIEF AND FULL FOLLOW-UPS for Product Oracle (decision O1g in docs/questions.md; read
it, O1f, O1c and docs/brief-and-full.md first, then api/oracle/templates/,
api/oracle/docs/layers.py, the export code, web/components/PresentMode.tsx and the
theme editor).

The owner changed three calls the O1f lane made on its own:

1. Templates with no brief sections are REFUSED. `validate_template` reports
   `no_brief_sections` as a problem (not a warning), so creating or editing such a
   template returns 422 with that problem. Existing company template versions are not
   rewritten and documents drafted from them keep working; the next edit must add
   brief markers. The template editor shows the problem and how to fix it (a `brief:`
   list in the front matter or a `# Full version {#full}` heading). Every built-in
   already passes; keep a test that proves it.
2. Company themes get editable SLIDE CSS. Add a nullable `slide_css` to themes
   (migration revision `0011`, down_revision `0010`; another lane may also add a
   `0011`, the integrator renumbers), validated and sanitised exactly like the theme's
   `css`, versioned or audited the same way. Present mode and the Deck PDF export use
   it after the shared slide layout; PPTX keeps using the theme tokens. Built-in themes
   keep their in-code slide variants and are read-only as today. The theme editor gets
   a Slide CSS field with a live slide preview. API, OpenAPI and MCP (`create_theme`,
   `update_theme`, `get_theme`, `preview_theme`) carry the field.
3. Presenter notes come ONLY from a ```notes block. A brief section without one shows
   "No notes for this slide" in the presenter view and gets no speaker notes in the
   PPTX; template guidance is never used as notes. Update the version's stored notes
   (or how they are computed) so older versions follow the same rule.

Also fix the review minor that touches notes: the themeless export path must strip
```notes blocks and guidance like the themed path, and the document view must not show
notes blocks as code.

Tests: validation refuses a briefless template (create and edit, 422, problem code);
slide_css validation, sanitising, storage and its use in Present data and the Deck PDF
(ORACLE_REQUIRE_PDF=1); notes only from blocks (version data, presenter view, PPTX
notes); role checks unchanged; Playwright mock tests for the theme editor's slide
preview and the presenter view's empty-notes state.

Product Oracle words only (users, roles; never "workspace"). Never touch .github/.
Run the full API suite, ruff, make openapi, web lint/tsc/build, Playwright. Commit.
Write `$SWARM_ARTIFACTS_DIR/o1g-report.md`.
