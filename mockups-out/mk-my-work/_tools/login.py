import sys, time
sys.path.insert(0, '.')
from snap import *
def login(page):
    page.goto(BASE + '/login'); time.sleep(1.5)
    page.get_by_label('Email').fill('admin@example.com')
    page.get_by_label('Password').fill('demo')
    page.get_by_role('button', name='Sign in').click(); time.sleep(3)
    return page.url
if __name__ == '__main__':
    pw, br, ctx = live(); page = ctx.new_page()
    print(login(page)); print(page.locator('body').inner_text()[:400])
    page.close(); pw.stop()
