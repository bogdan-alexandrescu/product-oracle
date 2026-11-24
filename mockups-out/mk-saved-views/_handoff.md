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
