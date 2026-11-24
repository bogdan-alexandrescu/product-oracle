# mk-watch: what exists today, and what the mock-ups add

Today (in the product, before these mock-ups):
- Inbox track alerts: Date slip, Overdue, Keep watching (`web/app/inbox/_needs.tsx`).
- Settings > Notifications (owners): Slack connect, one company channel, the weekly alignment report.
- My account: name, password, API tokens, MCP clients.
- No way to watch an item, no digest by email or Slack, no personal digest settings.

Added only as MOCK-HOOK variants (throwaway branch, never merged):
- WD1 how a person watches: `?wd1=a|b|c|d` on /simple/roadmap (panel head, rows, watchers line), Inbox `?view=watching`.
- WD2 the digest: `?wd2=a|b|c` on /account (settings row and a Slack or email sample, `&msg=slack|email`, `&step=mid`, `&n=many`).
- WD3 settings and states: `?wd3=a|b|c` on /account and /settings/notifications (`&state=noslack|quiet|stopped|owner`, `&reply=stop`).
- Code: `web/app/simple/_watch-mk.tsx`, mock data `web/lib/api/mock/watch-mk.ts`, frames by `web/e2e/mk-watch-frames.spec.ts`.

Re-shoot: `cd web && npm run build:mock`, then
`MK_ONLY=wd1,wd1d,wd2,wd3,wd3m swarm-test-browsers npx playwright test e2e/mk-watch-frames.spec.ts`,
and copy `web/.mk-watch-out/frames/*` into `mockups-out/mk-watch/frames/`.
