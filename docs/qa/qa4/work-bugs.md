# QA pass 4 · Briefs, requests, runs, inbox, run stops · bugs (39)
Found on the mock app (invented data) at desktop 1512 and phone 390, train AD's build. Ids qa4-<area>-N.

## qa4-work-1 · major · Brief: after Defer the status says 'Nothing asked yet'
- Page: /intakes/<id> (Saved addresses, from Inbox › Oracle asks › Open)
- What: After you Defer the open question, the brief's status changes to "Nothing asked yet" even though Batch 1 with its question is shown right below it.
- Steps: Inbox › 'Which metric shows repeat checkout got faster?' › Open › Change answer › Defer.
- Expected: The status keeps saying a question was asked and is deferred (e.g. 'Waiting for answers' or 'Question deferred').
- Where: web/app/intakes/[id]/_lib.ts:131
- Related to an end-to-end finding (another lane may touch it): E2E step 1b brief: Defer on the privacy question did nothing visible

## qa4-work-3 · major · Brief: a deferral is drawn as an answer card tagged 'Unknown'
- Page: /intakes/<id> (Saved addresses, from Inbox › Oracle asks › Open)
- What: A deferral is drawn as an answer: a new reply card from 'You' reading "Deferred" with an "Unknown" tag, the same as an 'I don't know' answer.
- Steps: Change answer › Defer; look at the thread under the question.
- Expected: Deferral shown as a state on the question (the 'Deferred' tag it already gets), not as a second answer with an 'Unknown' tag.
- Where: web/app/intakes/[id]/_questions.tsx

## qa4-work-13 · major · Requests page jumps ~400 px when owner controls load
- Page: /requests
- What: The page draws first without the owner's controls, then 1–2 s later 'New request', 'Interview a customer', the 'Oracle found 2 possible requests' card and the 'Start a PRD' column pop in, pushing the list ~400 px down under the cursor.
- Steps: Open /requests fresh (phone shows it most clearly) and watch the first two seconds.
- Expected: Reserve the space or show a skeleton so nothing jumps; or render the whole page at once.
- Where: web/app/requests/_components/RequestsScreen.tsx

## qa4-work-25 · major · Over-budget banner numbers don't add up
- Page: /runs/<id> (from /runs) — Team workspaces PRD (paused over budget)
- What: The over-budget banner's numbers do not add up: 'Spent $14.20, past its limit. Estimate $9.00, limit $13.50 (150%)… Resuming allows up to $4.50 more' — $4.50 is half the estimate, unrelated to the limit or what was spent, and the sentence runs on with 'Cancel run stops it'.
- Steps: /runs › Team workspaces PRD › read the blue banner.
- Expected: Say plainly what resuming allows in terms of the shown numbers (e.g. 'Resuming lets it spend up to $18.70 in total, $4.50 more') in two short sentences.
- Where: web/app/runs/_run-detail.tsx:620

## qa4-work-32 · major · Accepting a comment asks 'Why keep your call?'
- Page: /inbox
- What: Accepting a comment asks "Why keep your call?" — it is not clear what 'your call' is when you are accepting someone else's comment.
- Steps: Inbox › Seen › 'Add custom roles…' › Accept.
- Expected: A prompt that matches the action, e.g. 'Why accept? (optional)', or none.
- Where: web/app/inbox/_actions.tsx:165

## qa4-work-39 · major · Commenter's 'Suggest …' buttons overflow the card
- Page: /runs/<id>/review/<checkpoint> — Feature set (scope-review)
- What: For a commenter the 'Suggest …' buttons are wider than the 'Your call' column: 'Suggest Include dependency' and 'Suggest Remove dependency' overflow the card's right edge and overlap it.
- Steps: Sign in as commenter (scope-review), open Runs › Saved addresses PRD › Review feature set.
- Expected: Buttons wrap or stack within the column; the column is wide enough.
- Where: web/app/runs/[id]/review/[checkpoint]/_scope-lib.tsx:160

## qa4-work-47 · major · Engineering dates: internal basis codes shown, wrapping mid-code
- Page: /runs/<id>/review/<checkpoint> — Engineering dates (eng-dates)
- What: Internal reference codes show next to every date and wrap mid-code: 'Nov 30 · est-shipping-step', 'Dec 11 · cap-q4-checkout', also in the panel.
- Steps: Inbox › Engineering dates row › Review.
- Expected: Plain words for the basis ('Estimate: shipping step', 'Q4 capacity plan'), never the key.
- Where: web/app/runs/[id]/review/[checkpoint]/_eng-dates.tsx:32

## qa4-work-48 · major · Engineering dates: internal spec reference '(O4 Roadmap shape)'
- Page: /runs/<id>/review/<checkpoint> — Engineering dates (eng-dates)
- What: The Next/Later disclosure shows an internal spec reference: 'Next 2 · Later 1 · no dates (O4 Roadmap shape)'.
- Steps: Open Engineering dates; read the collapsed row under the table.
- Expected: 'Next 2 · Later 1 (Next and Later items have no dates)'.
- Where: web/app/runs/[id]/review/[checkpoint]/_eng-dates.tsx:322

## qa4-work-49 · major · Engineering dates: slugs instead of PRD and section names
- Page: /runs/<id>/review/<checkpoint> — Engineering dates (eng-dates)
- What: The subtitle and rows show slugs: 'The Now items of usage-alerts v2' and 'PRD section shipping / pricing / addresses'.
- Steps: Open Engineering dates.
- Expected: The PRD's title ('Usage alerts PRD v2') and the section's heading.
- Where: web/app/runs/[id]/review/[checkpoint]/_eng-dates.tsx:180, :238

## qa4-work-53 · major · Feature keys in code font under names, wrapping mid-key
- Page: /runs/<id>/review/<checkpoint> — Engineering check (eng-check)
- What: Each feature shows its internal key in code font under its name, wrapping mid-key: 'Guided setup ƒ.guided-/setup', 'Sample data ƒ.sample-/data'.
- Steps: Inbox › Engineering check row › Review (eng-check scenario).
- Expected: Feature name only; keys never shown.
- Where: web/app/runs/[id]/review/[checkpoint]/_eng-review.tsx
- Related to an end-to-end finding (another lane may touch it): E2E step 3 Engineering check: the feature key overlaps the Approach column

## qa4-work-4 · minor · "Send answer" is enabled with an empty answer box (no title or hint), so it is unclear what…
- Page: /intakes/<id> (Saved addresses, from Inbox › Oracle asks › Open)
- What: "Send answer" is enabled with an empty answer box (no title or hint), so it is unclear what sending nothing does.
- Steps: Change answer; leave the box empty; the Send answer button stays enabled.
- Expected: Send answer is disabled until something is typed (as Request changes is on the run page), or explains what an empty send does.
- Where: web/app/intakes/[id]/_questions.tsx

## qa4-work-6 · minor · The "I don't know" answer carries an extra grey "Unknown" tag that says the same thing again
- Page: /intakes/<id> (Saved addresses, from Inbox › Oracle asks › Open)
- What: The "I don't know" answer carries an extra grey "Unknown" tag that says the same thing again.
- Steps: Open the brief's Questions tab; read the answer card.
- Expected: One label: either the answer text or the tag.

## qa4-work-8 · minor · After Analyse with Oracle the header reads "0 things Oracle assumed (private to you), 1 open…
- Page: /intakes/<id> (Saved addresses, from Inbox › Oracle asks › Open)
- What: After Analyse with Oracle the header reads "0 things Oracle assumed (private to you), 1 open gap": an awkward zero-count phrase and an unexplained 'private to you'.
- Steps: Click Analyse with Oracle.
- Expected: e.g. 'Oracle assumed nothing; 1 gap still open', with what 'private' means said where it matters.
- Where: web/app/intakes/[id]/_read.tsx:32

## qa4-work-9 · minor · Analyse with Oracle gives no confirmation or progress
- Page: /intakes/<id> (Saved addresses, from Inbox › Oracle asks › Open)
- What: Analyse with Oracle gives no confirmation or progress: the header line silently changes and the button is renamed 'Read the brief again', while Findings keeps saying only "No findings from private sources" with no next step.
- Steps: Click Analyse with Oracle; open Findings.
- Expected: A short 'Oracle read the brief: nothing new found' note, and an empty state that says what to do next.

## qa4-work-10 · minor · The back link reads "← PRDs" even when the brief was opened from the Inbox
- Page: /intakes/<id> (Saved addresses, from Inbox › Oracle asks › Open)
- What: The back link reads "← PRDs" even when the brief was opened from the Inbox.
- Steps: Inbox › Oracle asks row › Open; look at the top-left back link.
- Expected: Back goes where the person came from, or the label names the place it goes.

## qa4-work-12 · minor · The Gaps tab shows internal-sounding fields
- Page: /intakes/<id> (Saved addresses, from Inbox › Oracle asks › Open)
- What: The Gaps tab shows internal-sounding fields: "Stop when: A named metric with a baseline value", "Section: Metrics", and a 'Triage' button whose effect is not said.
- Steps: Open the Gaps tab.
- Expected: Plain words ('Closed when…'), and a button label saying what Triage does.
- Where: web/app/intakes/[id]/_gaps.tsx

## qa4-work-15 · minor · The table header stacks 'Request' over 'State', and 'Start a PRD' wraps onto two lines, so…
- Page: /requests
- What: The table header stacks 'Request' over 'State', and 'Start a PRD' wraps onto two lines, so headers do not sit over their columns' values.
- Steps: Open /requests at 1440 wide; compare header to row values.
- Expected: One header per column, aligned with its values; a short checkbox header ('PRD').

## qa4-work-16 · minor · Rows with two state tags (New + Unverified, Disqualified + Unverified) stack them vertically…
- Page: /requests
- What: Rows with two state tags (New + Unverified, Disqualified + Unverified) stack them vertically, making those rows taller than the others.
- Steps: Look at 'Pay by bank transfer' and 'A custom domain for the shop'.
- Expected: Tags side by side so row heights stay even.

## qa4-work-17 · minor · Searching with no match shows "No requests match" with no way to clear, while the inspector…
- Page: /requests
- What: Searching with no match shows "No requests match" with no way to clear, while the inspector keeps showing a request that is no longer in the list.
- Steps: Select a request; type 'zzzz' in Search requests.
- Expected: Empty state with a 'Clear search' action; the inspector closes or says the item is filtered out.

## qa4-work-18 · minor · Opening /requests/new opens the New request dialog over the 'To decide' tab rather than the…
- Page: /requests/new
- What: Opening /requests/new opens the New request dialog over the 'To decide' tab rather than the list the person came from.
- Steps: Requests (All requests tab) › go to /requests/new or reload while the dialog is open.
- Expected: The dialog opens over the tab the person was on, or over All requests.
- Where: web/app/requests/new/page.tsx

## qa4-work-19 · minor · The New request form labels the person 'Requester', the table calls them 'Asked by', and the…
- Page: /requests
- What: The New request form labels the person 'Requester', the table calls them 'Asked by', and the inspector 'From'.
- Steps: Compare the New request form, the table header and the inspector.
- Expected: One word for the same field.

## qa4-work-20 · minor · The request inspector offers 'Reopen' next to Qualify/Merge/Disqualify for a request that is…
- Page: /requests
- What: The request inspector offers 'Reopen' next to Qualify/Merge/Disqualify for a request that is still New.
- Steps: Click 'Bulk edit prices'; read the Decision buttons.
- Expected: Reopen only on merged or disqualified requests.
- Where: web/app/requests/_components/RequestInspector.tsx

## qa4-work-21 · minor · On a phone the request cards wrap short values awkwardly ('A shop / owner', 'Faster check- /…
- Page: /requests
- What: On a phone the request cards wrap short values awkwardly ('A shop / owner', 'Faster check- / out', goal chips on two lines) in a two-column grid with lots of unused space.
- Steps: Open /requests at 390 wide; scroll the list.
- Expected: Values on one line, or one field per row when long.

## qa4-work-26 · minor · The header 'Decide' button has a dropdown chevron but only scrolls to the inline checkpoint…
- Page: /runs/<id> (from /runs) — Team onboarding PRD
- What: The header 'Decide' button has a dropdown chevron but only scrolls to the inline checkpoint card that already holds the decision buttons.
- Steps: /runs › Team onboarding PRD › click Decide.
- Expected: No chevron (it is a jump link), or a real menu with the decisions.
- Where: web/app/runs/_run-detail.tsx

## qa4-work-28 · minor · Panel eyebrows show raw lowercase states
- Page: /runs/<id> (from /runs)
- What: Panel eyebrows show raw lowercase states: 'Run · awaiting cost approval', 'Run · succeeded', 'Checkpoint · waiting'.
- Steps: Open any run; read the dark panel heading.
- Expected: Sentence case state matching the header tag ('Awaiting cost approval').

## qa4-work-29 · minor · The Decisions panel shows a terse log line in smaller type
- Page: /runs/<id> (from /runs) — Checkout redesign PRD
- What: The Decisions panel shows a terse log line in smaller type: 'PRD review · skipped · note: Turned off when the run started.'
- Steps: /runs › Checkout redesign PRD › Decisions.
- Expected: A sentence in the panel's normal size: 'PRD review was skipped: it was turned off when the run started.'

## qa4-work-30 · minor · The note box uses its placeholder as its only label ('Note (required to request changes)')
- Page: /runs/<id> (from /runs) — Team onboarding PRD
- What: The note box uses its placeholder as its only label ('Note (required to request changes)'); once typed in, the requirement disappears.
- Steps: Type in the note box under Confirm the baseline.
- Expected: A visible label above the box.

## qa4-work-31 · minor · On a phone the checkpoint table's 'Checkpoint' column becomes a grey line under each segment…
- Page: /runs/<id> (from /runs)
- What: On a phone the checkpoint table's 'Checkpoint' column becomes a grey line under each segment ('Feature set and dependencies', 'PRD review') with no label, reading like a subtitle.
- Steps: Open Team onboarding PRD at 390 wide; look at segments 2–4.
- Expected: Prefix it ('Stops for: PRD review') as the desktop screen reader text does.

## qa4-work-35 · minor · The 'Sources that need attention' table's columns do not line up with the main table above it…
- Page: /inbox
- What: The 'Sources that need attention' table's columns do not line up with the main table above it (For at 900 vs 680 px, Age 1216 vs 1000 px).
- Steps: Open Inbox at 1440; compare the two tables.
- Expected: Same column widths in both tables.

## qa4-work-38 · minor · The checkpoint row reads 'Confirm the baseline
- Page: /inbox
- What: The checkpoint row reads 'Confirm the baseline: nothing left to decide' yet sits in Needs you with a Review button.
- Steps: Open Inbox › Seen.
- Expected: Say what is needed ('Confirm the baseline: approve to continue').

## qa4-work-41 · minor · The same decision has different labels in the row and the panel
- Page: /runs/<id>/review/<checkpoint> — Feature set (scope-review)
- What: The same decision has different labels in the row and the panel: 'Defer' vs 'Defer to a later PRD'; the row offers 'Leave this out too' which the panel does not.
- Steps: Select Bulk edit; compare row buttons with the inspector.
- Expected: Same labels and options in both places.

## qa4-work-43 · minor · 'Requirements 2/2' and the goal chip 'Grow paid conversion · 1/3' show bare fractions without…
- Page: /runs/<id>/review/<checkpoint> — Feature set (scope-review)
- What: 'Requirements 2/2' and the goal chip 'Grow paid conversion · 1/3' show bare fractions without saying what they count.
- Steps: Open the feature set review; read the Requirements column and the Goals section.
- Expected: '2 of 2 kept', '1 of 3 features for this goal'.

## qa4-work-44 · minor · In the 'Needs you' filter the rows are numbered 3, 4, 5 (their place in All), which reads like…
- Page: /runs/<id>/review/<checkpoint> — Feature set (scope-review)
- What: In the 'Needs you' filter the rows are numbered 3, 4, 5 (their place in All), which reads like missing rows.
- Steps: Open the feature set review (Needs you tab).
- Expected: Number within the shown list, or hide the number.

## qa4-work-45 · minor · For a commenter the column is still headed 'Your call' and the panel shows the Include/Leave…
- Page: /runs/<id>/review/<checkpoint> — Feature set (scope-review)
- What: For a commenter the column is still headed 'Your call' and the panel shows the Include/Leave out/Defer buttons (inactive) beside 'An approver decides'.
- Steps: Sign in as commenter; open the feature set review.
- Expected: Heading 'Suggest' and no decision buttons the person cannot use.

## qa4-work-46 · minor · On a phone the group headings ('No goal 1', 'Raise activation 1') sit tight under the previous…
- Page: /runs/<id>/review/<checkpoint> — Feature set (scope-review)
- What: On a phone the group headings ('No goal 1', 'Raise activation 1') sit tight under the previous card with almost no gap.
- Steps: Open the feature set review at 390.
- Expected: Space above each group heading as on desktop.

## qa4-work-50 · minor · The 'Cart review step' row has a 'No date' tag and a 'No date' button side by side, and its…
- Page: /runs/<id>/review/<checkpoint> — Engineering dates (eng-dates)
- What: The 'Cart review step' row has a 'No date' tag and a 'No date' button side by side, and its '•••' menu drops to a line of its own.
- Steps: Open Engineering dates; look at the last row.
- Expected: Once marked No date, the button reads 'Edit reason' or is hidden; the menu stays in line.

## qa4-work-51 · minor · After Accept the row shows 'Accepted' but the Accept button stays the same, with no pressed…
- Page: /runs/<id>/review/<checkpoint> — Engineering dates (eng-dates)
- What: After Accept the row shows 'Accepted' but the Accept button stays the same, with no pressed state, so it is unclear the choice took.
- Steps: Click Accept on Shipping step.
- Expected: The chosen button shows as selected (or turns into 'Undo').

## qa4-work-54 · minor · 'No code map: assumptions' / 'No code map
- Page: /runs/<id>/review/<checkpoint> — Engineering check (eng-check)
- What: 'No code map: assumptions' / 'No code map: approach rests on assumptions' are terse and jargon-y for an owner.
- Steps: Open the engineering check; read the tags and panel.
- Expected: 'Oracle could not read the code, so this approach is a guess'.

## qa4-work-55 · minor · 'Ask the architect' is plain grey text, indented, with no button or link styling
- Page: /runs/<id>/review/<checkpoint> — Engineering check (eng-check); /runs/<id>/review/<checkpoint> — Engineering dates (eng-dates)
- What: 'Ask the architect' is plain grey text, indented, with no button or link styling.
- Steps: Look at the bottom of the right panel.
- Expected: Styled as a button like the others.
- Related to an end-to-end finding (another lane may touch it): E2E step 3 Engineering check: 'Send back to architect' looks disabled (grey text)
