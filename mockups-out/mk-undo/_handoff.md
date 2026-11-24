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
