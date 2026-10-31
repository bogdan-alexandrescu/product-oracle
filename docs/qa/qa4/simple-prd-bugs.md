# QA pass 4 · Simple one-pagers · bugs (27)
Found on the mock app (invented data) at desktop 1512 and phone 390, train AD's build. Ids qa4-<area>-N.

## qa4-simple-prd-1 · major · Start review says only 'No such PRD' on 6 of 7 one-pagers
- Page: /simple/one-pagers/<doc>
- What: Start review opens a dialog that says only "No such PRD" for 6 of the 7 one-pagers (Saved carts, Checkout redesign, Online deposits, ...); only Usage alerts gets the review form.
- Steps: As owner open One-pagers > Saved carts PRD (or Online deposits at booking, Checkout redesign PRD) > Start review.
- Expected: The review form for that PRD, or, if a review cannot be started, a sentence saying why and what to do; never a bare server message.
- Where: web/lib/api/mock/simple-meetings.ts:894 (the mock's meetings list does not know these PRDs); web/components/simple/meetings/StartSheet.tsx shows the raw detail
- Note: may be the mock's data, not the product: fix the mock if the mock is wrong, else say so and skip.

## qa4-simple-prd-2 · major · Phone: 'Ask an owner to start a review' hint overlaps a button
- Page: /simple/one-pagers/<doc>
- What: Phone, viewer and commenter: the hint "Ask an owner to start a review" under the disabled Start review button is drawn on top of the "Open the detailed view" button.
- Steps: Sign in as viewer@example.com on a 390 px phone, open One-pagers > Saved carts PRD.
- Expected: The hint sits on its own line under the buttons (or the disabled button is not shown), with nothing overlapping.

## qa4-simple-prd-3 · major · Badge says Draft while banner says published v3 stays live
- Page: /simple/one-pagers/<doc>
- What: The header badge says Draft while the banner above says "published v3 stays live until approved" (owner) or "you read the published version" (viewer, commenter): the page contradicts itself about whether this PRD was ever published.
- Steps: As owner edit a line on Saved carts PRD; read the yellow banner and the Draft badge under the title. Sign in as viewer and read the grey banner.
- Expected: One status: if v3 is published the badge says so (e.g. Published, edits in review); if it is a draft the banner does not call it published.

## qa4-simple-prd-5 · major · Present mode lays the one-pager off-centre
- Page: /simple/one-pagers/<doc>
- What: Present mode lays the one-pager out off-centre: the card sits in the left two thirds with an empty right third (where the rail was), and the Stop presenting button floats over the empty area.
- Steps: Open Saved carts PRD > Present at 1440 or 1512 wide.
- Expected: The presented one-pager is centred (or uses the width) with nothing left over from the editing layout.

## qa4-simple-prd-9 · major · List and one-pager disagree on the PRD's date
- Page: /simple/one-pagers, /simple/one-pagers/<doc>
- What: Dates contradict each other: the list says Saved carts PRD was "Updated Oct 18, 2026", while its one-pager says "Version 3 · Oct 20, 2026" (Usage alerts: list Oct 2, one-pager Oct 20).
- Steps: Open One-pagers and read a row's Updated date, then open that PRD and read the version date under the title.
- Expected: The same latest date in both places.

## qa4-simple-prd-10 · minor · Times disagree about today
- Page: /simple/one-pagers/<doc>
- What: Times disagree about today: a change made at 03:11 UTC on Oct 31 is stamped "Oct 30, 8:11 PM PT" while the timeline's line says "Today Oct 31".
- Steps: Edit a line in the evening Pacific time; compare the change card's time with the timeline's Today marker.
- Expected: Both use the same time zone, so today and the change's day agree.

## qa4-simple-prd-11 · minor · Needs a look points to sections that are not on the page
- Page: /simple/one-pagers/<doc>
- What: Needs a look points to sections that are not on the page: "In: Not this quarter" (the page calls it Not doing) and "In: Targets" (no Targets section); the lines are not clickable either.
- Steps: Open Saved carts PRD as owner and read Needs a look.
- Expected: Each problem names the section as it is labelled here and links/scrolls to the line it concerns.
- Related to an end-to-end finding (another lane may touch it): E2E step 7 One-pager: 'Needs a look' false positives naming sections ('In: Non-goals')

## qa4-simple-prd-12 · minor · Problem and who has it says who has it twice
- Page: /simple/one-pagers/<doc>
- What: Problem and who has it says who has it twice: the problem paragraph ends with "Admins of new teams with fewer than ten people." and the next line repeats "Who has it: Admins of new teams with fewer than ten people".
- Steps: Open any one-pager and read the first section.
- Expected: Who has it is shown once.

## qa4-simple-prd-13 · minor · A risk line shows an internal feature code
- Page: /simple/one-pagers/<doc>
- What: A risk line shows an internal feature code: "F-26 Calendar invites may slip past M1".
- Steps: Open Saved carts PRD > Risks and open decisions.
- Expected: The feature's name, without the code.

## qa4-simple-prd-14 · minor · Timeline milestone labels wrap mid-phrase at desktop width ("Milestone M1 · 12 roadmap /…
- Page: /simple/one-pagers/<doc>
- What: Timeline milestone labels wrap mid-phrase at desktop width ("Milestone M1 · 12 roadmap / items") although the bar area has room; on phone they fit on one line.
- Steps: Open any one-pager at 1440 or 1512 and look at Timeline.
- Expected: Label column wide enough for one line, or the count on its own small line.

## qa4-simple-prd-15 · minor · Timeline wording is mixed
- Page: /simple/one-pagers/<doc>
- What: Timeline wording is mixed: rows count "roadmap items", the footnote says "1 commitment with no milestone ends after Jan"; and the No milestone bar runs to the right edge with no end marker, so it is unclear which item ends when.
- Steps: Read the Timeline footnote and the No milestone row.
- Expected: One word for the items, and the late item's end shown (or the axis extended).

## qa4-simple-prd-16 · minor · Clicking Edit on a lower line opens the text box at the very bottom of the window (about y=870…
- Page: /simple/one-pagers/<doc>
- What: Clicking Edit on a lower line opens the text box at the very bottom of the window (about y=870 of 900) without scrolling it into view.
- Steps: Open Saved carts PRD at 1440x900, hover Not doing > Single sign-on setup, click Edit.
- Expected: The editor and its Save / Cancel are scrolled into view.

## qa4-simple-prd-17 · minor · The change card names the same person two ways
- Page: /simple/one-pagers/<doc>
- What: The change card names the same person two ways: "You changed ..." right after saving, "Admin changed ..." after a reload.
- Steps: Edit a line, read the rail card, reload, read it again.
- Expected: Always "You" for the signed-in person.

## qa4-simple-prd-18 · minor · See before/after shows the before and after twice (as Before:/After
- Page: /simple/one-pagers/<doc>
- What: See before/after shows the before and after twice (as Before:/After: lines and again as a struck-through diff box) and the link keeps saying See before/after once open.
- Steps: Edit a line, click See before/after in the rail.
- Expected: One before/after view; the link turns into Hide before/after.

## qa4-simple-prd-20 · minor · Proposal cards are written in the present tense
- Page: /simple/one-pagers/<doc>
- What: Proposal cards are written in the present tense: "You propose new wording ..." / "Commenter proposes new wording ...", unlike "Admin changed ...".
- Steps: As commenter click Propose wording on a line, Propose; read the rail card.
- Expected: "You proposed new wording ..." / "<Name> proposed ...".

## qa4-simple-prd-21 · minor · For people who see no Needs a look box (commenter, viewer, Present) the card keeps an empty…
- Page: /simple/one-pagers/<doc>
- What: For people who see no Needs a look box (commenter, viewer, Present) the card keeps an empty band of about 50 px above Problem and who has it.
- Steps: Sign in as commenter or viewer and open Saved carts PRD, or click Present.
- Expected: The first section starts at the card's normal top padding.

## qa4-simple-prd-22 · minor · Draw the flow draws immediately with no progress and no confirm, and the new flow is labelled…
- Page: /simple/one-pagers/<doc>
- What: Draw the flow draws immediately with no progress and no confirm, and the new flow is labelled "(revised)" and "Version 2" though it is the first flow drawn for that line.
- Steps: Saved carts PRD > Invite suggestions from the admin's calendar > Draw the flow.
- Expected: A short drawing state, then a flow titled after the line as Version 1.

## qa4-simple-prd-23 · minor · Export PDF gives no feedback for about 3 s, and the file is named for v3 ("Saved carts PRD v3…
- Page: /simple/one-pagers/<doc>
- What: Export PDF gives no feedback for about 3 s, and the file is named for v3 ("Saved carts PRD v3 one-pager.pdf") while an unapproved working draft exists, so the owner cannot tell which text is exported.
- Steps: Edit a line, then click Export PDF.
- Expected: A busy state on the button, and the file name or a note saying whether the draft or the published version was exported.

## qa4-simple-prd-25 · minor · The page intro reads like a spec, not a help line
- Page: /simple/one-pagers
- What: The page intro reads like a spec, not a help line: "Every PRD on one page: its plan and timeline, or its problem, bets, outcomes, what we will not do and risks."
- Steps: Open One-pagers.
- Expected: A plain sentence saying what a person can do here, e.g. "Open a PRD to read it on one page, edit it or start a review."

## qa4-simple-prd-26 · minor · Start review is shown, disabled, to viewers, who cannot take part in a review anyway
- Page: /simple/one-pagers/<doc>
- What: Start review is shown, disabled, to viewers, who cannot take part in a review anyway.
- Steps: Sign in as viewer@example.com and open a one-pager.
- Expected: Hide Start review for viewers.

## qa4-simple-prd-28 · minor · The Start review form names the PRD differently ("Usage alerts") from the page title and list…
- Page: /simple/one-pagers/<doc>
- What: The Start review form names the PRD differently ("Usage alerts") from the page title and list ("Usage alerts PRD"), and its disabled Start button has a dashed outline that looks like a placeholder rather than a button.
- Steps: As owner open Usage alerts PRD > Start review.
- Expected: The same PRD title everywhere; a disabled Start drawn like the other disabled buttons.

## qa4-simple-prd-30 · minor · Phone: the flow sheet closes with "Back" and the storyboard sheet with "Close"
- Page: /simple/one-pagers/<doc>
- What: Phone: the flow sheet closes with "Back" and the storyboard sheet with "Close"; the flow sheet shows two scroll bars side by side; the storyboard leaves most of the sheet blank under one step card.
- Steps: On a phone open the flow, then the storyboard, from Saved carts PRD.
- Expected: One close control wording, one scroll area, storyboard sized to its content.

## qa4-simple-prd-31 · minor · In the flow viewer, once Comment has opened full screen with the comments panel, Escape no…
- Page: /simple/one-pagers/<doc>
- What: In the flow viewer, once Comment has opened full screen with the comments panel, Escape no longer closes it; and the header Comment toggle and the panel's Comment submit button have the same name.
- Steps: Open the flow > Comment, press Escape twice.
- Expected: Escape closes the panel, then the viewer; the submit button reads e.g. Post comment.

## qa4-simple-prd-32 · minor · The flow's comments panel cites internal requirement codes
- Page: /simple/one-pagers/<doc>
- What: The flow's comments panel cites internal requirement codes: "From the PRD: Build section, Requirement R1".
- Steps: Open the flow > Comment, read the list.
- Expected: Cite the line in words ("From What we will build: A setup checklist ...").

## qa4-simple-prd-33 · minor · The flow viewer offers Comment to a viewer
- Page: /simple/one-pagers/<doc>
- What: The flow viewer offers Comment to a viewer.
- Steps: Sign in as viewer, open Saved carts PRD > Open the flow.
- Expected: No Comment for viewers (they cannot comment elsewhere on the page).

## qa4-simple-prd-34 · minor · Open the detailed view leaves Simple for /documents/<doc> in the same tab with no warning, and…
- Page: /simple/one-pagers/<doc>
- What: Open the detailed view leaves Simple for /documents/<doc> in the same tab with no warning, and the button looks like the other actions.
- Steps: Click Open the detailed view.
- Expected: Say it switches to Detailed (e.g. "Open in Detailed").

## qa4-simple-prd-35 · minor · Keyboard: every line has two Tab stops (the line, then its hidden Edit), so the rail's Undo /…
- Page: /simple/one-pagers/<doc>
- What: Keyboard: every line has two Tab stops (the line, then its hidden Edit), so the rail's Undo / Accept / Decline are only reached after 40+ Tabs, far from the line they belong to.
- Steps: Tab through Saved carts PRD from the top.
- Expected: One stop per line (Edit reachable from it), or the rail actions placed next to their line in Tab order.
