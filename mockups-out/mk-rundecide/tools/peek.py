import sys, time
from swarm_browser import live
pw, browser, ctx = live()
page = ctx.new_page()
print(page.viewport_size, page.evaluate("innerWidth"))
page.goto("http://localhost:3393/login?next=%2Fhome")
page.get_by_label("Email").fill("admin@example.com")
page.get_by_label("Password").fill("demo")
page.get_by_role("button", name="Sign in").click()
page.wait_for_url("**/home")
for i,u in enumerate(sys.argv[1:]):
    page.goto("http://localhost:3393"+u); time.sleep(3)
    page.screenshot(path=f"/workspace/att_b6adb80d0140404591d9/artifacts/peek{i}.png", full_page=True)
    print(u, page.url, page.evaluate("document.body.innerText.length"))
page.close()
pw.stop()
