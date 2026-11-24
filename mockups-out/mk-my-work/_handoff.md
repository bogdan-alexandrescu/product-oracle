# My work mock-ups: what the app does today (read on the mock app, Nov 24, 2026)

- Simple rail: Home, One-pagers, Roadmap, Goal map, Priorities, Meetings, Decisions, Inbox; yellow counts only for what waits on me. Simple / Detailed switch at the top of the rail. Phone: tab bar Home, One-pagers, Roadmap, Decisions, More.
- Detailed rail: Home, Requests, Ground Truth, PRDs, Priorities, Plan, Runs, Inbox, Company, Settings.
- Simple Home already lists decisions waiting for me (tiles "9 decisions waiting for you", "Waiting for you: <PRD>" rows with Decide as recommended / Another answer / Ask Oracle, "Also waiting for you"). So no proposal repeats a decisions list on Home; My work's Home section (MW1 b) leaves decisions to that card.
- The one feature panel (`web/app/simple/roadmap/_panel.tsx`) has Owner ("No owner yet" + Change, default "The track's owner") and Decider. Setting an owner today: Roadmap, find the feature, open its panel, Owner Change, pick, Save (5 steps). Every row in these mock-ups opens that same panel.
- Nothing lists items by owner; no "mine" filter anywhere.
- Owners and approvers change Simple directly; commenters make proposals; viewers read only. In these mock-ups a viewer sees no action buttons.

# Switches (all lines marked MOCK-HOOK)
- `?mw1=a|b|c` own page in the rail / "Yours" on Home / "Mine" on the Roadmap; `&mine=1` turns Mine on.
- `?mw2=a|b|c` by due date / by what I do / count tiles first; `&tile=decision|feature|milestone|proposal`.
- `?mw3=a|b|c` pick from "No owner yet" / Oracle suggests / plain line with a Roadmap link; `&case=none|forty|one`.
- `&act=open|mid|done`, `&pick=open|mid|done`, `&more=1`, `&hot=<row id>`, `&panel=<row id>`; a viewer: localStorage `po-mock-role=viewer`.
- Code: `web/components/simple/MyWorkMock.tsx`, `my-work-switch.ts`, `web/lib/api/mock/my-work.ts`, routes `web/app/simple/my-work/page.tsx`, `web/app/my-work/page.tsx`.

# Known gap
- The mock roadmap's own date estimates (Apr to May 2027) differ from the invented due dates on My work rows, so the opened panel shows other dates than the row. The build would read the item's own dates.
- 1512 frames were rendered at 1440 with the page zoomed to a 1512-wide layout (the live browser has no 1512 preset); the HTML frames carry the 1512 viewport.
