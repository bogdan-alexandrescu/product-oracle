# QA pass 4 · Simple priorities · design changes (14)
Found on the mock app (invented data) at desktop 1512 and phone 390, train AD's build. Ids qa4-<area>-N.

## qa4-simple-plan-3 · major · Ranks out of order around a dated line
- Page: /simple/priorities
- What: With a key-date or milestone line, the rank numbers come out of order around the line (2 above it; 1, 3, 4 below it; or 1, 2, 5 above and 3, 4 below), so the list no longer reads as a ranking.
- Steps: Ranked list, Line = 'Key date: Customer conference · Nov 14, 2026' (or Milestone: Beta). Read the numbers top to bottom.
- Expected: Show the numbers in reading order, or give each part its own ordering with a clear heading ('Makes Nov 14' / 'Misses Nov 14'). Don't show '2' above '1'.
- Where: web/app/simple/priorities/priorities.tsx (ranked list split by the line's end date)

## qa4-simple-plan-4 · major · Long 'Misses …' pill repeated on every row below a dated line
- Page: /simple/priorities
- What: With a dated line, every row below it carries a long 'Misses Customer conference · Nov 14, 2026' pill. That's 8 identical pills right under the line that already says so, and they push each row's numbers onto a second line.
- Steps: Ranked list, Line = Key date: Customer conference. Look at the rows below the line.
- Expected: The line says it once. Rows show a short 'Misses' mark (as Value / effort's side list does) or nothing.
- Where: web/app/simple/priorities/priorities.tsx:1623 (MissesTag)

## qa4-simple-plan-7 · major · Unlabelled bar beside 'confidence' shows goal value
- Page: /simple/priorities
- What: A small unlabelled blue bar between 'confidence' and 'value' looks like a confidence meter, but it is the goal value (a full bar for value 6 at confidence 0.5, a short bar for value 4 at confidence 0.8).
- Steps: Ranked list: compare Sample data import (confidence 0.5, full bar) with Setup checklist (confidence 0.8, shorter bar).
- Expected: Label the bar or place it with 'value', or drop it. A bar beside 'confidence 0.8' should show confidence.
- Where: web/app/simple/priorities/priorities.tsx:547 (prio-numbers)

## qa4-simple-plan-15 · major · Suggestions drawer has three look-alike Ask Oracle buttons
- Page: /simple/priorities
- What: The suggestions drawer has three ask-Oracle buttons that look alike ('Ask Oracle in the chat', '✦ Ask Oracle for more' and the rail's 'Ask Oracle'), plus '+ Suggest a feature'. It isn't clear which one adds suggestions here.
- Steps: Goal buckets > 'See or make suggestions' on Grow retention. Read the buttons at the top.
- Expected: One clearly named action per outcome, e.g. 'Get more Oracle suggestions' inside the Oracle tab, and the chat link as a quiet link.
- Where: web/components/simple/GoalSuggestions.tsx

## qa4-simple-plan-16 · major · Repeated 'Same as this: decline the suggestion' links decline without confirm
- Page: /simple/priorities
- What: Each Oracle suggestion lists every lookalike with its own 'Same as this: decline the suggestion' link. That's two identical underlined links in a row, worded as a statement. They look like the lookalikes' links and decline the whole suggestion with no confirm.
- Steps: Open the Grow retention suggestions drawer as owner and read an Oracle card.
- Expected: One 'Duplicate of…' action (pick which), styled as a button, with Undo afterwards.
- Where: web/components/simple/GoalSuggestions.tsx:300

## qa4-simple-plan-5 · minor · Even with 'This quarter', every row below the line repeats a 'Misses this quarter' pill, right…
- Page: /simple/priorities
- What: Even with 'This quarter', every row below the line repeats a 'Misses this quarter' pill, right under the line that already says 'everything below misses it'.
- Steps: Ranked list, Line = This quarter. Look at rows 6-9.
- Expected: One statement at the line; rows below are already greyed and hollow-marked.
- Where: web/app/simple/priorities/priorities.tsx:530

## qa4-simple-plan-10 · minor · Three of nine marks sit exactly on a dashed middle line, so you can't check the quadrant…
- Page: /simple/priorities
- What: Three of nine marks sit exactly on a dashed middle line, so you can't check the quadrant counts by eye. The note 'A mark on a middle line counts on the side its rank puts it' is hard to follow.
- Steps: Value / effort tab: count the marks in Quick wins (2) and Big bets (3). SC, F-06 and AM sit on the lines.
- Expected: Put marks on a line visibly on the side they count for, or count them separately ('on the middle: 3').
- Where: web/app/simple/priorities/priorities.tsx (vxe quadrants)

## qa4-simple-plan-13 · minor · Goal buckets' 'Share of engineer-weeks by goal' bar is two pale blocks of the same colour with…
- Page: /simple/priorities
- What: Goal buckets' 'Share of engineer-weeks by goal' bar is two pale blocks of the same colour with no numbers. It repeats the cards just below it and doesn't help compare them.
- Steps: Desktop, Goal buckets, look at the bar under 'Share of engineer-weeks by goal'.
- Expected: Give each segment a distinct fill and its share (e.g. '34%'), or remove the bar since each card already shows wk and %.
- Where: web/app/simple/priorities/plan-buckets.tsx:132

## qa4-simple-plan-14 · minor · The Line control disappears on Goal buckets, so the page doesn't say which line the weeks are…
- Page: /simple/priorities
- What: The Line control disappears on Goal buckets, so the page doesn't say which line the weeks are counted against. The sentence says 'this quarter' even after the Ranked list's line was set to a milestone.
- Steps: Ranked list: Line = Milestone: Beta. Switch to Goal buckets.
- Expected: Keep the Line control (or show the active line) on every view, or say clearly that buckets always use this quarter.
- Where: web/app/simple/priorities/priorities.tsx:1652

## qa4-simple-plan-19 · minor · On a phone, the suggestions sheet spends its first screen on three stacked buttons and the tabs
- Page: /simple/priorities
- What: On a phone, the suggestions sheet spends its first screen on three stacked buttons and the tabs. Each suggestion's Accept / Reject sits below the fold, and the 'Oracle suggested' and 'Sources:' labels each take a line of their own.
- Steps: Phone 390, Goal buckets > See or make suggestions.
- Expected: Put the actions in one row or an overflow menu so the first suggestion and its buttons are visible.
- Where: web/components/simple/GoalSuggestions.tsx

## qa4-simple-plan-23 · minor · Compare with Oracle: Oracle's column draws no line, so you can't see which features Oracle has…
- Page: /simple/priorities
- What: Compare with Oracle: Oracle's column draws no line, so you can't see which features Oracle has making the quarter and which missing it.
- Steps: Ranked list, Compare with Oracle on.
- Expected: Draw the same line in Oracle's column.
- Where: web/app/simple/priorities/priorities.tsx:610

## qa4-simple-plan-27 · minor · Choosing a dated line rewrites the page subtitle into a long second sentence ('Each feature's…
- Page: /simple/priorities
- What: Choosing a dated line rewrites the page subtitle into a long second sentence ('Each feature's end date decides what makes the line, so what makes it is listed first, each part by rank.'), which pushes the 'Open the detailed view' link down under it, so the header jumps.
- Steps: Ranked list, switch Line between This quarter and a key date.
- Expected: The header keeps its layout. Explain the dated line next to the line itself, in plain words.

## qa4-simple-plan-31 · minor · 'Q4 2026.' is tacked onto the end of every view's subtitle as a sentence of its own, e.g
- Page: /simple/priorities
- What: 'Q4 2026.' is tacked onto the end of every view's subtitle as a sentence of its own, e.g. 'Where the engineer-weeks go, goal by goal. Q4 2026.'
- Steps: Open any Priorities tab and read the subtitle.
- Expected: Show the period as its own label (e.g. near Line), not as a trailing fragment.

## qa4-simple-plan-32 · minor · Value / effort's legend tells goals apart by shape only (circle = Faster activation, square =…
- Page: /simple/priorities
- What: Value / effort's legend tells goals apart by shape only (circle = Faster activation, square = Grow retention) in one colour. With more goals it won't scale, and small marks are hard to tell apart.
- Steps: Value / effort, look at the legend.
- Expected: Use colour plus shape per goal, or label each mark's goal on hover/focus.
