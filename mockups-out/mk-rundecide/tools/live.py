from common import *
pw, page = start()
go(page, "/simple/meetings", 3)
print([a.get_attribute("href") for a in page.query_selector_all("a[href*='/simple/meetings/']")])
print(page.evaluate("document.querySelector('main').innerText")[:400])
page.close(); pw.stop()
