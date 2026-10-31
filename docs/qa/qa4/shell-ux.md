# QA pass 4 · Shell (navigation, Ask, errors, mode switch) · design changes (3)
Found on the mock app (invented data) at desktop 1512 and phone 390, train AD's build. Ids qa4-<area>-N.

## qa4-shell-7 · minor · Closing Ask and opening it again drops the conversation you were in
- Page: Ask drawer (all Detailed pages)
- What: Closing Ask and opening it again drops the conversation you were in; the drawer opens on an empty 'New chat about Runs', and the old chat is a row under 'HERE' with an unlabelled number '2'.
- Steps: Runs, open Ask, send a question, close the drawer, open Ask again.
- Expected: Reopening shows the chat you left. In the chat list, say what the number counts ('2 messages').
- Where: web/components/hop/HopPanel.tsx

## qa4-shell-8 · minor · The Ask drawer says the chat is private three times
- Page: Ask drawer (all pages)
- What: The Ask drawer says the chat is private three times: 'Just you and Oracle' in the header, then a 'Private' chip and a '1 person' chip on the thread.
- Steps: Open Ask on PRDs and send a question.
- Expected: One indicator of who can see the chat.
- Where: web/components/hop/HopPanel.tsx

## qa4-shell-10 · minor · Ask uses two icons: Oracle's compass mark on Detailed's desktop strip and drawer, but a…
- Page: Ask (phone header, Simple rail) vs Detailed's Ask strip
- What: Ask uses two icons: Oracle's compass mark on Detailed's desktop strip and drawer, but a circled question mark (which reads as Help) in the phone header and on Simple's 'Ask Oracle' button.
- Steps: Compare the Ask strip at 1440 with the phone header's Ask and Simple's rail.
- Expected: One icon for Ask everywhere, preferably Oracle's mark.
- Where: web/components/ds/AppShell.tsx:817 (Icon name="ask")
