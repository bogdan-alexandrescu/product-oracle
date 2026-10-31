from common import *
pw, page = start()
W=1440
# a: Home
go(page, "/simple?rd3=a", 3); show(page, '[data-testid="rd3-home"]'); page.evaluate("window.scrollBy(0,-120)"); time.sleep(.3)
snap(page, "rd3-a-rest", W, 900)
h = page.locator('[data-testid="rd3-home"]')
h.get_by_role("button", name="Decide").first.click(); time.sleep(.4); snap(page, "rd3-a-open", W, 900)
h.get_by_role("button", name="Not in the first release").click(); time.sleep(.4); snap(page, "rd3-a-done", W, 900)
go(page, "/simple?rd3=a", 3); snap(page, "rd3-a-rest-1512", 1512, 900)
# c: Decisions page section
go(page, "/simple/decisions?rd3=c", 3); show(page, '[data-testid="rd3-section"]'); snap(page, "rd3-c-rest", W, 900)
s = page.locator('[data-testid="rd3-section"]')
s.get_by_role("button", name="Decide").first.click(); time.sleep(.4); snap(page, "rd3-c-open", W, 900)
s.get_by_role("button", name="Not in the first release").click(); time.sleep(.4); snap(page, "rd3-c-done", W, 900)
go(page, "/simple/decisions?rd3=c", 3); snap(page, "rd3-c-rest-1512", 1512, 900)
# b (and a): the review meeting's agenda
go(page, "/simple/one-pagers/usage-alerts")
page.get_by_role("button", name="Start review").first.click(); time.sleep(1)
d = page.get_by_role("dialog", name="Start a review"); d.get_by_label("Approver").check(); d.get_by_role("button", name="Start", exact=True).click(); time.sleep(4)
murl = page.url.replace("http://localhost:3393", "")
print("meeting", murl)
def agenda(v):
    go(page, f"{murl}?rd3={v}", 3)
    page.get_by_role("navigation", name="Steps").get_by_role("button", name="Decisions").first.click(); time.sleep(2)
for v in "ba":
    agenda(v); snap(page, f"rd3-{v}-agenda", W, 900)
agenda("b"); a = page.locator('[data-testid="rd3-agenda"]')
a.get_by_role("button", name="Decide").first.click(); time.sleep(.4); snap(page, "rd3-b-open", W, 900)
a.get_by_role("button", name="Not in the first release").click(); time.sleep(.4); snap(page, "rd3-b-done", W, 900)
agenda("b"); snap(page, "rd3-b-agenda-1512", 1512, 900)
go(page, "/simple?rd3=b", 3); snap(page, "rd3-b-home", W, 900)
open("/cache/att_b6adb80d0140404591d9/tmp/mk/murl.txt","w").write(murl)
page.close(); pw.stop()
