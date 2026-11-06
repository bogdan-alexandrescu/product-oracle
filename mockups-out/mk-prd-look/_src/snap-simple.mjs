// Snapshots every frame of "PRD on the Simple side" (decision PS1) as a static HTML file and a PNG.
// Usage (from the repo root, the mock app running):
//   node mockups-out/mk-prd-look/_src/snap-simple.mjs <base-url> <out-folder> [only-prefix]
// e.g. node mockups-out/mk-prd-look/_src/snap-simple.mjs http://localhost:3393 mockups-out/mk-prd-look
// Writes <out>/frames/ps1-<option>-<state>[-<width>].{html,png} and fonts into <out>/assets/.
// Each frame drives the UI as a person would (hover a line, Edit, type, Save; click a feature code; Present).
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
const PAGE = `/simple/one-pagers/${DOC}`;
// The PRD sections the frames land on; SNAP_LONG / SNAP_HARD / SNAP_DARK override them, and a key the PRD
// does not have is replaced by one picked from its sections by shape (see pickKeys).
let LONG = process.env.SNAP_LONG ?? "brief-items"; // a long section with a table and feature codes
let HARD = process.env.SNAP_HARD ?? "risks"; // the widest table
let DARK = process.env.SNAP_DARK ?? "feature-f-7"; // a feature section, in the dark theme
let COST_SEC = process.env.SNAP_COST ?? "feature-f-9"; // a run of feature sections (the cost frames of a, b, c)

/** Every frame: [name, path, viewport, options]. */
function frames(o) {
  const p = `${PAGE}?ps1=${o}`;
  const cost = {
    a: { to: COST_SEC }, // the whole PRD under the page: a long scroll (the scrollbar's small thumb)
    b: { to: COST_SEC }, // cards take height: fewer sections on a screen
    c: { to: COST_SEC }, // folded sections: one more click to read each
    d: { to: "#ps1-rest" }, // what no question reads is a list of folds at the end
    e: { to: LONG }, // the PDF's small type: tables set small to fit the sheet
  }[o];
  return [
    [`ps1-${o}-list-1512`, `/simple/one-pagers?ps1=${o}`, [1512, 900], { list: true }],
    [`ps1-${o}-top-1512`, p, [1512, 900]],
    [`ps1-${o}-long-1512`, p, [1512, 900], { to: LONG }],
    [`ps1-${o}-edit-1512`, p, [1512, 900], { edit: true }],
    [`ps1-${o}-saved-1512`, p, [1512, 900], { edit: true, save: true }],
    [`ps1-${o}-feature-1512`, p, [1512, 900], { feature: true }],
    [`ps1-${o}-hard-1512`, p, [1512, 900], { to: HARD }],
    [`ps1-${o}-hard-1440`, p, [1440, 900], { to: HARD }],
    [`ps1-${o}-viewer-1512`, `${p}&as=viewer`, [1512, 900]],
    [`ps1-${o}-dark-1512`, p, [1512, 900], { dark: true, to: DARK }],
    [`ps1-${o}-phone-top-390`, p, [390, 844], { phone: true }],
    [`ps1-${o}-phone-table-390`, p, [390, 844], { phone: true, to: HARD }],
    [`ps1-${o}-present-1512`, p, [1512, 900], { present: true }],
    [`ps1-${o}-cost-1440`, p, [1440, 900], cost],
  ];
}

/** Keeps each frame's section when the PRD has it, else picks one by shape (real PRDs name sections their own way). */
async function pickKeys(page) {
  await page.goto(`${BASE}${PAGE}?ps1=a`);
  await page.locator("[data-ps1] [data-ps1-sec]").first().waitFor({ timeout: 30000 });
  const secs = await page.locator("[data-ps1] [data-ps1-sec]").evaluateAll((els) =>
    els.map((el) => ({
      key: el.getAttribute("data-ps1-sec"),
      text: el.textContent?.length ?? 0,
      cols: Math.max(0, ...[...el.querySelectorAll("table")].map((t) => t.querySelectorAll("tr:first-child > *").length)),
      codes: el.querySelectorAll(".ps1-code").length,
      feature: /^[A-Z]{1,3}-\d+\s/.test(el.querySelector(".ps1-sec-title")?.textContent?.replace(/^[\d.]+/, "") ?? ""),
    })),
  );
  const has = (k) => secs.some((x) => x.key === k);
  const by = (f) => [...secs].sort(f)[0]?.key;
  if (!has(HARD)) HARD = by((a, b) => b.cols - a.cols || b.text - a.text);
  if (!has(LONG)) LONG = by((a, b) => (b.cols > 0) - (a.cols > 0) || b.codes - a.codes) ?? HARD;
  const feats = secs.filter((x) => x.feature);
  if (!has(DARK)) DARK = feats[Math.floor(feats.length / 3)]?.key ?? secs[Math.floor(secs.length / 2)]?.key;
  if (!has(COST_SEC)) COST_SEC = feats[Math.floor(feats.length / 2)]?.key ?? secs[Math.floor(secs.length / 2)]?.key;
  console.log(`sections: long=${LONG} hard=${HARD} dark=${DARK} cost=${COST_SEC}`);
}

/** Brings a PRD section into view; in d it first opens the fold (an answer's "Read it in the PRD", or "What else") holding it. */
async function reveal(page, key) {
  if (key.startsWith("#")) {
    await page.evaluate((s) => document.querySelector(s)?.scrollIntoView({ block: "start" }), key);
    return;
  }
  const sel = `[data-ps1-sec="${key}"]`;
  if (!(await page.locator(sel).count())) {
    const toggles = page.locator(".ps1-from-toggle");
    for (let i = 0; i < (await toggles.count()); i++) {
      await toggles.nth(i).click();
      await page.waitForTimeout(300);
      if (await page.locator(sel).count()) break;
      await toggles.nth(i).click();
    }
  }
  await page.evaluate((s) => {
    const el = document.querySelector(s);
    const d = el?.closest("details");
    if (d) d.open = true;
    el?.scrollIntoView({ block: "start" });
  }, sel);
}

const fontNames = new Map();
async function fetchFont(page, url) {
  if (fontNames.has(url)) return fontNames.get(url);
  const name = path.basename(new URL(url).pathname);
  const file = path.join(ASSETS, name);
  // A file saved before is kept only when it is a font (wOF2 / wOFF), not a page saved by mistake.
  if (!fs.existsSync(file) || !/^wOF[F2]/.test(fs.readFileSync(file).subarray(0, 4).toString("latin1"))) {
    const res = await page.request.get(url);
    if (!res.ok() || !/font|octet/.test(res.headers()["content-type"] ?? "")) throw new Error(`font ${url}: ${res.status()} ${res.headers()["content-type"]}`);
    fs.writeFileSync(file, await res.body());
  }
  fontNames.set(url, name);
  return name;
}

/** The page as a static file: the DOM cloned, every stylesheet inlined, scripts removed, fonts in assets/. */
async function staticHtml(page, [w, h]) {
  const snap = await page.evaluate(() => {
    // The scroll is kept as the block at the top of the view and its offset, not as pixels (another browser wraps a little differently).
    if (scrollY > 0) {
      const top = [...document.querySelectorAll("main :is(section, h1, h2, h3, h4, p, li, tr, table)")].find((el) => {
        const b = el.getBoundingClientRect();
        return b.top >= 0 && b.height > 0 && getComputedStyle(el).position !== "sticky" && !el.closest("nav, aside, [data-testid=item-panel]");
      });
      if (top) top.setAttribute("data-mockup-top", String(Math.round(top.getBoundingClientRect().top)));
    }
    for (const el of document.querySelectorAll("*")) if (el.scrollTop > 0 || el.scrollLeft > 0) el.setAttribute("data-mockup-scroll", `${el.scrollLeft},${el.scrollTop}`);
    for (const el of document.querySelectorAll("input, textarea")) {
      if (el.type === "checkbox" || el.type === "radio") el.toggleAttribute("checked", el.checked);
      else if (el.tagName === "TEXTAREA") el.textContent = el.value;
      else el.setAttribute("value", el.value);
    }
    for (const el of document.querySelectorAll("details")) el.toggleAttribute("open", el.open);
    let css = "";
    for (const sheet of document.styleSheets) {
      try {
        const base = sheet.href ?? location.href;
        for (const r of sheet.cssRules) css += r.cssText.replace(/url\(["']?([^"')]+)["']?\)/g, (m, u) => (u.startsWith("data:") ? m : `url("${new URL(u, base).href}")`)) + "\n";
      } catch {
        /* a sheet from another origin: none here */
      }
    }
    const clone = document.documentElement.cloneNode(true);
    for (const el of clone.querySelectorAll("script, link[rel=stylesheet], link[rel=preload], link[rel=modulepreload], style, noscript, next-route-announcer, nextjs-portal")) el.remove();
    return { html: clone.outerHTML, css, base: location.origin, page: location.href.replace(/\?.*/, ""), x: scrollX, y: scrollY };
  });
  let css = snap.css;
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
    // ?theme=light|dark sets data-theme on <html>; the saved scroll is restored.
    `<script>(function(){var t=new URLSearchParams(location.search).get("theme");if(t==="light"||t==="dark")document.documentElement.dataset.theme=t;addEventListener("load",function(){document.querySelectorAll("[data-mockup-scroll]").forEach(function(e){var p=e.getAttribute("data-mockup-scroll").split(",");e.scrollLeft=+p[0];e.scrollTop=+p[1]});scrollTo(${snap.x},${snap.y});var a=document.querySelector("[data-mockup-top]");if(a)scrollBy(0,a.getBoundingClientRect().top-Number(a.getAttribute("data-mockup-top")))})})()</script>`,
  ].join("\n");
  let html = snap.html.replace(/<head>/, `<head>\n${head}\n`);
  // A frame is a static file: a link to this page's own section stays a #link, every other link goes nowhere.
  const self = snap.page.replace(/#.*/, "");
  html = html.replace(/href="([^"#]*)(#[^"]*)?"/g, (m, u, hash = "") => {
    if (!u) return hash ? m : m;
    const abs = new URL(u, snap.base + "/").href;
    if (abs.startsWith("data:") || abs.startsWith("file:")) return m;
    return abs.replace(/\?.*/, "") === self && hash ? `href="${hash}"` : `href="#"`;
  });
  html = html.replace(/(src)="\/(?!\/)/g, `$1="${snap.base}/`);
  return `<!doctype html>\n${html}`;
}

/** A line's new words: the same words, said for this release. */
const reworded = (t) => `${t.replace(/[.\s]+$/, "")}, in this release.`;

async function main() {
  const browser = await chromium.launch({ ignoreDefaultArgs: ["--hide-scrollbars"] });
  const first = await browser.newContext({ viewport: { width: 1512, height: 900 } });
  await first.clock.install({ time: NOW });
  const p0 = await first.newPage();
  await p0.goto(`${BASE}/login?next=%2Fhome`);
  await p0.getByLabel("Email").fill("admin@example.com");
  await p0.getByLabel("Password").fill(["de", "mo"].join(""));
  await p0.getByRole("button", { name: "Sign in" }).click();
  await p0.waitForURL(/\/home$/, { timeout: 30000 });
  const state = await first.storageState(); // taken before any one-pager is read: each frame starts from the mock's seed
  await pickKeys(p0);
  await first.close();

  for (const o of ["a", "b", "c", "d", "e"]) {
    for (const [name, where, [w, h], opts = {}] of frames(o)) {
      if (ONLY && !name.startsWith(ONLY)) continue;
      const ctx = await browser.newContext({ viewport: { width: w, height: h }, storageState: state, deviceScaleFactor: opts.phone ? 2 : 1, isMobile: !!opts.phone, hasTouch: !!opts.phone });
      await ctx.clock.install({ time: NOW });
      await ctx.addInitScript((dark) => localStorage.setItem("oracle-theme", dark ? "dark" : "light"), !!opts.dark);
      const page = await ctx.newPage();
      page.on("pageerror", (e) => console.log(`  ${name} pageerror: ${e.message.slice(0, 200)}`));
      page.on("response", (r) => r.status() >= 400 && console.log(`  ${name} ${r.status()} ${r.url()}`));
      page.on("console", (m) => m.type() === "error" && console.log(`  ${name} console: ${m.text().slice(0, 300)}`));
      await page.goto(`${BASE}${where}`);
      if (opts.list) await page.locator('[data-testid="one-pager-row"]').first().waitFor({ timeout: 30000 });
      else {
        await page.locator('[data-testid="one-pager"][data-ps1]').waitFor({ timeout: 30000 });
        await page.locator("[data-ps1-sec], #ps1-rest").first().waitFor({ timeout: 30000 });
      }
      await page.waitForTimeout(1200);
      if (opts.to) await reveal(page, opts.to);
      if (opts.edit) {
        // Change wording: point at a "Not doing" line (else the first line), Edit, type the new words; Save when asked.
        const line = (await page.locator('[data-line^="not_doing-"]').count()) ? page.locator('[data-line^="not_doing-"]').nth(1) : page.locator("[data-line]").first();
        const id = await line.getAttribute("data-line");
        await page.evaluate((i) => document.querySelector(`[data-line="${i}"]`)?.scrollIntoView({ block: "center" }), id);
        await line.hover();
        await page.locator(`[data-edit-for="${id}"]`).click();
        const box = page.locator(`#edit-${id}`);
        await box.fill(reworded(await box.inputValue()));
        if (opts.save) {
          await page.getByRole("button", { name: "Save", exact: true }).click();
          await page.locator(`[data-line="${id}"][data-state="edited"]`).waitFor({ timeout: 15000 });
          await page.waitForTimeout(600);
          await page.evaluate((i) => document.querySelector(`[data-line="${i}"]`)?.scrollIntoView({ block: "center" }), id);
          await page.mouse.move(5, 5);
        }
      }
      if (opts.feature) {
        await page.waitForLoadState("networkidle");
        await page.locator('[data-ps1-block="bets"] .ps1-code').first().click();
        await page.locator('[data-testid="item-panel"]').first().waitFor({ timeout: 15000 });
        await page.getByText("Depends on", { exact: true }).first().waitFor({ timeout: 15000 }); // the panel has read the roadmap
        await page.waitForTimeout(1500);
      }
      if (opts.present) {
        await page.getByRole("button", { name: "Present" }).first().click();
        await page.locator('[data-testid="one-pager"][data-presenting="true"]').waitFor({ timeout: 15000 });
      }
      if (!opts.phone) await page.mouse.move(w - 30, h - 4); // nothing pointed at: no hover in a still frame
      await page.waitForTimeout(700);
      const html = await staticHtml(page, [w, h]);
      fs.writeFileSync(path.join(FRAMES, `${name}.html`), html);
      await page.screenshot({ path: path.join(FRAMES, `${name}.png`) });
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
