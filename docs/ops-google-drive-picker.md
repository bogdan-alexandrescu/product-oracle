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
  may reach Drive 30 times a minute (in-process). A connection that is not active gets
  409 before the cache answers; the credential is read under the connection's row lock
  (as every reader does, so a refresh never spends a rotating refresh token twice); and
  Google's error text is redacted of the credential before it reaches the 502 answer or
  the connection's `last_error`.
- `GET /v1/connections/{id}/google/shared-drives` lists the shared drives the person's
  connection sees, for an owner choosing the company's (below).
- Every page sends a CSP with `default-src 'self'` that adds exactly `apis.google.com`,
  `accounts.google.com/gsi/` (scripts, frames, requests, its stylesheet) and
  `docs.google.com` (the picker frame); inline styles and `data:` images and fonts are
  allowed for the picker dialog and theme previews. In-app navigation keeps the first
  page's CSP, so it cannot be on `/settings/sources` alone.

## Syncing folders

- At most 2,000 docs per source come from its folders; past that the listing stops and
  the folder shows "Capped" on the source card.
- The folders are listed again when the allowlist or the company's domains or shared
  drives changed, after a narrowing save, when Drive's change log (`changes.list`) shows
  a change to a doc or folder under them, when a folder Oracle lost access to can be
  read again, or at least every 6 hours; otherwise a sync reads only the change log and
  the picked docs not pulled in yet.
- Lost access (owner 2026-10-20): when Drive answers 404, or a 403 refusing that file,
  for a picked folder (or the folder is in the trash), the card says "Lost access to
  <folder>" and every doc that came from it is hidden at once (soft delete), unless it is
  also picked on its own or under another picked folder. Each sync asks Drive about the
  folder again; once it can be read, its docs are read again and come back. A timeout,
  a 5xx or a rate limit is not a loss: the sync fails or stops and hides nothing. A
  picked doc Oracle cannot read is deleted, as before.
- Docs in a picked folder that are not the company's are skipped and listed on the card,
  with their count and names (S5, owner 2026-10-20; a person can still pick one on its
  own, and docs picked one by one are always pulled in):
  - in a shared drive: the company's only when the drive is on the owner's list,
    `company_shared_drives` (Settings › Sources › Google Drive); otherwise "Skipped: in a
    shared drive outside the company".
  - in My Drive: the company's when an owner's email domain is one of the company's;
    otherwise "Skipped: owned outside <domain>".
- The company's email domains are set explicitly: `ORACLE_IAP_ALLOWED_DOMAINS` plus the
  owner's `company_email_domains` setting (Settings › Sources › Google Drive). Public mail
  providers (gmail.com, outlook.com, yahoo.co.uk, gmx.de and the like) are refused there
  (422). **In production at least one must be set, or every doc in a picked folder is
  skipped** ("Skipped: company domain not set"; the check fails closed).
  `ORACLE_INFER_COMPANY_DOMAINS=true` takes them from the members' email addresses
  instead (public providers left out): local development only, never in production.

## Narrowing

Narrowing takes effect on save (S5, owner 2026-10-20). Removing a file or folder from a
source and saving deletes (soft delete: hidden from search, runs, MCP and new evidence;
stored versions kept; citations show 'source removed') every item that came from it in
that same request, with no Drive call, so it works with an expired connection or a paused
source. Which items came from which pick is what the last sync listed (the cursor's
`tree`); when a remaining folder was never listed, what came from the removed picks is
still deleted and the next sync settles the rest. A doc deleted this way that is still
under the allowlist (also in a remaining folder whose docs were never listed) is read
again by the next sync.

When an owner removes a shared drive from `company_shared_drives` or a domain from
`company_email_domains` (or resets either), the docs in picked folders that now fall
outside are deleted the same way, in that request, from every member's Google Docs
sources, judged from what each item stored (its shared drive and owners). A doc whose
drive and owner Oracle did not store is deleted too and read again by the next sync if
it is the company's. With `ORACLE_DRIVE_DOCS_OWNED_OUTSIDE=include_and_flag` nothing is
deleted: the next sync flags them.

A sync running when the source or those settings are edited saves nothing more (no
cursor, report or docs over the edit) and ends as `superseded`; it then deletes whatever
now falls outside that the save could not (rows it held). Each sync also adds every live
item of the source to what the connector knows, so sources narrowed before narrowing took
effect on save are cleaned by a plain sync.

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
| `ORACLE_IAP_ALLOWED_DOMAINS` | the company's email domains (also IAP sign-in), e.g. `["example.com"]`; with the owner's `company_email_domains` setting, what "the company's" means for docs in picked folders. One of the two must be set in production | no |
| `ORACLE_INFER_COMPANY_DOMAINS` | `false` (default). `true` takes the company's domains from the members' email addresses when none is set: local development only | no |

Owner settings (Settings › Sources › Google Drive, `PUT /v1/settings/{key}`):
`company_email_domains` (public mail providers refused) and `company_shared_drives`
(`[{"id", "name"}]`, chosen from the shared drives the owner's Google connection sees).
