# Lane: v2 design, the Atlas and Ledger blend (I3, V2b)

One SwarmCloud `claude-code` task, strategy `collect` (artifacts only). The orchestrator
reviews every rendered frame before the owner sees it.

## Prompt

THE BLENDED DESIGN for Product Oracle v2. Read first:
- docs/questions.md rows I3 (UI visual language: the chosen direction), V2b (what Oracle is for its users), V2c (where its AI work runs), P3d (cost is secondary), O1c (no inline citations), O1f (brief, full, Present), C1/C2 (review), T2 (advisory readiness), O4 (Now/Next/Later);
- docs/product-oracle-v2/build-prompt.md §0 and §13;
- docs/product-oracle-v2/design/directions/atlas/ and .../ledger/: the two directions the owner liked. Read their README, tokens.json and every HTML file. Broadsheet is there for reference only.

The owner's words (2026-10-19): "I like the direction for both Atlas and Ledger but I don't want a heavy UI with a lot of prose. Instead I'd like a light, breathable and clean UX/UI that offers all of the features and capabilities the current mockups and the build brief design offer, but with helper texts under tooltip icons and indicators consolidated into fewer cards, so the UI does not look busy or cluttered, and nothing is hard to find by looking at it."

Make ONE direction that blends them:
- Atlas's orientation: the PRD journey track, a confident accent used sparingly, and the feature x goal view.
- Ledger's precision: tables, and inspectors that open in place.
- Light and breathable: generous whitespace, a calm neutral base, one accent, and type that is clear rather than loud.
- Copy: every sentence of explanation becomes a tooltip behind a small (i) icon. Draw one tooltip open in one frame so its style is visible. Labels stay short.
- Indicators: consolidate them. One summary strip or one card where today there are four. Status shows as small chips, never paragraphs.
- Findability: the same thing is always in the same place on every screen (title, primary action, status, inspector).
- Cost stays secondary (P3d): one small line on a run, and prominent only in the approval and overrun items of the inbox.
Write tokens.json and a short README (the blend's rules: what came from Atlas, what from Ledger, what is new; tooltip and card rules), then static HTML mockups (Google Fonts only, no other network, no scripts needed), with realistic SYNTHETIC content for the same fictional company, Quillfield, software for independent vet clinics. Never use real company data.

The screens cover V2b's whole loop:
1. home: what needs me (decisions, reviews, questions) and my product tracks at a glance, in few cards;
2. requests: feature requests and feedback in one inbox: their sources (support, sales, Slack, interviews), duplicates merged, linked to goals, each qualified or disqualified with a reason;
3. baseline: goals and the features serving them (the starting point a PRD builds on), with the flagged, conflicts and proposals counts as chips;
4. idea-interview: a new product idea in Opportunity and Gaps, where the questions are asked as an INTERACTIVE INTERVIEW (a chat-like exchange with Oracle, real time, per V2c) instead of a form, with "I don't know", defer, ask someone and research this as quick replies;
5. prd-review: a PRD section under review: versions, Brief/Full, section status and revision, reviewers, the evidence inspector on one claim, the composition, and review suggestions being qualified or disqualified (accept, reject with a reason);
6. priorities: coordinating priorities for features and milestones: an ordered list with goal fit, confidence, effort, and the milestone each lands in, with drag handles and a "why this order" tooltip;
7. roadmap: the roadmap derived from the approved PRD, priorities and timeline constraints (Now/Next/Later with milestones; no invented dates), and the monitoring of each product track that an accepted PRD started (track status, drift, the next milestone, items at risk);
8. runs: agent work in SwarmCloud: runs with segments and roles, a checkpoint waiting, and cost as one small line;
9. publish: the publish check: what blocks, the hard checks, the ten advisory readiness criteria (T2), and what publishing records.
Render each with Playwright to PNG: desktop 1440x900 in light AND dark, plus phone 390 wide in light for home, idea-interview and prd-review. For the phone, size the viewport to the page height so that fixed bars sit at the bottom. Name them <screen>-<light|dark>-<desktop|mobile>.png beside the HTML. Write index.html (all frames) and design-blend-report.md: the blend's rules, a contrast table (WCAG AA for every text and background pair), and anything you could not render.

Check every PNG before finishing:
- nothing is drawn twice;
- no control exists that Oracle does not have or v2/V2b does not add;
- no text is clipped or overlapping;
- dark mode is a real theme;
- phone frames have no horizontal scroll;
- each screen has at most one primary action, and no paragraph of helper text is visible outside a tooltip;
- run segments and roles match Oracle's flows (Baseline proposal: researcher, analyst; Feature set, dependencies and design: analyst, architect; Priority order: prioritizer; PRD draft: writer, critic), and counts agree with the rows they summarise.
Fix and re-render anything that fails. Put everything under $SWARM_ARTIFACTS_DIR (blend/<files>, index.html, design-blend-report.md).
