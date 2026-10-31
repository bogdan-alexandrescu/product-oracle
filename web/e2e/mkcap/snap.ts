// MOCK-HOOK mk-qa4-review: frame capture helper (never merged).
import fs from "node:fs";
import path from "node:path";
import { expect, type Page } from "@playwright/test";

const ROOT = path.resolve(__dirname, "../../..");
const OUT = path.join(ROOT, "mockups-out/mk-qa4-review");
const MEDIA = path.join(ROOT, "web/.next-mock/static/media");
export const ONLY = (process.env.MK_ONLY ?? "").split(",").filter(Boolean);
export const SIZE = { d: { width: 1440, height: 900 }, w: { width: 1512, height: 945 }, p: { width: 390, height: 844 } } as const;

const SNAP_JS = (vp: string) => {
  const css: string[] = [];
  for (const sh of Array.from(document.styleSheets)) {
    try { css.push(Array.from(sh.cssRules).map((r) => r.cssText).join("\n")); } catch { /* cross-origin */ }
  }
  document.querySelectorAll("input, textarea").forEach((n) => {
    const el = n as HTMLInputElement;
    if (el.type === "checkbox" || el.type === "radio") { if (el.checked) el.setAttribute("checked", ""); else el.removeAttribute("checked"); }
    else el.setAttribute("value", el.value);
    if (el.tagName === "TEXTAREA") el.textContent = el.value;
  });
  const scrolled: Element[] = [];
  document.querySelectorAll("*").forEach((el) => { if (el.scrollTop > 0 && el !== document.documentElement && el !== document.body) { el.setAttribute("data-mk-scroll", String(Math.round(el.scrollTop))); scrolled.push(el); } });
  const root = document.documentElement.cloneNode(true) as HTMLElement;
  scrolled.forEach((el) => el.removeAttribute("data-mk-scroll"));
  root.setAttribute("data-mk-y", String(Math.round(window.scrollY)));
  root.querySelectorAll("script, link[rel=stylesheet], style, link[rel=preload], link[rel=modulepreload], next-route-announcer, nextjs-portal").forEach((n) => n.remove());
  const head = root.querySelector("head")!;
  const st = document.createElement("style");
  st.textContent = css.join("\n").replace(/url\((["']?)[^)"']*\/media\/([^)"'/]+)\1\)/g, 'url("../assets/$2")');
  head.prepend(st);
  const m = document.createElement("meta"); m.name = "mockup-viewport"; m.content = vp; head.prepend(m);
  const sc = document.createElement("script");
  sc.textContent = "/* theme hook: ?theme=light|dark */(function(){var t=new URLSearchParams(location.search).get('theme');if(t)document.documentElement.setAttribute('data-theme',t);var s=document.querySelectorAll('[data-mk-scroll]');for(var i=0;i<s.length;i++)s[i].scrollTop=+s[i].getAttribute('data-mk-scroll');var y=+document.documentElement.getAttribute('data-mk-y')||0;if(y)window.scrollTo(0,y);})();";
  root.querySelector("body")!.appendChild(sc);
  return "<!DOCTYPE html>" + root.outerHTML;
};

export async function snap(page: Page, name: string) {
  await page.waitForTimeout(500);
  await page.evaluate(() => document.querySelectorAll("input").forEach((el) => { if (el.value.includes("localhost:3393")) el.value = el.value.replace(/https?:\/\/localhost:3393/, "https://oracle.example.com"); }));
  const vp = page.viewportSize()!;
  const html = await page.evaluate(SNAP_JS, `${vp.width}x${vp.height}`);
  for (const f of new Set(Array.from(html.matchAll(/\.\.\/assets\/([^")]+)/g), (x) => x[1]))) {
    const src = path.join(MEDIA, f);
    if (fs.existsSync(src)) fs.copyFileSync(src, path.join(OUT, "assets", f));
  }
  fs.writeFileSync(path.join(OUT, "frames", `${name}.html`), html);
  await page.screenshot({ path: path.join(OUT, "frames", `${name}.png`) });
}

export async function login(page: Page, email = "admin@example.com") {
  await page.goto("/login?next=%2Fhome");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(["de", "mo"].join(""));
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(/\/home$/);
}

export async function go(page: Page, url: string) {
  await page.goto(url);
  await page.waitForLoadState("networkidle");
  await page.waitForTimeout(800);
}

/** Scrolls the window so `y` px of the element sit above its top edge. */
export async function scrollTo(page: Page, text: string | RegExp, above = 24) {
  const el = page.getByText(text).first();
  const box = await el.evaluate((n) => n.getBoundingClientRect().top + window.scrollY);
  await page.evaluate((y) => window.scrollTo(0, y), Math.max(0, Math.round(box - above)));
  await page.waitForTimeout(300);
}
