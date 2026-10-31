# Every frame from one data state: a fresh mock database, desktop then phone, RD3's meeting last.
from common import *
import sys
only = sys.argv[1:] or ["rd1", "rd2", "phone12", "rd3", "phone3"]
W = 1440
import common
pw, page = start()
common._page = page

def rd1():
    for v in "ab":
        go(page, f"/simple/decisions?rd1={v}")
        sel = '[data-testid="rd1-runs"]' if v == "a" else '[data-testid="rd1-mixed"]'
        show(page, sel); snap(page, f"rd1-{v}-rest", W, 900)
        page.locator(sel).get_by_role("button", name="Show what happened").first.click(); time.sleep(0.5)
        snap(page, f"rd1-{v}-open", W, 900)
        go(page, f"/simple/decisions?rd1={v}&many=1"); show(page, sel); snap(page, f"rd1-{v}-many-1512", 1512, 900)
    go(page, "/simple/decisions?rd1=c", 3); page.evaluate("window.scrollTo(0, document.documentElement.scrollHeight)"); time.sleep(.5); snap(page, "rd1-c-rest", W, 900)
    page.get_by_role("link", name="Usage alerts PRD").click(); time.sleep(3); snap(page, "rd1-c-prd", W, 900)
    page.locator('[data-testid="rd1-prd"]').get_by_role("button").click(); time.sleep(0.5); snap(page, "rd1-c-open", W, 900)
    page.locator('[data-testid="rd1-prd"]').get_by_role("button", name="Show what happened").click(); time.sleep(0.5); snap(page, "rd1-c-open-1512", 1512, 900)

P = "/simple/one-pagers/usage-alerts"
def rd2():
    b = lambda: page.locator('[data-testid="rd2-bar"]')
    for v in "abc":
        go(page, f"{P}?rd2={v}"); snap(page, f"rd2-{v}-rest", W, 900)
        b().get_by_role("button", name="Approve", exact=True).click(); time.sleep(.4)
        snap(page, f"rd2-{v}-open", W, 900)
        page.locator("#rd2-note").fill("Good to build from version 3."); time.sleep(.3)
        snap(page, f"rd2-{v}-mid", W, 900)
        b().get_by_role("button", name="Approve review and PRD" if v == "a" else "Approve review").click(); time.sleep(.4)
        if v == "b":
            snap(page, "rd2-b-next", W, 900)
            b().get_by_role("button", name="Approve the PRD").click(); time.sleep(.4)
        snap(page, f"rd2-{v}-done", W, 900)
    go(page, f"{P}?rd2=a&draft=1&open=1&phase=mid"); snap(page, "rd2-a-draft-1512", 1512, 900)
    go(page, f"{P}?rd2=b&phase=next"); snap(page, "rd2-b-next-1512", 1512, 900)
    go(page, f"{P}?rd2=c&phase=done"); snap(page, "rd2-c-done-1512", 1512, 900)

def phone12():
    w, h = 390, 844
    go(page, "/simple/decisions?rd1=a", 3); show(page, '[data-testid="rd1-runs"]'); snap(page, "rd1-a-rest-390", w, h)
    go(page, "/simple/decisions?rd1=b", 3); show(page, '[data-testid="rd1-mixed"]'); snap(page, "rd1-b-rest-390", w, h)
    go(page, f"{P}?rd1=c", 3); show(page, '[data-testid="rd1-prd"]'); snap(page, "rd1-c-prd-390", w, h)
    for v in "abc":
        go(page, f"{P}?rd2={v}&open=1&phase=mid", 3); show(page, '[data-testid="rd2-bar"]'); snap(page, f"rd2-{v}-open-390", w, h)

def decide(loc, name):
    loc.get_by_role("button", name="Another answer").first.click(); time.sleep(.4)
    loc.get_by_label("Your answer").first.fill("Not in the first release; look again in the spring"); time.sleep(.3)
    snap(page, f"{name}-open", W, 900)
    loc.get_by_role("button", name="Decide", exact=True).first.click(); time.sleep(.5)
    snap(page, f"{name}-done", W, 900)

MURL = os.path.join(os.environ.get("TMPDIR", "."), "murl.txt")
def agenda(murl, v):
    go(page, f"{murl}?rd3={v}", 3)
    page.get_by_role("navigation", name="Steps").get_by_role("button", name="Decisions").first.click(); time.sleep(2)

def rd3():
    go(page, "/simple?rd3=a", 3); show(page, '[data-testid="rd3-home"]', 120); snap(page, "rd3-a-rest", W, 900)
    decide(page.locator('[data-testid="rd3-home"]'), "rd3-a")
    go(page, "/simple?rd3=a", 3); snap(page, "rd3-a-rest-1512", 1512, 900)
    go(page, "/simple/decisions?rd3=c", 3); show(page, '[data-testid="rd3-section"]'); snap(page, "rd3-c-rest", W, 900)
    decide(page.locator('[data-testid="rd3-section"]'), "rd3-c")
    go(page, "/simple/decisions?rd3=c&many=1", 3); show(page, '[data-testid="rd3-section-more"]', 420); snap(page, "rd3-c-rest-1512", 1512, 900)
    go(page, P)
    page.get_by_role("button", name="Start review").first.click(); time.sleep(1)
    d = page.get_by_role("dialog", name="Start a review"); d.get_by_label("Approver").check(); d.get_by_role("button", name="Start", exact=True).click(); time.sleep(4)
    murl = page.get_by_test_id("meeting-chat-page-link").get_attribute("href").split("?")[0].removesuffix("/chat")
    open(MURL, "w").write(murl); print("meeting", murl)
    for v in "ba":
        agenda(murl, v); snap(page, f"rd3-{v}-agenda", W, 900)
    agenda(murl, "b"); decide(page.locator('[data-testid="rd3-agenda"]'), "rd3-b")
    agenda(murl, "b"); snap(page, "rd3-b-agenda-1512", 1512, 900)
    go(page, "/simple?rd3=b", 3); snap(page, "rd3-b-home", W, 900)

def phone3():
    w, h = 390, 844
    murl = open(MURL).read()
    go(page, "/simple?rd3=a", 3); show(page, '[data-testid="rd3-home"]'); snap(page, "rd3-a-rest-390", w, h)
    go(page, f"{murl}?rd3=b", 3)
    try:
        page.get_by_role("navigation", name="Steps").get_by_role("button", name="Decisions").first.click(timeout=5000); time.sleep(2)
    except Exception as e: print("steps?", e)
    show(page, '[data-testid="rd3-agenda"]'); snap(page, "rd3-b-agenda-390", w, h)
    go(page, "/simple/decisions?rd3=c", 3); show(page, '[data-testid="rd3-section"]'); snap(page, "rd3-c-rest-390", w, h)

try:
    for step in only:
        if step.startswith("phone"): device("phone-390")
        else: device("desktop")
        globals()[step]()
finally:
    pw.close(); common._pw.stop()
