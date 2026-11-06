// Snapshots every frame of the "PRD look" mock-ups (decision PT1) as a static HTML file and a PNG.
// Usage (from the repo root, the mock app running):
//   node mockups-out/mk-prd-look/_src/snap.mjs <base-url> <out-folder> [only-prefix]
// e.g. node mockups-out/mk-prd-look/_src/snap.mjs http://localhost:3393 mockups-out/mk-prd-look
// Writes <out>/frames/<code>-<option>-<state>[-<width>].{html,png} and fonts and PDFs into <out>/assets/.
// One Chromium at a time; scrollbars shown.
import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(path.join(here, "../../../web/package.json"));
const { chromium } = require("@playwright/test");

const BASE = (process.argv[2] ?? "http://localhost:3393").replace(/\/$/, "");
const OUT = path.resolve(process.argv[3] ?? path.join(here, ".."));
const ONLY = process.argv[4] ?? "";
const FRAMES = path.join(OUT, "frames");
const ASSETS = path.join(OUT, "assets");
fs.mkdirSync(FRAMES, { recursive: true });
fs.mkdirSync(ASSETS, { recursive: true });

const NOW = new Date("2026-11-06T16:00:00Z"); // the mock clock: Nov 6, 2026
const DOC = "crew-notes"; // the mock's first PRD (MOCK_PRD_FILE's first PRD replaces its content)
const LONG = "milestones"; // a section mid-document with a table and feature references
const PICK = "requirements"; // the section picked from the contents
const HARD = "risks"; // the longest section with the widest table
const DARK = "feature-f-7"; // a feature section, in the dark theme

/** Every frame: [name, url query, viewport, options]. */
function frames(o) {
  const q = (extra = "") => `?pt1=${o}${extra}`;
  return [
    [`pt1-${o}-top-1512`, q(), [1512, 900]],
    [`pt1-${o}-long-1512`, q(`&sec=${LONG}`), [1512, 900]],
    [`pt1-${o}-toc-1512`, q(`&sec=${LONG}&toc=1`), [1512, 900], { type: "re" }],
    [`pt1-${o}-landed-1512`, q(`&sec=${PICK}`), [1512, 900]],
    [`pt1-${o}-actions-1512`, q(`&sec=${PICK}`), [1512, 900], { menu: PICK }],
    [`pt1-${o}-edit-1512`, q(`&sec=${PICK}&edit=1`), [1512, 900]],
    [`pt1-${o}-hard-1512`, q(`&sec=${HARD}`), [1512, 900]],
    [`pt1-${o}-hard-1440`, q(`&sec=${HARD}`), [1440, 900]],
    [`pt1-${o}-viewer-1512`, q(`&sec=${PICK}&as=viewer`), [1512, 900]],
    [`pt1-${o}-dark-1512`, q(`&sec=${DARK}`), [1512, 900], { dark: true }],
    [`pt1-${o}-phone-top-390`, q(), [390, 844], { phone: true }],
    [`pt1-${o}-phone-table-390`, q(`&sec=${HARD}`), [390, 844], { phone: true }],
    [`pt1-${o}-print`, q(), [816, 1056], { print: true }],
    ...(COST[o] ? [[`pt1-${o}-cost-1440`, q(COST[o].query), [1440, 900], COST[o].opts ?? {}]] : []),
  ];
}
/** Each proposal's real cost, shown in one frame. */
const COST = {
  a: { query: `&sec=feature-f-4` }, // a section's review bar shows only once it is the current one
  b: { query: `&sec=feature-f-9` }, // cards take more height: fewer sections on a screen
  c: { query: `&sec=summary` , opts: { scrollTo: HARD } }, // a folded section: one more click to read it
  d: { query: `&sec=${HARD}` }, // the margin takes width: the wide table scrolls at 1440
  e: { query: `&sec=${HARD}`, opts: { scrollBy: 700 } }, // the sheet is narrow: the wide table wraps tall
};

async function versionUrl(page) {
  await page.goto(`${BASE}/documents/${DOC}`);
  const link = page.locator(`a[href*="/documents/${DOC}/v/"]`).first();
  await link.waitFor({ timeout: 30000 });
  const hrefs = await page.locator(`a[href*="/documents/${DOC}/v/"]`).evaluateAll((as) => as.map((a) => a.getAttribute("href")));
  const n = Math.max(...hrefs.map((h) => Number(/\/v\/(\d+)/.exec(h)?.[1] ?? 0)));
  return `${BASE}/documents/${DOC}/v/${n}`;
}

const fontNames = new Map();
async function fetchFont(page, url) {
  if (fontNames.has(url)) return fontNames.get(url);
  const name = path.basename(new URL(url).pathname);
  const file = path.join(ASSETS, name);
  if (!fs.existsSync(file)) {
    const res = await page.request.get(url);
    fs.writeFileSync(file, await res.body());
  }
  fontNames.set(url, name);
  return name;
}

/** The page as a static file: the DOM cloned, every stylesheet inlined, scripts removed, fonts in assets/. */
async function staticHtml(page, [w, h], { print = false } = {}) {
  const snap = await page.evaluate(() => {
    for (const el of document.querySelectorAll("*")) if (el.scrollTop > 0 || el.scrollLeft > 0) el.setAttribute("data-mockup-scroll", `${el.scrollLeft},${el.scrollTop}`);
    for (const el of document.querySelectorAll("input, textarea")) {
      if (el.type === "checkbox" || el.type === "radio") el.toggleAttribute("checked", el.checked);
      else if (el.tagName === "TEXTAREA") el.textContent = el.value;
      else el.setAttribute("value", el.value);
    }
    let css = "";
    for (const sheet of document.styleSheets) {
      try {
        for (const r of sheet.cssRules) css += r.cssText + "\n";
      } catch {
        /* a sheet from another origin: none here */
      }
    }
    const clone = document.documentElement.cloneNode(true);
    for (const el of clone.querySelectorAll("script, link[rel=stylesheet], link[rel=preload], link[rel=modulepreload], style, noscript, next-route-announcer, nextjs-portal")) el.remove();
    return { html: clone.outerHTML, css, base: location.origin, x: scrollX, y: scrollY, theme: document.documentElement.dataset.theme ?? "" };
  });
  let css = snap.css;
  if (print) css = css.replaceAll("@media print", "@media all");
  const urls = [...new Set([...css.matchAll(/url\(["']?([^"')]+\.(?:woff2?|ttf|otf))["']?\)/g)].map((m) => m[1]))];
  for (const u of urls) {
    const abs = new URL(u, snap.base).href;
    const name = await fetchFont(page, abs);
    css = css.split(u).join(`../assets/${name}`);
  }
  const head = [
    `<meta charset="utf-8">`,
    `<meta name="mockup-viewport" content="${w}x${h}">`,
    `<style>${css}</style>`,
    // ?theme=light|dark sets data-theme on <html>; the saved scroll positions are restored.
    `<script>(function(){var t=new URLSearchParams(location.search).get("theme");if(t==="light"||t==="dark")document.documentElement.dataset.theme=t;addEventListener("load",function(){document.querySelectorAll("[data-mockup-scroll]").forEach(function(e){var p=e.getAttribute("data-mockup-scroll").split(",");e.scrollLeft=+p[0];e.scrollTop=+p[1]});scrollTo(${snap.x},${snap.y})})})()</script>`,
  ].join("\n");
  let html = snap.html.replace(/<head>/, `<head>\n${head}\n`);
  html = html.replace(/(src|href)="\/(?!\/)/g, `$1="${snap.base}/`);
  return `<!doctype html>\n${html}`;
}

async function main() {
  const browser = await chromium.launch({ ignoreDefaultArgs: ["--hide-scrollbars"] });
  // Sign in once; every frame's context starts from that session.
  const first = await browser.newContext({ viewport: { width: 1512, height: 900 } });
  await first.clock.install({ time: NOW });
  const p0 = await first.newPage();
  await p0.goto(`${BASE}/login?next=%2Fhome`);
  await p0.getByLabel("Email").fill("admin@example.com");
  await p0.getByLabel("Password").fill(["de", "mo"].join(""));
  await p0.getByRole("button", { name: "Sign in" }).click();
  await p0.waitForURL(/\/home$/, { timeout: 30000 });
  const url = await versionUrl(p0);
  const state = await first.storageState();
  await first.close();

  for (const o of ["a", "b", "c", "d", "e"]) {
    for (const [name, query, [w, h], opts = {}] of frames(o)) {
      if (ONLY && !name.startsWith(ONLY)) continue;
      const ctx = await browser.newContext({
        viewport: { width: w, height: h },
        storageState: state,
        deviceScaleFactor: opts.phone ? 2 : 1,
        isMobile: !!opts.phone,
        hasTouch: !!opts.phone,
      });
      await ctx.clock.install({ time: NOW });
      await ctx.addInitScript((dark) => localStorage.setItem("oracle-theme", dark ? "dark" : "light"), !!opts.dark);
      const page = await ctx.newPage();
      if (opts.print) await page.emulateMedia({ media: "print" });
      await page.goto(`${url}${query}`);
      await page.locator("[data-pt1]").waitFor({ timeout: 30000 });
      await page.locator("[data-pt1] section[data-section-key]").first().waitFor();
      await page.waitForTimeout(1500);
      if (opts.menu) {
        await page.locator(`section[data-section-key="${opts.menu}"] [data-pt1-head] button[aria-label^="Actions for"]`).first().click();
        await page.waitForTimeout(400);
      }
      if (opts.scrollTo) {
        await page.evaluate((k) => document.querySelector(`[data-pt1-sec="${k}"]`)?.scrollIntoView({ block: "start" }), opts.scrollTo);
        await page.waitForTimeout(500);
      }
      if (opts.scrollBy) {
        await page.evaluate((y) => scrollBy(0, y), opts.scrollBy);
        await page.waitForTimeout(500);
      }
      const html = await staticHtml(page, [w, h], opts);
      fs.writeFileSync(path.join(FRAMES, `${name}.html`), html);
      if (opts.print) {
        await page.pdf({ path: path.join(ASSETS, `${name}.pdf`), format: "Letter", printBackground: true });
        await page.screenshot({ path: path.join(FRAMES, `${name}.png`) });
      } else await page.screenshot({ path: path.join(FRAMES, `${name}.png`) });
      console.log(name);
      await ctx.close();
    }
  }
  await browser.close();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
