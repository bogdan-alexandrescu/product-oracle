# mk-prd-look: PRD look (decision PT1)

Five ways a PRD reads, section to section, as switchable variants in the real web code behind
`?pt1=a|b|c|d|e` on the PRD page (`/documents/<doc>/v/<n>`). Mock-ups only: the branch is never merged.

| Letter | Proposal | |
|---|---|---|
| a | Calm document | recommended |
| b | Section cards | |
| c | Summary first | |
| d | Margin spec | |
| e | Printed report | |

State switches, added to the address: `&toc=1` (contents open), `&sec=<section key>` (landed on that
section), `&edit=1` (that section's Edit open), `&as=viewer` (seen as a viewer). Every line of the
variant code is marked `// MOCK-HOOK` (CSS `/* MOCK-HOOK */`):
`web/components/PrdLook.tsx`, `PrdLook.css`, `SectionView.tsx`, `VersionView.tsx`,
`web/lib/api/mock/mk-prd-look.ts`, `web/lib/api/mock/server.ts`, `web/next.config.ts`.

The frames here are built on an invented PRD ("Crew notes PRD", 52 sections, made-up people and
products), the mock's first PRD.

- `frames/` 14 frames per proposal: `pt1-<letter>-<state>[-<width>].html` (static, scripts removed,
  stylesheets inlined, `?theme=light|dark` sets the theme) and a `.png` of each.
- `assets/` fonts used by the frames and each proposal's printed PDF (`pt1-<letter>-print.pdf`).
- `picks.json` the proposals, their cost and the frames with captions.
- `_src/snap.mjs` the snapshot script.

## Re-snapshot with your real PRDs (on your laptop only)

1. Write the real PRDs to a JSON file whose name starts with `real-` (git ignores
   `mockups-out/**/real-*`; never commit it), e.g. `mockups-out/mk-prd-look/real-prds.json`:

   ```json
   {"prds": [
     {"title": "…", "code": "…", "version": 4, "status": "In review",
      "sections": [{"key": "summary", "title": "Summary", "markdown": "…"}]}
   ]}
   ```

   The PRDs replace the mock's PRDs in the order the mock lists them (the first one is the PRD the
   frames show); extra PRDs are ignored, missing ones keep the invented content. Each keeps the mock's
   document id, so every link works. `status` is Draft, In review or Approved. A section may give its
   `level` (1 to 3; else it follows from the key), and a PRD its `citations`; without them it shows no
   sources. A file without a `"prds"` list, or that is not JSON, stops the build.

2. Build and start the mock with that file (the file is read at build time):

   ```sh
   cd web
   npm ci                      # once
   MOCK_PRD_FILE=../mockups-out/mk-prd-look/real-prds.json npm run build:mock
   E2E_PORT=3393 PORT=3393 npm run start:mock
   ```

3. In another terminal, from the repo root, snapshot into another folder (its name also starts with
   `real-`, so it stays out of git):

   ```sh
   node mockups-out/mk-prd-look/_src/snap.mjs http://localhost:3393 mockups-out/mk-prd-look/real-frames
   ```

   It writes the same frame names into `real-frames/frames/` and `real-frames/assets/`; copy
   `picks.json` beside them to view them with the same captions. Add a frame-name prefix as a third
   argument to redo only some frames, e.g. `pt1-c`.

   The frames land on these sections when the PRD has them: `milestones` (a long section with a
   table), `requirements` (picked from the contents, opened for Edit), `risks` (the widest table) and
   `feature-f-7` (dark theme). When a key is missing the script picks one by shape (the widest table,
   the most feature codes, the longest list) and prints its choice; set `SNAP_LONG`, `SNAP_PICK`,
   `SNAP_HARD` or `SNAP_DARK` to choose yourself, e.g.
   `SNAP_HARD=risk-register node mockups-out/mk-prd-look/_src/snap.mjs …`.

4. Stop the mock with Ctrl-C in its terminal. Rebuild without `MOCK_PRD_FILE` to go back to the
   invented PRD.
