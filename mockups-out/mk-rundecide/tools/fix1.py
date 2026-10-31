from common import *
pw, page = start()
go(page, "/simple/decisions?rd1=c", 3); page.evaluate("window.scrollTo(0, document.documentElement.scrollHeight)"); time.sleep(.5); snap(page, "rd1-c-rest", 1440, 900)
page.close(); pw.stop()
