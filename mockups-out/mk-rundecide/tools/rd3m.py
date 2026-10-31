from common import *
pw, page = start()
W=1440
# b (and a): the review meeting's agenda
murl = "/simple/meetings/866890a0-b31f-468a-9f95-0d684af73bbf"
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
