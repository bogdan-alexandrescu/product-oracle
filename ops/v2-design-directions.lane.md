# Lane: v2 design directions (I3, redesign now)

One SwarmCloud `claude-code` task, strategy `collect` (artifacts only, no PR). The
orchestrator reviews every rendered frame before the owner sees an options page.

## Prompt

DESIGN DIRECTIONS for Product Oracle v2. The owner decided on 2026-10-19 (I3 UI visual language in docs/questions.md) to redesign Oracle's app UI before any v2 screen is built. Your job is three distinct visual directions for the owner to choose from. You do NOT change application code.

Read first:
- docs/product-oracle-v2/build-prompt.md §0 and §13 (the user journey and the screens v2 adds);
- docs/product-oracle-v2/waves.md (design track);
- docs/design.md;
- docs/questions.md rows I4 (a workspace, not a chat-first app), O1c (no inline citations in document bodies; evidence in a "Sources and data points" appendix and an inspector), O1f (brief, full and Present) and C1/C2 (review);
- then web/app, web/components and web/app/globals.css, to learn today's screens, navigation and information architecture.
Oracle is a company's AI head of product, used by product people, founders and reviewers. It should feel trustworthy, calm under dense information, and opinionated.

Make THREE directions that differ in kind, not in shade: for example in density, typography, colour temperature and the navigation pattern. Each is accessible: WCAG AA contrast, checked and reported for every text/background pair. Keep today's information architecture (Baseline, Runs, PRDs, Roadmap, Inbox, plus the new product idea entry) unless a direction proposes a change, which it must label as such. The app UI is separate from the document themes (roadmap-board and the others): do not restyle documents.

For each direction write:
- directions/<slug>/README.md: name, a one-paragraph rationale, who it suits, and its risks;
- directions/<slug>/tokens.json: colour for light and dark, type scale with Google Fonts families, spacing, radius, elevation, motion;
- static HTML mockups (one self-contained file each, fonts from Google Fonts only, no other network) of the same FIVE screens, with realistic SYNTHETIC content for a fictional company (never real company data):
  1. baseline: goals, the features serving them, confidence and evidence counts;
  2. idea-gaps: a short product idea turned into "Opportunity and Gaps", with conflicts, missing goals, assumptions, the top uncertainties and a batch of three questions with "I don't know / defer / ask someone / research this";
  3. prd-review: a PRD section under review, with section status and revision, the evidence inspector open on one claim, and the module composition inspector in a side panel;
  4. runs-inbox: a run with segments, cost against estimate, and a checkpoint waiting for a decision;
  5. publish: the publish dialog with readiness results (pass, warning, critical, not applicable) and what blocks.
Render each screen with Playwright to PNG: desktop 1440x900 in light AND dark, plus mobile 390x844 in light for idea-gaps and prd-review. Name them <screen>-<light|dark>-<desktop|mobile>.png beside the HTML.
Then write index.html, comparing the directions screen by screen, and design-directions-report.md: what each direction optimises, the contrast table, and anything you could not render.

Check your own output before finishing. Open every PNG and confirm:
- nothing is drawn twice;
- no control exists that Oracle does not have or v2 does not add;
- no text is clipped or overlapping;
- dark mode is a real theme, not inverted colours;
- the mobile frames have no horizontal scroll.
Fix and re-render anything that fails.

Put everything under $SWARM_ARTIFACTS_DIR (directions/<slug>/..., index.html, design-directions-report.md).
