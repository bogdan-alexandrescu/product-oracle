import sys, time
sys.path.insert(0, '.')
from snap import *
from login import login
pw, br, ctx = live()
page = ctx.new_page()
def role(r):
    page.goto(BASE + '/simple'); time.sleep(1)
    if r: page.evaluate(f"localStorage.setItem('po-mock-role','{r}')")
    else: page.evaluate("localStorage.removeItem('po-mock-role')")
    page.reload(); time.sleep(1)
def go(u, wait=3):
    page.goto(BASE + u); time.sleep(wait)
only = sys.argv[1:]
def want(n): return not only or n in only
try:
    if want('roles'):
        role('viewer')
        go('/simple/my-work?mw2=a'); save(page, 'mw2-a-viewer', '1440x900')
        go('/simple/my-work?mw3=a&case=none'); save(page, 'mw3-a-viewer', '1440x900')
        role('commenter')
        go('/simple/my-work?mw2=a'); save(page, 'mw2-a-commenter', '1440x900')
        role(None)
    if want('mw2a'):
        go('/simple/my-work?mw2=a&act=done&cost=1'); save(page, 'mw2-a-result', '1440x900')
    if want('mw1a'):
        go('/simple/my-work?mw1=a&panel=f1&cost=1'); save(page, 'mw1-a-result', '1440x900')
    if want('mw1c'):
        go('/simple/roadmap?mw1=c&mine=1&cost=1')
        page.locator('[data-mw-mine]').get_by_text('One-tap sign-up link').first.click(); time.sleep(2)
        save(page, 'mw1-c-result', '1440x900')
    if want('mw3c'):
        go('/simple/my-work?mw3=c&case=none')
        page.get_by_text('Set owners on the Roadmap').first.click(); time.sleep(3)
        r = page.get_by_text('Rep call script hints').first
        time.sleep(4); r.scroll_into_view_if_needed(); r.hover(); time.sleep(2)
        save(page, 'mw3-c-open', '1440x900')
        r.click(); time.sleep(2)
        page.get_by_role('button', name='Change the owner').click(); time.sleep(1)
        page.get_by_test_id('card-owner-edit').locator('select').select_option(label='Avery Stone'); time.sleep(1.5)
        save(page, 'mw3-c-mid', '1440x900')
        u = page.get_by_role('button', name='Undo')
        if u.count(): u.first.click(); time.sleep(1); print('undone')
finally:
    page.close(); pw.stop()
