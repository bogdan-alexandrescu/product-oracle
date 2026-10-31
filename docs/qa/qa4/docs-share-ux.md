# QA pass 4 · Document sharing, reviews, specs, interviews · design changes (7)
Found on the mock app (invented data) at desktop 1512 and phone 390, train AD's build. Ids qa4-<area>-N.

## qa4-docs-share-2 · major · Share dialog reveals sharing blockers one at a time
- Page: /documents/usage-alerts-roadmap (Share a link)
- What: The Share dialog reveals what blocks sharing one problem at a time: first only the missing date basis, then after fixing it 'v1 is not approved yet', then 'approved but not published'.
- Steps: Owner: roadmap overview > Share a link with no date source set; fix it via Plan > Dates; reopen Share a link.
- Expected: All blockers listed together with a link to fix each one.
- Where: web/components/share/RoadmapSharing.tsx

## qa4-docs-share-4 · major · 'Publish' means approve on one page and publish on another
- Page: /documents/usage-alerts-roadmap + /publish
- What: 'Publish' means two things: the Publish page's 'Publish v1' only approves the version, and the Share dialog then says 'v1 is approved but not published yet' and asks for a second 'Publish v1'.
- Steps: Owner: roadmap > Publish v1 on the publish page; return to the roadmap > Share a link.
- Expected: One publish step, or two clearly different labels (Approve vs Publish for sharing).
- Where: web/components/PublishView.tsx; web/components/share/RoadmapSharing.tsx

## qa4-docs-share-14 · major · Commenter asked for feedback has no way to act from the overview
- Page: /documents/checkout-redesign
- What: A commenter asked for feedback in an open campaign (and named reviewer of an overdue section) gets no way to act from the overview: campaign rows and section rows are plain text, not links.
- Steps: Sign in as commenter > PRD overview > click 'Company-wide feedback' or '2. Problem'.
- Expected: Each campaign and the person's own section link to where they comment.
- Where: web/components/ReviewSetup.tsx:549

## qa4-docs-share-21 · minor · After publishing, a 'Not blocked' badge still sits beside 'Published v1', and nothing links…
- Page: /documents/usage-alerts-roadmap/publish
- What: After publishing, a 'Not blocked' badge still sits beside 'Published v1', and nothing links back to sharing.
- Steps: Owner: roadmap > Publish v1.
- Expected: Drop the badge once published and offer 'Share a link' next.
- Where: web/lib/blocked.ts:9

## qa4-docs-share-24 · minor · 'Allow PDF download' is on by default although the dialog warns a downloaded PDF can't be…
- Page: /documents/usage-alerts-roadmap (Share a link)
- What: 'Allow PDF download' is on by default although the dialog warns a downloaded PDF can't be revoked.
- Steps: Owner: open Share a link.
- Expected: Off by default, the safer choice.
- Where: web/components/share/RoadmapSharing.tsx:515

## qa4-docs-share-32 · minor · Saving Review settings gives no confirmation, and the overview shows nowhere who decides or…
- Page: /documents/checkout-redesign (Review settings)
- What: Saving Review settings gives no confirmation, and the overview shows nowhere who decides or who must review.
- Steps: Owner: Review settings > set a decider > Save.
- Expected: A saved note and a one-line summary on the overview.
- Where: web/components/ReviewSetup.tsx

## qa4-docs-share-53 · minor · After 'Accept risk' the blocker turns Pass and disappears
- Page: /documents/checkout-redesign/publish
- What: After 'Accept risk' the blocker turns Pass and disappears; the accepted risk, its reason and review-by date show nowhere (only a passing 'Risk accepted.').
- Steps: Owner: PRD Publish > Accept risk on the critical blocker.
- Expected: Keep the accepted risk visible with reason and date.
- Where: web/components/PublishView.tsx
