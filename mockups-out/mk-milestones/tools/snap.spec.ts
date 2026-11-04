// MOCK-HOOK mk-milestones: frame exporter. Copy to web/mk-snap/ and run: SNAP_FRAMES=<frames.json> swarm-test-browsers npx playwright test -c mk-snap/pw.config.ts mk-snap/snap.spec.ts (mock server on :3393).
import fs from "node:fs";
import path from "node:path";
import { test, type Browser } from "@playwright/test";
const OUT = "/workspace/att_c5822002be4b47719c9e/work/repo/mockups-out/mk-milestones";
const frames: { file: string; q: string; dev: string; theme: string }[] = JSON.parse(fs.readFileSync(process.env.SNAP_FRAMES!, "utf8"));
const only = (process.env.SNAP_ONLY ?? "").split(",").filter(Boolean);
const SCROLL = (dev: string) => {
  const chart = document.querySelector("[data-testid=simple-chart]");
  const layer = document.querySelector("[data-testid=ms-layer]");
  if (chart) { const t = chart.getBoundingClientRect().top + scrollY; window.scrollTo(0, Math.max(0, t - (dev === "phone" ? 150 : 290))); }
  if (layer) {
    let e = layer.parentElement;
    while (e && !(e.scrollWidth > e.clientWidth + 2 && /auto|scroll/.test(getComputedStyle(e).overflowX))) e = e.parentElement;
    const ds = [...layer.querySelectorAll("[data-testid=ms-diamond],[data-testid=ms-prd-diamond],[data-testid=ms-ghost],[data-testid=ms-proposed]")];
    if (e && ds.length) {
      const er = e.getBoundingClientRect();
      const xs = ds.map((d) => d.getBoundingClientRect().left - er.left + e!.scrollLeft);
      const prd = layer.querySelector("[title^='M2 Digest']");
      const hi = dev === "phone" && prd ? prd.getBoundingClientRect().left - er.left + e.scrollLeft : Math.max(...xs), lo = Math.min(...xs);
      const sl = dev === "phone" ? hi - (170 + 0.35 * (e.clientWidth - 170)) : Math.max(Math.min(lo - 250, hi - e.clientWidth * 0.62), hi - e.clientWidth * 0.66);
      e.scrollLeft = Math.max(0, sl);
    }
  }
  return [innerWidth, document.documentElement.scrollWidth, document.body.scrollWidth];
};
const MARK = (theme: string) => {
  document.documentElement.setAttribute("data-theme", theme);
  for (const e of document.querySelectorAll("body *")) if (e.scrollLeft || e.scrollTop) e.setAttribute("data-snap-scroll", `${e.scrollLeft},${e.scrollTop}`);
};
const CLONE = (vp: string) => {
  const css: string[] = [];
  for (const s of document.styleSheets) { try { css.push([...s.cssRules].map((r) => r.cssText).join("\n")); } catch {} }
  const root = document.documentElement.cloneNode(true) as HTMLElement;
  root.querySelectorAll("script, link[rel=stylesheet], link[rel=preload], link[rel=modulepreload], style, next-route-announcer, nextjs-portal").forEach((n) => n.remove());
  const head = root.querySelector("head")!;
  const meta = document.createElement("meta"); meta.name = "mockup-viewport"; meta.content = vp; head.prepend(meta);
  const st = document.createElement("style");
  const fonts = new Set<string>();
  st.textContent = css.join("\n").replace(/url\(["']?([^"')]+\.woff2)["']?\)/g, (_m, u: string) => { fonts.add(new URL(u, location.href).href); return `url("../assets/${u.split("/").pop()}")`; });
  head.appendChild(st);
  const sc = document.createElement("script");
  sc.textContent = `(function(){var t=new URLSearchParams(location.search).get('theme');if(t==='light'||t==='dark')document.documentElement.setAttribute('data-theme',t);function r(){document.querySelectorAll('[data-snap-scroll]').forEach(function(e){var v=e.getAttribute('data-snap-scroll').split(',');e.scrollLeft=+v[0];e.scrollTop=+v[1];});window.scrollTo(0,${Math.round(scrollY)});}r();addEventListener('DOMContentLoaded',r);addEventListener('load',r);})();`;
  root.querySelector("body")!.appendChild(sc);
  return { html: "<!doctype html>\n" + root.outerHTML, fonts: [...fonts] };
};
async function ctxFor(browser: Browser, dev: string, w: number, theme: string) {
  const phone = dev === "phone";
  const ctx = await browser.newContext({ baseURL: "http://127.0.0.1:3393", viewport: phone ? { width: 390, height: 844 } : { width: w, height: 900 }, isMobile: phone, hasTouch: phone, colorScheme: theme as "light" | "dark", deviceScaleFactor: 1 });
  await ctx.addInitScript((t) => localStorage.setItem("oracle-theme", t), theme);
  const page = await ctx.newPage();
  await page.goto("/login?next=%2Fhome");
  await page.getByLabel("Email").fill("admin@example.com");
  await page.getByLabel("Password").fill("demo");
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.waitForURL(/\/home$/);
  await page.goto("/simple/roadmap");
  await page.waitForLoadState("networkidle");
  await page.waitForTimeout(1500);
  return { ctx, page };
}
test("snap", async ({ browser }) => {
  const cache = new Map<string, Awaited<ReturnType<typeof ctxFor>>>();
  for (const f of frames) {
    if (only.length && !only.includes(f.file)) continue;
    const w = f.file.includes("-1512") ? 1512 : 1440;
    const key = `${f.dev}-${w}-${f.theme}`;
    if (!cache.has(key)) cache.set(key, await ctxFor(browser, f.dev, w, f.theme));
    const { page } = cache.get(key)!;
    await page.goto(`/simple/roadmap?${f.q}`);
    await page.waitForSelector("[data-testid=simple-chart]", { timeout: 15000 }).catch(() => console.log("no chart", f.file));
    await page.waitForLoadState("networkidle");
    await page.waitForTimeout(700);
    const dims = await page.evaluate(SCROLL, f.dev);
    await page.waitForTimeout(300);
    await page.evaluate(MARK, f.theme);
    await page.waitForTimeout(300);
    const res = await page.evaluate(CLONE, f.dev === "phone" ? "390x844" : `${w}x900`);
    for (const u of res.fonts) {
      const dst = path.join(OUT, "assets", u.split("/").pop()!);
      if (!fs.existsSync(dst)) fs.writeFileSync(dst, Buffer.from(await (await page.request.get(u)).body()));
    }
    fs.writeFileSync(path.join(OUT, "frames", `${f.file}.html`), res.html);
    await page.screenshot({ path: path.join(OUT, "frames", `${f.file}.png`) });
    console.log(f.file, JSON.stringify(dims));
  }
  for (const { ctx } of cache.values()) await ctx.close();
});
