# MOCK-HOOK: whole file. Writes frames.json (what capture.spec.ts snapshots) and picks.json.
import json, os
D, W, P = [1440, 900], [1512, 900], [390, 844]
HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, '../../../mockups-out/mk-mentions')
frames = []

def fr(code, letter, state, q, size, caption, role='owner', page=None, scroll=None):
    suffix = '-1512' if size == W else '-390' if size == P else ''
    f = f"{code}-{letter}-{state}{suffix}"
    frames.append({'file': f, 'q': f"{code}={letter}" + (f"&{q}" if q else ''), 'size': size, 'role': role, **({'page': page} if page else {}), **({'scroll': scroll} if scroll else {})})
    return {'file': f + '.html', 'caption': caption}

MA1 = [
 dict(letter='a', name='One stream, filter', recommended=True,
  what='One Activity section at the end of the panel: the comment field on top, then comments and changes together, newest first. Three chips (All, Comments, Changes) narrow it in one click.',
  why='Most questions about a feature are "what happened and why": a date moved and the comment that explains it sit side by side. One click narrows it; nothing is hidden by default.',
  plus='Reads as one story; the field is always one scroll away; no new view.',
  cost='Seeing changes: 0 clicks (they are in the stream) or 1 click on Changes. Today: Open the detailed view, find History, 3 clicks and a page change.',
  frames=lambda l: [
   fr('ma1', l, 'rest', '', D, 'At rest: Activity under the panel\'s details, the field on top, comments and changes mixed, newest first.'),
   fr('ma1', l, 'open', 'open=1', D, 'Changes chip picked: only who changed what, 7 lines.'),
   fr('ma1', l, 'mid', 'phase=mid', D, 'Back on All, typing a comment in the field.', scroll='field'),
   fr('ma1', l, 'done', 'phase=done', D, 'Sent with Enter: the comment tops the stream. Cost: 1 click, the text, Enter.'),
   fr('ma1', l, 'hard', 'hard=1', W, 'Hard case at 1512: 200 events. Day headings, 20 shown, Show 20 more.'),
   fr('ma1', l, 'phone', '', P, 'Phone 390: the same section at the end of the sheet.'),
  ]),
 dict(letter='b', name='Two tabs', recommended=False,
  what='The panel\'s Comments become two tabs: Comments (as today, oldest first, field at the end) and History (changes only, newest first).',
  plus='Comments look exactly as today; history never pushes comments down.',
  cost='Seeing changes: 1 click on History. Linking a change to the comment about it: switch tabs and compare.',
  frames=lambda l: [
   fr('ma1', l, 'rest', '', D, 'At rest: Comments tab, as today, with History beside it.'),
   fr('ma1', l, 'open', 'open=1', D, 'History tab opened: changes only, newest first.'),
   fr('ma1', l, 'mid', 'phase=mid', D, 'Back on Comments, typing at the end of the list.', scroll='field'),
   fr('ma1', l, 'done', 'phase=done', D, 'Sent: the comment lands last in the list. Cost: 1 click, the text, Enter; History is a second click.', scroll='field'),
   fr('ma1', l, 'hard', 'hard=1&open=1', W, 'Hard case at 1512: History with 200 events, 20 at a time.'),
   fr('ma1', l, 'phone', '', P, 'Phone 390: the two tabs at the end of the sheet.'),
  ]),
 dict(letter='c', name='History folded under', recommended=False,
  what='Comments stay as today; under the field a fold, Show 7 changes, opens the history below them.',
  plus='The smallest change to today\'s panel; history is there for whoever looks.',
  cost='Seeing changes: 1 click on the fold, then scroll past every comment.',
  frames=lambda l: [
   fr('ma1', l, 'rest', '', D, 'At rest: comments as today, Show 7 changes folded under the field.'),
   fr('ma1', l, 'open', 'open=1', D, 'The fold opened: changes listed under the comments.'),
   fr('ma1', l, 'mid', 'phase=mid', D, 'Typing a comment in the field above the fold.', scroll='field'),
   fr('ma1', l, 'done', 'phase=done', D, 'Sent: the comment joins the list; the fold stays shut. Cost: 1 click, the text, Enter.', scroll='field'),
   fr('ma1', l, 'hard', 'hard=1&open=1', W, 'Hard case at 1512: 33 comments to scroll past before the 167 changes start.'),
   fr('ma1', l, 'phone', '', P, 'Phone 390: comments then the fold, at the end of the sheet.'),
  ]),
 dict(letter='d', name='Activity beside the panel', recommended=False,
  what='The panel keeps only an Activity button with its count. It opens a second card beside the feature panel holding the one stream, so details and activity show side by side.',
  plus='The panel stays short; on a wide screen details and activity are both in view.',
  cost='Everything costs 1 extra click; on a phone the second card covers the feature panel.',
  frames=lambda l: [
   fr('ma1', l, 'rest', '', D, 'At rest: one Activity button with its count, at the end of the panel.'),
   fr('ma1', l, 'open', 'open=1', D, 'Activity opened in a card beside the feature panel.'),
   fr('ma1', l, 'mid', 'phase=mid', D, 'Typing a comment in the side card.'),
   fr('ma1', l, 'done', 'phase=done', D, 'Sent: the comment tops the side card. Cost: 2 clicks, the text, Enter.'),
   fr('ma1', l, 'hard', 'hard=1', W, 'Hard case at 1512: 200 events in the side card; two cards cover most of the roadmap.'),
   fr('ma1', l, 'phone', 'open=1', P, 'Phone 390: the side card becomes a second sheet over the panel.'),
  ]),
]

MA2 = [
 dict(letter='a', name='@ picker, Inbox', recommended=True,
  what='Typing @ opens a list of company members by name and role; arrows and Enter pick one. Sent, the name reads as a tinted name in the comment. The person gets a Mentions row in their Inbox, counted in the rail\'s Inbox number, with Reply and Done.',
  why='Uses the one place people already look for what waits on them; no email shown, no new icon; picking is four keys.',
  plus='Fast for people who know @ from other tools; mentions are counted with everything else.',
  cost='Mention: @, 2 or 3 letters, Enter (about 4 keys). The mentioned person: 1 click on Inbox, where they already go.',
  frames=lambda l: [
   fr('ma2', l, 'rest', '', D, 'At rest: the field says @ mentions someone.'),
   fr('ma2', l, 'open', 'open=1', D, 'Typed @: members by name and role, never an email address.'),
   fr('ma2', l, 'mid', 'phase=mid', D, 'Typed @pri: one match, Enter picks it.'),
   fr('ma2', l, 'done', 'phase=done', D, 'Sent: Priya Raman reads as a tinted name. Cost: about 4 keys.'),
   fr('ma2', l, 'learn', '', D, 'Priya\'s Inbox: Avery mentioned you, with the comment, Reply and Done.', role='approver', page='inbox'),
   fr('ma2', l, 'hard', 'hard=1&phase=mid&role=commenter', W, 'Hard case at 1512, as a commenter: @Sam matches 4 people with long names; roles tell them apart.', role='commenter'),
   fr('ma2', l, 'phone', 'open=1', P, 'Phone 390: the list opens under the field.'),
  ]),
 dict(letter='b', name='Notify button, no @', recommended=False,
  what='No typing syntax: a Notify chip above the field opens a find-a-person box. Picked people show as chips; sent, the comment starts with To and their names. They get a Sent to you row in their Inbox.',
  plus='Nothing to learn; a name can never be mis-typed inside the text.',
  cost='Mention: click Notify, 3 letters, click the name (2 clicks, 3 keys). The person: 1 click on Inbox.',
  frames=lambda l: [
   fr('ma2', l, 'rest', '', D, 'At rest: a Notify chip above the field.'),
   fr('ma2', l, 'open', 'open=1', D, 'Notify opened: find a person, by name and role.'),
   fr('ma2', l, 'mid', 'phase=mid', D, 'Typed pri: Priya Raman picked shows as a chip.'),
   fr('ma2', l, 'done', 'phase=done', D, 'Sent: the comment starts To Priya Raman. Cost: 2 clicks, 3 keys.'),
   fr('ma2', l, 'learn', '', D, 'Priya\'s Inbox: Sent to you, with Reply and Done.', role='approver', page='inbox'),
   fr('ma2', l, 'hard', 'hard=1&phase=mid&role=commenter', W, 'Hard case at 1512, as a commenter: Sam finds 4 people.', role='commenter'),
   fr('ma2', l, 'phone', 'open=1', P, 'Phone 390: the find box over the field.'),
  ]),
 dict(letter='c', name='@ picker, bell', recommended=False,
  what='The same @ list, but a sent mention reads as bold @Name, and the person learns of it from a new bell in the page corner with its own count and list, apart from the Inbox.',
  plus='Mentions never mix with decisions and proposals that wait in the Inbox.',
  cost='Mention: about 4 keys. The person: a second place to check, 1 click on the bell; the product has no bell today.',
  frames=lambda l: [
   fr('ma2', l, 'rest', '', D, 'At rest: the field says @ mentions someone.'),
   fr('ma2', l, 'open', 'open=1', D, 'Typed @: members by name and role.'),
   fr('ma2', l, 'mid', 'phase=mid', D, 'Typed @pri: one match.'),
   fr('ma2', l, 'done', 'phase=done', D, 'Sent: @Priya Raman in bold. Cost: about 4 keys.'),
   fr('ma2', l, 'learn', '', D, 'Priya sees a new bell with 2, its list open; the Inbox count does not change.', role='approver', page='inbox'),
   fr('ma2', l, 'hard', 'hard=1&phase=mid&role=commenter', W, 'Hard case at 1512, as a commenter: @Sam matches 4 people.', role='commenter'),
   fr('ma2', l, 'phone', 'open=1', P, 'Phone 390: the list under the field.'),
  ]),
]

MA3 = [
 dict(letter='a', name='One sentence a line', recommended=True,
  what='Each change is one sentence: who, changed what, from (grey) to (bold), when. A commenter\'s change says proposed and who accepted it; Oracle\'s says Oracle. A change that can be undone has Undo; undoing adds its own line. Long history: day headings, 20 at a time.',
  why='Reads aloud like what happened; before and after on one line; undo sits on the line it reverses.',
  plus='Same shape for changes, proposals and Oracle; nothing to open to read a line.',
  cost='Undo a change: 2 clicks (Undo, confirm). Today there is no undo in the panel: change the field back by hand, 3 clicks and retyping.',
  frames=lambda l: [
   fr('ma3', l, 'rest', '', D, 'At rest: changes as sentences, mixed with comments.'),
   fr('ma3', l, 'open', 'open=1', D, 'Undo on Priya\'s date change asks to put Dates back.', scroll='undo'),
   fr('ma3', l, 'mid', 'phase=mid', D, 'Confirmed: the line says Undoing.'),
   fr('ma3', l, 'done', 'phase=done', D, 'Done: a new line, Avery put back Dates. Cost: 2 clicks.'),
   fr('ma3', l, 'hard', 'hard=1', W, 'Hard case at 1512: 200 events, day headings, 20 shown, Show 20 more.'),
   fr('ma3', l, 'phone', '', P, 'Phone 390: sentences wrap; Undo stays on the right.'),
  ]),
 dict(letter='b', name='Before and after box', recommended=False,
  what='Each change is a heading (who, when, proposed and accepted by) over a small box: the field, the old value struck through, the new value.',
  plus='Old and new values are easy to scan side by side.',
  cost='Undo: 2 clicks. Each change takes two lines, so the stream is about a third longer.',
  frames=lambda l: [
   fr('ma3', l, 'rest', '', D, 'At rest: each change a heading over a before and after box.'),
   fr('ma3', l, 'open', 'open=1', D, 'Undo on Priya\'s date change asks to put Dates back.', scroll='undo'),
   fr('ma3', l, 'mid', 'phase=mid', D, 'Confirmed: Undoing.'),
   fr('ma3', l, 'done', 'phase=done', D, 'Done: a new box at the top. Cost: 2 clicks.'),
   fr('ma3', l, 'hard', 'hard=1', W, 'Hard case at 1512: 200 events, fewer fit on screen.'),
   fr('ma3', l, 'phone', '', P, 'Phone 390: the boxes at full width.'),
  ]),
 dict(letter='c', name='Field first, filter', recommended=False,
  what='Each line starts with the field; who and when go underneath. Chips with counts (All, Dates, Status, Owner, Other) narrow the history to one field.',
  plus='Best for "when did the dates move?": one chip answers it, even in 200 events.',
  cost='Undo: 3 clicks (Dates, Undo, confirm). Who did it is in small text under each line.',
  frames=lambda l: [
   fr('ma3', l, 'rest', '', D, 'At rest: field-first lines and field chips with counts.'),
   fr('ma3', l, 'open', 'open=1', D, 'Dates chip picked: only date changes.'),
   fr('ma3', l, 'mid', 'phase=mid', D, 'Undo on Priya\'s date change asks to put Dates back.', scroll='undo'),
   fr('ma3', l, 'done', 'phase=done', D, 'Done: the put-back line tops the Dates list. Cost: 3 clicks.'),
   fr('ma3', l, 'hard', 'hard=1', W, 'Hard case at 1512: 200 events; the chips count each field.'),
   fr('ma3', l, 'phone', '', P, 'Phone 390: chips wrap above the lines.'),
  ]),
 dict(letter='d', name='Latest change per field', recommended=False,
  what='No timeline of changes: one row per field with its value, what it was, who changed it and when. All n opens that field\'s full list; Put back undoes the last change.',
  plus='Always short, even with 200 events; answers "who set this?" at a glance.',
  cost='Undo: 2 clicks. Order across fields is lost; older changes need All n, 1 more click each.',
  frames=lambda l: [
   fr('ma3', l, 'rest', '', D, 'At rest: comments, then one row per field with what it was.'),
   fr('ma3', l, 'open', 'open=1', D, 'All 1 on Dates opened: that field\'s list.'),
   fr('ma3', l, 'mid', 'phase=mid', D, 'Put back on Dates asks to put the old dates back.', scroll='undo'),
   fr('ma3', l, 'done', 'phase=done', D, 'Done: Dates now reads Oct 31 – Dec 10, was Dec 18. Cost: 2 clicks.'),
   fr('ma3', l, 'hard', 'hard=1', W, 'Hard case at 1512: 200 events still make six rows; the order is gone.'),
   fr('ma3', l, 'phone', '', P, 'Phone 390: field rows at full width.'),
  ]),
]

def dec(code, name, q, common, props):
    out = []
    for p in props:
        f = p.pop('frames')(p['letter'])
        if not p['recommended']: p.pop('why', None)
        out.append({**p, 'frames': f})
    return {'code': code, 'name': name, 'question': q, 'common': common, 'proposals': out}

picks = {
 'title': '@mentions and the activity history in the feature panel',
 'subtitle': 'Mock-ups for F-79 Weekly alert digest in the Simple feature panel. Invented people and data. Pick one per decision.',
 'decisions': [
  dec('MA1', 'Comments and history in the panel', 'How should comments and the history of changes share the feature panel?',
      'Everything sits at the end of the one feature panel, after details, dependencies, dates and goal, on every page that opens it. Comments keep today\'s field (Enter sends). Detailed keeps its History; the same lines show there.', MA1),
  dec('MA2', '@mention', 'How does a person mention someone, and how does that person find out?',
      'Only company members, by name and role, never an email address. Everyone who can comment can mention. A mention never changes the feature.', MA2),
  dec('MA3', 'One history line', 'What does one history line say, and how does a long history read?',
      'Every line says who, which field, from what to what, and when, month first. Proposals say who accepted them. Owners and approvers can undo; commenters see their proposal waiting.', MA3),
 ],
}
json.dump(frames, open(os.path.join(HERE, 'frames.json'), 'w'), indent=1)
os.makedirs(OUT, exist_ok=True)
json.dump(picks, open(os.path.join(OUT, 'picks.json'), 'w'), indent=1, ensure_ascii=False)
print(len(frames), 'frames')
