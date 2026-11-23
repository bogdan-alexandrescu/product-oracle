# mk-roadmap-edit: handoff

## Today's friction, checked in the mock app (Nov 23, signed in as the mock owner, /simple/roadmap)

- The feature panel (click a bar on the Timeline) shows 16 "Change" links, one per field: Code, Outcome, Notes,
  Dates, Status, Confidence, Owner, Decider, Horizon, Track, Goal, Measure, Target, Date, PRD, Milestone. Each opens
  a field with Save and Cancel, so one field costs the bar click, Change, the edit and Save.
- Adding an item: an "Add an item" bar above the roadmap with "Which roadmap?" (a select), then
  "Type a title, then drag it into place", then a "New item" chip to drag. Dates are set after, in the panel.
- "Owner: No owner yet" in the panel; flags such as a draft with no owner to confirm it need a separate trip to pick
  an owner (open the tray or panel, Change, pick, Save).
- Milestones are added from a "+ Milestone" chip on the Milestones band, apart from the items.
- Counts used in every caption: add a feature 8 steps, move its dates 5, set its owner 4, add a milestone about 5
  (the milestone form was not walked step by step; "about").

## Where things are

- Variants: `web/app/simple/roadmap/_re-mock.tsx`, switched in `web/app/simple/roadmap/page.tsx` (MOCK-HOOK lines).
  `?re1=a|b|c|d`, `?re2=…`, `?re3=…`, with `&st=rest|open|mid|result|ms|hard` and `&viewer=1`.
- Invented data (Juniper Lane, a home-energy company; invented people): `web/lib/api/mock/re-mock.ts`.
- Capture: `web/playwright.mk.config.ts` + `web/e2e/mk-roadmap-edit.capture.ts` (MOCK-HOOK). Serve the mock build on
  4173 (`npm run build:mock && npm run start:mock -- --port 4173`), then
  `npx playwright test -c playwright.mk.config.ts` (`MK_ONLY=re1-a` for one proposal).
- States are drawn from the URL (each frame is a real render of the page in that state); the bars do not yet
  respond to real drags. Building the picked proposals is the follow-up.
- Recommended: RE1 A Click the spot, RE2 A Grab the bar, RE3 A Ghost of the approved (an independent check agreed;
  RE2 B Edit switch and RE3 B Review lens were close seconds).

## Round 2 (Nov 23)

- Hard-case frames (`*-hard-1512`) are now captured at a true 1512x900 viewport (set in Playwright, not zoomed);
  all twelve were re-shot so every one matches.
- `MK_FRAMES=re1-c-mid,re2-d-hard-1512` re-shoots exact frames.
- Fixed from the re-review: RE1 C mid counts the added row ("Billing track 5 items"); RE3 A keeps its two counts
  together at 1512; the RE2 A and B phone owner row fades at the right with an arrow; RE1 B phone shows only the ring
  filling (no title yet); RE2 D's read-only panel says "View only", who can change it, and has a close button;
  the RE3 A phone caption names only F-29 Solar panel advice, the one '!' in view.
