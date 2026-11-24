import time
from swarm_browser import live
OUT='/workspace/att_e30e3832efdf4aa19a45/work/repo/mockups-out/mk-my-work/frames/'
pw, br, ctx = live(); page = ctx.new_page()
try:
    print(page.viewport_size, page.evaluate('innerWidth'))
    for n in ['mw1-b','mw1-c','mw2-a','mw2-b','mw2-c','mw3-a','mw3-b','mw3-c']:
        page.goto(f'http://127.0.0.1:34263/frames/{n}-phone.html?theme=dark'); time.sleep(1.2)
        page.screenshot(path=OUT + f'{n}-phone-dark.png'); print('ok', n)
finally:
    page.close(); pw.stop()
