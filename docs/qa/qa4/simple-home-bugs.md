# QA pass 4 · Simple Home · bugs (24)
Found on the mock app (invented data) at desktop 1512 and phone 390, train AD's build. Ids qa4-<area>-N.

## qa4-simple-home-1 · blocker · Walk me through it: a typed answer is not recorded
- Page: /simple
- What: In 'Walk me through it', typing your own answer (e.g. 'Seven steps') under 'Or type your answer' is answered with 'I could not tell what to change' and the decision is not recorded.
- Steps: Home > Walk me through it > on a decision type 'Seven steps' in 'Or type your answer' > send.
- Expected: The typed answer is recorded as the decision (or Oracle asks one clarifying question in plain words).
- Where: web/app/simple/walk.tsx:35 (typed text goes to the chat change parser)

## qa4-simple-home-2 · major · A decision's Ask Oracle prefills code 'Q5' and Oracle cannot answer
- Page: /simple
- What: A decision's 'Ask Oracle' opens the Ask panel prefilled with the internal code 'Q5' at the start, and Oracle's reply is 'I could not tell what to change'.
- Steps: Home > Decisions waiting for you > Ask Oracle on any row > Send the prefilled text.
- Expected: The prefill names the decision in words and Oracle answers the question about it.
- Where: web/components/simple/questions/Questions.tsx:94

## qa4-simple-home-3 · major · Answer citation '1' not clickable, hidden from screen readers, no source
- Page: /simple
- What: Oracle's answers show a superscript citation number '1' that is hidden from screen readers, cannot be clicked and has no matching source listed anywhere.
- Steps: Ask panel > ask any question on Home > read the answer.
- Expected: A citation opens or lists its source, or no number is shown.

## qa4-simple-home-4 · major · Suggestions drawer cannot be opened from Home
- Page: /simple
- What: The suggestions drawer cannot be opened from Home: no goal card ever shows its Suggestions button, because the goals with suggestions are not the company goals the cards show.
- Steps: Home > look at both goal cards for a Suggestions control.
- Expected: Each goal card with suggestions shows a 'Suggestions' button that opens the drawer.
- Where: web/app/simple/page.tsx:464 (goal cards)

## qa4-simple-home-5 · major · Broken-link rows repeat the same move sentence and button
- Page: /simple
- What: After a broken link is fixed, the same 'Moving the dependents starts X and Y...' sentence is shown word for word under two different broken-link rows, and 'Move the dependents' appears twice doing one thing.
- Steps: Home > The plan this quarter > Broken links with two linked items; read the sentence under each row.
- Expected: Each row explains only its own move; one control per action.
- Where: web/app/simple/page.tsx:1047

## qa4-simple-home-7 · major · 'The plan this quarter' shows one roadmap while broken links name others
- Page: /simple
- What: 'The plan this quarter' shows one row 'Guided setup · no milestone · 4 items' (wrapping onto two lines at 1440 and when the Ask panel is open) while the broken links under it name items on the Alerts and Onboarding roadmaps that the plan does not draw.
- Steps: Home at 1440x900 > The plan this quarter; open Ask Oracle to see the squeeze.
- Expected: The plan shows the roadmaps whose items it lists as broken; the row label fits on one line or truncates with an ellipsis.
- Where: web/components/simple/PlanByMonth.tsx:87

## qa4-simple-home-9 · major · Walk-through counts 10 decisions while Home says 9
- Page: /simple
- What: The walk-through's summary says '10 decisions and 5 broken links still wait' while Home's tiles say 9 decisions at the same moment (a meeting agenda item is counted as a decision).
- Steps: Home > Walk me through it > Skip to the end > compare the summary to Home's tiles.
- Expected: One count of decisions everywhere.

## qa4-simple-home-12 · major · Home's draft line counts 1 change while Roadmap counts 2
- Page: /simple
- What: Home's draft line says 'Your working draft of Alerts roadmap has 1 change' while the Roadmap page counts 2 changes after accepting a risk on In-app tour (Onboarding roadmap): the second draft is never mentioned on Home.
- Steps: Home > Accept as risk on In-app tour > read the draft line; open Roadmap.
- Expected: Home lists every working draft with its own count, or the total matches Roadmap.

## qa4-simple-home-16 · major · Viewers/commenters told '2 changes are in review' when only an unsent draft exists
- Page: /simple
- What: A viewer and a commenter are told '2 changes are in review' while the owner only has an unsent working draft; after the commenter proposes a fix the count becomes 3.
- Steps: Sign in as viewer@example.com (or commenter@) > Simple Home; compare with the owner's Home.
- Expected: Other roles see only what is really in review (nothing until the owner sends the draft).

## qa4-simple-home-17 · major · Commenter greeting says 'You can propose fixes' beside 'Nothing waits on you'
- Page: /simple
- What: As a commenter, the greeting says 'You can propose fixes for broken links' while the card below says 'Nothing waits on you', and a lone full-width '5 broken links' tile sits in the summary.
- Steps: Sign in as commenter@example.com > Simple Home.
- Expected: One consistent message; the tile row sized for one tile.
- Where: web/app/simple/page.tsx:246, :543

## qa4-simple-home-18 · major · Commenter can propose the same 'Move the dependents' fix twice
- Page: /simple
- What: As a commenter, after proposing 'Move the dependents' on Weekly alert digest (which also moves Mobile alert push), Mobile alert push still offers 'Propose: move the dependents', creating a duplicate proposal.
- Steps: Commenter > Home > Broken links > Propose on Weekly alert digest > look at Mobile alert push.
- Expected: Items already covered by a pending proposal say so and do not offer the same proposal.

## qa4-simple-home-24 · major · Reopened Home chat on Roadmap relabels the scope 'Home', no way back
- Page: /simple/roadmap
- What: Reopening a Home chat from Recent chats while on Roadmap relabels the scope switch 'Home | General' and the box 'Ask about Home' while you are on Roadmap, with no way back to 'This page' except New chat.
- Steps: Home > Ask Oracle > send a question > go to Roadmap > Ask Oracle > Recent chats > open the Home chat.
- Expected: The switch says which page the chat is about and offers a one-click way back to a chat about this page.

## qa4-simple-home-33 · major · A walk-through typed answer shows up in Recent chats as a new chat
- Page: /simple
- What: An answer typed in the walk-through ('Seven steps') turns up in Ask Oracle's Recent chats as a Home chat the person never started.
- Steps: Home > Walk me through it > type an answer > open Ask Oracle > Recent chats.
- Expected: Walk-through answers are recorded on the decision and do not create chats.
- Where: web/app/simple/walk.tsx:35

## qa4-simple-home-6 · minor · The second goal card has no 'From' starting value ('Now 9.4% · target 12%') while the first…
- Page: /simple
- What: The second goal card has no 'From' starting value ('Now 9.4% · target 12%') while the first shows 'From 31% · now 38% · target 45%', and Simple Home shows 2 goals while Detailed Home shows 3 (the proposed 'Cut early churn' is missing with no hint).
- Steps: Home in Simple, then switch to Detailed and compare goals.
- Expected: Goal cards read the same way; a proposed goal is shown or a note says proposed goals are hidden.
- Where: web/app/simple/page.tsx:464

## qa4-simple-home-10 · minor · Finishing the walk-through with Done drops keyboard focus to the page body instead of back on…
- Page: /simple
- What: Finishing the walk-through with Done drops keyboard focus to the page body instead of back on 'Walk me through it'.
- Steps: Keyboard: Tab to Walk me through it > Enter > go to the end > Done > press Tab.
- Expected: Focus returns to the control that opened the walk.

## qa4-simple-home-11 · minor · After a fix, the toast sits over the rail's Ask Oracle and account controls for about 10…
- Page: /simple
- What: After a fix, the toast sits over the rail's Ask Oracle and account controls for about 10 seconds, and its text repeats the item's name ('Weekly alert digest ‘Weekly alert digest’ ends...').
- Steps: Home > a broken link > Move the dependents; watch the bottom-left.
- Expected: The toast does not hide controls (or is placed over main content) and names the item once.

## qa4-simple-home-14 · minor · 'Another answer' repeats the recommended answer
- Page: /simple
- What: 'Another answer' lists the recommended answer again ('5 invites (recommended)'), which does the same as 'Decide as recommended' beside it.
- Steps: Home > Decisions > Another answer.
- Expected: Another answer offers only the other options and a free-text box.

## qa4-simple-home-20 · minor · As a viewer (no name), the rail's account line breaks the email at the @ ('viewer' /…
- Page: /simple
- What: As a viewer (no name), the rail's account line breaks the email at the @ ('viewer' / '@example.com').
- Steps: Sign in as viewer@example.com > Simple > look at the rail's account at the bottom.
- Expected: The email stays on one line, truncated with an ellipsis if needed.

## qa4-simple-home-21 · minor · A viewer sees the broken links list with no hint of who fixes them or why they are shown to…
- Page: /simple
- What: A viewer sees the broken links list with no hint of who fixes them or why they are shown to someone who cannot act.
- Steps: Sign in as viewer@example.com > Simple Home > Broken links.
- Expected: A short line: 'The owner fixes these; you can't change the roadmap.'

## qa4-simple-home-22 · minor · On the phone tab bar the More badge '3' (meetings) is yellow, the 'needs you' colour, while…
- Page: /simple
- What: On the phone tab bar the More badge '3' (meetings) is yellow, the 'needs you' colour, while the desktop rail shows the same count grey.
- Steps: Phone 390 > Simple Home > tab bar.
- Expected: Same badge meaning and colour on phone and desktop.

## qa4-simple-home-25 · minor · The summary tile reads '1 proposals on your items' on desktop and '1 proposals' on the phone…
- Page: /simple
- What: The summary tile reads '1 proposals on your items' on desktop and '1 proposals' on the phone (no singular).
- Steps: Owner Home with one proposal waiting.
- Expected: '1 proposal on your items'.
- Where: web/app/simple/page.tsx:261

## qa4-simple-home-28 · minor · Each broken link names its item twice
- Page: /simple
- What: Each broken link names its item twice: the red heading 'Weekly alert digest' then the sentence 'Weekly alert digest ends Dec 21...'.
- Steps: Home > The plan this quarter > Broken links.
- Expected: Name the item once (heading), the sentence starting 'Ends Dec 21, after...'.

## qa4-simple-home-31 · minor · 'Guided setup recommends: ...' presents a document title as if it were a person giving advice
- Page: /simple
- What: 'Guided setup recommends: ...' presents a document title as if it were a person giving advice.
- Steps: Home > Decisions waiting for you.
- Expected: 'Recommended in Guided setup: Yes, at launch'.
- Where: web/components/simple/questions/Questions.tsx:102

## qa4-simple-home-32 · minor · Recent chats titles are the whole first message, so a chat started from a decision's Ask…
- Page: /simple
- What: Recent chats titles are the whole first message, so a chat started from a decision's Ask Oracle shows a three-line title starting with the code 'Q5 Reminder default time in Guided setup: what should we decide? ...'.
- Steps: Home > a decision's Ask Oracle > Send > open Recent chats (phone 390 shows it worst).
- Expected: Short titles in plain words (e.g. 'Reminder default time'), one or two lines with ellipsis.
- Where: web/components/simple/questions/Questions.tsx:94
