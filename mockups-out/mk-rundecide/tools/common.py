import time, sys
sys.path.insert(0, "/cache/att_b6adb80d0140404591d9/tmp/mk")
from swarm_browser import live
from snap import snap, BASE
def start():
    pw, browser, ctx = live()
    page = ctx.new_page()
    page.goto(BASE + "/login?next=%2Fhome"); time.sleep(3)
    if "/login" in page.url and page.query_selector("input[type=password]"):
        page.get_by_label("Email").fill("admin@example.com"); page.get_by_label("Password").fill("demo")
        page.get_by_role("button", name="Sign in").click(); page.wait_for_url("**/home")
    return pw, page
def go(page, path, wait=2.5):
    page.goto(BASE + path); time.sleep(wait)
def show(page, sel):
    page.locator(sel).first.evaluate("e => e.scrollIntoView({block:'start'})"); page.evaluate("window.scrollBy(0,-24)"); time.sleep(0.4)
