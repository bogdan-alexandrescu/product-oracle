# QA pass 4 · Detailed Home and Company · design changes (11)
Found on the mock app (invented data) at desktop 1512 and phone 390, train AD's build. Ids qa4-<area>-N.

## qa4-company-11 · minor · Edit on a decision has a Context field that Propose decision does not, so context can only be…
- Page: /company/decisions
- What: Edit on a decision has a Context field that Propose decision does not, so context can only be added after proposing.
- Steps: Propose decision (no Context) vs. select D-6 > Edit (Context box).
- Expected: The same fields in Propose and Edit.
- Where: web/app/company/decisions

## qa4-company-14 · minor · The 'show everything' chip moves around
- Page: /company/decisions
- What: The 'show everything' chip moves around: 'All kinds' is last in Kind, 'Any state' last in State, but 'Anywhere' first in From.
- Steps: Look at the three filter rows.
- Expected: The reset chip in the same place on every row (first).
- Where: web/app/company/decisions

## qa4-company-20 · minor · A new ritual starts with no attendees (list shows 0), not even the person who added it and…
- Page: /company/rituals
- What: A new ritual starts with no attendees (list shows 0), not even the person who added it and owns it.
- Steps: Add ritual 'QA design sync'.
- Expected: The owner is ticked as an attendee by default.
- Where: web/app/company/rituals

## qa4-company-22 · minor · After Prepare now, the row shows 'Pre-read ready' in When and a 'Nov 2, 2026' link in Latest…
- Page: /company/rituals
- What: After Prepare now, the row shows 'Pre-read ready' in When and a 'Nov 2, 2026' link in Latest pre-read: two links to one page, and the date is the future meeting, not when it was prepared.
- Steps: Weekly goals check-in > Prepare now > back to Rituals.
- Expected: One link, and the column says what the date is (e.g. 'For Mon, Nov 2').
- Where: web/app/company/rituals

## qa4-company-24 · minor · The occurrence page has both an active Rituals tab and a small grey '← Rituals' link
- Page: /company/rituals/[occurrence]
- What: The occurrence page has both an active Rituals tab and a small grey '← Rituals' link: two ways back, the link low-contrast.
- Steps: Open an occurrence.
- Expected: One clear back affordance.
- Where: web/app/company/rituals

## qa4-company-25 · minor · Phone sheets are titled inconsistently
- Page: /company/rituals, /company/decisions
- What: Phone sheets are titled inconsistently: the ritual sheet's title is the ritual's name and its hero has no title, the decision sheet is titled 'Decision' with the name in the hero.
- Steps: Phone: tap a ritual, then a decision.
- Expected: One pattern for every inspector sheet.
- Where: web/components (Inspector sheet)

## qa4-company-28 · minor · 'Draft next version' is offered while v1 is still an unapproved draft
- Page: /company/strategy
- What: 'Draft next version' is offered while v1 is still an unapproved draft.
- Steps: Start a vision from the template > back to Strategy.
- Expected: Offer it only after v1 is approved, or explain what it does to v1.
- Where: web/app/company/strategy

## qa4-company-43 · minor · On phone the Company tabs wrap to two rows and the page action ('+ Decision', '+ Ritual', '+…
- Page: /company/*
- What: On phone the Company tabs wrap to two rows and the page action ('+ Decision', '+ Ritual', '+ Metric') is squeezed in beside the second row, so it reads as another tab.
- Steps: Phone 390: any Company tab.
- Expected: Scrollable single-row tabs with the action placed apart.
- Where: web/app/company/layout.tsx

## qa4-company-44 · minor · Phone Decisions rows drop approver, decided and review dates entirely
- Page: /company/decisions
- What: Phone Decisions rows drop approver, decided and review dates entirely; you must open each one to see who approves or what is due.
- Steps: Phone 390: Decisions.
- Expected: Approver and review date in the row meta.
- Where: web/app/company/decisions

## qa4-company-49 · minor · In flight's Progress column mixes 'Step 8 of 9' dots for PRDs and 'Segment 1 of 4' bars for…
- Page: /home
- What: In flight's Progress column mixes 'Step 8 of 9' dots for PRDs and 'Segment 1 of 4' bars for runs, plus 'Paused at segment 1 of 1', in one column.
- Steps: Home > In flight.
- Expected: One progress vocabulary, or the kind of item labelled.
- Where: web/app/home/_in-flight.tsx

## qa4-company-51 · minor · On phone, tapping an In flight row puts the selected-PRD panel below the whole list with no…
- Page: /home
- What: On phone, tapping an In flight row puts the selected-PRD panel below the whole list with no visible reaction where you tapped, unlike Company pages which open a sheet.
- Steps: Phone: Home > tap 'Clinic outreach PRD' in In flight.
- Expected: Open the panel as a sheet, as Decisions and Rituals do.
- Where: web/app/home/page.tsx
