// MOCK-HOOK: frames for the mock-ups in mockups-out/<set>/ (FRAMES=<set>, ONLY=<substring,...>).
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import { test } from "../e2e/test";

type Frame = { file: string; url: string; w?: number; h?: number; theme?: "light" | "dark"; wait?: number; js?: string[] };

const SET = process.env.FRAMES ?? "mk-featurepanel";
const OUT = path.resolve(__dirname, "../../mockups-out", SET);
const FR = path.join(OUT, "frames");
const AS = path.join(OUT, "assets");
const ONLY = (process.env.ONLY ?? "").split(",").filter(Boolean);
const THEME = `<script>try{var t=new URLSearchParams(location.search).get("theme");if(t==="light"||t==="dark")document.documentElement.setAttribute("data-theme",t)}catch(e){}</script>`;
const RESTORE = `<script>document.querySelectorAll("[data-snap-scroll]").forEach(function(e){var v=e.getAttribute("data-snap-scroll").split(",");e.scrollTop=+v[0];e.scrollLeft=+v[1]})</script>`;

test("capture frames", async ({ browser }) => {
  mkdirSync(FR, { recursive: true });
  mkdirSync(AS, { recursive: true });
  const frames: Frame[] = JSON.parse(readFileSync(path.join(OUT, "frames.json"), "utf8"));
  for (const fr of frames) {
    if (ONLY.length && !ONLY.some((o) => fr.file.includes(o))) continue;
    const w = fr.w ?? 1440;
    const h = fr.h ?? (w === 390 ? 844 : w === 1512 ? 982 : 900);
    const theme = fr.theme ?? "light";
    const ctx = await browser.newContext({ viewport: { width: w, height: h }, colorScheme: theme, deviceScaleFactor: 1, hasTouch: w < 500, isMobile: false });
    await ctx.clock.install({ time: "2026-10-22T12:00:00Z" });
    await ctx.addInitScript((t) => localStorage.setItem("oracle-theme", t), theme);
    const page = await ctx.newPage();
    await page.goto("/login");
    await page.fill("input[type=email]", "admin@example.com");
    await page.fill("input[type=password]", "demo");
    await page.click("button[type=submit]");
    await page.waitForURL((u) => !u.pathname.startsWith("/login"));
    await page.goto(fr.url);
    await page.waitForLoadState("networkidle");
    await page.waitForTimeout(fr.wait ?? 1800);
    for (const js of fr.js ?? []) {
      await page.evaluate(js);
      await page.waitForTimeout(500);
    }
    await page.screenshot({ path: path.join(FR, `${fr.file}.png`) });
    const d = await page.evaluate(() => {
      document.querySelectorAll("input,textarea").forEach((e) => e.setAttribute("value", (e as HTMLInputElement).value));
      const css: string[] = [];
      for (const ss of Array.from(document.styleSheets)) {
        try {
          const base = ss.href || location.href;
          css.push(
            Array.from(ss.cssRules)
              .map((r) => r.cssText)
              .join("\n")
              .replace(/url\((["']?)([^)"']+)\1\)/g, (m, _q, u: string) => (u.startsWith("data:") ? m : `url("${new URL(u, base).pathname}")`)),
          );
        } catch {}
      }
      document.querySelectorAll("*").forEach((e) => {
        if (e.scrollTop || e.scrollLeft) e.setAttribute("data-snap-scroll", `${e.scrollTop},${e.scrollLeft}`);
      });
      const c = document.documentElement.cloneNode(true) as HTMLElement;
      c.querySelectorAll("script,link,style,noscript,iframe,next-route-announcer").forEach((n) => n.remove());
      document.querySelectorAll("[data-snap-scroll]").forEach((e) => e.removeAttribute("data-snap-scroll"));
      return { html: c.outerHTML, css: css.join("\n") };
    });
    const assets = new Map<string, string>();
    const asset = async (u: string) => {
      if (assets.has(u)) return;
      const name = `${createHash("sha1").update(u).digest("hex").slice(0, 10)}-${path.basename(u.split("?")[0]).slice(-40)}`;
      if (!existsSync(path.join(AS, name))) {
        const r = await page.request.get(u);
        if (r.ok()) writeFileSync(path.join(AS, name), await r.body());
      }
      assets.set(u, `../assets/${name}`);
    };
    const urls = [...d.css.matchAll(/url\("(\/[^"]+)"\)/g)].map((m) => m[1]);
    const imgs = [...d.html.matchAll(/<img[^>]*?src="(\/[^"]+)"/g)].map((m) => m[1]);
    for (const u of [...urls, ...imgs]) await asset(u);
    const css = d.css.replace(/url\("(\/[^"]+)"\)/g, (_m, u: string) => `url("${assets.get(u) ?? u}")`);
    const html = d.html
      .replace(/(<img[^>]*?src=")(\/[^"]+)"/g, (_m, a: string, u: string) => `${a}${assets.get(u) ?? u}"`)
      .replace("<head>", `<head><meta charset="utf-8"><meta name="mockup-viewport" content="${w}x${h}">${THEME}<style>${css}</style>`)
      .replace("</body>", `${RESTORE}</body>`);
    writeFileSync(path.join(FR, `${fr.file}.html`), `<!DOCTYPE html>${html}`);
    console.log("ok", fr.file);
    await ctx.close();
  }
});
