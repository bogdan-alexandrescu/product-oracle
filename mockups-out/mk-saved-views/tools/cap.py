import json, sys, os, urllib.request, urllib.parse
from swarm_browser import live
OUT = '/workspace/att_29c1f97ad092422dbc96/work/repo/mockups-out/mk-saved-views'
BASE = 'http://127.0.0.1:3100'
SNAP = open(os.path.join(os.path.dirname(__file__), 'snap.js')).read()
frames = json.load(open(sys.argv[1]))
only = sys.argv[2:] 
pw, browser, ctx = live()
pg = ctx.new_page()
pg.goto(BASE + '/login?next=%2Fhome', timeout=60000)
pg.wait_for_timeout(3000)
if '/login' in pg.url and pg.get_by_label('Email').count():
    pg.get_by_label('Email').fill('admin@example.com'); pg.get_by_label('Password').fill('demo')
    pg.get_by_role('button', name='Sign in').click(); pg.wait_for_url('**/home', timeout=30000)
pg.goto(BASE + '/login?blank=1'); pg.wait_for_timeout(500)
fontsdone = set()
for fr in frames:
    if only and not any(fr['file'].startswith(o) for o in only): continue
    w, h = fr.get('w', 1440), fr.get('h', 900)
    role = fr.get('role', '')
    theme = fr.get('theme', 'light')
    pg.evaluate("([r,t]) => { r ? localStorage.setItem('po-mock-role', r) : localStorage.removeItem('po-mock-role'); localStorage.setItem('oracle-theme', t); }", [role, theme])
    url = BASE + fr['path'] + ('&' if '?' in fr['path'] else '?') + urllib.parse.urlencode(fr.get('q', {}))
    scale = 1
    pg.set_content(f'<html><body style="margin:0;background:#888"><iframe id=f src="{url}" style="border:0;width:{w}px;height:{h}px;transform:scale({scale});transform-origin:0 0;display:block;background:#fff"></iframe></body></html>')
    f = pg.frame_locator('#f')
    fh = pg.query_selector('#f').content_frame()
    try:
        fh.wait_for_selector('[data-testid=mock-saved-views]', timeout=30000)
    except Exception as e:
        print('NO COMPONENT', fr['file'], fh.url); 
    fh.wait_for_timeout(1500)
    fh.evaluate("(t) => document.documentElement.setAttribute('data-theme', t)", theme)
    if fr.get('scroll'):
        fh.evaluate("([s,o]) => { const e = document.querySelector(s); if (e) e.scrollIntoView({block:'start'}); window.scrollBy(0,o); }", [fr['scroll'], fr.get('off',-12)])
    for act in fr.get('pre', []):
        fh.evaluate(act)
    pg.mouse.move(2, 2)
    fh.wait_for_timeout(400)
    res = fh.evaluate(SNAP, {'vp': f'{w}x{h}'})
    name = fr['file']
    open(f'{OUT}/frames/{name}.html', 'w').write(res['html'])
    for u in res['fonts']:
        b = u.split('/').pop().split('?')[0]
        if b in fontsdone: continue
        try:
            data = urllib.request.urlopen(urllib.parse.urljoin(BASE + '/', u)).read()
            open(f'{OUT}/assets/{b}', 'wb').write(data); fontsdone.add(b)
        except Exception as e: print('font fail', u, e)
    pg.screenshot(path=f'{OUT}/frames/{name}.png', full_page=True, clip={'x':0,'y':0,'width':w,'height':h})
    print('ok', name, w, h, theme)
pg.close(); pw.stop()
