# QA pass 4 · Simple priorities · bugs (18)
Found on the mock app (invented data) at desktop 1512 and phone 390, train AD's build. Ids qa4-<area>-N.

## qa4-simple-plan-1 · major · Phone: milestone line chip forces sideways scroll (448 px)
- Page: /simple/priorities
- What: On a phone, picking a milestone line makes the whole page scroll sideways: the red 'Misses its own milestone, Beta · Nov 30, 2026' chip will not wrap and pushes the page to 448 px wide.
- Steps: Phone 390x844, Simple > More > Priorities, Ranked list, Line = 'Milestone: Beta · Nov 30, 2026'. Scroll to Weekly alert digest and swipe sideways.
- Expected: The chip wraps or shortens (e.g. 'Misses its own milestone') so the page stays 390 px wide.
- Where: web/app/simple/priorities/priorities.tsx:1611 (whitespace-nowrap on the own-milestone chip)

## qa4-simple-plan-2 · major · Goal buckets says 'No dated plan yet' while the page has milestones
- Page: /simple/priorities
- What: Goal buckets says 'No dated plan yet, so the work is not placed by milestone', but the same page offers a Beta milestone and two key dates in Line and tags Weekly alert digest 'Milestone Beta'.
- Steps: Ranked list: open the Line menu and see the milestone and key dates. Switch to Goal buckets and read the first sentence.
- Expected: Buckets either places the work by the dated plan that exists, or says why it doesn't (e.g. 'Grouped by goal for this quarter'), without claiming there are no dates.
- Where: web/app/simple/priorities/priorities.tsx:1655

## qa4-simple-plan-6 · major · Compare with Oracle: 'Your order' cards laid out inconsistently
- Page: /simple/priorities
- What: In Compare with Oracle, the 'Your order' cards wrap their details differently, card by card: some put goal/confidence/score on the right, some start them at the left edge and some put the bar on its own line. The column looks ragged.
- Steps: Desktop 1440, Ranked list, turn on Compare with Oracle. Compare cards 1, 2, 3 and 6.
- Expected: Every card in the half-width column uses the same layout (title line, then one left-aligned details line).
- Where: web/app/simple/priorities/priorities.tsx:526 (ml-auto flex-wrap details group)

## qa4-simple-plan-8 · major · Value/effort side list shows scores out of order without a reason
- Page: /simple/priorities
- What: Value / effort's 'Ranked' side list shows scores out of order (1.2, 1.25 / 0.91, 1.25) and doesn't say why. The reason (a dependency, a person's move) appears only in the full Ranked list.
- Steps: Value / effort tab, read the scores in the right-hand Ranked list.
- Expected: Mark moved rows (e.g. 'Oracle #4') and dependency-held rows ('after AR') in the side list too, or leave out the scores.
- Where: web/app/simple/priorities/priorities.tsx:1421 (side list)

## qa4-simple-plan-9 · major · Phone Value/effort: marks sit on top of chart labels
- Page: /simple/priorities
- What: On a phone, Value / effort's marks sit on top of the chart's own labels: AE sits under 'Fill-ins · 3', SI under 'middle effort', and PT runs into 'Later · 2'.
- Steps: Phone 390, Simple > More > Priorities > Value / effort. Look at the bottom of the chart.
- Expected: Quadrant and middle-line labels sit clear of the marks (move them to the edges or outside the plot) or hide when a mark overlaps them.
- Where: web/app/simple/priorities/priorities.tsx:1288-1296

## qa4-simple-plan-33 · major · Line 'Pick a date…' accepts a past date silently
- Page: /simple/priorities
- What: Line > 'Pick a date…' accepts a date in the past (Jan 1, 2025) without a word. Every feature then 'misses' it, all ten names are listed in the caption, and the past date stays in the Line menu as 'Date: Jan 1, 2025'.
- Steps: Ranked list, Line = Pick a date…, enter 01/01/2025, Apply.
- Expected: Past dates are refused or flagged ('That date has passed'), and a one-off date doesn't stay among the saved lines.
- Where: web/app/simple/priorities/priorities.tsx (Line picker)

## qa4-simple-plan-11 · minor · Feature code chips mix two styles
- Page: /simple/priorities
- What: Feature code chips mix two styles: real codes (F-06, F-12) next to two-letter monograms (SC, AR, AM). Some monograms don't match the feature's name ('AS' for Alert routing by team, 'SI' for Team invite nudges, 'SV' for Welcome video), so they look like internal ids.
- Steps: Ranked list: read the chips. Add Team invite nudges to the ranking and its chip reads 'SI'.
- Expected: One code style for every feature. If there is no real code, show none (or letters taken from the shown name).
- Where: web/app/simple/priorities/priorities.tsx:303 (CodeChip shows short_code)

## qa4-simple-plan-12 · minor · Goal buckets put the code before each name as plain text ('SC Setup checklist, F-12 Sample…
- Page: /simple/priorities
- What: Goal buckets put the code before each name as plain text ('SC Setup checklist, F-12 Sample data import'), so the codes read as part of the names. The Ranked list shows codes as chips.
- Steps: Goal buckets: read the feature list under each goal.
- Expected: Use the same chip style as the Ranked list, or names only.
- Where: web/app/simple/priorities/priorities.tsx:1737-1754 (codeOf)

## qa4-simple-plan-17 · minor · In the drawer, 'Show the flow' is plain accent text next to the bordered Accept and Reject…
- Page: /simple/priorities
- What: In the drawer, 'Show the flow' is plain accent text next to the bordered Accept and Reject buttons, so it reads as a label rather than a control.
- Steps: Open the suggestions drawer, look at the Accept / Reject / Show the flow row.
- Expected: The same button style as its neighbours (a ghost button with a hover state), or a disclosure chevron.
- Where: web/components/simple/GoalSuggestions.tsx:251

## qa4-simple-plan-18 · minor · Lookalike names in the drawer mix styles
- Page: /simple/priorities
- What: Lookalike names in the drawer mix styles: 'F-06 Weekly alert digest' has its code, 'Alert history export' doesn't (it is AE everywhere else). Both are dark-yellow underlined links that look nothing like the page's other links.
- Steps: Open the suggestions drawer and read the 'Looks like …' lines.
- Expected: Lookalikes use the same name + code format and link colour as the rest of the page.
- Where: web/components/simple/GoalSuggestions.tsx

## qa4-simple-plan-20 · minor · The 'See or make suggestions · 3' button's accessible name is 'Suggestions for Grow retention'
- Page: /simple/priorities
- What: The 'See or make suggestions · 3' button's accessible name is 'Suggestions for Grow retention'. A voice-control user saying the visible words doesn't match it, and the count isn't announced.
- Steps: Inspect the Goal buckets suggestion button.
- Expected: An accessible name that starts with the visible text, e.g. 'See or make suggestions for Grow retention, 3 waiting'.
- Where: web/components/simple/GoalSuggestions.tsx:332

## qa4-simple-plan-22 · minor · Compare with Oracle: Oracle's column says 'Yours
- Page: /simple/priorities
- What: Compare with Oracle: Oracle's column says 'Yours: #4, moved by other people's moves.', which is awkward, and doesn't say which move pushed it.
- Steps: Ranked list, Compare with Oracle on, after anyone has moved a feature. Read Oracle's order cards 3, 4, 8 and 9.
- Expected: e.g. 'Yours: #4 (pushed down when Mobile alert push moved up)'.
- Where: web/app/simple/priorities/priorities.tsx:610

## qa4-simple-plan-24 · minor · Compare with Oracle: 'No goal' is a yellow warning chip in Your order but plain grey text in…
- Page: /simple/priorities
- What: Compare with Oracle: 'No goal' is a yellow warning chip in Your order but plain grey text in Oracle's order.
- Steps: Turn on Compare with Oracle and look at Alert history export in both columns.
- Expected: The same chip in both columns.
- Where: web/app/simple/priorities/priorities.tsx:534

## qa4-simple-plan-25 · minor · Rows below the line move their meta chips onto a second, right-aligned line whenever an…
- Page: /simple/priorities
- What: Rows below the line move their meta chips onto a second, right-aligned line whenever an 'Oracle #n' or 'moved' chip appears, so neighbouring rows have different heights and alignments.
- Steps: Ranked list, owner accepts a move for Welcome video, or picks a key-date line. Compare rows 8 and 9 with the rest.
- Expected: Ghost/moved chips sit in a fixed slot so every row keeps the same layout.
- Where: web/app/simple/priorities/priorities.tsx:516-526

## qa4-simple-plan-26 · minor · For a commenter, the explanation 'You can't move this one
- Page: /simple/priorities
- What: For a commenter, the explanation 'You can't move this one: it is on a roadmap you don't have open to you.' is clumsy and doesn't say what to do.
- Steps: Sign in as commenter, Ranked list, look at New plan tiers.
- Expected: e.g. 'Only people with access to the Pricing roadmap can move this. Ask the owner.'

## qa4-simple-plan-28 · minor · On a phone, the line label wraps to two lines ('… everything below / misses it') with the rule…
- Page: /simple/priorities
- What: On a phone, the line label wraps to two lines ('… everything below / misses it') with the rule only at the left, so it reads as a sentence rather than a divider.
- Steps: Phone 390, Ranked list (or Value / effort side list), find the line.
- Expected: A shorter label on phone ('This quarter's line') with the rule spanning both sides, or the rule above the label.

## qa4-simple-plan-29 · minor · The tabs have role=tab but no aria-controls, and the panels aren't labelled by their tab, so…
- Page: /simple/priorities
- What: The tabs have role=tab but no aria-controls, and the panels aren't labelled by their tab, so screen readers don't link them.
- Steps: Inspect the 'Priorities views' tablist.
- Expected: Each tab has aria-controls pointing to a role=tabpanel labelled by the tab.
- Where: web/app/simple/priorities/priorities.tsx:221

## qa4-simple-plan-30 · minor · In dark mode, the second paragraph of Value / effort's help text is a dimmer grey than the…
- Page: /simple/priorities
- What: In dark mode, the second paragraph of Value / effort's help text is a dimmer grey than the first, so the drag instructions look disabled.
- Steps: Dark theme, Value / effort, read the two paragraphs under the legend.
- Expected: One text colour for both paragraphs.
