# QA pass 4 · Documents (PRD pages) · bugs (47)
Found on the mock app (invented data) at desktop 1512 and phone 390, train AD's build. Ids qa4-<area>-N.

## qa4-docs-2 · major · Build draft dialog shows '0 of 0 staged' with nothing to tick
- Page: /documents/team-workspaces/v/2
- What: Build draft opens a dialog that says "0 of 0 staged" and "Tick at least one item." but lists no items to tick, so its Build button can never be used; only a small note says a run is under way.
- Steps: PRDs > Team workspaces PRD > Read latest > Build draft 3.
- Expected: Either list the feedback that can be staged (with checkboxes), or disable the header button with the reason ("A run is under way; build once it ends") instead of opening a dead-end dialog.

## qa4-docs-3 · major · Roadmap milestone cell: struck ISO date, cut 'Not in Nov' badge
- Page: /documents/checkout-redesign/v/2/roadmap
- What: In the roadmap table the Saved addresses milestone cell shows "2026-12-15" struck through followed by a badge cut to "Not in Nov", partly hidden under the Medium confidence pill.
- Steps: Checkout redesign PRD > v2 > Roadmap tab; look at row 4 "Saved addresses" (Milestone column). On phone the same row shows "GA 2026-12-15".
- Expected: The milestone shows a readable date ("Dec 15, 2026") and the whole "Not in Now" badge, with no overlap with the next column.

## qa4-docs-4 · major · Roadmap warning shows an internal item key and ISO date
- Page: /documents/checkout-redesign/v/2/roadmap
- What: The roadmap warning reads "Date unverified · Saved addresses: saved-addresses: 2026-12-15 has no verified schedule basis": an internal item key and an ISO date in a sentence for people.
- Steps: Checkout redesign PRD > v2 > Roadmap tab; read the yellow banner.
- Expected: "Saved addresses: the Dec 15, 2026 date has no confirmed schedule behind it yet." No item key, no ISO date.

## qa4-docs-5 · major · Roadmap summary counts disagree with the table groups
- Page: /documents/checkout-redesign/v/2/roadmap
- What: The roadmap summary and the table disagree: the strip says "4 items · 3 Now · 1 Next" while the table groups show Now 2, Next 1, Later 0, and a dropped item is drawn under "Later 0"; item numbers start at 2.
- Steps: Checkout redesign PRD > v2 > Roadmap tab (before Build again).
- Expected: The summary counts, the group counts and the rows tell the same story (e.g. "Later 0 · 1 dropped"), and numbering starts at 1 or is explained.

## qa4-docs-7 · major · Held rewrites says sections were approved; page says 0 approved
- Page: /documents/checkout-redesign/v/2
- What: Held rewrites says an agent "rewrote these approved sections" (1. Goal trace), yet the same page says 0 approved and 1. Goal trace "Not reviewed".
- Steps: Checkout redesign PRD > v2 > Held rewrites; compare with the outline and the Review card (0 Approved).
- Expected: Say which version approved the section ("approved in v1") or make the counts agree.

## qa4-docs-8 · major · 'No engineering spec yet' beside an 'Open spec' link
- Page: /documents/checkout-redesign
- What: The overview contradicts itself about specs: "Engineering specs — No full engineering spec yet" while the Tech briefs list has an "Open spec" link, and Delete warns that "Early shipping cost: engineering spec" goes to Trash with the PRD.
- Steps: PRDs > Checkout redesign PRD > Open; read Tech briefs and Engineering specs. Then PRDs list > ⋯ > Delete… on the same PRD.
- Expected: The engineering spec appears under Engineering specs (or the delete list and the link match what the overview says exists).

## qa4-docs-9 · major · Impact: 'nothing marked stale' beside 'Potentially stale'
- Page: /documents/checkout-redesign/v/2/impact
- What: Impact says "Preview: nothing has been marked stale" while the same page shows "Potentially stale", "1/1 Dependencies stale" and "Stale since Oct 19".
- Steps: Checkout redesign PRD > v2 > Impact; click the affected tech brief (Table view).
- Expected: One consistent statement: either nothing is stale yet (and no 'stale since' date), or the banner says one output is already marked stale.

## qa4-docs-10 · major · Compare allows the same version on both sides
- Page: /documents/checkout-redesign/diff
- What: Compare lets you pick the same version on both sides and then shows "Changes from v2 to v2 · 11 unchanged" next to "Pick two versions" and "No differences".
- Steps: Checkout redesign PRD > v2 > Compare with v1; set From to v2.
- Expected: The From/To pickers can't pick the same version (or swap automatically), so the page never contradicts itself.

## qa4-docs-11 · major · Suggestion's proposed text shows raw markdown
- Page: /documents/team-workspaces/v/2
- What: A suggestion's proposed text shows raw markdown: "Three fixed roles: **owner**, **editor** and **viewer**."
- Steps: Team workspaces PRD > v2 > Review panel > the "Three fixed roles" suggestion (Go to 2. Roles).
- Expected: Proposed text is rendered (bold words) or shown as plain text without asterisks.

## qa4-docs-12 · major · 'Duplicate … resolved with it' card still Open with Accept/Dismiss
- Page: /documents/team-workspaces/v/2
- What: An Oracle card says "Duplicate of an earlier item; resolved with it." but the item is still Open with Accept and Dismiss buttons.
- Steps: Team workspaces PRD > v2 > Review panel > second item ("Can we quantify the demand…").
- Expected: A duplicate already resolved is shown as resolved/Done (or the card says it will be resolved when the other is).

## qa4-docs-13 · major · Evidence says 'citations only' for rows with none
- Page: /documents/checkout-redesign/v/2/evidence
- What: Evidence > Sections says "citations only" as the weakest support for rows with 0 links and 0 citations (the Introduction row and 5. Proposed flow), so it contradicts "6 sections unsupported".
- Steps: Checkout redesign PRD > v2 > Evidence > Sections.
- Expected: A row with no links and no citations says "none"/"unsupported" (or explains it inherits support from subsections).

## qa4-docs-14 · major · 'End campaign' closes an open feedback campaign without confirm
- Page: /documents/checkout-redesign
- What: "End campaign" closes the open feedback campaign immediately, with no confirmation, while people are still being asked for feedback.
- Steps: PRDs > Checkout redesign PRD > Open > Feedback campaigns > End campaign.
- Expected: Ask to confirm ("End Company-wide feedback? 2 of 4 took part") or offer Undo.

## qa4-docs-15 · major · 'Ask Oracle to review' gives no sign anything happened
- Page: /documents/checkout-redesign/v/2/quality
- What: "Ask Oracle to review" gives no sign anything happened: the button just turns dashed/disabled and the banner still says "No model review for v2 yet."
- Steps: Checkout redesign PRD > v2 > Quality > Ask Oracle to review.
- Expected: A visible state ("Oracle is reviewing v2… started 8:35 PM") with progress or a link to the run.

## qa4-docs-16 · major · Composition offers 'Publish revision 1' when it is already in force
- Page: /documents/checkout-redesign/composition
- What: Composition offers "Publish revision 1" while the header already says "Revision 1 in force" and "Confirmed revision 1", and "Use these modules" opens "Confirm revision 2" even though it shows "No change".
- Steps: Checkout redesign PRD > Composition; read the header, then press Use these modules.
- Expected: Buttons say what they do in this state (e.g. "Pin revision 1 to an approved version"); confirming an identical revision is not offered, or is disabled with "Nothing changed".

## qa4-docs-18 · minor · Evidence shows unexplained scores
- Page: /documents/checkout-redesign/v/2/evidence
- What: Evidence shows unexplained scores: "Impl 0.78" / "Impl 0.66" chips in Coverage and "0.66" as Weakest in Sections.
- Steps: Checkout redesign PRD > v2 > Evidence (Coverage, then Sections).
- Expected: Words people understand ("Strong link", "Medium link") matching the legend; no bare decimals or "Impl".

## qa4-docs-19 · minor · The Sources tab shows raw scores ("Slack · 0.82", "Meeting notes · 0.35") and cuts source…
- Page: /documents/checkout-redesign/v/2
- What: The Sources tab shows raw scores ("Slack · 0.82", "Meeting notes · 0.35") and cuts source titles short ("Custo…", "Q4 goals: activation a…") in a wide panel.
- Steps: Checkout redesign PRD > v2 > Review panel > Sources.
- Expected: A confidence word (or no score), and titles that wrap to two lines instead of being cut.

## qa4-docs-20 · minor · Oracle's push-back cites "Evidence: Roles research notes · confidence 0.82"
- Page: /documents/team-workspaces/v/2
- What: Oracle's push-back cites "Evidence: Roles research notes · confidence 0.82": a bare model score.
- Steps: Team workspaces PRD > v2 > "Three fixed roles" suggestion > Oracle pushes back.
- Expected: "strong evidence" or no score.

## qa4-docs-21 · minor · The changed-sections banner names the section by its internal key
- Page: /documents/team-workspaces/v/2
- What: The changed-sections banner names the section by its internal key: "Sections approved in v1 changed in this version: scope".
- Steps: Team workspaces PRD > v2; read the yellow banner.
- Expected: "…changed in this version: 3. Scope".

## qa4-docs-22 · minor · Held rewrites shows the section's anchor slug in code type ("1. Goal trace #goal-trace")
- Page: /documents/checkout-redesign/v/2
- What: Held rewrites shows the section's anchor slug in code type ("1. Goal trace #goal-trace").
- Steps: Checkout redesign PRD > v2 > Held rewrites.
- Expected: Only the section name.

## qa4-docs-23 · minor · The Regenerate dialog's estimate lists "Saved carts PRD (saved-carts), its latest version", an…
- Page: /documents
- What: The Regenerate dialog's estimate lists "Saved carts PRD (saved-carts), its latest version", an internal slug, and shows the price in a monospace font with slashed zeros ("$18.00").
- Steps: PRDs > ⋯ on Saved carts PRD > Regenerate… > Estimate.
- Expected: "Saved carts PRD, latest version (v2)" and the price in the normal type.

## qa4-docs-24 · minor · In Regenerate, "Start run" is disabled with a dashed outline until you press Estimate, and…
- Page: /documents
- What: In Regenerate, "Start run" is disabled with a dashed outline until you press Estimate, and nothing says why.
- Steps: PRDs > ⋯ > Regenerate…; try Start run.
- Expected: A hint next to the button ("Estimate the cost first"), or estimate automatically when the dialog opens.

## qa4-docs-25 · minor · Dialogs dismiss with an unstyled 'Back' instead of 'Cancel'
- Page: /documents
- What: Dialogs use "Back" as their cancel button (Regenerate, Delete) though there is nothing to go back to.
- Steps: PRDs > ⋯ > Regenerate… or Delete….
- Expected: "Cancel".

## qa4-docs-26 · minor · The Delete dialog says "The draft run that created one of these" will go to Trash without…
- Page: /documents
- What: The Delete dialog says "The draft run that created one of these" will go to Trash without saying which run or which item.
- Steps: PRDs > ⋯ on Checkout redesign PRD > Delete….
- Expected: Name the run ("The run of Oct 17 that wrote the engineering spec").

## qa4-docs-27 · minor · With no ideas, the Ideas tab still draws the table header (Idea / Author / Questions /…
- Page: /documents
- What: With no ideas, the Ideas tab still draws the table header (Idea / Author / Questions / Created) above the empty message.
- Steps: PRDs > Ideas (on a fresh mock).
- Expected: Only the empty state with its action.

## qa4-docs-28 · minor · "Imported by: An integration" doesn't say which integration
- Page: /documents/checkout-redesign
- What: "Imported by: An integration" doesn't say which integration.
- Steps: PRDs > Checkout redesign PRD > Open; Details panel.
- Expected: The integration's name (e.g. "Notion import").

## qa4-docs-30 · minor · "Potentially stale" and "Stale" tech-brief badges look identical (same amber pill)
- Page: /documents/checkout-redesign
- What: "Potentially stale" and "Stale" tech-brief badges look identical (same amber pill).
- Steps: PRDs > Checkout redesign PRD > Open > Tech briefs.
- Expected: Stale reads stronger than potentially stale (colour or icon).

## qa4-docs-31 · minor · The Export menu offers "Full · PDF · HTML · MD"
- Page: /documents/checkout-redesign/v/2
- What: The Export menu offers "Full · PDF · HTML · MD": "MD" (Markdown) means nothing to most readers.
- Steps: Checkout redesign PRD > v2 > Export.
- Expected: "Markdown (.md)" or "Text for docs tools".

## qa4-docs-32 · minor · Two "Request changes" buttons sit one above the other once the note box opens (the toggle and…
- Page: /documents/checkout-redesign/v/2
- What: Two "Request changes" buttons sit one above the other once the note box opens (the toggle and the dashed, disabled send button).
- Steps: Checkout redesign PRD > v2 > Request changes.
- Expected: The send button says "Send request" (or the toggle hides).

## qa4-docs-33 · minor · Escape doesn't close the inline Discuss form or the Held rewrites panel, unlike every dialog…
- Page: /documents/checkout-redesign/v/2
- What: Escape doesn't close the inline Discuss form or the Held rewrites panel, unlike every dialog and menu.
- Steps: Checkout redesign PRD > v2 > Discuss (or Held rewrites); press Esc.
- Expected: Esc closes it (Cancel/Close).

## qa4-docs-35 · minor · Review progress is worded three ways
- Page: /documents/saved-carts/v/2
- What: Review progress is worded three ways: "0 of 11 reviewed", "0 of 8 brief sections reviewed", "0 of 20 sections reviewed"; in brief mode the Review card also wraps "Open feedback" onto a second row.
- Steps: Saved carts PRD > v2 (Brief, then Full); compare with Checkout redesign v2.
- Expected: One wording and one-row card in all modes.

## qa4-docs-36 · minor · With the outline collapsed, the progress shows a bare "0/6" over a bar (the word "reviewed" is…
- Page: /documents/clinic-outreach/v/5
- What: With the outline collapsed, the progress shows a bare "0/6" over a bar (the word "reviewed" is screen-reader only).
- Steps: Any PRD version > Hide outline; look at the strip.
- Expected: "0 of 6 reviewed" visible.

## qa4-docs-37 · minor · On a phone the bottom bar's "Sections · 2/11" is the section's position, while everywhere else…
- Page: /documents/checkout-redesign/v/2
- What: On a phone the bottom bar's "Sections · 2/11" is the section's position, while everywhere else "1/11" means sections reviewed.
- Steps: Phone: Checkout redesign PRD > v2; compare the bottom bar with the Sections sheet ("1 of 11 reviewed").
- Expected: "Section 2 of 11" or show reviewed count.

## qa4-docs-39 · minor · Feedback items show only an initial avatar ("R") to other people, with no name
- Page: /documents/checkout-redesign/v/2
- What: Feedback items show only an initial avatar ("R") to other people, with no name; the owner sees "Me".
- Steps: Sign in as viewer or commenter > Checkout redesign PRD > v2 > Review panel.
- Expected: The author's name next to the avatar.

## qa4-docs-40 · minor · For a viewer or commenter, the block panel shows a "Risk" heading with nothing under it…
- Page: /documents/checkout-redesign/publish
- What: For a viewer or commenter, the block panel shows a "Risk" heading with nothing under it (Accept risk is hidden).
- Steps: Sign in as viewer > Checkout redesign PRD > Publish (Check readiness).
- Expected: Hide the empty section or say "Only approvers can accept a risk".

## qa4-docs-41 · minor · Advisory status chips are inconsistent
- Page: /documents/checkout-redesign/publish
- What: Advisory status chips are inconsistent: Pass has a tick icon, Warning, Critical and N/A have none.
- Steps: Checkout redesign PRD > Publish; Advisory list.
- Expected: Same treatment for all statuses.

## qa4-docs-42 · minor · The rating's Sections picker labels the Introduction with the PRD's title ("Checkout redesign…
- Page: /documents/checkout-redesign/v/2/quality
- What: The rating's Sections picker labels the Introduction with the PRD's title ("Checkout redesign PRD") — as do Evidence > Sections and Composition's outline — and the section you pick isn't shown on the saved rating.
- Steps: Checkout redesign PRD > v2 > Quality > Your rating > Sections; pick one, submit.
- Expected: "Introduction", and the saved rating lists its sections.

## qa4-docs-44 · minor · The lineage box under "Changed sections" says "Success metrics — Section of Checkout redesign…
- Page: /documents/checkout-redesign/v/2/impact
- What: The lineage box under "Changed sections" says "Success metrics — Section of Checkout redesign PRD v1" on a page about what v2 changed.
- Steps: Checkout redesign PRD > v2 > Impact (Lineage).
- Expected: "Section changed in v2" (with its number, "7. Success metrics").

## qa4-docs-46 · minor · "Approved plan" in Compared with is disabled but looks like a normal button
- Page: /documents/checkout-redesign/v/2/roadmap
- What: "Approved plan" in Compared with is disabled but looks like a normal button; the reason is only in a hover title.
- Steps: Checkout redesign PRD > v2 > Roadmap.
- Expected: Disabled styling and a visible note ("No approved roadmap yet").

## qa4-docs-47 · minor · After Build again the table is rebuilt at once, yet the banner says "Queued. Oracle starts…
- Page: /documents/checkout-redesign/v/2/roadmap
- What: After Build again the table is rebuilt at once, yet the banner says "Queued. Oracle starts deriving within a minute." ("deriving" is jargon) and the Compared-with block disappears.
- Steps: Checkout redesign PRD > v2 > Roadmap > Build again.
- Expected: The status matches what is shown ("Rebuilt just now" or keep the old table until it's done).

## qa4-docs-48 · minor · On a phone, roadmap cards show "Depends on — —" (two dashes), and the refresh checkbox's info…
- Page: /documents/checkout-redesign/v/2/roadmap
- What: On a phone, roadmap cards show "Depends on — —" (two dashes), and the refresh checkbox's info icon sits alone on its own line.
- Steps: Phone: Checkout redesign PRD > v2 > Roadmap.
- Expected: One dash; the info icon stays beside its label.

## qa4-docs-49 · minor · The "Unchanged" checkbox-button doesn't say what it does (its accessible name is "Show…
- Page: /documents/checkout-redesign/diff
- What: The "Unchanged" checkbox-button doesn't say what it does (its accessible name is "Show unchanged sections"), and the removed "8. Rollout" is listed between 6 and 7.
- Steps: Checkout redesign PRD > Compare with v1.
- Expected: Label "Show unchanged"; removed sections at their old place or at the end.

## qa4-docs-50 · minor · Module and blocker numbers run 1–5, 7, 6
- Page: /documents/checkout-redesign/composition
- What: Module numbers run 1–5, 7, then 6 under Suggested, and the Selection column repeats the group heading ("Required" under Required).
- Steps: Checkout redesign PRD > Composition.
- Expected: Numbers in reading order; drop the redundant column.

## qa4-docs-52 · minor · "Keep my call" on a pushed-back suggestion opens "Accept anyway"
- Page: /documents/team-workspaces/v/2
- What: "Keep my call" on a pushed-back suggestion opens "Accept anyway": keeping your call means accepting the suggestion, which reads backwards; "Dismiss suggestion" vs "Dismiss and decline the feedback" are also hard to tell apart.
- Steps: Team workspaces PRD > v2 > "Three fixed roles" > Keep my call; Clinic outreach v5 > Dismiss.
- Expected: Labels that name the outcome ("Accept custom roles anyway", "Dismiss, keep feedback open").

## qa4-docs-53 · minor · Answered tech-brief question still tagged 'Blocking'
- Page: /briefs/<id>
- What: A tech-brief question answered "Yes, prices change at most hourly" is still tagged "Blocking"; the next reads "Not answered at the Engineering check" (odd capital).
- Steps: Checkout redesign PRD > Open > Tech briefs > Show the full price early > Questions.
- Expected: Answered questions lose the Blocking tag (or show "Was blocking · answered").

## qa4-docs-54 · minor · If the problem text is too short, the banner says "To continue, say what problem it solves."…
- Page: /documents/new
- What: If the problem text is too short, the banner says "To continue, say what problem it solves." though you did; the 20-character minimum is only in the hint.
- Steps: PRDs > New PRD; type a title and "short" as the problem; Continue.
- Expected: "Say a bit more about the problem (at least 20 characters)."

## qa4-docs-56 · minor · The Coverage matrix's last visible column header is cut mid-word ("6. Risks ar… open…
- Page: /documents/checkout-redesign/v/2/evidence
- What: The Coverage matrix's last visible column header is cut mid-word ("6. Risks ar… open questions") at the right edge.
- Steps: Checkout redesign PRD > v2 > Evidence > Coverage at 1440 px.
- Expected: A fade/shadow over the scroll edge, or a sticky narrower layout so headers aren't sliced.

## qa4-docs-58 · minor · The brief Summary says "It serves G2 (retention)"
- Page: /documents/saved-carts/v/2
- What: The brief Summary says "It serves G2 (retention)": a goal code shown to readers.
- Steps: Saved carts PRD > v2 (Brief) > Summary.
- Expected: "It serves the retention goal."
