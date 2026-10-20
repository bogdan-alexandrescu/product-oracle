# Lane: v2 design system, B1 Split in the web app (I3)

One SwarmCloud `claude-code` task, strategy `direct-pr`, on main. It builds the chosen
design (I3: B1 Split) into `web/` as tokens, a component kit and the app shell, and
restyles today's screens with it. The new v2 screens (requests, roadmap tracks, interviews,
publish check) come in the UI wave, once their APIs merge; this lane gives them their parts.

## Prompt

THE DESIGN SYSTEM for Product Oracle v2's web app. Read first:
- docs/questions.md I3 (the chosen design and every rule on the way to it), P3d (cost is secondary: one small figure on a run, prominent only on cost approvals and overruns), V2b, T2, O4, B4, W5;
- docs/product-oracle-v2/design/chosen/B1/: README.md, tokens.json, report.md, the nine HTML screens, src/b1.css, and every PNG in frames/ (light, dark, phone). These are the target. Match them;
- web/AGENTS.md, web/app/layout.tsx, web/app/globals.css, web/components/ (AppNav, AppHeader, ui.tsx), web/lib/api, and web/e2e.

The rules the design was chosen under (I3), which every component must keep:
1. No visible prose: labels of one to three words, numbers, chips, icons and charts; explanations behind a small (i) tooltip. Row titles stay one line.
2. Readable: body 15 px, nothing under 13 px; every text and background pair at least 4.5:1, body text at least 7:1; tabular figures.
3. Same place on every screen: title and status top-left, one primary action top-right, the inspector on the right (below the table on a phone).
4. Goal progress is distance to go in the goal's own unit ("5 pts to go"); rings show confidence.
5. Dark is a real theme, chosen by the system setting and switchable in the user menu.

Build, in this order, with tests where behaviour exists:
1. **Tokens**: tokens.json as CSS custom properties (light and dark), in globals.css and the Tailwind theme the app already uses. Fonts from B1 via next/font (no runtime Google Fonts request). One source of truth: no hard-coded colours in components.
2. **Components** in web/components/ds/ (typed, server-component friendly where possible, client only where interactive): AppShell (dark rail with the nine destinations Home, Requests, Baseline, PRDs, Priorities, Roadmap, Runs, Inbox, Settings, counts as badges; phone tab bar Home, PRDs, Roadmap, Inbox, More), PageHeader (title, status chips, one primary action), DataTable (one-line rows, hairlines, selected row, sticky header, keyboard row selection, empty and loading states), Inspector (dark head with eyebrow, title, chips and Open; stat strip; sections), Chip (status kinds), GoalTag (G1-style), Ring (confidence 0-100), Sparkline (with dashed target), Meter (bar with value), JourneyTrack (the nine steps, compact dots on a phone), SegmentedControl, InfoTip (the (i) tooltip, keyboard and screen-reader accessible), KpiStrip, Avatar, CostFigure (small mono figure; prominent variant only for approvals and overruns).
3. **App shell**: replace AppNav/AppHeader with AppShell everywhere; destinations that have no page yet (Home, Requests) get a placeholder page in the new layout that says nothing beyond its title, so navigation is complete. The user menu holds the theme switch.
4. **Restyle today's screens** with the kit, keeping behaviour and API calls unchanged: baseline, documents (list, version view, review: the PRD review frame is the target), priorities, roadmap, runs, inbox, sources, settings. Where a screen has no B1 frame, follow the nearest one (settings like baseline's table plus inspector).
5. **A kit page** at /design (owners only, not in navigation) showing every component in each state, light and dark, so the UI wave and reviewers can see the parts.

Check before finishing: run the app against the mock (`npm run build:mock`, `start:mock`), screenshot every restyled page and /design at 1440x900 light and dark and at 390 wide, open each PNG and compare it with the B1 frames; nothing clipped, no horizontal scroll on a phone, no text under 13 px, contrast as above. Update Playwright tests whose selectors changed (keep their intent), add tests for DataTable keyboard selection and InfoTip. Run web lint, tsc, build, build:mock and the full Playwright suite against the mock, and the API suite if you touched anything there (you should not need to). Commit, open the PR, and write $SWARM_ARTIFACTS_DIR/v2-design-system-report.md with the before/after screenshots listed, the contrast table, and anything that could not match the frames and why.

Never touch .github/, deployment files, private/ or api/ (except regenerating nothing). No real company data: mock data stays the fictional Quillfield set.
