# QA pass 4 · Simple decisions and meetings · design changes (4)
Found on the mock app (invented data) at desktop 1512 and phone 390, train AD's build. Ids qa4-<area>-N.

## qa4-simple-decide-22 · minor · The meeting page drops the Simple sidebar, Ask and account menu (only a small 'Meetings' link…
- Page: /simple/meetings/<past id>
- What: The meeting page drops the Simple sidebar, Ask and account menu (only a small 'Meetings' link leads out; Tab reaches no navigation), while its own chat page keeps the full shell.
- Steps: Meetings > Review: Usage alerts; then Open chat on its own page.
- Expected: Same shell on both, or a clear 'Back to Meetings' with an arrow.
- Where: web/app/simple/meetings/[id]/_meeting.tsx

## qa4-simple-decide-28 · minor · The meeting chat is a scroll box inside a scrolling page (two scrollbars)
- Page: /simple/meetings/<live id>
- What: The meeting chat is a scroll box inside a scrolling page (two scrollbars); new cards appear cut at the box's top edge.
- Steps: Live review: send three messages in the chat.
- Expected: One scroll, or the box grows and keeps the newest message whole.
- Where: web/components/simple/chat/ChatThread.tsx

## qa4-simple-decide-33 · minor · Starting a review from an upcoming 'Weekly goals check-in' opens the PRD review sheet (What is…
- Page: /simple/meetings
- What: Starting a review from an upcoming 'Weekly goals check-in' opens the PRD review sheet (What is reviewed: PRD Guided setup), which fits a goals check-in poorly; there is no way to open a pre-read ('Pre-read not ready yet' on every row, not actionable).
- Steps: Meetings > Upcoming > Start review on Weekly goals check-in.
- Expected: The sheet says what this ritual reviews; the row says when the pre-read will be ready.
- Where: web/components/simple/meetings/StartSheet.tsx, web/app/simple/meetings/page.tsx:119

## qa4-simple-decide-36 · minor · List view already ends with every decision by meeting, so 'By meeting' is the same content…
- Page: /simple/decisions
- What: List view already ends with every decision by meeting, so 'By meeting' is the same content minus Waiting; two views doing one thing.
- Steps: Decisions > List, scroll down; then By meeting.
- Expected: List shows only what waits, or By meeting adds something.
- Where: web/app/simple/decisions/_decisions.tsx
