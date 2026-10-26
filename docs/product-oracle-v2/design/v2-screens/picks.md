# v2 screens: the owner's picks (2026-10-25)

Mockups: one self-contained HTML file per direction in this folder (invented data; the dashed
"States & roles" board under each screen is for review only, not product UI). Build from the
picked direction(s) below, in Oracle's design system (web/app/globals.css, web/components/ds),
against the API routes listed in index.html.

1. **Composition inspector, module catalog and module policy**: A (module table + inspector),
   with B's draft diff and Brief/Full outline inside A's Confirm step, and C's policy board as
   A's owner-only Company policy tab.
2. **Impact explorer and targeted regeneration plan**: B (lineage graph + plan sidebar) as the
   main view, with A's table + inspector as a second view (a view switch), and C's three-stage
   steps (settle staleness, propose a run or estimate, start) on each plan row. No "run the whole
   plan" action: the API has no such route. On a phone the graph becomes a grouped list.
3. **Evidence inspector for a PRD version**: C (coverage matrix) as the main view, with A's
   section table + inspector as a second view; the "no links or citations" signal stays.
4. **Viewer and review for wireframes and SVG flows**: A (canvas + review inspector), with C's
   "no comments" filter and B's side-by-side compare for 2-4 wireframe screens. No pins over the
   sandboxed iframe; annotation numbers come from labels Oracle writes into each wireframe.
5. **Quality evaluation**: A (criteria table + inspector), with C's "hide rules and model until
   you pick" as an option of the rating form, and B's report list as a History section.
