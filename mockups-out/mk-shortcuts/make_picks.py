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
 'common': 'Every proposal moves through rows with a key, opens the one feature panel with Enter, closes the top panel with Esc, moves a row with a key held with Shift (a commenter\'s move becomes a proposal, as dragging does today), and opens a sheet of keys from a Keys line above Ask Oracle. The sheet lists this page first. Keys are off on a phone and while typing (KS3). The version viewer\'s keys move onto the same layer unchanged.',
 'proposals': [
  {'letter': 'A', 'name': 'Single keys, numbered pages', 'recommended': False,
   'what': 'One key per action: j and k step through rows, Enter opens, Shift J and Shift K move a row, c adds, / finds, s switches Simple and Detailed, and the number keys 1 to 9 open the rail\'s pages in order. The sheet is a small card in the middle with two columns and no search.',
   'plus': 'The fewest keys of all: any page is one key away, and the whole set fits on one card.',
   'cost': 'Open the third feature: 3 keys (j j Enter) against 1 click today. Go to Roadmap: 1 key (3) against 1 click.',
   'frames': fr('ks1', 'a', [
     ('rest', 'Priorities at rest: the first row has the key focus; a Keys line with ? sits above Ask Oracle.'),
     ('open', 'Pressing ? opens a small card: this page and Everywhere on the left, the numbered pages on the right.'),
     ('mid', 'Card closed, j pressed twice: the focus is on Weekly alert digest. The strip at the bottom counts the keys.'),
     ('result', 'Enter opens Weekly alert digest in the feature panel: 3 keys against 1 click on the name today.'),
     ('hard-1512', 'The hard case, Detailed at 1512 in dark: the rail has 10 pages, so Settings gets no number, and adding a page renumbers the rest.'),
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
     ('hard-1512', 'The hard case, Detailed at 1512 in dark: every one of the 10 Detailed pages gets its own letter, and the list scrolls under the search box.'),
   ])},
  {'letter': 'C', 'name': 'Alt and Ctrl keys', 'recommended': False,
   'what': 'Every key is held with Alt or Ctrl: Alt and the arrows step through rows, Alt Enter opens, Alt Shift and the arrows move a row, Ctrl Alt and a number opens a page, Ctrl / opens the sheet. The sheet is a large table with every page\'s keys open at once.',
   'plus': 'A stray letter never fires anything, so it is the safest for people who type a lot or use a screen reader.',
   'cost': 'Open the third feature: Alt ↓, Alt ↓, Alt Enter, 6 keys held in pairs, against 1 click. Go to Roadmap: Ctrl Alt 3, 3 keys at once.',
   'frames': fr('ks1', 'c', [
     ('rest', 'Priorities at rest: the first row has the key focus; the Keys line shows Ctrl / instead of ?.'),
     ('open', 'Ctrl / opens a wide table: this page, Go to, Everywhere and every other page, all open at once.'),
     ('mid', 'Table closed, Alt ↓ twice: the focus is on Weekly alert digest.'),
     ('result', 'Alt Enter opens Weekly alert digest in the feature panel: 6 key presses against 1 click.'),
     ('hard-1512', 'The hard case, Detailed at 1512 in dark: the table needs most of the screen, and Ctrl Alt with a number is AltGr on many European keyboards.'),
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
     ('hard-1512', 'The hard case, Detailed at 1512 in dark: typing "pl" leaves Go to Plan (6) and Switch to Simple; Plan\'s key is a number that changes when the rail changes.'),
   ])},
 ]}

KS2 = {
 'code': 'KS2', 'name': 'Teaching the keys, showing the focus',
 'question': 'How does a person learn the keys in place, and how does the focused row look?',
 'common': 'Every proposal uses the keys of KS1 B, shows one focused row at a time on Priorities (and the same on list rows and timeline rows elsewhere), keeps the ? sheet, and adds no paragraph of help.',
 'proposals': [
  {'letter': 'A', 'name': 'Keys in tooltips', 'recommended': True,
   'what': 'The tooltips a person already gets on hover carry the key beside the name: Roadmap g then r in the rail, Open Enter on a row\'s name, Close Esc on the panel. The focused row gets a blue bar on its left and a light blue fill.',
   'why': 'It teaches at the moment of use, costs no space and no new text on the page, and the bar reads clearly in light and dark without hiding a row\'s own outline or the drag grip.',
   'plus': 'For a commenter the grip\'s tooltip says Suggest a move, so the key tells what it will do for that role.',
   'cost': 'Nothing extra on screen. Open the third feature: 3 keys (j j Enter) against 1 click.',
   'frames': fr('ks2', 'a', [
     ('rest', 'At rest: the first row has the key focus, a blue bar on its left and a light fill.'),
     ('open', 'Hovering Roadmap in the rail: its tooltip shows g then r.'),
     ('mid', 'After j j the focus is on Weekly alert digest; hovering its name shows Open Enter.'),
     ('result', 'Enter opens it in the feature panel; hovering Close shows Esc. 3 keys against 1 click.'),
     ('hard-1512', 'The hard case, a commenter at 1512 in dark: the grip\'s tooltip reads Suggest a move, Shift J or Shift K, since a commenter\'s move becomes a proposal.'),
   ])},
  {'letter': 'B', 'name': 'Key chips on hover', 'recommended': False,
   'what': 'Hovering a row shows small key chips at its right end: Enter open, Shift J and Shift K move. The focused row gets a blue ring around the whole card.',
   'plus': 'The keys for a row are visible without waiting for a tooltip.',
   'cost': 'Nothing to press to learn; open the second feature: 2 keys (j Enter) against 1 click.',
   'frames': fr('ks2', 'b', [
     ('rest', 'At rest: the first row has the key focus, a blue ring around the card.'),
     ('open', 'Hovering Weekly alert digest: key chips appear at the end of its row.'),
     ('mid', 'j moves the ring to Alert rules engine; the chips stay on the hovered row.'),
     ('result', 'Enter opens Alert rules engine in the feature panel: 2 keys against 1 click.'),
     ('hard-1512', 'The hard case, long names at 1512 in dark: the chips cover the goal, value and score of the row they sit on.'),
   ])},
  {'letter': 'C', 'name': 'A first-use nudge', 'recommended': False,
   'what': 'After a person opens rows with the mouse a few times, a small card in the corner shows j k, Enter and ?, lights each key as it is used, and goes away with Got it. The focused row gets a light fill only.',
   'plus': 'It reaches people who never hover, once, and then stays out of the way.',
   'cost': 'One card to dismiss once; after that the same keys as A.',
   'frames': fr('ks2', 'c', [
     ('rest', 'At rest: nobody has pressed a key yet, so no row has the focus.'),
     ('open', 'After a third open with the mouse, the card appears bottom right: j k, Enter, ?, Not now and Got it.'),
     ('mid', 'Pressing j: the first row fills light blue and the j in the card lights up.'),
     ('result', 'Got it closes the card for good; the focus stays on the first row.'),
     ('hard-1512', 'The hard case at 1512 in dark: with the feature panel open the card sits on top of the panel\'s last lines.'),
   ])},
  {'letter': 'D', 'name': 'A key bar at the bottom', 'recommended': False,
   'what': 'A slim bar along the bottom of every page lists that page\'s keys, lights the last key pressed, and switches to the panel\'s keys when a panel is open. It can be hidden. The focused row gets a grey fill and a soft ring.',
   'plus': 'The keys are always in sight, so nobody has to remember them.',
   'cost': 'One line of screen on every page, always. Open the second feature: 2 keys (j Enter).',
   'frames': fr('ks2', 'd', [
     ('rest', 'At rest: the key bar along the bottom lists j, k, Enter, Shift J, g r and ?.'),
     ('open', 'Pressing ? opens the sheet over the page; the bar stays.'),
     ('mid', 'j moves the focus to Alert rules engine and lights j in the bar.'),
     ('result', 'Enter opens the feature panel; the bar now lists the panel\'s keys: Esc, j, k, ?.'),
     ('hard-1512', 'The hard case, long names at 1512 in dark: the bar covers the foot of the panel and the last row, and adds text to every page.'),
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
     ('result', 'Esc leaves the field; the text waits with Save and Cancel, and the panel stays open.'),
     ('hard-1512', 'The hard case, a dialog at 1512 in dark: Shift J opens Move Mobile alert push to rank 5; typing jk lands in its Reason field and nothing behind moves.'),
     ('phone-390', 'Phone 390: no keys; the feature panel has previous and next buttons beside its menu.'),
   ])},
  {'letter': 'B', 'name': 'Ctrl Enter saves and goes on', 'recommended': False,
   'what': 'Plain keys type in a field, as in A. Ctrl Enter, already the save key in Oracle\'s comment and answer boxes, saves the field and opens the next feature in the panel, so a person can fill one field down the whole list. In a dialog Ctrl Enter confirms it. Phones are unchanged.',
   'plus': 'The quickest way to fill notes, owners or reasons for many features in a row.',
   'cost': 'Fill notes for the next feature: type, then 2 keys (Ctrl Enter) against Save, a click on the next row and Change: 3 clicks.',
   'frames': fr('ks3', 'b', [
     ('rest', 'At rest: Weekly alert digest is open in the feature panel.'),
     ('open', 'Change on Notes opens the field.'),
     ('mid', 'Typing "Ask two beta teams first jk" fills the field.'),
     ('result', 'Ctrl Enter saves the note (the saved toast shows) and opens the next feature, Mobile alert push.'),
     ('hard-1512', 'The hard case, a dialog at 1512 in dark: Shift J, a reason, then Ctrl Enter moves Mobile alert push to rank 5 at once.'),
     ('phone-390', 'Phone 390: nothing changes; the panel is as today.'),
   ])},
  {'letter': 'C', 'name': 'Keys off, shown', 'recommended': False,
   'what': 'While a field has the cursor a small tag under it says the keys are off; Esc leaves the field as in A. In a dialog, ? (outside its field) shows only that dialog\'s keys. On a phone a sideways swipe on the panel goes to the next feature.',
   'plus': 'A person always sees why a key did nothing.',
   'cost': 'Same keys as A; one more tag on screen while typing, and a gesture on the phone that has to be found.',
   'frames': fr('ks3', 'c', [
     ('rest', 'At rest: Weekly alert digest is open in the feature panel.'),
     ('open', 'Change on Notes opens the field; a tag under it shows the keys are off while typing.'),
     ('mid', 'Typing "Ask two beta teams first jk" goes into the field; the tag stays.'),
     ('result', 'Esc leaves the field; the tag goes and the panel stays.'),
     ('hard-1512', 'The hard case, a dialog at 1512 in dark: Tab to its buttons, then ? shows only this box\'s keys: Enter, Esc, Tab.'),
     ('phone-390', 'Phone 390: a swipe hint over the panel; sliding sideways goes to the next feature.'),
   ])},
 ]}

json.dump({'title': 'App-wide keyboard shortcuts and a help sheet',
           'subtitle': 'Issue #1795 · mock-ups on Priorities in Simple and Detailed, light and dark, 1440, 1512 and phone 390 · invented data',
           'decisions': [KS1, KS2, KS3]}, open('picks.json', 'w'), indent=1, ensure_ascii=False)
print('ok')
