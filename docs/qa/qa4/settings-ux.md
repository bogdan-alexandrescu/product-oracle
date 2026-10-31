# QA pass 4 · Settings, account, access, set-up · design changes (8)
Found on the mock app (invented data) at desktop 1512 and phone 390, train AD's build. Ids qa4-<area>-N.

## qa4-settings-24 · major · Webhook delivery log squeezed to one-letter columns
- Page: /settings/webhooks
- What: In the webhook inspector, the Delivery log table is squeezed: the Event column shows a single letter ("w"), its header reads "E", and When is cut to "Oct 30, 8:2…".
- Steps: Settings > Webhooks > New webhook (name, https URL, one event) > Create > Done > select it > Send test event; read the Delivery log.
- Expected: Readable columns: stack the rows as cards in the narrow inspector, or open the log full width.
- Where: app/settings/webhooks/DeliveryLog.tsx:41

## qa4-settings-41 · major · New template requires raw Markdown with YAML front matter
- Page: /settings/templates/new
- What: New template asks people to write raw Markdown with YAML front matter (theme: clean-document, suggest_when, brief: [problem, solution]), {#id} anchors and HTML comments, plus a permanent "Key" in slug format.
- Steps: Settings > Templates > New template.
- Expected: Fields for the name, theme, when to suggest it and the sections; keep raw Markdown as an advanced option and make the key from the name.
- Where: app/settings/templates

## qa4-settings-8 · minor · Two controls do the same thing
- Page: /settings/sources
- What: Two controls do the same thing: "Add a source" in the header and an "Add source" form in a side panel headed "Your sources / New source". The panel reads like a source called "New source", and its dashed, disabled Add source looks like a placeholder.
- Steps: Open Settings > Sources; look at the right panel.
- Expected: One add-source path, and a panel title that says it is a form (for example "Add a source").
- Where: app/settings/sources

## qa4-settings-16 · minor · Page headers are inconsistent
- Page: /settings/company, /settings/notifications, /settings/analytics
- What: Page headers are inconsistent: Company, Notifications and Analytics have no (i) help and no status chip, unlike the other Settings pages.
- Steps: Click through the Settings tabs and compare the titles.
- Expected: The same header pattern on every Settings page.
- Where: app/settings/*

## qa4-settings-22 · minor · On a phone, a selected template or theme opens its detail far below the whole list, with no…
- Page: /settings/templates, /settings/themes
- What: On a phone, a selected template or theme opens its detail far below the whole list, with no scroll to it.
- Steps: Phone 390; Settings > Templates; tap a template.
- Expected: Open the detail as a sheet, or scroll it into view.
- Where: app/settings/templates, app/settings/themes

## qa4-settings-35 · minor · A viewer's first visit says nothing about what a viewer can do, while a commenter gets "You…
- Page: /home (first visit), /simple
- What: A viewer's first visit says nothing about what a viewer can do, while a commenter gets "You can propose fixes…" and "Walk me through it".
- Steps: Sign in as viewer@example.com and read Home; then do the same as commenter.
- Expected: A short line for viewers saying what they can see and how to ask for more access.
- Where: Simple Home greeting

## qa4-settings-37 · minor · Pages a role can't use say "Ask an owner (Admin)" but the button is "Open Members", which is…
- Page: /settings/notifications, /settings/trash
- What: Pages a role can't use say "Ask an owner (Admin)" but the button is "Open Members", which is unrelated. Connections tells an approver "An owner sets it up on Notifications", a page they can't open.
- Steps: Sign in as approver; open /settings/notifications (from the Connections Slack text) and /settings/trash.
- Expected: Say who the owner is with a way to reach them; don't send people to Members.
- Where: app/settings/notifications, app/settings/trash

## qa4-settings-47 · minor · The expired-invite screen says "Ask the person who invited you to resend it" but doesn't say…
- Page: /access
- What: The expired-invite screen says "Ask the person who invited you to resend it" but doesn't say who that was, and offers only Sign out (no way to ask for access from here, as the pending flow allows).
- Steps: Open the invite-expired screen.
- Expected: Name the inviter, and offer "Ask to join" as the pending flow does.
- Where: app/access/page.tsx
