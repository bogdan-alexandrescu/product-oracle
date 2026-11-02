"""Snapshot the mock-up frames as static html + png (run with the mock app on :3393, signed in).

python3 snap.py frames.json [only-prefix]
Each frame: {"file": "np1-b-open", "url": "/simple?np1=b&open=1", "w": 1440, "h": 900,
             "steps": [["click", "selector"] | ["fill", "selector", "text"] | ["scroll", "selector", "end"] | ["wait", ms]],
             "scenario": "before-drafting" (optional)}
"""

import json
import pathlib
import re
import sys
import urllib.request

from swarm_browser import live

BASE = "http://127.0.0.1:3393"
OUT = pathlib.Path(__file__).parent
FRAMES = OUT / "frames"
ASSETS = OUT / "assets"

CAPTURE = r"""
() => {
  document.querySelectorAll('input').forEach(i => i.setAttribute('value', i.value));
  document.querySelectorAll('textarea').forEach(t => { t.textContent = t.value; });
  document.querySelectorAll('*').forEach(n => { if (n.scrollTop > 0) n.setAttribute('data-mk-scroll', String(n.scrollTop)); });
  const css = [];
  for (const sh of document.styleSheets) { try { css.push([...sh.cssRules].map(r => r.cssText).join('\n')); } catch (e) {} }
  const clone = document.documentElement.cloneNode(true);
  clone.querySelectorAll('script, link[rel=stylesheet], link[rel=preload], link[rel=modulepreload], link[as=script], link[as=font], next-route-announcer, nextjs-portal, style').forEach(n => n.remove());
  clone.querySelectorAll('img[src^="/"]').forEach(i => i.setAttribute('src', location.origin + i.getAttribute('src')));
  document.querySelectorAll('[data-mk-scroll]').forEach(n => n.removeAttribute('data-mk-scroll'));
  return { html: clone.outerHTML, css: css.join('\n'), scrollY: window.scrollY };
}
"""

HOOK = """<script>/* mock-up hooks: ?theme=light|dark, and each scrolled part back where it was */
(function(){var t=new URLSearchParams(location.search).get('theme');if(t==='light'||t==='dark')document.documentElement.setAttribute('data-theme',t);
addEventListener('DOMContentLoaded',function(){document.querySelectorAll('[data-mk-scroll]').forEach(function(n){n.scrollTop=+n.getAttribute('data-mk-scroll')});window.scrollTo(0,SCROLLY);});})();</script>"""


def fonts(css: str, page) -> str:
    def swap(m):
        url = m.group(1).strip("'\"")
        if url.startswith("../media/"):
            url = "/_next/static/media/" + url[len("../media/"):]
        if not url.startswith("/_next/static/media/"):
            return m.group(0)
        name = url.rsplit("/", 1)[1]
        dest = ASSETS / name
        if not dest.exists():
            dest.write_bytes(urllib.request.urlopen(BASE + url).read())
        return f"url(../assets/{name})"

    return re.sub(r"url\(([^)]+)\)", swap, css)


def shoot(page, f):
    # The live browser's size is the gate's (desktop 1440x900 or phone-390, by preset): 1512 is
    # laid out at 1512 CSS px by zooming the page to 1440/1512; the html file has no zoom.
    page.evaluate("() => localStorage.setItem('oracle.hop-panel.open', '0')")
    page.goto(BASE + f["url"])
    page.wait_for_load_state("networkidle")
    page.wait_for_timeout(f.get("settle", 1500))
    zoom = 1440 / 1512 if f["w"] == 1512 else 1
    if zoom != 1:
        page.evaluate("z => { document.documentElement.style.zoom = String(z); }", zoom)
        page.wait_for_timeout(500)
    for st in f.get("steps", []):
        if st[0] == "click":
            page.locator(st[1]).first.click()
        elif st[0] == "fill":
            page.locator(st[1]).first.fill(st[2])
        elif st[0] == "label":
            page.get_by_label(st[1], exact=True).first.fill(st[2])
        elif st[0] == "role":
            page.get_by_role(st[1], name=st[2]).first.click()
        elif st[0] == "waitfor":
            page.locator(st[1]).first.wait_for(timeout=20000)
        elif st[0] == "type":
            page.locator(st[1]).first.press_sequentially(st[2])
        elif st[0] == "scroll":
            page.evaluate("([s, to]) => { const n = document.querySelector(s); n.scrollTop = to === 'end' ? n.scrollHeight : +to; }", [st[1], st[2]])
        elif st[0] == "winscroll":
            page.evaluate("y => window.scrollTo(0, y)", st[1])
        elif st[0] == "into":
            page.locator(st[1]).first.scroll_into_view_if_needed()
        elif st[0] == "wait":
            page.wait_for_timeout(st[1])
        page.wait_for_timeout(400)
    page.mouse.move(2, f["h"] - 2)
    page.wait_for_timeout(300)
    page.screenshot(path=str(FRAMES / (f["file"] + ".png")))
    if zoom != 1:
        page.evaluate("() => { document.documentElement.setAttribute('data-mk-zoom', '1'); }")
    got = page.evaluate(CAPTURE)
    got["html"] = re.sub(r'(<html[^>]*?) style="zoom: [0-9.]+;?"', r"\1", got["html"]).replace(' data-mk-zoom="1"', "")
    css = fonts(got["css"], page)
    html = got["html"]
    head = f'<meta charset="utf-8"><meta name="mockup-viewport" content="{f["w"]}x{f["h"]}"><style>{css}</style>{HOOK.replace("SCROLLY", str(int(got["scrollY"])))}'
    html = html.replace("<head>", "<head>" + head, 1)
    (FRAMES / (f["file"] + ".html")).write_text("<!doctype html>" + html)
    print("ok", f["file"])


def main():
    frames = json.loads(pathlib.Path(sys.argv[1]).read_text())
    only = sys.argv[2] if len(sys.argv) > 2 else ""
    FRAMES.mkdir(parents=True, exist_ok=True)
    ASSETS.mkdir(parents=True, exist_ok=True)
    pw, browser, context = live()
    page = context.new_page()
    try:
        # Fresh mock data in the "before-drafting" scenario (a brief in Detailed for option a), signed in as the owner.
        page.goto(BASE + "/login")
        page.evaluate("() => { localStorage.removeItem('po-mock-db-v2'); localStorage.setItem('po-mock-scenario', 'before-drafting'); localStorage.setItem('oracle.hop-panel.open', '0'); }")
        page.goto(BASE + "/login")
        page.get_by_label("Email").fill("admin@example.com")
        page.get_by_label("Password").fill("demo")
        page.get_by_role("button", name="Sign in").click()
        page.wait_for_timeout(2500)
        for f in frames:
            phone = f["w"] < 600
            if any(f["file"].startswith(o) for o in only.split(",")) and phone == (sys.argv[3] == "phone" if len(sys.argv) > 3 else False):
                shoot(page, f)
    finally:
        page.close()
        pw.stop()


if __name__ == "__main__":
    main()
