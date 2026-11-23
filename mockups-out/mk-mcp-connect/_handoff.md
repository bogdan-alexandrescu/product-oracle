# mk-mcp-connect: what exists today (checked in the code and the mock app, Nov 23)

- MCP endpoint: `api/oracle/mcp` (`server.py` McpEndpoint, `tools.py` app_operations: one tool per API operation, limited by the caller's rights; `curated.py`).
- OAuth: `api/oracle/mcp/oauth/routes.py` (oauth_consent_request, oauth_consent_decision); the public address comes from `public_url` (`api/oracle/config.py`, used in `mcp/oauth/service.py` and `discussions/replies.py` to build `<public_url>/mcp`). **No API response gives the web the MCP address today**: the mock-up reads `MOCK_MCP_URL` (web/lib/api/mock/mcp-connect.ts). Building it needs an API change (for example an `mcp_url` field on `GET /v1/me/account`, read from ORACLE_PUBLIC_URL) with a pytest test.
- Consent screen: `web/app/oauth/consent/ConsentScreen.tsx` ("Let <client> use Product Oracle?", Approve / Deny); its only link is "Go to Oracle" on an error.
- **Correction to the brief:** My account already lists the person's MCP clients. `web/components/MyAccount.tsx` ClientsPanel ("MCP clients": client, what it can do, authorized, last used, status, Revoke with a confirm) and an "MCP clients" stat, over `GET/DELETE /v1/me/oauth-clients`. What is missing is any way to find MCP, its address, how to connect, what you can do, or a company view.
- Personal tokens: My account > Personal API tokens (TokensPanel); owners: Settings > API tokens (`/v1/api-tokens` lists every kind, mcp_client included: the source for the owner's company view).
- Account menu: `UserMenu` in `web/components/ds/AppShell.tsx`, shared by Simple and Detailed; My account is `/account`, which renders in Detailed's chrome.
- Not built by the mock-up and needed for a real build: the MCP address from the API; "where it runs" per client (the mock maps client ids; the API has only client_name); MC3 b's undo needs a delayed revoke in the API; the company view should use can() rather than a role compare (the mock-up compares `me.role === 'owner'`, MOCK-HOOK only).

## Switches
`?mc1=a|b|c&mc2=a|b|c&mc3=a|b|c` plus `menu=1` (account menu open), `open=1` (MC1 b dialog), `tab=code|app|other`, `copied=1`, `phase=wait|late`, `step=1|2|3`, `revoke=1`, `as=viewer|commenter|approver`, `clients=none|fresh|five`.
Capture: `cd web && npm run build:mock && npm run start:mock -- --port 4517`, then
`E2E_PORT=4517 E2E_PREBUILT=1 npx playwright test e2e/mk-mcp-connect.capture.spec.ts` (needs CI unset; MK_ONLY=<prefix> for some frames).

## Review round (Nov 23)
- The company view's row for the signed-in owner now comes from their own client list (`mockCompany` in web/lib/api/mock/mcp-connect.ts), so it follows `clients=none|fresh|five`; MC3 a sorts it by name, c by last used.
- MC3 b: a revoke waiting on Undo (`mockSetPending`) counts as revoked everywhere: the check strip reads 'Revoked' with Undo, and the MCP clients stat and list count drop at once.
- Commands wrap only at spaces and after `/` or `.`; names wrap in full; 'Just now' replaces 'A moment ago'.
- Dark frames for every proposal, and mc3-b-five-390. mc2-a-rest was dropped (it was the same picture as mc1-a-open).
- Still true: the company view compares `me.role === 'owner'` (MOCK-HOOK only); the build uses can('list_api_tokens').
