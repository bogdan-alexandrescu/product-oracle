from common import *
pw, page = start()
go(page, "/simple/one-pagers/usage-alerts?rd3=a")
page.get_by_role("button", name="Start review").first.click(); time.sleep(1)
d = page.get_by_role("dialog", name="Start a review")
d.get_by_label("Approver").check()
d.get_by_role("button", name="Start", exact=True).click(); time.sleep(4)
print(page.url)
print(page.evaluate("document.querySelector('main')?.innerText || document.body.innerText")[:1500])
for n in ["Decisions","Decide"]:
    try:
        page.get_by_role("navigation", name="Steps").get_by_role("button", name=n).first.click(timeout=3000); time.sleep(2); print("clicked", n); break
    except Exception as e: print("no", n)
print(page.evaluate("document.querySelector('main')?.innerText")[:1200])
print(page.get_by_role("navigation", name="Steps").inner_text())
page.close(); pw.stop()
