# Google Drive picker (Google Docs sources)

People choose the Google Docs Oracle reads with Google's own Drive picker (S5,
2026-10-19). Oracle holds Google's `drive.file` access: it can open only the files each
person picked. Settings > Sources, kind Google Docs, "Choose files from Drive".

## What runs where

- Browser: loads `https://apis.google.com/js/api.js` and
  `https://accounts.google.com/gsi/client`, asks Google Identity Services for a
  `drive.file` token (Oracle's client id, the connection's email as hint), opens
  `google.picker` (Google Docs, folders to browse into, several files at once).
  The picked file ids (and names) are saved in the source config `{docs, names}`.
- API: `GET /v1/connections/google/picker-config` gives the browser the client id, the
  Cloud project number and the browser API key (404 until all are set). The person's
  Google connection (same OAuth client, `openid email drive.file`) reads the picked files.
- `/settings/sources` sends a CSP that allows exactly `apis.google.com`,
  `accounts.google.com/gsi/` and `docs.google.com` (the picker frame) besides the app.

## Folders

`drive.file` covers files "that you open with an app or that the user shares with an
app while using the Google Picker API" ([Choose Google Drive API scopes](https://developers.google.com/workspace/drive/api/guides/api-specific-auth)).
Picking a folder grants the folder, not the files in it, and Drive answers 404 for files
that were never picked. The picker therefore shows folders to browse into but does not
let anyone pick one (`setSelectFolderEnabled(false)`); people open the folder and pick
its files. Older sources that allowlist `folders` keep syncing while their connection
still holds the old `drive.readonly` grant; after reconnecting they show "Reconnect to
choose files" until their files are picked.

## Setup in Oracle's Google Cloud project

1. Enable the **Google Picker API** (and keep the Google Drive API enabled).
2. Create a **browser API key**: application restriction *Websites*,
   `https://oracle.swarm.saga.xyz/*`; API restriction *Google Picker API* only.
3. OAuth consent screen ("Product Oracle", internal): add the scope
   `https://www.googleapis.com/auth/drive.file` (remove `drive.readonly` once every
   legacy folder source has moved to picked files).
4. OAuth client (web): add `https://oracle.swarm.saga.xyz` to the **authorized
   JavaScript origins** (the browser asks for the drive.file token from that origin);
   the redirect URI `https://oracle.swarm.saga.xyz/v1/connections/google/callback`
   stays as it is.

## Settings (API environment)

| Name | Value | Secret? |
| --- | --- | --- |
| `ORACLE_OAUTH_GOOGLE_CLIENT_ID` | the OAuth client id (already set for Google sign-in) | no |
| `ORACLE_OAUTH_GOOGLE_CLIENT_SECRET` | the OAuth client secret (already set) | yes, never returned |
| `ORACLE_GOOGLE_PICKER_APP_ID` | the Cloud **project number** of that project | no |
| `ORACLE_GOOGLE_PICKER_API_KEY` | the browser API key from step 2 | public by design (the browser sends it to Google); kept as a secret value and never logged |

Everyone reconnects Google once (Settings > Connections, "Reconnect to choose files")
so their grant becomes `drive.file`.
