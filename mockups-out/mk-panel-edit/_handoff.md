# mk-panel-edit: hand-off

Mock-ups for "Feature panel: edit any field in one step and act on its flags in place"
(decisions PE1 to PE3). Open `picks.json`; each frame is a static `frames/*.html` (with
`?theme=light|dark`) plus a `.png`.

## Today's friction (Nov 23): two checked in the mock app with frames, two read from the code

- `frames/today-rest.html`: the feature panel lists about 20 fields, each with its own
  **Change** link.
- `frames/today-change.html`: Change opens a field with **Save** and **Cancel**: two clicks plus a
  Save for every field (dates, owner, milestone alike).
- Adding an item (read from the code, no frame): the quick add says "Type a title, then drag it into place"
  (`web/app/simple/roadmap/_add.tsx`): a title, then a drag onto a quarter.
- A draft with no owner (read from the code, no frame) shows "Draft with no owner to confirm it"; its fix is a separate
  "Pick an owner" trip (`web/app/simple/roadmap/_roadmap.tsx`, the flag list), not in the panel.
- Milestones are added from the "+ Milestone" chip on the time axis, apart from the items
  (visible in `today-rest.png`, top of the Timeline).

Counted today: add a feature 2 clicks and a drag; move its dates 3 clicks with Save; set its
owner 3 clicks with Save; add a milestone 4 clicks with Save.

## How the mock-ups are built

- Real web code behind the address: `?pe1=a|b|c|d&pe2=a|b|c&pe3=a|b|c`, plus `&hard=1` (long
  name, 8 dependencies), `&viewer=1` (read only), `&hover=<field>` (holds the hover look for a frame).
  Any `pe*` switch swaps the feature panel's body (`FloatingCard`, two `// MOCK-HOOK` lines in
  `web/app/simple/roadmap/_card.tsx`) for `web/app/simple/roadmap/_pe.tsx` (the whole file is a
  mock-up). Invented data: `web/lib/api/mock/mk-panel-edit.ts`.
- Date changes go through the real change call (`move_dates`), so the Roadmap bar moves and the
  real toast with Undo shows; other fields and the flags are kept in the panel's own state.
- Capture: serve the mock build on :4173 (`cd web && npm run build:mock && npm run start:mock -- --port 4173`),
  then `swarm-test-browsers npx playwright test -c scripts/mk-panel-edit/capture.config.ts frames`
  (`ONLY=pe2-b` for one proposal, `ONLY=viewers` for the viewer frames alone). The repo's own Playwright was used because the shared live
  browser cannot be set to 1512 wide. Each frame starts from the same seeded mock data.

## Not done

- No Playwright spec or gate run: this branch is a throwaway mock-up, never merged.
- Flags other than dates are not saved through the mock API (state in the panel only).

## Round 2

- The 1512 frames are rendered at a true 1512x900 viewport (Playwright's `setViewportSize`, no zoom).
- A feature typed under Needed by and a new milestone are now made through the mock's real calls
  (`add_item`, `set_depends`, `move_dates`; `POST /v1/simple/roadmap/milestones`, `set_milestone`), so the
  Roadmap draws the new row after Alert rules engine and the milestone on the Milestones strip.
- The panel has a height cap, so its body scrolls; the add frames scroll it to Needed by after the earlier toast is dismissed.
- Every frame of a story keeps the open Roadmap row where it was at rest (banners added after a change no longer move it).
- `&hard=1` also gives the open Roadmap row the panel's long name (MOCK-HOOK in `web/lib/api/mock/simple-roadmap.ts`).
- Viewer frames are signed in as Lena Ortiz, a viewer (`viewer@example.com`).

## Round 2, second fix pass

- Move it after moves F-79 Weekly alert digest for real (`move_dates`, MOCK-HOOK in `_pe.tsx`): it starts the day after
  this feature ends and keeps its length, so on the Roadmap its bar moves to Nov 25 to Jan 4 and loses its red mark.
- C's phone frames at rest show the count alone, flags closed, as on the desktop.
- The scrolled panel shows a whole field under its header (the capture scrolls back to the start of a cut field).
- pe2-a-changed and pe3-a-owner-fixed scroll the panel just enough that the F-79 flag and its buttons sit above the toast.
- The added feature is typed as "Alert sounds" (the row label fits) and lasts six weeks, so its bar shows both dates.
- The new milestone's flag mark is the product's mark for a milestone met when features ship (kind delivery); the
  diamonds are the goal's number checkpoints. The captions now say so.
- Hard and viewer frames at 1512 start the timeline 80 px earlier, so the open row's end dot sits in the grid, not on
  its "Not in GT" chip. Still a true 1512x900 viewport (`setViewportSize`).
- Known trade: in the add-result frames the panel shows its Ends field whole, so the F-79 flag under Needed by sits
  under the "Added ..." toast there.
