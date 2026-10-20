"""Render the six A1 frames with Playwright."""
import pathlib
from playwright.sync_api import sync_playwright
A1 = pathlib.Path(__file__).resolve().parent.parent
FRAMES = [("home-light-desktop", "home", "light", False), ("home-dark-desktop", "home", "dark", False),
          ("home-light-mobile", "home", "light", True), ("requests-light-desktop", "requests", "light", False),
          ("prd-review-light-desktop", "prd-review", "light", False), ("roadmap-light-desktop", "roadmap", "light", False)]
with sync_playwright() as p:
    b = p.chromium.launch()
    for name, page, scheme, mobile in FRAMES:
        vp = {"width": 390, "height": 844} if mobile else {"width": 1440, "height": 900}
        ctx = b.new_context(viewport=vp, device_scale_factor=2 if mobile else 1, color_scheme=scheme)
        pg = ctx.new_page()
        pg.goto((A1 / f"{page}.html").as_uri())
        pg.evaluate("document.fonts.ready")
        pg.wait_for_timeout(600)
        sw = pg.evaluate("document.documentElement.scrollWidth")
        h = pg.evaluate("document.documentElement.scrollHeight")
        if mobile:
            pg.set_viewport_size({"width": 390, "height": h})
            pg.wait_for_timeout(200)
            h = pg.evaluate("document.documentElement.scrollHeight")
        pg.screenshot(path=str(A1 / f"{name}.png"), full_page=True)
        print(name, "scrollWidth", sw, "height", h, "fonts", pg.evaluate("[...document.fonts].filter(f=>f.status=='loaded').length"))
        ctx.close()
    b.close()
