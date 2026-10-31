# QA pass 4 · Settings, account, access, set-up · bugs (38)
Found on the mock app (invented data) at desktop 1512 and phone 390, train AD's build. Ids qa4-<area>-N.

## qa4-settings-1 · major · Connections says '0 connected' while sources sync
- Page: /settings/connections, /home (Set up)
- What: Connections says "0 connected" and Home's Set up says "Connect tools: None", yet Sources lists active Slack, GitHub, Google Docs and Fireflies sources that are syncing.
- Steps: Sign in as the owner; open Home and look at Set up; open Settings > Connections; open Settings > Sources.
- Expected: Connections and the Set up step should count the tools that the active sources already use, or say why they don't count.
- Where: app/settings/connections; Home Set up checklist

## qa4-settings-2 · major · Set up says '3 sources read' while Sources shows 6
- Page: /home (Set up), /settings/sources
- What: Set up's "Pick sources" says "3 sources read" while Sources shows "My sources 6".
- Steps: Open Home as the owner and read Pick sources; press Change; count the rows on Sources.
- Expected: One number for the same sources, or a label that says what the 3 are (for example, read in the last sync).
- Where: Home Set up checklist

## qa4-settings-4 · major · Company domains step lands at the top of Sources
- Page: /home (Set up) -> /settings/sources
- What: The Company domains step opens Sources at the top of the page; the domains section is about 1,100 px further down with nothing pointing to it.
- Steps: Home > Set up > Company domains > Open.
- Expected: Land scrolled to (and highlighting) the domains section.
- Where: Set up step link (anchor lost on navigation)

## qa4-settings-6 · major · Sources with lost access still read 'Active'
- Page: /settings/sources
- What: Sources marked "Active" also show "Lost access", "No access" or "Reconnect to choose files", but the header counts only "1 needs attention".
- Steps: Open Settings > Sources; read Product docs and Drive folders; compare with the header chips.
- Expected: A source with lost access should not read Active; the header count should include every source that needs a person.
- Where: app/settings/sources

## qa4-settings-7 · major · Expired-token source error offers only Sync now
- Page: /settings/sources
- What: Example repo shows "Error: The connection was rejected: token expired" but offers only Sync now, which can't fix an expired token; there's no Reconnect or new-token action.
- Steps: Open Settings > Sources; find Example repo (GitHub).
- Expected: A Reconnect / Paste a new token button next to the error, as Drive folders has.
- Where: app/settings/sources

## qa4-settings-9 · major · Owner's role shown twice on Members
- Page: /settings/members
- What: The owner's row shows "Owner" twice in the Role column: a pill and a disabled "Owner" button.
- Steps: Settings > Members; look at Admin's row.
- Expected: Show the role once; if it can't be changed, say why in a tooltip.
- Where: components/MembersSettings.tsx

## qa4-settings-13 · major · Change-role dialog shows internal wording
- Page: /settings/members
- What: The change-role dialog shows internal wording: "Decides document reviews needs Approver · 1".
- Steps: Settings > Members > Approver > change the role to Commenter.
- Expected: Plain words, for example: "Approver can no longer decide 1 document review."
- Where: components/MembersSettings.tsx

## qa4-settings-18 · major · Theme preview unreadable and shows raw citation tokens
- Page: /settings/themes
- What: The theme preview is a tiny, unreadable thumbnail, and it shows raw citation tokens ("c1: funnel export").
- Steps: Settings > Themes > select a theme; look at the preview.
- Expected: A preview large enough to judge the type, with sample text and no citation tokens.
- Where: app/settings/themes
- Related to an end-to-end finding (another lane may touch it): E2E step 7 One-pager: raw [c:cN] citation tokens leak to readers

## qa4-settings-20 · major · Dark mode: unchecked checkboxes look checked (grey squares)
- Page: /settings/members (and other forms)
- What: In dark mode, unchecked checkboxes render as filled grey squares that look checked.
- Steps: Switch to dark; Settings > Members > Engineering lead picker.
- Expected: An unchecked box is an outline; checked is filled.
- Where: checkbox styles in dark theme

## qa4-settings-25 · major · Failed webhook test shows raw '✕ connect'
- Page: /settings/webhooks
- What: A failed test send shows the raw error code "✕ connect", and "Oracle tries again in a minute" for a one-off test.
- Steps: Send test event to a webhook whose host can't be reached.
- Expected: "Couldn't reach hooks.example.com" and a way to try again; no automatic retry note on a test.
- Where: app/settings/webhooks/NewWebhookSheet.tsx:150; WebhookInspector

## qa4-settings-44 · major · Autonomy 'Lowest confidence' is a bare decimal; 90 accepted
- Page: /settings/autonomy
- What: Raising a responsibility to Act asks for "Lowest confidence" as a bare decimal (0.9) with no scale; typing 90 is accepted and Save stays enabled.
- Steps: Settings > Autonomy > Triage requests > Act; type 90 in Lowest confidence and a reason.
- Expected: A percent field (90 %) or a slider, with values outside the range refused.
- Where: app/settings/autonomy/AutonomySettings.tsx

## qa4-settings-3 · minor · "Invite team: 4 people · 2 invited" counts as invited two invites that have both expired…
- Page: /home (Set up)
- What: "Invite team: 4 people · 2 invited" counts as invited two invites that have both expired (Members shows 0 open).
- Steps: Open Home's Set up; open Settings > Members and look at the invites.
- Expected: Say the invites expired and offer to send them again, or don't count them.
- Where: Home Set up checklist

## qa4-settings-5 · minor · The Build baseline step's Review opens /baseline with no "Back to Home" link
- Page: /home (Set up) -> /baseline
- What: The Build baseline step's Review opens /baseline with no "Back to Home" link; the other Set up steps have one.
- Steps: Home > Set up > Build baseline > Review.
- Expected: The same way back to Home that the other steps have.
- Where: Set up step link

## qa4-settings-10 · minor · Member emails break mid-address
- Page: /settings/members
- What: Emails in the People table wrap mid-word ("admin@example" / ".com").
- Steps: Settings > Members at 1440 px.
- Expected: Keep the email on one line, or truncate it with an ellipsis and show the full email on hover.
- Where: components/MembersSettings.tsx

## qa4-settings-11 · minor · The member drawer doesn't close on Escape, and the invite form is hidden while it's open
- Page: /settings/members
- What: The member drawer doesn't close on Escape, and the invite form is hidden while it's open.
- Steps: Settings > Members > click a person > press Escape.
- Expected: Escape closes the drawer; the invite form stays reachable.
- Where: components/MembersSettings.tsx

## qa4-settings-12 · minor · The member drawer says the same empty thing twice
- Page: /settings/members
- What: The member drawer says the same empty thing twice: "Holds: Nothing" and "Responsibilities: Nothing assigned".
- Steps: Settings > Members > click Commenter.
- Expected: One line saying the person holds nothing, or merge the two sections.
- Where: components/members/MemberApprovals.tsx

## qa4-settings-14 · minor · The Engineering lead step reads "People named 0"
- Page: /settings/members (Engineering lead), /home (Set up)
- What: The Engineering lead step reads "People named 0".
- Steps: Home > Set up > Engineering lead, or Settings > Members > Engineering lead.
- Expected: "Nobody named yet. Pick who carries engineering checks."
- Where: components/MembersSettings.tsx:260

## qa4-settings-17 · minor · Internal keys are shown to people
- Page: /settings/templates, /settings/themes
- What: Internal keys are shown to people: "ai-feature" and "clean-document" under template and theme names.
- Steps: Settings > Templates or Themes; select a row and read the inspector.
- Expected: Show only the display name.
- Where: app/settings/templates, app/settings/themes

## qa4-settings-19 · minor · For the owner, the Slack pings note says "Settings › Notifications" as plain text instead of a…
- Page: /account
- What: For the owner, the Slack pings note says "Settings › Notifications" as plain text instead of a link.
- Steps: My account > Slack pings.
- Expected: A link to /settings/notifications for owners.
- Where: components/account/SlackPingsPanel.tsx:54

## qa4-settings-21 · minor · On a phone, the Active pill in member rows floats out of line with the name
- Page: /settings/members
- What: On a phone, the Active pill in member rows floats out of line with the name.
- Steps: Phone 390; Settings > Members.
- Expected: The pill lines up with the row text.
- Where: components/MembersSettings.tsx

## qa4-settings-23 · minor · Company-owned tokens read "For No one (company)"
- Page: /settings/api-tokens
- What: Company-owned tokens read "For No one (company)".
- Steps: Settings > API tokens; look at Acts for / For.
- Expected: "The company" or "Not tied to a person".
- Where: components/ApiTokensSettings.tsx:253

## qa4-settings-26 · minor · The Delivery log's Event filter and rows use raw event names (webhook.test…
- Page: /settings/webhooks
- What: The Delivery log's Event filter and rows use raw event names (webhook.test, run.awaiting_approval, approval.approvals_invalidated), while the form used plain sentences.
- Steps: Select a webhook; open the Event filter.
- Expected: The same plain labels as the New webhook form.
- Where: app/settings/webhooks/DeliveryLog.tsx:41,73

## qa4-settings-27 · minor · The list still says "Last delivery: None yet" after a test delivery appears in the log
- Page: /settings/webhooks
- What: The list still says "Last delivery: None yet" after a test delivery appears in the log.
- Steps: Send test event; look at the list row.
- Expected: The list updates with the latest delivery and its result.
- Where: app/settings/webhooks

## qa4-settings-28 · minor · The inspector shows "API version 2026-10-25"
- Page: /settings/webhooks
- What: The inspector shows "API version 2026-10-25": an internal version written as an ISO date.
- Steps: Select a webhook.
- Expected: Hide it, or call it "Payload format: Oct 25, 2026" with help text.
- Where: app/settings/webhooks/WebhookInspector.tsx:93

## qa4-settings-29 · minor · After Create, the dialog is still titled "New webhook", and the one-time signing secret is cut…
- Page: /settings/webhooks
- What: After Create, the dialog is still titled "New webhook", and the one-time signing secret is cut mid-character in a narrow field.
- Steps: Create a webhook.
- Expected: Title it "Webhook created" and show the whole secret (wrap it or widen the field).
- Where: app/settings/webhooks/NewWebhookSheet.tsx

## qa4-settings-30 · minor · The New webhook dialog runs to the bottom edge of a 900 px window
- Page: /settings/webhooks
- What: The New webhook dialog runs to the bottom edge of a 900 px window: Cancel and Create are off-screen, and Create stays disabled without saying what's missing.
- Steps: Settings > Webhooks > New webhook.
- Expected: Keep the footer pinned and visible, and name the missing field.
- Where: app/settings/webhooks/NewWebhookSheet.tsx

## qa4-settings-31 · minor · The "Include owners-and-approvers content … Off unless you say why" option is hard to follow
- Page: /settings/webhooks
- What: The "Include owners-and-approvers content … Off unless you say why" option is hard to follow: it isn't clear what is withheld or what "say why" asks for.
- Steps: New webhook; read the last option.
- Expected: Say plainly what extra content is sent and who can see it.
- Where: app/settings/webhooks/WebhookInspector.tsx:94

## qa4-settings-32 · minor · The rail's Inbox badge with two digits ("11") is a cramped oval that overlaps the icon
- Page: all pages (rail)
- What: The rail's Inbox badge with two digits ("11") is a cramped oval that overlaps the icon.
- Steps: Owner with 11 inbox items; look at the rail.
- Expected: The badge fits its number and clears the icon.
- Where: components/ds/AppShell.tsx

## qa4-settings-33 · minor · Freshness numbers contradict
- Page: /settings/claude-accounts
- What: Freshness numbers contradict: the header says "Last checked 5 min ago" while the table footer says "Usage read 3–51 min ago".
- Steps: Settings > Claude accounts.
- Expected: One freshness line, or labels that make the difference clear.
- Where: app/settings/claude-accounts/_readings.ts:220

## qa4-settings-34 · minor · Internal terms with no explanation
- Page: /settings/claude-accounts
- What: Internal terms with no explanation: "Given out", "Drain", "Facts", "Holding now (0)", "Copy ID".
- Steps: Settings > Claude accounts; select an account.
- Expected: Plain labels ("Last used by a run", "Stop new jobs"…), and no raw-ID button for people.
- Where: app/settings/claude-accounts/ClaudeAccounts.tsx:328,955

## qa4-settings-36 · minor · For non-owners, Members has no "View only" chip (it uses a sentence instead), while Company…
- Page: /settings/members
- What: For non-owners, Members has no "View only" chip (it uses a sentence instead), while Company, Templates, Claude accounts and Autonomy show the chip.
- Steps: Sign in as viewer; open Settings > Members, then Company.
- Expected: The same View only chip on every read-only Settings page.
- Where: components/MembersSettings.tsx:216

## qa4-settings-38 · minor · A viewer's personal-token form offers the Write scope with no hint that a viewer can't write…
- Page: /account
- What: A viewer's personal-token form offers the Write scope with no hint that a viewer can't write anything.
- Steps: Sign in as viewer; My account > Personal API tokens.
- Expected: Hide Write for viewers, or say what it allows for this role.
- Where: components/account

## qa4-settings-39 · minor · An expired personal token reads "Expired Sep 29, 2026" and then "Expired" again in the Status…
- Page: /account
- What: An expired personal token reads "Expired Sep 29, 2026" and then "Expired" again in the Status column, and has no action to clear it.
- Steps: My account > Personal API tokens (owner).
- Expected: Say it once; offer Remove for expired tokens.
- Where: components/account

## qa4-settings-40 · minor · The consent page is titled "Connect an MCP client" (jargon), and "Returns to an app on this…
- Page: /oauth/consent
- What: The consent page is titled "Connect an MCP client" (jargon), and "Returns to an app on this computer" doesn't say which app.
- Steps: Open the consent screen from an MCP client's connect request.
- Expected: Use the client's name in the title ("Let Example Agent use Product Oracle?"), and name the return target.
- Where: app/oauth/consent

## qa4-settings-42 · minor · The starter body's placeholder line suggest_when
- Page: /settings/templates/new
- What: The starter body's placeholder line suggest_when: "Describe when this template is the right pick" is saved as real data when the template is created unchanged.
- Steps: New template > enter a key and name > Create template; read the v1 body.
- Expected: Ask for when-to-suggest text, or leave it empty, rather than saving the instruction text.
- Where: app/settings/templates

## qa4-settings-43 · minor · The Key and Name placeholders ("launch-brief", "Launch brief") look like filled-in values, yet…
- Page: /settings/templates/new
- What: The Key and Name placeholders ("launch-brief", "Launch brief") look like filled-in values, yet Create says "Enter a key to create the template".
- Steps: Open New template; look at Details.
- Expected: Lighter, clearly example-style placeholders ("e.g. launch-brief").
- Where: app/settings/templates

## qa4-settings-45 · minor · Locked levels (padlock Act or Recommend) explain why only in a hover tooltip ("Stays with…
- Page: /settings/autonomy
- What: Locked levels (padlock Act or Recommend) explain why only in a hover tooltip ("Stays with people: date commitments"), which touch and screen-reader users never get. The change dialog's Save is dashed and disabled until Why is filled, with nothing saying Why is required.
- Steps: Settings > Autonomy; hover or tap a padlocked Act; open a change and leave Why empty.
- Expected: Show the reason in text (or with aria-describedby) and mark Why as required.
- Where: app/settings/autonomy/AutonomySettings.tsx:187

## qa4-settings-46 · minor · While a request is pending, Send note with an empty note says "Sent"
- Page: /access
- What: While a request is pending, Send note with an empty note says "Sent"; nothing was written for the owner.
- Steps: Sign in as someone who asked to join (pending); press Send note without typing.
- Expected: Keep Send note disabled until there is text, or say there is nothing to send.
- Where: app/access/page.tsx
