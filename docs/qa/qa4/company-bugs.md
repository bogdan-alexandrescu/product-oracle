# QA pass 4 · Detailed Home and Company · bugs (37)
Found on the mock app (invented data) at desktop 1512 and phone 390, train AD's build. Ids qa4-<area>-N.

## qa4-company-1 · major · Deleting a custom ritual: no confirm, no undo
- Page: /company/rituals
- What: Delete on a custom ritual removes it at once: no confirm, no undo, and its occurrences go with it.
- Steps: Rituals > Add ritual 'QA design sync' > select it > Delete. The row vanishes (Rituals 6 -> 5).
- Expected: A confirm naming the ritual (as Withdraw and Share have), or an Undo toast.
- Where: web/app/company/rituals/_components/RitualInspector.tsx:377

## qa4-company-3 · major · Metrics table cuts metric names to 'Ac…'
- Page: /company/metrics
- What: The Metrics table cuts the metric's name to 'Ac…' at 1440 wide, while columns of dashes keep their full width.
- Steps: Metrics > Add metric 'Activation rate' > save. The Metric column shows 'Ac…'.
- Expected: The name column gets the spare width (min ~200px); dash-only columns shrink.
- Where: web/app/company/metrics/page.tsx:87 (title column has no width; the other columns are fixed)

## qa4-company-4 · major · Recorded metric value not reflected on its linked goal
- Page: /company/metrics
- What: Numbers contradict after recording a value: the metric shows 41% last week but its linked goal still says '7 pts to go' (38% of 45%), though the form promised each weekly value becomes the goal's current value.
- Steps: Add metric linked to Raise activation > Record 41 for Week of Oct 19 > look at 'Goal and inputs' in the inspector and the Home goal tile.
- Expected: Goal current becomes 41% and '4 pts to go', or the form/inspector says why the goal does not take it (e.g. only the latest full week counts).
- Where: web/app/company/metrics/_components/MetricInspector.tsx

## qa4-company-5 · major · Add alternative accepts 'not a url' as Website
- Page: /company/market
- What: Add alternative accepts 'not a url' as the Website and shows it in the inspector as 'Website not a url'.
- Steps: Market > Add alternative > Name 'Spreadsheets', Website 'not a url' > Add alternative.
- Expected: Reject anything that is not an https:// address, as Watch a page already does ('Only https:// pages can be watched').
- Where: web/app/company/market/_components/Alternatives.tsx:453 (website sent unchecked), :494

## qa4-company-6 · major · Alternatives cannot be edited or archived
- Page: /company/market
- What: An alternative cannot be edited or archived once added: the inspector has no Edit, Rename or Archive, so a typo or wrong Kind/website stays forever.
- Steps: Add an alternative with a wrong website > select it > look for a way to fix it.
- Expected: Edit and Archive actions in the alternative inspector for approvers and owners.
- Where: web/app/company/market/_components/Alternatives.tsx:203-232

## qa4-company-7 · major · Vision shows 'Imported by API token draft-picker'
- Page: /company/strategy (vision page)
- What: A vision started from the template shows 'Imported by API token draft-picker', an internal token name, and calls an in-app draft 'Imported'.
- Steps: Strategy > New vision > Start from the empty template > open the vision; read Details in the right panel.
- Expected: 'Started by <person>' / 'Drafted by Oracle', never a token's name; 'Created' instead of 'Imported' for drafts made in the app.
- Where: web/components/DocumentOverview.tsx:166-177

## qa4-company-8 · minor · Propose decision lets you Remove every option, then only complains when you press Propose
- Page: /company/decisions
- What: Propose decision lets you Remove every option, then only complains when you press Propose.
- Steps: Propose decision > Remove both options > Propose.
- Expected: Remove is hidden or disabled at the minimum of two options.
- Where: web/app/company/decisions

## qa4-company-9 · minor · Pressing Propose on an empty form flags only the Decision field
- Page: /company/decisions
- What: Pressing Propose on an empty form flags only the Decision field; empty options and the missing approver are flagged one at a time on later tries.
- Steps: Propose decision > Propose with everything empty.
- Expected: Every missing required field is marked at once.
- Where: web/app/company/decisions

## qa4-company-10 · minor · Both option cards in Propose decision use the same Summary example 'Yearly plans from the…
- Page: /company/decisions
- What: Both option cards in Propose decision use the same Summary example 'Yearly plans from the first day', even under 'e.g. Monthly only'.
- Steps: Propose decision; compare the two option cards.
- Expected: Each option's examples match its own label (e.g. 'Billed each month').
- Where: web/app/company/decisions

## qa4-company-12 · minor · Withdraw and Reassign each show two buttons with the same label
- Page: /company/decisions
- What: Withdraw and Reassign each show two buttons with the same label: the action-row button stays and a second submit appears under the form.
- Steps: Select D-6 > Withdraw (or Reassign): 'Withdraw' appears twice, 'Reassign' twice.
- Expected: The row button turns into the open form, or the submit says 'Withdraw D-6' / 'Reassign to …'.
- Where: web/app/company/decisions

## qa4-company-15 · minor · The filter chips re-flow when the inspector opens or closes (From goes from two short rows to…
- Page: /company/decisions
- What: The filter chips re-flow when the inspector opens or closes (From goes from two short rows to one long one), so chips jump under the pointer.
- Steps: Pick Checkpoints (empty list, no inspector) then Judgement calls.
- Expected: Stable filter layout whether or not a decision is selected.
- Where: web/app/company/decisions

## qa4-company-16 · minor · 'Checkpoints' in the Kind filter says 'No checkpoint decisions.' while Home's Needs you lists…
- Page: /company/decisions
- What: 'Checkpoints' in the Kind filter says 'No checkpoint decisions.' while Home's Needs you lists a 'Checkpoint' waiting: one word, two things.
- Steps: Home shows Checkpoint 'Confirm the baseline'; Decisions > Checkpoints shows none.
- Expected: Different names, or the empty state explains that checkpoint approvals show here once decided.
- Where: web/app/company/decisions

## qa4-company-17 · minor · The 'Review' action on a decided decision does not say what it does (review the outcome?…
- Page: /company/decisions
- What: The 'Review' action on a decided decision does not say what it does (review the outcome? reopen?).
- Steps: Select D-3 (Decided) > Actions: Review, Reassign.
- Expected: A label such as 'Record the review' or 'Review the outcome'.
- Where: web/app/company/decisions

## qa4-company-18 · minor · A commenter sees an Edit button that does nothing, with the note 'Only its creator, its…
- Page: /company/decisions
- What: A commenter sees an Edit button that does nothing, with the note 'Only its creator, its approver or an owner edits a proposal'.
- Steps: Sign in as commenter > Decisions > D-6 (made by Admin).
- Expected: Hide Edit for people who cannot edit, or wording 'Only … can edit'.
- Where: web/app/company/decisions

## qa4-company-19 · minor · Ritual length and lead time are checked by the browser's own bubble ('Value must be greater…
- Page: /company/rituals
- What: Ritual length and lead time are checked by the browser's own bubble ('Value must be greater than or equal to 5'), not the app's inline errors, and a negative lead time (-3) is not flagged at the same time.
- Steps: Select a ritual > Length 0, Pre-read lead time -3 > Save.
- Expected: Inline messages under both fields in the app's voice.
- Where: web/app/company/rituals/_components/RitualInspector.tsx

## qa4-company-21 · minor · 'Times are in Pacific Time (Los Angeles), not set yet' reads as a contradiction (used and not…
- Page: /company/rituals
- What: 'Times are in Pacific Time (Los Angeles), not set yet' reads as a contradiction (used and not set).
- Steps: Open Rituals; read the line above the table and under Time in the inspector.
- Expected: 'Times use Pacific Time until you set the company time zone. Set it'.
- Where: web/app/company/rituals

## qa4-company-23 · minor · The occurrence header runs date, length, attendees, time zone and 'Data as of' together with…
- Page: /company/rituals/[occurrence]
- What: The occurrence header runs date, length, attendees, time zone and 'Data as of' together with only spaces between them.
- Steps: Rituals > Weekly goals check-in > Prepare now.
- Expected: Separators (·) or labelled items.
- Where: web/app/company/rituals

## qa4-company-27 · minor · In New vision, 'Start from the empty template' looks like a text link next to Cancel though it…
- Page: /company/strategy
- What: In New vision, 'Start from the empty template' looks like a text link next to Cancel though it creates a document.
- Steps: Strategy > New vision.
- Expected: A secondary button that reads as an action.
- Where: web/app/company/strategy

## qa4-company-30 · minor · New update pre-fills a title that is already taken ('Board update · October 2026') with no…
- Page: /company/updates
- What: New update pre-fills a title that is already taken ('Board update · October 2026') with no warning.
- Steps: Updates > New update > Board update.
- Expected: A unique default or a warning that an update with this title exists.
- Where: web/app/company/updates

## qa4-company-31 · minor · With 'The period starts after it ends' showing, 'Draft with Oracle · $9.00' stays enabled
- Page: /company/updates
- What: With 'The period starts after it ends' showing, 'Draft with Oracle · $9.00' stays enabled.
- Steps: New update > From 12/01/2026, To 10/30/2026.
- Expected: The paid button is disabled until the period is valid.
- Where: web/app/company/updates

## qa4-company-32 · minor · New pricing memo does not show what the Oracle run costs, while New update and New vision show…
- Page: /company/market
- What: New pricing memo does not show what the Oracle run costs, while New update and New vision show it on the button.
- Steps: Market > Pricing > New pricing memo.
- Expected: 'Draft with Oracle · $x' like the other drafting dialogs.
- Where: web/app/company/market/_components/NewPricingMemo.tsx

## qa4-company-33 · minor · The CSV import's file picker is the bare browser control 'Choose File No file chosen', which…
- Page: /company/market
- What: The CSV import's file picker is the bare browser control 'Choose File No file chosen', which reads as text.
- Steps: Market > Win and loss > Import.
- Expected: A styled 'Choose a CSV file' button showing the chosen name.
- Where: web/app/company/market/_components/ImportDialog.tsx

## qa4-company-34 · minor · Add win or loss: the Account placeholder 'Account 14' looks like a filled-in value, and the…
- Page: /company/market
- What: Add win or loss: the Account placeholder 'Account 14' looks like a filled-in value, and the required fields (Account, Decided on, Reason) are not marked.
- Steps: Market > Win and loss > Add.
- Expected: A clear example ('e.g. Acme Ltd') and 'required' marks, as Add metric has.
- Where: web/app/company/market/_components/DealDialog.tsx:111

## qa4-company-35 · minor · Add alternative: Name is not marked required and Kind defaults to 'Direct', so a spreadsheet…
- Page: /company/market
- What: Add alternative: Name is not marked required and Kind defaults to 'Direct', so a spreadsheet habit gets filed as a direct competitor.
- Steps: Market > Add alternative.
- Expected: Name marked required; Kind asks for a choice.
- Where: web/app/company/market/_components/Alternatives.tsx:429

## qa4-company-36 · minor · The 'Add alternative' header button stays on the Positioning tab, where it has nothing to do…
- Page: /company/market
- What: The 'Add alternative' header button stays on the Positioning tab, where it has nothing to do with the page.
- Steps: Market > Positioning.
- Expected: The header action matches the open sub-tab (or none).
- Where: web/app/company/market/page.tsx

## qa4-company-37 · minor · Editing one Positioning card stretches its row, leaving a tall empty neighbour
- Page: /company/market
- What: Editing one Positioning card stretches its row, leaving a tall empty neighbour; the Competitive alternatives card ignores the alternatives already added.
- Steps: Market > Positioning > Edit on Competitive alternatives (Spreadsheets exists).
- Expected: Edit in place without the empty gap, and offer the listed alternatives as a start.
- Where: web/app/company/market/_components/Positioning.tsx

## qa4-company-38 · minor · Add metric repeats its Goal placeholder 'Pick a unit to see goals measured in it' word for…
- Page: /company/metrics
- What: Add metric repeats its Goal placeholder 'Pick a unit to see goals measured in it' word for word as the help line under it.
- Steps: Metrics > Add metric.
- Expected: Say it once.
- Where: web/app/company/metrics/_components/MetricForm.tsx:307,320

## qa4-company-39 · minor · The Unit field in Add metric is a combobox with a '▼' glyph unlike every other select on the…
- Page: /company/metrics
- What: The Unit field in Add metric is a combobox with a '▼' glyph unlike every other select on the form.
- Steps: Metrics > Add metric; compare Unit with Kind and Good direction.
- Expected: The same control style as the other selects.
- Where: web/app/company/metrics/_components/MetricForm.tsx

## qa4-company-40 · minor · The metric inspector says 'Threshold
- Page: /company/metrics
- What: The metric inspector says 'Threshold: Default' without saying what the default is.
- Steps: Select a metric with no threshold.
- Expected: 'Default (x%)'.
- Where: web/app/company/metrics/_components/MetricInspector.tsx:146

## qa4-company-41 · minor · With one value the Weekly values chart is a lone dot in a corner and the caption reads 'Week…
- Page: /company/metrics
- What: With one value the Weekly values chart is a lone dot in a corner and the caption reads 'Week of Oct 19 to week of Oct 19. Shaded: the last 6 weeks.' while the shading sits apart from the dot.
- Steps: Record one value on a new metric.
- Expected: With one point show the value as text, or a chart that frames it.
- Where: web/app/company/metrics/_components/MetricChart.tsx

## qa4-company-42 · minor · On phone the metric row reads 'Last week 41% —' with an unlabeled dash for Change
- Page: /company/metrics
- What: On phone the metric row reads 'Last week 41% —' with an unlabeled dash for Change.
- Steps: Phone: Metrics with one recorded value.
- Expected: Label it ('No change yet') or drop it.
- Where: web/app/company/metrics/page.tsx

## qa4-company-45 · minor · A Needs you row reads 'Baseline proposal Team onboarding' with no separator, while others use…
- Page: /home
- What: A Needs you row reads 'Baseline proposal Team onboarding' with no separator, while others use ' · '.
- Steps: Home > Needs you > Checkpoint row.
- Expected: 'Baseline proposal · Team onboarding'.
- Where: web/app/home/page.tsx

## qa4-company-46 · minor · A question's context shows the section number
- Page: /home
- What: A question's context shows the section number: 'Online deposits at booking · 3. Risks'.
- Steps: Home > Needs you after answering the first question.
- Expected: '… · Risks' without the outline number.
- Where: web/app/home/page.tsx

## qa4-company-47 · minor · An answered question stays in Needs you as 'Answered ✓' and keeps its row, while the count…
- Page: /home
- What: An answered question stays in Needs you as 'Answered ✓' and keeps its row, while the count drops to 10.
- Steps: Home > Answer > type > Send answer.
- Expected: The row leaves (or the count and list agree until it does).
- Where: web/app/home/page.tsx

## qa4-company-50 · minor · On a narrow phone the Needs you header counts wrap and leave 'Questions 1' alone on a second…
- Page: /home
- What: On a narrow phone the Needs you header counts wrap and leave 'Questions 1' alone on a second line next to Inbox.
- Steps: iPhone SE: Home > Needs you header.
- Expected: Counts wrap as a group or move under the title.
- Where: web/app/home/page.tsx

## qa4-company-52 · minor · The selected-PRD panel's 'Sections ☐ Not reviewed 11' uses a checkbox as a legend
- Page: /home
- What: The selected-PRD panel's 'Sections ☐ Not reviewed 11' uses a checkbox as a legend; it looks clickable and is not.
- Steps: Home > PRD panel > Sections.
- Expected: A swatch-style legend, not a checkbox.
- Where: web/app/home/page.tsx

## qa4-company-53 · minor · The same PRD shows 'Open feedback 1' to the owner and '0' to a viewer with no hint the count…
- Page: /home
- What: The same PRD shows 'Open feedback 1' to the owner and '0' to a viewer with no hint the count is per person.
- Steps: Compare owner and viewer Home > PRD panel.
- Expected: Label it 'Your open feedback' or show the same total.
- Where: web/app/home/page.tsx
