# mk-shortcuts: what the app has today (read from the mock app, Nov 24)

- Simple rail: Home, One-pagers, Roadmap, Goal map, Priorities, Meetings, Decisions, Inbox; Ask Oracle; Simple/Detailed switch.
- Priorities (Simple): ranked list of rows (`prio-row`), each: grip, rank, dot, name (+ code when it has one), status, badges
  ("Not in the Ground Truth"), goal, value/confidence/weeks/score, and a "..." menu (Delete feature, which asks to confirm).
  The line ("this quarter") splits the list. Show chips (All, New, In progress, Exists). No search box on this page.
- Clicking a row's name opens the one feature panel (`item-panel`, right side, 400px): code + name, every field with
  "Change", dependencies both ways, broken-link actions. Esc closes it (panel's own handler).
- Roadmap (Simple): Timeline / Gantt / Now-Next-Later / Waterfall; add-an-item bar (title field + New item); filters.
- Goal map has a "Search the roadmap" field.
- Keys today: only the version viewer (`web/components/VersionView.tsx:814-827`: / filter, [ ] j k step, v brief, c composer,
  { } versions; ignored inside a dialog). Elsewhere only scattered Escape handlers and arrow keys on drag grips.
- `Kbd` exists (`web/components/ui.tsx:155`); InfoTip (`components/ds/InfoTip.tsx`); Dialog/Sheet in `components/ds`.
- Roles: owner/approver edit directly; commenter's edits become proposals; viewer reads only.

## Mock-hook switches (all `// MOCK-HOOK`)
`/simple/priorities?ks1=a..d|ks2=a..d|ks3=a..c` plus state: `open=1` (help sheet), `q=` (sheet search), `row=N` (focused row),
`hover=N`, `tip=rail|row|close`, `g=1` (g pressed), `trail=g,r` (keys pressed, the cost strip), `nudge=1`, `typing=1`, `dialog=1`.
Component: `web/components/mock/KeysMock.tsx`, mounted in `web/components/ds/AppShell.tsx`.
