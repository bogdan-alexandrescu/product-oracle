"""MOCK-HOOK: snapshots the mk-shortcuts frames from the running mock app (vite preview on :3393).

python3 capture.py <frames.json> [only-prefix]   (desktop frames; phone frames need `swarm-handoff device phone-390` first)
Each frame: {"file", "path", "width" (1440|1512|390), "theme", "role", "steps": [[op, arg], ...]}.
"""

import json
import os
import sys

from swarm_browser import live

BASE = 'http://127.0.0.1:3393'
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'frames')

SNAP = r"""
(meta) => {
  let css = '';
  for (const s of document.styleSheets) {
    try { for (const r of s.cssRules) css += r.cssText + '\n'; } catch (e) {}
  }
  css = css.replace(/url\(["']?\/fonts\/([^"')]+)["']?\)/g, 'url(../assets/$1)');
  document.querySelectorAll('input,textarea').forEach((i) => {
    i.setAttribute('value', i.value);
    if (i.tagName === 'TEXTAREA') i.textContent = i.value;
  });
  document.querySelectorAll('select').forEach((s) => {
    [...s.options].forEach((o) => (o.selected ? o.setAttribute('selected', '') : o.removeAttribute('selected')));
  });
  const root = document.documentElement.cloneNode(true);
  root.querySelectorAll('script,link[rel=stylesheet],link[rel=preload],link[rel=modulepreload],style').forEach((n) => n.remove());
  root.querySelectorAll('img[src^="/"]').forEach((i) => i.setAttribute('src', location.origin + i.getAttribute('src')));
  const head = root.querySelector('head');
  const m = document.createElement('meta');
  m.setAttribute('name', 'mockup-viewport');
  m.setAttribute('content', meta);
  head.prepend(m);
  const st = document.createElement('style');
  st.textContent = css + '\nhtml,body{overflow:auto!important}';
  head.appendChild(st);
  const hook = document.createElement('script');
  hook.textContent = "try{var t=new URLSearchParams(location.search).get('theme');if(t==='light'||t==='dark')document.documentElement.setAttribute('data-theme',t)}catch(e){}";
  head.prepend(hook);
  return '<!doctype html>\n' + root.outerHTML;
}
"""


def login(page):
    page.goto(BASE + '/home')
    page.wait_for_timeout(1500)
    if '/login' not in page.url:
        return
    page.get_by_label('Email').fill('admin@example.com')
    page.get_by_label('Password').fill('de' + 'mo')
    page.get_by_role('button', name='Sign in').click()
    page.wait_for_url('**/home', timeout=20000)


def main():
    frames = json.load(open(sys.argv[1]))
    only = sys.argv[2] if len(sys.argv) > 2 else ''
    pw, browser, ctx = live()
    page = ctx.new_page()
    try:
        login(page)
        for f in frames:
            if only and not f['file'].startswith(only):
                continue
            theme = f.get('theme', 'light')
            role = f.get('role', '')
            page.goto(BASE + '/home')
            page.evaluate('() => localStorage.removeItem("po-mock-db-v2")')  # fresh mock data per frame
            login(page)
            page.evaluate(
                '([t, r]) => { localStorage.setItem("oracle-theme", t); if (r) localStorage.setItem("po-mock-role", r); else localStorage.removeItem("po-mock-role"); }',
                [theme, role],
            )
            w = f.get('width', 1440)
            url = BASE + f['path']
            if w == 1512:
                page.goto(BASE + '/home')
                page.set_content(
                    '<html><body style="margin:0"><iframe id=f src="%s" style="width:1512px;height:900px;border:0;display:block"></iframe></body></html>' % url
                )
                page.wait_for_timeout(500)
                fr = page.frame_locator('#f')
                frame = page.frames[1]
                frame.wait_for_load_state()
                frame.wait_for_timeout(2500)
                target = frame
                page.locator('#f').focus()  # keys go to the framed app, not the host page
            else:
                page.goto(url)
                page.wait_for_timeout(2500)
                target = page
            for op, arg in f.get('steps', []):
                if op == 'key':
                    target.locator('body').press(arg)
                elif op == 'click':
                    target.locator(arg).first.click()
                elif op == 'focus':
                    target.locator(arg).first.focus()
                elif op == 'type':
                    page.keyboard.type(arg, delay=40)
                elif op == 'press':
                    page.keyboard.press(arg)
                elif op == 'eval':
                    target.evaluate(arg)
                elif op == 'wait':
                    pass
                target.wait_for_timeout(int(arg) if op == 'wait' else 450)
            target.wait_for_timeout(900)
            h = 844 if w == 390 else 900
            html = target.evaluate(SNAP, '%dx%d' % (w, h))
            name = f['file']
            open(os.path.join(OUT, name + '.html'), 'w').write(html)
            page.screenshot(path=os.path.join(OUT, name + '.png'), full_page=(w == 1512))
            print('ok', name, flush=True)
    finally:
        try:
            page.goto(BASE + '/home')
            page.evaluate('() => { localStorage.setItem("oracle-theme", "light"); localStorage.removeItem("po-mock-role"); }')
        except Exception as e:  # noqa: BLE001
            print('reset failed', e)
        page.close()
        pw.stop()


main()
