from common import *
pw, page = start()
W, H = 390, 844
go(page, "/simple/decisions?rd1=a", 3); show(page, '[data-testid="rd1-runs"]'); snap(page, "rd1-a-rest-390", W, H)
go(page, "/simple/decisions?rd1=b", 3); show(page, '[data-testid="rd1-mixed"]'); snap(page, "rd1-b-rest-390", W, H)
go(page, "/simple/one-pagers/usage-alerts?rd1=c", 3); show(page, '[data-testid="rd1-prd"]'); snap(page, "rd1-c-prd-390", W, H)
for v in "abc":
    go(page, f"/simple/one-pagers/usage-alerts?rd2={v}&open=1&phase=mid", 3); show(page, '[data-testid="rd2-bar"]'); snap(page, f"rd2-{v}-open-390", W, H)
go(page, "/simple?rd3=a", 3); show(page, '[data-testid="rd3-home"]'); snap(page, "rd3-a-rest-390", W, H)
go(page, "/simple/meetings/866890a0-b31f-468a-9f95-0d684af73bbf?rd3=b", 3)
try:
    page.get_by_role("navigation", name="Steps").get_by_role("button", name="Decisions").first.click(timeout=5000); time.sleep(2)
except Exception as e: print("steps?", e)
show(page, '[data-testid="rd3-agenda"]'); snap(page, "rd3-b-agenda-390", W, H)
go(page, "/simple/decisions?rd3=c", 3); show(page, '[data-testid="rd3-section"]'); snap(page, "rd3-c-rest-390", W, H)
page.close(); pw.stop()
