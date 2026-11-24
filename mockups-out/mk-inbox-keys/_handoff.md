# mk-inbox-keys: what the Inbox has today (read on the mock app, Nov 24, 2026)

- One Inbox for Simple (/simple/inbox) and Detailed (/inbox): the same page (app/inbox/_inbox.tsx) in each shell.
- Panel "Needs you N"; state tabs New, Seen, Staged, Declined, Done, each with its count; the rail's Inbox badge counts New + Seen.
- Rows: kind (icon + word), item (feature code with name, e.g. "F-112 Rep daily scoreboard"), For, age ("5w", "now"), the row's own buttons
  (Review, Approve, Resume / Cancel run, Approve / Decline with a role pick, Open). Rows are grouped by kind, one table each.
- Each row draws only what the person's role can do; another role's item says who decides ("Owners decide") under For your information.
- An action's result shows in a banner above the rows with Undo (useActed); a decided access request moves to Done or Declined at once.
- A question opens in place under its row (its answer form); Dates rows open the feature panel (Open).
- No keyboard moves, no focused row, no key hints, no snooze anywhere. No "Snoozed" tab.
- Phone 390: tabs keep one line, rows stack; buttons keep 32 px targets.
