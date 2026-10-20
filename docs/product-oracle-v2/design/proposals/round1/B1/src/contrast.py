import re,json
css=open('src/b1.css').read()
blocks=re.findall(r':root\{(.*?)\}',css,re.S)
def parse(b): return dict(re.findall(r'--([\w-]+):(#[0-9a-fA-F]{6})',b))
light=parse(blocks[0]); dark={**light,**parse(blocks[1])}
def lum(h):
    c=[int(h[i:i+2],16)/255 for i in (1,3,5)]
    c=[x/12.92 if x<=0.03928 else ((x+0.055)/1.055)**2.4 for x in c]
    return 0.2126*c[0]+0.7152*c[1]+0.0722*c[2]
def ratio(a,b):
    la,lb=sorted([lum(a),lum(b)],reverse=True); return (la+0.05)/(lb+0.05)
pairs=[('text','surface','body'),('text','bg','body'),('text','surface2','body'),('text','accent-soft','body (selected row)'),
('text2','surface','label'),('text2','bg','label'),('text2','surface2','label (table head)'),('text2','accent-soft','label (selected row)'),
('accent-ink','surface','link, count'),('accent-ink','accent-soft','chip, id'),('on-accent','accent','primary button'),
('pass','pass-bg','chip'),('warn','warn-bg','chip'),('crit','crit-bg','chip'),('na','na-bg','chip'),
('pass','surface','delta figure'),('crit','surface','numeral'),('warn','surface','numeral'),
('hero-text','hero','inspector title'),('hero-text2','hero','inspector label'),('hero-text','hero-2','inspector chip'),
('on-lime','lime','now chip, nav active'),('nav-text','nav','nav label'),('tip-text','tip','tooltip')]
out=['| Theme | Text | Background | Use | Ratio | Need | Result |','|---|---|---|---|---|---|---|']
bad=0
for name,t in (('light',light),('dark',dark)):
    for a,b,use in pairs:
        r=ratio(t[a],t[b]); need=7 if use.startswith('body') else 4.5
        ok=r>=need; bad+=not ok
        out.append(f'| {name} | `{a}` {t[a]} | `{b}` {t[b]} | {use} | {r:.2f} | {need} | {"pass" if ok else "FAIL"} |')
print('\n'.join(out)); print('fails',bad)
json.dump({'light':light,'dark':dark},open('/tmp/colors.json','w'),indent=1)
