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
  `added=`, `share=all`, `rights=oa`, `renamed=`, `removed=<id>`, `toast=`, `fromlink=1`, `cost=`.
- Frames: captured by an iframe host in the live 1440 browser (1512 is scaled to fit for the PNG; the HTML carries
  `mockup-viewport` 1512x982). Scrollbars are the live browser's own (its launch flags are not ours to set).
- SV2 and SV3 build on SV1 B (and SV3 C on SV1 A), so they skip a second "at rest" frame of the same page.
