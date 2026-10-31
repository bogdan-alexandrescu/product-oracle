# QA pass 4 · Plan, priorities, baseline, impact · bugs (41)
Found on the mock app (invented data) at desktop 1512 and phone 390, train AD's build. Ids qa4-<area>-N.

## qa4-plan-1 · major · Priorities: 'Oracle #' column squeezes feature names mid-word
- Page: /priorities
- What: After moving one feature, an 'Oracle #' column appears and squeezes the Feature column so names break mid-word ('Addres s lookup service', 'Shippin g cost', 'checko ut').
- Steps: Sign in as owner, /priorities at 1440 wide, click ▲ or More on a row and save a move with a reason; look at the Feature column.
- Expected: Feature names keep a minimum width and wrap only between words; the extra column takes space from elsewhere (or the inspector narrows).
- Where: web/app/priorities/page.tsx:1056

## qa4-plan-2 · major · A saved move does nothing visible
- Page: /priorities
- What: A saved move does nothing visible: the change reads 'Moved above Saved addresses at checkout' for Address lookup service, which was already #1, and every row's # equals its Oracle #.
- Steps: /priorities, on row 1 'Address lookup service' use More > Move, pick 'above Saved addresses at checkout', give a reason, save; compare # and Oracle # columns and the Changes list.
- Expected: Either refuse a move that cannot change the order (say why) or show the new rank; the change should not claim a move that did not happen.
- Where: web/app/priorities/_components/overrides.tsx:135

## qa4-plan-3 · major · Plan treats a roadmap as approved; Documents and Launches say not
- Page: /plan
- What: The Plan treats the Usage alerts roadmap v1 as approved (items On track; 'Approved only' still lists them) while Documents says 'In review / Not approved yet', Launches says there is no approved roadmap and Edit plan says version 1 is in review.
- Steps: Open /plan, note the Roadmap card and pick 'Approved only'; open Documents tab, then Launches, then Edit plan on /plan.
- Expected: One approval state for the roadmap, the same on Plan, Documents, Launches and Edit plan.

## qa4-plan-4 · major · A PRD's roadmap draft on Plan is missing from Documents
- Page: /plan
- What: The Checkout redesign PRD card says 'roadmap draft 2' and the Roadmap table shows its draft items, but that roadmap appears nowhere on the Documents tab (which says '1 roadmap').
- Steps: /plan: read the Checkout redesign PRD card in 'PRDs in play' and the Checkout redesign rows in the table; open Documents.
- Expected: Every roadmap the Plan shows is listed (and openable) on Documents, or the Plan says where the draft lives.

## qa4-plan-7 · major · Report says milestone has a verified basis while an item slips past it
- Page: /plan/reports/<id>
- What: The report says the next milestone 'First release, Nov 30' has 'a verified basis supports it' while the same card lists ENG-405 slipping to Dec 9, after that milestone, and counts '1 Dates slipping'.
- Steps: /plan/reports, open the newest report (or Latest report); read the Usage alerts PRD card.
- Expected: When an item slips past the milestone, the milestone line says it is at risk, not only that a verified date supports it.

## qa4-plan-8 · minor · When the table is scrolled, the sticky header leaves a strip of the row underneath visible…
- Page: /priorities
- What: When the table is scrolled, the sticky header leaves a strip of the row underneath visible (half-cut 'Bulk export', '50%' text peeks between header and top edge).
- Steps: /priorities at 1440x900, scroll down a little so the header sticks.
- Expected: Sticky header fully covers rows that scroll under it.

## qa4-plan-9 · minor · 'Ranked higher' is an outlined pill on row 1 but a filled blue pill on row 5
- Page: /priorities
- What: 'Ranked higher' is an outlined pill on row 1 but a filled blue pill on row 5; same flag, two looks.
- Steps: /priorities, compare the Flags of Address lookup service and Scheduled exports.
- Expected: One style per flag.

## qa4-plan-11 · minor · Row 7 'Shared projects' has its ▼ disabled although row 8 is below it, with no hint why
- Page: /priorities
- What: Row 7 'Shared projects' has its ▼ disabled although row 8 is below it, with no hint why.
- Steps: /priorities, look at the ▲▼ arrows on rows 7 and 8; hover the disabled ▼.
- Expected: Either allow the move or show why (tooltip: 'Dark mode has no goal').

## qa4-plan-12 · minor · Dark mode (no goal) shows Score '0.00' as if it were scored, next to the 'No goal' flag
- Page: /priorities
- What: Dark mode (no goal) shows Score '0.00' as if it were scored, next to the 'No goal' flag.
- Steps: /priorities, row 8.
- Expected: Show '—' for a feature that cannot be scored.

## qa4-plan-14 · minor · Saving a snapshot shows a green toast repeating the row that appears directly under it (same…
- Page: /priorities
- What: Saving a snapshot shows a green toast repeating the row that appears directly under it (same top-5 list twice).
- Steps: /priorities, Save snapshot.
- Expected: A short confirmation ('Snapshot saved') or just the new row highlighted.

## qa4-plan-15 · minor · The Changes list and the inspector show the mover as 'admin@example.com' rather than a name
- Page: /priorities
- What: The Changes list and the inspector show the mover as 'admin@example.com' rather than a name.
- Steps: /priorities, make a move, read Changes and the right-hand 'Your change'.
- Expected: The person's name (email only on hover).

## qa4-plan-17 · minor · On phone, 'By goal' drops the ranked-feature count and bar and shows only 'Top #1', so the…
- Page: /priorities
- What: On phone, 'By goal' drops the ranked-feature count and bar and shows only 'Top #1', so the card loses its main number.
- Steps: /priorities at 390 wide, scroll to By goal.
- Expected: Keep '3 ranked · top #1' on phone.

## qa4-plan-18 · minor · Milestone inspector: the Horizon and Status segmented controls draw a full-width border box…
- Page: /plan
- What: Milestone inspector: the Horizon and Status segmented controls draw a full-width border box with the buttons bunched to the left and empty space inside.
- Steps: /plan, click milestone M1 on the track card; look at the inspector.
- Expected: Border hugs the buttons, or the buttons fill the box evenly.

## qa4-plan-20 · minor · Selecting a milestone leaves the previously selected roadmap row ('Threshold alerts on spend')…
- Page: /plan
- What: Selecting a milestone leaves the previously selected roadmap row ('Threshold alerts on spend') highlighted while the inspector shows the milestone.
- Steps: /plan, click a roadmap row, then click milestone M1.
- Expected: Only the item shown in the inspector stays highlighted.

## qa4-plan-21 · minor · Edit plan: Up / Down / Defer are plain text with no button look
- Page: /plan
- What: Edit plan: Up / Down / Defer are plain text with no button look; enabled and disabled differ only by grey vs dark text.
- Steps: /plan, click Edit plan.
- Expected: Real buttons with a clear disabled state.

## qa4-plan-22 · minor · Versions are named two ways
- Page: /plan
- What: Versions are named two ways: Edit plan lists Budgets per team under Later in 'version 1' while the table says 'Dropped in draft 2 (was Planned)'.
- Steps: /plan, read the Later row 'Budgets per team', then open Edit plan.
- Expected: One naming (draft N or version N) and the same state for the item in both places.

## qa4-plan-23 · minor · Roadmap rows labelled 'From Baseline
- Page: /plan
- What: Roadmap rows labelled 'From Baseline: A new item' — reads like a placeholder; it does not say what came from Baseline.
- Steps: /plan, look at the source line of new roadmap rows / inspector.
- Expected: Name the baseline item, e.g. 'New — not in the baseline'.

## qa4-plan-24 · minor · Confidence ring shows '–' with no explanation
- Page: /plan
- What: Every goal's confidence ring is empty with '–' and the word 'confidence', which looks broken; nothing says why it has no value.
- Steps: /plan Goals card; /baseline Goals.
- Expected: Hide the ring until there is a value, or say 'No confidence yet — add evidence'.

## qa4-plan-25 · minor · The '+2' chip after a goal on 'Usage dashboard' has no visible meaning (only a hover tooltip…
- Page: /plan
- What: The '+2' chip after a goal on 'Usage dashboard' has no visible meaning (only a hover tooltip, none on phone).
- Steps: /plan, Roadmap row Usage dashboard, Goal column.
- Expected: Say '+2 goals' or list them on tap.

## qa4-plan-26 · minor · 'At risk: 1 of 7 items need attention (1 may be out of date, 1 slipping)' gives two reasons…
- Page: /plan
- What: 'At risk: 1 of 7 items need attention (1 may be out of date, 1 slipping)' gives two reasons for one item, which reads as two items; 'Check now' then says 1 item.
- Steps: /plan track card; same text on the report.
- Expected: Count reasons and items separately ('1 item: slipping and may be out of date').

## qa4-plan-27 · minor · Inspector History line 'PRD v1 Now · in a draft' is unclear
- Page: /plan
- What: Inspector History line 'PRD v1 Now · in a draft' is unclear.
- Steps: /plan, click a roadmap row, read History.
- Expected: Plain sentence, e.g. 'Added to Now in draft 2 from PRD v1'.

## qa4-plan-30 · minor · A roadmap row shows a raw repository reference 'acme/app#418' as its engineering link text
- Page: /plan
- What: A roadmap row shows a raw repository reference 'acme/app#418' as its engineering link text.
- Steps: /plan at 390 wide, Roadmap row 'Spend forecast for the month'.
- Expected: Show the issue title or 'Issue 418'.

## qa4-plan-31 · minor · ENG-402 shows 'Nov 20 ✓ verified date' on the Plan but the Dates page lists only ENG-412 and…
- Page: /plan/dates
- What: ENG-402 shows 'Nov 20 ✓ verified date' on the Plan but the Dates page lists only ENG-412 and ENG-413, so you cannot find where ENG-402's date was verified.
- Steps: /plan, row 'Threshold alerts on spend'; then Dates tab, All.
- Expected: Every verified date shown on the Plan is listed on Dates.

## qa4-plan-32 · minor · The Dates column header 'Supports' (holding a date) and 'For
- Page: /plan/dates
- What: The Dates column header 'Supports' (holding a date) and 'For: Whole PRD' are unclear.
- Steps: /plan/dates.
- Expected: Headers like 'Date' and 'Applies to'.

## qa4-plan-34 · minor · Documents marks state two ways
- Page: /plan/documents
- What: Documents marks state two ways: a dot + 'In review' in the list and a pill 'In review' / 'Not approved yet' in the detail.
- Steps: /plan/documents.
- Expected: One state style.

## qa4-plan-35 · minor · An '0 outcomes' chip sits right beside the empty state that already says there are none
- Page: /plan/outcomes
- What: An '0 outcomes' chip sits right beside the empty state that already says there are none.
- Steps: /plan/outcomes.
- Expected: Drop the zero chip when empty.

## qa4-plan-36 · minor · The info button is named 'About Alignment reports' while the tab and page say 'Reports'
- Page: /plan/reports
- What: The info button is named 'About Alignment reports' while the tab and page say 'Reports'; on Latest report the Reports tab is highlighted instead of the Latest report link.
- Steps: /plan/reports, focus the (i) button; then click Latest report.
- Expected: One name; highlight the link actually opened.

## qa4-plan-37 · minor · On phone the report title is cut to 'Alignment so far · wee…' with no way to read the rest
- Page: /plan/reports/<id>
- What: On phone the report title is cut to 'Alignment so far · wee…' with no way to read the rest.
- Steps: /plan/reports at 390 wide, open a report.
- Expected: Wrap the title or show it in full below the bar.

## qa4-plan-38 · minor · On phone the tab strip opens scrolled so a sliver of the previous tab ('s' of Documents) shows…
- Page: /plan
- What: On phone the tab strip opens scrolled so a sliver of the previous tab ('s' of Documents) shows at the left edge.
- Steps: /plan/reports or /plan/documents at 390 wide.
- Expected: Scroll the active tab into view without cutting a neighbour mid-word (or fade the edge).

## qa4-plan-39 · minor · Report text uses internal terms
- Page: /plan/reports/<id>
- What: Report text uses internal terms: 'On demand' pill, 'Now items without an issue', 'untracked', '11 baseline items changed'.
- Steps: /plan/reports, open the newest report.
- Expected: Plain words ('Made by hand', 'Now items with no engineering ticket').

## qa4-plan-42 · minor · Goal progress uses two methods
- Page: /baseline
- What: Goal progress uses two methods: '50% of the way from 31% to ≥45%' vs '78% of the way to ≥12%' (from zero) for a goal that fell 1.8 pts; the Plan says '2.6 pts to go'.
- Steps: /baseline Goals; /plan Goals.
- Expected: One method, and the same figure on both pages.

## qa4-plan-43 · minor · On phone the Usage export row loses its 'Proposed' pill, goal link pills have no left padding…
- Page: /baseline
- What: On phone the Usage export row loses its 'Proposed' pill, goal link pills have no left padding (text touches the border), and the Goals card drops Owner/Horizon/Metric.
- Steps: /baseline at 390 wide.
- Expected: Same facts as desktop, padded pills.

## qa4-plan-44 · minor · Impact pages take about 3.5 s to show on the mock (all other pages ~1.7 s)
- Page: /impact/changes/<id>
- What: Impact pages take about 3.5 s to show on the mock (all other pages ~1.7 s).
- Steps: Open /impact/changes/<id> from a PRD's change history, or /impact/entities/<id> from Baseline; time to content.
- Expected: Under 2 s, or a skeleton straight away.

## qa4-plan-45 · minor · The back crumb '‹ Impact of Checkout redesign PRD v2' sits on the same line as a long H1 that…
- Page: /impact/changes/<id>
- What: The back crumb '‹ Impact of Checkout redesign PRD v2' sits on the same line as a long H1 that repeats it ('Impact: Checkout redesign PRD v2 › Success metrics section edited').
- Steps: Open an impact change page.
- Expected: Crumb above the title; title without repeating the crumb.

## qa4-plan-46 · minor · The Lineage legend always lists 'deleted upstream' (red dashed) even when nothing was deleted
- Page: /impact/changes/<id>
- What: The Lineage legend always lists 'deleted upstream' (red dashed) even when nothing was deleted.
- Steps: Open any impact page.
- Expected: Show only legend entries that appear in the diagram.

## qa4-plan-47 · minor · With one outcome the table cuts every cell with an ellipsis ('Threshold ale…', '+5 points by…
- Page: /plan/outcomes
- What: With one outcome the table cuts every cell with an ellipsis ('Threshold ale…', '+5 points by Dec 15, 20…', 'Dec 15, 2…') while the rest of the page is empty.
- Steps: /plan/outcomes, Track outcome and fill it (or open with one outcome) at 1440 wide.
- Expected: Item, prediction and due date shown in full (wrap, or drop the repeated date from Predicted).

## qa4-plan-48 · minor · The outcome inspector reads 'Predicted ? → +5 points'
- Page: /plan/outcomes
- What: The outcome inspector reads 'Predicted ? → +5 points': a bare question mark stands for the unknown starting value; the Metric 'activation rate' also differs from the goal's metric 'Accounts that finish setup within 7 days'.
- Steps: /plan/outcomes, select the outcome.
- Expected: 'From today's value (not measured yet) → +5 points', and the goal's own metric name.

## qa4-plan-49 · minor · Goal Owner shows 'Approver' (a role) instead of a person, next to goals marked 'No owner' /…
- Page: /baseline
- What: Goal Owner shows 'Approver' (a role) instead of a person, next to goals marked 'No owner' / 'Name an owner'.
- Steps: /baseline, Goals table, Owner column.
- Expected: A person's name, or 'No owner' consistently.
- Note: may be the mock's data, not the product: fix the mock if the mock is wrong, else say so and skip.

## qa4-plan-50 · minor · Progress text breaks between '≥' and its number ('from 31% to ≥ / 45%'), and Horizon 'Medium ·…
- Page: /baseline
- What: Progress text breaks between '≥' and its number ('from 31% to ≥ / 45%'), and Horizon 'Medium · Jun 30' wraps mid-date.
- Steps: /baseline at 1440 wide, Goals table.
- Expected: Keep '≥ 45%' and dates on one line (non-breaking).

## qa4-plan-51 · minor · The header says '5/6 Features traced' but the Feature × goal grid lists 6 features with no…
- Page: /baseline
- What: The header says '5/6 Features traced' but the Feature × goal grid lists 6 features with no mark showing which one is not traced.
- Steps: /baseline, compare the top tile with the grid.
- Expected: Mark the untraced feature, or link the tile to it.

## qa4-plan-52 · minor · Button 'Read targets from 1 goal's text' does not say what will happen
- Page: /baseline
- What: Button 'Read targets from 1 goal's text' does not say what will happen.
- Steps: /baseline, Goals header.
- Expected: A label like 'Fill target from the goal's wording (1)'.
