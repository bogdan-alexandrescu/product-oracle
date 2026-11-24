# mk-palette: command palette mock-ups (issue 1794, CP1..CP3)

MOCK-UPS ONLY, never merged. Branch base 83b3594.

## What the app has today (read in the mock app before drawing)
- No palette, no global search, no ⌘K. ⌘/Ctrl is used only to submit (comment box, chat).
- Simple rail: brand, Simple/Detailed switch, Home, One-pagers, Roadmap (count), Goal map, Priorities,
  Meetings, Decisions (count), Inbox (count); Ask Oracle and the account at the foot. Phone: top bar
  (page name, Ask, avatar) and a tab bar (Home, One-pagers, Roadmap, Decisions, More).
- Detailed rail: narrow tiles (Home, Requests, Ground Truth, PRDs, Priorities, Plan, Runs, Inbox, Company,
  Settings); Ask on the right edge.
- Finding F-79 today: open Roadmap, scroll the timeline, find the row, click it (4 steps and a scroll).
- Adding an item today: Roadmap, Add an item: pick a roadmap, pick a track, type a title, New item.
- Every feature opens the one feature panel (`app/simple/roadmap/_panel.tsx` FeaturePanel, by id/code/name).
  Owners and approvers change at once; commenters propose (can('create_simple_change') /
  can('accept_simple_change')).

## Switches (all lines MOCK-HOOK)
- `?cp1=a|b|c` look: centered sheet / drop-down from the top / side sheet.
- `?cp2=a|b|c` behaviour: find and open here / find and do / go to its page.
- `?cp3=a|b|c` entry: Find in the rail (+ phone top-bar button) / field strip above every page / round button.
- `&many=1` 60 extra long-named features; `&cost=<words>` the cost note. Switches persist per tab.
- Code: `web/components/mockup/Palette.tsx`, data `web/lib/api/mock/palette.ts`, hooks in `web/app/__root.tsx`,
  `web/components/ds/AppShell.tsx`, `web/components/simple/SimpleShell.tsx`.

## Frames
- `npm run build:mock`, serve dist on 4173 (`npx vite preview --mode mock --port 4173`), then
  `swarm-test-browsers npx playwright test -c playwright.mk.config.ts` (`MK_ONLY=cp2-b` for one).
- Writes `mockups-out/mk-palette/frames/*.html|png`; fonts in `assets/`; `?theme=dark` on any html.
- Recommended: CP1 a (centered sheet), CP2 b (find and do), CP3 a (Find in the rail).
