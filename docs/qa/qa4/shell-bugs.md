# QA pass 4 · Shell (navigation, Ask, errors, mode switch) · bugs (16)
Found on the mock app (invented data) at desktop 1512 and phone 390, train AD's build. Ids qa4-<area>-N.

## qa4-shell-1 · blocker · Phone Detailed: Ask Oracle text box hidden under the tab bar
- Page: /home, /documents, /runs, /inbox, every Detailed page (phone)
- What: On a phone in Detailed, the Ask Oracle sheet's text box sits under the tab bar, so you cannot tap it to type a question.
- Steps: Phone 390x844, sign in as the owner, open Home (or any Detailed page), tap Ask in the header, tap where the 'Ask about Home…' box should be at the bottom.
- Expected: The sheet covers the tab bar (as Simple's Ask sheet does) and its text box and Send button sit above the bottom edge, visible and tappable.
- Where: web/components/ds/AppShell.tsx:823 (Detailed's sheet is rendered inside the sticky z-30 header, so the z-[39] tab bar at :507 draws over it; Simple's sheet at :825 is outside the header and works)

## qa4-shell-2 · major · Failed list load also shows the empty state and zero counts
- Page: /documents, /runs
- What: When a list fails to load, the page shows the error and also the empty state ('No PRDs yet. Start one with New PRD.', 'Nothing yet') and 'Ideas 0', so it reads as if you have no PRDs or runs.
- Steps: Make GET /v1/documents (or /v1/runs) fail (mock: localStorage po-mock-fail), open PRDs or Runs.
- Expected: On a failed load, only the error with a Try again button; no empty-state text and no 0 counts.
- Where: web/app/documents (list page) and web/app/runs/page.tsx: the empty row renders whenever rows are empty, without checking for an error

## qa4-shell-3 · major · Load errors are one red server line with no Try again or way back
- Page: /documents, /runs, /inbox, /company/rituals/<id>
- What: Load errors are one red line that gives the server's message and nothing else: no plain explanation, no Try again, no way back.
- Steps: Make a list's GET fail (po-mock-fail), open PRDs, Runs or Inbox; or open a meeting that no longer exists.
- Expected: A plain sentence ('Couldn't load your PRDs') with Try again, the same treatment on every page.

## qa4-shell-4 · minor · A link to a meeting, template or report that no longer exists shows a normal page heading…
- Page: /company/rituals/<id>, /settings/templates/<key>, /plan/reports/<id>
- What: A link to a meeting, template or report that no longer exists shows a normal page heading ('Company', 'Template', 'Alignment report') with a small pink line ('Occurrence not found'), not the not-found page that a missing PRD or run gets; 'Occurrence' is an internal word.
- Steps: Open a deleted ritual occurrence, template or report link (e.g. /company/rituals/zzz).
- Expected: The same not-found treatment as 'Document not found' / 'Run not found' (heading, sentence, Back to … and Go to Home), in people's words ('This meeting doesn't exist or was deleted'). The tab title says not found too.
- Where: web/app/company/rituals/[occurrence], web/app/settings/templates/[key], web/app/plan/reports/[id]

## qa4-shell-5 · minor · Switching to Simple from the New roadmap page lands on One-pagers (the PRDs list), not Roadmap
- Page: /documents/new?kind=roadmap
- What: Switching to Simple from the New roadmap page lands on One-pagers (the PRDs list), not Roadmap.
- Steps: Plan › Documents › New roadmap, then click Simple in the rail.
- Expected: Simple's Roadmap, the page that matches Plan (the rail already highlights Plan on this page).
- Where: web/lib/experience-paths.ts:57-62 (switchTarget skips 'new' and then matches /documents to /simple/one-pagers)

## qa4-shell-6 · minor · Switching to Simple and straight back to Detailed does not return you to where you were
- Page: /requests, /baseline, /runs, /inbox, /company/strategy, /company/updates, /company/metrics, /company/market, /settings/*, /plan/dates, /roadmap/changelog
- What: Switching to Simple and straight back to Detailed does not return you to where you were: from Requests, Runs, Inbox, Settings and the like you end up on Home, and from Plan › Dates or Changelog you end up on Plan's first tab.
- Steps: Open Requests, click Simple, then click Detailed.
- Expected: Detailed → Simple → Detailed returns to the page you left (remember the Detailed page you switched away from).
- Where: web/lib/experience-paths.ts:50-54 (Simple Home maps back to Detailed Home)

## qa4-shell-9 · minor · In dark mode the page behind the open Ask drawer is not dimmed (in light mode it is), so the…
- Page: Ask drawer (desktop below 1600 px)
- What: In dark mode the page behind the open Ask drawer is not dimmed (in light mode it is), so the drawer does not read as an overlay and the cut-off panel behind it looks broken.
- Steps: Theme Dark, PRDs, open Ask.
- Expected: A visible scrim in dark mode too, as in light.
- Where: web/components/ds/AppShell.tsx HopDock scrim 'bg-hero/30' (hero is near the dark page colour)

## qa4-shell-11 · minor · Disabled buttons drawn with a dashed outline (read as placeholders)
- Page: Ask drawer
- What: The disabled Send button has a dashed outline, which looks like a placeholder or drop zone and not like the greyed buttons used elsewhere (e.g. Remove in Members).
- Steps: Open Ask with an empty box.
- Expected: The app's usual disabled style.
- Where: web/components/hop

## qa4-shell-12 · minor · Under your own message, the actions wrap unevenly
- Page: Ask drawer
- What: Under your own message, the actions wrap unevenly: 'Edit  Delete' on one line and 'Research this' alone on the next, although there is room for all three.
- Steps: Open Ask on PRDs and send a question.
- Expected: All three actions on one line, evenly spaced.
- Where: web/components/hop

## qa4-shell-13 · minor · Settings pages never say Settings
- Page: /settings/* (every Settings tab)
- What: Settings pages never say Settings: the rail's Settings opens a page headed 'Members' and titled 'Members · Product Oracle', while Company's pages are titled 'Strategy · Company · Product Oracle'.
- Steps: Click Settings in the rail and look at the heading and the browser tab.
- Expected: Tab titles '<Tab> · Settings · Product Oracle', like Company and Plan, and a Settings heading or breadcrumb above the tabs.
- Where: web/components/ds/AppShell.tsx:600-716 (sectionOf / usePageTitle)

## qa4-shell-14 · minor · Simple and Detailed pages share browser-tab titles ('Home · Product Oracle', 'Priorities ·…
- Page: /simple vs /home, /simple/priorities vs /priorities, one-pager vs PRD page
- What: Simple and Detailed pages share browser-tab titles ('Home · Product Oracle', 'Priorities · Product Oracle', 'Checkout redesign PRD · Product Oracle' for both the PRD and its one-pager), so two open tabs cannot be told apart.
- Steps: Open /home and /simple in two tabs.
- Expected: A mode or page cue in Simple's titles (e.g. 'One-pager · Checkout redesign PRD').
- Where: web/components/ds/AppShell.tsx:669 usePageTitle

## qa4-shell-18 · minor · While PRDs load, and after a failed load, the switch says 'Ideas 0' (and PRDs shows no count)…
- Page: /documents
- What: While PRDs load, and after a failed load, the switch says 'Ideas 0' (and PRDs shows no count), giving a count before anything is known.
- Steps: Slow down GET /v1/documents (po-mock-slow), open PRDs.
- Expected: No count, or a placeholder, until the list has loaded.

## qa4-shell-19 · minor · The loading skeleton bars are so pale on the light theme that the page looks empty and…
- Page: /documents, /runs (loading)
- What: The loading skeleton bars are so pale on the light theme that the page looks empty and finished, not loading.
- Steps: Slow down GET /v1/documents, open PRDs.
- Expected: Skeleton bars with enough contrast to see (around 3:1 against the card), or a visible loading note.

## qa4-shell-20 · minor · When the Runs table has no rows, its header's shaded strip stops about two thirds of the way…
- Page: /runs (empty or failed)
- What: When the Runs table has no rows, its header's shaded strip stops about two thirds of the way across, leaving the last (Action) column white.
- Steps: Make GET /v1/runs fail, or use the empty company, and open Runs.
- Expected: A header fill across the whole table width, as when rows exist.
- Where: web/app/runs/page.tsx

## qa4-shell-21 · minor · The red error banner touches the control under it (the PRDs | Ideas switch, the Runs card)…
- Page: /documents, /runs
- What: The red error banner touches the control under it (the PRDs | Ideas switch, the Runs card) with no gap.
- Steps: Make a list's GET fail and open the page.
- Expected: The page's normal spacing between the banner and the next block.

## qa4-shell-22 · minor · Phone tab bar: More not marked current on its pages
- Page: phone tab bar (Detailed and Simple)
- What: When you are on a More destination (Priorities, Runs, Settings…), the tab bar highlights More but does not mark it as current for screen readers (no aria-current), so only sighted people know where they are.
- Steps: Phone, open Priorities, inspect the More tab.
- Expected: aria-current on the More tab, or its name saying the current page ('More, Priorities').
- Where: web/components/ds/AppShell.tsx:507-560 (tab-more button)
