# de-r1 handoff (features directly on Simple's Roadmap)

Branch commits (on top of 7f932ba):
- d9a1e71de part 1 ADD IN PLACE: done for Timeline (each track band ends with a faint "+ Add" row; a click at a week
  puts a six-week bar, Monday-snapped, with the title field; Enter adds on that track with its code at those dates;
  Escape cancels) and Now / Next / Later (every column ends with "+ Add", a card with the title field). Top add bar
  untouched. NOT built: the Gantt's per-goal "+ Add" rows.
- 6e887e210 part 2 GRAB THE BAR, partly: drag a Timeline bar up/down onto another track's band moves it there
  (set_track; the band under the pointer is marked); click the open row's name renames in place (edit_title; Enter
  saves, Escape keeps). Move and stretch by drag already existed (roadmap-r2). NOT built: week snap for the move drag
  (it stays day-by-day as built), owner-initials picker on the bar, re-track on the Gantt.
- f08c77ffc part 4 DELETE: with a bar or card selected (panel open), Delete/Backspace moves it to Trash at once with
  Undo (the panel's Move to Trash, via useFeatureDelete with now=can_decide; who may only propose proposes); never
  while focus is in a field.
- part 3 PRIORITIZE: NOT built. The reorder op (after.position) exists in the API and mock, but the Timeline sorts a
  track's rows by start date, and positions are plain integers (one row's move needs its neighbours renumbered).
  Owner question in questions.json.

Specs (mock-backed, --retries=0, all pass): web/e2e/de-r1-add.spec.ts (5, incl. a commenter proposing), de-r1-grab.spec.ts (2),
de-r1-delete.spec.ts (2). A commenter's add in place files a proposal (toast names Needs a decision); NOT built: a pending mark on the Timeline (re-track/rename of a proposer go through
the same propose/act calls, which file proposals; no new pending mark was built on the Timeline).

Gates: tsc clean; eslint on touched files clean except base errors (_roadmap.tsx cognitive-complexity 8, same as the
base file; _add.tsx max-lines and FeatureDelete complexity are base, untouched); prettier written on touched files.
NOT run: full `npm run lint` (takes >10 min here, timed out), prose guard spec, vite build separately (the Playwright
mock build ran and passed). roadmap-r2-timeline-drag.spec.ts at 1024 is flaky on the base too (a different test
fails each run; seen on 7f932ba's _zoom.tsx).
No API change, so no pytest.

Files outside the territory (smallest change): web/app/simple/roadmap/_roadmap.tsx (onAdd takes a span; passes
onAddAt / onAddIn; the Delete-key effect), web/lib/api/mock/simple-changes.ts (add_item keeps after.start_date and
end_date, as additions._plan does).
Open: a just-added draft's bar did not move with a horizontal mouse drag in a test (re-track of the same bar works);
not looked into. Check it first if you pick this up.
