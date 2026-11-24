# mk-saved-views: what exists today (read from the mock app, Nov 24, 2026)

- Simple Roadmap (`/simple/roadmap`): view tabs Timeline / Gantt / Now-Next-Later / Waterfall; a filter row
  (Removed, Roadmap, PRD, Goal, Track, Owner, From, To, Tracks) in `web/app/simple/roadmap/_roadmap.tsx` (`pickers`).
  Picks are local state seeded from the URL and remembered per person (`simple_filters` prefs); the URL is not written back.
  On a phone the pickers sit behind a Filters button. No status, confidence or draft filter. No saved views.
- Simple Priorities (`/simple/priorities`): tabs Ranked list / Value-effort / Goal buckets, the Line picker, and Show
  chips (All, New, In progress, Exists). A goal filter comes from the URL. No saved views.
- Detailed Priorities (`/priorities`): count chips (ranked, no goal, in a cycle) and the scoring method; no saved views.
- Detailed Plan (`/plan`): only the Plan scope control (Approved + drafts / Approved only); no PRD/Goal/Owner pickers,
  so the mock-ups draw Detailed on Priorities.
- Roles in the mock: localStorage `po-mock-role` (viewer, commenter, approver; none = owner). Theme: `oracle-theme`.

# Mock-up switches (all lines marked MOCK-HOOK)
- `web/components/MockSavedViews.tsx`, mounted in the Roadmap filter row, above Simple Priorities' Show chips, and under
  Detailed Priorities' header.
- `?sv1=a|b|c|d` placement, `?sv2=a|b|c|d` sharing, `?sv3=a|b|c` managing; states `open=1|save|more|manage|overflow`,
  `phase=mid|done`, `name=`, `cur=<view id>`, `edited=1`, `many=1` (ten long names), `as=commenter|viewer`,
  `vname=` (the typed name; `name=` is the Priorities page's own goal name), `share=all`, `rights=oa`, `renamed=`, `removed=<id>`, `toast=`, `fromlink=1`, `cost=`.
- Frames: captured by an iframe host in the live browser; the iframe is the frame's real width (1512 frames are 1512 wide, not scaled) and the PNG is clipped to it. Scrollbars are the live browser's own (its launch flags are not ours to set).
- SV2 and SV3 build on SV1 B (and SV3 C on SV1 A), so they skip a second "at rest" frame of the same page.

# Status (review round 1, Nov 24, 2026)
- Fixed every finding and minor in verdict.json; all 70 frames re-snapped (HTML + light PNG + dark PNG), picks.json rebuilt.
- The live browser crashed for good after the full re-snap. Left without a fresh PNG:
  `sv3-c-phone-390` (its HTML now opens with the strip scrolled to the saved long-named tab and its ⋯; the PNG and its
  dark PNG were removed because they showed the unscrolled strip) and `sv3-b-phone-390-dark.png` (removed: stale).
  Re-run `tools/cap.py frames.json sv3-c-phone` and the dark pass for those two.
- Not drawn: a default being changed (reorder is drawn in sv3-a-open). For the owner: the built page's "Not in GT" badge
  is overdrawn by a dependency line and abbreviates Ground Truth; that is the built page, not this lane.
- Gates: tsc passed. Lint, Playwright and the prose guard not run (mock-ups only).

# Status (review round 2 fixes, Nov 24, 2026)
- SV3 C phone: light and dark PNGs captured; on the phone a tab name is capped shorter (8rem) so the picked tab and its ⋯
  fit whole after the strip scrolls to it. SV3 B phone dark PNG captured.
- SV1 B View button on the phone: capped at the row width, the name cut with an ellipsis (full name stays in the sheet).
  Measured document scrollWidth 375 (page fits 390) on sv3-a, sv3-b and sv3-c phone frames.
- Phone tab strip (SV1 A, SV3 C): fades out over its last 1.5rem, so no sliver of the next tab shows before + Save view.
- A saved view with Drafts only (cur=new, added=) now narrows the timeline to its 2 items (MOCK-HOOK in `_roadmap.tsx` data);
  re-snapped sv1-a..d-result and sv2-a/c/d-result, light and dark.
- Tools now use this workspace's paths; frames.json is built by `tools/gen.py` into $TMPDIR/cap.
- For the owner (built page, not this lane): "Not in GT" overdrawn by a dependency line; at the side-list width (SV1 C)
  the "M6 Beta" chip covers the start of "Board meeting".
- Gates: tsc passed; eslint on the two touched files shows 2 old import-order errors on `_roadmap.tsx` line 3 (from round 1's
  MOCK-HOOK import), none new. Playwright and the prose guard not run (mock-ups only).

# Status (review round 3 fixes, Nov 24, 2026)
- SV3 C phone: the picked saved view (Everything the onboarding team still owes…, Goal: Grow retention) is now applied:
  the page shows Showing Grow retention only: 4 of 22 and only Grow retention rows; the tab counts 4. On Simple Priorities
  a view's count is the page's own (All items 22 there, as the Show chip says; 19 on the roadmap and Detailed).
  `gen.py` puts the goal on every Priorities frame whose picked view is one of the long-named ones (SV3 A, B, C phone).
- Phone tab strip: no scrollbar drawn (`scrollbar-width: none`); the right-edge fade stays.
- SV1 A: when the filters were changed on a built-in view, an Edited mark sits after Drafts only (desktop and phone).
- `_roadmap.tsx` line 2047 (`let items`) now carries its MOCK-HOOK marker.
- Re-snapped light and dark: every phone frame, sv1-a-rest, -open, -mid, -detailed.
- Tools now point at this workspace and $TMPDIR (`/cache/<attempt>/tmp/cap`).
- Gates: tsc passed; eslint 2 old import-order errors on `_roadmap.tsx` line 3, none new. Playwright and the prose guard
  not run (mock-ups only).
- Not changed (built page, for the owner): "Not in GT" overdrawn by a dependency line; "M6 Beta" covers the start of
  "Board meeting" at the side-list width. Seen but not in the findings: sv2-b-phone's link banner wraps so a line starts with "·".
