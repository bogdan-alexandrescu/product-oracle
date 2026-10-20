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
  `setSelectFolderEnabled(true)`). The picked ids and names are saved in the source
  config `{docs, folders, names}`.
- API: `GET /v1/connections/google/picker-config` gives the browser the client id, the
  Cloud project number and the browser API key (404 until all are set). The person's
  Google connection (same OAuth client, `openid email drive.readonly`) reads the picked
  docs and lists the picked folders recursively on every sync.
- Every page sends a CSP that allows exactly `apis.google.com`,
  `accounts.google.com/gsi/` and `docs.google.com` (the picker frame) besides the app
  for scripts, frames and requests (in-app navigation keeps the first page's CSP, so it
  cannot be on `/settings/sources` alone).

## Narrowing

Removing a file or folder from a source and saving deletes, on the next sync, every item
that came from it (S5, 'Browse access and narrowing'). The source keeps the files it
knows in its cursor across the edit, and the sync deletes those no longer under the
allowlist.

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
