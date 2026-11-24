# mk-linked-pr: what exists today (read from the mock app before drawing)

- **One feature panel** (`web/app/simple/roadmap/_panel.tsx` FeaturePanel, `_card.tsx` FloatingCard, fields in
  `_fields.tsx` PanelFields): Code, Outcome, Notes, Dates, Status (Planned / In progress / Done; Cut is in the ⋯ menu),
  Confidence, Owner, Decider, Horizon, Track, Goal, Measure, Target, Date, Reading, PRD, Milestone, Depends on,
  Needed by; then Why, Open decisions, Decided, Tasks, Flow, Proposals on it. Each field has Change.
  Opened from Priorities, Roadmap, Goal buckets, Decisions, Meetings, Home. A phone gets the bottom sheet.
- **Oracle already suggests something**: dates. "Oracle suggests Apr 1 – May 11 (i)" with Accept / Edit dates /
  Dismiss (a commenter: "Propose these dates", no Dismiss), in the panel, a Timeline popover, and Inbox "Dates" rows
  with Open. LP2 reuses this shape.
- **Priorities rows** (`web/app/simple/priorities/priorities.tsx`): rank, name, code, a current-state pill
  (NEW / IN PROGRESS / EXISTS, from the code check, not the item status), "Not in the Ground Truth", goal, value,
  confidence, effort, score. One priority order, drag to rank.
- **Inbox** (`web/app/inbox/_inbox.tsx`, `_needs.tsx`): Needs you with New / Seen / Staged / Declined / Done tabs;
  rows = kind, what, context, age, actions.
- **GitHub**: a connection on Settings › Connections (`web/app/settings/connections`), sources sync; issues link to a
  plan from `LinkIssueDialog` (Detailed plan page). No pull request links and no status from code today.
- **Detailed**: the feature panel and the item Status field live in Simple only (FeaturePanel is used only under
  `app/simple` and `components/simple`); Detailed has no roadmap-item status editor. Detailed's Inbox is the same
  Inbox component, so the Inbox proposals (LP2 A, LP2 B, LP3 C) have a `-detailed` frame.

## Not drawn / limits
- Inbox counts (rail, Needs you, New) add the mock rows still waiting (`useMkInboxExtra`), so acting on one moves them all.
- Role frames: `-commenter`, `-viewer` for LP1 A-D, LP3 A, LP3 C.
- LP1 B's "done" frame is reached by `&phase=done` (the pull request is opened in GitHub, outside Oracle).

## How to run
`cd web && npm run build:mock && swarm-test-browsers npx playwright test -c mk/mk.config.ts` (MK_ONLY=lp1-a,... for some).
Switches: `?lp1=a|b|c|d`, `?lp2=a|b|c`, `?lp3=a|c|d`, `&open=1`, `&phase=mid|done`, `&data=many`, `&host=off`, `&link=gone`.
