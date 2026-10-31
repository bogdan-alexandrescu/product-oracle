import time, sys, os
sys.path.insert(0, __import__("os").path.dirname(__file__))
from snap import snap, BASE
_pw = None
def start(reset=False):
    """A Chromium of our own (run under swarm-test-browsers), scrollbars shown; a fresh context is a fresh mock database."""
    global _pw
    import glob
    from playwright.sync_api import sync_playwright
    _pw = sync_playwright().start()
    exe = glob.glob(os.environ["SWARM_TEST_BROWSERS_PATH"] + "/chromium-*/chrome-linux*/chrome")[0]
    browser = _pw.chromium.launch(executable_path=exe, ignore_default_args=["--hide-scrollbars"])
    page = browser.new_context(viewport={"width": 1440, "height": 900}).new_page()
    page.goto(BASE + "/login?next=%2Fhome"); time.sleep(3)
    if "/login" in page.url and page.query_selector("input[type=password]"):
        page.get_by_label("Email").fill("admin@example.com"); page.get_by_label("Password").fill("demo")
        page.get_by_role("button", name="Sign in").click(); page.wait_for_url("**/home")
    return browser, page
def go(page, path, wait=2.5):
    page.goto(BASE + path); time.sleep(wait)
def show(page, sel, gap=None):
    # scroll the window itself (never an inner box), leaving room under a phone's sticky top bar
    page.locator(sel).first.evaluate("(e, g) => { const off = g ?? (innerWidth < 600 ? 54 : 24); window.scrollTo(0, Math.max(0, e.getBoundingClientRect().top + scrollY - off)); }", gap); time.sleep(0.5)
_page = None
def device(name, page=None):
    size = {"desktop": (1440, 900), "phone-390": (390, 844)}[name]
    (page or _page).set_viewport_size({"width": size[0], "height": size[1]}); time.sleep(1)
