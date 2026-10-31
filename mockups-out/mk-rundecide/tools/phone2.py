from common import *
pw, page = start()
for v in "abc":
    go(page, f"/simple/one-pagers/usage-alerts?rd2={v}&open=1&phase=mid", 3); show(page, '[data-testid="rd2-bar"]'); snap(page, f"rd2-{v}-open-390", 390, 844)
page.close(); pw.stop()
