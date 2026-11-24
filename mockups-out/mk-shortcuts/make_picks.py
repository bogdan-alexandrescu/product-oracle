"""MOCK-HOOK: writes picks.json for the owner's pick page."""
import json, os

def fr(code, o, items):
    out = []
    for state, cap in items:
        f = f'{code}-{o}-{state}.html'
        assert os.path.exists('frames/' + f), f
        out.append({'file': f, 'caption': cap})
    return out

KS1 = {
 'code': 'KS1', 'name': 'The keys and the help sheet',
 'question': 'Which keys does Oracle use, and how does the ? sheet lay them out?',
 'common': 'Every proposal moves through rows with a key, opens the one feature panel with Enter, closes the top panel with Esc, moves a row with a key held with Shift (a commenter\'s move becomes a proposal, as dragging does today), and opens a sheet of keys from a Keys line: above Ask Oracle in Simple\'s rail, above Settings in Detailed\'s (with KS2 D\'s bottom bar, its ? All keys takes the Keys line\'s place). The sheet lists this page first. A viewer sees move and add struck out as view only; a commenter\'s move reads Suggest a move and add reads Suggest an item. On a phone the Keys line sits in More only when a keyboard is plugged in, and keys are off while typing (KS3). The version viewer\'s keys move onto the same layer unchanged.',
 'proposals': [
  {'letter': 'A', 'name': 'Single keys, numbered pages', 'recommended': False,
   'what': 'One key per action: j and k step through rows, Enter opens, Shift J and Shift K move a row, c adds, / finds, s switches Simple and Detailed, and the number keys 1 to 9 open the rail\'s pages in order. The sheet is a small card in the middle with two columns and no search.',
   'plus': 'The fewest keys of all: any page is one key away, and the whole set fits on one card.',
   'cost': 'Open the third feature: 3 keys (j j Enter) against 1 click today. Go to Roadmap: 1 key (3) against 1 click.',
   'frames': fr('ks1', 'a', [
     ('rest', 'Priorities at rest: the first row has the key focus; a Keys line with ? sits above Ask Oracle.'),
     ('open', 'Pressing ? opens a small card: this page and Everywhere on the left, the numbered pages on the right.'),
     ('mid', 'Card closed, j pressed twice: the focus is on Weekly alert digest. The dashed strip at the top counts every key pressed.'),
     ('result', 'Enter opens Weekly alert digest in the feature panel: 3 keys against 1 click on the name today.'),
     ('hard-1512', 'The hard case, Detailed at 1512 in dark: the Keys line sits above Settings; the rail has 10 pages, so Settings gets no number, and adding a page renumbers the rest.'),
     ('phone-390', 'Phone 390 with a keyboard: the card drops to one column and scrolls.'),
   ])},
  {'letter': 'B', 'name': 'Letters after g', 'recommended': True,
   'what': 'The same single keys for the page (j, k, Enter, Shift J and K, c, /, Esc, ?), and pages by g then a letter: g r Roadmap, g p Priorities, g m Goal map, g d Decisions, g i Inbox. The sheet slides in on the right, has a search box, shows this page first and folds other pages\' keys under their names.',
   'why': 'Letters stay put when the rail changes and read as the page\'s name; every Detailed page gets one; people coming from Linear, Jira or GitHub already know g then a letter; and the search finds a key by its word, so the long Detailed list stays usable.',
   'plus': 'The sheet scales from Simple\'s 8 pages to Detailed\'s 10 and to new pages without renumbering.',
   'cost': 'Go to Roadmap: 2 keys (g r) against 1 click. Open the third feature: 3 keys (j j Enter) against 1 click.',
   'frames': fr('ks1', 'b', [
     ('rest', 'Priorities at rest: the first row has the key focus; the Keys line with ? sits above Ask Oracle.'),
     ('open', 'Pressing ? slides the sheet in on the right with a search box: this page, Go to (g then a letter), Everywhere, then other pages folded.'),
     ('mid', 'Typing "road" in the sheet leaves Roadmap (g then r) and Goal map\'s "Search the roadmap".'),
     ('result', 'Sheet closed, g then r pressed: Roadmap opens. 2 keys against 1 click in the rail today.'),
     ('hard-1512', 'The hard case, Detailed at 1512 in dark: opened from the Keys line above Settings, every Detailed page gets a letter, but some are hard to guess (g u Runs, g l Plan, g f PRDs, g t Ground Truth), and g c Company sits beside c for Add.'),
     ('viewer', 'A viewer opens the sheet: moving rows and adding are struck out as view only; the rest works. The rail\'s counts are what waits on this person, so they are smaller than the owner\'s.'),
     ('commenter', 'A commenter opens the sheet: the move keys read Suggest a move and c reads Suggest an item, since a commenter\'s edits become proposals, as they do today. The rail\'s counts are what waits on this person, so they are smaller than the owner\'s.'),
     ('phone-390', 'Phone 390 with a keyboard: the sheet fills the screen, search box first.'),
   ])},
  {'letter': 'C', 'name': 'Alt and Ctrl keys', 'recommended': False,
   'what': 'Every key is held with Alt or Ctrl: Alt and the arrows step through rows, Alt Enter opens, Alt Shift and the arrows move a row, Ctrl Alt and a number opens a page, Ctrl / opens the sheet, Ctrl K searches (Ctrl F stays the browser\'s own find; Oracle takes Ctrl K only on its own pages, as Chrome also uses it for the address bar), Alt V switches Simple and Detailed. The sheet is a large table with every page\'s keys open at once.',
   'plus': 'A stray letter never fires anything, so it is the safest for people who type a lot or use a screen reader.',
   'cost': 'Open the third feature: 6 keys (Alt ↓, Alt ↓, Alt Enter, held in pairs) against 1 click. Go to Roadmap: 3 keys (Ctrl Alt 3, held together).',
   'frames': fr('ks1', 'c', [
     ('rest', 'Priorities at rest: the first row has the key focus; the Keys line shows Ctrl / instead of ?.'),
     ('open', 'Ctrl / opens a wide table: this page, Go to, Everywhere and every other page, all open at once.'),
     ('mid', 'Table closed, Alt ↓ twice: the focus is on Weekly alert digest.'),
     ('result', 'Alt Enter opens Weekly alert digest in the feature panel: 6 keys against 1 click.'),
     ('hard-1512', 'The hard case, Detailed at 1512 in dark: the Keys line above Settings stacks the icon, Keys and Ctrl / on one line, like the other rail items, and costs a rail slot; the table needs most of the screen, and Ctrl Alt with a number is AltGr on many European keyboards.'),
     ('phone-390', 'Phone 390 with a keyboard: the three columns stack into one long list; search is Ctrl K, so Ctrl F stays the browser\'s own find; Oracle takes Ctrl K only on its own pages.'),
   ])},
  {'letter': 'D', 'name': 'A list you type into', 'recommended': False,
   'what': 'The keys are those of A, but ? opens a list you type into: type a few letters of any action or page, Enter runs it. Each line shows its key, so the list teaches the key while it runs the action.',
   'plus': 'Nothing to learn first: anyone can reach any action by its name, and it doubles as a quick page switcher.',
   'cost': 'Go to Roadmap through the list: 6 keys (? r o a d Enter), or 1 key (3) once learnt, against 1 click.',
   'frames': fr('ks1', 'd', [
     ('rest', 'Priorities at rest: the first row has the key focus; the Keys line with ? sits above Ask Oracle.'),
     ('open', 'Pressing ? opens a list at the top with a box to type in, the first line picked.'),
     ('mid', 'Typing "road" leaves Go to Roadmap (key 3) and Search the roadmap (key /).'),
     ('result', 'Enter runs the picked line: Roadmap opens. 6 keys this time, 1 key (3) once learnt.'),
     ('hard-1512', 'The hard case, Detailed at 1512 in dark, Ask Oracle docked on the right as at this width today: typing "pl" leaves Go to Plan (6) and Switch to Simple; Plan\'s key is a number that changes when the rail changes.'),
     ('phone-390', 'Phone 390 with a keyboard: the list sits at the top, full width.'),
   ])},
 ]}

KS2 = {
 'code': 'KS2', 'name': 'Teaching the keys, showing the focus',
 'question': 'How does a person learn the keys in place, and how does the focused row look?',
 'common': 'Every proposal uses the keys of KS1 B, shows one focused row at a time on Priorities in Simple and Detailed (and the same on list rows and timeline rows elsewhere), keeps the ? sheet, and adds no paragraph of help. On a phone no key hints show; with a keyboard plugged in, the focus look appears.',
 'proposals': [
  {'letter': 'A', 'name': 'Keys in tooltips', 'recommended': True,
   'what': 'The tooltips a person already gets on hover carry the key beside the name: Roadmap g then r in the rail, Open Enter on a row\'s name, Close Esc on the panel. The focused row gets a blue bar on its left and a light blue fill.',
   'why': 'It teaches at the moment of use, costs no space and no new text on the page, and the bar reads clearly in light and dark without hiding a row\'s own outline or the drag grip.',
   'plus': 'For a commenter the grip\'s tooltip says Suggest a move, so the key tells what it will do for that role.',
   'cost': 'Nothing extra on screen. Open the third feature: 3 keys (j j Enter) against 1 click.',
   'frames': fr('ks2', 'a', [
     ('rest', 'At rest: the first row has the key focus, a blue bar on its left and a light fill.'),
     ('open', 'Hovering Roadmap in the rail: its tooltip, inside the rail after the name, shows g then r over the count until the pointer leaves.'),
     ('mid', 'After j j the focus is on Weekly alert digest; hovering its name shows Open Enter beside the name line.'),
     ('result', 'Enter opens it in the feature panel; hovering Close shows Esc under it. 3 keys against 1 click.'),
     ('hard-1512', 'The hard case, a commenter at 1512 in dark: hovering Weekly alert digest\'s grip, the tooltip at the free end of its second line reads Suggest a move, Shift J or Shift K, since a commenter\'s move becomes a proposal. The rail\'s counts are what waits on this person, so they are smaller than the owner\'s.'),
     ('viewer', 'A viewer\'s rows have no grip; the tip beside the row\'s name says view only, with no key; j, k and Enter still work. The rail\'s counts are what waits on this person, so they are smaller than the owner\'s.'),
     ('detailed', 'Detailed: the focused row takes the table\'s own selected look, the same row the panel shows.'),
     ('phone-390', 'Phone 390: no tooltips; with a keyboard the first row shows the blue bar.'),
   ])},
  {'letter': 'B', 'name': 'Key chips on hover', 'recommended': False,
   'what': 'Hovering a row shows small key chips at its right end: Enter open, Shift J and Shift K move. The focused row gets a blue ring around the whole card.',
   'plus': 'The keys for a row are visible without waiting for a tooltip.',
   'cost': 'Nothing to press to learn; open the second feature: 2 keys (j Enter) against 1 click.',
   'frames': fr('ks2', 'b', [
     ('rest', 'At rest: the first row has the key focus, a blue ring around the card.'),
     ('open', 'Hovering Weekly alert digest: key chips appear in the free right end of its second line.'),
     ('mid', 'j moves the ring to Alert rules engine; the chips stay on the hovered row.'),
     ('result', 'Enter opens Alert rules engine in the feature panel: 2 keys against 1 click.'),
     ('hard-1512', 'The hard case, long names at 1512 in dark: a one-line row has no free end, so the chips cover its value and score.'),
     ('phone-390', 'Phone 390: no hover, so no chips; with a keyboard the first row shows the ring.'),
   ])},
  {'letter': 'C', 'name': 'A first-use nudge', 'recommended': False,
   'what': 'After a person opens rows with the mouse a few times, a small card in the corner shows j k, Enter and ?, lights each key as it is used, and goes away with Got it. The focused row gets a light fill only.',
   'plus': 'It reaches people who never hover, once, and then stays out of the way.',
   'cost': 'One card to dismiss once; after that the same keys as A.',
   'frames': fr('ks2', 'c', [
     ('rest', 'At rest: nobody has pressed a key yet, so no row has the focus.'),
     ('open', 'After a third open with the mouse, the card appears bottom right: j k, Enter, ?, Not now and Got it.'),
     ('mid', 'Pressing j: the first row fills light blue and the j in the card lights up.'),
     ('result', 'Got it: the card is gone and the focus stays on the first row.'),
     ('hard-1512', 'The hard case at 1512 in dark: with the feature panel open the card sits on top of the panel\'s last lines.'),
     ('phone-390', 'Phone 390: no card on a phone; with a keyboard the first row fills light blue.'),
   ])},
  {'letter': 'D', 'name': 'A key bar at the bottom', 'recommended': False,
   'what': 'A slim bar along the bottom of every page lists that page\'s keys, lights the last key pressed, and switches to the panel\'s keys when a panel is open. It can be hidden. The focused row gets a grey fill and a soft ring.',
   'plus': 'The keys are always in sight, so nobody has to remember them.',
   'cost': 'One line of screen on every page, always. Open the second feature: 2 keys (j Enter).',
   'frames': fr('ks2', 'd', [
     ('rest', 'At rest: the key bar along the bottom lists j, k, Enter, Shift J, g r and ?.'),
     ('open', 'Pressing ? opens the sheet; the bar hides while it is open, so no key shows twice.'),
     ('mid', 'j moves the focus to Alert rules engine and lights j in the bar.'),
     ('result', 'Enter opens the feature panel; the bar now lists the panel\'s keys: Esc, j, k, ?.'),
     ('hard-1512', 'The hard case, long names at 1512 in dark: the bar covers the foot of the panel and the last row, and adds text to every page.'),
     ('phone-390', 'Phone 390: no bar on a phone; with a keyboard the first row gets the grey fill.'),
   ])},
 ]}

KS3 = {
 'code': 'KS3', 'name': 'Typing, dialogs and phones',
 'question': 'What do the keys do while typing in a field, inside a dialog, and on a phone?',
 'common': 'In every proposal a plain letter typed in a field goes into the field, Ctrl J stays Ask Oracle (it already is), and a dialog keeps its own Enter, Esc and Tab. Today one Esc in the feature panel\'s Notes field closes the whole panel.',
 'proposals': [
  {'letter': 'A', 'name': 'Esc steps out first', 'recommended': True,
   'what': 'Every key types while a field has the cursor. Esc leaves the field first and keeps what was typed with its Save and Cancel; a second Esc closes the panel. In a dialog only the dialog\'s keys work: letters go into its field and nothing behind it moves. On a phone there are no keys; the feature panel gets previous and next buttons that step through features in the same order j and k do.',
   'why': 'One rule for every field and dialog, no lost typing on a stray Esc, and the phone gets the same "next feature" step with a thumb.',
   'plus': 'Fixes today\'s loss: one Esc no longer closes the panel with the typing in it.',
   'cost': 'Leave a field and close the panel: 2 keys (Esc Esc) against 1 today, which also drops the field.',
   'frames': fr('ks3', 'a', [
     ('rest', 'At rest: Weekly alert digest is open in the feature panel after Enter on its row.'),
     ('open', 'Change on Notes opens the field with the cursor in it.'),
     ('mid', 'Typing "Ask two beta teams first jk": j and k go into the field; the focus on the rows does not move.'),
     ('result', 'Esc (1 key) leaves the field; the text waits with Save and Cancel, and the panel stays open. A second Esc would close it.'),
     ('hard-1512', 'The hard case, a dialog at 1512 in dark: Shift J opens Move Mobile alert push to rank 5; typing jk lands in its Reason field and nothing behind moves.'),
     ('phone-390', 'Phone 390, Weekly alert digest open: no keys; thumb-sized previous and next buttons sit beside the panel\'s menu and cut the title short.'),
   ])},
  {'letter': 'B', 'name': 'Ctrl Enter saves and goes on', 'recommended': False,
   'what': 'Plain keys type in a field, as in A. Ctrl Enter, already the save key in Oracle\'s comment and answer boxes, saves the field and opens the next feature in the panel, so a person can fill one field down the whole list. In a dialog Ctrl Enter confirms it. Phones are unchanged.',
   'plus': 'The quickest way to fill notes, owners or reasons for many features in a row.',
   'cost': 'Fill notes for the next feature: type, then 2 keys (Ctrl Enter) against Save, a click on the next row and Change: 3 clicks. Confirm a dialog: 2 keys (Ctrl Enter).',
   'frames': fr('ks3', 'b', [
     ('rest', 'At rest: Weekly alert digest is open in the feature panel.'),
     ('open', 'Change on Notes opens the field.'),
     ('mid', 'Typing "Ask two beta teams first jk" fills the field.'),
     ('result', 'Ctrl Enter (2 keys) saves the note to the working draft (the toast says so) and opens the next feature, Mobile alert push.'),
     ('hard-1512', 'The hard case, a dialog at 1512 in dark: Shift J (2 keys) opens Move Mobile alert push to rank 5, a reason is typed; Ctrl Enter next would confirm it.'),
     ('phone-390', 'Phone 390, Weekly alert digest open: nothing changes; the panel is as today.'),
   ])},
  {'letter': 'C', 'name': 'Keys off, shown', 'recommended': False,
   'what': 'While a field has the cursor a small tag beside its Save and Cancel says the keys are off; Esc leaves the field as in A. In a dialog, ? (outside its field) shows only that dialog\'s keys. On a phone a sideways swipe on the panel goes to the next feature.',
   'plus': 'A person always sees why a key did nothing.',
   'cost': 'Same keys as A; one more tag on screen while typing, and a gesture on the phone that has to be found.',
   'frames': fr('ks3', 'c', [
     ('rest', 'At rest: Weekly alert digest is open in the feature panel.'),
     ('open', 'Change on Notes opens the field; a tag on the Save and Cancel line, level with the field\'s right edge, shows the keys are off while typing.'),
     ('mid', 'Typing "Ask two beta teams first jk" goes into the field; the tag stays.'),
     ('result', 'Esc leaves the field; the tag goes and the panel stays.'),
     ('hard-1512', 'The hard case, a dialog at 1512 in dark: Tab to its buttons, then ? (2 keys) shows only this box\'s keys in a card beside it: Enter, Esc, Tab.'),
     ('phone-390', 'Phone 390, Weekly alert digest open: a swipe hint at the foot of the panel, over the Confidence line until it fades; sliding sideways goes to the next feature.'),
   ])},
 ]}

json.dump({'title': 'App-wide keyboard shortcuts and a help sheet',
           'subtitle': 'Issue #1795 · mock-ups on Priorities in Simple and Detailed, light and dark, 1440, 1512 and phone 390, as owner, commenter and viewer · invented data · the dashed Cost strip is a mock-up note counting every key pressed',
           'decisions': [KS1, KS2, KS3]}, open('picks.json', 'w'), indent=1, ensure_ascii=False)
print('ok')
