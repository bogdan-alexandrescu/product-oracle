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

# Review round 1 (verdict NOT_YET), what changed
- The panel agrees with the row: while a My work switch is on, the mock roadmap reads My work's features as Avery Stone's with the row's dates (`mwRoadmapItem` in `my-work.ts`, `mwPatch` in `simple-roadmap.ts`); the rows' features sit on Guided setup track, where the mock roadmap has them.
- Decisions agree: My work's decisions carry Decisions' codes (Q5, Q6, Q8) and answers; the 31 other waiting decisions (no due date) are counted (43 items, decisions 34) and linked to Decisions.
- Deciding drops every count: the group, the page, My work's and Decisions' rail and tab counts (`useMyWorkDecided`). A decided row loses its Late tag.
- Roles: `mw2-a-commenter` (Propose an answer, Open to propose, a status) and `mw2-a-viewer` (Open only, a status); MW3's viewer frame is drawn once (in a).
- Cost band (`&cost=1`) on every result frame. Header late + at risk add up to the group. Phone Mine switch; view tabs hide while Mine is on; Mine's line points to the 34 on Decisions.
- Frames re-rendered by `$TMPDIR/mk/snap.py` (not committed: it drives the live browser by CDP).

# Known gap
- 1512 frames: the live browser has only 1440 and 390 presets, so the page is zoomed to a 1512-wide layout and the PNG is scaled to 1512x900; the HTML frames carry the 1512 viewport.
- The Roadmap already has an Owner filter (All / a person / No owner); MW1 c's Mine is a one-tap form of it.
- Lint on `MyWorkMock.tsx` still flags raw `simple-button` buttons and complexity (mock only, never merged).

# Review round 2 (verdict NOT_YET), what changed (round 3)
- MW3 c mid: rendered by picking Avery Stone in the panel's Owner (it saves at once, with Undo); the script then clicks Undo. The "Set owners on the Roadmap" link keeps `mw3=c&case=none`, so the rail shows no My work count on the Roadmap frames.
- Role frames: a viewer's or commenter's rows say "Feature named for you" / "Milestone named for you"; statuses "Your role can read only; ask an editor to change" and "Your role proposes; an approver decides".
- A group with rows decided this visit reads "· 2 · 1 decided" (mw2-a-result).
- My work's features' goal has a target date (Mar 31, 2027) in the mock, so the panel's Date is not "No date yet" beside the feature's dates.
- Phone dark PNG for every proposal (from the static phone HTML with ?theme=dark). mw3-a-viewer re-rendered.
- Static HTML keeps scroll positions (`data-mock-scroll`, restored on load beside the theme hook). Scripts in `_tools/` (they drive the live browser by CDP; serve the mock build on 127.0.0.1:4173 first).
