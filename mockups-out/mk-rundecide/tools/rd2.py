from common import *
pw, page = start()
W=1440
P="/simple/one-pagers/usage-alerts"
bar='[data-testid="rd2-bar"]'
def b(): return page.locator(bar)
for v in "abc":
    go(page, f"{P}?rd2={v}"); snap(page, f"rd2-{v}-rest", W, 900)
    b().get_by_role("button", name="Approve", exact=True).click(); time.sleep(.4)
    snap(page, f"rd2-{v}-open", W, 900)
    page.locator("#rd2-note").fill("Good to build from version 3."); time.sleep(.3)
    snap(page, f"rd2-{v}-mid", W, 900)
    b().get_by_role("button", name="Approve review and PRD" if v=="a" else "Approve review").click(); time.sleep(.4)
    if v=="b":
        snap(page, "rd2-b-next", W, 900)
        b().get_by_role("button", name="Approve the PRD").click(); time.sleep(.4)
    snap(page, f"rd2-{v}-done", W, 900)
# hard cases
go(page, f"{P}?rd2=a&draft=1&open=1&phase=mid"); snap(page, "rd2-a-draft-1512", 1512, 900)
go(page, f"{P}?rd2=b&phase=next"); snap(page, "rd2-b-next-1512", 1512, 900)
go(page, f"{P}?rd2=c&phase=done"); snap(page, "rd2-c-done-1512", 1512, 900)
page.close(); pw.stop()
