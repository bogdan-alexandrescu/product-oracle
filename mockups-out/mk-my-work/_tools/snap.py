import os, re, subprocess, sys, time, json
from swarm_browser import live
BASE = 'http://127.0.0.1:4173'
OUT = '/workspace/att_e30e3832efdf4aa19a45/work/repo/mockups-out/mk-my-work/frames'
FONTS = [('dm-mono-latin-400', 'dm-mono-latin-400.woff2'), ('dm-mono-latin-500', 'dm-mono-latin-500.woff2'), ('inter-tight', 'inter-tight-latin.woff2')]

CLONE_JS = r"""
() => {
  // carry live form state into attributes so the clone shows it
  document.querySelectorAll('select').forEach(s => { [...s.options].forEach(o => { if (o.selected) o.setAttribute('selected',''); else o.removeAttribute('selected'); }); });
  document.querySelectorAll('input').forEach(i => { if (i.type==='checkbox'||i.type==='radio') { if (i.checked) i.setAttribute('checked',''); else i.removeAttribute('checked'); } else i.setAttribute('value', i.value); });
  document.querySelectorAll('textarea').forEach(t => { t.textContent = t.value; });
  document.querySelectorAll('[data-mock-scroll]').forEach(e => e.removeAttribute('data-mock-scroll'));
  document.querySelectorAll('body *').forEach(e => { if (e.scrollTop || e.scrollLeft) e.setAttribute('data-mock-scroll', e.scrollLeft + ',' + e.scrollTop); });
  document.documentElement.setAttribute('data-mock-scroll', window.scrollX + ',' + window.scrollY);
  let css = '';
  for (const sh of document.styleSheets) { try { for (const r of sh.cssRules) css += r.cssText + '\n'; } catch (e) {} }
  const root = document.documentElement.cloneNode(true);
  root.querySelectorAll('script, link[rel=stylesheet], style, link[rel=modulepreload], link[rel=preload]').forEach(n => n.remove());
  root.removeAttribute('data-theme');
  const head = root.querySelector('head');
  const st = document.createElement('style'); st.textContent = css; head.prepend(st);
  return {html: '<!doctype html>\n' + root.outerHTML, css};
}
"""

def sh(*a):
    subprocess.run(['swarm-handoff', *a], check=True, timeout=60, capture_output=True)

def fixfonts(html):
    def rep(m):
        u = m.group(1)
        for key, f in FONTS:
            if key in u: return 'url("../assets/%s")' % f
        return m.group(0)
    return re.sub(r'url\(["\']?([^)"\']*\.woff2[^)"\']*)["\']?\)', rep, html)

def save(page, name, vp):
    page.evaluate("document.documentElement.removeAttribute('data-theme')")
    r = page.evaluate(CLONE_JS)
    html = fixfonts(r['html'])
    meta = '<meta charset="utf-8"><meta name="mockup-viewport" content="%s"><script>(function(){var t=new URLSearchParams(location.search).get("theme");if(t)document.documentElement.setAttribute("data-theme",t);addEventListener("load",function(){document.querySelectorAll("body [data-mock-scroll]").forEach(function(e){var p=e.getAttribute("data-mock-scroll").split(",");e.scrollLeft=+p[0];e.scrollTop=+p[1];});var r=(document.documentElement.getAttribute("data-mock-scroll")||"0,0").split(",");scrollTo(+r[0],+r[1]);});})();</script>' % vp
    html = html.replace('<head>', '<head>' + meta, 1)
    open(os.path.join(OUT, name + '.html'), 'w').write(html)
    page.evaluate("document.documentElement.setAttribute('data-theme','light')"); time.sleep(0.3)
    page.screenshot(path=os.path.join(OUT, name + '.png'))
    page.evaluate("document.documentElement.setAttribute('data-theme','dark')"); time.sleep(0.3)
    page.screenshot(path=os.path.join(OUT, name + '-dark.png'))
    page.evaluate("document.documentElement.removeAttribute('data-theme')")
    print('saved', name, vp, flush=True)
