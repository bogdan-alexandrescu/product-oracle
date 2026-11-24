import json
R='/simple/roadmap'; P='/simple/priorities'; D='/priorities'
NEW='Retention drafts'
REN='Alerts launch, weekly check'
frames=[]; props={}
def F(code, letter, state, path, q, caption, w=1440, h=900, role='', scroll=None):
    name=f"{code}-{letter}-{state}" + ('-1512' if w==1512 else '-390' if w==390 else '')
    q=dict(q); 
    if role: q['as']=role
    c=q.get('cur','all')
    if c=='alerts': q['prd']='usage-alerts'
    if c in ('q1','new') or q.get('edited')=='1': q['goal']='grow-retention'; q['name']='Grow retention'
    fr={'file':name,'path':path,'q':q,'w':w,'h':h,'role':role}
    if scroll: fr['scroll']=scroll
    frames.append(fr); props.setdefault((code,letter),[]).append({'file':f'frames/{name}.html','caption':caption})
WIDE=dict(w=1512,h=982); PH=dict(w=390,h=844)
SC='[data-testid=mock-saved-views]'
# ---------------- SV1
for L,save_cost,today in [('a','Save: 2 steps (Save view, then type a name and press Enter). Reopen: 1 click.',''),('b','Save: 3 steps (View, Save these filters, then a name and Enter). Reopen: 2 clicks.',''),('c','Save: 2 steps (Save these filters, then a name and Enter). Reopen: 1 click.',''),('d','Save: 3 steps (open View, pick Save these filters, then a name and Save). Reopen: 2 picks.','')]:
    cost={'a':'Save: 2 steps','b':'Save: 3 steps','c':'Save: 2 steps','d':'Save: 3 steps'}[L]+' · today: 2–6 picks every visit'
    base={'sv1':L}
    F('sv1',L,'rest',R,{**base,'edited':'1'},{'a':'At rest: views are a second tab row, under Timeline and Gantt; Goal and Drafts only were just picked, so Save view lights up.','b':'At rest: one View button starts the filter row; Goal and Drafts only were just picked, so it shows Edited and Save as a view.','c':'At rest: views are a list on the right of the page; the filters were just changed, so Save these filters lights up.','d':'At rest: View is one more picker in the filter row, like PRD and Goal; it reads All items (edited).'}[L])
    F('sv1',L,'open',R,{**base,'edited':'1','open':{'a':'save','b':'1','c':'save','d':'1'}[L]},{'a':'Save view opened: a small box asks for a name.','b':'The View menu opened: built-in views, saved views, and Save these filters as a view at the foot.','c':'Save these filters opened in the side list: a name box above the views.','d':'The View picker opened: every view in one list, Save these filters… last.'}[L])
    F('sv1',L,'mid',R,{**base,'edited':'1','open':'save','vname':NEW},{'a':'Mid-way: the name is typed.','b':'Mid-way: Save these filters was picked; the name is typed in the menu.','c':'Mid-way: the name is typed in the side list.','d':'Mid-way: the picker turned into a name box with Save and Cancel.'}[L])
    F('sv1',L,'result',R,{**base,'phase':'done','added':NEW,'cur':'new','cost':cost},{'a':'Result: the new view is a tab, picked; the Saved tick sits under the tabs.','b':'Result: the View button reads the new name, with a Saved tick.','c':'Result: the new view sits in the side list, picked, with a Saved tick.','d':'Result: the picker reads the new name, with a Saved tick.'}[L]+' Cost: '+cost)
    F('sv1',L,'hard',R,{**base,'many':'1','cur':'l0','edited':'1' if L=='b' else '','open':{'a':'overflow','b':'1','c':'','d':'1'}[L]},{'a':'Hard case at 1512: ten more views with long names; six tabs fit, the rest go under +N more.','b':'Hard case at 1512: twelve saved views with long names; the menu wraps each name on two lines and scrolls.','c':'Hard case at 1512: twelve saved views with long names; the side list wraps them and takes a column of the page all the time.','d':'Hard case at 1512: twelve saved views; the plain picker cuts long names short and cannot group or wrap them.'}[L],**WIDE)
    F('sv1',L,'detailed',D,{**base,'edited':'1','open':{'a':'','b':'1','c':'','d':''}[L]},{'a':'Detailed Priorities: the same tabs above its counts.','b':'Detailed Priorities: the same View menu above its counts.','c':'Detailed Priorities: the same side list beside the ranked table.','d':'Detailed Priorities: the same View picker above its counts.'}[L])
    F('sv1',L,'phone',P,{**base,'edited':'1','open':{'a':'','b':'1','c':'1','d':''}[L]},{'a':'Phone 390, Simple Priorities: the tabs scroll sideways; Save view stays at the end.','b':'Phone 390, Simple Priorities: the View menu opens as a sheet from the bottom.','c':'Phone 390, Simple Priorities: the side list does not fit, so a Views button opens it full screen.','d':'Phone 390, Simple Priorities: View is one more picker in the row; a tap opens the phone’s own list.'}[L],**PH)
# ---------------- SV2
c2={'a':'Share: 1 more tap · today: send the page link','b':'Share: 2 clicks · today: send the page link','c':'Share: 2 more taps · today: send the page link','d':'Share: 1 more tap, owners only · today: send the page link'}
F('sv2','a','rest',R,{'sv2':'a','cur':'q1'},'At rest: Rosa Lind’s shared view is picked; the button says Everyone sees it.')
F('sv2','a','open',R,{'sv2':'a','cur':'q1','edited':'1','open':'1'},'Drafts only was ticked, so the view shows Edited with Save, Save as new and Undo changes; the menu splits Mine from Shared with everyone.')
F('sv2','a','mid',R,{'sv2':'a','cur':'q1','edited':'1','open':'save','vname':NEW,'share':'all'},'Mid-way: Save as new, named, Who sees it set to Everyone.')
F('sv2','a','result',R,{'sv2':'a','phase':'done','added':NEW,'cur':'new','share':'all','open':'1','cost':c2['a']},'Result: the view is under Shared with everyone with its maker’s name; tick: Saved, everyone sees it. Cost: '+c2['a'])
F('sv2','a','hard',R,{'sv2':'a','cur':'q1','edited':'1'},'Hard case, a commenter at 1512: the line says they can suggest changes to Rosa Lind’s view; Suggest this change sends her a proposal, Save as my view keeps a private copy.',role='commenter',**WIDE)
F('sv2','a','phone',P,{'sv2':'a','cur':'q1','edited':'1','open':'save','share':'all','vname':NEW},'Phone 390: the save sheet with Who sees it.',**PH)
F('sv2','b','rest',R,{'sv2':'b','cur':'alerts'},'At rest: every view is private; Copy link sits beside the View button.')
F('sv2','b','open',R,{'sv2':'b','cur':'alerts','open':'1'},'The menu opened: one Saved list, no sharing, Copy link to these filters at the foot.')
F('sv2','b','mid',R,{'sv2':'b','cur':'alerts','phase':'done'},'Mid-way: Copy link pressed; tick: Link copied. The link carries every filter.')
F('sv2','b','result',R,{'sv2':'b','cur':'alerts','fromlink':'1','cost':c2['b']},'Result: a viewer opens the link; the button reads From a link, the banner names Rosa Lind’s link and says they can read it and keep their own copy. Cost: '+c2['b'],role='viewer')
F('sv2','b','hard',R,{'sv2':'b','cur':'alerts','edited':'1','open':'1','many':'1'},'Hard case at 1512: twelve private views and an edited one; there is only Save, Save as new and Copy link, so a change stays with its maker.',**WIDE)
F('sv2','b','phone',P,{'sv2':'b','cur':'alerts','fromlink':'1'},'Phone 390: a link opened on a phone, with Save as my view.',role='viewer',**PH)
F('sv2','c','rest',R,{'sv2':'c','cur':'q1','open':'1'},'At rest, menu open: a lock marks views only some people may change.')
F('sv2','c','open',R,{'sv2':'c','cur':'all','edited':'1','open':'save','share':'all'},'Save these filters opened: Who sees it, and Who can change it.')
F('sv2','c','mid',R,{'sv2':'c','cur':'all','edited':'1','open':'save','share':'all','vname':NEW,'rights':'oa'},'Mid-way: named, shared with everyone, changeable by owners and approvers.')
F('sv2','c','result',R,{'sv2':'c','phase':'done','added':NEW,'cur':'new','share':'all','rights':'oa','open':'1','cost':c2['c']},'Result: the view is shared, with a lock. Cost: '+c2['c'])
F('sv2','c','hard',R,{'sv2':'c','cur':'q1','edited':'1'},'Hard case, a commenter at 1512: the view is locked to owners and approvers, so only Save as my view is offered; no proposal path.',role='commenter',**WIDE)
F('sv2','c','phone',P,{'sv2':'c','cur':'all','edited':'1','open':'save','share':'all','rights':'oa','vname':NEW},'Phone 390: the save sheet with Who sees it and Who can change it, each on one line.',**PH)
F('sv2','d','rest',R,{'sv2':'d','cur':'q1'},'At rest: a team view is picked; the button and its row both say Team.')
F('sv2','d','open',R,{'sv2':'d','cur':'q1','open':'1'},'The menu opened: Team views, set by owners, come first for everyone; then built-in, then Mine.')
F('sv2','d','mid',R,{'sv2':'d','cur':'all','edited':'1','open':'save','vname':NEW,'share':'all'},'Mid-way: an owner saves with Make it a team view ticked.')
F('sv2','d','result',R,{'sv2':'d','phase':'done','added':NEW,'cur':'new','share':'all','open':'1','cost':c2['d']},'Result: the view is a team view for everyone; tick: Saved as a team view. Cost: '+c2['d'])
F('sv2','d','hard',R,{'sv2':'d','cur':'all','edited':'1','open':'save','vname':'My retention check'},'Hard case, a viewer at 1512: a line says they can save for themselves and owners set team views; no team choice is offered.',role='viewer',**WIDE)
F('sv2','d','phone',P,{'sv2':'d','cur':'q1','open':'1'},'Phone 390: the sheet with Team views on top.',**PH)
# ---------------- SV3
c3={'a':'Rename: 4 steps · today: no views to rename','b':'Rename: 4 steps · today: no views to rename','c':'Rename: 3 steps · today: no views to rename'}
F('sv3','a','rest',R,{'sv3':'a','cur':'alerts'},'At rest: a saved view, Alerts launch review, is picked from the View menu.')
F('sv3','a','open',R,{'sv3':'a','cur':'alerts','open':'manage','drag':'q1'},'Manage views opened (View, then Manage views): every view with a handle, Default and Remove (Hide for built-in views); Q1 retention check is being dragged.')
F('sv3','a','mid',R,{'sv3':'a','cur':'alerts','open':'manage','phase':'mid','vname':REN},'Mid-way: the name of Alerts launch review was clicked and is being typed over.')
F('sv3','a','result',R,{'sv3':'a','cur':'alerts','open':'manage','renamed':REN,'cost':c3['a']},'Result: renamed in place; the new name wraps, with a Renamed tick under it. Cost: '+c3['a'])
F('sv3','a','hard',R,{'sv3':'a','cur':'l0','open':'manage','many':'1','removed':'l3','toast':'Removed Guided setup drafts waiting for an owner and a date'},'Hard case at 1512: ten more views with long names wrap in full in the sheet; one was removed and the toast offers Undo.',**WIDE)
F('sv3','a','phone',P,{'sv3':'a','cur':'l0','open':'manage','many':'1'},'Phone 390: the sheet fills the screen; long names wrap in full, handles stay on the left.',**PH)
F('sv3','b','rest',R,{'sv3':'b','cur':'alerts','open':'1'},'At rest, menu open: each saved row carries a ⋯; there is no Manage views.')
F('sv3','b','open',R,{'sv3':'b','cur':'alerts','open':'more'},'The View menu opened, then ⋯ on Alerts launch review: Rename, Move up, Move down, Make it the default, Copy link, Remove.')
F('sv3','b','mid',R,{'sv3':'b','cur':'alerts','open':'1','phase':'mid','vname':REN},'Mid-way: Rename turned the row into a name box inside the menu.')
F('sv3','b','result',R,{'sv3':'b','cur':'alerts','open':'1','renamed':REN,'cost':c3['b']},'Result: the row and the View button carry the new name. Cost: '+c3['b'])
F('sv3','b','hard',R,{'sv3':'b','cur':'l0','open':'1','many':'1','removed':'l1'},'Hard case at 1512: twelve long names in one scrolling menu; a removed view leaves an Undo line in its place.',**WIDE)
F('sv3','b','phone',P,{'sv3':'b','cur':'l0','open':'more','many':'1','removed':'l3'},'Phone 390: the menu as a bottom sheet; ⋯ opened on a row, and a removed view left an Undo line.',**PH)
F('sv3','c','rest',R,{'sv3':'c','cur':'alerts'},'At rest: views are tabs; the picked saved tab shows its ⋯.')
F('sv3','c','open',R,{'sv3':'c','cur':'alerts','open':'more'},'Views as tabs: ⋯ on the picked tab opens Rename, Make it the default, Copy link, Remove.')
F('sv3','c','mid',R,{'sv3':'c','cur':'alerts','phase':'mid','vname':REN},'Mid-way: the tab became a name box.')
F('sv3','c','result',R,{'sv3':'c','cur':'alerts','renamed':REN,'cost':c3['c']},'Result: the tab carries the new name. Cost: '+c3['c'])
F('sv3','c','hard',R,{'sv3':'c','cur':'l0','open':'overflow','many':'1','removed':'l7','toast':'Removed Pricing roadmap items with confidence under thirty percent'},'Hard case at 1512: six tabs fit; the rest sit under +N more with drag handles; the removed view is struck through there, and the toast offers Undo.',**WIDE)
F('sv3','c','phone',P,{'sv3':'c','cur':'l0','many':'1'},'Phone 390: the tab strip scrolled to a saved view; its long name is cut short, with ⋯ beside it.',**PH)
for fr in frames:
    if fr['file'].endswith('-390'): fr['scroll']=SC
    elif fr['w']==1512: pass
    elif fr['path']=='/simple/roadmap' and fr['q'].get('open') and fr['q'].get('open')!='manage': fr['scroll']=SC; fr['off']=-200
for fr in frames:
    if fr['file']=='sv3-c-phone-390': fr['pre']=["() => { const t=document.querySelector('[data-testid=sv-tabs] [role=tab][aria-selected=true]'); const l=t && t.parentElement; if (l) l.scrollLeft = t.offsetLeft - l.offsetLeft - 8; }"]
json.dump(frames,open('/cache/att_ac3bd35d49af4f9081a8/tmp/cap/frames.json','w'),indent=1)
json.dump({f'{k[0]}-{k[1]}':v for k,v in props.items()},open('/cache/att_ac3bd35d49af4f9081a8/tmp/cap/props.json','w'),indent=1)
print(len(frames))
