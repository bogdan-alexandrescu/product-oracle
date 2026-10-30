# Simple Definition of Done, item 4: roadmap, priorities and one-pager actions

Every action below is proven by a mock-backed Playwright spec (web/e2e, `test` from e2e/test.ts,
the mock clock) that drives the UI, on a desktop and on a phone (390x844). Each cell names
`spec file :: test title`. Specs named with no folder are under web/e2e. "Desktop" counts the
config default (1366x820) as well as 1440x900; "phone" is 390 wide.

Roles: the owner (admin@example.com) applies into the working draft; the approver and the
commenter propose and the decider accepts or declines; the viewer reads.

Notes on scope:
- The roadmap has four formats (timeline, Gantt, Now/Next/Later board, waterfall); there is
  no list format on /simple/roadmap (the phone's timeline is its list of goal lanes).
- On a phone the timeline format draws thin goal lanes (design B3: no bars, a lane opens a list
  of its rows), so the "compact timeline" a finger long-press drags is the compact chart of the
  Gantt and waterfall formats.

## Roadmap (/simple/roadmap)

| Action | Role | Desktop | Phone |
|---|---|---|---|
| Drag, goal lanes timeline | owner | simple-roadmap.spec.ts :: an owner drags a bar: applied, with Undo | n/a: thin lanes (B3), see the compact timeline row |
| Drag, goal lanes timeline | commenter | simple-roadmap.spec.ts :: a commenter's drag is a proposal the owner accepts in the tray | n/a (B3) |
| Drag, goal lanes timeline | approver | MISSING | n/a (B3) |
| Drag, goal lanes timeline | viewer | simple-roadmap.spec.ts :: a viewer reads and cannot drag | n/a (B3) |
| Drag, Gantt | owner | MISSING | simple-roadmap.spec.ts :: a long press drags a bar on a phone |
| Long-press drag, compact timeline (Gantt) | owner | n/a (a mouse drag, row above) | simple-roadmap-keys.spec.ts :: a long-press drag is one change |
| Long-press drag, compact timeline (Gantt) | approver | n/a | MISSING |
| Drag, board | owner | simple-roadmap-formats.spec.ts :: an owner drags a board card to another horizon, with Undo | simple-roadmap-formats.spec.ts :: a long press drags a board card on a phone |
| Drag, board | commenter | simple-roadmap-formats.spec.ts :: a commenter's board move is a proposal the owner accepts | MISSING |
| Drag, waterfall | owner | simple-roadmap-plus.spec.ts :: an owner drags a phased bar on the waterfall, with Undo | same test, its phone branch (long press) |
| Cut it and its dependents | owner | fix5-cut-dependents.spec.ts :: cut it and its dependents: one change, named in the change list, undone as one (desktop) | same title (phone) |
| Cut it, keep the dependents | owner | MISSING | MISSING |
| Cut | commenter | fix5-cut-dependents.spec.ts :: a commenter proposes it (desktop) | a commenter proposes it (phone) |
| Cut | approver (decides the item only) | fix5-cut-dependents.spec.ts :: deciding the item but not its dependents, the cut with them is a proposal (desktop) | same (phone) |
| Add: a title dropped on a quarter, Oracle drafts | owner | simple-additions.spec.ts :: an owner drags a quick add onto a quarter, sees Oracle draft it, and undoes it | simple-additions.spec.ts :: an owner adds from the sheet and opens the drafted flow full height |
| Add: a title dropped on a goal | owner | simple-additions.spec.ts :: an owner drops a quick add on a goal header | n/a: a phone has no drag target; the sheet asks for the goal (row above) |
| Add | approver | simple-additions.spec.ts :: an approver proposes a quick add the owner accepts in the tray | MISSING |
| Add | commenter | MISSING | simple-additions.spec.ts :: a commenter proposes from the sheet and reads a goal's suggestions |
| A draft stays a draft until an owner confirms | owner | simple-priorities.spec.ts :: a draft at the bottom merges, comes back with Undo, and is confirmed | MISSING |
| Propose (an edit becomes a proposal) | commenter | simple-roadmap-plus.spec.ts :: a commenter proposes a key date, the owner accepts; a viewer reads | same test, its phone branch |
| Propose | approver | simple-additions.spec.ts :: an approver proposes a quick add the owner accepts in the tray | MISSING |
| Accept a proposal | owner | simple-roadmap.spec.ts :: a commenter's drag is a proposal the owner accepts in the tray | simple-roadmap-plus.spec.ts :: a commenter proposes a key date, the owner accepts; a viewer reads (phone branch) |
| Decline a proposal | owner | MISSING | MISSING |
| Undo, step by step in the working draft | owner | MISSING | MISSING |
| Accept an Oracle-proposed date | owner | simple-roadmap.spec.ts :: Oracle's date suggestion: accept, edit | simple-plan-dates-to-confirm.spec.ts :: an owner accepts a two-milestone item's dates from the tray (phone, light) |
| Edit an Oracle-proposed date | owner | simple-roadmap.spec.ts :: Oracle's date suggestion: accept, edit | MISSING |
| Broken dependency: move the dependents | owner | simple-roadmap.spec.ts :: a broken link's fixes: move the dependents, accept as risk | MISSING |
| Broken dependency: move the dependents | commenter | simple-roadmap.spec.ts :: a commenter proposes a fix from the callout | MISSING |
| Broken dependency: move the dependency | owner | MISSING | MISSING |
| Broken dependency: accept as a risk with a note | owner | simple-roadmap.spec.ts :: a broken link's fixes: move the dependents, accept as risk | MISSING |
| Export the view as PNG and PDF with its filters | any | simple-roadmap-formats.spec.ts :: every format exports as PNG and PDF, branded, with its filters | same test, its phone branch |

## Priorities (/simple/priorities)

| Action | Role | Desktop | Phone |
|---|---|---|---|
| Reorder: an override with a one-line reason, Oracle's rank as a ghost | owner | simple-priorities.spec.ts :: an owner drags a row with a reason, sees the ghost and the override, compares and undoes | MISSING (simple-priorities.spec.ts :: drag, compare toggle and goal cards on a phone, dark drags with a reason but never checks the ghost or the override) |
| Reorder | commenter | simple-priorities.spec.ts :: a commenter proposes inline with its flow thumbnail; the owner accepts | simple-priorities.spec.ts :: a proposal's flow opens a full-height sheet on a phone |
| Reorder | approver | MISSING | MISSING |
| Reorder | viewer | MISSING | simple-priorities.spec.ts :: a viewer reads and is offered no change |
| Value/effort drag (re-estimate) | owner | simple-priorities.spec.ts :: value / effort: a sideways drag re-estimates effort and the rank moves at once | simple-priorities-codes.spec.ts :: drag a mark on a phone, dark: code kept, moved #5 → #2 |
| Value/effort drag | commenter | MISSING (keyboard only: simple-priorities-codes.spec.ts :: a commenter's move is proposed and highlights nothing) | MISSING |
| Accept a goal's feature suggestion | owner | simple-additions.spec.ts :: priorities: a bucket's suggestion is accepted and Merge merges the draft | MISSING |
| Reject a goal's feature suggestion | owner | MISSING (roadmap tray only: simple-additions.spec.ts :: an owner accepts, undoes and rejects suggested features in the tray) | MISSING |
| Goal suggestions | viewer | simple-suggest.spec.ts :: a viewer reads a bucket's suggestions on Priorities (desktop, light) | simple-suggest.spec.ts :: a viewer reads a bucket's suggestions on Priorities (phone, light) |

## One-pager (/simple/one-pagers/[doc])

| Action | Role | Desktop | Phone |
|---|---|---|---|
| Export PDF | viewer | simple-one-pager.spec.ts :: reads the page, presents, exports and links to the detailed view (desktop · light) | same test (phone · light) |
| Export PDF | owner | simple-prd-qa2-page.spec.ts :: Present hides the chrome, and leaving full screen ends it; Export shows a passing toast (qa-24, 25) | simple-prd-timeline.spec.ts :: Export PDF saves the timeline, then a page per milestone (phone, light) |
| Line edit applies (the PRD section's change) | owner | simple-one-pager.spec.ts :: an owner edits a line into the working draft and undoes it (desktop · light) | same test (phone · light) |
| Line edit applies | the PRD's named decider | MISSING | MISSING |
| Line edit is a proposal | commenter | simple-one-pager.spec.ts :: a commenter proposes, the owner accepts after opening the flow (desktop · light) | same test (phone · light) |
| Line edit is a proposal | approver | MISSING | MISSING |
| Line edit | viewer | simple-one-pager.spec.ts :: reads the page, presents, exports and links to the detailed view (no Edit offered) | same test (phone) |
| The edit is the full PRD's section change | owner | MISSING | MISSING |

## Mode switch

| Action | Role | Desktop | Phone |
|---|---|---|---|
| Lands on the matching page | any | simple-mode.spec.ts :: the switch lands on the matching page, Detailed to Simple; … Simple to Detailed | MISSING for roadmap and priorities (simple-mode.spec.ts :: phone: Simple's rail is a tab bar and a More drawer, every page fits 390 px covers one-pager to PRD) |
| Default: viewer and commenter in Simple | viewer, commenter | simple-mode.spec.ts :: with no saved mode, a viewer lands in Simple; … a commenter lands in Simple | MISSING |
| Default: approver and owner in Detailed | approver, owner | simple-mode.spec.ts :: with no saved mode, an approver lands in Detailed; … an owner lands in Detailed | MISSING |
| The choice is remembered | any | simple-mode.spec.ts :: the chosen mode is remembered across a reload and the next sign-in | MISSING |
