// MOCK-HOOK mk-qa4-review: frame capture helper (never merged).
import fs from "node:fs"; // MOCK-HOOK
import path from "node:path"; // MOCK-HOOK
import { expect, type Page } from "@playwright/test"; // MOCK-HOOK
// MOCK-HOOK
const ROOT = path.resolve(__dirname, "../../.."); // MOCK-HOOK
const OUT = path.join(ROOT, "mockups-out/mk-qa4-review"); // MOCK-HOOK
const MEDIA = path.join(ROOT, "web/.next-mock/static/media"); // MOCK-HOOK
export const ONLY = (process.env.MK_ONLY ?? "").split(",").filter(Boolean); // MOCK-HOOK
export const SIZE = { d: { width: 1440, height: 900 }, w: { width: 1512, height: 945 }, p: { width: 390, height: 844 } } as const; // MOCK-HOOK
// MOCK-HOOK
const SNAP_JS = (vp: string) => { // MOCK-HOOK
  const css: string[] = []; // MOCK-HOOK
  for (const sh of Array.from(document.styleSheets)) { // MOCK-HOOK
    try { css.push(Array.from(sh.cssRules).map((r) => r.cssText).join("\n")); } catch { /* cross-origin */ } // MOCK-HOOK
  } // MOCK-HOOK
  document.querySelectorAll("input, textarea").forEach((n) => { // MOCK-HOOK
    const el = n as HTMLInputElement; // MOCK-HOOK
    if (el.type === "checkbox" || el.type === "radio") { if (el.checked) el.setAttribute("checked", ""); else el.removeAttribute("checked"); } // MOCK-HOOK
    else el.setAttribute("value", el.value); // MOCK-HOOK
    if (el.tagName === "TEXTAREA") el.textContent = el.value; // MOCK-HOOK
  }); // MOCK-HOOK
  const scrolled: Element[] = []; // MOCK-HOOK
  document.querySelectorAll("*").forEach((el) => { if (el.scrollTop > 0 && el !== document.documentElement && el !== document.body) { el.setAttribute("data-mk-scroll", String(Math.round(el.scrollTop))); scrolled.push(el); } }); // MOCK-HOOK
  const root = document.documentElement.cloneNode(true) as HTMLElement; // MOCK-HOOK
  scrolled.forEach((el) => el.removeAttribute("data-mk-scroll")); // MOCK-HOOK
  root.setAttribute("data-mk-y", String(Math.round(window.scrollY))); // MOCK-HOOK
  root.querySelectorAll("script, link[rel=stylesheet], style, link[rel=preload], link[rel=modulepreload], next-route-announcer, nextjs-portal").forEach((n) => n.remove()); // MOCK-HOOK
  const head = root.querySelector("head")!; // MOCK-HOOK
  const st = document.createElement("style"); // MOCK-HOOK
  st.textContent = css.join("\n").replace(/url\((["']?)[^)"']*\/media\/([^)"'/]+)\1\)/g, 'url("../assets/$2")'); // MOCK-HOOK
  head.prepend(st); // MOCK-HOOK
  const m = document.createElement("meta"); m.name = "mockup-viewport"; m.content = vp; head.prepend(m); // MOCK-HOOK
  const sc = document.createElement("script"); // MOCK-HOOK
  sc.textContent = "/* theme hook: ?theme=light|dark */(function(){var t=new URLSearchParams(location.search).get('theme');if(t)document.documentElement.setAttribute('data-theme',t);var s=document.querySelectorAll('[data-mk-scroll]');for(var i=0;i<s.length;i++)s[i].scrollTop=+s[i].getAttribute('data-mk-scroll');var y=+document.documentElement.getAttribute('data-mk-y')||0;if(y)window.scrollTo(0,y);})();"; // MOCK-HOOK
  root.querySelector("body")!.appendChild(sc); // MOCK-HOOK
  return "<!DOCTYPE html>" + root.outerHTML; // MOCK-HOOK
}; // MOCK-HOOK
// MOCK-HOOK
export async function snap(page: Page, name: string) { // MOCK-HOOK
  await page.waitForTimeout(500); // MOCK-HOOK
  await page.evaluate(() => document.querySelectorAll("input").forEach((el) => { if (el.value.includes("localhost:3393")) el.value = el.value.replace(/https?:\/\/localhost:3393/, "https://oracle.example.com"); })); // MOCK-HOOK
  const vp = page.viewportSize()!; // MOCK-HOOK
  const html = await page.evaluate(SNAP_JS, `${vp.width}x${vp.height}`); // MOCK-HOOK
  for (const f of new Set(Array.from(html.matchAll(/\.\.\/assets\/([^")]+)/g), (x) => x[1]))) { // MOCK-HOOK
    const src = path.join(MEDIA, f); // MOCK-HOOK
    if (fs.existsSync(src)) fs.copyFileSync(src, path.join(OUT, "assets", f)); // MOCK-HOOK
  } // MOCK-HOOK
  fs.writeFileSync(path.join(OUT, "frames", `${name}.html`), html); // MOCK-HOOK
  await page.screenshot({ path: path.join(OUT, "frames", `${name}.png`) }); // MOCK-HOOK
} // MOCK-HOOK
// MOCK-HOOK
export async function login(page: Page, email = "admin@example.com") { // MOCK-HOOK
  // Frames are the viewport: presenting never goes real full screen here. // MOCK-HOOK
  await page.addInitScript(() => { Element.prototype.requestFullscreen = function () { return Promise.resolve(); }; }); // MOCK-HOOK
  await page.goto("/login?next=%2Fhome"); // MOCK-HOOK
  await page.getByLabel("Email").fill(email); // MOCK-HOOK
  await page.getByLabel("Password").fill(["de", "mo"].join("")); // MOCK-HOOK
  await page.getByRole("button", { name: "Sign in" }).click(); // MOCK-HOOK
  await expect(page).toHaveURL(/\/home$/); // MOCK-HOOK
} // MOCK-HOOK
// MOCK-HOOK
export async function go(page: Page, url: string) { // MOCK-HOOK
  await page.goto(url); // MOCK-HOOK
  await page.waitForLoadState("networkidle"); // MOCK-HOOK
  await page.waitForTimeout(800); // MOCK-HOOK
} // MOCK-HOOK
// MOCK-HOOK
/** Scrolls the window so `y` px of the element sit above its top edge. */ // MOCK-HOOK
export async function scrollTo(page: Page, text: string | RegExp, above = 24) { // MOCK-HOOK
  const el = page.getByText(text).first(); // MOCK-HOOK
  const box = await el.evaluate((n) => n.getBoundingClientRect().top + window.scrollY); // MOCK-HOOK
  await page.evaluate((y) => window.scrollTo(0, y), Math.max(0, Math.round(box - above))); // MOCK-HOOK
  await page.waitForTimeout(300); // MOCK-HOOK
} // MOCK-HOOK
