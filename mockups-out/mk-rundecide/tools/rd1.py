from common import *
pw, page = start()
W=1440
for v in "ab":
    go(page, f"/simple/decisions?rd1={v}")
    sel = '[data-testid="rd1-runs"]' if v=="a" else '[data-testid="rd1-mixed"]'
    show(page, sel); snap(page, f"rd1-{v}-rest", W, 900)
    page.locator(sel).get_by_role("button", name="Show what happened").first.click(); time.sleep(0.5)
    snap(page, f"rd1-{v}-open", W, 900)
    go(page, f"/simple/decisions?rd1={v}&many=1"); show(page, sel); snap(page, f"rd1-{v}-many-1512", 1512, 900)
go(page, "/simple/decisions?rd1=c"); show(page, '[data-testid="rd1-note"]'); page.evaluate("window.scrollBy(0,-500)"); time.sleep(.3); snap(page, "rd1-c-rest", W, 900)
page.get_by_role("link", name="Usage alerts PRD").click(); time.sleep(3); snap(page, "rd1-c-prd", W, 900)
page.locator('[data-testid="rd1-prd"]').get_by_role("button").click(); time.sleep(0.5); snap(page, "rd1-c-open", W, 900)
page.locator('[data-testid="rd1-prd"]').get_by_role("button", name="Show what happened").click(); time.sleep(0.5); snap(page, "rd1-c-open-1512", 1512, 900)
page.close(); pw.stop()
