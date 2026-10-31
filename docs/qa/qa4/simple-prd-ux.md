# QA pass 4 · Simple one-pagers · design changes (8)
Found on the mock app (invented data) at desktop 1512 and phone 390, train AD's build. Ids qa4-<area>-N.

## qa4-simple-prd-4 · major · Viewers/commenters told '2 changes in review' but cannot see them
- Page: /simple/one-pagers/<doc>
- What: A viewer or commenter sees "2 changes in review · you read the published version" but nothing on the page lets them see what the changes are (no Changes and proposals rail, no link).
- Steps: Owner edits a line and submits for review; commenter proposes wording; sign in as viewer and open Saved carts PRD.
- Expected: The banner links to (or the rail lists) the changes in review, or the banner says they will appear once approved.

## qa4-simple-prd-6 · major · Present mode shows unapproved edits and proposals highlighted to the audience
- Page: /simple/one-pagers/<doc>
- What: Present mode shows the owner's unapproved edit and a pending proposal highlighted in yellow and blue to the audience, with no legend saying what the colours mean.
- Steps: Edit a Not doing line, have a commenter propose wording on another, then Present.
- Expected: Presenting shows either the published text or the working draft without editing highlights, and says which it is.

## qa4-simple-prd-7 · major · Submit for review sends at once with no confirm or reviewer choice
- Page: /simple/one-pagers/<doc>
- What: Submit for review sends the draft at once, with no confirmation and no choice of reviewer, and then says "waiting on review from Approver", a role label rather than a person.
- Steps: Edit a line on Saved carts PRD, click Submit for review in the yellow banner.
- Expected: A short confirm that names who will review (by name) and lets the owner pick or change them; the banner names the person.
- Where: web/lib/api/mock/simple-one-pager.ts:510
- Note: may be the mock's data, not the product: fix the mock if the mock is wrong, else say so and skip.

## qa4-simple-prd-8 · major · 'Submit for review' and 'Start review' read as one action
- Page: /simple/one-pagers/<doc>
- What: Two buttons look like they do one thing: "Submit for review" in the draft banner and "Start review" in the header; nothing says that one asks reviewers to approve the edit and the other books a review meeting.
- Steps: Edit a line, then compare the banner's Submit for review and the header's Start review.
- Expected: Labels that say what happens, e.g. "Send edits for approval" and "Start a review meeting".

## qa4-simple-prd-19 · minor · Once a draft is submitted, the change card loses its Undo and nothing else offers to withdraw…
- Page: /simple/one-pagers/<doc>
- What: Once a draft is submitted, the change card loses its Undo and nothing else offers to withdraw the submission or a single change.
- Steps: Edit a line, Submit for review, look at the change card.
- Expected: A way to withdraw the submission or the change, or a line saying it can no longer be undone and why.

## qa4-simple-prd-24 · minor · "Newest first" in the PRDs card header looks like a sort control but is plain text
- Page: /simple/one-pagers
- What: "Newest first" in the PRDs card header looks like a sort control but is plain text; and the rows do not show that a PRD has a working draft or proposals waiting.
- Steps: Open One-pagers after editing Saved carts PRD.
- Expected: Either a real sort menu or a quieter caption; a small marker on PRDs with changes waiting.

## qa4-simple-prd-27 · minor · Phone, owner: the draft banner wraps to four lines (about 130 px) before the title
- Page: /simple/one-pagers/<doc>
- What: Phone, owner: the draft banner wraps to four lines (about 130 px) before the title.
- Steps: As owner on a 390 px phone, edit a line, Submit for review, Remind; open the one-pager.
- Expected: A one- or two-line banner, details behind a tap.

## qa4-simple-prd-29 · minor · An owner can Edit a line that has a commenter's proposal waiting, with no hint that saving…
- Page: /simple/one-pagers/<doc>
- What: An owner can Edit a line that has a commenter's proposal waiting, with no hint that saving will bypass or conflict with the proposal.
- Steps: Commenter proposes wording on A mobile setup flow; as owner click Edit on the same line.
- Expected: The editor mentions the waiting proposal (or offers Accept with changes).
