# Google Drive picker (Google Docs sources)

People choose the Google Docs and folders Oracle pulls in with Google's own Drive picker
(S5, 2026-10-19, revised by 'Drive folders'). A picked folder syncs every Google Doc in
it and its sub-folders, now and later, so Oracle keeps read access to the person's Drive
(`drive.readonly`), not only to picked files. Settings > Sources, kind Google Docs,
"Choose from Drive". What the page says: "Oracle can read your Drive; it pulls in only
the files and folders you choose here."

## What runs where

- Browser: loads `https://apis.google.com/js/api.js` and
  `https://accounts.google.com/gsi/client` when the Google Docs picker shows, asks Google
  Identity Services for a `drive.readonly` token (Oracle's client id, the connection's
  email as hint) on the click on "Choose from Drive" (so popup blockers allow the sign-in
  popup), and opens `google.picker` (Google Docs and folders, several at once,
  `setSelectFolderEnabled(true)`, shared drives included with `setEnableDrives(true)`).
  The picked ids and names are saved in the source config `{docs, folders, names}`.
  Ids can also be pasted (or Drive links, read for their id).
- API: `GET /v1/connections/google/picker-config` gives the browser the client id, the
  Cloud project number and the browser API key (404 until all are set). The person's
  Google connection (same OAuth client, `openid email drive.readonly`) reads the picked
  docs and lists the picked folders recursively.
- Every id must look like a Drive id (`^[A-Za-z0-9_-]{10,200}$`, never `root`, the whole
  My Drive): anything else is a 400 before Drive is called. Ids are also escaped in
  Drive queries and quoted as URL path segments.
- `GET /v1/connections/{id}/google/files?q=&folder=&cursor=` lists the person's Google
  Docs and folders through their own connection, for the browser and for MCP clients
  acting as the person (tool `list_google_drive_files`). Owner only; API tokens without a
  user get 403; run tokens cannot reach it. The search text is one escaped
  `name contains '...'` term. Answers are cached a minute per connection, and a person
  may reach Drive 30 times a minute (in-process).
- Every page sends a CSP with `default-src 'self'` that adds exactly `apis.google.com`,
  `accounts.google.com/gsi/` (scripts, frames, requests, its stylesheet) and
  `docs.google.com` (the picker frame); inline styles and `data:` images and fonts are
  allowed for the picker dialog and theme previews. In-app navigation keeps the first
  page's CSP, so it cannot be on `/settings/sources` alone.

## Syncing folders

- At most 2,000 docs per source come from its folders; past that the listing stops and
  the folder shows "Capped" on the source card.
- The folders are listed again when the allowlist changed, when Drive's change log
  (`changes.list`) shows a change to a doc or folder under them, or at least every 6
  hours; otherwise a sync reads only the change log and the picked docs not pulled in
  yet.
- A picked folder Oracle can no longer read (unshared, deleted) shows "No access" on the
  source card; what came from it is kept until the folder is removed from the source.
- Docs in a picked folder whose owner's email domain is not the company's are skipped
  and listed on the card as "Skipped: owned outside <domain>" with their count and names
  (S5, owner 2026-10-20; a person can still pick one on its own). The company's domains are
  `ORACLE_IAP_ALLOWED_DOMAINS`, else the members' email domains (public mail providers
  left out). Docs in a shared drive have no owner and count as the company's; docs picked
  one by one are always pulled in.

## Narrowing

Removing a file or folder from a source and saving deletes (soft delete: hidden, stored
versions kept), on the next sync, every item that came from it (S5, 'Browse access and
narrowing', owner 2026-10-20). Each sync adds every live item of the source to what the
connector knows, so this holds when the connection changes in the same edit, for sources
narrowed before this was fixed (a plain sync cleans them), and however the cursor was
reset. A sync that was running when the source was edited saves nothing more (no cursor,
no report over the edit) and ends as `superseded`.

## Connections

Connections that already hold `drive.readonly` keep working with no reconnect. A Google
connection without it (the short-lived `drive.file` grant) shows "Reconnect to choose
files"; Reconnect signs in again for `drive.readonly`.

## Setup in Oracle's Google Cloud project

1. Enable the **Google Picker API** (and keep the Google Drive API enabled).
2. Create a **browser API key**: application restriction *Websites*,
   `https://oracle.swarm.saga.xyz/*`; API restriction *Google Picker API* only.
3. OAuth consent screen ("Product Oracle", internal): keep the scope
   `https://www.googleapis.com/auth/drive.readonly`. No `drive.file` scope is needed.
4. OAuth client (web): add `https://oracle.swarm.saga.xyz` to the **authorized
   JavaScript origins** (the browser asks for the token from that origin); the redirect
   URI `https://oracle.swarm.saga.xyz/v1/connections/google/callback` stays as it is.

## Settings (API environment)

| Name | Value | Secret? |
| --- | --- | --- |
| `ORACLE_OAUTH_GOOGLE_CLIENT_ID` | the OAuth client id (already set for Google sign-in) | no |
| `ORACLE_OAUTH_GOOGLE_CLIENT_SECRET` | the OAuth client secret (already set) | yes, never returned |
| `ORACLE_GOOGLE_PICKER_APP_ID` | the Cloud **project number** of that project | no |
| `ORACLE_GOOGLE_PICKER_API_KEY` | the browser API key from step 2 | public by design (the browser sends it to Google); kept as a secret value and never logged |
| `ORACLE_DRIVE_DOCS_OWNED_OUTSIDE` | `skip` (default): docs in a picked folder owned outside the company are left out and listed; `include_and_flag`: pulled in and listed as "Owned outside <domain>" (items carry `acl.owned_outside_company`) | no |
