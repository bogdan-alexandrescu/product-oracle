// Snapshots each frame of mk-goal-ladder as a static HTML file (DOM cloned, stylesheets inlined,
// scripts removed, fonts copied to assets/) plus a PNG. Usage: node snap.mjs [filter]
// Run from web/ so @playwright/test resolves: node ../mockups-out/mk-goal-ladder/_src/snap.mjs
import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
const require = createRequire(path.resolve("package.json"));
const { chromium } = require("@playwright/test");
const here = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.resolve(here, "..");
const BASE = process.env.BASE ?? "http://localhost:3393";
const { FRAMES } = await import(path.join(here, "frames.mjs"));
const only = process.argv[2];

const browser = await chromium.launch({ ignoreDefaultArgs: ["--hide-scrollbars"] }); // scrollbars shown
const fonts = new Set();
for (const fr of FRAMES) {
  if (only && !fr.file.includes(only)) continue;
  const [w, h] = fr.size ?? [1440, 900];
  const ctx = await browser.newContext({ viewport: { width: w, height: h }, deviceScaleFactor: 1, isMobile: w < 600, hasTouch: w < 600 });
  await ctx.addInitScript(() => localStorage.setItem("oracle-theme", "light"));
  const page = await ctx.newPage();
  await page.goto(BASE + "/simple/roadmap", { waitUntil: "networkidle" });
  if (await page.locator("input[type=password]").count()) {
    // the mock app's demo sign-in, then the frame's URL again
    await page.fill("input[type=email]", "admin@example.com");
    await page.fill("input[type=password]", "demo");
    await page.keyboard.press("Enter");
    await page.waitForTimeout(1500);
  }
  await page.goto(BASE + fr.url, { waitUntil: "networkidle" });
  await page.waitForSelector('[data-testid="ld-page"]', { timeout: 20000 });
  for (const c of fr.clicks ?? []) await page.click(c);
  await page.waitForTimeout(700);
  if (fr.scroll) await page.evaluate((y) => window.scrollTo(0, y), fr.scroll);
  if (fr.scrollSel) await page.evaluate((s) => document.querySelector(s)?.scrollIntoView({ block: "center" }), fr.scrollSel);
  if (fr.hscroll) await page.evaluate((x) => document.querySelectorAll('.overflow-x-auto').forEach((e) => (e.scrollLeft = x)), fr.hscroll);
  await page.waitForTimeout(300);
  const name = fr.file;
  await page.screenshot({ path: path.join(OUT, "frames", `${name}.png`) });
  const { html, urls } = await page.evaluate(([vp]) => {
    let css = "";
    for (const s of document.styleSheets) {
      // font urls made absolute against their own stylesheet, so they can be fetched and copied
      try { for (const r of s.cssRules) css += r.cssText.replace(/url\(["']?([^"')]+)["']?\)/g, (_, u) => `url("${new URL(u, s.href ?? location.href).href}")`) + "\n"; } catch { /* cross-origin */ }
    }
    const urls = [...css.matchAll(/url\(["']?([^"')]+\.(?:woff2?|ttf|otf))["']?\)/g)].map((m) => m[1]);
    const doc = document.documentElement.cloneNode(true);
    doc.querySelectorAll("script, link[rel=stylesheet], link[rel=preload], link[as=script], noscript, style").forEach((n) => n.remove());
    // keep scroll positions as offsets the static file opens at
    const head = doc.querySelector("head");
    const st = document.createElement("style");
    st.textContent = css;
    head.appendChild(st);
    const m = document.createElement("meta");
    m.setAttribute("name", "mockup-viewport");
    m.setAttribute("content", vp);
    head.prepend(m);
    doc.setAttribute("data-theme", "light");
    return { html: "<!doctype html>\n" + doc.outerHTML, urls, sx: window.scrollX, sy: window.scrollY };
  }, [`${w}x${h}`]);
  let out = html;
  for (const u of urls) {
    const file = path.basename(u.split("?")[0]);
    fonts.add(JSON.stringify([u, file]));
    out = out.split(u).join(`../assets/${file}`);
  }
  const scrollY = await page.evaluate(() => window.scrollY);
  // ?theme=light|dark sets data-theme on <html>; the frame opens where the shot was taken.
  const hook = `<script>(function(){var t=new URLSearchParams(location.search).get("theme");if(t)document.documentElement.setAttribute("data-theme",t);addEventListener("load",function(){scrollTo(0,${scrollY})})})()</script>`;
  out = out.replace("</head>", hook + "</head>");
  fs.writeFileSync(path.join(OUT, "frames", `${name}.html`), out);
  await ctx.close();
  console.log("frame", name);
}
for (const j of fonts) {
  const [u, file] = JSON.parse(j);
  const dest = path.join(OUT, "assets", file);
  if (fs.existsSync(dest)) continue;
  const r = await fetch(u);
  if (r.ok) fs.writeFileSync(dest, Buffer.from(await r.arrayBuffer()));
}
await browser.close();
