# QA pass 4 · Briefs, requests, runs, inbox, run stops · design changes (12)
Found on the mock app (invented data) at desktop 1512 and phone 390, train AD's build. Ids qa4-<area>-N.

## qa4-work-14 · major · 'New request' and 'File as request' are two different forms
- Page: /requests
- What: Two different forms create a request: 'New request' asks for Requester and Channel (with 'In app'), 'File as request' asks for 'Where it came from' and 'Asked by: Customer/Team/Unknown' (no 'In app'), and is titled 'Add request'.
- Steps: Click New request; close; click File as request on a found item.
- Expected: One request form with the same fields, labels and channel list, prefilled from the found item.
- Where: web/app/requests/_components/NewRequest.tsx

## qa4-work-7 · minor · Under the header, a second small line explains both buttons in a run-on sentence ("Analyse…
- Page: /intakes/<id> (Saved addresses, from Inbox › Oracle asks › Open)
- What: Under the header, a second small line explains both buttons in a run-on sentence ("Analyse with Oracle: Oracle reads… Draft with Oracle: Oracle writes…"), crowding the header; after an analysis it changes to "Read the brief again: …".
- Steps: Open the brief; read the two lines under the title.
- Expected: Each button's meaning in its own tooltip or info, not a run-on paragraph under the header.

## qa4-work-22 · minor · Rows show both a linked title and an 'Open' button that do the same thing
- Page: /runs
- What: Rows show both a linked title and an 'Open' button that do the same thing; for the cost-approval row the button says 'Open' instead of what is needed (approve the cost).
- Steps: Open /runs; compare 'Usage alerts v2 PRD' link and its 'Open' button.
- Expected: The row action names the decision ('Approve $53.00', 'Resume or cancel'); one way to open the run.
- Where: web/app/runs/page.tsx:99

## qa4-work-23 · minor · 'Start a run…' (a primary + button) does not start anything
- Page: /runs
- What: 'Start a run…' (a primary + button) does not start anything: it opens 'Where to start a run', a list of links to other pages.
- Steps: Click Start a run….
- Expected: Label it 'Where to start a run' / make it a secondary button, or let it start the run from here.
- Where: web/app/runs/page.tsx:260

## qa4-work-24 · minor · The selected-run panel has no action
- Page: /runs
- What: The selected-run panel has no action: for a run awaiting cost approval it shows the cost but no Approve button.
- Steps: Open /runs; read the Selected run panel for 'Usage alerts v2 PRD'.
- Expected: The panel offers the same decision as the row.

## qa4-work-27 · minor · 'Where it runs: On this server (test mode)' shows a hosting detail on every run
- Page: /runs/<id> (from /runs)
- What: 'Where it runs: On this server (test mode)' shows a hosting detail on every run.
- Steps: Open any run; read Details.
- Expected: Hide it unless it matters to the person, or say what it means for them.

## qa4-work-33 · minor · Several inline Accept/Decline forms can be open at once in different rows, each with its own…
- Page: /inbox
- What: Several inline Accept/Decline forms can be open at once in different rows, each with its own Cancel, making rows jump in height.
- Steps: Click Decline on one comment and Accept on another.
- Expected: Opening one closes the other.
- Where: web/app/inbox/_actions.tsx

## qa4-work-34 · minor · The 'Needs you 11' heading sits above tabs that include Staged, Declined and Done, which do…
- Page: /inbox
- What: The 'Needs you 11' heading sits above tabs that include Staged, Declined and Done, which do not need you; on those tabs the heading changes to the tab name.
- Steps: Open Inbox; switch to Done.
- Expected: A neutral heading ('Inbox') above the tabs, with the counts on the tabs.

## qa4-work-36 · minor · Row actions differ for the same kind of item
- Page: /inbox
- What: Row actions differ for the same kind of item: most comments have Accept/Decline/Open, one has 'Stage for agents', one has only Merge/Open (no Decline).
- Steps: Read the Comment rows' actions.
- Expected: The same set for every comment, with the varying one as the primary.

## qa4-work-37 · minor · On a phone, actions sit in different places per row
- Page: /inbox
- What: On a phone, actions sit in different places per row: Review/Approve/Answer beside the title, Resume on its own right-aligned line, comment actions under the meta line on the left.
- Steps: Open Inbox at 390 wide.
- Expected: One place for row actions on every card.

## qa4-work-42 · minor · Bulk edit's row stacks four full-width buttons, making it three times taller than other rows
- Page: /runs/<id>/review/<checkpoint> — Feature set (scope-review)
- What: Bulk edit's row stacks four full-width buttons, making it three times taller than other rows.
- Steps: Open the feature set review.
- Expected: Primary choice plus a menu, or buttons in a wrap row.

## qa4-work-52 · minor · On a phone the sticky decision bar plus the bottom nav take about 200 px of an 844 px screen…
- Page: /runs/<id>/review/<checkpoint> — Engineering dates (eng-dates)
- What: On a phone the sticky decision bar plus the bottom nav take about 200 px of an 844 px screen, and the selected item's details are at the very bottom of the page, far from the row.
- Steps: Open Engineering dates at 390 wide.
- Expected: A compact one-line sticky bar; the item's details open in a sheet from the row.
