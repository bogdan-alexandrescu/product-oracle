import sys, time
from swarm_browser import live
pw, browser, ctx = live()
page = ctx.new_page()
page.goto("http://localhost:3393/login?next=%2Fhome")
time.sleep(4)
if "/login" in page.url and page.query_selector("input[type=password]"):
    page.get_by_label("Email").fill("admin@example.com"); page.get_by_label("Password").fill("demo")
    page.get_by_role("button", name="Sign in").click(); page.wait_for_url("**/home")
for u in sys.argv[1:]:
    page.goto("http://localhost:3393"+u); time.sleep(3)
    print("==",u); print(page.evaluate("document.querySelector('main')?.innerText || document.body.innerText")[:1500])
    print([a.get_attribute("href") for a in page.query_selector_all("main a[href*='meetings/']")][:8])
page.close(); pw.stop()
