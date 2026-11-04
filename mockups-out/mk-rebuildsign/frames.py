"""Re-captures the rebuild-sign mock-up frames (MOCK-UPS ONLY, never merged).

Run the web app on the mock API with the MOCK-HOOK switches on this branch:
    cd web && npm run build:mock && npm run start:mock -- -p 3400
then: python3 mockups-out/mk-rebuildsign/frames.py [BASE_URL] [--only name-substring]
Each frame is saved as frames/<name>.html (CSS inlined, fonts in assets/, theme hook:
?theme=light|dark on the HTML file) and frames/<name>.png, captioned in frames.json.
"""

import json
import re
import shutil
import subprocess
import sys
import urllib.request
from urllib.parse import urljoin
from pathlib import Path

HERE = Path(__file__).resolve().parent
FRAMES = HERE / "frames"
ASSETS = HERE / "assets"
BASE = next((a for a in sys.argv[1:] if a.startswith("http")), "http://localhost:3400")
ONLY = sys.argv[sys.argv.index("--only") + 1] if "--only" in sys.argv else None

PAGES = {
    "one-pager": ("/simple/one-pagers/checkout-redesign", "Simple one-pager"),
    "list": ("/simple/one-pagers", "One-pagers list"),
    "roadmap": ("/simple/roadmap", "Simple Roadmap"),
    "detailed": ("/documents/checkout-redesign", "Detailed PRD page"),
    "home": ("/simple", "Home"),
}
NAMES = {"a": "A · status chip", "b": "B · banner", "c": "C · quiet marker and note"}
STATE_WORDS = {
    "running": "a run mid-step",
    "scheduled": "a scheduled run",
    "waiting": "a run waiting at a stop for Priya Raman",
    "failed": "a run that failed",
    "done": "the new version has landed",
}


def plan():
    out = []
    for p in "abc":
        def add(page, state="running", vp="desktop", theme="light", extra="", note=""):
            name = f"{p}-{page}-{state}{'-' + extra.replace('&', '').replace('=', '') if extra else ''}-{vp}-{theme}"
            q = f"?rb={p}&rbstate={state}{'&' + extra if extra else ''}"
            cap = f"{NAMES[p]}: {PAGES[page][1]}, {STATE_WORDS[state]}" + (f"; {note}" if note else "")
            out.append(dict(name=name, proposal=p.upper(), page=page, state=state, viewport=vp, theme=theme, url=PAGES[page][0] + q, caption=cap))

        for page in PAGES:
            add(page, note="a list row carries the quiet marker; the banner is on the page itself" if p == "b" and page == "list" else "")
        for st in ("scheduled", "waiting", "failed", "done"):
            add("one-pager", st)
        add("roadmap", "waiting")
        add("detailed", "done")
        add("one-pager", extra="rbtick=1", note="mid-update: a poll just moved it to step 3")
        if p == "a":
            add("one-pager", extra="rbopen=1", note="its popover open: steps, who started it, the next stop, Open run")
            add("roadmap", extra="rbopen=1", note="its popover open")
        add("one-pager", extra="rbcase=two", note="hard case: a regenerate and a roadmap run on the same PRD")
        add("roadmap", extra="rbcase=four", note="hard case: a roadmap fed by four PRDs, two of them rebuilding")
        for page in PAGES:
            add(page, vp="phone")
        add("one-pager", "waiting", vp="phone")
        if p == "a":
            add("one-pager", vp="phone", extra="rbopen=1", note="its popover open")
        for page in PAGES:
            add(page, theme="dark")
            add(page, vp="phone", theme="dark")
        add("one-pager", "waiting", vp="phone", theme="dark")
        add("home", "done", theme="dark")
    return out


def inline(page, name):
    """The page as one static HTML file: CSS inlined, fonts copied to assets/, scripts removed."""
    html = page.content()
    css = []
    for href in page.eval_on_selector_all("link[rel=stylesheet]", "els => els.map(e => e.href)"):
        text = urllib.request.urlopen(href).read().decode()

        def font(m, href=href):
            url = m.group(1).strip("'\"")
            fn = url.split("/")[-1].split("?")[0].split("#")[0]
            dst = ASSETS / fn
            if not dst.exists():
                dst.write_bytes(urllib.request.urlopen(urljoin(href, url)).read())
            return f"url(../assets/{fn})"

        css.append(re.sub(r"url\(([^)]+\.(?:woff2?|ttf|otf)[^)]*)\)", font, text))
    css = "\n".join(css)
    html = re.sub(r"<script\b[^>]*>.*?</script>", "", html, flags=re.S)
    html = re.sub(r"<link\b[^>]*(?:stylesheet|preload|modulepreload|icon)[^>]*>", "", html)
    hook = (
        "<script>/* theme hook: ?theme=light|dark */try{var t=new URLSearchParams(location.search).get('theme');"
        "if(t==='light'||t==='dark')document.documentElement.dataset.theme=t}catch(e){}</script>"
    )
    html = html.replace("</head>", f"<style>{css}</style>{hook}</head>", 1)
    (FRAMES / f"{name}.html").write_text(html)


def write_index(frames):
    """index.html: every frame by proposal, its caption, linked to its static HTML."""
    rows = []
    for p in "ABC":
        rows.append(f"<h2>Proposal {p}</h2><ul>")
        for f in (x for x in frames if x["proposal"] == p):
            rows.append(f'<li><a href="frames/{f["name"]}.html?theme={f["theme"]}">{f["name"]}</a> · {f["viewport"]} · {f["theme"]}: {f["caption"]}</li>')
        rows.append("</ul>")
    (HERE / "index.html").write_text(
        "<!doctype html><meta charset=utf-8><title>Rebuild sign mock-ups</title>"
        "<style>body{font:15px/1.5 system-ui;max-width:72rem;margin:2rem auto;padding:0 1rem}</style>"
        "<h1>MOCK-UPS ONLY: rebuild sign for PRDs and roadmaps</h1>" + "".join(rows) + "\n"
    )


def set_device(viewport, theme):
    """The live browser's size and colour scheme belong to its gate: set them by preset."""
    if shutil.which("swarm-handoff"):
        subprocess.run(["swarm-handoff", "device", "phone-390" if viewport == "phone" else "desktop"], check=True)
        subprocess.run(["swarm-handoff", "theme", theme], check=True)


def main():
    from swarm_browser import live

    FRAMES.mkdir(exist_ok=True)
    ASSETS.mkdir(exist_ok=True)
    pw, browser, ctx = live()
    page = ctx.new_page()
    errors = []
    page.on("console", lambda m: errors.append(f"{m.type}: {m.text}") if m.type in ("error", "warning") else None)
    page.on("pageerror", lambda e: errors.append(f"pageerror: {e}"))
    page.goto(BASE + "/login?next=%2Fsimple", wait_until="networkidle")
    if page.get_by_label("Email").count():
        page.get_by_label("Email").fill("admin@example.com")
        page.get_by_label("Password").fill("demo")
        page.get_by_role("button", name="Sign in").click()
        page.wait_for_url("**/simple", timeout=60000)
    meta_path = HERE / "frames.json"
    meta = {f["name"]: f for f in json.loads(meta_path.read_text())} if meta_path.exists() else {}
    report_path = HERE / "capture-report.json"
    report = json.loads(report_path.read_text()) if report_path.exists() and ONLY else {}
    current = None
    for f in sorted(plan(), key=lambda f: (f["viewport"], f["theme"])):
        if ONLY and ONLY not in f["name"]:
            continue
        if current != (f["viewport"], f["theme"]):
            current = (f["viewport"], f["theme"])
            set_device(*current)
        page.evaluate("t => localStorage.setItem('oracle-theme', t)", f["theme"])
        errors.clear()
        page.goto(BASE + f["url"], wait_until="networkidle", timeout=120000)
        page.wait_for_timeout(1500)
        width = page.evaluate("document.documentElement.scrollWidth")
        page.screenshot(path=str(FRAMES / f"{f['name']}.png"), full_page=False)
        inline(page, f["name"])
        report[f["name"]] = {"scrollWidth": width, "console": [e[:300] for e in errors]}
        meta[f["name"]] = {k: f[k] for k in ("name", "proposal", "page", "state", "viewport", "theme", "url", "caption")}
        print(f["name"], width, len(errors), flush=True)
    meta_path.write_text(json.dumps(list(meta.values()), indent=2) + "\n")
    write_index(list(meta.values()))
    report_path.write_text(json.dumps(report, indent=2) + "\n")
    page.evaluate("localStorage.removeItem('oracle-theme')")
    page.close()
    pw.stop()


if __name__ == "__main__":
    main()
