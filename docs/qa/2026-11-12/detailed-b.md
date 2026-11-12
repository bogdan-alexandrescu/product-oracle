# Visual QA findings: Detailed Runs, Priorities, Inbox, Company (rituals), Settings (members, connections, trash), sign-in and error pages

Built from main e5431e8 with `npm run build:mock` and served with `npm run start:mock -p 3393`. I drove it with Playwright (headless Chromium, mock clock at 2026-10-22T12:00Z) at 1440x900 and 390x844, in light and dark.

- **Scenarios used:** default, `empty`, `large`, `long-title`, `rituals`, `scope-review`, `eng-check`, `eng-dates`, `eng-review`, `feature-set`, `baseline-review`, `run-review`, `priority-order`, `run-decisions`, plus a viewer sign-in.
- **Screenshots:** in `shots/`, named `<state>--<theme>-<width>.png`.
- **Overflow checks:** an automated check on every shot found no sideways scroll and nothing past the viewport at either width.
- **Console:** no console errors apart from the expected 404 on the not-found page.
- **Full-page shots:** in these, the fixed side nav, the phone tab bar and sticky decision bars appear mid-page. That is a capture artifact, and I checked it in viewport shots (`16e-*`); it is not reported.

## Findings

| # | Sev | Page and state | Theme / width | What is wrong | Screenshot | Likely file:line | Recommended fix |
|---|---|---|---|---|---|---|---|
| 1 | major | Priorities, at rest and with a row selected | all | Features appear by name only: in the table, Depends on, the Cycle banner, the inspector's "Moved for" chip, and the Move dialog title. The codes (F-1…F-8) are in the data (`key`) but are never shown, which breaks "every feature shows its code with its name". | 20-priorities--light-1440.png, 20-priorities--light-390.png, 24-priorities-move-down--light-1440.png | web/app/priorities/page.tsx:242 (`featureText`, "never its code (qa-plan-17)"); row title cell; _components/overrides.tsx (sheet title) | Show "F-5 Address lookup service" everywhere through the shared `named()/namedText` helper the goal column already uses. This reverses qa-plan-17, so the owner should confirm (see questions.json). |
| 2 | major | Run detail, Priority order checkpoint (priority-order scenario) | all | The blocking problem reads "F-2 is ranked 1, above F-5 (rank 2), which it depends on", and its row label is a bare "F-2". These are codes with no names. | 15-priority-order-run1--light-1440.png | api/oracle/priorities/run_order.py:331 (message); web/lib/api/mock/runs.ts:1472 (mock copy); problem row in web/app/runs/_run-detail.tsx (gate problems, near :2652) | Build the message from `known.features` as "F-2 Usage alerts is ranked 1, above F-5 Address lookup service (rank 2), which it depends on", and label the row "F-2 Usage alerts". Needs a red pytest first and the mock updated to match. |
| 3 | major | Feature set checkpoint review (scope-review), Engineering check, Engineering dates | all | Feature rows and the inspector show names without codes ("Bulk edit", "Address labels", "Pick address in one …"). Engineering check shows a raw key "ƒ.guided-setup" instead of a code. Engineering dates items have no code. | 16-scope-review-run1-review1--light-1440.png, 16-eng-check-run1-review1--light-1440.png, 16-eng-dates-run2-review1--light-1440.png | web/app/runs/[id]/review/[checkpoint]/_scope-review.tsx (row title), _scope-inspector.tsx (header), _eng-review.tsx (feature header with key), _eng-dates.tsx (item cell) | Show code + name on each row and inspector header. Where a proposed feature has no code yet, keep the existing "New, not in the Ground Truth" flag rather than showing a key. |
| 4 | major | Priorities row ⋯ "More actions"; Feature set "Answered" ✓ and other ✓ marks on checkpoint pages | all | Text glyphs ⋯ and ✓ draw as empty boxes (tofu) in Chromium here. The row's only path to Move above / Pin at… looks like a broken square. The repo already notes this hazard in _eng-dates.tsx:327. | 20b-priorities-rowactions-zoom--light-1440.png, 16b-scope-answered-zoom--light-1440.png | web/app/priorities/_components/overrides.tsx:277 (⋯); web/components/review/AgentQuestions.tsx:155 (✓); ✓ text in _scope-review.tsx:640, _scope-inspector.tsx:258/546/625, _items-review.tsx:600/615 | Use `<Icon name="more" />` for ⋯ (as _eng-dates.tsx does) and a check Icon in place of the ✓ character. |
| 5 | major | Runs list, header badge "3 runs need a decision" (and the viewer's "3 runs waiting on others") | all | The count is plain text and does not lead to the runs it counts. With the `large` scenario's 55 runs, the 13 that need a decision are scattered through the list. | 10-runs--light-1440.png, 14-large-runs--light-1440.png, 95-viewer-runs--dark-390.png | web/app/runs/page.tsx:250 (and :254) | Make the badge a toggle that filters the list to those runs, with a clear-filter control, matching the Members stat links. |
| 6 | major | Priorities header chips "8 ranked", "1 no goal", "2 in a cycle" | all | The counts are plain chips with no way to reach the counted features. | 20-priorities--light-1440.png | web/app/priorities/page.tsx:1524-1527 | Make each chip filter or highlight its rows ("1 no goal" leads to Dark mode, "2 in a cycle" to rows 4-5). |
| 7 | major | Ritual occurrence pre-read (Monthly roadmap refresh, `rituals` scenario) | all | Tracks ("Usage alerts PRD: at risk, 2 at risk"), Potentially stale items ("Digest emails") and Priority changes ("Usage alerts: #5→#2") are plain text. Their counts and features lead nowhere and features show no code. In the same page family, Goals and Needs a decision are links. | 82-occurrence2--dark-1440.png, 82-occurrence2--light-1440.png | web/app/company/rituals/_components/MetricBlocks.tsx (Tracks, Stale, Priority changes blocks) | Link each track to its PRD or roadmap and each "N at risk" to those items. Show features as code + name linking to the feature panel. |
| 8 | minor | Ritual occurrence summary (Weekly goals check-in after Summarize) | all | The written summary of a goals check-in is headed "Monthly roadmap refresh — summary" with roadmap content. The mock returns one fixed text for every kind except the metrics review. | 83-occurrence1-summarize--light-1440.png | web/lib/api/mock/rituals.ts:722 (`SUMMARY_TEXT`) | Key the mock summary by ritual kind (goals check-in, roadmap refresh, …) so each occurrence reads like its own summary. |
| 9 | minor | Settings › Connections, GitHub and Google Docs cards | all | The same need has two buttons: "Connect with GitHub" and "Add another account". After Add another account opens the token form, Connect with GitHub still sits under it. Slack and Notion show only "Add another account". | 51-settings-connections--light-1440.png, 68-connections-add-account--light-1440.png | web/app/settings/connections/ConnectionsSettings.tsx:191 | Use one entry per provider ("Add another account" opening a choice of sign-in or token), and hide the other while the form is open. **Needs a design choice.** |
| 10 | minor | Settings › Connections, Google Docs old-drive row | all | Two (i) icons sit side by side after the status chip. | 51-settings-connections--light-1440.png | web/app/settings/connections/ConnectionsSettings.tsx (row status / tip) | Merge them into one InfoTip. |
| 11 | minor | Settings › Connections header "7 connected" | all | The count chip is plain text (the cards below are the items). | 51-settings-connections--light-1440.png | web/app/settings/connections/page.tsx | Make it a link that scrolls to the first card, or drop the chip. |
| 12 | minor | Settings › Members, Open invites: Revoke | light 1440 | Revoke removes the invite at once with no confirmation, toast or Undo, unlike Remove member, which offers Undo. | 66-members-revoke--light-1440.png | web/components/MembersSettings.tsx (open-invites list, ~1250) | Show the same undo toast used for Remove (`memberActs.mark`). |
| 13 | minor | Settings › Members, invite rows | all | Actions are misaligned: "Resend" sits alone on one line, and "Copy link · Revoke" on the next with a different indent. | 50-settings-members--light-1440.png, 62-members-invite-sent--light-1440.png | web/components/MembersSettings.tsx (~1250-1300) | Put Resend, Copy link and Revoke on one row with the same button style. |
| 14 | minor | Settings › Members table | light/dark 1440 | Member emails break at "@" ("admin@ / example.com") in a narrow Member column while Last sign-in and Tokens have spare room. | 50-settings-members--light-1440.png | web/components/MembersSettings.tsx (people table column widths) | Widen the Member column or truncate the email with a title. |
| 15 | minor | Priorities ▲/▼ move: "Move …" dialog | light/dark 1440 | On desktop it opens as a full-width bottom sheet with its content centred. Other desktop confirmations on these pages (Delete PRD, Change role) are centred modals. | 24-priorities-move-down--light-1440.png | web/app/priorities/_components/overrides.tsx:451 (`Sheet`) | Use the centred dialog above 600 px, keeping the sheet on phones. **Needs a design choice** if the sheet was picked. |
| 16 | minor | Company › Rituals, ritual selected | all | The company time zone notice and its "Set it" link appear twice: above the table and again in the panel. | 41-rituals--light-1440.png | web/app/company/rituals/page.tsx:240 and _components/RitualInspector.tsx | Keep only the line above the table (the code comment says "named once", qa-company-21). |
| 17 | minor | Company › Rituals › Add ritual | all | Two lines of prose under the Title field ("Type a title…" and "It starts every Monday at 9:00 AM … once it is added"). | 81-ritual-add-dialog--light-1440.png | web/app/company/rituals/page.tsx (add form) | Put the defaults sentence behind an (i) InfoTip. |
| 18 | minor | Ritual occurrence page back link | all | It reads "←Rituals" with no gap. The Runs pages use an arrow icon with a gap ("← Runs"). | 83-occurrence1-summarize--light-1440.png | web/app/company/rituals/_components/OccurrenceDetail.tsx:135 | Use the same back-link component and icon as run detail. |
| 19 | minor | Feature set checkpoint, Questions from the agents | all | The same sentence ("Not answered by the time you decide: Priority order goes with the agent's pick.") repeats under every question card, on top of a header sentence. | 16-scope-review-run1-review1--light-1440.png, 16-scope-review-run1-review1--dark-390.png | web/components/review/AgentQuestions.tsx:269 | Say it once in the header InfoTip and keep only "Why they ask" on each card. |
| 20 | minor | Run detail, Paused: over budget | all | One state is said four times: status pill, a full-width banner "Paused: over budget. Resume or cancel it.", the Segments header and the inspector. | 12-run3--light-1440.png | web/app/runs/_run-detail.tsx (paused banner) | Drop the banner; the pill and the Resume / Cancel run buttons already say it. |
| 21 | minor | Settings › Trash, empty | all | The link reads "Open Documents", but the nav and the page it opens are called "PRDs". | 55-settings-trash--light-1440.png | web/app/settings/trash/page.tsx:217 | Rename it to "Open PRDs". |

Checked with nothing to report:

- Sign-in: empty, wrong password, phone.
- Not-found pages: app, settings, run.
- Run list: empty and large.
- Run states: cost approval, waiting for review, succeeded.
- Engineering dates.
- Inbox: all tabs, Answer, Approve access.
- Members: invite validation and success, role-change dialog, viewer view.
- Connections: Disconnect confirm.
- Trash: delete dialog, item, restore toast.
- Rituals: list, panel, Prepare now, summaries toggle.
- Priorities: RICE, Oracle's order, snapshot.
- Dark-mode contrast of the selected segments (dark text on light blue, good).

**Not covered:** the app's error boundary (`app/error.tsx`, `global-error.tsx`). The Detailed mock offers no way to make a page throw through the UI, so it was not captured.

## Counts
- blocker: 0
- major: 7
- minor: 14

## Lanes (no shared files)
| Lane | Findings | Files |
|---|---|---|
| L1 priorities | 1, 6, 15, 4 (⋯ part) | web/app/priorities/page.tsx, web/app/priorities/_components/overrides.tsx |
| L2 checkpoint reviews | 3, 4 (✓ part), 19 | web/app/runs/[id]/review/[checkpoint]/*, web/components/review/AgentQuestions.tsx |
| L3 run-order problems (API + run detail) | 2, 20 | api/oracle/priorities/run_order.py (+ pytest), web/lib/api/mock/runs.ts, web/app/runs/_run-detail.tsx |
| L4 runs list | 5 | web/app/runs/page.tsx |
| L5 rituals | 7, 8, 16, 17, 18 | web/app/company/rituals/**, web/lib/api/mock/rituals.ts |
| L6 settings | 9, 10, 11, 12, 13, 14, 21 | web/app/settings/connections/*, web/components/MembersSettings.tsx, web/app/settings/trash/page.tsx |
