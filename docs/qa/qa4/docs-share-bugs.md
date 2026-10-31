# QA pass 4 · Document sharing, reviews, specs, interviews · bugs (50)
Found on the mock app (invented data) at desktop 1512 and phone 390, train AD's build. Ids qa4-<area>-N.

## qa4-docs-share-1 · blocker · Review settings: Escape in the picker discards every unsaved pick
- Page: /documents/checkout-redesign (Review settings)
- What: In Review settings, pressing Escape to close the 'Add a mandatory reviewer' picker closes the whole sheet and throws away every unsaved pick (decider, required sections) with no warning.
- Steps: Owner: PRD overview > Review settings; pick a decider and tick required sections; open 'Add a mandatory reviewer'; press Escape; reopen Review settings.
- Expected: Escape closes only the picker; the sheet and its picks stay (or the sheet asks before discarding changes).
- Where: web/components/ReviewSetup.tsx

## qa4-docs-share-3 · major · Publishing a roadmap shows PRD wording and PRD checks
- Page: /documents/usage-alerts-roadmap/publish
- What: Publishing a roadmap shows PRD wording: 'On publish: PRD status set to Approved', and the advisory checks are PRD quality checks (Problem and user clarity, ...). The confirm dialog says the same.
- Steps: Owner: roadmap overview > Publish (or open /documents/usage-alerts-roadmap/publish from the roadmap).
- Expected: Roadmap wording and checks that apply to a roadmap ('Roadmap status set to Published').
- Where: web/components/PublishView.tsx

## qa4-docs-share-5 · major · Phone shared roadmap: theme cards stay 3 columns ~107 px wide
- Page: /s/<token>
- What: On a phone, the shared roadmap's theme cards stay in a 3-column grid about 107px wide, so every word wraps on its own line and most of the screen is empty.
- Steps: Owner: create a share link, open it signed out on a 390px phone.
- Expected: Cards stack in one column on narrow screens.
- Where: api/oracle/templates/builtin/themes/roadmap-board.css:3 (no @media rule)

## qa4-docs-share-6 · major · Share View log says UTC but shows PDT; day header wrong
- Page: /documents/usage-alerts-roadmap (View log)
- What: The share link's View log says 'Times in UTC (Company time zone)' but every row is in PDT, and the day header reads 'Oct 31, 2026' above rows that all say Oct 30.
- Steps: Owner: roadmap overview > Share links > View log.
- Expected: One time zone named and used consistently; day headers that match the rows under them.
- Where: web/components/share/RoadmapSharing.tsx:894,901,916

## qa4-docs-share-7 · major · 'Extend · 24 hours from now' silently shortens a longer link
- Page: /documents/usage-alerts-roadmap (Extend)
- What: 'Extend' with '24 hours from now' quietly shortened a link that ran to Nov 13 so it ends Oct 31; nothing warns and the dialog never shows the resulting end date.
- Steps: Owner: roadmap > Share links > Extend on a link ending Nov 13 > 24 hours from now > Extend.
- Expected: Show the new end date, and hide or warn about options earlier than the current end.
- Where: web/components/share/RoadmapSharing.tsx (Extend dialog)

## qa4-docs-share-8 · major · Wireframes banner shows a raw <img> tag and internal wording
- Page: /specs/<spec>/design/<version>
- What: The Side by side wireframes view shows a banner with a raw HTML tag and internal wording: 'Sanitised: Oracle removed <img> with a remote src from Cart 2 when it stored it.'
- Steps: Owner: spec version > wireframes design > Side by side.
- Expected: Plain words, e.g. 'An image from another website was removed from Cart 2 for safety.'
- Where: web/components/DesignReview.tsx:312

## qa4-docs-share-9 · major · Public version guide stuck on step 1; real blocker not named
- Page: /documents/usage-alerts-roadmap/public
- What: The Public version guide 'Next, step 1 of 3: Approve at least one item's public text' never moves on: approving Behaviour's text still leaves '0 items on the public page' because every item is 'Left out: serves no confirmed goal', and the page never says to link items to a goal. 'Draft public texts' answers that every item serving a goal already has text (none do).
- Steps: Owner: roadmap > Check public text > Approve Behaviour's text.
- Expected: The guide names the real blocker (items need a confirmed goal) and links to where to set it.
- Where: web/app/documents/[doc]/public

## qa4-docs-share-11 · major · Advisory check Pass contradicts the hard check's open critical blocker
- Page: /documents/checkout-redesign/publish
- What: Advisory check '5 Blocker and feasibility resolution: Pass' sits beside the hard check 'Critical blockers: 1 open, Fail' with a Critical blocker listed; the two contradict.
- Steps: Owner: PRD overview > Publish.
- Expected: The advisory check agrees with the hard check while a critical blocker is open.
- Where: web/components/PublishView.tsx

## qa4-docs-share-12 · major · 'Ask for feedback' accepts a due date in the past
- Page: /documents/checkout-redesign
- What: 'Ask for feedback' accepts a due date two months in the past (Sep 1) and sends the campaign; the row then reads 'Open · due Sep 1'.
- Steps: Owner: PRD overview > Feedback campaigns > Ask for feedback > due date Sep 1 > Send.
- Expected: Past due dates are refused or warned about.
- Where: web/components/ReviewSetup.tsx

## qa4-docs-share-13 · major · 'Assign' only expands the sections list
- Page: /documents/checkout-redesign (Section owners)
- What: In Section owners and reviewers, the 'Assign' button only expands the list (and becomes 'Hide'); the '9 more sections with no owner' line stays even when they are all shown.
- Steps: Owner: PRD overview > Section owners and reviewers > Assign.
- Expected: Label says what it does ('Show 9 sections'), and the count line updates once they are shown.
- Where: web/components/ReviewSetup.tsx:372

## qa4-docs-share-15 · minor · One version shows dates three ways
- Page: /documents/<doc>
- What: One version shows dates three ways: Versions table 'Imported Oct 2, 1:00 AM PDT', details 'Approved Oct 3, 2026', preview 'Imported Oct 4, 2026', with a time-zone abbreviation on some only.
- Steps: Owner: open any document overview.
- Expected: One date format per page.

## qa4-docs-share-16 · minor · The empty Share links card says 'Use Share above' but the button is called 'Share a link'
- Page: /documents/usage-alerts-roadmap
- What: The empty Share links card says 'Use Share above' but the button is called 'Share a link'.
- Steps: Owner: roadmap overview with no share links.
- Expected: Name the actual button.
- Where: web/components/share/RoadmapSharing.tsx

## qa4-docs-share-17 · minor · The roadmap's Versions table shows State 'Latest' where PRDs show 'Approved'
- Page: /documents/usage-alerts-roadmap
- What: The roadmap's Versions table shows State 'Latest' where PRDs show 'Approved'; the same column means different things.
- Steps: Owner: compare Versions tables on roadmap and PRD overviews.
- Expected: Same column, same meaning.

## qa4-docs-share-18 · minor · The Share dialog calls it 'schedule basis' while Plan > Dates calls the same thing 'date…
- Page: /documents/usage-alerts-roadmap (Share a link)
- What: The Share dialog calls it 'schedule basis' while Plan > Dates calls the same thing 'date source' / 'Add a date source'.
- Steps: Owner: Share a link on a roadmap without dates; compare with Plan > Dates.
- Expected: One name for one thing.
- Where: web/components/share/RoadmapSharing.tsx

## qa4-docs-share-19 · minor · Opening a dialog or panel adds a scrollbar and shifts the layout
- Page: all dialogs
- What: Opening any dialog adds a page scrollbar, shifting the header buttons and the rail about 15px sideways.
- Steps: Owner: roadmap > Share a link (or any dialog) on desktop.
- Expected: No layout shift when a dialog opens (scrollbar-gutter: stable).

## qa4-docs-share-20 · minor · 'Hard checks 3' is shown in the accent colour though all three are N/A, so it reads as three…
- Page: /documents/usage-alerts-roadmap/publish
- What: 'Hard checks 3' is shown in the accent colour though all three are N/A, so it reads as three problems.
- Steps: Owner: roadmap > Publish.
- Expected: Count only checks that apply, or show it neutral.
- Where: web/components/PublishView.tsx:734

## qa4-docs-share-22 · minor · The breadcrumb says 'Approved' while the page says 'Published' for the same state
- Page: /documents/usage-alerts-roadmap/publish
- What: The breadcrumb says 'Approved' while the page says 'Published' for the same state.
- Steps: Owner: publish a roadmap and look at breadcrumb vs page.
- Expected: One word.

## qa4-docs-share-23 · minor · 'Add a label first.' shows as an error before the person has typed anything
- Page: /documents/usage-alerts-roadmap (Share a link)
- What: 'Add a label first.' shows as an error before the person has typed anything.
- Steps: Owner: open Share a link.
- Expected: Show it only after a try to create without a label.
- Where: web/components/share/RoadmapSharing.tsx:384

## qa4-docs-share-25 · minor · Download PDF on a shared link always saves a file called 'roadmap.pdf', with no roadmap name…
- Page: /s/<token>
- What: Download PDF on a shared link always saves a file called 'roadmap.pdf', with no roadmap name or date.
- Steps: Open a share link signed out > Download PDF.
- Expected: File named after the roadmap and date.
- Where: web/components/share/SharedRoadmap.tsx:108

## qa4-docs-share-26 · minor · On a phone the shared page's title wraps to two lines beside Download PDF and a line starts…
- Page: /s/<token>
- What: On a phone the shared page's title wraps to two lines beside Download PDF and a line starts with an orphan '· Link ends'.
- Steps: Open a share link on a 390px phone.
- Expected: Title and Download stack cleanly; no line starts with a separator.
- Where: web/components/share/SharedRoadmap.tsx

## qa4-docs-share-27 · minor · View log says '6 views · 1 browser' while its rows list both Safari and Chrome, and a PDF…
- Page: /documents/usage-alerts-roadmap (View log)
- What: View log says '6 views · 1 browser' while its rows list both Safari and Chrome, and a PDF download is counted as a view.
- Steps: Owner: Share links > View log.
- Expected: Counts that match the rows; downloads counted separately.
- Where: web/components/share/RoadmapSharing.tsx

## qa4-docs-share-28 · minor · On a phone a share link row reads 'Team v1 Nov 13, 2026 6 Active' with no labels, so '6' and…
- Page: /documents/usage-alerts-roadmap (Share links)
- What: On a phone a share link row reads 'Team v1 Nov 13, 2026 6 Active' with no labels, so '6' and the date mean nothing; the Versions row shows a lone '–'.
- Steps: Owner: roadmap overview on a 390px phone.
- Expected: Label the numbers on phone ('Ends Nov 13 · 6 views').
- Where: web/components/share/RoadmapSharing.tsx

## qa4-docs-share-29 · minor · The Revoke dialog says the link 'stops working on its next request' (developer wording)
- Page: /documents/usage-alerts-roadmap (Revoke)
- What: The Revoke dialog says the link 'stops working on its next request' (developer wording).
- Steps: Owner: Share links > Revoke.
- Expected: 'stops working right away'.
- Where: web/components/share/RoadmapSharing.tsx:827

## qa4-docs-share-30 · minor · After revoking, the Share links header counts 0 while the revoked row is still listed
- Page: /documents/usage-alerts-roadmap (Share links)
- What: After revoking, the Share links header counts 0 while the revoked row is still listed; the row shows no reason, who revoked or when, and still shows an end date.
- Steps: Owner: revoke a link with reason 'Meeting moved'.
- Expected: Count matches the list (or 'Active 0 · Revoked 1'); row shows revoked by/when/reason.
- Where: web/components/share/RoadmapSharing.tsx

## qa4-docs-share-31 · minor · Opening a revoked link with its correct passcode says 'That passcode did not open a link
- Page: /s/<token>
- What: Opening a revoked link with its correct passcode says 'That passcode did not open a link. Check it and the address', blaming the passcode, instead of 'This link has ended'.
- Steps: Revoke a passcode link, then open it signed out and enter the right passcode.
- Expected: Say the link was revoked/ended.
- Where: web/components/share/SharedRoadmap.tsx:45

## qa4-docs-share-33 · minor · Review settings shows an unexplained 'Default policy' pill, and its Save/Cancel scroll away…
- Page: /documents/checkout-redesign (Review settings)
- What: Review settings shows an unexplained 'Default policy' pill, and its Save/Cancel scroll away with the content on a 900px-tall window.
- Steps: Owner: open Review settings at 1440x900.
- Expected: Explain the pill; pin the footer.
- Where: web/components/ReviewSetup.tsx:32

## qa4-docs-share-34 · minor · A section due date in the past is accepted silently (Oct 1 becomes 'Overdue Oct 1'), while an…
- Page: /documents/checkout-redesign (Section owners)
- What: A section due date in the past is accepted silently (Oct 1 becomes 'Overdue Oct 1'), while an existing past date 'Due Oct 24' is not marked overdue.
- Steps: Owner: Section owners > edit a section > due Oct 1 > Save.
- Expected: Warn on past dates; mark all past dates overdue the same way.
- Where: web/components/ReviewSetup.tsx

## qa4-docs-share-36 · minor · An open campaign 'due Oct 26' (past) shows no overdue cue
- Page: /documents/checkout-redesign
- What: An open campaign 'due Oct 26' (past) shows no overdue cue.
- Steps: Owner: PRD overview > Feedback campaigns.
- Expected: Mark it overdue.
- Where: web/components/ReviewSetup.tsx:549

## qa4-docs-share-37 · minor · In the same card group, 'Edit', 'Assign' and 'End campaign' are plain text buttons while 'Ask…
- Page: /documents/checkout-redesign
- What: In the same card group, 'Edit', 'Assign' and 'End campaign' are plain text buttons while 'Ask for feedback' is bordered.
- Steps: Owner: PRD overview.
- Expected: One button style for equal actions.
- Where: web/components/ReviewSetup.tsx:555

## qa4-docs-share-38 · minor · A new campaign shows '0 of 0 took part' although the form says everyone who can comment is…
- Page: /documents/checkout-redesign
- What: A new campaign shows '0 of 0 took part' although the form says everyone who can comment is asked (the other campaign shows 2 of 4).
- Steps: Owner: Ask for feedback > Send.
- Expected: Show the real number asked.
- Where: web/components/ReviewSetup.tsx:549

## qa4-docs-share-40 · minor · Comment boxes and the Details drawer show file names
- Page: /specs/<spec>/design/<version>
- What: Comment boxes and the Details drawer show file names: 'Comment on annotation 1 of cart-1.html', 'cart-1.html'.
- Steps: Owner: spec design > wireframes > Comment.
- Expected: Use the file's title ('Cart 1').
- Where: web/components/DesignReview.tsx:759

## qa4-docs-share-41 · minor · Commenting on an annotation bumps 'Reviews 0 → 1' while Version reviews still says no reviews
- Page: /specs/<spec>/design/<version>
- What: Commenting on an annotation bumps 'Reviews 0 → 1' while Version reviews still says no reviews; after 'Request changes' with no note, the 'Add a note…' error stays after later actions.
- Steps: Owner: spec design > comment on an annotation; click Request changes without a note, then comment again.
- Expected: Reviews count only verdicts; the error clears when the person moves on.
- Where: web/components/DesignReview.tsx

## qa4-docs-share-42 · minor · The status pills (User flow / In review / Potentially stale) repeat in the page header and the…
- Page: /specs/<spec>/design/<version>
- What: The status pills (User flow / In review / Potentially stale) repeat in the page header and the review panel header right beside each other.
- Steps: Owner: spec design > Review the design.
- Expected: Show them once.
- Where: web/components/DesignReview.tsx:485

## qa4-docs-share-43 · minor · The Version panel's 'Depends on' shows a staleness sentence on flows and the PRD on wireframes
- Page: /specs/<spec>/design/<version>
- What: The Version panel's 'Depends on' shows a staleness sentence on flows and the PRD on wireframes: the label doesn't match what follows.
- Steps: Owner: spec design > Review the design > Version panel.
- Expected: 'Depends on' always lists what it depends on; staleness shown as its own line.
- Where: web/components/DesignReview.tsx

## qa4-docs-share-44 · minor · The same object is called 'technical brief' (page title, design back-links) and 'spec' (PRD…
- Page: /documents/<spec>/v/2
- What: The same object is called 'technical brief' (page title, design back-links) and 'spec' (PRD overview 'Open spec').
- Steps: Owner: PRD overview > Open spec; then open a design page.
- Expected: One name.

## qa4-docs-share-46 · minor · What it touches shows enum values side by side
- Page: /briefs/<id>
- What: What it touches shows enum values side by side: 'Kind Module · Change Change', 'Change New'.
- Steps: Open any tech brief.
- Expected: Readable wording ('Changes an existing module').
- Where: web/app/briefs/_brief-detail.tsx

## qa4-docs-share-47 · minor · The public check's 'To approve 0' filter says nothing is left while both items show Missing…
- Page: /documents/usage-alerts-roadmap/public
- What: The public check's 'To approve 0' filter says nothing is left while both items show Missing and Approve buttons.
- Steps: Owner: roadmap > Check public text.
- Expected: The count matches the items waiting.

## qa4-docs-share-48 · minor · An item's 'Approve' opens the same editor as 'Edit' (two controls, one action), and Stage…
- Page: /documents/usage-alerts-roadmap/public
- What: An item's 'Approve' opens the same editor as 'Edit' (two controls, one action), and Stage defaults to 'Exploring' for a Now item.
- Steps: Owner: Check public text > Approve on Behaviour.
- Expected: Approve approves; Stage defaults from the horizon.

## qa4-docs-share-49 · minor · The preview footer reads 'Preview
- Page: /documents/usage-alerts-roadmap/public
- What: The preview footer reads 'Preview: a shared link's page shows when it was shared and when it ends here' – garbled.
- Steps: Owner: Check public text, scroll to preview.
- Expected: 'On a shared link, this shows when it was shared and when it ends.'

## qa4-docs-share-50 · minor · For a viewer the locked page shows 'Back to the roadmap' twice, as the top link and as the…
- Page: /documents/usage-alerts-roadmap/public
- What: For a viewer the locked page shows 'Back to the roadmap' twice, as the top link and as the only button.
- Steps: Viewer: roadmap > /public.
- Expected: One way back.

## qa4-docs-share-52 · minor · For one blocker, 'Resolve' goes to /baseline?entity=… while the side panel's 'Open blocker'…
- Page: /documents/checkout-redesign/publish
- What: For one blocker, 'Resolve' goes to /baseline?entity=… while the side panel's 'Open blocker' goes to /baseline?tab=blockers…: two controls, two places.
- Steps: Owner: PRD Publish > Critical blockers.
- Expected: One control to one place.
- Where: web/components/PublishView.tsx

## qa4-docs-share-54 · minor · The disabled 'Publish v2' only explains itself in a hover tooltip '1 block'
- Page: /documents/checkout-redesign/publish
- What: The disabled 'Publish v2' only explains itself in a hover tooltip '1 block'.
- Steps: Owner: PRD Publish with an open blocker.
- Expected: Visible text saying what blocks it.
- Where: web/components/PublishView.tsx

## qa4-docs-share-55 · minor · For a viewer the page header says 'Not blocked' while the Advisory section shows '1 critical'
- Page: /documents/checkout-redesign/publish
- What: For a viewer the page header says 'Not blocked' while the Advisory section shows '1 critical'.
- Steps: Viewer: PRD > Publish on a phone.
- Expected: Explain advisory criticals don't block, or don't call it 'critical'.
- Where: web/lib/blocked.ts

## qa4-docs-share-56 · minor · Viewers get a filled primary 'Review the design' button that opens a read-only panel headed…
- Page: /specs/<spec>/design/<version>
- What: Viewers get a filled primary 'Review the design' button that opens a read-only panel headed 'Design review · viewing as viewer' (raw role name).
- Steps: Viewer: spec design > Review the design.
- Expected: 'Open the review' for read-only roles; plain 'You can read this review'.
- Where: web/components/DesignReview.tsx:485

## qa4-docs-share-57 · minor · Headers show internal template and theme names
- Page: /documents/usage-alerts-roadmap + /documents/checkout-redesign
- What: Document headers show internal names in pills: 'Template: Now / Next / Later · Theme: Roadmap board', 'Template: Goal-traced PRD'.
- Steps: Open any document overview.
- Expected: Hide template/theme or move it into the details panel.

## qa4-docs-share-58 · minor · In dark mode the audience preview stays a bright white page inside the dark console
- Page: /documents/usage-alerts-roadmap
- What: In dark mode the audience preview stays a bright white page inside the dark console.
- Steps: Owner: roadmap overview in dark theme.
- Expected: A dimmed or dark-aware preview frame.

## qa4-docs-share-59 · minor · In the interview chat, a skipped question stays in the transcript with no 'Skipped' marker
- Page: /i/<token>
- What: In the interview chat, a skipped question stays in the transcript with no 'Skipped' marker; the next question follows straight on.
- Steps: Open an interview link signed out > Start > answer > Skip this question.
- Expected: Mark skipped questions.
- Where: web/app/i/[token]/_chat.tsx:230

## qa4-docs-share-60 · minor · Enter adds a new line and only Ctrl/Cmd+Enter sends, with no hint shown
- Page: /i/<token>
- What: Enter adds a new line and only Ctrl/Cmd+Enter sends, with no hint shown.
- Steps: Type an answer and press Enter.
- Expected: A hint under the box ('Ctrl+Enter to send').
- Where: web/app/i/[token]/_chat.tsx:121

## qa4-docs-share-61 · minor · After finishing, reopening the link shows 'Interview' as the header (not the company) and…
- Page: /i/<token>
- What: After finishing, reopening the link shows 'Interview' as the header (not the company) and 'This link has already been used' to the person who just finished it.
- Steps: Finish an interview, then reload the link.
- Expected: Keep the company name; say 'You've finished this interview, thank you'.
- Where: web/app/i/[token]/_chat.tsx:139

## qa4-docs-share-63 · minor · The interview page tells the owner 'Send it to them if you haven't' while the link can't be…
- Page: /requests/interviews/<id>
- What: The interview page tells the owner 'Send it to them if you haven't' while the link can't be shown or copied again.
- Steps: Owner: Requests > Interviews > Ana Lima.
- Expected: 'If you didn't send it, make a new link.'
- Where: web/app/requests/interviews/[id]/_detail.tsx:261
