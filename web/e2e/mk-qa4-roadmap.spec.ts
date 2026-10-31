// MOCK-HOOK: mk-qa4-roadmap. Not a test of the product: it drives the owner's mock-up variants
// (/simple/roadmap?qr1=..&qr2=..&qr3=..&qr4=..) through the UI and saves each frame as a static
// HTML page (styles inlined, fonts in assets/, no scripts) and a PNG, under mockups-out/.
// Run: MK_SNAP=1 E2E_PORT=3393 npx playwright test e2e/mk-qa4-roadmap.spec.ts --workers=1
import fs from "node:fs";
import path from "node:path";

import { login } from "./helpers";
import { expect, test, type Page } from "./test";

const OUT = path.resolve(__dirname, "../../mockups-out/mk-qa4-roadmap"); // MOCK-HOOK
const FRAMES: { file: string; caption: string }[] = []; // MOCK-HOOK
const ONLY = process.env.MK_ONLY; // MOCK-HOOK

test.skip(!process.env.MK_SNAP, "mock-up capture only (MK_SNAP=1)"); // MOCK-HOOK
test.describe.configure({ mode: "serial" }); // MOCK-HOOK
test.use({ launchOptions: { ignoreDefaultArgs: ["--hide-scrollbars"] }, viewport: { width: 1440, height: 900 } }); // MOCK-HOOK
test.setTimeout(240_000); // MOCK-HOOK

const SCROLLBARS = `::-webkit-scrollbar{width:12px;height:12px}::-webkit-scrollbar-track{background:rgba(127,127,127,.12)}::-webkit-scrollbar-thumb{background:rgba(110,118,130,.7);border-radius:6px;border:2px solid transparent;background-clip:content-box}`; // MOCK-HOOK

async function go(page: Page, q: string, size: [number, number] = [1440, 900]) { // MOCK-HOOK
  await page.setViewportSize({ width: size[0], height: size[1] }); // MOCK-HOOK
  await page.goto(`/simple/roadmap?${q}`); // MOCK-HOOK
  await expect(page.getByTestId("mk-timeline")).toBeVisible({ timeout: 60_000 }); // MOCK-HOOK
  await page.addStyleTag({ content: SCROLLBARS }); // MOCK-HOOK
  await page.waitForTimeout(600); // MOCK-HOOK
  await toChart(page); // MOCK-HOOK
}

async function toChart(page: Page) { // MOCK-HOOK
  await page.evaluate((top) => { const el = document.querySelector(top ? '[data-testid="mk-timeline"]' : '[data-testid="mk-scroll"], [data-testid="mk-list"]'); if (el) window.scrollTo(0, el.getBoundingClientRect().top + window.scrollY - (top ? 60 : 110)); }, !new URL(page.url()).searchParams.has("qr1") || /qr[234]=/.test(page.url())); // MOCK-HOOK
  await page.waitForTimeout(250); // MOCK-HOOK
}

async function snap(page: Page, file: string, caption: string, full = false) { // MOCK-HOOK
  fs.mkdirSync(path.join(OUT, "frames"), { recursive: true }); // MOCK-HOOK
  fs.mkdirSync(path.join(OUT, "assets"), { recursive: true }); // MOCK-HOOK
  const vp = page.viewportSize()!; // MOCK-HOOK
  await page.screenshot({ path: path.join(OUT, "frames", `${file}.png`), fullPage: full }); // MOCK-HOOK
  const got = await page.evaluate(() => { // MOCK-HOOK
    let css = ""; // MOCK-HOOK
    for (const sh of Array.from(document.styleSheets)) { // MOCK-HOOK
      let rules: CSSRule[] = []; // MOCK-HOOK
      try { rules = Array.from(sh.cssRules); } catch { continue; } // MOCK-HOOK
      const base = sh.href ?? location.href; // MOCK-HOOK
      css += rules.map((r) => r.cssText.replace(/url\((["']?)([^"')]+)\1\)/g, (_m, _q, u: string) => (u.startsWith("data:") ? `url(${u})` : `url("${new URL(u, base).href}")`))).join("\n") + "\n"; // MOCK-HOOK
    } // MOCK-HOOK
    document.querySelectorAll("*").forEach((el) => { if (el.scrollLeft > 0 || (el.scrollTop > 0 && el !== document.documentElement && el !== document.body)) el.setAttribute("data-mk-scroll", `${el.scrollLeft},${el.scrollTop}`); }); // MOCK-HOOK
    document.querySelectorAll("input").forEach((i) => i.setAttribute("value", i.value)); // MOCK-HOOK
    document.querySelectorAll("select").forEach((s) => Array.from(s.options).forEach((o) => (o.selected ? o.setAttribute("selected", "") : o.removeAttribute("selected")))); // MOCK-HOOK
    const doc = document.documentElement.cloneNode(true) as HTMLElement; // MOCK-HOOK
    doc.querySelectorAll("script, link[rel=stylesheet], link[rel=preload], link[rel=modulepreload], link[as], style, nextjs-portal, next-route-announcer, iframe").forEach((n) => n.remove()); // MOCK-HOOK
    doc.querySelectorAll("[data-mk-scroll]").forEach((el) => { const [x, y] = el.getAttribute("data-mk-scroll")!.split(",").map(Number); const c = el.firstElementChild as HTMLElement | null; if (c) { c.style.marginLeft = `-${x}px`; c.style.marginTop = `-${y}px`; } }); // MOCK-HOOK
    document.querySelectorAll("[data-mk-scroll]").forEach((el) => el.removeAttribute("data-mk-scroll")); // MOCK-HOOK
    doc.removeAttribute("data-theme"); // MOCK-HOOK
    return { html: doc.outerHTML, css, sy: Math.round(window.scrollY) }; // MOCK-HOOK
  }); // MOCK-HOOK
  let css = got.css; // MOCK-HOOK
  const fonts = Array.from(new Set(Array.from(css.matchAll(/url\("([^"]+\.(?:woff2?|ttf|otf))"\)/g)).map((m) => m[1]))); // MOCK-HOOK
  for (const u of fonts) { // MOCK-HOOK
    const name = path.basename(new URL(u).pathname); // MOCK-HOOK
    const dest = path.join(OUT, "assets", name); // MOCK-HOOK
    if (!fs.existsSync(dest)) { const r = await page.request.get(u); if (r.ok()) fs.writeFileSync(dest, await r.body()); } // MOCK-HOOK
    css = css.split(u).join(`../assets/${name}`); // MOCK-HOOK
  } // MOCK-HOOK
  const origin = new URL(page.url()).origin; // MOCK-HOOK
  css = css.split(`url("${origin}/`).join(`url("../assets/missing/`); // MOCK-HOOK
  const head = `<meta charset="utf-8"><meta name="mockup-viewport" content="${vp.width}x${vp.height}"><title>${file}</title><script>(function(){var t=new URLSearchParams(location.search).get("theme");if(t==="light"||t==="dark")document.documentElement.setAttribute("data-theme",t);else document.documentElement.setAttribute("data-theme","light");if("scrollRestoration" in history)history.scrollRestoration="manual";var y=${got.sy},go=function(){window.scrollTo(0,y)};document.addEventListener("DOMContentLoaded",go);window.addEventListener("load",go);if(document.fonts)document.fonts.ready.then(go);})()</script><style>${css}</style><style>${SCROLLBARS}</style>`; // MOCK-HOOK
  const html = "<!doctype html>\n" + got.html.replace(/<head>/, `<head>${head}`).replace(/ href="\/(?!\/)/g, ' data-href="/'); // MOCK-HOOK
  fs.writeFileSync(path.join(OUT, "frames", `${file}.html`), html); // MOCK-HOOK
  FRAMES.push({ file: `${file}.html`, caption }); // MOCK-HOOK
  const man = path.join(OUT, "frames.json"); // MOCK-HOOK
  const old: { file: string; caption: string }[] = fs.existsSync(man) ? JSON.parse(fs.readFileSync(man, "utf8")) : []; // MOCK-HOOK
  fs.writeFileSync(man, JSON.stringify([...old.filter((f) => f.file !== `${file}.html`), { file: `${file}.html`, caption }], null, 2)); // MOCK-HOOK
}

const toLane = (page: Page, title: string, gap = 120) => page.evaluate(([t, g]) => { const el = Array.from(document.querySelectorAll('[data-testid="mk-timeline"] div, [data-testid="mk-list"] li')).find((d) => d.textContent?.startsWith(t as string)); if (el) window.scrollTo(0, el.getBoundingClientRect().top + window.scrollY - (g as number)); }, [title, gap] as const); // MOCK-HOOK
const rowToTop = (page: Page, key: string, gap = 70) => page.evaluate(([k, g]) => { const el = Array.from(document.querySelectorAll('[data-testid="mk-bar"]')).find((b) => b.closest("li")?.textContent?.includes(k as string)); if (el) window.scrollTo(0, el.getBoundingClientRect().top + window.scrollY - (g as number)); }, [key, gap] as const); // MOCK-HOOK
const scrollChart = (page: Page, dx: number) => page.evaluate((d) => { const el = document.querySelector('[data-testid="mk-scroll"]'); if (el) el.scrollLeft += d; }, dx); // MOCK-HOOK
const DESK = (q: string) => `${q}`; // MOCK-HOOK

const story = (name: string, fn: (page: Page) => Promise<void>) => test(name, async ({ page }) => { test.skip(!!ONLY && !name.startsWith(ONLY)); await login(page); await fn(page); }); // MOCK-HOOK

story("qr1-a", async (page) => { // MOCK-HOOK
  await go(page, DESK("qr1=a")); // MOCK-HOOK
  await snap(page, "qr1-a-rest", "At rest: six months around today. One row per item, its name fixed on the left, its dates on the bar."); // MOCK-HOOK
  await scrollChart(page, 900); // MOCK-HOOK
  await page.waitForTimeout(300); // MOCK-HOOK
  await snap(page, "qr1-a-mid", "Scrolled sideways into 2027: the names stay on the left, Back to today brings you home."); // MOCK-HOOK
  await page.getByTestId("mk-zoom-all").click(); // MOCK-HOOK
  await expect(page.getByTestId("mk-zoom-all")).toHaveAttribute("aria-pressed", "true"); // MOCK-HOOK
  await toChart(page); // MOCK-HOOK
  await snap(page, "qr1-a-result", "After choosing All 3 years: the whole plan fits; bars get thin (the cost), but every name is still readable on the left."); // MOCK-HOOK
  await go(page, DESK("qr1=a"), [1512, 900]); // MOCK-HOOK
  await snap(page, "qr1-a-rest-1512", "The owner's 1512 window: the same six months, with more room per week; nothing overlaps."); // MOCK-HOOK
  await go(page, DESK("qr1=a"), [390, 844]); // MOCK-HOOK
  await snap(page, "qr1-a-rest-390", "Phone: a list by quarter, each item with its name, dates and goal; Today marks this quarter."); // MOCK-HOOK
});

story("qr1-b", async (page) => { // MOCK-HOOK
  await go(page, DESK("qr1=b")); // MOCK-HOOK
  await snap(page, "qr1-b-rest", "At rest: quarters as columns, starting at this one. Each item is a block over its quarters with its name and dates inside."); // MOCK-HOOK
  await scrollChart(page, 1180); // MOCK-HOOK
  await page.waitForTimeout(300); // MOCK-HOOK
  await snap(page, "qr1-b-mid", "Scrolled to 2028: goal names stay on the left. An item that ends mid-quarter still fills the whole quarter (the cost)."); // MOCK-HOOK
  await go(page, DESK("qr1=b"), [1512, 900]); // MOCK-HOOK
  await snap(page, "qr1-b-rest-1512", "1512 wide: about five quarters show; the rest scroll."); // MOCK-HOOK
  await go(page, DESK("qr1=b"), [390, 844]); // MOCK-HOOK
  await snap(page, "qr1-b-rest-390", "Phone: the same quarter columns, two at a time, scrolled sideways."); // MOCK-HOOK
});

story("qr1-c", async (page) => { // MOCK-HOOK
  await go(page, DESK("qr1=c")); // MOCK-HOOK
  await snap(page, "qr1-c-rest", "At rest: all three years at once, no scrolling sideways. Each item has its own row with its name written above its bar."); // MOCK-HOOK
  await go(page, DESK("qr1=c"), [1512, 900]); // MOCK-HOOK
  await snap(page, "qr1-c-rest-1512", "1512 wide: a short item is still only a few pixels; the chart runs on down the page, past the screen (the cost)."); // MOCK-HOOK
  await go(page, DESK("qr1=c"), [390, 844]); // MOCK-HOOK
  await snap(page, "qr1-c-rest-390", "Phone: the names fit, but the bars are too small to tap."); // MOCK-HOOK
});

story("qr1-d", async (page) => { // MOCK-HOOK
  await go(page, DESK("qr1=d")); // MOCK-HOOK
  await snap(page, "qr1-d-rest", "At rest: no chart at all; a list by quarter on every screen, the same as a phone."); // MOCK-HOOK
  await go(page, DESK("qr1=d"), [1512, 900]); // MOCK-HOOK
  await page.mouse.wheel(0, 900); // MOCK-HOOK
  await page.waitForTimeout(300); // MOCK-HOOK
  await snap(page, "qr1-d-rest-1512", "1512 wide, scrolled down: what runs at the same time is no longer side by side (the cost)."); // MOCK-HOOK
});

story("qr2-a", async (page) => { // MOCK-HOOK
  await go(page, DESK("qr1=a&qr2=a")); // MOCK-HOOK
  await snap(page, "qr2-a-rest", "At rest: the key sits above the chart. Red only for a broken link; a draft is grey and dashed; a cut item is struck through; Today is purple."); // MOCK-HOOK
  await go(page, DESK("qr1=a&qr2=a"), [390, 844]); // MOCK-HOOK
  await snap(page, "qr2-a-rest-390", "Phone: the same key above the list, wrapped onto lines."); // MOCK-HOOK
  await rowToTop(page, "In-app tour", 160); // MOCK-HOOK
  await snap(page, "qr2-a-cut-390", "Phone, further down: In-app tour, cut, is grey and struck through in its quarter."); // MOCK-HOOK
  await go(page, DESK("qr1=a&qr2=a")); // MOCK-HOOK
  await toLane(page, "Below the line", 360); // MOCK-HOOK
  await snap(page, "qr2-a-cut", "Scrolled down to Below the line: In-app tour, cut, is a grey bar with its name struck through; no red."); // MOCK-HOOK
});

story("qr2-b", async (page) => { // MOCK-HOOK
  await go(page, DESK("qr1=a&qr2=b")); // MOCK-HOOK
  await snap(page, "qr2-b-rest", "At rest: the same colours, no key on the page; one button, What the colours mean."); // MOCK-HOOK
  await page.getByTestId("mk-key-button").click(); // MOCK-HOOK
  await snap(page, "qr2-b-open", "After a click: the key opens under the button and covers the conflicts list until closed (the cost)."); // MOCK-HOOK
  await page.getByTestId("mk-key-button").click(); // MOCK-HOOK
  await toLane(page, "Below the line", 360); // MOCK-HOOK
  await snap(page, "qr2-b-cut", "Key closed, scrolled down to Below the line: the cut item looks as in A, with no key in sight to say so."); // MOCK-HOOK
});

story("qr2-c", async (page) => { // MOCK-HOOK
  await go(page, DESK("qr1=a&qr2=c")); // MOCK-HOOK
  await snap(page, "qr2-c-rest", "At rest: every bar the same blue; a short word on the row says Draft, Cut or Broken link; Today is a plain line."); // MOCK-HOOK
  await go(page, DESK("qr1=a&qr2=c"), [390, 844]); // MOCK-HOOK
  await snap(page, "qr2-c-rest-390", "Phone: the words sit after each name in the list."); // MOCK-HOOK
  await rowToTop(page, "In-app tour", 160); // MOCK-HOOK
  await snap(page, "qr2-c-cut-390", "Phone, further down: In-app tour says Cut after its struck-through name; its mark is as blue as the rest."); // MOCK-HOOK
  await go(page, DESK("qr1=a&qr2=c")); // MOCK-HOOK
  await toLane(page, "Below the line", 360); // MOCK-HOOK
  await snap(page, "qr2-c-cut", "Scrolled down to Below the line: In-app tour has the same blue bar as live work; only the word Cut and the strike say it is out."); // MOCK-HOOK
});

story("qr2-d", async (page) => { // MOCK-HOOK
  await go(page, DESK("qr1=a&qr2=d")); // MOCK-HOOK
  await scrollChart(page, -260); // MOCK-HOOK
  await page.waitForTimeout(300); // MOCK-HOOK
  await snap(page, "qr2-d-rest", "Scrolled back a little: the fill says progress (grey done, green in progress, blue planned); red stays only for a broken link. One more colour to learn (the cost)."); // MOCK-HOOK
  await toLane(page, "Below the line", 360); // MOCK-HOOK
  await snap(page, "qr2-d-cut", "Scrolled down to Below the line: a cut item is grey like a done one, told apart only by its struck-through name."); // MOCK-HOOK
});

story("qr3-a", async (page) => { // MOCK-HOOK
  await go(page, DESK("qr1=a&qr3=a")); // MOCK-HOOK
  await snap(page, "qr3-a-rest", "At rest: the broken links get a panel of their own above the chart, words in full with their fixes; the chart has only a ⚠ by the name."); // MOCK-HOOK
  await page.getByTestId("mk-conflict").first().getByRole("button").first().click(); // MOCK-HOOK
  await page.waitForTimeout(600); // MOCK-HOOK
  await snap(page, "qr3-a-mid", "Clicking a link's words opens its item beside the chart, its row marked."); // MOCK-HOOK
  await page.keyboard.press("Escape"); // MOCK-HOOK
  await page.getByTestId("mk-conflict").first().getByRole("button", { name: "Accept as risk" }).click(); // MOCK-HOOK
  await page.getByTestId("mk-conflict").first().getByRole("textbox").fill("Last week's rules are enough"); // MOCK-HOOK
  await snap(page, "qr3-a-risk", "Accept as risk asks for one line on why it is fine, right in the panel."); // MOCK-HOOK
  await page.getByTestId("mk-conflict").first().getByRole("button", { name: "Save the risk" }).click(); // MOCK-HOOK
  await page.waitForTimeout(1500); // MOCK-HOOK
  await toChart(page); // MOCK-HOOK
  await snap(page, "qr3-a-result", "After Accept as risk: that link leaves the panel, which now counts what is left."); // MOCK-HOOK
  await page.getByTestId("mk-conflicts").getByRole("button").first().click(); // MOCK-HOOK
  await snap(page, "qr3-a-shut", "Hide folds the panel to one line; the chart moves up."); // MOCK-HOOK
});

story("qr3-aw", async (page) => { // MOCK-HOOK
  await go(page, DESK("qr1=a&qr3=a")); // MOCK-HOOK
  await page.getByTestId("format-waterfall").click(); // MOCK-HOOK
  await expect(page.getByTestId("mk-conflicts")).toBeVisible(); // MOCK-HOOK
  await page.waitForTimeout(800); // MOCK-HOOK
  await page.evaluate(() => { const el = document.querySelector('[data-testid="mk-conflicts"]'); if (el) window.scrollTo(0, el.getBoundingClientRect().top + window.scrollY - 70); }); // MOCK-HOOK
  await snap(page, "qr3-a-waterfall", "Waterfall chosen: the same panel sits above its chart, and no banner covers a phase bar."); // MOCK-HOOK
});

story("qr3-b", async (page) => { // MOCK-HOOK
  await go(page, DESK("qr1=a&qr3=b")); // MOCK-HOOK
  await snap(page, "qr3-b-rest", "At rest: each broken link takes a row of its own under its item, words in full, never over a bar. The chart grows a row per link (the cost)."); // MOCK-HOOK
  await page.getByTestId("mk-conflict").first().getByRole("button", { name: "Move the dependents" }).click(); // MOCK-HOOK
  await page.waitForTimeout(1500); // MOCK-HOOK
  await toChart(page); // MOCK-HOOK
  await snap(page, "qr3-b-result", "After Move the dependents: the row goes and the bars below close up."); // MOCK-HOOK
});

story("qr3-c", async (page) => { // MOCK-HOOK
  await go(page, DESK("qr1=a&qr3=c")); // MOCK-HOOK
  await snap(page, "qr3-c-rest", "At rest: a small red mark after each broken bar, nothing else; you cannot read what is wrong without a click (the cost)."); // MOCK-HOOK
  await page.getByTestId("mk-badge").first().click(); // MOCK-HOOK
  await snap(page, "qr3-c-open", "Clicking the mark opens the words and fixes just under the bar."); // MOCK-HOOK
});

story("qr3-d", async (page) => { // MOCK-HOOK
  await go(page, DESK("qr1=a&qr3=d")); // MOCK-HOOK
  await snap(page, "qr3-d-rest", "At rest: the broken links in a column beside the chart; the chart loses a third of its width (the cost)."); // MOCK-HOOK
  await go(page, DESK("qr1=a&qr3=d"), [1512, 900]); // MOCK-HOOK
  await snap(page, "qr3-d-rest-1512", "1512 wide: about six months of chart show beside the column, each week narrower."); // MOCK-HOOK
});

const bar = (page: Page, key: string) => page.locator(`[data-testid="mk-row"][data-item="${key}"] [data-testid="mk-bar"]`); // MOCK-HOOK

story("qr4-a", async (page) => { // MOCK-HOOK
  await go(page, DESK("qr1=a&qr4=a")); // MOCK-HOOK
  await bar(page, "alert-rules").click(); // MOCK-HOOK
  await page.waitForTimeout(800); // MOCK-HOOK
  await snap(page, "qr4-a-open", "Clicking Alert rules engine: the item opens in a panel at the right. The page stays where it was; the row is marked."); // MOCK-HOOK
  await scrollChart(page, 500); // MOCK-HOOK
  await page.waitForTimeout(300); // MOCK-HOOK
  await snap(page, "qr4-a-mid", "With the panel open the chart still scrolls; it is narrower while the panel is open (the cost)."); // MOCK-HOOK
  await page.locator('[data-testid="mk-row"][data-item="setup-checklist"] button').first().click(); // MOCK-HOOK
  await page.waitForTimeout(800); // MOCK-HOOK
  await snap(page, "qr4-a-result", "Clicking Setup checklist's name swaps the panel to it, no closing first; the chart slides back so its bar is in sight."); // MOCK-HOOK
  await go(page, DESK("qr1=a&qr4=a&open=alert-digest"), [1512, 900]); // MOCK-HOOK
  await snap(page, "qr4-a-open-1512", "1512 wide with Weekly alert digest open: the chart keeps about five months beside the panel."); // MOCK-HOOK
  await go(page, DESK("qr1=a&qr4=a"), [390, 844]); // MOCK-HOOK
  await rowToTop(page, "Mobile alert push", 140); // MOCK-HOOK
  await page.locator('[data-testid="mk-bar"]', { hasText: "Mobile alert push" }).click(); // MOCK-HOOK
  await page.waitForTimeout(800); // MOCK-HOOK
  await snap(page, "qr4-a-open-390", "Phone: the item opens as a sheet over the lower half; Mobile alert push stays marked in sight above it."); // MOCK-HOOK
});

story("qr4-b", async (page) => { // MOCK-HOOK
  await go(page, DESK("qr1=a&qr4=b")); // MOCK-HOOK
  await bar(page, "alert-rules").click(); // MOCK-HOOK
  await page.waitForTimeout(800); // MOCK-HOOK
  await snap(page, "qr4-b-open", "Clicking Alert rules engine: its details open in place under its row and push the rows below down (the cost: the rest of the plan leaves the screen)."); // MOCK-HOOK
  await go(page, DESK("qr1=a&qr4=b"), [390, 844]); // MOCK-HOOK
  await page.locator('[data-testid="mk-bar"]', { hasText: "Mobile alert push" }).click(); // MOCK-HOOK
  await page.waitForTimeout(800); // MOCK-HOOK
  await rowToTop(page, "Mobile alert push", 70); // MOCK-HOOK
  await page.waitForTimeout(300); // MOCK-HOOK
  await snap(page, "qr4-b-open-390", "Phone: the details open inside the list under the item and push the next items down."); // MOCK-HOOK
});

story("qr4-c", async (page) => { // MOCK-HOOK
  await go(page, DESK("qr1=a&qr4=c")); // MOCK-HOOK
  await bar(page, "alert-rules").click(); // MOCK-HOOK
  await page.waitForTimeout(800); // MOCK-HOOK
  await snap(page, "qr4-c-open", "Clicking Alert rules engine: the card opens right beside its bar, over the rows next to it; the bar stays in sight."); // MOCK-HOOK
  await page.keyboard.press("Escape"); // MOCK-HOOK
  await page.evaluate(() => { const box = document.querySelector('[data-testid="mk-scroll"]')!; const b = document.querySelector('[data-testid="mk-row"][data-item="alert-sso"] [data-testid="mk-bar"]')!; box.scrollLeft += b.getBoundingClientRect().left - box.getBoundingClientRect().left - 232 - 4; }); // MOCK-HOOK
  await page.waitForTimeout(300); // MOCK-HOOK
  await bar(page, "alert-sso").click(); // MOCK-HOOK
  await page.waitForTimeout(800); // MOCK-HOOK
  await snap(page, "qr4-c-open-hard", "Scrolled to 2027, Alert routing by team fills the chart: no room either side, so the card opens under it and covers the rows below (the cost)."); // MOCK-HOOK
});
