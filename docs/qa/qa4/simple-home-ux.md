# QA pass 4 · Simple Home · design changes (7)
Found on the mock app (invented data) at desktop 1512 and phone 390, train AD's build. Ids qa4-<area>-N.

## qa4-simple-home-13 · major · Goal card opens Priorities, which shows nothing for that goal
- Page: /simple
- What: Clicking a goal card ('Planned') opens Priorities, where nothing planned for that goal is shown.
- Steps: Home > click 'Raise activation'.
- Expected: The card opens where that goal's planned items are listed (or the label says where it goes).
- Where: web/app/simple/page.tsx (goalHref fallback to /simple/priorities)

## qa4-simple-home-26 · major · Home proposal row offers Accept with no before/after of the move
- Page: /simple
- What: A proposal row on Home ('Move the dependents: Weekly alert digest') shows no before/after of the dates it moves, yet offers Accept right there; the owner accepts blind.
- Steps: Owner > Home > Proposals on your items.
- Expected: The row shows what moves and to when (or Accept opens a summary first).

## qa4-simple-home-15 · minor · The rail's Meetings badge '3' counts all upcoming meetings, drawn as a grey count next to the…
- Page: /simple
- What: The rail's Meetings badge '3' counts all upcoming meetings, drawn as a grey count next to the yellow 'needs you' badges of Roadmap and Decisions; a person cannot tell it is not something waiting on them.
- Steps: Look at the Simple rail.
- Expected: Badges mean one thing (waiting on you), or the meetings count is labelled.

## qa4-simple-home-27 · minor · 'Since your last visit' lists only the owner's own actions ('You accepted a risk...', 'You…
- Page: /simple
- What: 'Since your last visit' lists only the owner's own actions ('You accepted a risk...', 'You moved...'), which are not news to them.
- Steps: Owner > make any fix on Home > reload > Since your last visit.
- Expected: Show what other people did since the last visit; leave your own actions out.
- Where: web/app/simple/page.tsx:814

## qa4-simple-home-29 · minor · Goal cards lead with the weighting jargon 'Counts for 63% of each feature's score' above the…
- Page: /simple
- What: Goal cards lead with the weighting jargon 'Counts for 63% of each feature's score' above the goal's name, so the first thing read is not the goal.
- Steps: Home > goal cards.
- Expected: Goal name first; the weighting as a secondary line in plain words ('63% of priority').
- Where: web/app/simple/page.tsx:464

## qa4-simple-home-30 · minor · 'Broken links · Alerts roadmap' sits inside 'The plan this quarter' with the heading and every…
- Page: /simple
- What: 'Broken links · Alerts roadmap' sits inside 'The plan this quarter' with the heading and every item name in alarm red, making the plan card read as an error panel.
- Steps: Home > The plan this quarter.
- Expected: Broken links as their own card or with one warning accent, item names in normal text colour.

## qa4-simple-home-34 · minor · 'All ->' and '4 more ->' on Decisions waiting for you both open the same /simple/decisions…
- Page: /simple
- What: 'All ->' and '4 more ->' on Decisions waiting for you both open the same /simple/decisions list, two controls doing one thing in one card.
- Steps: Home > Decisions waiting for you > compare 'All' (top right) with '4 more' (bottom).
- Expected: One link, or '4 more' expands the rest in place.
