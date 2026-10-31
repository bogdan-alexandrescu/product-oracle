# QA pass 4 · Simple roadmap · bugs (42)
Found on the mock app (invented data) at desktop 1512 and phone 390, train AD's build. Ids qa4-<area>-N.

## qa4-simple-roadmap-1 · major · Now/Next/Later by Goal puts ~20 goal items under 'No goal'
- Page: /simple/roadmap
- What: Now / Next / Later grouped by Goal puts items that belong to the Reliability, Revenue, Growth and Activation goals under "No goal" (e.g. Setup failure alerts, Pricing page words, Team invites, Bulk import), while Timeline, Gantt and Waterfall show them under their goals.
- Steps: Simple > Roadmap (All roadmaps) > Group by Goal > Now / Next / Later; compare the Now column's No goal section with the Timeline's Reliability/Revenue/Growth/Activation lanes.
- Expected: Every view groups an item under the same goal; the board uses the same goal lanes as the charts.
- Where: web/app/simple/roadmap/_board.tsx:74 (uses data.groups, not lanes(data,'goal') from _lib.ts:423)

## qa4-simple-roadmap-2 · major · Exported Timeline PNG/PDF leaves most bars unlabelled
- Page: /simple/roadmap
- What: The exported PNG/PDF of the Timeline leaves most bars unlabelled: short bars in Faster activation, Reliability, Revenue, Growth and Activation are blank pills, so a reader of the export cannot tell what they are.
- Steps: Simple > Roadmap > Timeline > Export PNG (or PDF); open the file.
- Expected: Each bar in the export carries its item name (inside, beside, or in a numbered key).

## qa4-simple-roadmap-6 · major · Dark mode: Timeline and Gantt estimated bars nearly invisible
- Page: /simple/roadmap
- What: In dark mode the Timeline's bars and the Gantt's estimated (hatched) bars are nearly invisible against the dark chart background; bar fills/outlines lack contrast.
- Steps: Switch theme to dark; Simple > Roadmap > Timeline, then Gantt.
- Expected: Bars at least 3:1 against the chart background in dark mode, hatch visible.

## qa4-simple-roadmap-8 · major · Group counts differ between goal cards, Timeline and Waterfall
- Page: /simple/roadmap
- What: Group counts contradict each other across the page: the Growth goal card says 4 items while Waterfall's Growth lane says 5; Timeline's Revenue lane says 3 items while Waterfall's says 5; the Timeline's No goal lane says 3 while Now / Next / Later's No goal sections list ~20.
- Steps: Simple > Roadmap; read the goal cards, then the lane headers in Timeline, Waterfall and Now / Next / Later.
- Expected: One count per group, the same in every view and on the goal cards.

## qa4-simple-roadmap-9 · major · Sidebar Roadmap badge 3 vs 'Needs a decision · 11'
- Page: /simple/roadmap
- What: The sidebar Roadmap badge reads 3 while the page's own button reads "Needs a decision · 11" — two numbers for what waits on the owner, with no hint what the 3 counts.
- Steps: Sign in as owner; Simple > Roadmap; compare the sidebar badge with Needs a decision.
- Expected: The badge and the button count the same thing, or the badge has a tooltip saying what it counts.

## qa4-simple-roadmap-10 · major · Goal cards missing for some goals; actions differ between cards
- Page: /simple/roadmap
- What: Goal cards cover only some goals: Reliability and Growth get cards but Revenue and Activation, which have their own lanes, do not; Reliability and Growth cards also lack the "Suggest a feature" link the other cards have.
- Steps: Simple > Roadmap; compare goal cards above the filters with the Group by Goal lanes.
- Expected: A card for every goal that has a lane, each with the same actions.

## qa4-simple-roadmap-12 · major · 'Cut it, keep the dependents' offered on items with no dependents
- Page: /simple/roadmap
- What: The item card's "Cut it" action is offered as "Cut it, keep the dependents" on items that have no dependents.
- Steps: Open an item card with Needed by: No other items > Talk to Oracle > ask to cut it; read the change card's buttons.
- Expected: Only "Cut it" when nothing depends on the item; the dependents choice only when there are dependents.
- Where: web/components/simple/chat/ChatCard.tsx:176

## qa4-simple-roadmap-13 · major · After 'Cut it' the card still shows stale broken-link flags
- Page: /simple/roadmap
- What: After cutting an item from its card the card stays open showing the old broken-link flags and their fix buttons, as if the item were still live.
- Steps: Item card > Talk to Oracle > cut the item > accept; look at the open card.
- Expected: The card refreshes: shows the item as cut (below the line) and drops stale flags and fixes.

## qa4-simple-roadmap-14 · major · Needs a decision drawer does not close on Escape
- Page: /simple/roadmap
- What: The Needs a decision drawer does not close on Escape (other dialogs on the page do).
- Steps: Simple > Roadmap > Needs a decision; press Escape.
- Expected: Escape closes the drawer and returns focus to the button.

## qa4-simple-roadmap-16 · major · Phone Waterfall: banners overlap bars; goal names cut
- Page: /simple/roadmap
- What: Phone Waterfall: conflict banners overlap the bars and are truncated with an ellipsis, and goal names in the lane column are cut off.
- Steps: Phone; Simple > Roadmap > Waterfall.
- Expected: Banners wrap and sit outside the bars; goal names wrap.

## qa4-simple-roadmap-17 · major · Quick add: Enter without a roadmap does nothing visible
- Page: /simple/roadmap
- What: Quick add: pressing Enter with a title but no roadmap chosen does nothing visible; the hint saying a roadmap is needed is only announced to screen readers.
- Steps: Simple > Roadmap > Add an item: leave Which roadmap? empty, type a title, press Enter.
- Expected: A visible inline message ("Pick a roadmap first") and focus moved to the roadmap picker.

## qa4-simple-roadmap-18 · major · Key dates: Add disabled with no reason; toast covers Add
- Page: /simple/roadmap
- What: Key dates: the Add button stays disabled with no reason shown, and the success toast covers the Add button after adding.
- Steps: Simple > Roadmap > Key dates · 2 > fill part of the form; then add one.
- Expected: Say what is missing next to the disabled Add; place toasts clear of the form.

## qa4-simple-roadmap-19 · minor · Dates that fall in another year carry no year
- Page: /simple/roadmap
- What: Dates that fall in another year carry no year: Gantt/Timeline tooltips and the suggestion say "Oct 31 – Dec 11" for a 2028 date, and "Welcome video Jul 1 to Oct 30" spans two years with no year.
- Steps: Hover/focus the Welcome video bar or its ? suggestion.
- Expected: Add the year whenever the date is not in the current year or a range spans years.

## qa4-simple-roadmap-20 · minor · Now / Next / Later column header reads "Now Oct 1 – Dec 31" without a year while Next and…
- Page: /simple/roadmap
- What: Now / Next / Later column header reads "Now Oct 1 – Dec 31" without a year while Next and Later carry years.
- Steps: Simple > Roadmap > Now / Next / Later.
- Expected: "Oct 1 – Dec 31, 2026".
- Where: web/app/simple/roadmap/_board.tsx

## qa4-simple-roadmap-21 · minor · Later column count reads "1 · 1 below the line", which is hard to parse
- Page: /simple/roadmap
- What: Later column count reads "1 · 1 below the line", which is hard to parse.
- Steps: Now / Next / Later; read the Later header.
- Expected: "1 item, 1 cut" or similar plain words.
- Where: web/app/simple/roadmap/_board.tsx:442

## qa4-simple-roadmap-22 · minor · A bare "✦ 1" pill sits on the Grow retention group header in Now / Next / Later, with no words…
- Page: /simple/roadmap
- What: A bare "✦ 1" pill sits on the Grow retention group header in Now / Next / Later, with no words saying it is a suggested feature.
- Steps: Now / Next / Later; look at the Grow retention section header.
- Expected: "✦ 1 suggested feature" as on the goal card.

## qa4-simple-roadmap-23 · minor · The cut item below the line shows a bare "1st" before its name in Gantt and Waterfall, with no…
- Page: /simple/roadmap
- What: The cut item below the line shows a bare "1st" before its name in Gantt and Waterfall, with no words saying it is first in the return queue.
- Steps: Gantt or Waterfall; read the Below the line row.
- Expected: "1st to return" or a tooltip/legend entry explaining the number.
- Where: web/app/simple/roadmap/_timeline.tsx:313

## qa4-simple-roadmap-24 · minor · Gantt dependency-conflict pills are clipped at the chart's right edge with an ellipsis, so the…
- Page: /simple/roadmap
- What: Gantt dependency-conflict pills are clipped at the chart's right edge with an ellipsis, so the sentence cannot be read.
- Steps: Gantt, Week scale; look at the ⚠ pills right of Weekly alert digest / Mobile alert push.
- Expected: Pills wrap or open the full sentence on hover/focus.

## qa4-simple-roadmap-25 · minor · Gantt bar labels are truncated mid-word ("Self-serve…", "Team invite…", "Referral link…") for…
- Page: /simple/roadmap
- What: Gantt bar labels are truncated mid-word ("Self-serve…", "Team invite…", "Referral link…") for slices.
- Steps: Gantt; look at slice bars in Revenue and Growth.
- Expected: Show the full name beside short bars.

## qa4-simple-roadmap-26 · minor · Oracle's dotted date-suggestion box for Welcome video runs past the Timeline's right edge and…
- Page: /simple/roadmap
- What: Oracle's dotted date-suggestion box for Welcome video runs past the Timeline's right edge and is clipped, as is the connector to In-app tour.
- Steps: Timeline; look at the right end of the No goal / Below the line rows.
- Expected: The suggestion fits inside the chart or the axis extends to include it.

## qa4-simple-roadmap-27 · minor · Milestone and key-date labels at the top of the Timeline are struck through by the vertical…
- Page: /simple/roadmap
- What: Milestone and key-date labels at the top of the Timeline are struck through by the vertical milestone/today lines ("Customer conference", "M1 ends Nov 27", "Board meeting").
- Steps: Timeline; look at the label stack above the lanes.
- Expected: Lines stop under labels or labels get a background.

## qa4-simple-roadmap-28 · minor · A tall empty band fills the Grow retention lane in the Timeline (rows reserved for…
- Page: /simple/roadmap
- What: A tall empty band fills the Grow retention lane in the Timeline (rows reserved for banners/stacking), pushing other lanes far down.
- Steps: Timeline, Group by Goal.
- Expected: Lanes as tall as their content.

## qa4-simple-roadmap-29 · minor · The legends differ between views (Timeline
- Page: /simple/roadmap
- What: The legends differ between views (Timeline: Estimated (the horizon’s window), Oracle’s date suggestion (? opens it); Gantt: Dated, Estimated, Dates Oracle suggests (? opens them); Board: Estimated dates) for the same marks.
- Steps: Compare the legend under each of the four views.
- Expected: One wording per mark across views.

## qa4-simple-roadmap-30 · minor · Now / Next / Later shows milestone-overrun and cut flags ("ends Jun 8, after its milestone…
- Page: /simple/roadmap
- What: Now / Next / Later shows milestone-overrun and cut flags ("ends Jun 8, after its milestone ‘Beta’") that the Timeline never shows for the same item.
- Steps: Compare Weekly alert digest in Now / Next / Later and Timeline.
- Expected: The same warnings wherever the item is drawn.

## qa4-simple-roadmap-31 · minor · Waterfall legend has an orphan "Today" line and its phase legend (Discover / Build / Beta /…
- Page: /simple/roadmap
- What: Waterfall legend has an orphan "Today" line and its phase legend (Discover / Build / Beta / Launch) reuses "Beta", the name of a key date on the same chart.
- Steps: Waterfall; read the legend.
- Expected: Legend entries grouped and unambiguous.

## qa4-simple-roadmap-32 · minor · An internal feature code appears to people
- Page: /simple/roadmap
- What: An internal feature code appears to people: "F-06" before Weekly alert digest in the phone lane list, "F-03 Setup failure alerts" in the card's Slices, and "Looks like F-06 …" on drafts.
- Steps: Phone Timeline list; or open an item card; or a draft in Now / Next / Later.
- Expected: Names only, as elsewhere on the Simple roadmap.
- Where: web/app/simple/roadmap/_board.tsx:399

## qa4-simple-roadmap-33 · minor · Phone lane header reads "4 items, up to 1 at once", jargon that says nothing useful to the…
- Page: /simple/roadmap
- What: Phone lane header reads "4 items, up to 1 at once", jargon that says nothing useful to the owner.
- Steps: Phone; Timeline; read the lane list header.
- Expected: Drop it, or say "one at a time".

## qa4-simple-roadmap-34 · minor · Phone Gantt has no Today pill (desktop has one), so the red line is unexplained
- Page: /simple/roadmap
- What: Phone Gantt has no Today pill (desktop has one), so the red line is unexplained.
- Steps: Phone; Gantt.
- Expected: The Today label on phone too.

## qa4-simple-roadmap-35 · minor · Phone Timeline shows an "open below" chip on Grow retention with no clear target
- Page: /simple/roadmap
- What: Phone Timeline shows an "open below" chip on Grow retention with no clear target.
- Steps: Phone; Timeline; look right of Grow retention.
- Expected: Say what opens below (e.g. "3 broken links below").
- Where: web/app/simple/roadmap/_lanes.tsx:1544

## qa4-simple-roadmap-36 · minor · Goal cards say "1 items" when a goal has one item
- Page: /simple/roadmap
- What: Goal cards say "1 items" when a goal has one item.
- Steps: Filter so a goal has one item; read its card.
- Expected: "1 item".

## qa4-simple-roadmap-37 · minor · Key dates list truncates titles mid-word ("Pr…") in its narrow column
- Page: /simple/roadmap
- What: Key dates list truncates titles mid-word ("Pr…") in its narrow column.
- Steps: Key dates · 2; read the list.
- Expected: Titles wrap.

## qa4-simple-roadmap-38 · minor · Needs a decision drawer lists the Weekly alert digest milestone flag twice
- Page: /simple/roadmap
- What: Needs a decision drawer lists the Weekly alert digest milestone flag twice.
- Steps: Needs a decision; scan the items.
- Expected: One entry per problem.

## qa4-simple-roadmap-39 · minor · The duplicate-draft decision wording "Same as this" and Decline do not say what happens to the…
- Page: /simple/roadmap
- What: The duplicate-draft decision wording "Same as this" and Decline do not say what happens to the draft.
- Steps: Needs a decision > a Looks like… draft; read the buttons.
- Expected: "Merge into …" / "Keep both".

## qa4-simple-roadmap-40 · minor · The item card's Talk to Oracle box clips its placeholder text and, opened with nothing asked…
- Page: /simple/roadmap
- What: The item card's Talk to Oracle box clips its placeholder text and, opened with nothing asked, shows an empty panel with no prompt suggestions.
- Steps: Item card > Talk to Oracle.
- Expected: A full placeholder and two or three example asks.

## qa4-simple-roadmap-41 · minor · The change card proposed in Talk to Oracle lists the item's existing flags as if they were…
- Page: /simple/roadmap
- What: The change card proposed in Talk to Oracle lists the item's existing flags as if they were changes, and its preview is hidden behind the item card.
- Steps: Item card > Talk to Oracle > ask to move it; read the change card.
- Expected: Only the proposed changes; preview visible.

## qa4-simple-roadmap-42 · minor · Item card text is awkward
- Page: /simple/roadmap
- What: Item card text is awkward: "Depends on: No other items" / "Needed by: No other items" and a Why line that just repeats the PRD and item name ("From Guided setup: Setup failure alerts.").
- Steps: Open any item card.
- Expected: "Nothing" / "None"; a Why that explains why.
- Where: web/app/simple/roadmap/_card.tsx:352

## qa4-simple-roadmap-43 · minor · The "From was after To, so they were swapped" toast stays on screen after both filters are set…
- Page: /simple/roadmap
- What: The "From was after To, so they were swapped" toast stays on screen after both filters are set back to All, describing a state that no longer exists.
- Steps: Set From Q3 2028, To Q1 2027; then set both to All.
- Expected: The toast clears when the filters change again.
- Where: web/app/simple/roadmap/_roadmap.tsx:1019

## qa4-simple-roadmap-46 · minor · Filter selects get their accessible name from the wrapping label plus all option text ("From…
- Page: /simple/roadmap
- What: Filter selects get their accessible name from the wrapping label plus all option text ("From All Q4 2026 Q1 2027 …"), so screen readers read the whole option list.
- Steps: Tab to the From filter with a screen reader / inspect accessible name.
- Expected: Name "From" via label for/id.
- Where: web/app/simple/roadmap/_roadmap.tsx (filter labels)

## qa4-simple-roadmap-47 · minor · Tab order inside the Timeline jumps between lanes out of visual order (Weekly alert digest…
- Page: /simple/roadmap
- What: Tab order inside the Timeline jumps between lanes out of visual order (Weekly alert digest, then Alert routing by team, then back up to Setup failure alerts).
- Steps: Tab past Group by into the chart.
- Expected: Focus follows lanes top to bottom, left to right.

## qa4-simple-roadmap-48 · minor · The export footer date reads "Oct 30" with no year and no time context, while the export has…
- Page: /simple/roadmap
- What: The export footer date reads "Oct 30" with no year and no time context, while the export has no roadmap name when 'All roadmaps' is filtered ("every roadmap").
- Steps: Export PNG; read the header/footer.
- Expected: A full date ("Oct 30, 2026") and plain wording ("All roadmaps").

## qa4-simple-roadmap-49 · minor · Start a review lists attendees as role names (Admin, Approver, Commenter, Viewer) with no…
- Page: /simple/roadmap
- What: Start a review lists attendees as role names (Admin, Approver, Commenter, Viewer) with no names or emails, so the owner cannot tell who is invited.
- Steps: Simple > Roadmap > Start review.
- Expected: People's names with their role as secondary text.
- Note: may be the mock's data, not the product: fix the mock if the mock is wrong, else say so and skip.

## qa4-simple-roadmap-50 · minor · The Gantt Draft row also carries a "Pending decision" tag while the Timeline calls the same…
- Page: /simple/roadmap
- What: The Gantt Draft row also carries a "Pending decision" tag while the Timeline calls the same thing "Draft · …" in the bar, two words for one state.
- Steps: Compare Team invite nudges in Gantt and Timeline.
- Expected: One label.
