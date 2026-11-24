import json
P='/simple/priorities'
row=lambda n: f':nth-match([data-testid="prio-row"], {n})'
rank=lambda n: f':nth-match([data-testid="prio-rank"], {n})'
box=lambda n: f'{row(n)} [data-testid="bulk-box"]'
F=[]
def add(file, url, do=(), w=1440, h=900, theme='light'):
    F.append(dict(file=file, url=P+url, do=list(do), w=w, h=h, theme=theme))
PH=dict(w=390, h=844)
# BE1 a: boxes on hover, shift-click
add('be1-a-rest','?be1=a',[('hover','h1')])
add('be1-a-open','?be1=a',[('hover',rank(2))])
add('be1-a-mid','?be1=a',[('click',box(2)),('hover',rank(6))])
add('be1-a-result','?be1=a',[('click',box(2)),('click',box(6),['Shift'])])
add('be1-a-hard-1512','?be1=a',[('click',box(2)),('click','text=/Pick all \\d+ shown/'),('scroll','1400')],w=1512,h=982)
add('be1-a-phone','?be1=a',[('click',box(2)),('click',box(3)),('click',box(5))],**PH)
# BE1 b: select mode
add('be1-b-rest','?be1=b',[('hover','h1')])
add('be1-b-open','?be1=b',[('click','[data-testid="bulk-mode"]')])
add('be1-b-mid','?be1=b',[('click','[data-testid="bulk-mode"]'),('click',rank(2)),('click',rank(4))])
add('be1-b-result','?be1=b',[('click','[data-testid="bulk-mode"]'),('click',rank(2)),('click',rank(4)),('click',rank(7),['Shift'])])
add('be1-b-hard-1512','?be1=b&long=1',[('click','[data-testid="bulk-mode"]'),('click',rank(2)),('click',f'{row(4)} [data-testid="prio-title"]'),('click',rank(6))],w=1512,h=982)
add('be1-b-phone','?be1=b',[('click','[data-testid="bulk-mode"]'),('click',rank(2)),('click',rank(3))],**PH)
# BE1 c: ctrl and shift click
add('be1-c-rest','?be1=c',[('hover','h1')])
add('be1-c-open','?be1=c',[('click',f'{row(2)} [data-testid="prio-details"]',['Control'])])
add('be1-c-mid','?be1=c',[('click',rank(2),['Control']),('click',rank(4),['Control'])])
add('be1-c-result','?be1=c',[('click',rank(2),['Control']),('click',rank(4),['Control']),('click',rank(7),['Shift'])])
add('be1-c-hard-1512','?be1=c&long=1',[('click',rank(2),['Control']),('click',rank(4),['Control']),('click','[data-testid="info-tip"] >> nth=-1')],w=1512,h=982)
add('be1-c-phone','?be1=c',[('click',rank(2))],**PH)
# BE2: bar
B='?be2=%s&pick=2,4,6,7'
for v in 'abc':
    u=B%v
    add(f'be2-{v}-rest',u,[('hover','h1')])
if True:
    add('be2-a-open',B%'a',[('click','[data-testid="bulk-field-status"]')])
    add('be2-a-mid',B%'a',[('click','[data-testid="bulk-field-status"]'),('click','[data-testid="bulk-opt-Done"]')])
    add('be2-a-result',B%'a',[('click','[data-testid="bulk-field-status"]'),('click','[data-testid="bulk-opt-Done"]'),('click','[data-testid="bulk-apply"]')])
    add('be2-a-hard-1512','?be2=a&long=1&pick=2,3,4,5,6,7,8,9,10,11,12,13,14,15',[('click','[data-testid="bulk-field-dates"]'),('click','[data-testid="bulk-shift-2"]')],w=1512,h=982)
    add('be2-a-phone',B%'a',[('click','[data-testid="bulk-field-status"]'),('click','[data-testid="bulk-opt-Done"]')],**PH)
    add('be2-b-open',B%'b',[('click','[data-testid="bulk-edit"]')])
    add('be2-b-mid',B%'b',[('click','[data-testid="bulk-edit"]'),('click','[data-testid="bulk-opt-Rosa Lind"]'),('click','summary:has-text("Dates")'),('click','[data-testid="bulk-shift-2"]')])
    add('be2-b-result',B%'b',[('click','[data-testid="bulk-edit"]'),('click','[data-testid="bulk-opt-Rosa Lind"]'),('click','summary:has-text("Dates")'),('click','[data-testid="bulk-shift-2"]'),('click','[data-testid="bulk-apply"]')])
    add('be2-b-hard-1512','?be2=b&long=1&pick=2,3,4,5,6,7,8,9,10,11,12,13,14,15',[('click','[data-testid="bulk-edit"]'),('click','[data-testid="bulk-opt-Rosa Lind"]'),('click','summary:has-text("Dates")'),('click','[data-testid="bulk-shift-2"]')],w=1512,h=982)
    add('be2-b-phone',B%'b',[('click','[data-testid="bulk-edit"]'),('click','[data-testid="bulk-opt-Rosa Lind"]')],**PH)
    add('be2-c-open',B%'c',[('click','[data-testid="bulk-field-dates"]')])
    add('be2-c-mid',B%'c',[('click','[data-testid="bulk-field-dates"]'),('click','[data-testid="bulk-shift-2"]')])
    add('be2-c-result',B%'c',[('click','[data-testid="bulk-field-dates"]'),('click','[data-testid="bulk-shift-2"]'),('click','[data-testid="bulk-apply"]')])
    add('be2-c-hard-1512','?be2=c&long=1&pick=2,3,4,5,6,7,8,9,10,11,12,13,14,15',[('click','[data-testid="bulk-field-dates"]'),('click','[data-testid="bulk-shift-2"]')],w=1512,h=982)
    add('be2-c-phone',B%'c',[('click','[data-testid="bulk-field-dates"]'),('click','[data-testid="bulk-shift-2"]')],**PH)
# BE3
for v in 'abc':
    pk='2,3,4' if v=='b' else '2,3,4,7'
    u=f'?be3={v}&pick={pk}'
    st=[('click','[data-testid="bulk-field-status"]')]
    dn=st+[('click','[data-testid="bulk-opt-Done"]')]
    add(f'be3-{v}-rest',u,[('hover','h1')])
    add(f'be3-{v}-open',u,st)
    add(f'be3-{v}-mid',u,dn)
    add(f'be3-{v}-result',u,dn+[('click','[data-testid="bulk-apply"]')])
    add(f'be3-{v}-hard-1512',f'?be3={v}&role=commenter&pick=2,3,4,6',dn,w=1512,h=982)
    add(f'be3-{v}-phone',u,dn+[('click','[data-testid="bulk-apply"]')],**PH)
# dark
add('be2-a-mid-dark',B%'a',[('click','[data-testid="bulk-field-status"]'),('click','[data-testid="bulk-opt-Done"]')],theme='dark')
add('be1-a-result-dark','?be1=a',[('click',box(2)),('click',box(6),['Shift'])],theme='dark')
add('be3-a-result-dark','?be3=a&pick=2,3,4,7',[('click','[data-testid="bulk-field-status"]'),('click','[data-testid="bulk-opt-Done"]'),('click','[data-testid="bulk-apply"]')],theme='dark')
json.dump(F,open('spec.json','w'),indent=0)
print(len(F))
