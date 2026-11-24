# mk-undo: what exists today (inventory) and this review round

## Undo, restore and toast patterns in the built app (before the mock-ups)
- One toast at a time: `web/components/ds/Toast.tsx` (10 s life, `LIFETIME_MS` :124; held while hovered or
  focused; `avoid` moves it to the top when it would cover the row its action came from; a `top` toast finds a
  spot clear of every control, `clearSpot`; it stays clear of open dialogs, `clearOfDialogs`).
- Toasts that carry Undo today: Simple Roadmap change results (`web/app/simple/roadmap/_roadmap.tsx:2342`, :2831),
  the feature panel (`_panel.tsx:156`), Removed (`_removed.tsx:145`), Simple Home (`web/app/simple/page.tsx:918`),
  a metric (`web/app/company/metrics/_components/MetricInspector.tsx`). They call the change's undo route
  (`api/oracle/simple/changes_router.py:180`).
- Cut asks first: an in-page confirm in the feature panel's menu (`_card.tsx`, `confirmInPage`); the menu also
  holds Restore to the roadmap (`_card.tsx:1227`); a cut feature's panel shows the "Cut on … by …" bar with Restore.
- Removed and Trash: the Roadmap's "Removed · N" list with Restore; Trash for deleted items.
- Working draft banner: its own Undo takes back the whole draft, not one change.
- The panel's "Decided" and "Proposals on it" sections list what was decided and proposed on a feature.

## Frames redone in this round (runner: `web/mk-snap/`, Playwright via swarm-test-browsers, mock build on :4317)
UT1 a/b/c/d hard and hard-1512 (1512 frames are now a real 1512x945 viewport), UT1 a/b/c/d open-dark (chart drawn),
UT1 b/c open, UT1 a phone, the whole UT1 d story (strip now in the page flow under the title row and view switch;
wraps on phone; count leaves out Undone lines), UT3 b hard, hard-1512, phone (a commenter's list says Withdraw).

## Findings left open (not done in this round's time)
- (Done: UT1 starts from a real change; the draft banner counts the quick changes too, so after Undo both read 2. Re-snapped UT1 a story, b/c open, all UT1 hard and dark frames.)
- (Done: the UT2 and UT3 a/c 1512 frames were re-laid from their static frames in a real 1512x945 window, `web/mk-snap/wide.spec.ts`.)
- UT2 commenter frames (b, c, d hard; phone frames on the commenter), UT3 b/c phone on the panel.
- Drawn-twice items (Restore bar beside the toast's Undo; UT3 a History beside Decided/Proposals; draft Undo vs toast Undo).
- (Done: focus rings on UT2 c and UT3 a/b mid frames; a cost tag on every result frame; UT3 a frames scrolled to History, UT3 c rest to Removed · 7; `web/mk-snap/tags.spec.ts`.)
- Still open: a Detailed frame per recommended proposal; UT3 c mid focus ring; minors on 'Not in GT' and codes in the real toast's text.

## Round 3 (this round)
Runner: `web/mk-snap/` (every line marked MOCK-HOOK): `ut1.spec.ts`, `ut2.spec.ts` (new: UT2 commenter frames, live),
`ut3.spec.ts` (new: UT3 b/c phone on the open panel, UT3 b/c dark, Detailed frames), `tags.spec.ts` (cost notes, focus rings),
`patch.spec.ts` (static UT2/UT3 frames: banner 'Undo whole draft', History without the line Decided already lists).
- Toast placement as today's clearSpot: bottom when clear, else the first spot that covers no real button (chart chips weigh
  little), and left of an open feature panel on a desktop. UT1 b's 'N more' sits inside the oldest toast; UT1 c's hard
  frames are scrolled to the timeline so the open list covers only the chart.
- Cost tags are a margin note in the rail's empty middle (top right on UT3 b's result, where the open list fills the rail).
- UT1 a's story undoes a move of F-79 Weekly alert digest, whose bar is in view at Oct 31 – Dec 10 in the result.
- UT2 commenter: a toast offers Withdraw; b a 'Proposed · Withdraw' mark beside the status, no toast; c toast Undo; d a plain
  toast naming Proposals on it, which shows Withdraw. None says 'Needs a decision' (a commenter has none).
- Toast text: the two uncoded names get F-63 Welcome video and F-64 In-app tour; no 'in your working draft' suffix.
- The draft banner's Undo reads 'Undo whole draft'.
## Still open
- UT3 a has no Detailed frame (History lives in the Simple panel only); UT1 c and UT2 a have one.
- The cut's toast Undo still sits beside the panel's 'Cut on … by …' Restore bar in UT2 a/b/c mid (not reworked this round).
- 'Not in GT' chip and its end dot on the timeline (built text), 'In-app tour' uncoded in the built Removed list.

## Round 4
Runner `web/mk-snap/r4.spec.ts` (MOCK-HOOK): UT1 b/c stories live from the open frames' start (rest, open, mid, result, phone, c Detailed),
UT2 a/b/c stories live (confidence to Low, menu, cut, Undo; panel closed and F-79 in view), UT3 a story live (cut, History, Undo; dark;
commenter hard and 1512; phone). `snap.ts` pins the clock (every banner: 4:15 AM). One Undo per cut: while the cut's toast shows, the
panel's 'Cut on … · Restore' bar waits (`useMkCutToast`). Proposal toasts read 'Proposed a status change'; marks name the new value.
Still open: 'In-app tour' uncoded in built text; 'Not in GT' over the end dot; UT2 phone toasts over b's banner spot. UT3 a in
Detailed: stated in its cost, owner asked.
