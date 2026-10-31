import os, re, time, hashlib, urllib.request
from urllib.parse import urljoin
OUT = "/workspace/att_b6adb80d0140404591d9/work/repo/mockups-out/mk-rundecide"
BASE = "http://localhost:3393"
JS = r"""
() => {
  const css = [];
  for (const sh of document.styleSheets) {
    try { const base = sh.href || location.href; let t = ""; for (const r of sh.cssRules) t += r.cssText + "\n";
      t = t.replace(/url\((['"]?)([^'")]+)\1\)/g, (m, q, u) => u.startsWith('data:') ? m : `url(${new URL(u, base).href})`);
      css.push(t); } catch (e) {}
  }
  document.querySelectorAll('input,textarea,select').forEach(el => {
    if (el.tagName === 'TEXTAREA') el.textContent = el.value;
    else if (el.tagName === 'SELECT') [...el.options].forEach(o => o.selected ? o.setAttribute('selected','') : o.removeAttribute('selected'));
    else { el.setAttribute('value', el.value); if (el.checked) el.setAttribute('checked',''); }
  });
  const scrolled = [];
  document.querySelectorAll('*').forEach(el => { if (el.scrollTop > 0) { el.setAttribute('data-mk-scroll', String(el.scrollTop)); scrolled.push(el); } });
  const root = document.documentElement.cloneNode(true);
  scrolled.forEach(el => el.removeAttribute('data-mk-scroll'));
  root.querySelectorAll('script,link[rel="stylesheet"],link[rel="preload"],link[rel="modulepreload"],style,noscript,next-route-announcer,nextjs-portal').forEach(n => n.remove());
  root.removeAttribute('data-theme'); root.style.removeProperty('zoom');
  return { html: root.outerHTML, css: css.join("\n"), y: window.scrollY };
}
"""
THEME = """<script>/* mockup hooks: ?theme=light|dark, and the frame's scroll */(function(){var t=new URLSearchParams(location.search).get('theme');if(t==='light'||t==='dark')document.documentElement.setAttribute('data-theme',t);addEventListener('load',function(){document.querySelectorAll('[data-mk-scroll]').forEach(function(e){e.scrollTop=+e.getAttribute('data-mk-scroll')});window.scrollTo(0,%d)})})();</script>"""

def snap(page, name, w, h, req=None):
    zoom = w != page.evaluate("innerWidth")
    if zoom:
        page.evaluate(f"document.documentElement.style.zoom = String(innerWidth/{w})"); time.sleep(0.8)
    page.screenshot(path=f"{OUT}/frames/{name}.png")
    r = page.evaluate(JS)
    if zoom:
        page.evaluate("document.documentElement.style.zoom = ''")
    css = r["css"]
    def font(m):
        u = m.group(1)
        if not re.search(r"\.(woff2?|ttf|otf)(\?|$)", u): return m.group(0)
        fn = os.path.basename(u.split("?")[0])
        p = f"{OUT}/assets/{fn}"
        if not os.path.exists(p):
            resp = urllib.request.urlopen(u)
            open(p, "wb").write(resp.read())
        return f"url(../assets/{fn})"
    css = re.sub(r"url\((http[^)]+)\)", font, css)
    html = r["html"]
    head = f'<meta charset="utf-8"><meta name="mockup-viewport" content="{w}x{h}"><style>{css}</style>' + (THEME % r["y"])
    html = html.replace("<head>", "<head>" + head, 1)
    def img(m):
        u = m.group(2)
        if u.startswith("data:"): return m.group(0)
        full = urljoin(BASE + "/", u.replace("&amp;", "&"))
        fn = "img-" + hashlib.md5(full.encode()).hexdigest()[:10] + os.path.splitext(full.split("?")[0])[1][:5]
        p = f"{OUT}/assets/{fn}"
        if not os.path.exists(p):
            try: open(p, "wb").write(urllib.request.urlopen(full).read())
            except Exception: return m.group(0)
        return f'{m.group(1)}="../assets/{fn}"'
    html = re.sub(r'(<img[^>]*?\ssrc)="([^"]+)"', img, html)
    html = re.sub(r'\ssrcset="[^"]*"', "", html)
    open(f"{OUT}/frames/{name}.html", "w").write("<!doctype html>\n" + html)
    print("saved", name, len(html)//1024, "KB")
