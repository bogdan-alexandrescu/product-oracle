import json
P='/simple/priorities'
row=lambda n: f':nth-match([data-testid="prio-row"], {n})'
rank=lambda n: f':nth-match([data-testid="prio-rank"], {n})'
box=lambda n: f'{row(n)} [data-testid="bulk-box"]'
F=[]
al=lambda n,o=8: ('align',row(n),[str(o)])
top=lambda y: ('below','[data-testid="bulk-result"]',[str(y)])
def add(file, url, do=(), w=1440, h=900, theme='light'):
    F.append(dict(file=file, url=P+url, do=list(do), w=w, h=h, theme=theme))
PH=dict(w=390, h=844)
# BE1 a: boxes on hover, shift-click
add('be1-a-rest','?be1=a',[('hover','h1')])
add('be1-a-open','?be1=a',[('hover',rank(2))])
add('be1-a-mid','?be1=a',[('click',box(2)),al(7),('hover',rank(6))])
add('be1-a-result','?be1=a',[('click',box(2)),('click',box(6),['Shift']),al(7)])
add('be1-a-hard-1512','?be1=a',[('click',box(2)),('click','text=/Pick all \\d+ shown/'),al(22)],w=1512,h=982)
add('be1-a-phone','?be1=a',[('click',box(2)),('click',box(3)),('click',box(5)),al(5)],**PH)
# BE1 b: select mode
add('be1-b-rest','?be1=b',[('hover','h1')])
add('be1-b-open','?be1=b',[('click','[data-testid="bulk-mode"]')])
add('be1-b-mid','?be1=b',[('click','[data-testid="bulk-mode"]'),('click',rank(2)),('click',rank(4)),al(7)])
add('be1-b-result','?be1=b',[('click','[data-testid="bulk-mode"]'),('click',rank(2)),('click',rank(4)),('click',rank(7),['Shift']),al(7)])
add('be1-b-hard-1512','?be1=b&long=1',[('click','[data-testid="bulk-mode"]'),('click',rank(2)),('click',f'{row(4)} [data-testid="prio-title"]'),al(6),('hover',f'{row(4)} [data-testid="prio-title"]')],w=1512,h=982)
add('be1-b-phone','?be1=b',[('click','[data-testid="bulk-mode"]'),('click',rank(2)),('click',rank(3)),al(2)],**PH)
# BE1 c: ctrl and shift click
add('be1-c-rest','?be1=c',[('hover','h1')])
add('be1-c-open','?be1=c',[('click',f'{row(2)} [data-testid="prio-details"]',['Control']),al(7)])
add('be1-c-mid','?be1=c',[('click',rank(2),['Control']),('click',rank(4),['Control']),al(7)])
add('be1-c-result','?be1=c',[('click',rank(2),['Control']),('click',rank(4),['Control']),('click',rank(7),['Shift']),al(7)])
add('be1-c-hard-1512','?be1=c&long=1',[('hover',f'{row(4)} [data-testid="prio-title"]')],w=1512,h=982)
add('be1-c-phone','?be1=c',[('click',rank(2))],**PH)
# BE2: bar
B='?be2=%s&pick=2,4,6,7'
for v in 'abc':
    u=B%v
    add(f'be2-{v}-rest',u,[('hover','h1'),al(7)])
if True:
    add('be2-a-open',B%'a',[al(7),('click','[data-testid="bulk-field-status"]')])
    add('be2-a-mid',B%'a',[al(7),('click','[data-testid="bulk-field-status"]'),('click','[data-testid="bulk-opt-Exists"]')])
    add('be2-a-dates',B%'a',[al(7),('click','[data-testid="bulk-field-dates"]'),('click','[data-testid="bulk-end-Dec-15"]')])
    add('be2-a-track',B%'a',[al(7),('click','[data-testid="bulk-field-track"]')])
    add('be2-b-track',B%'b',[('click','[data-testid="bulk-edit"]'),('click','[data-testid="bulk-sum-track"]')])
    add('be2-c-track',B%'c',[al(7),('click','[data-testid="bulk-field-track"]')])
    add('be2-a-result',B%'a',[('click','[data-testid="bulk-field-status"]'),('click','[data-testid="bulk-opt-Exists"]'),('click','[data-testid="bulk-apply"]'),al(7)])
    add('be2-a-hard-1512','?be2=a&long=1&pick=2,3,4,5,6,7,8,9,10,11,12,13,14,15',[('click','[data-testid="bulk-field-dates"]'),('click','[data-testid="bulk-shift-2"]')],w=1512,h=982)
    add('be2-a-phone',B%'a',[('click','[data-testid="bulk-field-status"]'),('click','[data-testid="bulk-opt-Exists"]')],**PH)
    add('be2-b-open',B%'b',[('click','[data-testid="bulk-edit"]')])
    add('be2-b-mid',B%'b',[('click','[data-testid="bulk-edit"]'),('click','[data-testid="bulk-opt-Rosa Lind"]'),('click','[data-testid="bulk-shift-2"]')])
    add('be2-b-result',B%'b',[('click','[data-testid="bulk-edit"]'),('click','[data-testid="bulk-opt-Rosa Lind"]'),('click','[data-testid="bulk-shift-2"]'),('click','[data-testid="bulk-apply"]'),al(7)])
    add('be2-b-hard-1512','?be2=b&long=1&pick=2,3,4,5,6,7,8,9,10,11,12,13,14,15',[('click','[data-testid="bulk-edit"]'),('click','[data-testid="bulk-opt-Rosa Lind"]'),('click','[data-testid="bulk-shift-2"]')],w=1512,h=982)
    add('be2-b-phone',B%'b',[('click','[data-testid="bulk-edit"]'),('click','[data-testid="bulk-opt-Rosa Lind"]')],**PH)
    add('be2-c-open',B%'c',[al(7),('click','[data-testid="bulk-field-dates"]')])
    add('be2-c-mid',B%'c',[al(7),('click','[data-testid="bulk-field-dates"]'),('click','[data-testid="bulk-shift-2"]'),al(7)])
    add('be2-c-result',B%'c',[('click','[data-testid="bulk-field-dates"]'),('click','[data-testid="bulk-shift-2"]'),('click','[data-testid="bulk-apply"]'),al(7)])
    add('be2-c-hard-1512','?be2=c&long=1&pick=2,3,4,5,6,7,8,9,10,11,12,13,14,15',[('click','[data-testid="bulk-field-dates"]'),('click','[data-testid="bulk-shift-2"]')],w=1512,h=982)
    add('be2-c-phone',B%'c',[('click','[data-testid="bulk-field-dates"]'),('click','[data-testid="bulk-shift-2"]'),al(2)],**PH)
# BE3
for v in 'abc':
    pk='2,3,4' if v=='b' else '2,3,4,7'
    u=f'?be3={v}&pick={pk}'
    st=[('click','[data-testid="bulk-field-owner"]')]
    dn=st+[('click','[data-testid="bulk-opt-Rosa Lind"]')]
    sc=[al(7)]
    end=[al(7)] if v=='b' else [top(10)]
    endp=[al(3,-10)] if v=='b' else [top(54)]
    add(f'be3-{v}-rest',u,[('hover','h1')]+sc)
    add(f'be3-{v}-open',u,sc+st)
    add(f'be3-{v}-mid',u,sc+dn)
    add(f'be3-{v}-result',u,sc+dn+[('click','[data-testid="bulk-apply"]')]+end)
    add(f'be3-{v}-hard-1512',f'?be3={v}&role=commenter&pick=2,3,4,6',[al(7 if v=='c' else 6)]+dn,w=1512,h=982)
    add(f'be3-{v}-phone',u,dn+[('click','[data-testid="bulk-apply"]')]+endp,**PH)
# cost notes on each result frame, then dark copies of every result and phone frame
NOTE={'be1-a':'4 in a run: 2 clicks · today: no way to pick several','be1-b':'4 rows: 5 to 6 clicks · today: no way to pick several',
 'be1-c':'4 in a run: 2 clicks, keyboard only · today: no way to pick several','be2-a':'5 clicks for 4 features · today: about 16 clicks',
 'be2-b':'8 clicks for two fields · today: about 24 clicks','be2-c':'5 clicks for 4 features · today: about 16 clicks',
 'be3-a':'5 clicks · 1 more to see what was not changed','be3-b':'5 clicks · locked rows skipped, no click',
 'be3-c':'5 clicks · then 1 per locked feature to ask'}
for f in F:
    k=f['file'][:5]
    if f['file']==k+'-result': f['do'].append(('note',NOTE[k]))
for f in list(F):
    if f['file'].endswith('-result') or f['file'].endswith('-phone'):
        F.append(dict(f, file=f['file']+'-dark', theme='dark'))
json.dump(F,open('spec.json','w'),indent=0)
print(len(F))
# BE1 a on the Roadmap board
card=lambda n: f':nth-match([data-testid="board-card"], {n})'
bb=lambda n: f'{card(n)} [data-testid="board-box"]'
G=[]
def addb(file, do, w=1440, h=900, theme='light'):
    G.append(dict(file=file, url='/simple/roadmap?be1=a', wait='[data-testid="format-board"]', do=[('click','[data-testid="format-board"]')]+list(do), w=w, h=h, theme=theme))
addb('be1-a-board-open',[('hover',card(2))])
addb('be1-a-board-mid',[('click',bb(2)),('align',card(5)),('hover',card(5))])
addb('be1-a-board-result',[('click',bb(2)),('click',bb(5),['Shift']),('align',card(5))])
addb('be1-a-board-result-1512',[('click',bb(2)),('click',bb(5),['Shift']),('click',bb(9))],w=1512,h=982)
addb('be1-a-board-phone',[('click',bb(1)),('click',bb(2)),('align',card(3))],**PH)
addb('be1-a-board-phone-dark',[('click',bb(1)),('click',bb(2)),('align',card(3))],theme='dark',**PH)
json.dump(F+G,open('spec.json','w'),indent=0)
json.dump(G,open('spec-board.json','w'),indent=0)
# BE1 a in Detailed (plan table)
pb=lambda n: f':nth-match([data-testid="plan-box"], {n})'
H=[]
def addd(file, do, w=1440, h=900):
    H.append(dict(file=file, url='/plan?be1=a', wait='[data-testid="plan-row"]', do=list(do), w=w, h=h, theme='light'))
addd('be1-a-detailed-rest',[('scrollto','[data-testid="plan-row"]')])
addd('be1-a-detailed-result',[('click',pb(2)),('click',pb(6),['Shift'])])
addd('be1-a-detailed-result-1512',[('click',pb(1)),('click',pb(7))],w=1512,h=982)
addd('be1-a-detailed-phone',[('click',pb(1)),('click',pb(3)),('align',':nth-match([data-testid="plan-row"], 3)')],**PH)
json.dump(F+G+H,open('spec.json','w'),indent=0)
json.dump(H,open('spec-detailed.json','w'),indent=0)
