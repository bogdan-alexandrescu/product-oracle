# mk-mentions: what the app has today (read from the mock app, Nov 24)

- The one feature panel: `web/app/simple/roadmap/_panel.tsx` (FeaturePanel) -> `_card.tsx` (FloatingCard). Desktop: a 400px
  card at the right; phone: a bottom sheet with Details / Talk to Oracle tabs. Order: title with code, Code, Outcome,
  Notes, Dates, Status, Confidence, Owner, Decider, Horizon, Track, Goal (measure, target, date, reading), PRD,
  Milestone, Depends on, Needed by, Near, Why, Open decisions, Decided, Tasks, Flow, Proposals on it, then
  Open the detailed view / Talk to Oracle, then Comments.
- Comments already exist on a feature (#1553): `web/components/simple/FeatureComments.tsx`, oldest first, a field at the
  end (Enter sends), edit/delete own; count on rows (`CommentCount`). Mock: `web/lib/api/mock/feature-comments.ts`.
- No history of a feature in Simple. Detailed has History in `web/app/baseline/_components/EntityDrawer.tsx:2042`
  (time, then "field: before -> after" joined by dots).
- No @mentions anywhere. A member picker exists (`web/components/PersonPicker.tsx`, used by Ask a teammate, which lands
  in the asked person's Inbox).
- Inbox: one page (`web/app/inbox/_inbox.tsx`), Simple reuses it; the rail shows the Inbox count. No bell anywhere.
- Edits in Simple are direct for owners and approvers, proposals for commenters; Oracle's suggestions are accepted or
  declined; there is no undo in the panel today.

## The mock-ups
- Switches (local only, MOCK-HOOK): `/simple/roadmap?item=<F-79 id>&ma1=a|b|c|d`, `&ma2=a|b|c`, `&ma3=a|b|c|d`; states
  `&open=1`, `&phase=mid|done`, `&hard=1`, `&role=commenter`; Inbox: `/simple/inbox?ma2=a|b|c`.
- Code: `web/components/simple/MkActivity.tsx`, `web/lib/api/mock/mk-mentions.ts` (invented data, 200-event generator),
  hooks in `web/app/simple/roadmap/_card.tsx` and `web/app/inbox/_inbox.tsx`.
- Frames: `web/scripts/mk-mentions/picks.py` writes `frames.json` and `picks.json`; `capture.spec.ts` snapshots them
  (`cd web && npm run build:mock`, serve on 3393, then
  `swarm-test-browsers npx playwright test -c scripts/mk-mentions/playwright.config.ts`; `MK_ONLY=ma2` for a subset).
- Not done: lint on the mock-up code fails (raw buttons, file length); it is never merged. Detailed's History is not
  redrawn: every proposal shares its lines with it (said in each decision's common text).
