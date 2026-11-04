// MOCK-HOOK: the whole file. Captures the mk-goalbuckets mock-up frames (PNG + static HTML) into
// mockups-out/mk-goalbuckets/frames from the mock app: `MK_CAPTURE=1 E2E_PORT=3393 npx playwright
// test e2e/mk-goalbuckets-capture.spec.ts`. MK_FRAMES (a JSON file) lists the frames; MK_ONLY
// (comma-separated names) narrows the run. Skipped unless MK_CAPTURE=1.
import { expect, test, type Page } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";

import { ADMIN } from "./helpers";

type Frame = { name: string; q: string; focus: string | null; block: string; dy?: number; full?: boolean; phone?: boolean; theme?: string; w1512?: boolean; user?: string };

const OUT = path.resolve(__dirname, "../../mockups-out/mk-goalbuckets");
const ON = process.env.MK_CAPTURE === "1";
const ONLY = new Set((process.env.MK_ONLY ?? "").split(",").filter(Boolean));
const FRAMES: Frame[] = ON ? (JSON.parse(fs.readFileSync(process.env.MK_FRAMES ?? "", "utf8")) as Frame[]).filter((f) => !ONLY.size || ONLY.has(f.name)) : [];

const HOOK =
  "<script>/* mock-up hooks only: ?theme=light|dark, and scroll to the frame's subject */(function(){var t=new URLSearchParams(location.search).get('theme');" +
  "if(t==='light'||t==='dark')document.documentElement.setAttribute('data-theme',t);addEventListener('DOMContentLoaded',function(){var f=document.querySelector('[data-mk-focus]');" +
  "var y=document.documentElement.getAttribute('data-mk-scroll');if(y)window.scrollTo(0,+y);else if(f)f.scrollIntoView({block:'center'});});})();</script>";

const READY =
  'section[data-mockup] button[aria-label^="Edit "], section[data-mockup] button[aria-label^="More for"], [data-testid=mk-toolbar], [data-testid=add-goal], section[data-mockup] [title="Drag to another goal"], section[data-mockup] button[aria-label^="Move "], section[data-mockup] button[aria-label^="Goals "], [role=dialog], [data-testid=goal-form]';

async function signIn(page: Page, email: string) {
  await page.goto("/login?next=%2Fsimple");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(ADMIN.password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.waitForURL((u) => !u.pathname.startsWith("/login"));
}

async function snapshot(page: Page): Promise<string> {
  return page.evaluate(() => {
    for (const s of document.querySelectorAll("select")) for (const o of s.options) o.selected ? o.setAttribute("selected", "") : o.removeAttribute("selected");
    for (const i of document.querySelectorAll("input")) {
      if (i.type === "checkbox" || i.type === "radio") i.checked ? i.setAttribute("checked", "") : i.removeAttribute("checked");
      else i.setAttribute("value", i.value);
    }
    for (const t of document.querySelectorAll("textarea")) t.textContent = t.value;
    let css = "";
    for (const sh of document.styleSheets) {
      try {
        for (const r of sh.cssRules) css += r.cssText + "\n";
      } catch {
        /* cross-origin sheet */
      }
    }
    const root = document.documentElement.cloneNode(true) as HTMLElement;
    root.querySelectorAll("script, link[rel=stylesheet], link[rel=preload], style").forEach((n) => n.remove());
    root.style.removeProperty("zoom");
    const st = document.createElement("style");
    st.textContent = css;
    root.querySelector("head")!.appendChild(st);
    return "<!doctype html>\n" + root.outerHTML;
  });
}

async function fonts(page: Page, html: string): Promise<string> {
  const re = /url\("?(?:\/_next\/static|\.\.)\/media\/([^")]+)"?\)/g;
  for (const m of new Set([...html.matchAll(re)].map((x) => x[1]))) {
    const dst = path.join(OUT, "assets", m);
    if (!fs.existsSync(dst)) fs.writeFileSync(dst, await (await page.request.get(`/_next/static/media/${m}`)).body());
  }
  return html.replace(re, 'url("../assets/$1")');
}

test.describe("mk-goalbuckets frames", () => {
  test.skip(!ON, "capture runs only with MK_CAPTURE=1");
  for (const f of FRAMES) {
    test(f.name, async ({ page }) => {
      const errors: string[] = [];
      page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
      page.on("pageerror", (e) => errors.push(String(e)));
      const [w, h] = f.phone ? [390, 844] : [1440, 900];
      await page.setViewportSize({ width: w, height: h });
      const user = f.user ?? ADMIN.email;
      await signIn(page, user);
      await page.goto(`/simple/priorities?tab=buckets&${f.q}`);
      await page.locator("[data-mockup]").waitFor();
      await page.waitForLoadState("networkidle");
      if (user === ADMIN.email) await page.locator(READY).first().waitFor();
      await page.evaluate(() => document.fonts.ready);
      const theme = f.theme ?? (f.phone ? "dark" : "light");
      await page.evaluate((t) => (document.documentElement.dataset.theme = t), theme);
      if (f.w1512) await page.evaluate(() => (document.documentElement.style.zoom = String(1440 / 1512)));
      await page.evaluate(() => window.scrollTo(0, 0));
      if (f.focus) {
        // Scroll the window (never an inner element) so the subject sits where the frame wants it.
        const y = await page.evaluate(
          ([s, b, dy, pad]) => {
            const e = document.querySelector(s as string);
            if (!e) throw new Error("no " + s);
            e.setAttribute("data-mk-focus", "");
            const r = e.getBoundingClientRect();
            const H = window.innerHeight;
            let t = b === "start" ? r.top + scrollY : b === "end" ? r.bottom + scrollY - H : r.top + scrollY - (H - r.height) / 2;
            t += dy as number;
            return Math.max(0, Math.min(document.documentElement.scrollHeight - H - (pad as number), t));
          },
          // a frame marked full may scroll to the page's very end
          [f.focus, f.block, f.dy ?? 0, f.full ? 0 : 90] as const,
        );
        await page.evaluate((t) => window.scrollTo(0, t), y);
      }
      // Wait until the scroll has settled, with the phone's sticky header flush at the top.
      let last = "";
      for (let i = 0; i < 40; i++) {
        await page.waitForTimeout(150);
        const now = await page.evaluate(() => {
          const hd = document.querySelector("[data-testid=phone-header]");
          return `${Math.round(scrollY)}:${hd && getComputedStyle(hd).display !== "none" ? Math.round(hd.getBoundingClientRect().top) : 0}`;
        });
        if (now === last && now.endsWith(":0")) break;
        last = now;
      }
      expect(last.endsWith(":0"), `sticky header at the top (${last})`).toBe(true);
      // Nothing may be wider than the window.
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(f.w1512 ? 1512 : w);
      let y = await page.evaluate(() => Math.round(scrollY));
      await page.screenshot({ path: path.join(OUT, "frames", `${f.name}.png`) });
      if (f.w1512) y = Math.round((y * 1512) / 1440);
      let html = await fonts(page, await snapshot(page));
      html = html.replace("<head>", `<head>${HOOK}<meta name="mockup-viewport" content="${f.w1512 ? 1512 : w}x${h}">`);
      html = html.replace(/<html([^>]*?) data-theme="[^"]*"/, "<html$1");
      html = html.replace("<html", `<html data-theme="${theme}" data-mk-scroll="${y}"`);
      fs.writeFileSync(path.join(OUT, "frames", `${f.name}.html`), html);
      expect(errors, "console errors").toEqual([]);
    });
  }
});
