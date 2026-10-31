# QA pass 4 · Plan, priorities, baseline, impact · design changes (9)
Found on the mock app (invented data) at desktop 1512 and phone 390, train AD's build. Ids qa4-<area>-N.

## qa4-plan-5 · major · 'Draft roadmap from this track' starts a run with no confirm or estimate
- Page: /plan
- What: 'Draft roadmap from this track' starts a run straight away with no confirmation or estimate, and lands on a run page that says 'Not started / No estimate yet' with no obvious way to start it.
- Steps: /plan, track card 'Usage alerts PRD', click 'Draft roadmap from this track'.
- Expected: A confirm step saying what will happen (and cost), and a run page with a clear next action.

## qa4-plan-10 · minor · 'With your changes' is selected by default and is identical to 'Oracle's order' when there are…
- Page: /priorities
- What: 'With your changes' is selected by default and is identical to 'Oracle's order' when there are no changes; the Ranked higher/lower flags also appear in Oracle's order, so the toggle seems to do nothing.
- Steps: /priorities with no changes; toggle With your changes / Oracle's order.
- Expected: Hide or disable the toggle until a change exists, or say 'No changes yet — both orders match'.

## qa4-plan-13 · minor · Snapshots promise 'keep this order and compare it later' but a saved snapshot has no compare…
- Page: /priorities
- What: Snapshots promise 'keep this order and compare it later' but a saved snapshot has no compare, open or delete control, and its note is not shown.
- Steps: /priorities, Save snapshot (empty note and with a note); look at the snapshot row.
- Expected: A Compare with now action on each snapshot; show the note.

## qa4-plan-19 · minor · The milestone shows 'Oct 19 – Nov 30' but its inspector edits a single Date
- Page: /plan
- What: The milestone shows 'Oct 19 – Nov 30' but its inspector edits a single Date; the start date cannot be edited and nothing says where it comes from.
- Steps: /plan, click M1, read the Date field.
- Expected: Edit both dates or say the start is derived.

## qa4-plan-28 · minor · Pausing a track removes its PRD from 'PRDs in play' (and another card takes its slot) while…
- Page: /plan
- What: Pausing a track removes its PRD from 'PRDs in play' (and another card takes its slot) while the '7 PRDs / 1 at risk' chips stay the same.
- Steps: /plan, track card, click Paused; look at PRDs in play and the header chips.
- Expected: Paused PRDs stay listed with a Paused tag, or the counts change with them.

## qa4-plan-29 · minor · The 'Approved only' choice is remembered silently across visits
- Page: /plan
- What: The 'Approved only' choice is remembered silently across visits; the '6 proposed' chip disappears and nothing on return says a filter is on.
- Steps: /plan, pick Approved only, leave and come back.
- Expected: Show that a filter is active (and a way to clear it).

## qa4-plan-33 · minor · A withdrawn date has no actions (no undo or re-propose) and the 'Proposed 0' filter is offered…
- Page: /plan/dates
- What: A withdrawn date has no actions (no undo or re-propose) and the 'Proposed 0' filter is offered with nothing to show and no hint what proposing means.
- Steps: /plan/dates, row ENG-413 and the Proposed filter.
- Expected: Undo withdraw, and an empty state explaining how dates get proposed.

## qa4-plan-40 · minor · The header 'Launches' button duplicates the Launches link in the strip
- Page: /roadmap/changelog
- What: The header 'Launches' button duplicates the Launches link in the strip; Launches has a 'Changelog' button duplicating too; the disabled Export Markdown/HTML buttons have low contrast.
- Steps: /roadmap/changelog and /roadmap/launches.
- Expected: One way to switch; disabled buttons legible with a reason.

## qa4-plan-41 · minor · Changelog and Launches switch the H1 to their own name with a '‹ Plan' crumb, while…
- Page: /roadmap/launches
- What: Changelog and Launches switch the H1 to their own name with a '‹ Plan' crumb, while Dates/Documents/Outcomes keep H1 'Plan'; the tab strip and the crumb both lead back.
- Steps: Open each Plan tab and the two links.
- Expected: Consistent heading pattern across the Plan section.
