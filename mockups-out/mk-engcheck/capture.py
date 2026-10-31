import json, os, re, sys, urllib.request

B = "http://localhost:3393"
OUT = os.path.dirname(os.path.abspath(__file__))
FR, AS = OUT + "/frames", OUT + "/assets"
os.makedirs(FR, exist_ok=True); os.makedirs(AS, exist_ok=True)
REVIEW = open(os.environ["TMPDIR"] + "/cap/url.txt").read().strip()
RET = "f.returns-portal"
OWN = bool(os.environ.get("MOCK_OWN_BROWSER"))

SNAP_JS = r"""() => {
  for (const el of document.querySelectorAll('input')) { el.setAttribute('value', el.value); if (el.checked) el.setAttribute('checked',''); }
  for (const el of document.querySelectorAll('textarea')) el.textContent = el.value;
  let i = 0;
  for (const el of document.querySelectorAll('*')) { if (el.scrollTop > 0) el.setAttribute('data-mock-scroll', String(el.scrollTop)); }
  const doc = document.documentElement.cloneNode(true);
  for (const el of document.querySelectorAll('[data-mock-scroll]')) el.removeAttribute('data-mock-scroll');
  doc.querySelectorAll('script, noscript, link[rel=preload], link[rel=modulepreload], link[as=script], link[rel=stylesheet], style, iframe, nextjs-portal').forEach(e => e.remove());
  doc.style.removeProperty('zoom');
  if (window.__vh) window.__vh.undo();  // no layout is read until redo, so no scroll clamps
  let css = '';
  for (const ss of document.styleSheets) { const base = ss.href || location.href; try { for (const r of ss.cssRules) css += r.cssText.replace(/url\(\s*["']?([^"')]+)["']?\s*\)/g, (m, u) => u.startsWith('data:') ? m : 'url(' + new URL(u, base).href + ')') + '\n'; } catch (e) {} }
  if (window.__vh) window.__vh.redo();
  const imgs = [...doc.querySelectorAll('img[src]')].map(e => e.getAttribute('src'));
  return { html: doc.outerHTML, css, imgs, sx: window.scrollX, sy: window.scrollY };
}"""

VH_JS = r"""z => {
  const ch = [];
  for (const ss of document.styleSheets) { let rules; try { rules = ss.cssRules; } catch (e) { continue; }
    const walk = rs => { for (const r of rs) { if (r.cssRules) walk(r.cssRules); if (!r.style) continue;
      for (const prop of [...r.style]) { const v = r.style.getPropertyValue(prop); if (!/\d(d|s|l)?vh/.test(v)) continue;
        ch.push([r.style, prop, v, v.replace(/([\d.]+)((d|s|l)?vh)/g, (m, n, u) => (parseFloat(n) / z) + u), r.style.getPropertyPriority(prop)]); } } };
    walk(rules); }
  window.__vh = { undo: () => ch.forEach(([st, p, o, n, pr]) => st.setProperty(p, o, pr)), redo: () => ch.forEach(([st, p, o, n, pr]) => st.setProperty(p, n, pr)) };
  window.__vh.redo();
}"""

def fetch(url, name):
    p = os.path.join(AS, name)
    if not os.path.exists(p):
        with urllib.request.urlopen(url) as r: open(p, "wb").write(r.read())
    return "../assets/" + name

def save(page, name, vw, vh):
    page.mouse.move(vw - 4, 4); page.wait_for_timeout(200)  # no row left lit by a hover
    # At the very end of the page the sticky bar lifts off the bottom (the page's own bottom
    # padding shows under it); stop just short of the end.
    page.evaluate("() => { const m = document.documentElement.scrollHeight - innerHeight; if (m > 0 && scrollY >= m - 2) scrollTo(0, m - 40); }"); page.wait_for_timeout(150)
    d = page.evaluate(SNAP_JS)
    css = d["css"]
    def rep(m):
        u = m.group(1).strip("'\"")
        if u.startswith("data:"): return m.group(0)
        full = u if u.startswith("http") else B + u
        return "url(" + fetch(full, os.path.basename(u.split("?")[0])) + ")"
    css = re.sub(r"url\(([^)]+)\)", rep, css)
    html = d["html"]
    for src in d["imgs"]:
        if src.startswith("/") and not src.startswith("//"):
            html = html.replace('src="%s"' % src, 'src="%s"' % fetch(B + src, re.sub(r"[^A-Za-z0-9._-]", "_", os.path.basename(src.split("?")[0])) or "img"))
    hook = ('<meta name="mockup-viewport" content="%dx%d"><style>%s</style>'
            '<script>(function(){var t=new URLSearchParams(location.search).get("theme");'
            'document.documentElement.setAttribute("data-theme",t==="dark"?"dark":"light");'
            'addEventListener("load",function(){document.querySelectorAll("[data-mock-scroll]").forEach(function(e){e.scrollTop=+e.getAttribute("data-mock-scroll")});'
            'scrollTo(%d,%d)})})()</script>') % (vw, vh, css, d["sx"], d["sy"])
    html = re.sub(r"<head>", "<head>" + hook, html, count=1)
    html = re.sub(r'\sdata-theme="[a-z]*"', "", html, count=1)
    open(os.path.join(FR, name + ".html"), "w").write("<!DOCTYPE html>" + html)
    page.screenshot(path=os.path.join(FR, name + ".png"))
    print("saved", name, flush=True)

def start(page, n=9):
    page.goto(B + "/login?next=%2Fhome")
    page.evaluate("n => {localStorage.clear(); localStorage.setItem('po-mock-scenario','eng-check'); localStorage.setItem('po-mock-eng-n', String(n)); localStorage.setItem('oracle-theme','light')}", n)
    page.reload()
    page.get_by_label("Email").fill("commenter@example.com")  # the eng-check scenario's engineering lead, named Sam Okafor for the mock-ups
    page.get_by_label("Password").fill("demo")
    page.get_by_role("button", name="Sign in").click()
    page.wait_for_url("**/home")

def open_review(page, q, zoom=None):
    page.goto(REVIEW + "?" + q)
    page.get_by_test_id("decision-bar").wait_for()
    page.wait_for_timeout(700)
    if zoom and OWN:
        page.set_viewport_size({"width": 1512, "height": 945}); page.wait_for_timeout(500)
    elif OWN and page.viewport_size["width"] == 1512:
        page.set_viewport_size({"width": 1440, "height": 900}); page.wait_for_timeout(500)
    elif zoom:
        # The gate owns the window (1440 x 900), so 1512 x 945 is a CSS zoom. Under zoom a vh is
        # still 1/100 of 900 px, so the PNG scales every vh length by 1/zoom (no band at the
        # bottom); the HTML snapshot keeps the original rules (it opens at 1512 x 945 itself).
        page.evaluate("z => document.documentElement.style.zoom = String(z)", zoom)
        page.evaluate(VH_JS, zoom)
        page.wait_for_timeout(300)

def insp(page): return page.get_by_test_id("brief-inspector")
def card(page, key): return page.locator(f'[data-testid="brief-row"][data-feature="{key}"]')

def verdict_with_note(scope, text, save_it):
    scope.get_by_role("group", name="Verdict").get_by_role("button", name="Feasible with changes", exact=True).click()
    scope.get_by_role("textbox", name="What changes").fill(text)
    if save_it:
        scope.get_by_role("button", name="Save verdict").click()
        scope.page.wait_for_timeout(600) if hasattr(scope, "page") else None

NOTE = "Labels only in the regions the provider serves; the rest get a printable address slip."
ANS = "Yes in 11 of our 14 regions; the other 3 fall back to the address slip."
ANS2 = "The buyer pays, from the refund, unless the item arrived damaged."

def pause(page, ms=600): page.wait_for_timeout(ms)

def frames_desktop(page, only):
    W = (1440, 900); H = (1512, 945); Z = 1440 / 1512
    def want(n): return not only or any(n.startswith(o) for o in only)
    # ---------------- EC1 a: compact table + scrolling panel
    for name in ["ec1-a-rest", "ec1-a-open", "ec1-a-mid", "ec1-a-result"]:
        if not want(name): continue
        start(page); open_review(page, "ec1=a")
        if name != "ec1-a-rest":
            card(page, RET).click(); pause(page)
        if name in ("ec1-a-mid", "ec1-a-result"):
            verdict_with_note(insp(page), NOTE, name == "ec1-a-result"); pause(page)
        save(page, name, *W)
    if want("ec1-a-hard"):
        start(page, 15); open_review(page, "ec1=a", Z)
        card(page, RET).click(); pause(page)
        page.get_by_test_id("panel-scroll").evaluate("e => e.scrollTop = 520"); pause(page)
        save(page, "ec1-a-hard-1512", *H)
    # ---------------- EC1 b: master-detail
    for name in ["ec1-b-rest", "ec1-b-open", "ec1-b-mid", "ec1-b-result"]:
        if not want(name): continue
        start(page); open_review(page, "ec1=b")
        if name != "ec1-b-rest":
            card(page, RET).click(); pause(page)
        if name in ("ec1-b-mid", "ec1-b-result"):
            verdict_with_note(insp(page), NOTE, name == "ec1-b-result"); pause(page)
        save(page, name, *W)
    if want("ec1-b-hard"):
        start(page, 15); open_review(page, "ec1=b", Z)
        card(page, "f.invoice-pdf").click(); pause(page)
        insp(page).get_by_role("group", name="Verdict").get_by_role("button", name="Feasible", exact=True).click(); pause(page)
        page.locator('section[aria-label="Features"]').evaluate("e => e.scrollTop = e.scrollHeight"); pause(page)
        save(page, "ec1-b-hard-1512", *H)
    # ---------------- EC1 c: one card per feature
    for name in ["ec1-c-rest", "ec1-c-open", "ec1-c-mid", "ec1-c-result"]:
        if not want(name): continue
        start(page); open_review(page, "ec1=c")
        if name != "ec1-c-rest":
            c = card(page, RET); c.get_by_role("button", name=re.compile("^Show all")).click(); pause(page)
            c.evaluate("e => window.scrollTo(0, e.getBoundingClientRect().top + window.scrollY - 16)"); pause(page)
        if name in ("ec1-c-mid", "ec1-c-result"):
            c = card(page, RET); verdict_with_note(c, NOTE, name == "ec1-c-result"); pause(page)
            c.get_by_test_id("decide").scroll_into_view_if_needed(); pause(page)
        save(page, name, *W)
    if want("ec1-c-hard"):
        start(page, 15); open_review(page, "ec1=c", Z)
        card(page, "f.gift-cards").evaluate("e => window.scrollTo(0, e.getBoundingClientRect().top + window.scrollY - 16)"); pause(page)
        save(page, "ec1-c-hard-1512", *H)
    # ---------------- EC1 d: one feature at a time
    for name in ["ec1-d-rest", "ec1-d-open", "ec1-d-mid", "ec1-d-result"]:
        if not want(name): continue
        start(page); open_review(page, "ec1=d")
        if name != "ec1-d-rest":
            page.get_by_role("navigation", name="Features").get_by_role("button", name=re.compile(r"^7\. ")).click(); pause(page)
        if name in ("ec1-d-mid", "ec1-d-result"):
            verdict_with_note(insp(page), NOTE, name == "ec1-d-result"); pause(page)
            page.get_by_test_id("decide").scroll_into_view_if_needed(); pause(page)
        save(page, name, *W)
    if want("ec1-d-hard"):
        start(page, 15); open_review(page, "ec1=d", Z)
        page.get_by_role("navigation", name="Features").get_by_role("button", name=re.compile(r"^7\. ")).click(); pause(page)
        verdict_with_note(insp(page), NOTE, True); pause(page)
        page.get_by_role("button", name="Next feature").click(); pause(page)
        page.evaluate("scrollTo(0,0)"); pause(page)
        save(page, "ec1-d-hard-1512", *H)
    # ---------------- EC2 (inside EC1 b)
    for L in "abc":
        for st in ["rest", "mid", "result"]:
            name = f"ec2-{L}-{st}"
            if not want(name): continue
            start(page); open_review(page, f"ec1=b&ec2={L}&sel={RET}")
            box = page.get_by_role("textbox", name=re.compile("^Answer: Does the shipping provider")).first
            if st != "rest" or L == "a":
                pass
            if st in ("mid", "result"):
                box.scroll_into_view_if_needed(); box.fill(ANS); pause(page, 300)
                if L == "a" and st == "mid": page.evaluate("scrollTo(0, Math.min(scrollY, document.documentElement.scrollHeight - innerHeight - 40))"); pause(page)
            if st == "result":
                box.locator("xpath=..").get_by_role("button", name="Answer").click(); pause(page)
                if L == "c":
                    pass
                else:
                    page.get_by_test_id("answer").first.scroll_into_view_if_needed(); pause(page)
                if L == "a": page.evaluate("scrollTo(0, Math.min(scrollY, document.documentElement.scrollHeight - innerHeight - 40))"); pause(page)
            save(page, name, *W)
        name = f"ec2-{L}-hard-1512"
        if want(name):
            # the returns feature with all three answered, at the owner's window
            start(page, 15); open_review(page, f"ec1=b&ec2={L}&sel={RET}", Z)
            for label, text in [("Does the shipping provider", ANS), ("Who pays for the label", ANS2), ("Do we need scanning", "Marking by hand is enough for now.")]:
                b = page.get_by_role("textbox", name=re.compile("^Answer: " + label)).first
                b.fill(text); b.locator("xpath=..").get_by_role("button", name="Answer").click(); pause(page, 500)
            if L == "c":
                page.get_by_role("button", name=re.compile("^Show 3 answered")).click(); pause(page)
                page.locator('[data-testid="all-questions"] [data-answered="true"]').first.evaluate("e => window.scrollTo(0, e.getBoundingClientRect().top + window.scrollY - 220)")
            elif L == "a":
                page.get_by_test_id("answer").first.scroll_into_view_if_needed(); pause(page)
                page.evaluate("scrollTo(0, Math.min(scrollY, document.documentElement.scrollHeight - innerHeight - 40))")
            else:
                page.evaluate("scrollTo(0,0)")
            pause(page)
            save(page, name, *H)

def frames_phone(page, only):
    P = (390, 844)
    def want(n): return not only or any(n.startswith(o) for o in only)
    if want("ec1-a-phone"):
        start(page); open_review(page, "ec1=a")
        card(page, RET).click(); pause(page)
        save(page, "ec1-a-phone-390", *P)
    if want("ec1-b-phone"):
        start(page); open_review(page, "ec1=b"); save(page, "ec1-b-phone-390", *P)
        card(page, RET).click(); pause(page); page.evaluate("scrollTo(0,0)"); pause(page)
        save(page, "ec1-b-phone-open-390", *P)
    if want("ec1-c-phone"):
        start(page); open_review(page, "ec1=c"); save(page, "ec1-c-phone-390", *P)
    if want("ec1-d-phone"):
        start(page); open_review(page, "ec1=d"); save(page, "ec1-d-phone-390", *P)
    for L in "abc":
        # the returns feature on a phone, its first blocking question just answered
        name = f"ec2-{L}-phone-390"
        if not want(name): continue
        start(page); open_review(page, f"ec1=b&ec2={L}&sel={RET}")
        box = page.get_by_role("textbox", name=re.compile("^Answer: Does the shipping provider")).first
        box.scroll_into_view_if_needed(); box.fill(ANS); pause(page, 300)
        box.locator("xpath=..").get_by_role("button", name="Answer").click(); pause(page)
        if L == "c":
            page.get_by_test_id("all-questions").evaluate("e => window.scrollTo(0, e.getBoundingClientRect().top + window.scrollY - 64)")
        else:
            page.get_by_test_id("answer").first.evaluate("e => window.scrollTo(0, e.getBoundingClientRect().top + window.scrollY - 200)")
        pause(page)
        save(page, name, *P)

if __name__ == "__main__":
    mode = sys.argv[1]; only = sys.argv[2:]
    if OWN:
        # Own Chromium (when the live browser is gone): run under swarm-test-browsers, scrollbars shown.
        from playwright.sync_api import sync_playwright
        pw = sync_playwright().start()
        browser = pw.chromium.launch(channel="chromium", ignore_default_args=["--hide-scrollbars"])
        phone = dict(viewport={"width": 390, "height": 844}, is_mobile=True, has_touch=True, device_scale_factor=1)
        ctx = browser.new_context(**(phone if mode == "phone" else dict(viewport={"width": 1440, "height": 900})))
    else:
        from swarm_browser import live
        pw, browser, ctx = live()
    page = ctx.new_page()
    try:
        (frames_phone if mode == "phone" else frames_desktop)(page, only)
    finally:
        page.close()
        if OWN: browser.close()
        pw.stop()
