import json, os, sys
OUT = sys.argv[1]

def fr(code, letter, items):
    out = []
    for state, cap in items:
        f = f'{code}-{letter}-{state}.html'
        assert os.path.exists(os.path.join(OUT, 'frames', f)), f
        out.append({'file': f'frames/{f}', 'caption': cap})
    return out

D = []
D.append({
  'code': 'BE1', 'name': 'Picking several features',
  'question': 'How does a person pick several features on a list without losing drag to reorder or click to open the panel?',
  'common': 'Shown on Priorities, ranked list (Simple), at 1440 and 1512 and on a phone. Picked rows get the accent ring; the bulk bar (BE2) shows once one row is picked; Clear and Esc drop the picks. The same picking goes on Roadmap Now / Next / Later cards, Goal buckets and the Detailed plan list. Today: no picking at all; fixing 4 features means 4 panel opens (about 16 steps).',
  'proposals': [
    {'letter': 'A', 'name': 'Boxes on hover', 'recommended': True,
     'what': 'A checkbox fades in left of the drag handle when the pointer is over a row, and stays on every row once one is picked. Shift-click on a second box picks every row between. "Pick all N shown" sits over the list while picking. The handle still drags, the name still opens the feature panel. On a phone the boxes always show.',
     'why': 'Nothing changes for someone who never picks, drag and click keep working, and it is the way Jira and Linear lists already work, so people know it.',
     'plus': 'Shift-click covers "the 8 overdue ones" in two clicks; works the same with a mouse, a keyboard (Space on the box) and a finger.',
     'cost': '2 clicks for a run of rows, 1 click per row otherwise; nothing to turn on or off.',
     'frames': fr('be1', 'a', [
        ('rest', 'At rest: the list looks as it does today. No boxes until the pointer is on a row.'),
        ('open', 'The pointer on Alert rules engine: its box fades in left of the drag handle.'),
        ('mid', 'Alert rules engine is picked; with Shift held over Alert history export, the rows between are tinted to show what Shift-click will pick.'),
        ('result', 'After the Shift-click: 5 rows picked, every box shows, the bar says "5 picked". Cost: 2 clicks (today: no way to pick).'),
        ('result-dark', 'The same result in dark mode.'),
        ('hard-1512', 'Hard case, 1512 wide, all 22 picked with "Pick all 22 shown", scrolled to the end: the bar stays at the bottom and the last row clears it.'),
        ('phone', 'Phone 390: no hover, so every row shows its box; 3 rows picked by tapping their boxes, the bar sits under the list.'),
     ])},
    {'letter': 'B', 'name': 'A pick mode', 'recommended': False,
     'what': 'A "Pick several" button over the list turns on a pick mode: drag handles give way to checkboxes and a click anywhere on a row picks it (Shift-click picks a run). "Done picking" turns it off.',
     'plus': 'Big click targets, no hidden controls; nobody drags a row by mistake while picking.',
     'cost': '1 click to start, 1 per row (or 2 for a run), 1 to finish: 4 to 5 clicks for 4 rows.',
     'frames': fr('be1', 'b', [
        ('rest', 'At rest: a "Pick several" button over the list; rows as today.'),
        ('open', 'Pick mode on: the drag handles become boxes, drag is off (its tip says why), the button reads "Done picking".'),
        ('mid', 'Two rows picked by clicking anywhere on them.'),
        ('result', 'Shift-click on row 7 adds the run 4 to 7: 5 picked and the bar shows. Cost: 1 + 3 clicks, then 1 to leave the mode.'),
        ('hard-1512', 'Hard case, 1512 wide with long names: a click on a feature\'s name picks it instead of opening its panel, so the panel is two clicks away while picking.'),
        ('phone', 'Phone 390: pick mode with 2 rows picked; the handle space holds the box.'),
     ])},
    {'letter': 'C', 'name': 'Ctrl and Shift click', 'recommended': False,
     'what': 'No new control: Ctrl-click (Cmd-click on a Mac) on a row picks it, Shift-click picks a run, as in a file manager. A small "Pick several" (i) over the list says how.',
     'plus': 'Zero new things on screen; the fastest for people who already know the keys.',
     'cost': '2 clicks for a run, 1 per row, but only with a keyboard; no way on a phone or tablet.',
     'frames': fr('be1', 'c', [
        ('rest', 'At rest: only "Pick several" with its (i) over the list.'),
        ('open', 'Ctrl-click on Alert rules engine picks it; the count reads "1 picked" and the bar shows.'),
        ('mid', 'A second Ctrl-click adds Mobile alert push.'),
        ('result', 'Shift-click on row 7 adds the run 4 to 7: 5 picked. Cost: 3 clicks with keys held (today: no way to pick).'),
        ('hard-1512', 'Hard case, 1512 wide with long names: picks work, but nothing on a row says it can be picked; a person who has not read the (i) never finds it.'),
        ('phone', 'Phone 390: a tap has no Ctrl or Shift, so nothing can be picked; this proposal needs a second way for touch.'),
     ])},
  ]})

D.append({
  'code': 'BE2', 'name': 'The bulk bar',
  'question': 'Where does a person set owner, status, dates or track for the picked features, and see what will change before it does?',
  'common': 'Every proposal: owner (people), status (New, In progress, Exists: the product\'s own words), dates shifted by weeks, track; a before -> after preview; one button that applies all, one history entry per feature, one toast with Undo. 4 features picked (ranks 2, 4, 6, 7) on Priorities. Today: 4 panel opens, about 16 steps.',
  'proposals': [
    {'letter': 'A', 'name': 'Bar with field menus', 'recommended': True,
     'what': 'A bar floats at the bottom: "4 picked · Clear | Owner Status Dates Track". Each field opens a small menu above the bar; once a value is picked the menu lists every feature before -> after (features that already have it say "already") with Cancel and "Change 4". Applying closes the bar and shows a toast with Undo.',
     'why': 'One field at a time is what people do most ("give these an owner", "mark these done"); the preview sits right by the choice, and nothing covers the list until a field is opened.',
     'plus': 'Short: 3 clicks after picking; the preview names each feature, so a wrong pick is seen before applying.',
     'cost': 'Pick (2) + field (1) + value (1) + Change (1) = 5 clicks for any number of features (today: about 16 for 4, 32 for 8).',
     'frames': fr('be2', 'a', [
        ('rest', 'At rest: 4 rows picked, the bar at the bottom with Owner, Status, Dates and Track.'),
        ('open', 'Status opened: a menu above the bar with New, In progress and Exists.'),
        ('mid', 'Exists picked: the menu lists the 4 features before -> after, "already Exists" where nothing changes, and "Change 4".'),
        ('mid-dark', 'The same preview in dark mode.'),
        ('result', '"Change 4" pressed: each row shows its new status, the picks clear, a toast says what changed with Undo. Cost: 5 clicks (today about 16).'),
        ('hard-1512', 'Hard case, 1512 wide, 14 picked with long names, dates +2 weeks: the preview shows 5 and "and 9 more", the menu scrolls.'),
        ('phone', 'Phone 390: the bar takes two rows (count, then the 4 fields); the menu opens full width above it.'),
     ])},
    {'letter': 'B', 'name': 'One edit sheet', 'recommended': False,
     'what': 'The bar holds a single "Edit 4 features" button. It opens a side sheet with all four fields (each left as "keep" until set) and a "What changes" list under them; one "Change 4" applies everything set.',
     'plus': 'Several fields in one go (owner and dates together) with one preview and one Undo.',
     'cost': 'Pick (2) + Edit (1) + 2 per field + Change (1): 6 clicks for one field, 8 for two.',
     'frames': fr('be2', 'b', [
        ('rest', 'At rest: 4 picked; the bar has one "Edit 4 features" button.'),
        ('open', 'The sheet opened on the right: Owner open, Status, Dates and Track on "keep".'),
        ('mid', 'Owner Rosa Lind and dates +2 weeks set: "What changes" lists each feature\'s owner and end date before -> after.'),
        ('result', '"Change 4" pressed: rows show Rosa Lind and their new dates, the sheet closes, a toast offers Undo. Cost: 8 clicks for two fields.'),
        ('hard-1512', 'Hard case, 1512 wide, 14 picked with long names: the preview is long and scrolls under the sheet\'s buttons; the list behind the sheet is hidden.'),
        ('phone', 'Phone 390: the sheet covers the whole screen; Owner set to Rosa Lind.'),
     ])},
    {'letter': 'C', 'name': 'Preview in the rows', 'recommended': False,
     'what': 'The bar is the same as A, but a field\'s menu only takes the value and closes; the preview is drawn in each picked row itself (old value struck, new value beside it) and the bar gets "Change 4".',
     'plus': 'The change is seen where the feature lives, next to its rank, goal and score.',
     'cost': 'Pick (2) + field (1) + value (1) + Change (1) = 5 clicks; checking picks that are off screen needs scrolling.',
     'frames': fr('be2', 'c', [
        ('rest', 'At rest: 4 picked, the same bar as A.'),
        ('open', 'Dates opened: shift by -2, -1, +1, +2 or +4 weeks.'),
        ('mid', '+2 weeks picked: the menu closes and each picked row shows its end date struck and the new one beside it; "Change 4" appears in the bar.'),
        ('result', '"Change 4" pressed: rows keep the new date in the edited colour, a toast offers Undo. Cost: 5 clicks.'),
        ('hard-1512', 'Hard case, 1512 wide, 14 picked with long names: only the picks on screen can be checked; 9 sit below the fold.'),
        ('phone', 'Phone 390: the preview is in each card; with long cards only one or two picks are on screen at a time.'),
     ])},
  ]})

D.append({
  'code': 'BE3', 'name': 'Mixed rights',
  'question': 'When some picked features will become proposals and some cannot be changed at all, how does the person know before and after applying?',
  'common': 'Rights come from each feature\'s own can_* fields: owners and approvers change at once, a commenter\'s change becomes a proposal to the approver (Avery Stone here), a locked feature is not changed. Shown with the BE2 A bar; 4 picked: two the person may change, Weekly alert digest F-79 (needs approval) and Alert routing by team (locked by Jonah Pike).',
  'proposals': [
    {'letter': 'A', 'name': 'Sorted preview', 'recommended': True,
     'what': 'Picked rows carry a small "Proposal" or "Cannot change" tag. The preview splits into "Changes now", "Sent to Avery Stone to approve" and "Not changed" (with an (i) saying why), and the button says "Change 2, propose 1". After applying, a strip reads "Status Exists: 2 changed · 1 sent to Avery Stone · 1 not changed"; each count highlights its rows, with Undo.',
     'why': 'Nothing surprises the person: they see the split before pressing and can find every item after, while all four stay pickable.',
     'plus': 'One apply for the whole mix; the counts lead to the rows they count.',
     'cost': 'The same 5 clicks as BE2 A; 1 more to see which rows were not changed.',
     'frames': fr('be3', 'a', [
        ('rest', 'At rest: 4 picked; Weekly alert digest is tagged "Proposal", Alert routing by team "Cannot change".'),
        ('open', 'Status opened.'),
        ('mid', 'Exists picked: the preview splits into Changes now 2, Sent to Avery Stone 1, Not changed 1; the button says "Change 2, propose 1".'),
        ('result', 'Applied: two rows show Exists, Weekly alert digest reads "Exists, waiting for Avery Stone", and the strip counts 2 changed, 1 sent, 1 not changed, each a button. Cost: 5 clicks.'),
        ('result-dark', 'The same result in dark mode.'),
        ('hard-1512', 'Hard case, 1512 wide, signed in as a commenter: every pick becomes a proposal, so the preview has one group and the button says "Propose 4 changes".'),
        ('phone', 'Phone 390: the result strip with its three counts above the list.'),
     ])},
    {'letter': 'B', 'name': 'Locked rows not pickable', 'recommended': False,
     'what': 'A feature the person cannot change shows a lock where its box would be (its tip says who locked it and why), so it is never picked. Proposals are picked as usual; the button says "Change 2, propose 1" and the toast says how many went to the approver.',
     'plus': 'Nothing is ever "not changed": the result is always all applied or proposed.',
     'cost': 'The same 5 clicks; a shift-click run skips locked rows silently.',
     'frames': fr('be3', 'b', [
        ('rest', 'At rest: 3 picked; Alert routing by team shows a lock instead of a box.'),
        ('open', 'Status opened.'),
        ('mid', 'Exists picked: a plain preview of the 3, and "Change 2, propose 1".'),
        ('result', 'Applied: a toast "2 changed, 1 sent to Avery Stone to approve" with Undo; Weekly alert digest reads "Exists, waiting for Avery Stone". Cost: 5 clicks.'),
        ('hard-1512', 'Hard case, 1512 wide, signed in as a commenter: every box stays (all can be proposed) and the button says "Propose 4 changes".'),
        ('phone', 'Phone 390: the result as a toast.'),
     ])},
    {'letter': 'C', 'name': 'Apply, then report', 'recommended': False,
     'what': 'No rights are shown before applying: the button says "Change 4". After it, a strip lists what was not changed, each with its reason and an "Ask Jonah Pike" button, and counts the proposals sent.',
     'plus': 'The plainest bar; the "why" and the way out sit together after the fact.',
     'cost': 'The same 5 clicks, plus 1 per locked feature to ask its owner.',
     'frames': fr('be3', 'c', [
        ('rest', 'At rest: 4 picked; no tags on the rows.'),
        ('open', 'Status opened.'),
        ('mid', 'Exists picked: a plain preview, "Change 4", nothing said about rights.'),
        ('result', 'Applied: the strip counts 2 changed, 1 sent, 1 not changed and lists Alert routing by team, "Locked by Jonah Pike for the Dec 15 board meeting", with "Ask Jonah Pike". Cost: 5 clicks + 1 to ask.'),
        ('hard-1512', 'Hard case, 1512 wide, signed in as a commenter: the button still says "Change 4"; only after pressing does the person learn all 4 went for approval.'),
        ('phone', 'Phone 390: the report strip with the Ask button.'),
     ])},
  ]})

json.dump({'title': 'Bulk edit owner, status and dates for several features',
           'subtitle': 'Mock-ups for the owner to pick from: how features are picked (BE1), the bulk bar (BE2), mixed rights (BE3). Priorities, ranked list, Simple; invented data.',
           'decisions': D}, open(os.path.join(OUT, 'picks.json'), 'w'), indent=2)
print('written')
