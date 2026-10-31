# QA pass 4 · Simple decisions and meetings · bugs (34)
Found on the mock app (invented data) at desktop 1512 and phone 390, train AD's build. Ids qa4-<area>-N.

## qa4-simple-decide-1 · blocker · Viewer can undo the owner's applied changes in the meeting chat
- Page: /simple/meetings/<id>/chat
- What: A viewer can undo the owner's applied changes in the meeting chat: every applied card shows 'Undo this change' to everyone, and pressing it as the viewer removed the owner's note from the meeting's notes.
- Steps: Owner: start a review of Guided setup with Viewer attending; in its chat send 'note: keep reminders quiet on weekends' and press Apply. Sign in as viewer@example.com, Meetings > Join > Open chat on its own page; press 'Undo this change' on the note card.
- Expected: Only the person who applied the change (or someone allowed to change things) sees Undo; a viewer sees the card read-only. Today the card reads 'Undone' and the note disappears from Notes so far and from the minutes.
- Where: web/components/simple/chat/ChatCard.tsx:338 (Undo shown whenever card.status==='applied', no permission check)

## qa4-simple-decide-2 · major · 'Approve one-pager edits (1)' publishes the PRD in one click, no preview
- Page: /simple/meetings/<live id>
- What: 'Approve one-pager edits (1)' in the meeting header publishes the whole PRD in one click, with no confirmation and no way to see what the one edit is.
- Steps: Owner in a live review of Guided setup: move a roadmap item from the chat, then press 'Approve one-pager edits (1)' in the header.
- Expected: The button opens what will be approved (the edit, its line) and asks to confirm a publish; the label says it publishes. Today it silently records 'D-9 Approved Guided setup (published)' and a banner 'Approved in Review: Guided setup · published'.
- Where: web/app/simple/meetings/[id]/_meeting.tsx (header actions)

## qa4-simple-decide-3 · major · Ending a meeting silently drops a commenter's pending proposal
- Page: /simple/meetings/<live id>
- What: Ending a meeting silently drops a pending proposal: the commenter's 'move Welcome video to Now' is not in the End dialog, the minutes, or 'What still waits on whom' ('No approval waits').
- Steps: As commenter in a live review, send 'move Welcome video to Now' in the chat and press Propose. As owner, press End meeting > End meeting, read the minutes.
- Expected: The End dialog warns that 1 proposal is still waiting, and the minutes list it under What still waits on whom (or it carries over).
- Where: web/app/simple/meetings/[id]/_meeting.tsx (end dialog / minutes)

## qa4-simple-decide-4 · major · Ended meeting's chat still takes messages whose Apply is dead
- Page: /simple/meetings/<past id>/chat
- What: The chat of an ended meeting still has a live message box; a message gets a change card whose Apply is greyed out ('The meeting has ended') — a dead end — and the chat shows none of the meeting's earlier messages.
- Steps: Meetings > Past > Review: Usage alerts > open /chat (Open chat on its own page) > type 'note: test' > Send.
- Expected: An ended meeting's chat is read-only: the past messages show, the box is replaced by 'This meeting has ended; ask Oracle instead'.
- Where: web/components/simple/chat/MeetingChat.tsx

## qa4-simple-decide-5 · major · Commenter cannot apply although the rule says 'Everyone except viewers'
- Page: /simple/meetings/<live id>
- What: A commenter cannot apply a change even though the meeting rule reads 'Who changes things: Everyone except viewers'; their card only offers Propose ('Proposed to Admin by you').
- Steps: Owner starts a review with the default rule 'Everyone except viewers' and Commenter attending. As commenter, send 'move Welcome video to Now' in the meeting chat.
- Expected: Either the commenter can Apply (as the rule says) or the rule names who really can change things (e.g. 'Editors and owners; others propose').
- Where: web/components/simple/chat/ChatCard.tsx

## qa4-simple-decide-6 · major · Same question: 'Decide for Approver' on List, 'Decide as recommended' on Board
- Page: /simple/decisions
- What: The same question shows different buttons on List and Board: Q7, Q12, Q15 (Approver decides) read 'Decide for Approver' (secondary) on List but 'Decide as recommended' (primary) on Board and on the meeting's agenda.
- Steps: Decisions > List: look at Q7 under Waiting for others. Switch to Board: Q7 under Recommended. Start a review: Q7 on the Decisions step.
- Expected: One label everywhere for deciding someone else's question ('Decide for Approver'), so the owner knows they decide on another's behalf.
- Where: web/app/simple/decisions/_decisions.tsx:294 (Board's QuestionRow lacks forOthers; only line 245 passes it)

## qa4-simple-decide-7 · major · Meetings list shows a past meeting's end time unlabelled
- Page: /simple/meetings
- What: A past meeting's row shows its END time with no label ('Sat Oct 24, 12:02 AM') while the Decisions page dates the same meeting by its start ('Fri Oct 23'), so the two pages disagree on the meeting's day.
- Steps: Meetings > Past: Review: Usage alerts. Then Decisions > By meeting: the same meeting's card.
- Expected: Both pages show the same moment, labelled ('started Fri Oct 23, 11:12 PM' or 'ended …').
- Where: web/app/simple/meetings/page.tsx:137 (when(m.ended_at ?? m.started_at))

## qa4-simple-decide-8 · major · Board 'Needs input' holds questions that have a recommendation
- Page: /simple/decisions?view=board
- What: Board's 'Needs input' column holds Q2 and Q4, which have a recommendation and a primary 'Decide as recommended' button, so the column name contradicts its cards (they only lack a decider).
- Steps: Decisions > Board: read Q2 Export format sign-off under Needs input.
- Expected: Cards with a recommendation but no decider sit under a column that says so ('Needs a decider'), or under Recommended with 'Name a decider' first.
- Where: web/lib/api/mock/simple-questions.ts:130 / web/app/simple/decisions/_decisions.tsx:267

## qa4-simple-decide-9 · major · Board 'Decided 1' while List shows 4 decisions
- Page: /simple/decisions?view=board
- What: Board says 'Decided 1' (phone tab and desktop 'Decided questions 1') while List and By meeting show 4 decisions (D-4, Q1, D-2, D-1); after a meeting it is 2 vs 9.
- Steps: Decisions > Board: Decided count. Switch to List: count the decided rows.
- Expected: The Board's decided column says it counts PRD questions only ('Decided questions') on the phone tab too, or includes meeting decisions.
- Where: web/app/simple/decisions/_decisions.tsx:274

## qa4-simple-decide-10 · major · Internal codes ('Blocks M1: F-03', 'Q5') instead of plain words
- Page: /simple/decisions
- What: Question rows on Decisions and the meeting agenda show internal codes 'Blocks M1: F-03 Health log', although a plainBlocks() helper exists to show 'Blocks Health log, first milestone' (qa-simple-home-13).
- Steps: Decisions > List: read any row's 'Blocks …' line.
- Expected: 'Blocks Health log, first milestone' as Home shows it.
- Where: web/components/simple/questions/Questions.tsx:423 (plain only when the caller asks)

## qa4-simple-decide-11 · major · A meeting decision gets a second code (Q5 and D-5)
- Page: /simple/meetings/<live id>
- What: Meeting decisions get a second code: deciding Q5 in a meeting shows as 'D-5 Decided Q5 Reminder default time' in the meeting, but as 'Q5 Reminder default time' on the Decisions page; an open question in the minutes is coded 'D-3' like a decision.
- Steps: Start a review, Decisions step, Decide as recommended on Q5. Read All decisions; then Decisions > By meeting. Past meeting minutes: 'D-3: Should muted teams…' under Open questions.
- Expected: One code per item: Q5 stays Q5; open questions are not given decision codes.
- Where: web/lib/api/mock/simple-meetings.ts / web/app/simple/meetings/[id]/_meeting.tsx

## qa4-simple-decide-12 · major · Meeting decisions recorded without saying what changed
- Page: /simple/meetings/<live id>
- What: Decisions recorded from the roadmap step and accepted proposals do not say what changed: 'D-7 Moved Sample data import', 'D-8 Accepted: Moved Team invite nudges' (to where? proposed by whom?), while a chat move reads 'D-6 Move Setup checklist to Next'.
- Steps: Live review > 2 Roadmap > Move to Later on Sample data import; 3 Decisions > Pending proposals > Accept. Read All decisions and the minutes.
- Expected: 'Moved Sample data import to Later', 'Accepted Commenter's proposal: Team invite nudges to Now'; one tense for all.
- Where: web/lib/api/mock/simple-meetings.ts

## qa4-simple-decide-13 · major · Start a review: Start greys out with no reason
- Page: /simple/meetings (Start a review)
- What: Start a review: Start greys out with no reason when no attendee (other than you) is ticked, or when 'Presenter plus one or two people' has nobody picked.
- Steps: Meetings > Start review; untick Admin and Approver (or choose 'Presenter plus one or two people' and pick nobody).
- Expected: A line beside Start saying what is missing ('Tick at least one attendee', 'Pick who may change things').
- Where: web/components/simple/meetings/StartSheet.tsx:242

## qa4-simple-decide-15 · major · Meeting roadmap step rows unordered; Move buttons misaligned
- Page: /simple/meetings/<live id>
- What: Roadmap step lists items in no order (Now, Now, Cut, Later, Next) and its Move buttons do not line up row to row.
- Steps: Live review > 2 Roadmap.
- Expected: Rows ordered Now, Next, Later, Cut (or by date); buttons in fixed columns.
- Where: web/app/simple/meetings/[id]/_meeting.tsx

## qa4-simple-decide-17 · major · Toasts cover controls (meeting step pills and timer; other pages)
- Page: /simple/meetings/<live id>
- What: The 'Decided Q5' toast in a live meeting covers the header's step pills (2 Roadmap, 3 Decisions) and timer; on the Decisions page the same toast sits at the bottom.
- Steps: Live review > 3 Decisions > Decide as recommended on Q5.
- Expected: The toast does not cover the meeting's navigation; same position on every page.
- Where: web/app/simple/meetings/[id]/_meeting.tsx

## qa4-simple-decide-19 · major · Times mix formats and zone letters (PDT/PT/PST)
- Page: /simple/meetings/<live id>
- What: Times in one meeting use four formats: '8:18 PM PDT', 'Oct 30, 8:18 PM PDT', 'Fri Oct 30, 8:21 PM', 'drawn Oct 26, 8:00 AM PT', 'Oct 20, 2026'; the Start sheet adds 'Mon, Nov 2, 9:00 AM PST' with a comma, while the lead already says times are Pacific.
- Steps: Live review: read Q5 after deciding, All decisions, a comment, the one-pager header; Meetings > Start review on Weekly goals check-in.
- Expected: One format ('Fri Oct 30, 8:18 PM') and no zone letters, as the page lead names the zone.
- Where: web/app/simple/meetings/[id]/_meeting.tsx, web/components/simple/meetings/StartSheet.tsx

## qa4-simple-decide-14 · minor · In 'Presenter plus one or two people' the picker offers Viewer, although viewers cannot change…
- Page: /simple/meetings (Start a review)
- What: In 'Presenter plus one or two people' the picker offers Viewer, although viewers cannot change things in any mode.
- Steps: Meetings > Start review; tick Viewer under Who attends; choose 'Presenter plus one or two people'.
- Expected: Only people whose role may change things are offered.
- Where: web/components/simple/meetings/StartSheet.tsx:226

## qa4-simple-decide-16 · minor · The roadmap step's Move/Cut buttons act on one click with only a 'Done' line
- Page: /simple/meetings/<live id>
- What: The roadmap step's Move/Cut buttons act on one click with only a 'Done' line; no Undo, no word of what moved, while the same change from the chat needs Preview and Apply.
- Steps: Live review > 2 Roadmap > Move to Later on Sample data import.
- Expected: A toast 'Moved Sample data import to Later · Undo', like deciding a question.
- Where: web/app/simple/meetings/[id]/_meeting.tsx

## qa4-simple-decide-20 · minor · An ended meeting's header reads 'Ended Sat Oct 24, 12:02 AM (Pacific Time (Los Angeles))' with…
- Page: /simple/meetings/<past id>
- What: An ended meeting's header reads 'Ended Sat Oct 24, 12:02 AM (Pacific Time (Los Angeles))' with nested brackets.
- Steps: Meetings > Past > Review: Usage alerts.
- Expected: 'Ended Sat Oct 24, 12:02 AM Pacific Time'.
- Where: web/app/simple/meetings/[id]/_meeting.tsx:644

## qa4-simple-decide-21 · minor · A past meeting says its count twice
- Page: /simple/meetings
- What: A past meeting says its count twice: '· 1 decision' on the row and '1 decision taken.' right under it; the Decisions card also repeats the title ('Review: Usage alerts' and 'Fri Oct 23 · Usage alerts').
- Steps: Meetings > Past; Decisions > By meeting.
- Expected: Say it once; the date line without the PRD name when the title already has it.
- Where: web/app/simple/meetings/page.tsx:137, web/app/simple/decisions/_decisions.tsx:335

## qa4-simple-decide-23 · minor · Attendee chips are hidden toggles
- Page: /simple/meetings/<live id>
- What: Attendee chips are hidden toggles: pressing a name marks that person absent/present with no visible button look, and their accessible name stays 'Commenter is here' whatever the state.
- Steps: Live review: click 'Commenter' in the attendee row.
- Expected: A visible control ('Mark away') whose name follows its state.
- Where: web/app/simple/meetings/[id]/_meeting.tsx:209-216

## qa4-simple-decide-24 · minor · 'All decisions' in the meeting sidebar lists only this meeting's decisions ('None yet.' while…
- Page: /simple/meetings/<live id>
- What: 'All decisions' in the meeting sidebar lists only this meeting's decisions ('None yet.' while the company has many).
- Steps: Live review: right column.
- Expected: 'Decisions in this meeting'.
- Where: web/app/simple/meetings/[id]/_meeting.tsx

## qa4-simple-decide-25 · minor · After edits and an approval the one-pager's 'Changes and proposals' still says 'No changes…
- Page: /simple/meetings/<live id>
- What: After edits and an approval the one-pager's 'Changes and proposals' still says 'No changes yet', and the header keeps 'Version 3 · Oct 20, 2026' after publishing.
- Steps: Live review: make changes, Approve one-pager edits, go back to 1 One-pager.
- Expected: Changes listed beside their lines; the version line updated.
- Where: web/components/simple/OnePager.tsx

## qa4-simple-decide-26 · minor · The one-pager card in the meeting sits 32 px left of the title and buttons above it, and…
- Page: /simple/meetings/<live id>
- What: The one-pager card in the meeting sits 32 px left of the title and buttons above it, and Present / Export PDF / Open the detailed view float above the narrow middle column.
- Steps: Live review > 1 One-pager.
- Expected: Card, title and actions on one left edge.
- Where: web/app/simple/meetings/[id]/_meeting.tsx

## qa4-simple-decide-27 · minor · On a phone the meeting header's 'Meetings' link and the title sit on different…
- Page: /simple/meetings/<live id>
- What: On a phone the meeting header's 'Meetings' link and the title sit on different lines/baselines, and the one-pager card nests padding so text runs in a ~260 px column.
- Steps: Phone 390: open a live review.
- Expected: Back link and title aligned; one level of card padding.
- Where: web/app/simple/meetings/[id]/_meeting.tsx

## qa4-simple-decide-29 · minor · A chat change card repeats itself
- Page: /simple/meetings/<live id>
- What: A chat change card repeats itself: 'Move Setup checklist to Next' then 'Item: Setup checklist'; Oracle's bubble 'I understood one change:' ends in a colon with the change in a separate box.
- Steps: Live review chat: send 'move Setup checklist to Next'.
- Expected: One line per change.
- Where: web/components/simple/chat/ChatCard.tsx

## qa4-simple-decide-30 · minor · A viewer's chat says 'Viewers ask questions here
- Page: /simple/meetings/<live id>/chat
- What: A viewer's chat says 'Viewers ask questions here; the presenter makes changes and notes' while the rule shown above reads 'Everyone except viewers' may change things.
- Steps: As viewer, join a live review with the default rule; open its chat.
- Expected: The hint matches the rule ('Commenters and up make changes').
- Where: web/components/simple/chat/MeetingChat.tsx

## qa4-simple-decide-31 · minor · Pending proposals: Accept (tall primary) and Decline (short) are different heights
- Page: /simple/meetings/<live id>
- What: Pending proposals: Accept (tall primary) and Decline (short) are different heights; the comment box's 'Add comment' looks disabled until typing.
- Steps: Live review > 3 Decisions with a pending proposal.
- Expected: Matching button sizes.
- Where: web/app/simple/meetings/[id]/_meeting.tsx:487-489

## qa4-simple-decide-32 · minor · Minutes: 'No flow yet' appears on only one decision (D-8)
- Page: /simple/meetings/<live id>
- What: Minutes: 'No flow yet' appears on only one decision (D-8); 'Connect Slack' is grey like disabled text; comments in the minutes are not shown on the Decisions page's meeting card.
- Steps: End a live review and read the minutes; Decisions > By meeting.
- Expected: Flow state shown consistently or not at all; Connect Slack styled as a link; same minutes on both pages.
- Where: web/app/simple/meetings/[id]/_meeting.tsx

## qa4-simple-decide-34 · minor · On a phone, upcoming rows break 'Pre-|read' at the hyphen and the past row breaks '12:02 | AM'
- Page: /simple/meetings
- What: On a phone, upcoming rows break 'Pre-|read' at the hyphen and the past row breaks '12:02 | AM'.
- Steps: Phone 390: Meetings.
- Expected: Non-breaking 'Pre-read' and times.
- Where: web/app/simple/meetings/page.tsx:119,137

## qa4-simple-decide-35 · minor · With Ask Oracle open at 1440 the 'Waiting for you' heading wraps to two lines and the…
- Page: /simple/decisions
- What: With Ask Oracle open at 1440 the 'Waiting for you' heading wraps to two lines and the List/Board/By meeting switch drops under the filters.
- Steps: Decisions > Ask Oracle on any row.
- Expected: Heading stays on one line; layout holds.
- Where: web/app/simple/decisions/_decisions.tsx

## qa4-simple-decide-37 · minor · Commenter's PRD filter lists only 'Usage alerts' while the list shows 14 Guided setup…
- Page: /simple/decisions
- What: Commenter's PRD filter lists only 'Usage alerts' while the list shows 14 Guided setup questions to them.
- Steps: Sign in as commenter@example.com > Simple > Decisions > PRD filter.
- Expected: Every PRD whose questions are shown is in the filter.
- Where: web/app/simple/decisions/_decisions.tsx:306

## qa4-simple-decide-38 · minor · Footer link 'Open the Inbox (it leaves Simple)' reads awkwardly
- Page: /simple/decisions
- What: Footer link 'Open the Inbox (it leaves Simple)' reads awkwardly; the Decided badge uses the same yellow attention colour as waiting counts.
- Steps: Decisions: bottom of the page; Board > Decided questions.
- Expected: 'Open the Inbox in Detailed'; a neutral badge for done items.
- Where: web/app/simple/decisions/_decisions.tsx

## qa4-simple-decide-39 · minor · Links named only by code ('D-9', 'D-8' …) and four identical 'Start review' buttons give…
- Page: /simple/meetings/<id>
- What: Links named only by code ('D-9', 'D-8' …) and four identical 'Start review' buttons give screen-reader users no context.
- Steps: Tab through an ended meeting and the Meetings page.
- Expected: Accessible names like 'D-9 Approved Guided setup' and 'Start review: Weekly goals check-in'.
- Where: web/app/simple/meetings/[id]/_meeting.tsx, web/app/simple/meetings/page.tsx
